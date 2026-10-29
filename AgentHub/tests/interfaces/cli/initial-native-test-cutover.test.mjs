import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { executeTaskAwaitCutover, executePreparationForward, executePreparationResume, inspectTaskAwaitCutoverSource, inspectInstalledNativeTestOwner, openTaskAwaitCutoverRuntime,
  parseTaskAwaitCutoverArguments } from "../../../task-await-cutover.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskReleasePlanService } from "../../../src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../../src/application/workspace-release-preflight-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { openTaskOperationReconciliationStores } from "../../../src/interfaces/cli/task-operation-reconciliation-runtime.mjs";
import { preparationHash, readPreparationSourceClosure } from "../../../src/application/release-preparation-admission.mjs";
import { preparationLegacyIdentity } from "../../../src/domain/release-preparation.mjs";
import { ReleaseOperationService } from "../../../src/application/release-operation-service.mjs";
import { WorkspaceReleaseOperationAdapter } from "../../../src/application/workspace-release-operation-adapter.mjs";
import { ReleaseOperationStore } from "../../../src/infrastructure/persistence/release-operation-store.mjs";
import { executeRelease, openReleaseRuntime, parseReleaseArguments } from "../../../release.mjs";
import { createReleaseOperationServices } from "../../../src/composition/release-operation-composition.mjs";
import { taskGitIdentityHash } from "../../../src/domain/task-git-reference.mjs";
import { mcpArgumentsHash } from "../../../src/domain/mcp-arguments-hash.mjs";

const exec = promisify(execFile);
const hash = "b".repeat(64);
const wire = value => JSON.parse(JSON.stringify(value));
async function git(cwd, ...args) {
  return String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
}
async function commit(cwd, message) {
  await git(cwd, "add", ".");
  await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
}

async function fixture(t, { releaseManager = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-initial-native-"));
  const primary = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(primary); await mkdir(dataDir);
  await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "base.txt"), "main\n"); await commit(primary, "main");
  const main = await git(primary, "rev-parse", "HEAD");
  const origin = path.join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "remote", "add", "origin", origin); await git(primary, "push", "origin", "main");
  const databaseFile = path.join(dataDir, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); catalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Native fixture",
    settings: { workingDirectory: primary, releaseWorkflowEnabled: true } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "Owner", settings: { releaseManager } }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "fixture-thread", streamId: stream.id }));
  const publication = { generation: "fixture", repositories: [{ root: primary, revision: main }] };
  const board = new TaskBoardService({ store, workspaceCatalog: catalog });
  const taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication, recordTiming: () => {} });
  const releaseGit = new ReleaseGitWorkspaceService({ dataDir,
    readPreparationAuthority: projectRoot => catalog.preparationIsolationAuthority(projectRoot) });
  const preflight = new WorkspaceReleasePreflightService({
    releasePlanner: new TaskReleasePlanService({ taskBoard: board, taskGitWorkspaces: taskGit }),
    taskGitWorkspaces: taskGit, releaseGitWorkspaces: releaseGit, readPublicationState: async () => publication,
    resolveReleaseValidationSource: () => assert.fail("Cutover never refreshes a shared Contour"),
    validateProductionCandidate: () => assert.fail("Cutover never publishes"),
  });
  await taskGit.prepareDev(primary);
  let installed = { available: false, hash };
  const open = async () => {
    let raw;
    const runtime = await openTaskAwaitCutoverRuntime({ config: { dataDir, taskBoard: { autoPlaceConfidence: 0.8 } },
      openStores: async options => { raw = await openTaskOperationReconciliationStores(options); return raw; },
      taskGitWorkspaces: taskGit, releaseGitWorkspaces: releaseGit, releasePreflight: preflight });
    runtime.inspectInstalledNativeOwner = async () => installed;
    runtime.fixtureCatalog = raw.workspaceCatalogStore;
    return runtime;
  };
  const create = async name => {
    const task = store.create({ text: name, bucket: "workspace", workspaceId: workspace.id });
    await board.claim({ id: task.id, workspaceId: workspace.id, streamId: stream.id,
      provider: "codex", threadId: "fixture-thread", turnId: `turn-${task.id}`, operationId: `claim-${task.id}` });
    const managed = await taskGit.prepare({ taskId: task.id, taskNumber: board.task(task.id).taskNumber, projectRoot: primary });
    await writeFile(path.join(managed.projectRoot, `${name}.txt`), `${name}\n`); await commit(managed.projectRoot, name);
    return { id: task.id, root: managed.projectRoot };
  };
  const input = async (task, requestId) => {
    const state = await preflight.initialNativeTestState({ workspaceId: workspace.id, projectRoot: primary });
    return { workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId: "fixture-thread",
      taskId: task.id, requestId, repositoryRoot: primary, expectedTaskRevision: board.task(task.id).revision,
      confirm: true, initialNativeTest: true,
      expectedSourceCommit: await git(task.root, "rev-parse", "HEAD"), expectedSourceTree: await git(task.root, "rev-parse", "HEAD^{tree}"),
      expectedSourceBranch: await git(task.root, "branch", "--show-current"), expectedMainCommit: main,
      expectedDevCommit: await git(primary, "rev-parse", "refs/heads/dev"),
      expectedPublicationHash: state.publicationHash, expectedCandidateHash: state.candidateHash,
      expectedPlanRevision: state.planRevision, expectedRuntimeHash: hash };
  };
  const run = (task, args, customize = null) => executeTaskAwaitCutover(args, {
    inspectSource: values => inspectTaskAwaitCutoverSource(values, { sourceRoot: task.root }),
    openRuntime: async () => { const runtime = await open(); customize?.(runtime); return runtime; },
  });
  return { root, primary, main, databaseFile, catalog, board, taskGit, releaseGit, preflight, publication, create, input, run, open,
    workspaceId: workspace.id, streamId: stream.id,
    setInstalled: value => { installed = value; },
    async status(task, status, requestId) {
      const runtime = await open();
      try {
        const token = runtime.service.contextToken({ provider: "codex", threadId: "fixture-thread", streamId: stream.id });
        return await runtime.service.call("hub_task_status_update", { context_token: token, task_id: task.id,
          status, request_id: requestId, expected_task_revision: board.task(task.id).revision,
          expected_workflow_status: board.task(task.id).workflowStatus });
      } finally { runtime.close(); }
    },
  };
}

test("ordinary preparation continuation CLI retains original identity and rejects mixed cutover authority", () => {
  const argv = ["--resume-preparation", "--provider", "codex", "--thread", "thread",
    "--stream", "stream", "--request", "original", "--expected-arguments-hash", "a".repeat(64),
    "--expected-preparation-revision", "4", "--native-resolution-review-file", "reviewed.json"];
  const parsed = parseTaskAwaitCutoverArguments(argv);
  assert.equal(parsed.requestId, "original");
  assert.equal(parsed.expectedPreparationRevision, 4);
  assert.equal(parsed.resumePreparation, true);
  assert.equal(parsed.nativeResolutionReviewFile, path.resolve("reviewed.json"));
  assert.throws(() => parseTaskAwaitCutoverArguments([...argv, "--confirm-cutover"]), /cannot change selection/u);
  assert.throws(() => parseTaskAwaitCutoverArguments([...argv, "--task", "foreign"]), /cannot change selection/u);
});

test("source release CLI uses shared default owners for run, refusal, terminal recovery and readonly retry", { timeout: 240000 }, async t => {
  const f = await fixture(t, { releaseManager: true });
  const task = await f.create("normal-release");
  await mkdir(path.join(task.root, "AgentHub"));
  await writeFile(path.join(task.root, "AgentHub/package.json"), JSON.stringify({ name: "agent-hub", version: "2026.10.12" }));
  await writeFile(path.join(task.root, "AgentHub/package-lock.json"), JSON.stringify({ name: "agent-hub", version: "2026.10.12", packages: { "": { name: "agent-hub", version: "2026.10.12" } } }));
  await commit(task.root, "release metadata fixture");
  await f.status(task, "testing", "normal-test");
  await f.status(task, "awaiting_implementation", "normal-await");
  await writeFile(path.join(f.primary, "main-docs.txt"), "new accepted main\n");
  await commit(f.primary, "accepted main");
  const main = await git(f.primary, "rev-parse", "HEAD");
  const oldDev = await git(f.primary, "rev-parse", "dev");
  const previousEnv = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.LOCALAPPDATA = path.join(f.root, "state");
  process.env.XDG_STATE_HOME = process.env.LOCALAPPDATA;
  t.after(() => { for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  await mkdir(path.join(process.env.LOCALAPPDATA, "AgentHub"), { recursive: true });
  await writeFile(path.join(process.env.LOCALAPPDATA, "AgentHub/publication-state.json"), JSON.stringify(f.publication));
  const published = new Set();
  let publishes = 0, validations = 0;
  const publication = { publish: async ({ operation }) => {
    published.add(operation.operationId); publishes += 1; return { status: "applied", revision: "fixture-published" };
  }, readback: async ({ operation }) => ({ status: published.has(operation.operationId) ? "applied" : "not_applied" }) };
  const store = new ReleaseOperationStore({ dataDir: path.dirname(f.databaseFile) });
  const open = () => openReleaseRuntime({
    createServices: args => createReleaseOperationServices({ ...args, publication,
      finalization: { finalize: async () => ({ status: "fixture-terminal" }) } }),
    openTaskRuntime: async () => {
      const runtime = await openTaskAwaitCutoverRuntime({ config: { dataDir: path.dirname(f.databaseFile),
        taskBoard: { autoPlaceConfidence: 0.8 } } });
      runtime.service.releasePreflight.validateOperationGeneration = async ({ generation }) => {
        validations += 1;
        for (const candidate of generation.candidates) {
          const owner = new ReleaseGitWorkspaceService({ dataDir: candidate.generationRoot });
          assert.equal((await owner.frozenCandidate(f.primary)).preReleaseHead, candidate.commit);
        }
        return { status: "ready" };
      };
      return runtime;
    },
  });
  const requestFile = path.join(f.root, "release-request.json");
  const accepted = [];
  const command = async (action, request, loseReply = false) => {
    await writeFile(requestFile, JSON.stringify(request));
    return executeRelease(parseReleaseArguments([action, "--provider", "codex", "--thread", "fixture-thread",
      "--stream", f.streamId, "--request-file", requestFile]), { openRuntime: open, onAccepted: ack => {
        accepted.push(ack);
        if (loseReply) throw new Error("controlled durable reply lost");
      } });
  };
  await assert.rejects(command("run", { request_id: "invalid-native-release",
    task_ids: [task.id], validation_mode: "full", approved_targets: [{ targetId: "fixture", kind: "fixture",
      repositoryRoot: f.primary, nativeResolutionReview: [] }] }), /Invalid exact native resolution bundle/u);
  assert.equal(f.catalog.mcpOperation("invalid-native-release").status, "failed");
  assert.deepEqual(store.active(), []);
  const runInput = { request_id: "one-normal-release",
    task_ids: [task.id], validation_mode: "full", approved_targets: [{ targetId: "fixture", kind: "fixture",
      repositoryRoot: f.primary, approvedLocalMainCommit: main, approvedOriginMainCommit: main }] };
  await assert.rejects(command("run", runInput, true), /durable reply lost/u);
  const refused = await command("get", { operation_id: accepted.at(-1).operationId });
  const operationId = refused.operation.operationId;
  assert.equal(refused.operation.state, "waiting");
  assert.equal(refused.operation.waitReason.code, "prepared_candidate_stale");
  assert.equal(refused.operation.lastError.code, "RELEASE_MAIN_APPROVAL_STALE");
  assert.equal(store.latestStep(operationId, 1, "compose").status, "failed");
  assert.equal(await git(f.primary, "rev-parse", "dev"), oldDev);
  assert.equal(publishes, 0);
  const stalePrepared = await f.releaseGit.frozenCandidate(f.primary);
  await git(f.primary, "push", "origin", "main");
  const stillStale = await command("continue", { request_id: "same-normal-release-origin-ready", operation_id: operationId });
  assert.equal(stillStale.operation.state, "waiting", JSON.stringify(stillStale.operation.lastError));
  assert.equal(stillStale.operation.waitReason.code, "prepared_candidate_stale");
  assert.equal(stillStale.operation.lastError.code, "RELEASE_PREPARED_CANDIDATE_STALE");
  assert.deepEqual(await f.releaseGit.frozenCandidate(f.primary), stalePrepared);
  assert.equal(publishes, 0); assert.equal(validations, 0);
  assert.equal(await git(f.primary, "rev-parse", "dev"), oldDev);
  // Preparation owns accepted-main integration and the new prepared composition.
  await f.taskGit.prepareDev(f.primary, { synchronizeAcceptedMain: true });
  await f.preflight.withAwaitTransition(f.workspaceId, () => f.preflight.prepareAwaitSet({ workspaceId: f.workspaceId,
    reviewedMainApprovals: { approvedLocalMainCommit: main, approvedOriginMainCommit: main } }));
  const prepared = await f.releaseGit.frozenCandidate(f.primary);
  assert.equal(prepared.baseCommit, main);
  assert.equal(prepared.checkpointPhase, "prepared");
  const done = await command("continue", { request_id: "same-normal-release-continue", operation_id: operationId });
  assert.equal(done.operation.state, "done", JSON.stringify(done.operation.lastError));
  assert.equal(done.generations.length, 1);
  assert.equal(done.generations[0].candidates[0].manifest.preparedCandidate.commit, prepared.preReleaseHead);
  assert.equal(done.generations[0].candidates[0].manifest.preparedCandidate.tree, prepared.tree);
  assert.equal(publishes, 1); assert.equal(validations, 1);
  assert.equal(await git(f.primary, "rev-parse", "HEAD"), main);
  assert.equal(await git(f.primary, "status", "--porcelain=v1"), "");
  await git(f.primary, "merge-base", "--is-ancestor", main, "dev");
  assert.equal(done.operation.authorization.fingerprint, refused.operation.authorization.fingerprint);
  assert.equal((await command("run", runInput)).operation.operationId, operationId);
  assert.equal(publishes, 1);
  assert.ok(accepted.length >= 2, "durable acknowledgement is emitted before drain");
  const legacy = store.create({ requestId: "legacy-terminal", workspaceId: f.workspaceId,
    streamId: f.streamId, threadId: "fixture-thread", runnerVersion: "old-runner",
    authorization: { taskIds: [task.id], validationMode: "full", approvedTargets: [{
      targetId: "legacy", kind: "agent-hub-publication", repositoryRoot: f.primary,
      approvedLocalMainCommit: f.main, approvedOriginMainCommit: f.main }] } }).operation;
  const originalGeneration = store.putGeneration({ ...done.generations[0], operationId: legacy.operationId,
    generation: 1, runnerVersion: legacy.runnerVersion, sourceFingerprint: "retained-original" }).generation;
  store.transition(legacy.operationId, { state: "validate", currentGeneration: 1 });
  store.transition(legacy.operationId, { state: "publish", publicationEffects: { generation: 1,
    publishStarted: { generation: 1, candidate: originalGeneration.identitySha256 } } });
  const oldPublish = store.beginStep({ operationId: legacy.operationId, generation: 1,
    stepId: "publish:legacy", input: { candidate: originalGeneration.identitySha256 } }).receipt;
  store.finishStep(oldPublish, { status: "failed", effect: { status: "not_applied" }, error: "pre-effect failure" });
  store.transition(legacy.operationId, { state: "compose" });
  const oldCompose = store.beginStep({ operationId: legacy.operationId, generation: 2,
    stepId: "compose", input: { authorization: legacy.authorization, priorGeneration: 1 } }).receipt;
  store.finishStep(oldCompose, { status: "failed", error: `ENOENT: retained metadata unavailable for ${f.primary}` });
  const failed = store.transition(legacy.operationId, { state: "failed", lastError: {
    step: "compose", message: `ENOENT: retained metadata unavailable for ${f.primary}` } }).operation;
  const prior = store.snapshot(legacy.operationId);
  const recovered = await command("continue", { operation_id: legacy.operationId, request_id: "legacy-current-main",
    reviewed_main: { expectedRevision: failed.revision, approvedRepositories: [{ projectRoot: f.primary,
      approvedLocalMainCommit: main, approvedOriginMainCommit: main }] } });
  assert.equal(recovered.operation.state, "done", JSON.stringify(recovered.operation.lastError));
  assert.deepEqual(recovered.operation.authorization, prior.operation.authorization);
  assert.deepEqual(recovered.generations[0], originalGeneration);
  assert.equal(recovered.operation.reviewedMain.priorRevision, failed.revision);
  assert.equal(recovered.operation.reviewedMain.requestId, "legacy-current-main");
  assert.equal(publishes, 2);
  const beforeRead = store.snapshot(legacy.operationId);
  assert.deepEqual(await command("get", { operation_id: legacy.operationId }), beforeRead);
  assert.deepEqual(store.snapshot(legacy.operationId), beforeRead);
  assert.equal(publishes, 2);
});

test("source release CLI rejects malformed business input before opening the mutation runtime", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-cli-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestFile = path.join(root, "request.json");
  let opens = 0;
  for (const value of [[], null, { context_token: "foreign" }]) {
    await writeFile(requestFile, JSON.stringify(value));
    await assert.rejects(executeRelease({ action: "continue", requestFile }, {
      openRuntime: async () => { opens += 1; throw new Error("must not open"); },
    }), /business arguments/u);
  }
  assert.equal(opens, 0);
  for (const request of [{ task_id: "one", status: "done" }, { status: "awaiting_implementation" }]) {
    await writeFile(requestFile, JSON.stringify(request));
    await assert.rejects(executeRelease({ action: "accept", requestFile }, {
      openRuntime: async () => { opens += 1; throw new Error("must not open"); },
    }), /addressed Task Await/u);
  }
  assert.equal(opens, 0);
  assert.throws(() => parseReleaseArguments(["continue", "--provider", "codex", "--provider", "codex"]), /Invalid release/u);
});

test("source acceptance carries all reviewed prefixes through public Await and immutable SQLite retry", { timeout: 240000 }, async t => {
  const f = await fixture(t, { releaseManager: true });
  const a = await f.create("bundle-a"), b = await f.create("bundle-b");
  await f.status(a, "testing", "bundle-test-a");
  await f.status(a, "awaiting_implementation", "bundle-await-a");
  await f.status(b, "testing", "bundle-test-b");
  const before = structuredClone(f.board.task(b.id));
  const plan = await f.preflight.releasePlanner.plan(f.workspaceId, { acceptingTask: { id: b.id, revision: before.revision } });
  const frozen = plan.ready.map(entry => ({ taskId: entry.taskId, taskRevision: entry.taskRevision,
    taskNumber: entry.taskNumber ?? null, projectRoot: entry.projectRoot, branch: entry.branch,
    resultCommit: entry.resultCommit })).sort((left, right) => left.taskId.localeCompare(right.taskId));
  const evidence = await f.taskGit.releaseIntegrationEvidence({ projectRoot: f.primary, tasks: frozen });
  const identity = { policy: "main-selected-git-merge-v1", workspaceId: f.workspaceId,
    planRevision: plan.revision, baseCommit: f.main, tasks: evidence.tasks };
  const proof = path.join(f.root, "reviewed-proof");
  await git(f.root, "clone", "--no-local", f.primary, proof);
  await git(proof, "checkout", "--detach", f.main);
  const reviews = [], bindings = new Map();
  let prefix = f.main;
  for (const [index, task] of evidence.tasks.entries()) {
    await git(proof, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
      "merge", "--no-ff", "--no-edit", task.resultCommit);
    await writeFile(path.join(proof, "owner-compat.txt"), `reviewed prefix ${index}\n`);
    await git(proof, "add", "owner-compat.txt");
    await git(proof, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit");
    const commit = await git(proof, "rev-parse", "HEAD"), tree = await git(proof, "rev-parse", "HEAD^{tree}");
    const automaticTree = (await git(proof, "merge-tree", "--write-tree", prefix, task.resultCommit)).split(/\r?\n/u)[0];
    const diff = (await exec("git", ["diff", "--binary", "--full-index", "--no-renames", automaticTree, tree],
      { cwd: proof, windowsHide: true, encoding: "buffer" })).stdout;
    const binding = { identityHash: taskGitIdentityHash(identity), parents: [prefix, task.resultCommit],
      commit, tree, automaticTree, diffSha256: createHash("sha256").update(diff).digest("hex") };
    const requestId = `verified-prefix-${index}`;
    bindings.set(requestId, binding);
    reviews.push({ requestId, text: `<native-merge-review>${JSON.stringify({ kind: "native-merge-review-v1", verdict: "ACCEPT", binding })}</native-merge-review>` });
    prefix = commit;
  }
  assert.equal(reviews.length, 2);
  const bundlePath = path.join(f.root, "reviewed-prefixes.bundle");
  await git(proof, "update-ref", "refs/heads/reviewed", prefix);
  await git(proof, "bundle", "create", bundlePath, "refs/heads/reviewed");
  const native_resolution_review = { bundlePath,
    bundleSha256: createHash("sha256").update(await readFile(bundlePath)).digest("hex"), reviews };
  const verified = new Set();
  // Existing authenticated-review port is controlled; all Git, lifecycle, MCP
  // receipt, candidate promotion and SQLite persistence below are real owners.
  f.releaseGit.verifyNativeResolutionReview = async (review, binding, actualIdentity) => {
    assert.deepEqual(binding, bindings.get(review.requestId));
    assert.deepEqual(actualIdentity, identity); verified.add(review.requestId);
  };
  const requestFile = path.join(f.root, "accept-request.json");
  const request = { request_id: "one-bundle-await", task_id: b.id, status: "awaiting_implementation",
    expected_task_revision: before.revision, expected_workflow_status: "testing", native_resolution_review };
  const open = () => openReleaseRuntime({ openTaskRuntime: f.open });
  const invoke = async (body, openRuntime = open) => {
    await writeFile(requestFile, JSON.stringify(body));
    return executeRelease(parseReleaseArguments(["accept", "--provider", "codex", "--thread", "fixture-thread",
      "--stream", f.streamId, "--request-file", requestFile]), { openRuntime });
  };
  for (const [suffix, patch] of [["array", { native_resolution_review: [] }],
    ["cas", { expected_task_revision: null }], ["test", { status: "testing" }]]) {
    await assert.rejects(invoke({ ...request, ...patch, request_id: `invalid-${suffix}` }));
    assert.deepEqual(f.board.task(b.id), before);
  }
  await assert.rejects(invoke({ ...request, request_id: "tampered-bundle-await",
    native_resolution_review: { ...native_resolution_review, bundleSha256: "0".repeat(64) } }), /digest changed/u);
  assert.deepEqual(f.board.task(b.id), before);
  const accepted = await invoke(request);
  assert.equal(accepted.workflowStatus, "awaiting_implementation");
  assert.equal(accepted.revision, before.revision + 1);
  assert.deepEqual([...verified].sort(), [...bindings.keys()].sort());
  const candidate = (await f.releaseGit.initialNativeTestCandidate(f.primary)).candidate;
  assert.equal(candidate.preReleaseHead, prefix);
  assert.equal((await readFile(path.join(candidate.releaseRoot, "owner-compat.txt"), "utf8")).replace(/\r\n/gu, "\n"), "reviewed prefix 1\n");
  const reflog = await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  const reopenDefault = () => openReleaseRuntime({ openTaskRuntime: () => openTaskAwaitCutoverRuntime({
    config: { dataDir: path.dirname(f.databaseFile), taskBoard: { autoPlaceConfidence: 0.8 } },
  }) });
  assert.deepEqual(wire(await invoke(request, reopenDefault)), wire(accepted));
  assert.equal(await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.main);
  assert.equal(f.catalog.mcpOperation(request.request_id).status, "succeeded");
});

test("source acceptance retains Task-woken owner lifetime through success and lost public replies", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "accept-lifetime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestFile = path.join(root, "request.json");
  const cases = ["selected", " selected "].flatMap(taskId => [null, "receipt", "ack"].map(loss => ({ taskId, loss })));
  for (const { taskId, loss } of cases) {
    await writeFile(requestFile, JSON.stringify({ task_id: taskId, status: "awaiting_implementation", request_id: "one-await" }));
    let release, entered, closed = false;
    const barrier = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const result = { id: "selected", workflowStatus: "awaiting_implementation" };
    const calls = [];
    const pending = executeRelease({ action: "accept", requestFile, provider: "codex", threadId: "owner", streamId: "owner" }, {
      openRuntime: async () => ({
        service: { contextToken: () => "fixture-token", call: async (tool, args) => {
          calls.push([tool, args]);
          if (loss === "receipt") throw new Error("lost receipt response");
          return result;
        } },
        operations: { drainAddressed: async selector => {
          assert.deepEqual(selector, { taskId: "selected" }); entered(); await barrier;
        } },
        close: () => { closed = true; },
      }),
      onAccepted: () => { if (loss === "ack") throw new Error("lost ack response"); },
    });
    await started;
    assert.equal(closed, false);
    release();
    if (loss) await assert.rejects(pending, new RegExp(`lost ${loss} response`, "u"));
    else assert.equal(await pending, result);
    assert.equal(closed, true);
    assert.equal(calls.length, 1, "no public call replay");
    assert.equal(calls[0][0], "hub_task_status_update");
    assert.equal(calls[0][1].task_id, taskId, "public business arguments remain exact");
  }
});

for (const padded of [false, true]) {
test(`public Task ${padded ? "padded" : "canonical"} identity retains admitted owner through lost Await receipt`, { timeout: 180000 }, async t => {
  const f = await fixture(t, { releaseManager: true });
  const task = await f.create("task-receipt-lifetime");
  await f.status(task, "testing", "lifetime-test");
  const before = structuredClone(f.board.task(task.id));
  const store = new ReleaseOperationStore({ dataDir: path.dirname(f.databaseFile) });
  const make = (requestId, taskId) => {
    const op = store.create({ requestId, workspaceId: f.workspaceId, streamId: f.streamId,
      threadId: "fixture-thread", runnerVersion: "fixture",
      authorization: { taskIds: [taskId], validationMode: "full", approvedTargets: [{ targetId: "fixture", kind: "fixture", repositoryRoot: f.primary }] } }).operation;
    return store.transition(op.operationId, { state: "waiting", resumeState: "compose",
      waitReason: { code: "validation_failed", message: "controlled prior correction wait" } }).operation;
  };
  const original = make("existing-selected-release", task.id);
  const foreign = make("unrelated-release", "foreign-task"), foreignBefore = store.snapshot(foreign.operationId);
  let enteredResolve, releaseResolve, held = true, runtime;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const closes = [], composed = [];
  const open = async () => {
    const taskRuntime = await f.open();
    const raw = taskRuntime.fixtureCatalog, complete = raw.completeMcpOperation.bind(raw);
    raw.completeMcpOperation = async (id, ...args) => {
      if (id === "reviewer-task-lost-receipt") {
        await entered; throw new Error("controlled public Await receipt persistence failure");
      }
      return complete(id, ...args);
    };
    runtime = await openReleaseRuntime({ openTaskRuntime: async () => taskRuntime });
    runtime.operations.compose = async input => {
      composed.push(input.operation.operationId); enteredResolve(); await release;
      throw Object.assign(new Error("controlled fixture preparation refusal"), { code: "RELEASE_PREPARATION_REJECTED" });
    };
    const close = runtime.close;
    runtime.close = () => { closes.push({ held }); close(); };
    return runtime;
  };
  const requestFile = path.join(f.root, "request.json");
  const request = { task_id: padded ? ` ${task.id} ` : task.id, status: "awaiting_implementation",
    expected_task_revision: before.revision, expected_workflow_status: "testing", request_id: "reviewer-task-lost-receipt" };
  const requestBytes = JSON.stringify(request);
  await writeFile(requestFile, requestBytes);
  const attempt = executeRelease({ action: "accept", requestFile, provider: "codex", threadId: "fixture-thread", streamId: f.streamId },
    { openRuntime: open }).then(value => ({ value }), error => ({ error: error.message }));
  await Promise.race([entered, attempt.then(result => { throw new Error("fixture failed before owner barrier: " + JSON.stringify(result)); })]);
  await new Promise(resolve => setTimeout(resolve, 100));
  const earlyClosed = closes.some(entry => entry.held);
  held = false; releaseResolve();
  const result = await attempt;
  await runtime.operations.drain(original.operationId);
  const final = store.snapshot(original.operationId);
  const drainBefore = { snapshot: store.snapshot(original.operationId), composed: [...composed] };
  await runtime.operations.drainAddressed({ taskId: task.id });
  assert.deepEqual(store.snapshot(original.operationId), drainBefore.snapshot);
  assert.deepEqual(composed, drainBefore.composed, "drain cannot schedule another composition");
  assert.equal(earlyClosed, false, "stores must stay open through the addressed Task owner lifetime");
  assert.match(result.error, /receipt reconciliation/u);
  assert.equal(f.catalog.mcpOperation(request.request_id).status, "unknown");
  assert.equal(f.catalog.mcpOperation(request.request_id).argumentsHash, mcpArgumentsHash(request));
  assert.equal(await readFile(requestFile, "utf8"), requestBytes);
  assert.equal(f.board.task(task.id).workflowStatus, "awaiting_implementation");
  assert.equal(final.operation.state, "waiting");
  assert.equal(final.operation.waitReason.code, "preparation_refused");
  assert.equal(final.operation.lastError.message, "controlled fixture preparation refusal");
  assert.deepEqual(final.operation.authorization, original.authorization);
  assert.equal(final.generations.length, 0);
  assert.deepEqual([...new Set(composed)], [original.operationId]);
  assert.deepEqual(closes, [{ held: false }]);
  assert.deepEqual(store.snapshot(foreign.operationId), foreignBefore);
  t.diagnostic(JSON.stringify({ padded, earlyClosed, closes, mcpStatus: "unknown", taskStatus: "awaiting_implementation",
    originalArgumentsHashUnchanged: true, originalAuthorizationExact: true, foreignFullSnapshotExact: true,
    explicitDrainNoAdditionalScheduling: true, ownerState: final.operation.state }));
});
}

test("public native source entry retains original operation timing on success and admission failure", { timeout: 180_000 }, async t => {
  const f = await fixture(t), events = [];
  f.taskGit.recordTiming = event => events.push(event);
  const success = await f.create("timed-success");
  const successArgs = await f.input(success, "timed-native-success");
  await f.run(success, successArgs);
  const rejected = await f.create("timed-refusal");
  const rejectedArgs = await f.input(rejected, "timed-native-refusal");
  f.taskGit.assertInitialNativeTestOwned = async () => { throw new Error("injected owned admission refusal"); };
  await assert.rejects(f.run(rejected, rejectedArgs), /injected owned admission refusal/);
  for (const [operationId, task, outcome] of [[successArgs.requestId, success, "ok"], [rejectedArgs.requestId, rejected, "error"]]) {
    const trace = events.filter(event => event.operationId === operationId);
    assert.ok(trace.some(event => event.stage === "workflow" && event.phase === "start"));
    assert.ok(trace.some(event => event.stage === "workflow" && event.phase === "end" && event.outcome === outcome));
    assert.ok(trace.some(event => event.stage === "trace-summary"));
    assert.ok(trace.every(event => event.taskId === task.id && Number.isInteger(event.traceId)));
    assert.ok(trace.every(event => !("context_token" in event) && !("contents" in event) && !("arguments" in event)));
  }
  assert.equal(f.board.task(success.id).workflowStatus, "testing");
  assert.equal(f.board.task(rejected.id).workflowStatus, "in_progress");
  assert.equal(f.catalog.mcpOperation(rejectedArgs.requestId).status, "failed");
});

test("restored preparation public owner preserves native content and same SQLite original", async t => {
  const f = await fixture(t, { releaseManager: true }), task = await f.create("accepted");
  await f.status(task, "testing", "accepted-test");
  await f.status(task, "awaiting_implementation", "accepted-await");
  const candidate = await f.releaseGit.initialNativeTestCandidate(f.primary);
  const prepared = candidate.candidate;
  const before = structuredClone(f.board.task(task.id));
  const awaitOutcome = JSON.stringify(f.board.lifecycleOutcome("accepted-await"));
  const planner = new TaskReleasePlanService({ taskBoard: f.board, taskGitWorkspaces: f.taskGit });
  const plan = await planner.plan(f.workspaceId);
  const entry = plan.ready.find(item => item.taskId === task.id);
  const envelope = { schemaVersion: 1, planRevision: plan.revision,
    publicationHash: preparationHash(f.publication), sourceCommit: f.main, sourceTree: await git(f.primary, "rev-parse", "main^{tree}"),
    sourceClosureHash: (await readPreparationSourceClosure()).hash,
    tasks: [{ taskId: task.id, rowRevision: before.revision, taskRevision: entry.taskRevision,
      baseCommit: f.main, resultCommit: entry.resultCommit, projectRoot: f.primary }],
    repositories: [{ projectRoot: f.primary, approvedBaseCommit: f.main, publishedRevision: f.main,
      primaryMainCommit: f.main, originMainCommit: f.main, checkpointHash: candidate.checkpointSha256,
      manifestHash: prepared.manifestHash, preReleaseHead: prepared.preReleaseHead, tree: prepared.tree, approvedTree: prepared.tree }] };
  const invoke = async (args, customize = () => {}) => {
    const runtime = await f.open();
    try {
      customize(runtime);
      const token = runtime.service.contextToken({ provider: "codex", threadId: "fixture-thread", streamId: f.streamId });
      return await runtime.service.call("hub_release_prepare", { context_token: token, ...args });
    } finally { runtime.close(); }
  };
  for (const field of ["approvedTree", "checkpointHash", "originMainCommit"]) {
    const stale = structuredClone(envelope); stale.repositories[0][field] = field.endsWith("Hash") ? "0".repeat(64) : "0".repeat(40);
    await assert.rejects(invoke({ request_id: `stale-${field}`, preparation: stale }), /changed|differs/u);
    assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), candidate);
  }
  const args = { request_id: "prepare-original", preparation: envelope };
  const result = await invoke(args, runtime => {
    const original = runtime.service.releasePreflight.prepareCurrentAwaitSet.bind(runtime.service.releasePreflight);
    runtime.service.releasePreflight.prepareCurrentAwaitSet = async request => {
      await original(request);
      throw new Error("lost response after exact SQL terminal");
    };
  });
  assert.equal(f.catalog.mcpOperation(args.request_id).status, "succeeded");
  assert.equal(result.candidates[0].preReleaseHead, prepared.preReleaseHead);
  const reflog = await git(prepared.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  const terminal = JSON.stringify(f.catalog.mcpOperation(args.request_id));
  assert.deepEqual(await invoke(args), result);
  assert.equal(JSON.stringify(f.catalog.mcpOperation(args.request_id)), terminal);
  assert.equal(await git(prepared.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
  assert.deepEqual(f.board.task(task.id), before);
  assert.equal(JSON.stringify(f.board.lifecycleOutcome("accepted-await")), awaitOutcome);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.main);
});

async function preparationRecoveryFixture(t, { checkingReplyLost = false } = {}) {
  const f = await fixture(t, { releaseManager: true }), task = await f.create("dev-only-accepted");
  await f.status(task, "testing", "recovery-task-test");
  await f.status(task, "awaiting_implementation", "recovery-task-await");
  const candidate = await f.releaseGit.initialNativeTestCandidate(f.primary), before = structuredClone(f.board.task(task.id));
  const plan = await new TaskReleasePlanService({ taskBoard: f.board, taskGitWorkspaces: f.taskGit }).plan(f.workspaceId);
  const entry = plan.ready[0], oldDev = await git(f.primary, "rev-parse", "dev");
  await writeFile(path.join(f.primary, "base.txt"), "main\naccepted docs correction\n");
  await commit(f.primary, "accepted local docs correction");
  const acceptedMain = await git(f.primary, "rev-parse", "main");
  await git(f.primary, "push", "origin", "main");
  // Actual owner refresh before the public preparation, as in the reported refusal.
  const audit = await f.releaseGit.inspectMainChanges({ projectRoot: f.primary, publishedRevision: f.main,
    approvedLocalMainCommit: acceptedMain, approvedOriginMainCommit: acceptedMain });
  assert.equal(audit.approved, true);
  const expectedTree = (await git(f.primary, "merge-tree", "--write-tree", acceptedMain, entry.resultCommit)).split(/\r?\n/u)[0];
  const envelope = { schemaVersion: 1, planRevision: plan.revision, publicationHash: preparationHash(f.publication),
    sourceCommit: f.main, sourceTree: await git(f.primary, "rev-parse", `${f.main}^{tree}`),
    sourceClosureHash: (await readPreparationSourceClosure()).hash,
    tasks: [{ taskId: task.id, rowRevision: before.revision, taskRevision: entry.taskRevision,
      baseCommit: f.main, resultCommit: entry.resultCommit, projectRoot: f.primary }],
    repositories: [{ projectRoot: f.primary, approvedBaseCommit: acceptedMain, publishedRevision: f.main,
      primaryMainCommit: acceptedMain, originMainCommit: acceptedMain, checkpointHash: candidate.checkpointSha256,
      manifestHash: candidate.candidate.manifestHash, preReleaseHead: candidate.candidate.preReleaseHead,
      tree: candidate.candidate.tree, approvedTree: expectedTree }] };
  const originalId = "recovery-original";
  const invoke = async (tool, body, customize = () => {}) => {
    const runtime = await f.open();
    try {
      customize(runtime);
      const token = runtime.service.contextToken({ provider: "codex", threadId: "fixture-thread", streamId: f.streamId });
      return await runtime.service.call(tool, { context_token: token, ...body });
    } finally { runtime.close(); }
  };
  const prepare = (customize = () => {}) => invoke("hub_release_prepare", { request_id: originalId, preparation: envelope }, customize);
  await assert.rejects(prepare(runtime => {
    if (!checkingReplyLost) return;
    const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparation.bind(runtime.fixtureCatalog);
    runtime.fixtureCatalog.checkpointMcpPreparation = (...args) => {
      const result = checkpoint(...args);
      if (args[1].state.phase === "checking" && !args[1].resume) throw new Error("lost owned checking reply");
      return result;
    };
  }), checkingReplyLost ? /lost owned checking reply/u : /does not contain accepted local main/u);
  const original = f.catalog.mcpOperation(originalId);
  assert.equal(original.status, "unknown");
  assert.equal(original.preparationState.phase, checkingReplyLost ? "checking" : "paused");
  assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), candidate);
  const resumeArgs = { request_id: originalId, expected_arguments_hash: original.argumentsHash,
    expected_preparation_revision: original.preparationState.revision };
  const bootstrap = () => f.taskGit.bootstrapAcceptedMainIntoDev({ projectRoot: f.primary, acceptedMainCommit: acceptedMain,
    expectedDevCommit: oldDev, publishedRevision: f.main, expectedPublicationGeneration: f.publication.generation,
    expectedMergeBaseCommit: f.main, requestId: "normal-accepted-main-bootstrap" });
  return { ...f, task, before, candidate, oldDev, acceptedMain, originalId, original, envelope, invoke,
    prepare, resumeArgs, bootstrap };
}

async function legacyForwardFixture(t) {
  const f = await preparationRecoveryFixture(t);
  // Reproduce the pre-checkpoint schema: keep the actual UNKNOWN/refusal and
  // successful audit, remove only the newer fixture's owner stage column value.
  const db = new DatabaseSync(f.databaseFile);
  try { db.prepare("UPDATE hub_mcp_operations SET preparation_state_json=NULL WHERE request_id=?").run(f.originalId); }
  finally { db.close(); }
  const legacy = f.catalog.mcpOperation(f.originalId);
  assert.equal(legacy.status, "unknown"); assert.equal(legacy.preparationState, undefined);
  await f.bootstrap();
  const observe = async request => ({ kind: "preparation-invocation-terminal-v1", requestId: request.requestId,
    argumentsHash: request.argumentsHash, originalSourceClosureHash: request.originalPreparation.sourceClosureHash,
    terminalEvidenceSha256: createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
    joinedInvocation: true, joinedChildren: true });
  const forward = (customize = () => {}, inspect = observe) => executePreparationForward({
    provider: "codex", threadId: "fixture-thread", streamId: f.streamId, requestId: f.originalId,
    expectedArgumentsHash: legacy.argumentsHash,
    expectedPreparationRevision: f.catalog.mcpOperation(f.originalId).preparationState?.revision ?? 0,
    originalPreparation: f.envelope, preparation: f.envelope,
  }, { openRuntime: async () => { const runtime = await f.open(); customize(runtime); return runtime; }, inspectOriginalExecution: inspect });
  return { ...f, legacy, forward, observe };
}

test("forward preparation public consumer preserves legacy UNKNOWN and refuses unproved old invocation", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t), before = structuredClone(f.board.task(f.task.id));
  const oldDev = await git(f.primary, "rev-parse", "dev");
  await assert.rejects(f.forward(() => {}, async () => ({ joinedInvocation: false })), /not proved/u);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), f.legacy);
  const result = await f.forward();
  assert.equal(result.kind, "forward-preparation-completed");
  assert.equal(result.retainedLegacyOutcome, "unknown");
  assert.equal(result.candidates[0].tree, f.envelope.repositories[0].approvedTree);
  const row = f.catalog.mcpOperation(f.originalId);
  assert.deepEqual(preparationLegacyIdentity(row), f.legacy);
  assert.equal(row.preparationState.phase, "completed");
  assert.deepEqual(row.preparationState.events[0].envelope, f.envelope);
  const candidate = await f.releaseGit.frozenCandidate(f.primary);
  const reflog = await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  assert.deepEqual(await f.forward(() => {}, () => assert.fail("terminal retry is read-only")), result);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), row);
  assert.equal(await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
  assert.deepEqual(f.board.task(f.task.id), before);
  assert.equal(await git(f.primary, "rev-parse", "dev"), oldDev);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.acceptedMain);
  const read = await f.invoke("hub_release_prepare_get", { preparation_request_id: f.originalId,
    expected_arguments_hash: f.legacy.argumentsHash });
  assert.equal(read.status, "unknown"); assert.deepEqual(read.recovery.result, result);
  const stale = new DatabaseSync(f.databaseFile);
  try {
    assert.throws(() => stale.prepare("UPDATE hub_mcp_operations SET receipt_state='succeeded' WHERE request_id=?").run(f.originalId), /immutable/u);
    assert.throws(() => stale.prepare("UPDATE hub_mcp_operations SET preparation_state_json=NULL WHERE request_id=?").run(f.originalId), /immutable/u);
  } finally { stale.close(); }
});

for (const boundary of ["transfer-reply", "terminal-before", "terminal-after"]) {
  test(`forward preparation ${boundary} recovery uses one candidate and retains unknown history`, { timeout: 240_000 }, async t => {
    const f = await legacyForwardFixture(t);
    const attempt = f.forward(runtime => {
      const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparationForward.bind(runtime.fixtureCatalog);
      runtime.fixtureCatalog.checkpointMcpPreparationForward = (...args) => {
        const phase = args[1].state.phase;
        if (boundary === "terminal-before" && phase === "completed") throw new Error("lost terminal before commit");
        const result = checkpoint(...args);
        if (boundary === "transfer-reply" && args[1].transfer || boundary === "terminal-after" && phase === "completed") {
          throw new Error("lost exact owner reply");
        }
        return result;
      };
    });
    if (boundary === "terminal-after") await attempt;
    else await assert.rejects(attempt, /lost exact owner reply|unknown/u);
    const partial = f.catalog.mcpOperation(f.originalId);
    assert.deepEqual(preparationLegacyIdentity(partial), f.legacy);
    const candidate = await f.releaseGit.frozenCandidate(f.primary);
    const reflog = await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
    const result = await f.forward();
    assert.equal(f.catalog.mcpOperation(f.originalId).preparationState.phase, "completed");
    assert.deepEqual(preparationLegacyIdentity(f.catalog.mcpOperation(f.originalId)), f.legacy);
    if (boundary !== "transfer-reply") {
      assert.equal(result.candidates[0].preReleaseHead, candidate.preReleaseHead);
      assert.equal(await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
    }
  });
}

test("forward preparation refused lease invocation cannot change a newer live owner", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t);
  let refuseA, startedA, releaseB;
  const aEntered = new Promise(resolve => { startedA = resolve; });
  const bHeld = new Promise(resolve => { releaseB = resolve; });
  const aMayRefuse = new Promise(resolve => { refuseA = resolve; });
  const a = f.forward(runtime => {
    const refused = new WorkspaceReleasePreflightService({
      releasePlanner: new TaskReleasePlanService({ taskBoard: f.board, taskGitWorkspaces: f.taskGit }),
      taskGitWorkspaces: f.taskGit, releaseGitWorkspaces: f.releaseGit, readPublicationState: async () => f.publication,
      resolveReleaseValidationSource: () => assert.fail("No Contour"), validateProductionCandidate: () => assert.fail("No publication"),
    });
    refused.withAwaitTransition = async () => { startedA(); await aMayRefuse; throw new Error("A refused before Await acquisition"); };
    runtime.service.releasePreflight = refused;
  });
  const aOutcome = assert.rejects(a, /A refused before Await acquisition/u);
  await aEntered;
  let bReady;
  const ready = new Promise(resolve => { bReady = resolve; });
  const b = f.forward(runtime => {
    const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparationForward.bind(runtime.fixtureCatalog);
    runtime.fixtureCatalog.checkpointMcpPreparationForward = async (...args) => {
      const row = checkpoint(...args);
      if (args[1].state.phase === "composing" && args[1].state.inventory) {
        bReady(row); await bHeld;
      }
      return row;
    };
  });
  try {
    const live = await ready;
    assert.equal(live.preparationState.phase, "composing");
    refuseA(); await aOutcome;
    assert.deepEqual(f.catalog.mcpOperation(f.originalId), live);
  } finally { refuseA(); releaseB(); }
  const result = await b;
  assert.equal(result.kind, "forward-preparation-completed");
  assert.deepEqual(preparationLegacyIdentity(f.catalog.mcpOperation(f.originalId)), f.legacy);
});

test("forward preparation refuses unfinished dev without implicit recovery or custody transfer", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t);
  const dev = await f.taskGit.prepareDev(f.primary);
  const file = await git(dev.projectRoot, "rev-parse", "--git-path", "index.lock");
  const marker = path.resolve(dev.projectRoot, file);
  await writeFile(marker, "owned interrupted fixture\n", { flag: "wx" });
  try {
    await assert.rejects(f.forward(), /unfinished dev Git operation: index.lock/u);
    assert.equal(await readFile(marker, "utf8"), "owned interrupted fixture\n");
    assert.deepEqual(f.catalog.mcpOperation(f.originalId), f.legacy);
  } finally { await unlink(marker); }
});

test("forward preparation preserves partial native promotion instead of replaying effects", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t);
  await assert.rejects(f.forward(runtime => {
    const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparationForward.bind(runtime.fixtureCatalog);
    runtime.fixtureCatalog.checkpointMcpPreparationForward = (...args) => {
      if (args[1].state.phase === "completed") throw new Error("terminal write lost");
      return checkpoint(...args);
    };
  }), /unknown/u);
  const candidate = await f.releaseGit.frozenCandidate(f.primary);
  const file = path.join(path.dirname(candidate.checkpointFile), "native-preparation.json");
  const journal = JSON.parse(await readFile(file, "utf8"));
  // Exact native crash position: candidate ref moved, original checkpoint not
  // committed yet. Retain both actual identities; this is not a rollback proof.
  assert.ok(journal.before.checkpointBytes);
  await writeFile(candidate.checkpointFile, Buffer.from(journal.before.checkpointBytes, "base64"));
  await writeFile(file, JSON.stringify({ ...journal, phase: "prepared" }, null, 2) + "\n");
  const checkpointBefore = await readFile(candidate.checkpointFile), journalBefore = await readFile(file);
  const refsBefore = await git(candidate.releaseRoot, "show-ref");
  await assert.rejects(f.forward(), /partial promotion/u);
  assert.deepEqual(await readFile(candidate.checkpointFile), checkpointBefore);
  assert.deepEqual(await readFile(file), journalBefore);
  assert.equal(await git(candidate.releaseRoot, "show-ref"), refsBefore);
  assert.deepEqual(preparationLegacyIdentity(f.catalog.mcpOperation(f.originalId)), f.legacy);
});

test("preparation recovery actual ancestry refusal after main audit resumes same SQLite original after guarded bootstrap", { timeout: 240_000 }, async t => {
  const f = await preparationRecoveryFixture(t);
  const read = await f.invoke("hub_release_prepare_get", { preparation_request_id: f.originalId,
    expected_arguments_hash: f.original.argumentsHash });
  assert.equal(read.recovery.phase, "paused");
  await assert.rejects(f.prepare(), /unknown/u);
  await assert.rejects(f.invoke("hub_release_prepare_resume", { ...f.resumeArgs, expected_arguments_hash: "0".repeat(64) }), /identity/u);
  await assert.rejects(f.invoke("hub_release_prepare_resume", { ...f.resumeArgs, expected_preparation_revision: 0 }), /stage evidence/u);
  for (const value of [-1, 1.5, [f.resumeArgs.expected_preparation_revision]]) {
    await assert.rejects(f.invoke("hub_release_prepare_resume", { ...f.resumeArgs, expected_preparation_revision: value }), /argument/u);
  }
  const boot = await f.bootstrap();
  assert.equal(boot.integrated, true);
  await git(f.primary, "merge-base", "--is-ancestor", f.oldDev, boot.headCommit);
  await git(f.primary, "merge-base", "--is-ancestor", f.acceptedMain, boot.headCommit);
  assert.equal(f.catalog.mcpOperation(f.originalId).status, "unknown", "bootstrap is not original settlement");
  f.publication.generation = "drift";
  await assert.rejects(f.invoke("hub_release_prepare_resume", f.resumeArgs), /changed/u);
  assert.equal(f.catalog.mcpOperation(f.originalId).preparationState.revision, f.resumeArgs.expected_preparation_revision);
  f.publication.generation = "fixture";
  const replies = await Promise.allSettled([f.invoke("hub_release_prepare_resume", f.resumeArgs),
    f.invoke("hub_release_prepare_resume", f.resumeArgs)]);
  assert.equal(replies.filter(reply => reply.status === "fulfilled").length, 1);
  const result = replies.find(reply => reply.status === "fulfilled").value;
  assert.equal(result.requestId, f.originalId);
  const finished = f.catalog.mcpOperation(f.originalId);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.argumentsHash, f.original.argumentsHash);
  assert.match(finished.preparationState.originalError, /does not contain accepted local main/u);
  assert.equal(await git(f.primary, "rev-parse", "dev"), boot.headCommit);
  assert.deepEqual(f.board.task(f.task.id), f.before);
  const current = await f.releaseGit.frozenCandidate(f.primary);
  assert.equal(await git(current.releaseRoot, "rev-parse", `${current.preReleaseHead}:dev-only-accepted.txt`),
    await git(f.primary, "rev-parse", `${f.oldDev}:dev-only-accepted.txt`));
  assert.match(await readFile(path.join(current.releaseRoot, "base.txt"), "utf8"), /accepted docs correction/u);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.acceptedMain);
  assert.deepEqual(await f.invoke("hub_release_prepare_resume", f.resumeArgs), result);
});

test("preparation recovery legacy UNKNOWN never gains authority from absent candidate or later bootstrap", { timeout: 240_000 }, async t => {
  const f = await preparationRecoveryFixture(t);
  // Model the old schema's exact missing checkpoint, only in this disposable SQLite fixture.
  const db = new DatabaseSync(f.databaseFile);
  try { db.prepare("UPDATE hub_mcp_operations SET preparation_state_json = NULL WHERE request_id = ?").run(f.originalId); }
  finally { db.close(); }
  const before = JSON.stringify(f.catalog.mcpOperation(f.originalId));
  await f.bootstrap();
  const read = await f.invoke("hub_release_prepare_get", { preparation_request_id: f.originalId,
    expected_arguments_hash: f.original.argumentsHash });
  assert.match(read.recovery.missingEvidence, /owner stage checkpoint/u);
  await assert.rejects(f.invoke("hub_release_prepare_resume", { ...f.resumeArgs, expected_preparation_revision: 0 }), /stage evidence/u);
  assert.equal(JSON.stringify(f.catalog.mcpOperation(f.originalId)), before);
  assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), f.candidate);
});

test("preparation recovery lost checking checkpoint reply resumes only after reacquiring original owner leases", { timeout: 240_000 }, async t => {
  const f = await preparationRecoveryFixture(t, { checkingReplyLost: true });
  await f.bootstrap();
  const result = await f.invoke("hub_release_prepare_resume", f.resumeArgs);
  assert.equal(result.requestId, f.originalId);
  const original = f.catalog.mcpOperation(f.originalId);
  assert.equal(original.status, "succeeded");
  assert.match(original.preparationState.originalError, /lost owned checking reply/u);
  assert.deepEqual(f.board.task(f.task.id), f.before);
});

test("preparation recovery live origin drift refuses without repeating the successful main audit", { timeout: 240_000 }, async t => {
  const f = await preparationRecoveryFixture(t);
  await f.bootstrap();
  const advanced = await git(f.primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
    "commit-tree", await git(f.primary, "rev-parse", `${f.acceptedMain}^{tree}`), "-p", f.acceptedMain,
    "-m", "new external origin commit");
  await git(f.primary, "push", "origin", `${advanced}:refs/heads/main`);
  f.releaseGit.inspectMainChanges = async () => assert.fail("resume repeated the successful original main audit");
  await assert.rejects(f.invoke("hub_release_prepare_resume", f.resumeArgs), /current main or remote changed/u);
  assert.equal(f.catalog.mcpOperation(f.originalId).status, "unknown");
  assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), f.candidate);
  assert.deepEqual(f.board.task(f.task.id), f.before);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.acceptedMain);
});

for (const boundary of ["compose-intent", "terminal-intent", "terminal-response"]) {
  test(`preparation recovery ${boundary} does not replay possible effects`, { timeout: 240_000 }, async t => {
    const f = await preparationRecoveryFixture(t);
    await f.bootstrap();
    let effects = 0;
    const invocation = f.invoke("hub_release_prepare_resume", f.resumeArgs, runtime => {
      if (boundary === "compose-intent") {
        runtime.service.releasePreflight.releaseGitWorkspaces.prepareCandidate = async () => {
          effects++; throw new Error("lost compose reply");
        };
      } else {
        const originalComplete = runtime.fixtureCatalog.completeMcpOperation.bind(runtime.fixtureCatalog);
        runtime.fixtureCatalog.completeMcpOperation = (...args) => {
          if (args[2]?.validate) effects++;
          if (boundary === "terminal-response") {
            const result = originalComplete(...args);
            if (args[2]?.validate) throw new Error("lost terminal reply");
            return result;
          }
          throw new Error("terminal write unavailable");
        };
      }
    });
    if (boundary === "terminal-response") await invocation;
    else await assert.rejects(invocation, /lost compose reply|unknown/u);
    const after = f.catalog.mcpOperation(f.originalId);
    if (boundary === "terminal-response") {
      assert.equal(after.status, "succeeded");
      assert.deepEqual(await f.invoke("hub_release_prepare_resume", f.resumeArgs), after.result);
    } else {
      assert.equal(after.status, "unknown");
      assert.equal(after.preparationState.phase, boundary === "compose-intent" ? "composing" : "terminal-intent");
      const readback = await f.invoke("hub_release_prepare_get", { preparation_request_id: f.originalId,
        expected_arguments_hash: after.argumentsHash });
      assert.match(readback.recovery.missingEvidence, /candidate or rollback outcome/u);
      await assert.rejects(f.invoke("hub_release_prepare_resume", { ...f.resumeArgs,
        expected_preparation_revision: after.preparationState.revision }), /stage evidence/u);
    }
    assert.equal(effects, 1);
  });
}

test("initial native Test parser requires the full reviewed identity and keeps legacy families separate", () => {
  const args = ["--workspace", "workspace", "--stream", "stream", "--provider", "codex", "--thread", "thread",
    "--task", "task", "--request", "original", "--repository", ".", "--expected-task-revision", "1",
    "--initial-native-test", "--confirm-cutover", "--expected-source-commit", "a".repeat(40),
    "--expected-source-tree", "a".repeat(40), "--expected-source-branch", "HUB-1",
    "--expected-main-commit", "a".repeat(40), "--expected-dev-commit", "a".repeat(40),
    "--expected-publication-sha256", hash, "--expected-candidate-sha256", hash,
    "--expected-plan-revision", hash, "--expected-runtime-sha256", hash];
  assert.equal(parseTaskAwaitCutoverArguments(args).initialNativeTest, true);
  assert.throws(() => parseTaskAwaitCutoverArguments(args.slice(0, -2)), /Missing value/u);
  assert.throws(() => parseTaskAwaitCutoverArguments([...args, "--expected-projector-sha256", hash]), /distinct/u);
  assert.throws(() => parseTaskAwaitCutoverArguments([...args, "--squash-bootstrap"]), /distinct/u);
  const returned = args.map(value => value === "--initial-native-test" ? "--returned-native-test" : value);
  assert.throws(() => parseTaskAwaitCutoverArguments(returned), /expected-returned-result/u);
  assert.equal(parseTaskAwaitCutoverArguments([...returned, "--expected-returned-result-commit", "c".repeat(40)]).expectedReturnedResultCommit, "c".repeat(40));
  assert.throws(() => parseTaskAwaitCutoverArguments([...args, "--expected-returned-result-commit", "c".repeat(40)]), /distinct/u);
});

for (const failure of ["sql-terminal", "mcp-receipt"]) {
  test(`public CLI returned native Test preserves prior Await and recovers ${failure} on its original`, async t => {
    const f = await fixture(t), neighbor = await f.create("neighbor");
    await f.status(neighbor, "testing", "neighbor-test"); await f.status(neighbor, "awaiting_implementation", "neighbor-await");
    const task = await f.create("correction");
    await f.status(task, "testing", "prior-test"); await f.status(task, "awaiting_implementation", "prior-await");
    const prior = f.board.task(task.id).gitReferences[0].resultCommit;
    const testOutcome = JSON.stringify(f.board.lifecycleOutcome("prior-test"));
    const candidate = await f.releaseGit.initialNativeTestCandidate(f.primary);
    await f.status(task, "in_progress", "prior-return");
    assert.equal(f.board.task(task.id).gitReferences[0].resultCommit, prior);
    assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), candidate);
    const returnOutcome = JSON.stringify(f.board.lifecycleOutcome("prior-return"));
    await writeFile(path.join(task.root, "corrected.txt"), "corrected\n"); await commit(task.root, "corrected descendant");
    const input = { ...await f.input(task, `returned-${failure}`), expectedReturnedResultCommit: prior };
    const before = f.board.task(task.id);
    await assert.rejects(f.run(task, { ...input, requestId: "foreign-prior", expectedReturnedResultCommit: f.board.task(neighbor.id).gitReferences[0].resultCommit }), /prior accepted result/u);
    await assert.rejects(f.run(task, { ...input, requestId: "missing-return-binding", expectedReturnedResultCommit: undefined }), /caller|Task/u);
    await assert.rejects(f.run(task, input, runtime => {
      if (failure === "sql-terminal") runtime.taskBoard.commitWorkflowTransition = async () => { throw new Error("Lost returned SQL terminal"); };
      else runtime.fixtureCatalog.completeMcpOperation = async () => { throw new Error("Lost returned MCP receipt"); };
    }), /unknown|UNKNOWN|readback|reconciliation/u);
    assert.equal(f.catalog.mcpOperation(input.requestId).status, "unknown");
    const dev = await git(f.primary, "rev-parse", "dev"), reflog = await git(f.primary, "reflog", "show", "--format=%H", "dev");
    if (failure === "sql-terminal") {
      const database = new DatabaseSync(f.databaseFile);
      try {
        const row = database.prepare("SELECT result_json FROM hub_task_lifecycle_outcomes WHERE operation_id = ?").get("prior-return");
        const changed = JSON.parse(row.result_json); changed.evidence.acceptedResult.taskRevision += 1;
        database.prepare("UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?").run(JSON.stringify(changed), "prior-return");
        await assert.rejects(f.run(task, input), /UNKNOWN|Unknown/u);
        assert.equal(f.board.task(task.id).workflowStatus, "in_progress");
        database.prepare("UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?").run(row.result_json, "prior-return");
      } finally { database.close(); }
    }
    f.setInstalled({ available: true, hash: "c".repeat(64) });
    const result = await f.run(task, input);
    assert.equal(result.result.workflowStatus, "testing");
    assert.equal(f.board.task(task.id).revision, before.revision + 1);
    assert.equal(f.board.task(task.id).gitReferences[0].resultCommit, input.expectedSourceCommit);
    assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
    assert.equal(await git(f.primary, "reflog", "show", "--format=%H", "dev"), reflog);
    assert.equal(JSON.stringify(f.board.lifecycleOutcome("prior-test")), testOutcome);
    assert.equal(JSON.stringify(f.board.lifecycleOutcome("prior-return")), returnOutcome);
    assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), candidate);
    assert.deepEqual((await f.run(task, input)).result, wire(result.result));
    await f.status(task, "awaiting_implementation", "corrected-await");
    const current = await f.releaseGit.frozenCandidate(f.primary);
    assert.deepEqual(current.manifest.taskIds.sort(), [neighbor.id, task.id].sort());
    await git(current.releaseRoot, "merge-base", "--is-ancestor", prior, current.preReleaseHead);
    await git(current.releaseRoot, "merge-base", "--is-ancestor", input.expectedSourceCommit, current.preReleaseHead);
    assert.equal((await readFile(path.join(current.releaseRoot, "neighbor.txt"), "utf8")).replaceAll("\r\n", "\n"), "neighbor\n");
    assert.equal((await readFile(path.join(current.releaseRoot, "corrected.txt"), "utf8")).replaceAll("\r\n", "\n"), "corrected\n");
  });
}

test("initial native Test closes bootstrap only for a verified ready installed native status owner", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-installed-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseId = "native-fixture", release = path.join(root, "releases", releaseId);
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(release, "src", "application"), { recursive: true });
  await mkdir(path.join(release, "src", "infrastructure", "filesystem"), { recursive: true });
  await writeFile(path.join(root, "current.json"), JSON.stringify({ current: releaseId }));
  await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({ pid: process.pid, ready: true, releaseId }));
  const files = { "package.json": JSON.stringify({ name: "agent-hub", version: "2026.9.25", type: "module" }),
    "src/application/hub-mcp-service.mjs": "export class HubMcpService { static nativeTaskStatusVersion = 1; }\n",
    "src/infrastructure/filesystem/native-release-merge.mjs": "export const fixture = true;\n" };
  const entries = [];
  for (const [file, value] of Object.entries(files)) {
    await writeFile(path.join(release, file), value);
    entries.push({ path: file, bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") });
  }
  await writeFile(path.join(release, "runtime-manifest.json"), JSON.stringify({ releaseId, version: "2026.9.25", files: entries }));
  assert.equal((await inspectInstalledNativeTestOwner({ runtimeRoot: root })).available, true);
  await writeFile(path.join(release, "src/application/hub-mcp-service.mjs"), "tampered\n");
  await assert.rejects(inspectInstalledNativeTestOwner({ runtimeRoot: root }), /mismatch/u);
});

test("public CLI initial native Test retains the prepared accepted candidate and ordinary Await", async t => {
  const f = await fixture(t), accepted = await f.create("accepted");
  await f.status(accepted, "testing", "accepted-test"); await f.status(accepted, "awaiting_implementation", "accepted-await");
  const prepared = await f.releaseGit.initialNativeTestCandidate(f.primary);
  const task = await f.create("initial"), input = await f.input(task, "initial-original");
  const before = f.board.task(task.id);
  const result = await f.run(task, input);
  assert.equal(result.result.workflowStatus, "testing");
  assert.equal(result.result.gitIntegration.integrated, true);
  assert.equal(result.result.gitWorkspace.headCommit, input.expectedSourceCommit);
  assert.equal(f.board.task(task.id).revision, before.revision + 1);
  assert.equal(f.board.task(task.id).gitReferences[0].resultCommit, input.expectedSourceCommit);
  assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), prepared);
  const outcome = JSON.stringify(f.board.lifecycleOutcome(input.requestId));
  const dev = await git(f.primary, "rev-parse", "dev"), reflog = await git(f.primary, "reflog", "show", "--format=%H", "dev");
  f.setInstalled({ available: true, hash: "c".repeat(64) });
  assert.deepEqual((await f.run(task, input)).result, wire(result.result));
  assert.equal(JSON.stringify(f.board.lifecycleOutcome(input.requestId)), outcome);
  assert.equal(await git(f.primary, "reflog", "show", "--format=%H", "dev"), reflog);
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
  const refused = await f.create("after-install"), refusal = await f.input(refused, "closed-bootstrap");
  await assert.rejects(f.run(refused, refusal), /bootstrap is closed/u);
  assert.equal(f.board.task(refused.id).workflowStatus, "in_progress");
  // Installed normal Test/Await uses the ordinary owner and has no launcher dependency.
  await f.status(refused, "testing", "ordinary-test-after-install");
  await f.status(task, "awaiting_implementation", "ordinary-await-after-cutover");
  assert.equal(f.board.task(task.id).workflowStatus, "awaiting_implementation");
  const current = await f.releaseGit.frozenCandidate(f.primary);
  assert.deepEqual(current.manifest.taskIds.sort(), [accepted.id, task.id].sort());
  assert.equal((await readFile(path.join(current.releaseRoot, "accepted.txt"), "utf8")).replaceAll("\r\n", "\n"), "accepted\n");
});

test("public CLI initial native Test refuses stale and foreign source, caller, Task and current pins", async t => {
  const f = await fixture(t), task = await f.create("guarded"), input = await f.input(task, "guard-original");
  const before = f.board.task(task.id), dev = await git(f.primary, "rev-parse", "dev");
  let opened = false;
  await assert.rejects(executeTaskAwaitCutover({ ...input, expectedSourceTree: "a".repeat(40) }, {
    inspectSource: values => inspectTaskAwaitCutoverSource(values, { sourceRoot: task.root }),
    openRuntime: () => { opened = true; assert.fail("Source must be inspected before stores"); },
  }), /tree or branch changed/u);
  assert.equal(opened, false);
  for (const [key, value] of [["expectedTaskRevision", before.revision + 1], ["expectedMainCommit", "a".repeat(40)],
    ["expectedDevCommit", "a".repeat(40)], ["expectedPublicationHash", "a".repeat(64)],
    ["expectedCandidateHash", "a".repeat(64)], ["expectedPlanRevision", "a".repeat(64)], ["expectedRuntimeHash", "a".repeat(64)]]) {
    await assert.rejects(f.run(task, { ...input, requestId: `stale-${key}`, [key]: value }));
    assert.equal(f.board.lifecycleTransition(`stale-${key}`), null);
  }
  const foreignStream = await f.catalog.runMutation(() => f.catalog.createStream({ workspaceId: input.workspaceId, name: "Foreign" }));
  await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "codex", threadId: "foreign-thread", streamId: foreignStream.id }));
  await assert.rejects(f.run(task, { ...input, requestId: "foreign-caller", streamId: foreignStream.id, threadId: "foreign-thread" }), /caller|assignment/u);
  const foreign = await f.create("foreign-source"), foreignInput = await f.input(foreign, "foreign-source-original");
  await assert.rejects(f.run(foreign, { ...foreignInput, taskId: task.id, expectedTaskRevision: before.revision }), /managed Task checkout/u);
  assert.deepEqual(f.board.task(task.id), before);
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
  assert.equal(f.catalog.mcpOperation("guard-original"), null);
});

test("public CLI native Test and Await preserve primary hooks without invoking clone configuration", async t => {
  const f = await fixture(t), accepted = await f.create("accepted-before-hooks");
  await f.status(accepted, "testing", "before-hooks-test");
  await f.status(accepted, "awaiting_implementation", "before-hooks-await");
  const prepared = await f.releaseGit.initialNativeTestCandidate(f.primary);
  const task = await f.create("hooked");
  const hooks = path.join(f.root, "team-hooks"), marker = path.join(f.root, "hook-ran");
  await mkdir(hooks);
  const hook = `#!/bin/sh\nprintf ran > '${marker.replaceAll("\\", "/")}'\nexit 91\n`;
  const packHook = path.join(hooks, "pack-objects");
  await writeFile(packHook, hook, { mode: 0o755 });
  await git(f.primary, "config", "core.hooksPath", hooks);
  await git(f.primary, "config", "uploadpack.packObjectsHook", `sh '${packHook.replaceAll("\\", "/")}'`);
  const config = await readFile(path.join(f.primary, ".git", "config"));
  const input = await f.input(task, "hooked-native-original");
  const result = await f.run(task, input);
  assert.equal(result.result.workflowStatus, "testing");
  assert.equal(f.catalog.mcpOperation(input.requestId).status, "succeeded");
  assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), prepared);
  await f.status(task, "awaiting_implementation", "hooked-native-await");
  const candidate = await f.releaseGit.frozenCandidate(f.primary);
  assert.deepEqual(candidate.manifest.taskIds.sort(), [accepted.id, task.id].sort());
  await git(candidate.releaseRoot, "merge-base", "--is-ancestor", input.expectedSourceCommit, candidate.preReleaseHead);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.main);
  assert.deepEqual(await readFile(path.join(f.primary, ".git", "config")), config);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.deepEqual((await f.run(task, input)).result, wire(result.result));
});

test("public CLI initial native Test fences caller rotation in the lifecycle admission transaction", async t => {
  const f = await fixture(t), task = await f.create("sql-race"), input = await f.input(task, "sql-caller-race");
  const before = f.board.task(task.id), dev = await git(f.primary, "rev-parse", "dev");
  await assert.rejects(f.run(task, input, runtime => {
    const begin = runtime.taskBoard.beginLifecycleTransition.bind(runtime.taskBoard);
    runtime.taskBoard.beginLifecycleTransition = async options => {
      await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "codex", threadId: "rotated-thread", streamId: input.streamId }));
      return begin(options);
    };
  }), /current SQL caller/u);
  assert.equal(f.board.lifecycleTransition(input.requestId), null);
  assert.equal(f.catalog.mcpOperation(input.requestId).status, "failed");
  assert.deepEqual(f.board.task(task.id), before);
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
});

for (const failure of ["sql-terminal", "mcp-receipt"]) {
  test(`public CLI initial native Test reopens ${failure} UNKNOWN with the same original and no second dev CAS`, async t => {
    const f = await fixture(t), task = await f.create("recover"), input = await f.input(task, `lost-${failure}`);
    const before = f.board.task(task.id);
    await assert.rejects(f.run(task, input, runtime => {
      if (failure === "sql-terminal") runtime.taskBoard.commitWorkflowTransition = async () => { throw new Error("Lost SQL terminal"); };
      else runtime.fixtureCatalog.completeMcpOperation = async () => { throw new Error("Lost MCP receipt"); };
    }), /unknown|UNKNOWN|readback|reconciliation/u);
    const receipt = f.catalog.mcpOperation(input.requestId);
    assert.equal(receipt.status, "unknown");
    assert.equal(f.board.task(task.id).workflowStatus, failure === "sql-terminal" ? "in_progress" : "testing");
    const dev = await git(f.primary, "rev-parse", "dev"), reflog = await git(f.primary, "reflog", "show", "--format=%H", "dev");
    const priorOutcome = JSON.stringify(f.board.lifecycleOutcome(input.requestId));
    // Same original recovery stays available after the native installed owner appears.
    f.setInstalled({ available: true, hash: "c".repeat(64) });
    await assert.rejects(f.run(task, { ...input, expectedDevCommit: "a".repeat(40) }), /original caller or arguments|identity/u);
    const foreignStream = await f.catalog.runMutation(() => f.catalog.createStream({ workspaceId: input.workspaceId, name: "Foreign recovery" }));
    await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "codex", threadId: "foreign-recovery", streamId: foreignStream.id }));
    await assert.rejects(f.run(task, { ...input, streamId: foreignStream.id, threadId: "foreign-recovery" }), /original caller or arguments/u);
    if (failure === "sql-terminal") {
      await writeFile(path.join(task.root, "recover.txt"), "foreign\n");
      await assert.rejects(f.run(task, input), /dirty/u);
      await writeFile(path.join(task.root, "recover.txt"), "recover\n");
      f.publication.generation = "foreign";
      await assert.rejects(f.run(task, input), /UNKNOWN/u);
      assert.equal(f.catalog.mcpOperation(input.requestId).status, "unknown");
      f.publication.generation = "fixture";
    }
    const result = await f.run(task, input);
    assert.equal(result.result.workflowStatus, "testing");
    assert.equal(f.catalog.mcpOperation(input.requestId).status, "succeeded");
    assert.equal(f.board.task(task.id).revision, before.revision + 1);
    assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
    assert.equal(await git(f.primary, "reflog", "show", "--format=%H", "dev"), reflog);
    if (failure === "mcp-receipt") assert.equal(JSON.stringify(f.board.lifecycleOutcome(input.requestId)), priorOutcome);
    assert.deepEqual((await f.run(task, input)).result, wire(result.result));
  });
}


test("reviewer concurrent lock refusal cannot poison current preparation owner", { timeout:240_000 }, async t => {
  const f=await preparationRecoveryFixture(t); await f.bootstrap();
  const staleEntered=Promise.withResolvers(), refuseStale=Promise.withResolvers();
  const composeEntered=Promise.withResolvers(), finishCompose=Promise.withResolvers();
  const awaitBoundary=f.preflight.withAwaitTransition.bind(f.preflight);
  let first=true;
  f.preflight.withAwaitTransition=async (...args)=>{
    if(first){first=false;staleEntered.resolve();await refuseStale.promise;throw new Error("Workspace Await lock acquisition refused before owner transfer");}
    return awaitBoundary(...args);
  };
  let effects=0;
  const prepare=f.releaseGit.prepareCandidate.bind(f.releaseGit);
  f.releaseGit.prepareCandidate=async (...args)=>{effects++;composeEntered.resolve();await finishCompose.promise;return prepare(...args);};
  const stale=f.invoke("hub_release_prepare_resume",f.resumeArgs).then(value=>({value}),error=>({error:error.message}));
  await staleEntered.promise;
  const winner=f.invoke("hub_release_prepare_resume",f.resumeArgs).then(value=>({value}),error=>({error:error.message}));
  await composeEntered.promise;
  const owned=f.catalog.mcpOperation(f.originalId);
  refuseStale.resolve();const refused=await stale;
  const afterRefusal=f.catalog.mcpOperation(f.originalId);
  finishCompose.resolve();const completed=await winner;
  const final=f.catalog.mcpOperation(f.originalId);
  console.log(JSON.stringify({reviewerRace:{owned:{status:owned.status,phase:owned.preparationState.phase,revision:owned.preparationState.revision,ownerId:owned.preparationState.ownerId},refused,
    afterRefusal:{status:afterRefusal.status,error:afterRefusal.error,phase:afterRefusal.preparationState.phase,revision:afterRefusal.preparationState.revision,ownerId:afterRefusal.preparationState.ownerId},completed,
    final:{status:final.status,phase:final.preparationState.phase,revision:final.preparationState.revision}}}));
  assert.equal(afterRefusal.receiptState,owned.receiptState,"unowned lock refusal changed the live invocation's receipt");
  assert.deepEqual(afterRefusal,owned);
  assert.match(refused.error,/lock acquisition refused/u);
  assert.equal(effects,1);
  assert.deepEqual(await f.invoke("hub_release_prepare_resume",f.resumeArgs),completed.value);
  assert.equal(effects,1);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId),final);
  assert.ok(completed.value,"the actual owned winner must complete");
});


const isolationObserver = async request => ({ kind: "preparation-effects-isolated-v1",
  requestId: request.requestId, argumentsHash: request.argumentsHash,
  originalSourceClosureHash: request.originalPreparation.sourceClosureHash,
  isolationEvidenceSha256: "1".repeat(64), authorizationSha256: "2".repeat(64),
  legacyInvocationTerminal: true, writeTargetsHash: request.isolationPlan.writeTargetsHash,
  reason: "Fixture legacy native-child custody is unknown; isolate future targets" });

test("isolated preparation proof record refuses arrays before transfer and persists complete valid evidence", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t), before = f.catalog.mcpOperation(f.originalId);
  const old = await f.releaseGit.frozenCandidate(f.primary);
  const oldCheckpoint = await readFile(old.checkpointFile);
  const oldHead = await git(old.releaseRoot, "rev-parse", "PreRelease");
  let plan, expectedProof;
  const observe = async request => {
    plan = request.isolationPlan;
    expectedProof = await isolationObserver(request);
    return expectedProof;
  };
  await assert.rejects(f.forward(() => {}, async request => Object.assign([], await observe(request))), /not proved/u);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), before);
  await assert.rejects(lstat(plan.dataDir), { code: "ENOENT" });
  assert.deepEqual(await readFile(old.checkpointFile), oldCheckpoint);
  assert.equal(await git(old.releaseRoot, "rev-parse", "PreRelease"), oldHead);
  assert.deepEqual(await f.releaseGit.frozenCandidate(f.primary), old);

  const result = await f.forward(() => {}, observe);
  const row = f.catalog.mcpOperation(f.originalId);
  assert.equal(row.preparationState.phase, "completed");
  assert.deepEqual(row.preparationState.custody, expectedProof);
  assert.deepEqual(row.preparationState.events[0].custody, expectedProof);
  assert.deepEqual(JSON.parse(JSON.stringify(row.preparationState.custody)), expectedProof);
  assert.deepEqual(preparationLegacyIdentity(row), f.legacy);
  const candidate = await f.releaseGit.frozenCandidate(f.primary);
  assert.notEqual(candidate.releaseRoot, old.releaseRoot);
  assert.equal(candidate.releaseRoot, result.candidates[0].releaseRoot);
  const reflog = await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  assert.deepEqual(await f.forward(() => {}, () => assert.fail("Completed retry must remain read-only")), result);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), row);
  assert.equal(await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
});

test("isolated preparation excludes old Git writers and fences old SQLite connections and authority replacement", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t), old = await f.releaseGit.frozenCandidate(f.primary);
  const db = new DatabaseSync(f.databaseFile);
  let raced = false, result;
  try { result = await f.forward(runtime => {
    const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparationForward.bind(runtime.fixtureCatalog);
    runtime.fixtureCatalog.checkpointMcpPreparationForward = async (...args) => {
      const row = checkpoint(...args);
      if (args[1].state.phase === "composing" && !raced) {
        raced = true;
        // Existing legacy writer can still touch its own refs/checkpoint after
        // transfer. Neither target is used as the new candidate's authority.
        await git(old.releaseRoot, "update-ref", "refs/heads/PreRelease", f.main);
        await writeFile(old.checkpointFile, JSON.stringify({ oldWriter: "late" }));
        assert.throws(() => db.prepare("UPDATE hub_mcp_operations SET receipt_state='succeeded' WHERE request_id=?").run(f.originalId), /immutable/u);
        assert.throws(() => db.prepare("DELETE FROM hub_mcp_operations WHERE request_id=?").run(f.originalId), /deleted/u);
        assert.throws(() => db.prepare("INSERT OR REPLACE INTO hub_mcp_operations SELECT * FROM hub_mcp_operations WHERE request_id=?").run(f.originalId), /replaced/u);
        assert.throws(() => db.prepare("UPDATE hub_mcp_operations SET preparation_state_json=json_remove(preparation_state_json,'$.isolation') WHERE request_id=?").run(f.originalId), /immutable/u);
      }
      return row;
    };
  }, isolationObserver); } finally { db.close(); }
  const current = await f.releaseGit.frozenCandidate(f.primary);
  assert.notEqual(current.releaseRoot, old.releaseRoot);
  assert.equal(result.candidates[0].releaseRoot, current.releaseRoot);
  assert.equal(current.tree, f.envelope.repositories[0].approvedTree);
  assert.deepEqual(JSON.parse(await readFile(old.checkpointFile, "utf8")), { oldWriter: "late" });
  assert.deepEqual(preparationLegacyIdentity(f.catalog.mcpOperation(f.originalId)), f.legacy);
  const reflog = await git(current.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  assert.deepEqual(await f.forward(() => {}, () => assert.fail("Completed retry must not inspect or compose")), result);
  assert.equal(await git(current.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
  const common = await git(current.releaseRoot, "rev-parse", "--git-common-dir");
  assert.equal(path.resolve(current.releaseRoot, common), path.join(current.releaseRoot, ".git"));
  await assert.rejects(readFile(path.join(current.releaseRoot, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
  const alternate = path.join(current.releaseRoot, ".git", "objects", "info", "alternates");
  await mkdir(path.dirname(alternate), { recursive: true });
  await writeFile(alternate, path.join(old.releaseRoot, ".git", "objects") + "\n");
  try { await assert.rejects(f.releaseGit.frozenCandidate(f.primary), /object.common store is shared/u); }
  finally { await unlink(alternate); }
  const originalHooks = await git(current.releaseRoot, "config", "--local", "--get", "core.hooksPath");
  await git(current.releaseRoot, "config", "core.hooksPath", f.root);
  try { await assert.rejects(f.releaseGit.frozenCandidate(f.primary), /configuration changed/u); }
  finally { await git(current.releaseRoot, "config", "core.hooksPath", originalHooks); }
  const reconciled = await f.releaseGit.reconcile({ projectRoots: [f.primary] });
  assert.equal(reconciled.repositories.find(item => item.source === "registered_workspace").releaseRoot, current.releaseRoot);
  const origin = path.join(f.root, "origin.git"), tree = await git(origin, "rev-parse", `${f.acceptedMain}^{tree}`);
  const incoming = await git(origin, "-c", "user.name=Incoming", "-c", "user.email=incoming@local.invalid",
    "commit-tree", tree, "-p", f.acceptedMain, "-m", "new unapproved incoming");
  await git(origin, "update-ref", "refs/heads/main", incoming, f.acceptedMain);
  const audit = await f.releaseGit.inspectMainChanges({ projectRoot: f.primary, publishedRevision: f.main,
    approvedLocalMainCommit: f.acceptedMain, approvedOriginMainCommit: f.acceptedMain });
  assert.equal(audit.approved, false); assert.equal(audit.approvalRequired, true);
  assert.ok(audit.commits.some(item => item.commit === incoming));
});

for (const boundary of ["before-transfer", "after-transfer", "before-terminal", "after-terminal"]) {
  test(`isolated preparation ${boundary} preserves custody and reuses one independent candidate`, { timeout: 240_000 }, async t => {
    const f = await legacyForwardFixture(t);
    const inspect = boundary === "before-transfer" ? async () => { throw new Error("before custody transfer"); } : isolationObserver;
    const attempt = f.forward(runtime => {
      const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparationForward.bind(runtime.fixtureCatalog);
      runtime.fixtureCatalog.checkpointMcpPreparationForward = (...args) => {
        if (boundary === "before-terminal" && args[1].state.phase === "completed") throw new Error("terminal reply lost");
        const row = checkpoint(...args);
        if (boundary === "after-transfer" && args[1].transfer || boundary === "after-terminal" && args[1].state.phase === "completed") {
          throw new Error("after owned commit");
        }
        return row;
      };
    }, inspect);
    if (boundary === "after-terminal") await attempt;
    else await assert.rejects(attempt, /custody transfer|owned commit|unknown/u);
    assert.deepEqual(preparationLegacyIdentity(f.catalog.mcpOperation(f.originalId)), f.legacy);
    const result = await f.forward(() => {}, isolationObserver);
    const candidate = await f.releaseGit.frozenCandidate(f.primary);
    assert.equal(result.candidates[0].tree, candidate.tree);
    assert.equal(f.catalog.mcpOperation(f.originalId).preparationState.phase, "completed");
    assert.deepEqual(await f.forward(() => {}, () => assert.fail("Read only")), result);
  });
}


test("isolated preparation does not inherit hooks or mutable object alternates", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t), hooks = path.join(f.root, "inherited-hooks"), touched = path.join(f.root, "hook-ran");
  await mkdir(hooks);
  await writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh\nprintf unsafe > '${touched.replaceAll("\\", "/")}'\n`);
  const names = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "core.hooksPath"; process.env.GIT_CONFIG_VALUE_0 = hooks;
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(f.primary, ".git", "objects");
    const result = await f.forward(() => {}, isolationObserver), candidate = await f.releaseGit.frozenCandidate(f.primary);
    assert.equal(result.candidates[0].releaseRoot, candidate.releaseRoot);
    await assert.rejects(readFile(touched), { code: "ENOENT" });
    assert.equal(await git(candidate.releaseRoot, "config", "--local", "--get", "core.fsmonitor"), "false");
    await assert.rejects(readFile(path.join(candidate.releaseRoot, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
});


test("isolated preparation preserves partial native promotion without falling back to legacy authority", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t);
  await assert.rejects(f.forward(runtime => {
    const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparationForward.bind(runtime.fixtureCatalog);
    runtime.fixtureCatalog.checkpointMcpPreparationForward = (...args) => {
      if (args[1].state.phase === "completed") throw new Error("lost terminal before commit");
      return checkpoint(...args);
    };
  }, isolationObserver), /unknown/u);
  const candidate = await f.releaseGit.frozenCandidate(f.primary);
  const journalFile = path.join(path.dirname(candidate.checkpointFile), "native-preparation.json");
  const journal = JSON.parse(await readFile(journalFile, "utf8"));
  assert.equal(journal.before.checkpointBytes, null);
  await unlink(candidate.checkpointFile);
  await writeFile(journalFile, JSON.stringify({ ...journal, phase: "prepared" }) + "\n");
  const original = await readFile(journalFile), refs = await git(candidate.releaseRoot, "show-ref");
  await assert.rejects(f.forward(() => {}, isolationObserver), /partial promotion/u);
  assert.deepEqual(await readFile(journalFile), original);
  assert.equal(await git(candidate.releaseRoot, "show-ref"), refs);
  await assert.rejects(readFile(candidate.checkpointFile), { code: "ENOENT" });
  await assert.rejects(f.releaseGit.frozenCandidate(f.primary), /ENOENT|incomplete/u);
  assert.deepEqual(preparationLegacyIdentity(f.catalog.mcpOperation(f.originalId)), f.legacy);
});


test("isolated preparation refuses an unexpected same-original legacy candidate before transfer or duplicate", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t), old = await f.releaseGit.frozenCandidate(f.primary);
  const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(await readFile(old.checkpointFile, "utf8")),
    preflightRequestId: f.originalId }));
  await writeFile(old.checkpointFile, bytes);
  const current = structuredClone(f.envelope);
  current.repositories[0].checkpointHash = createHash("sha256").update(bytes).digest("hex");
  await assert.rejects(executePreparationForward({ provider: "codex", threadId: "fixture-thread", streamId: f.streamId,
    requestId: f.originalId, expectedArgumentsHash: f.legacy.argumentsHash, expectedPreparationRevision: 0,
    originalPreparation: f.envelope, preparation: current }, { openRuntime: f.open,
    inspectOriginalExecution: isolationObserver }), /Preserve same-original legacy candidate.promotion/u);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), f.legacy);
  assert.deepEqual(await readFile(old.checkpointFile), bytes);
});


test("isolated preparation actual default factory reads registered root and same completed original", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t), result = await f.forward(() => {}, isolationObserver);
  const row = f.catalog.mcpOperation(f.originalId);
  const openDefault = () => openTaskAwaitCutoverRuntime({ config: { dataDir: path.dirname(f.databaseFile),
    taskBoard: { autoPlaceConfidence: 0.8 } } });
  const replay = await executePreparationForward({ provider: "codex", threadId: "fixture-thread", streamId: f.streamId,
    requestId: f.originalId, expectedArgumentsHash: f.legacy.argumentsHash,
    expectedPreparationRevision: row.preparationState.revision, originalPreparation: f.envelope, preparation: f.envelope },
  { openRuntime: openDefault, inspectOriginalExecution: () => assert.fail("Completed retry does not retransfer") });
  assert.deepEqual(replay, result);
  const runtime = await openDefault();
  try {
    const candidate = await runtime.service.releasePreflight.releaseGitWorkspaces.frozenCandidate(f.primary);
    assert.equal(candidate.releaseRoot, result.candidates[0].releaseRoot);
    assert.equal(candidate.preReleaseHead, result.candidates[0].preReleaseHead);
    assert.equal(candidate.tree, result.candidates[0].tree);
  } finally { runtime.close(); }
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), row);
});

test("completed preparation authority imports later Task results through ordinary default Await", { timeout: 360_000 }, async t => {
  const f = await legacyForwardFixture(t), result = await f.forward(() => {}, isolationObserver);
  const original = f.catalog.mcpOperation(f.originalId);
  const isolation = original.preparationState.isolation;
  const bundle = path.join(isolation.dataDir, "source.bundle"), bundleBytes = await readFile(bundle);
  const oldCandidate = result.candidates[0];
  const workspaceUrl = await git(oldCandidate.releaseRoot, "remote", "get-url", "workspace");
  assert.equal(workspaceUrl, bundle);
  // Model the already reviewed/published main; the old isolated source snapshot
  // stays immutable while later independent Task results are created normally.
  f.publication.repositories[0].revision = f.acceptedMain;
  const previousEnv = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.LOCALAPPDATA = path.join(f.root, "state");
  process.env.XDG_STATE_HOME = process.env.LOCALAPPDATA;
  t.after(() => { for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  await mkdir(path.join(process.env.LOCALAPPDATA, "AgentHub"), { recursive: true });
  await writeFile(path.join(process.env.LOCALAPPDATA, "AgentHub/publication-state.json"), JSON.stringify(f.publication));
  const later = await f.create("later-selected-result");
  await f.status(later, "testing", "later-result-test");
  const before = structuredClone(f.board.task(later.id)), commit = before.gitReferences[0].resultCommit;
  await assert.rejects(git(oldCandidate.releaseRoot, "cat-file", "-e", `${commit}^{commit}`));
  const primaryBefore = await git(f.primary, "status", "--porcelain=v1");
  const primaryHead = await git(f.primary, "rev-parse", "HEAD");
  const openDefault = () => openTaskAwaitCutoverRuntime({ config: { dataDir: path.dirname(f.databaseFile),
    taskBoard: { autoPlaceConfidence: 0.8 } } });
  const input = { task_id: later.id, status: "awaiting_implementation", request_id: "later-result-await",
    expected_task_revision: before.revision, expected_workflow_status: "testing" };
  const runtime = await openDefault();
  let accepted, candidate;
  try {
    const token = runtime.service.contextToken({ provider: "codex", threadId: "fixture-thread", streamId: f.streamId });
    accepted = await runtime.service.call("hub_task_status_update", { context_token: token, ...input });
    candidate = await runtime.service.releasePreflight.releaseGitWorkspaces.frozenCandidate(f.primary);
  } finally { runtime.close(); }
  assert.equal(accepted.workflowStatus, "awaiting_implementation");
  assert.equal(candidate.releaseRoot, oldCandidate.releaseRoot);
  await git(candidate.releaseRoot, "merge-base", "--is-ancestor", commit, candidate.preReleaseHead);
  await assert.rejects(readFile(path.join(candidate.releaseRoot, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
  assert.deepEqual(await readFile(bundle), bundleBytes);
  assert.equal(await git(candidate.releaseRoot, "remote", "get-url", "workspace"), workspaceUrl);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), original);
  assert.equal(await git(f.primary, "status", "--porcelain=v1"), primaryBefore);
  assert.equal(await git(f.primary, "rev-parse", "HEAD"), primaryHead);
  const reflog = await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  const reopened = await openDefault();
  try {
    const token = reopened.service.contextToken({ provider: "codex", threadId: "fixture-thread", streamId: f.streamId });
    assert.deepEqual(wire(await reopened.service.call("hub_task_status_update", { context_token: token, ...input })), wire(accepted));
    await writeFile(path.join(f.primary, "later-main.txt"), "reviewed local main\n");
    await commitFile();
    async function commitFile() { await git(f.primary, "add", "later-main.txt");
      await git(f.primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "later accepted local main"); }
    const localMain = await git(f.primary, "rev-parse", "HEAD");
    const audit = await reopened.service.releasePreflight.releaseGitWorkspaces.inspectMainChanges({ projectRoot: f.primary,
      publishedRevision: f.acceptedMain, approvedLocalMainCommit: localMain, approvedOriginMainCommit: f.acceptedMain });
    assert.equal(audit.approved, true); assert.equal(audit.localMain, localMain); assert.equal(audit.originMain, f.acceptedMain);
    assert.equal(await git(f.primary, "rev-parse", "HEAD"), localMain);
  } finally { reopened.close(); }
  assert.equal(await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
  assert.deepEqual(await readFile(bundle), bundleBytes);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), original);
});

test("ordinary public resume consumes established isolated custody without another observer or operator", { timeout: 240000 }, async t => {
  const f = await legacyForwardFixture(t);
  await assert.rejects(f.invoke("hub_release_prepare_resume", { request_id: f.originalId,
    expected_arguments_hash: f.legacy.argumentsHash, expected_preparation_revision: 0 }), /resumable owner stage/u);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), f.legacy);
  await assert.rejects(f.forward(runtime => {
    const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparationForward.bind(runtime.fixtureCatalog);
    runtime.fixtureCatalog.checkpointMcpPreparationForward = (...args) => {
      if (args[1].state.phase === "completed") throw new Error("controlled terminal reply lost before commit");
      return checkpoint(...args);
    };
  }, isolationObserver), /unknown/u);
  const blocked = f.catalog.mcpOperation(f.originalId);
  assert.equal(blocked.preparationState.phase, "blocked");
  const candidate = await f.releaseGit.frozenCandidate(f.primary);
  const reflog = await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  const input = { provider: "codex", threadId: "fixture-thread", streamId: f.streamId,
    requestId: f.originalId, expectedArgumentsHash: f.legacy.argumentsHash,
    expectedPreparationRevision: blocked.preparationState.revision };
  const result = await executePreparationResume(input, { openRuntime: f.open });
  assert.equal(result.kind, "forward-preparation-completed");
  assert.deepEqual(preparationLegacyIdentity(f.catalog.mcpOperation(f.originalId)), f.legacy);
  assert.equal(await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
  const completed = f.catalog.mcpOperation(f.originalId);
  const openDefault = () => openTaskAwaitCutoverRuntime({ config: { dataDir: path.dirname(f.databaseFile),
    taskBoard: { autoPlaceConfidence: 0.8 } } });
  assert.deepEqual(await executePreparationResume({ ...input,
    expectedPreparationRevision: completed.preparationState.revision }, { openRuntime: openDefault }), result);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), completed);
});

test("ordinary isolated resume inventories large native evidence across retained directories and still refuses non-files", { timeout: 240000 }, async t => {
  const f = await legacyForwardFixture(t);
  await assert.rejects(f.forward(runtime => {
    const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparationForward.bind(runtime.fixtureCatalog);
    runtime.fixtureCatalog.checkpointMcpPreparationForward = (...args) => {
      if (args[1].state.phase === "completed") throw new Error("controlled terminal reply lost before commit");
      return checkpoint(...args);
    };
  }, async request => ({ ...await isolationObserver(request), reason: "Exact retained evidence ".repeat(7000) })), /unknown/u);
  const candidate = await f.releaseGit.frozenCandidate(f.primary);
  const retained = path.join(path.dirname(candidate.releaseRoot), "native-merges", "retained-evidence");
  const mergeFile = path.join(retained, "merge.json");
  await mkdir(mergeFile, { recursive: true });
  const input = () => ({ provider: "codex", threadId: "fixture-thread", streamId: f.streamId,
    requestId: f.originalId, expectedArgumentsHash: f.legacy.argumentsHash,
    expectedPreparationRevision: f.catalog.mcpOperation(f.originalId).preparationState.revision });
  const checkpointBefore = await readFile(candidate.checkpointFile);
  const reflogBefore = await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  await assert.rejects(executePreparationResume(input(), { openRuntime: f.open }), /effect record is unsafe/u);
  assert.deepEqual(await readFile(candidate.checkpointFile), checkpointBefore);
  await rm(mergeFile, { recursive: true });
  // Full index/automatic inventories scale with repository paths, even for one
  // selected conflict. This is retained evidence, not a new selected result.
  const stages = Array.from({ length: 3000 }, (_, index) => ({
    path: `AgentHub/retained/${String(index).padStart(4, "0")}-${"native-path".repeat(8)}.mjs`,
    mode: "100644", blob: "a".repeat(40), stage: 0,
  }));
  const bytes = Buffer.from(JSON.stringify({ version: 1, identity: { policy: "retained-native-evidence" },
    next: 0, head: f.main, merges: [], merging: true,
    conflict: { paths: ["base.txt"], stages, automatic: stages } }));
  assert.ok(bytes.length > 512 * 1024);
  await writeFile(mergeFile, bytes);
  const parsedJournalFile = path.join(path.dirname(candidate.releaseRoot), "native-preparation.json");
  const parsedJournal = Buffer.concat([await readFile(parsedJournalFile), Buffer.from(" ".repeat(600 * 1024))]);
  await writeFile(parsedJournalFile, parsedJournal);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const nativeRoot = path.dirname(retained);
  const existing = await readdir(nativeRoot);
  for (let index = existing.length; index < 65; index++) {
    await mkdir(path.join(nativeRoot, `retained-directory-${index}`));
  }
  const directories = (await readdir(nativeRoot)).sort();
  assert.equal(directories.length, 65);
  const result = await executePreparationResume(input(), { openRuntime: f.open });
  assert.equal(result.kind, "forward-preparation-completed");
  assert.deepEqual((await readdir(nativeRoot)).sort(), directories);
  const completed = f.catalog.mcpOperation(f.originalId);
  assert.ok(completed.preparationState.events.some(event => event.inventory?.native?.length === 65));
  assert.ok(completed.preparationState.events.some(event =>
    event.inventory?.native?.some(entry => entry.root === "retained-evidence" && entry.mergeHash === digest)));
  assert.deepEqual(await readFile(mergeFile), bytes);
  assert.deepEqual(await readFile(parsedJournalFile), parsedJournal);
  assert.deepEqual(await readFile(candidate.checkpointFile), checkpointBefore);
  assert.equal(await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflogBefore);
  assert.deepEqual(preparationLegacyIdentity(completed), f.legacy);
  const openDefault = () => openTaskAwaitCutoverRuntime({ config: { dataDir: path.dirname(f.databaseFile),
    taskBoard: { autoPlaceConfidence: 0.8 } } });
  assert.deepEqual(await executePreparationResume(input(), { openRuntime: openDefault }), result);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), completed);
});

test("ordinary isolated resume reads a committed composing stage after its response was lost", { timeout: 240000 }, async t => {
  const f = await legacyForwardFixture(t);
  await assert.rejects(f.forward(runtime => {
    const checkpoint = runtime.fixtureCatalog.checkpointMcpPreparationForward.bind(runtime.fixtureCatalog);
    runtime.fixtureCatalog.checkpointMcpPreparationForward = (...args) => {
      const row = checkpoint(...args);
      if (args[1].state.phase === "composing") throw new Error("composing checkpoint committed but response lost");
      return row;
    };
  }, isolationObserver), /response lost/u);
  const original = f.catalog.mcpOperation(f.originalId);
  assert.equal(original.preparationState.phase, "composing");
  const result = await executePreparationResume({ provider: "codex", threadId: "fixture-thread", streamId: f.streamId,
    requestId: f.originalId, expectedArgumentsHash: f.legacy.argumentsHash,
    expectedPreparationRevision: original.preparationState.revision }, { openRuntime: f.open });
  assert.equal(result.kind, "forward-preparation-completed");
  assert.deepEqual(preparationLegacyIdentity(f.catalog.mcpOperation(f.originalId)), f.legacy);
  assert.equal(f.catalog.mcpOperation(f.originalId).preparationState.phase, "completed");
});


test("isolated preparation unresolved current child guard blocks another transfer", { timeout: 240_000 }, async t => {
  const f = await legacyForwardFixture(t), own = f.taskGit.withTaskRepositoryRecoveryLock.bind(f.taskGit);
  let injected = false;
  f.taskGit.withTaskRepositoryRecoveryLock = (taskId, root, lease, operation) => own(taskId, root, lease, owned => operation({
    ...owned, beginProcessTreeGuard: async context => {
      const guard = await owned.beginProcessTreeGuard(context);
      if (!injected && context.cwd.includes("release-prep") && context.args.includes("clone")) {
        injected = true;
        return { ...guard, clear: async () => {
          throw Object.assign(new Error("controlled current child completion lost"), { processTreeStopped: false });
        } };
      }
      return guard;
    },
  }));
  await assert.rejects(f.forward(() => {}, isolationObserver), /current child completion lost|completion is unproven/u);
  assert.equal(injected, true);
  const retained = f.catalog.mcpOperation(f.originalId);
  await assert.rejects(f.forward(() => {}, isolationObserver), /process-tree guard/u);
  assert.deepEqual(f.catalog.mcpOperation(f.originalId), retained);
  assert.deepEqual(preparationLegacyIdentity(retained), f.legacy);
  await assert.rejects(f.releaseGit.frozenCandidate(f.primary), /ENOENT|incomplete|publication requires/u);
});

test("reviewer lost public MCP receipt keeps stores alive until the addressed owner drains", { timeout: 180000 }, async t => {
  const f = await fixture(t, { releaseManager: true });
  const task = await f.create("lost-mcp-receipt");
  await mkdir(path.join(task.root, "AgentHub"));
  await writeFile(path.join(task.root, "AgentHub/package.json"), JSON.stringify({ name: "agent-hub", version: "2026.10.12" }));
  await writeFile(path.join(task.root, "AgentHub/package-lock.json"), JSON.stringify({ name: "agent-hub", version: "2026.10.12", packages: { "": { name: "agent-hub", version: "2026.10.12" } } }));
  await commit(task.root, "fixture metadata");
  await f.status(task, "testing", "test");
  await f.status(task, "awaiting_implementation", "await");
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.LOCALAPPDATA = path.join(f.root, "state"); process.env.XDG_STATE_HOME = process.env.LOCALAPPDATA;
  t.after(() => { for (const [k,v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k]=v; } });
  await mkdir(path.join(process.env.LOCALAPPDATA, "AgentHub"), { recursive:true });
  await writeFile(path.join(process.env.LOCALAPPDATA, "AgentHub/publication-state.json"), JSON.stringify(f.publication));
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => { enteredResolve=resolve; });
  const release = new Promise(resolve => { releaseResolve=resolve; });
  let held=true, runtime, operationId, published=0;
  const closed=[];
  const open = async () => {
    runtime = await openReleaseRuntime({
      createServices: args => createReleaseOperationServices({ ...args,
        publication: { publish: async () => { published++; return {status:"applied"}; }, readback: async()=>({status:"not_applied"}) },
        finalization: { finalize: async()=>({status:"fixture-terminal"}) } }),
      openTaskRuntime: async () => {
        const r=await openTaskAwaitCutoverRuntime({config:{dataDir:path.dirname(f.databaseFile),taskBoard:{autoPlaceConfidence:0.8}},
          openStores: async options => {
            const raw=await openTaskOperationReconciliationStores(options);
            const complete=raw.workspaceCatalogStore.completeMcpOperation.bind(raw.workspaceCatalogStore);
            raw.workspaceCatalogStore.completeMcpOperation=async (id,...args)=> {
              if(id==="reviewer-lost-mcp-receipt") { await entered; throw new Error("controlled MCP receipt persistence reply failure"); }
              return complete(id,...args);
            };
            return raw;
          },
        });
        r.service.releasePreflight.validateOperationGeneration=async()=>({status:"ready"});
        return r;
      },
    });
    const compose=runtime.operations.compose;
    runtime.operations.compose=async input=> { operationId=input.operation.operationId; enteredResolve(); await release; return compose(input); };
    const close=runtime.close;
    runtime.close=()=> { closed.push({composeStillHeld:held,operationId}); return close(); };
    return runtime;
  };
  const file=path.join(f.root,"request.json");
  await writeFile(file,JSON.stringify({request_id:"reviewer-lost-mcp-receipt",task_ids:[task.id],validation_mode:"full",
    approved_targets:[{targetId:"fixture",kind:"fixture",repositoryRoot:f.primary,
      approvedLocalMainCommit:f.main,approvedOriginMainCommit:f.main}]}));
  const attempt=executeRelease({action:"run",provider:"codex",threadId:"fixture-thread",streamId:f.streamId,requestFile:file},{openRuntime:open})
    .then(value=>({value}),error=>({error:String(error.message)}));
  await Promise.race([entered,attempt.then(result=>{throw new Error("fixture failed before owner barrier: "+JSON.stringify(result));})]);
  await new Promise(resolve=>setTimeout(resolve,100));
  const earlyClosed=closed.some(item=>item.composeStillHeld);
  held=false; releaseResolve();
  const result=await attempt;
  const final=await runtime.operations.drain(operationId);
  const proof={earlyClosed,closed,returnedError:result.error,operationState:final.operation.state,
    ownerError:final.operation.lastError,mcpStatus:f.catalog.mcpOperation("reviewer-lost-mcp-receipt").status,published};
  console.log("REVIEWER_MCP_ACK_PROOF "+JSON.stringify(proof));
  assert.equal(earlyClosed,false,"task/catalog stores must remain open until the admitted same-original owner drains");
  assert.equal(final.operation.state,"done",JSON.stringify(final.operation.lastError));
  assert.equal(proof.mcpStatus,"unknown","release completion must not invent a terminal MCP receipt");
  assert.equal(published,1,"drain must not repeat publication");
  assert.match(result.error,/receipt reconciliation/u);
});
test("reviewer valid public get arguments do not gain a new file-size restriction", { timeout: 60000 }, async t => {
  const f=await fixture(t,{releaseManager:true});
  const store=new ReleaseOperationStore({dataDir:path.dirname(f.databaseFile)});
  const op=store.create({requestId:"reviewer-existing-operation",workspaceId:f.workspaceId,streamId:f.streamId,
    threadId:"fixture-thread",runnerVersion:"fixture",authorization:{taskIds:["fixture-task"],validationMode:"full",
      approvedTargets:[{targetId:"fixture",kind:"fixture",repositoryRoot:f.primary}]}}).operation;
  const request={operation_id:op.operationId};
  const file=path.join(f.root,"get.json");
  const open=()=>openReleaseRuntime({openTaskRuntime:()=>openTaskAwaitCutoverRuntime({config:{
    dataDir:path.dirname(f.databaseFile),taskBoard:{autoPlaceConfidence:0.8}}})});
  const input={action:"get",provider:"codex",threadId:"fixture-thread",streamId:f.streamId,requestFile:file};
  await writeFile(file,JSON.stringify(request));
  const compact=await executeRelease(input,{openRuntime:open});
  const encoded=JSON.stringify(request)+" ".repeat(1024*1024);
  assert.deepEqual(JSON.parse(encoded),request);
  await writeFile(file,encoded);
  const runtime=await open();
  let direct;
  try {
    const token=runtime.service.contextToken({provider:input.provider,threadId:input.threadId,streamId:input.streamId});
    direct=await runtime.service.call("hub_release_get",{...JSON.parse(encoded),context_token:token});
  } finally {runtime.close();}
  assert.deepEqual(direct,compact);
  const actual=await executeRelease(input,{openRuntime:open}).then(value=>({value}),error=>({error:error.message}));
  console.log("REVIEWER_INPUT_SIZE_PROOF "+JSON.stringify({sameBusinessArgs:true,inputBytes:Buffer.byteLength(encoded),
    directPublicGetEqual:true,consumerError:actual.error,operationUnchanged:JSON.stringify(store.snapshot(op.operationId))===JSON.stringify(compact)}));
  assert.equal(actual.error,undefined,"ordinary source consumer must preserve existing public business arguments without an unrequested physical-file limit");
});
