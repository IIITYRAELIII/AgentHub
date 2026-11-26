import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskIntegrationGitService } from "../../../src/infrastructure/filesystem/task-integration-git.mjs";
import { readNativeUpstreamAdoptions } from "../../../src/infrastructure/filesystem/native-upstream-adoption.mjs";
import { installedNativeHistoryBaseline, assertInstalledLocalSourceBaseline } from "../../../src/infrastructure/filesystem/local-source-baseline.mjs";
import { assertNativeTaskHistories } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { normalizedReleaseBaseProvenance } from "../../../src/domain/release-base-provenance.mjs";
import { defaultRuntimeRoot } from "../../../src/infrastructure/filesystem/runtime-layout.mjs";
import { readAgentHubVersion } from "../../../src/infrastructure/filesystem/agent-hub-package.mjs";
import { nextRuntimeReleaseVersion } from "../../helpers/external-release-recipe.fixture.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { TaskIntegrationService } from "../../../src/application/task-integration-service.mjs";
import { createTaskOperationTimingBatchRecorder, measureTaskOperation, withTaskOperationTiming } from "../../../src/infrastructure/process/task-operation-timing.mjs";
import { partialOwnGitPublication } from "../../fixtures/own-git-publication-fixture.mjs";

const run = promisify(execFile), sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function git(root, args, options = {}) {
  const pending = run("git", args, { cwd: root, windowsHide: true,
    encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  pending.child.stdin.end(options.input ?? "");
  const { stdout } = await measureTaskOperation("fixture:git", () => pending, { detail: true });
  return options.rawOutput ? stdout : stdout.toString("utf8").trim();
}
async function save(root, file, bytes) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), bytes);
}
async function commit(root, message) {
  await git(root, ["add", "-A"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
async function fixture(t, owningTaskId = "11111111-1111-4111-8111-111111111111", owningTaskRevision = 2, agreedOrigin = false, ownPublishedOrigin = false, versionedRuntime = false, { joinOwnedWork = null } = {}) {
  // Keep the runtime fixture and native Job proof within the Windows path limit.
  const root = await mkdtemp(path.join(os.tmpdir(), "na-"));
  t.after(async () => {
    await joinOwnedWork?.();
    await rm(root, { recursive: true, force: true });
  });
  const environment = { ...process.env, LOCALAPPDATA: path.join(root, "state"), XDG_STATE_HOME: path.join(root, "state") };
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git"), runtimeRoot = defaultRuntimeRoot({ environment });
  await git(root, ["init", "--bare", "--initial-branch=main", origin]);
  await git(root, ["clone", origin, primary]);
  await git(primary, ["config", "core.autocrlf", "false"]);
  await save(primary, ".gitattributes", "* text eol=lf\n");
  await save(primary, "CHANGELOG.md", "# History\n");
  await save(primary, "AgentHub/server.mjs", "export const repair = 0;\n");
  await save(primary, "AgentHub/package.json", JSON.stringify({ name: "agent-hub", version: "2026.10.11" }) + "\n");
  await save(primary, "AgentHub/package-lock.json", JSON.stringify({ name: "agent-hub", version: "2026.10.11", packages: { "": { name: "agent-hub", version: "2026.10.11" } } }) + "\n");
  let main = await commit(primary, "agreed main");
  await git(primary, ["push", "origin", "main"]);
  const own = path.join(root, "own");
  await git(primary, ["worktree", "add", "-b", "own", own, main]);
  await save(own, "CHANGELOG.md", "# History\n\nPublished OWN notes.\n");
  await save(own, "AgentHub/package.json", JSON.stringify({ name: "agent-hub", version: "2026.10.12" }) + "\n");
  await save(own, "AgentHub/package-lock.json", JSON.stringify({ name: "agent-hub", version: "2026.10.12", packages: { "": { name: "agent-hub", version: "2026.10.12" } } }) + "\n");
  const published = await commit(own, "OWN publication");
  await git(own, ["push", "origin", "HEAD:main"]);
  if (agreedOrigin) {
    await git(primary, ["merge", "--ff-only", published]);
    await save(primary, "TEAM_SKILLS/[Ж]/accepted.md", "Already agreed repository metadata.\n");
    main = await commit(primary, "already accepted main after publication");
    await git(primary, ["push", "origin", "main"]);
  }
  const carry = path.join(root, "carry");
  await git(primary, ["worktree", "add", "-b", "carry", carry, agreedOrigin ? main : published]);
  await save(carry, "AgentHub/server.mjs", "export const repair = 1;\n");
  const source = await commit(carry, "installed local repair");
  const external = path.join(root, "external");
  await git(primary, ["worktree", "add", "-b", "external", external, ownPublishedOrigin ? source : agreedOrigin ? main : published]);
  await save(external, "CHANGELOG.md", "# History\n\nApproved external notes.\n\nPublished OWN notes.\n");
  await save(external, "AgentHub/incoming.mjs", "export const incoming = true;\n");
  const adopted = await commit(external, "approved external code");
  if (!agreedOrigin) await git(external, ["push", "origin", "HEAD:main"]);
  const dataDir = path.join(runtimeRoot, "data"), publication = { generation: "own-publication", repositories: [{ root: primary, revision: published }] };
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication, recordTiming: () => {} });
  const task = await service.prepare({ taskId: owningTaskId, taskNumber: "HUB-1", projectRoot: primary });
  await git(task.projectRoot, ["sparse-checkout", "disable"]);
  await git(task.projectRoot, ["merge", "--ff-only", source]);
  if (ownPublishedOrigin) await git(task.projectRoot, ["merge", "--ff-only", adopted]);
  else if (!agreedOrigin) await git(task.projectRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", adopted]);
  await save(task.projectRoot, "AgentHub/selected.mjs", "export const selected = true;\n");
  const result = await commit(task.projectRoot, "selected correction");
  const tasks = [{ taskId: task.taskId, taskRevision: owningTaskRevision, baseCommit: main, resultCommit: result }];
  const receipt = agreedOrigin || ownPublishedOrigin ? null : await service.recordExplicitUpstreamAdoption({ taskId: task.taskId, branch: task.branch,
    projectRoot: primary, taskBaseCommit: main, acceptedLocalMainCommit: main, adoptedCommit: adopted,
    snapshotCommit: result, requestId: "fixture-explicit-adoption" });
  const release = path.join(runtimeRoot, "releases", "installed-repair"), physical = Buffer.from("export const repair = 1;\n");
  const ownVersion = ownPublishedOrigin || versionedRuntime ? readAgentHubVersion({ packageFile: path.join(carry, "AgentHub", "package.json") }) : null;
  const ownReleaseVersion = ownPublishedOrigin || versionedRuntime ? await nextRuntimeReleaseVersion({ releasesDir: path.dirname(release), packageVersion: ownVersion }) : null;
  await save(release, "server.mjs", physical);
  const manifest = Buffer.from(JSON.stringify({ releaseId: "installed-repair", sourceRoot: path.join(carry, "AgentHub"),
    ...((ownPublishedOrigin || versionedRuntime) ? { version: ownVersion, releaseVersion: ownReleaseVersion } : {}),
    files: [{ path: "server.mjs", bytes: physical.length, sha256: sha(physical) }] }));
  await save(release, "runtime-manifest.json", manifest);
  await save(runtimeRoot, "current.json", JSON.stringify({ current: "installed-repair" }));
  const ownPublication = ownPublishedOrigin ? partialOwnGitPublication({ dataDir, repositoryRoot: primary,
    localMainCommit: main, publishedRevision: published, commit: adopted,
    tree: await git(primary, ["rev-parse", `${adopted}^{tree}`]), sourceBaseCommit: source, taskId: task.taskId }) : null;
  const candidate = new TaskIntegrationGitService({ dataDir: ownPublishedOrigin ? dataDir : path.join(root, "release-data"), environment });
  const port = (args, options) => git(primary, args, options);
  const adoptions = await readNativeUpstreamAdoptions({ git: port, tasks, repositoryRoot: primary, localMainCommit: main });
  const p = await installedNativeHistoryBaseline({ git: port, sourceGit: git, repositoryRoot: primary,
    primaryMainCommit: main, publishedRevision: published, tasks, runtimeRoot, planRevision: "exact", adoptions,
    readOwnGitPublication: ownPublication?.read });
  await save(runtimeRoot, "publication-state.json", JSON.stringify(publication));
  const publicProvenance = { ...p, compositionBaseCommit: p.ownGitPublication?.commit ?? published };
  const request = { projectRoot: primary, workspaceId: "fixture", planRevision: "exact", frozenTasks: tasks,
    approvedBaseCommit: publicProvenance.compositionBaseCommit, baseProvenance: publicProvenance };
  return { root, primary, own, carry, external, origin, runtimeRoot, dataDir, main, published, source, adopted,
    task, tasks, result, receipt, service, candidate, port, adoptions, p, request, release, ownPublication };
}

test("own partial Git publication permits ordinary Test and candidate reuse without claiming runtime success", async t => {
  let ownedWork;
  ownedWork = withTaskOperationTiming({ operationId: "own-partial-next-test",
    record: createTaskOperationTimingBatchRecorder(events => console.info(JSON.stringify(events))) }, async () => {
    const f = await measureTaskOperation("fixture:setup", () => fixture(t, undefined, undefined, false, true, false,
      { joinOwnedWork: () => ownedWork.catch(() => {}) }));
    assert.equal(f.p.ownGitPublication.commit, f.adopted);
    const rows = f.ownPublication.rows(), pointer = await readFile(path.join(f.runtimeRoot, "current.json"));
    const integrated = await measureTaskOperation("fixture:ordinary-test", () => f.service.snapshotAndMerge({ taskId: f.task.taskId, projectRoot: f.primary,
      operationId: "own-partial-next-test" }));
    assert.equal(integrated.snapshot.headCommit, f.result);
    assert.equal(integrated.integration.integrated, true);
    const prepared = await measureTaskOperation("fixture:candidate-first", () => f.candidate.prepareCandidate(f.request));
    assert.equal((await measureTaskOperation("fixture:candidate-reuse", () => f.candidate.prepareCandidate(f.request))).preReleaseHead, prepared.preReleaseHead);
    assert.equal(await git(f.primary, ["rev-parse", "refs/heads/main"]), f.main);
    assert.deepEqual(await readFile(path.join(f.runtimeRoot, "current.json")), pointer);
    assert.equal(f.ownPublication.rows(), rows);
    const verify = extra => assertInstalledLocalSourceBaseline({ provenance: f.p, git: f.port,
      repositoryRoot: f.primary, primaryMainCommit: f.main, publishedRevision: f.published,
      planRevision: "exact", tasks: f.tasks, runtimeRoot: f.runtimeRoot,
      readOwnGitPublication: f.ownPublication.read, ...extra });
    await measureTaskOperation("fixture:authority", () => verify({}));
    await assert.rejects(verify({ readOwnGitPublication: null }), /OWN Git publication/u);
    await assert.rejects(verify({ provenance: { ...f.p, ownGitPublication: { ...f.p.ownGitPublication, extra: true } } }), /publication|provenance/iu);
    await save(f.external, "AgentHub/foreign.mjs", "export const foreign = true;\n");
    await commit(f.external, "foreign after exact own publication");
    await git(f.external, ["push", "origin", "HEAD:main"]);
    await assert.rejects(verify({}), /OWN Git publication|origin/iu);
    await assert.rejects(f.candidate.prepareCandidate(f.request), /OWN Git publication|origin/iu);
    assert.equal(f.ownPublication.rows(), rows);
  });
  return await ownedWork;
});

async function terminalAuthority(t, ownPublishedOrigin = false) {
  for (const drift of [true, false]) await t.test(drift ? "origin drift before Task CAS" : "success and same-original repeat", async child => {
    const sqlRoot = await mkdtemp(path.join(os.tmpdir(), "hub-ordinary-terminal-"));
    const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(sqlRoot, "tasks.sqlite") });
    await catalog.load();
    const store = new TaskBoardStore({ databaseFile: path.join(sqlRoot, "tasks.sqlite") });
    child.after(async () => { store.close(); catalog.close(); await rm(sqlRoot, { recursive: true, force: true }); });
    const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Fixture",
      settings: { workingDirectory: sqlRoot, releaseWorkflowEnabled: true } }));
    const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "Executor" }));
    const board = new TaskBoardService({ store, workspaceCatalog: catalog });
    const created = store.create({ text: "Fix", bucket: "workspace", workspaceId: workspace.id });
    await board.claim({ id: created.id, workspaceId: workspace.id, streamId: stream.id,
      provider: "codex", threadId: "fixture", turnId: "turn", operationId: "claim" });
    const f = await fixture(child, created.id, board.task(created.id).revision + 1, false, ownPublishedOrigin);
    await catalog.runMutation(() => catalog.updateWorkspaceSettings(workspace.id,
      { workingDirectory: f.primary, releaseWorkflowEnabled: true }));
    await board.beginLifecycleTransition({ id: created.id, operationId: "test", kind: "workflow",
      targetWorkflowStatus: "testing", expectedRevision: board.task(created.id).revision });
    await board.commitWorkflowTransition({ operationId: "test", gitReferences: [{ projectRoot: f.primary,
      branch: f.task.branch, resultCommit: f.result }], evidence: { resultCommit: f.result } });
    const task = structuredClone(board.task(created.id));
    const tasks = f.tasks.map(item => ({ ...item, projectRoot: f.primary }));
    // Integration membership is a port. Git proofs, native candidate, lifecycle
    // and the terminal SQLite mutation are the actual owners under test.
    f.service.releaseIntegrationEvidence = async () => ({ tasks });
    let ready = false, injected = 0, terminalCalls = 0;
    const prepare = f.candidate.prepareCandidate.bind(f.candidate);
    f.candidate.prepareCandidate = request => {
      return prepare({ ...request, commitPrepared: async candidate => {
        ready = true; return request.commitPrepared(candidate);
      } });
    };
    const publication = { generation: "own-publication", repositories: [{ root: f.primary, revision: f.published }] };
    const plan = { revision: "exact", ready: tasks, blocked: [], conflicts: [] };
    const preflight = new TaskIntegrationService({
      releasePlanner: {
        plan: async () => plan,
        planAcceptance: async (_workspaceId, { checkBaseline }) => {
          checkBaseline?.(plan);
          return { baseline: plan, prospective: plan };
        },
      },
      taskGitWorkspaces: f.service, releaseGitWorkspaces: f.candidate,
      resolveReleaseValidationSource: async () => ({}), readPublicationState: async () => publication,
    });
    const record = event => {
      if (event.stage === "trace-summary") child.diagnostic(JSON.stringify({
        operationId: event.operationId, aggregateSemantics: event.aggregateSemantics,
        stageAggregates: event.stageAggregates,
      }));
    };
    f.service.recordTiming = record;
    const measure = f.service.measureOperation.bind(f.service);
    f.service.measureOperation = async (stage, operation) => {
      if (stage === "persistence" && ready && drift && !injected) {
        const changeOrigin = async () => {
          if (injected) return;
          injected++;
          await save(f.external, "AgentHub/late-origin.mjs", "unapproved before terminal CAS\n");
          await commit(f.external, "origin drift inside actual persistence admission");
          await git(f.external, ["push", "origin", "HEAD:main"]);
        };
        await changeOrigin();
      }
      return measure(stage, operation);
    };
    const originalCommit = board.commitWorkflowTransition.bind(board);
    board.commitWorkflowTransition = request => {
      if (request.operationId === "ordinary-await") terminalCalls++;
      return originalCommit(request);
    };
    const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog,
      taskGitWorkspaces: f.service, releasePreflight: preflight });
    const request = { taskId: task.id, operationId: "ordinary-await", status: "awaiting_implementation",
      projectRoot: f.primary, expectedRevision: task.revision, expectedWorkflowStatus: "testing" };
    const perform = () => withTaskOperationTiming({ operationId: request.operationId, taskId: task.id, record },
      () => lifecycle.updateWorkflowStatus(request));
    if (drift) {
      await assert.rejects(perform(), ownPublishedOrigin ? /OWN Git publication origin changed/ : /identity changed/);
      assert.equal(injected, 1);
      assert.equal(terminalCalls, 0);
      assert.equal(board.task(task.id).revision, task.revision);
      assert.equal(board.task(task.id).workflowStatus, "testing");
      assert.equal(board.lifecycleOutcome("ordinary-await"), null);
    } else {
      const accepted = await perform();
      assert.equal(board.task(task.id).workflowStatus, "awaiting_implementation");
      assert.equal(terminalCalls, 1);
      const refs = await git(f.primary, ["for-each-ref", "--format=%(refname) %(objectname)"]);
      const prepared = await f.candidate.frozenCandidate(f.primary);
      const checkpoint = await readFile(prepared.checkpointFile);
      await assert.rejects(perform(), /revision changed/);
      const repeat = board.lifecycleOutcome(request.operationId).result;
      assert.equal(repeat.task.revision, accepted.task.revision);
      assert.equal(terminalCalls, 1);
      assert.equal(await git(f.primary, ["for-each-ref", "--format=%(refname) %(objectname)"]), refs);
      assert.deepEqual(await readFile(prepared.checkpointFile), checkpoint);
      if (ownPublishedOrigin) {
        f.candidate.prepareCandidate = prepare;
        const rows = f.ownPublication.rows();
        const acceptedManifest = JSON.parse(await readFile(prepared.manifestFile, "utf8"));
        const validated = await f.candidate.validateCandidate({ ...f.request, workspaceId: acceptedManifest.workspaceId,
          planRevision: acceptedManifest.planRevision, frozenTasks: acceptedManifest.tasks,
          approvedBaseCommit: acceptedManifest.baseCommit, baseProvenance: acceptedManifest.baseProvenance });
        assert.equal(acceptedManifest.baseProvenance.ownGitPublication.commit, f.adopted);
        assert.equal(validated.tree, await git(prepared.releaseRoot, ["rev-parse", prepared.preReleaseHead + "^{tree}"]));
        assert.equal((await f.candidate.frozenCandidate(f.primary)).preReleaseHead, prepared.preReleaseHead);
        assert.equal(f.ownPublication.rows(), rows);
        assert.equal(await git(f.primary, ["rev-parse", "refs/heads/main"]), f.main);
      }
    }
  });
}

test("ordinary Await checks native authority inside actual Task persistence and terminal repeat has no Git effects",
  t => terminalAuthority(t));

test("own partial Git publication reaches actual Await CAS and preserves origin fencing",
  t => terminalAuthority(t, true));

test("already agreed main origin survives Test and requires a published base for Await", async t => {
  const f = await fixture(t, undefined, undefined, true);
  assert.deepEqual(f.adoptions, []);
  assert.equal(f.p.approvedOriginMainCommit, f.main);
  assert.deepEqual(f.p.adoptions, []);
  const verify = (provenance = f.p, extra = {}) => assertInstalledLocalSourceBaseline({ provenance, git: f.port,
    repositoryRoot: f.primary, primaryMainCommit: f.main, publishedRevision: f.published,
    planRevision: "exact", tasks: f.tasks, runtimeRoot: f.runtimeRoot, ...extra });
  for (const adoptions of [null, {}, "", false]) {
    assert.throws(() => normalizedReleaseBaseProvenance({ ...f.p, adoptions }), /adoption pins/);
  }
  assert.throws(() => normalizedReleaseBaseProvenance({ ...f.p, approvedOriginMainCommit: f.adopted }), /adoption pins/);
  await assert.rejects(verify(f.p, { git: async (args, options) => {
    if (args[0] === "merge-base" && args[2] === f.main && args[3] === f.source) throw new Error("source lacks agreed main");
    return f.port(args, options);
  } }), /source lacks agreed main/);
  const snapshot = await f.service.snapshot({ taskId: f.task.taskId, taskNumber: "HUB-1", projectRoot: f.task.projectRoot });
  assert.equal((await f.service.mergeIntoDev(snapshot)).integrated, true);
  const derived = await f.candidate.deriveInstalledLocalSourceBaselineForSelection({ projectRoot: f.primary,
    planRevision: "exact", tasks: f.tasks, publishedRevision: f.published, adoptions: [] });
  assert.deepEqual(derived, { ...f.p, compositionBaseCommit: f.published });
  assert.equal(await git(f.task.projectRoot, ["show", "HEAD:AgentHub/server.mjs"]), "export const repair = 1;");
  assert.equal(await git(f.task.projectRoot, ["show", "HEAD:AgentHub/selected.mjs"]), "export const selected = true;");
  await assert.rejects(f.candidate.prepareCandidate(f.request), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  await git(f.external, ["push", "origin", "HEAD:main"]);
  await assert.rejects(verify(), /agreed main origin changed/);
  assert.equal(await git(f.primary, ["rev-parse", "main"]), f.main);
  assert.equal(await git(f.primary, ["status", "--porcelain=v1"]), "");
});

test("ordinary Await derives exact selected adoption and installed source through existing owners", async t => {
  const f = await fixture(t);
  const base = await f.service.releaseBaseEvidence({ projectRoot: f.primary,
    publishedBaseCommit: f.published, tasks: f.tasks });
  assert.deepEqual(base.adoptions, f.p.adoptions);
  const request = { projectRoot: f.primary, planRevision: "exact", tasks: f.tasks,
    publishedRevision: base.publishedBaseCommit, adoptions: base.adoptions };
  assert.deepEqual(await f.candidate.deriveInstalledLocalSourceBaselineForSelection(request),
    { ...f.p, compositionBaseCommit: f.published });
  await assert.rejects(f.candidate.deriveInstalledLocalSourceBaselineForSelection({ ...request,
    adoptions: [{ ...base.adoptions[0], recordHash: "0".repeat(40) }] }), /evidence changed/);
  await assert.rejects(f.service.releaseBaseEvidence({ projectRoot: f.primary, publishedBaseCommit: f.published,
    tasks: [{ ...f.tasks[0], baseCommit: "0".repeat(40) }] }), /base changed/);
  await save(f.external, "AgentHub/later.mjs", "unapproved\n");
  await commit(f.external, "origin drift before ordinary Await");
  await git(f.external, ["push", "origin", "HEAD:main"]);
  // Historical evidence is still readable, but never grants current promotion.
  assert.deepEqual(await f.service.releaseBaseEvidence({ projectRoot: f.primary,
    publishedBaseCommit: f.published, tasks: f.tasks }), base);
  await assert.rejects(f.candidate.deriveInstalledLocalSourceBaselineForSelection(request), /identity changed/);
});

test("installed source object batch reaches actual TaskGit Test through the existing owned process lane", async t => {
  const f = await fixture(t);
  const snapshot = await f.service.snapshot({ taskId: f.task.taskId, taskNumber: "HUB-1", projectRoot: f.task.projectRoot });
  const integrated = await f.service.mergeIntoDev(snapshot);
  assert.equal(integrated.integrated, true);
  for (const name of ["server", "incoming", "selected"]) {
    assert.ok(await git(integrated.dev.projectRoot, ["show", `HEAD:AgentHub/${name}.mjs`]));
  }
  assert.equal(await git(f.primary, ["rev-parse", "main"]), f.main);
  assert.equal(await git(f.primary, ["status", "--porcelain=v1"]), "");
});



test("native composition rejects substituted receipts, changed snapshot and post-validation origin drift", async t => {
  const f = await fixture(t), verify = () => assertInstalledLocalSourceBaseline({ provenance: f.p, git: f.port,
    repositoryRoot: f.primary, primaryMainCommit: f.main, publishedRevision: f.published,
    planRevision: "exact", tasks: f.tasks, runtimeRoot: f.runtimeRoot });
  await verify();
  await assert.rejects(verifyChanged({ ...f.p, adoptions: [{ ...f.p.adoptions[0], recordHash: "0".repeat(40) }] }), /receipts changed/);
  function verifyChanged(provenance) { return assertInstalledLocalSourceBaseline({ provenance, git: f.port,
    repositoryRoot: f.primary, primaryMainCommit: f.main, publishedRevision: f.published,
    planRevision: "exact", tasks: f.tasks, runtimeRoot: f.runtimeRoot }); }
  const authority = { bases: [f.source], metadataBases: [f.source], adoptions: f.adoptions };
  await assertNativeTaskHistories({ git: f.port, baseCommit: f.source, tasks: f.tasks, historyAuthority: authority });
  await save(f.task.projectRoot, "CHANGELOG.md", "Task invented notes\n");
  const notes = await commit(f.task.projectRoot, "invalid task notes");
  await assert.rejects(assertNativeTaskHistories({ git: f.port, baseCommit: f.source,
    tasks: [{ ...f.tasks[0], resultCommit: notes }], historyAuthority: authority }), /unselected merge side/);
  await assert.rejects(verify(), /identity changed/);
  // New ordinary adoption belongs to the new exact snapshot, never the old receipt.
  await git(f.task.projectRoot, ["checkout", f.result, "--", "CHANGELOG.md"]);
  await commit(f.task.projectRoot, "restore approved notes");
  const changed = await git(f.task.projectRoot, ["rev-parse", "HEAD"]);
  await assert.rejects(readNativeUpstreamAdoptions({ git: f.port, tasks: f.tasks, repositoryRoot: f.primary, localMainCommit: f.main }), /identity changed/);
  await git(f.task.projectRoot, ["switch", "--detach", f.result]);
  // Restore only the disposable fixture's Task ref to exercise original reuse.
  await git(f.primary, ["update-ref", `refs/heads/${f.task.branch}`, f.result, changed]);
  const before = await f.candidate.prepareCandidate(f.request);
  const checkpoint = await readFile(before.checkpointFile ?? (await f.candidate.frozenCandidate(f.primary)).checkpointFile);
  let committed = 0;
  await assert.rejects(f.candidate.prepareCandidate({ ...f.request, validateBeforeCommit: async () => {
    await save(f.external, "AgentHub/later.mjs", "unapproved\n");
    await commit(f.external, "origin drift after validation");
    await git(f.external, ["push", "origin", "HEAD:main"]);
  }, commitPrepared: async () => { committed++; } }), /identity changed/);
  assert.equal(committed, 0);
  assert.deepEqual(await readFile((await f.candidate.frozenCandidate(f.primary)).checkpointFile), checkpoint);
  assert.equal(await git(f.primary, ["rev-parse", "main"]), f.main);
});

test("an exact adoption ignores root notes and still refuses version changes and foreign merge sides", async t => {
  const f = await fixture(t);
  const verify = async label => {
    const resultCommit = await git(f.task.projectRoot, ["rev-parse", "HEAD"]);
    const tasks = [{ ...f.tasks[0], resultCommit }];
    await f.service.recordExplicitUpstreamAdoption({ taskId: f.task.taskId, branch: f.task.branch,
      projectRoot: f.primary, taskBaseCommit: f.main, acceptedLocalMainCommit: f.main,
      adoptedCommit: f.adopted, snapshotCommit: resultCommit, requestId: label });
    const adoptions = await readNativeUpstreamAdoptions({ git: f.port, tasks,
      repositoryRoot: f.primary, localMainCommit: f.main });
    return () => assertNativeTaskHistories({ git: f.port, baseCommit: f.source, tasks,
      historyAuthority: { bases: [f.source], metadataBases: [f.source], adoptions } });
  };
  await save(f.task.projectRoot, "CHANGELOG.md", "Invented Task release notes\n");
  await commit(f.task.projectRoot, "invalid notes");
  await (await verify("notes"))();
  await git(f.task.projectRoot, ["checkout", f.adopted, "--", "CHANGELOG.md"]);
  await git(f.task.projectRoot, ["update-index", "--chmod=+x", "CHANGELOG.md"]);
  await git(f.task.projectRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "invalid notes mode"]);
  await (await verify("mode"))();
  await git(f.task.projectRoot, ["checkout", f.adopted, "--", "CHANGELOG.md"]);
  await save(f.task.projectRoot, "AgentHub/package.json", JSON.stringify({ name: "fixture", version: "9.9.9" }) + "\n");
  await commit(f.task.projectRoot, "invalid version");
  await assert.rejects((await verify("version"))(), /release-owned package-version/);
  await git(f.task.projectRoot, ["checkout", f.adopted, "--", "AgentHub/package.json"]);
  await commit(f.task.projectRoot, "restore approved version");
  const other = path.join(f.root, "other");
  await git(f.primary, ["worktree", "add", "-b", "other", other, f.main]);
  await save(other, "AgentHub/unselected.mjs", "export const unselected = true;\n");
  const foreign = await commit(other, "unselected Task result");
  await git(f.task.projectRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", foreign]);
  await assert.rejects((await verify("foreign"))(), /unselected merge side/);
  assert.equal(await git(f.primary, ["rev-parse", "main"]), f.main);
});
