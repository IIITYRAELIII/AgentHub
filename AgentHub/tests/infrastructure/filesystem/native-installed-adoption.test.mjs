import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { readNativeUpstreamAdoptions } from "../../../src/infrastructure/filesystem/native-upstream-adoption.mjs";
import { installedNativeHistoryBaseline, assertInstalledLocalSourceBaseline } from "../../../src/infrastructure/filesystem/local-source-baseline.mjs";
import { assertNativeTaskHistories } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { localSourceSelectionHash, normalizedReleaseBaseProvenance } from "../../../src/domain/release-base-provenance.mjs";
import { defaultRuntimeRoot } from "../../../src/infrastructure/filesystem/runtime-layout.mjs";
import { readAgentHubVersion } from "../../../src/infrastructure/filesystem/agent-hub-package.mjs";
import { nextRuntimeReleaseVersion } from "../../../src/infrastructure/filesystem/runtime-release-version.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { WorkspaceReleasePreflightService } from "../../../src/application/workspace-release-preflight-service.mjs";

const run = promisify(execFile), sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function git(root, args, options = {}) {
  const pending = run("git", args, { cwd: root, windowsHide: true,
    encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  pending.child.stdin.end(options.input ?? "");
  const { stdout } = await pending;
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
async function fixture(t, owningTaskId = "11111111-1111-4111-8111-111111111111", owningTaskRevision = 2, agreedOrigin = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-adoption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  await git(primary, ["worktree", "add", "-b", "external", external, agreedOrigin ? main : published]);
  await save(external, "CHANGELOG.md", "# History\n\nApproved external notes.\n\nPublished OWN notes.\n");
  await save(external, "AgentHub/incoming.mjs", "export const incoming = true;\n");
  const adopted = await commit(external, "approved external code");
  if (!agreedOrigin) await git(external, ["push", "origin", "HEAD:main"]);
  const dataDir = path.join(runtimeRoot, "data"), publication = { generation: "own-publication", repositories: [{ root: primary, revision: published }] };
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication, recordTiming: () => {} });
  const task = await service.prepare({ taskId: owningTaskId, taskNumber: "HUB-1", projectRoot: primary });
  await git(task.projectRoot, ["sparse-checkout", "disable"]);
  await git(task.projectRoot, ["merge", "--ff-only", source]);
  if (!agreedOrigin) await git(task.projectRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", adopted]);
  await save(task.projectRoot, "AgentHub/selected.mjs", "export const selected = true;\n");
  const result = await commit(task.projectRoot, "selected correction");
  const tasks = [{ taskId: task.taskId, taskRevision: owningTaskRevision, baseCommit: main, resultCommit: result }];
  const receipt = agreedOrigin ? null : await service.recordExplicitUpstreamAdoption({ taskId: task.taskId, branch: task.branch,
    projectRoot: primary, taskBaseCommit: main, acceptedLocalMainCommit: main, adoptedCommit: adopted,
    snapshotCommit: result, requestId: "fixture-explicit-adoption" });
  const release = path.join(runtimeRoot, "releases", "installed-repair"), physical = Buffer.from("export const repair = 1;\n");
  const version = readAgentHubVersion({ packageFile: path.join(carry, "AgentHub", "package.json") });
  const releaseVersion = await nextRuntimeReleaseVersion({ releasesDir: path.dirname(release), packageVersion: version });
  await save(release, "server.mjs", physical);
  const manifest = Buffer.from(JSON.stringify({ releaseId: "installed-repair", version, releaseVersion, sourceRoot: path.join(carry, "AgentHub"),
    files: [{ path: "server.mjs", bytes: physical.length, sha256: sha(physical) }] }));
  await save(release, "runtime-manifest.json", manifest);
  await save(runtimeRoot, "current.json", JSON.stringify({ current: "installed-repair" }));
  const candidate = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "release-data"), environment });
  const port = (args, options) => git(primary, args, options);
  const adoptions = await readNativeUpstreamAdoptions({ git: port, tasks, repositoryRoot: primary, localMainCommit: main });
  const p = await installedNativeHistoryBaseline({ git: port, sourceGit: git, repositoryRoot: primary,
    primaryMainCommit: main, publishedRevision: published, tasks, runtimeRoot, planRevision: "exact", adoptions });
  await save(runtimeRoot, "publication-state.json", JSON.stringify(publication));
  const request = { projectRoot: primary, workspaceId: "fixture", planRevision: "exact", frozenTasks: tasks,
    approvedBaseCommit: source, baseProvenance: p };
  return { root, primary, own, carry, external, origin, runtimeRoot, dataDir, main, published, source, adopted,
    task, tasks, result, receipt, service, candidate, port, adoptions, p, request, release };
}

async function terminalAuthority(t, agreedOrigin = false) {
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
    const f = await fixture(child, created.id, board.task(created.id).revision + 1, agreedOrigin);
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
    let ready = false, injected = 0, prepares = 0, terminalCalls = 0;
    const prepare = f.candidate.prepareCandidate.bind(f.candidate);
    f.candidate.prepareCandidate = request => {
      prepares++;
      return prepare({ ...request, commitPrepared: async candidate => {
        ready = true; return request.commitPrepared(candidate);
      } });
    };
    const publication = { generation: "own-publication", repositories: [{ root: f.primary, revision: f.published }] };
    const preflight = new WorkspaceReleasePreflightService({
      releasePlanner: { plan: async () => ({ revision: "exact", ready: tasks, blocked: [], conflicts: [] }) },
      taskGitWorkspaces: f.service, releaseGitWorkspaces: f.candidate,
      resolveReleaseValidationSource: async () => ({}), readPublicationState: async () => publication,
    });
    f.service.measureOperation = async (stage, operation) => {
      if (stage === "persistence" && ready && drift && !injected) {
        const changeOrigin = async () => {
          if (injected) return;
          injected++;
          await save(f.external, "AgentHub/late-origin.mjs", "unapproved before terminal CAS\n");
          await commit(f.external, "origin drift inside actual persistence admission");
          await git(f.external, ["push", "origin", "HEAD:main"]);
        };
        if (process.env.HUB_TEST_LATE_NATIVE_HISTORY === "1") {
          const key = Symbol.for("agent-hub.test.after-native-history");
          globalThis[key] = changeOrigin;
          child.after(() => { delete globalThis[key]; });
        } else await changeOrigin();
      }
      return operation();
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
    if (drift) {
      await assert.rejects(lifecycle.updateWorkflowStatus(request), agreedOrigin ? /agreed main origin changed/ : /identity changed/);
      assert.equal(injected, 1);
      assert.equal(terminalCalls, 0);
      assert.equal(board.task(task.id).revision, task.revision);
      assert.equal(board.task(task.id).workflowStatus, "testing");
      assert.equal(board.lifecycleOutcome("ordinary-await"), null);
    } else {
      const accepted = await lifecycle.updateWorkflowStatus(request);
      assert.equal(board.task(task.id).workflowStatus, "awaiting_implementation");
      assert.equal(terminalCalls, 1);
      const refs = await git(f.primary, ["for-each-ref", "--format=%(refname) %(objectname)"]);
      const prepared = await f.candidate.frozenCandidate(f.primary);
      const checkpoint = await readFile(prepared.checkpointFile);
      await assert.rejects(lifecycle.updateWorkflowStatus(request), /revision changed/);
      const repeat = board.lifecycleOutcome(request.operationId).result;
      assert.equal(repeat.task.revision, accepted.task.revision);
      assert.equal(prepares, 1);
      assert.equal(terminalCalls, 1);
      assert.equal(await git(f.primary, ["for-each-ref", "--format=%(refname) %(objectname)"]), refs);
      assert.deepEqual(await readFile(prepared.checkpointFile), checkpoint);
    }
  });
}

test("ordinary Await checks native authority inside actual Task persistence and terminal repeat has no Git effects",
  t => terminalAuthority(t));

test("already agreed main origin reaches actual Await terminal CAS without invented adoption receipts",
  t => terminalAuthority(t, true));

test("late native history completion keeps origin fencing before the actual Task CAS", async () => {
  const environment = { ...process.env, HUB_TEST_LATE_NATIVE_HISTORY: "1" };
  delete environment.NODE_TEST_CONTEXT;
  const result = await run(process.execPath, ["--import",
    new URL("../../helpers/native-history-observer.mjs", import.meta.url).href,
    "--test", "--test-name-pattern=^already agreed main origin reaches", import.meta.filename],
  { env: environment, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /tests 3/u);
  assert.match(result.stdout, /pass 3/u);
  assert.match(result.stdout, /fail 0/u);
});

test("already agreed main origin survives Test and candidate reuse but refuses drift and malformed authority", { timeout: 240000 }, async t => {
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
  assert.deepEqual(derived, f.p);
  const first = await f.candidate.prepareCandidate(f.request);
  assert.equal((await f.candidate.prepareCandidate(f.request)).manifestHash, first.manifestHash);
  assert.equal(await git(first.releaseRoot, ["show", "HEAD:AgentHub/server.mjs"]), "export const repair = 1;");
  assert.equal(await git(first.releaseRoot, ["show", "HEAD:AgentHub/selected.mjs"]), "export const selected = true;");
  const checkpointFile = (await f.candidate.frozenCandidate(f.primary)).checkpointFile;
  const checkpoint = await readFile(checkpointFile);
  await assert.rejects(f.candidate.prepareCandidate({ ...f.request, validateBeforeCommit: async () => {
    await git(f.external, ["push", "origin", "HEAD:main"]);
  } }), /agreed main origin changed/);
  assert.deepEqual(await readFile(checkpointFile), checkpoint);
  assert.equal((await f.candidate.frozenCandidate(f.primary)).preReleaseHead, first.preReleaseHead);
  await assert.rejects(verify(), /agreed main origin changed/);
  assert.equal(await git(f.primary, ["rev-parse", "main"]), f.main);
  assert.equal(await git(f.primary, ["status", "--porcelain=v1"]), "");
});

test("ordinary Await derives exact selected adoption and installed source through existing owners", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const base = await f.service.releaseBaseEvidence({ projectRoot: f.primary,
    publishedBaseCommit: f.published, tasks: f.tasks });
  assert.deepEqual(base.adoptions, f.p.adoptions);
  const request = { projectRoot: f.primary, planRevision: "exact", tasks: f.tasks,
    publishedRevision: base.publishedBaseCommit, adoptions: base.adoptions };
  assert.deepEqual(await f.candidate.deriveInstalledLocalSourceBaselineForSelection(request), f.p);
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

test("native installed source and exact ordinary adoption survive Test, candidate reuse and generation", async t => {
  const f = await fixture(t);
  await assert.rejects(assertNativeTaskHistories({ git: f.port, baseCommit: f.main, tasks: f.tasks }), /release-owned/);
  const snapshot = await f.service.snapshot({ taskId: f.task.taskId, taskNumber: "HUB-1", projectRoot: f.task.projectRoot });
  const integrated = await f.service.mergeIntoDev(snapshot);
  assert.equal(integrated.integrated, true);
  assert.equal(await git(integrated.dev.projectRoot, ["show", "HEAD:AgentHub/server.mjs"]), "export const repair = 1;");
  const first = await f.candidate.prepareCandidate(f.request);
  const again = await f.candidate.prepareCandidate(f.request);
  assert.equal(again.preReleaseHead, first.preReleaseHead);
  assert.equal(again.manifestHash, first.manifestHash);
  for (const name of ["server", "incoming", "selected"]) assert.ok(await git(first.releaseRoot, ["show", `HEAD:AgentHub/${name}.mjs`]));
  const notes = Buffer.from("# Consolidated release\n");
  await save(first.releaseRoot, "CHANGELOG.md", notes);
  await save(first.releaseRoot, "foreign.txt", "foreign bytes stay intact\n");
  const generationInput = { ...f.request, operationId: "release-original", generation: 1, changelogContent: notes };
  await assert.rejects(f.candidate.prepareGeneration(generationInput), { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  assert.equal(await readFile(path.join(first.releaseRoot, "foreign.txt"), "utf8"), "foreign bytes stay intact\n");
  await unlink(path.join(first.releaseRoot, "foreign.txt"));
  await assert.rejects(f.candidate.prepareGeneration({ ...generationInput, changelogContent: Buffer.from("substituted notes\n") }),
    { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  const generation = await f.candidate.prepareGeneration(generationInput);
  assert.equal(generation.manifest.baseProvenance.adoptions[0].recordHash, f.receipt.recordHash);
  const frozen = await f.candidate.freezePublicationCandidate({ projectRoot: f.primary, workspaceId: "fixture",
    expectedPlanRevision: "exact", expectedPreparedHead: first.preReleaseHead, changelogContent: notes,
    releaseDate: new Date("2026-10-17T00:00:00Z") });
  assert.equal(frozen.phase, "frozen");
  assert.equal(await git(f.primary, ["rev-parse", "main"]), f.main);
  assert.equal(await git(f.primary, ["status", "--porcelain=v1"]), "");
  let terminalWrites = 0;
  await assert.rejects(f.service.withTaskLock(f.task.taskId, lease => f.service.withAppliedNativeTerminalOwned({
    taskId: f.task.taskId, projectRoot: f.primary, operationId: `native:${f.task.taskId}:${f.result}`, lease,
  }, async (_record, recheck) => {
    await recheck();
    await save(f.external, "AgentHub/later.mjs", "unapproved after awaited terminal callback\n");
    await commit(f.external, "origin changed before terminal CAS");
    await git(f.external, ["push", "origin", "HEAD:main"]);
    await recheck();
    terminalWrites++;
  })), /identity changed/);
  assert.equal(terminalWrites, 0);
});

test("native composition rejects substituted receipts, changed snapshot and post-validation origin drift", { timeout: 240000 }, async t => {
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
    tasks: [{ ...f.tasks[0], resultCommit: notes }], historyAuthority: authority }), /release-owned/);
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

test("an exact adoption never waives Task notes, modes, version changes or a foreign merge side", { timeout: 120000 }, async t => {
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
  await assert.rejects((await verify("notes"))(), /release-owned CHANGELOG/);
  await git(f.task.projectRoot, ["checkout", f.adopted, "--", "CHANGELOG.md"]);
  await git(f.task.projectRoot, ["update-index", "--chmod=+x", "CHANGELOG.md"]);
  await git(f.task.projectRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "invalid notes mode"]);
  await assert.rejects((await verify("mode"))(), /release-owned CHANGELOG/);
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
