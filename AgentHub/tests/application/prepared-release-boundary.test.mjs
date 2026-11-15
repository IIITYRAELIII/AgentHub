import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskReleasePlanService } from "../../src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";
import { WorkspaceReleaseOperationAdapter } from "../../src/application/workspace-release-operation-adapter.mjs";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";
import * as releaseDomain from "../../src/domain/release-operation.mjs";
const { createReleaseOperation, restoreReleaseOperation, effectiveReleaseTaskScope } = releaseDomain;

const execute = promisify(execFile);
async function git(cwd, ...args) {
  return (await execute("git", ["-c", "core.hooksPath=", ...args], { cwd, windowsHide: true })).stdout.trim();
}
async function commit(root, message) {
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

async function observeNativeGit(counts, run) {
  const original = childProcess.spawn;
  childProcess.spawn = function (executable, args, ...options) {
    if (/(?:^|[\\/])git(?:\.exe)?$/iu.test(String(executable)) && Array.isArray(args)) {
      const command = args.find(arg => ["merge", "merge-tree", "clone", "checkout", "bundle", "commit"].includes(arg));
      if (command) counts[command] = (counts[command] ?? 0) + 1;
    }
    return Reflect.apply(original, this, [executable, args, ...options]);
  };
  syncBuiltinESMExports();
  try { return await run(); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
}

// Git, SQLite, catalog intake, public MCP and the actual prepared/freeze owner
// are real. Only prior Task acceptance evidence and external validation/effects
// are controlled ports. No publication or full pipeline is invoked.
async function fixture(t, { conflicting = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prepared-release-"));
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git");
  await mkdir(primary); await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, "shared.txt"), "base\n");
  await mkdir(path.join(primary, "AgentHub"));
  const pkg = { name: "agent-hub", version: "2.0.3", type: "module" };
  await writeFile(path.join(primary, "AgentHub/package.json"), JSON.stringify(pkg));
  await writeFile(path.join(primary, "AgentHub/package-lock.json"), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { "": pkg } }));
  const base = await commit(primary, "agreed main");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "remote", "add", "origin", origin); await git(primary, "push", "origin", "main");
  const databaseFile = path.join(root, "hub.sqlite"), dataDir = path.join(root, "data");
  const catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Prepared fixture", settings: { workingDirectory: primary, releaseWorkflowEnabled: true } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true, workingDirectory: primary } }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "prepared-fixture", streamId: stream.id }));
  const taskStore = new TaskBoardStore({ databaseFile });
  const board = new TaskBoardService({ store: taskStore, workspaceCatalog: catalog });
  const results = new Map();
  const add = async (name, status = "awaiting_implementation", start = base) => {
    const row = taskStore.create({ text: name, bucket: "workspace", workspaceId: workspace.id });
    const folder = path.join(root, name);
    const branch = `agenthub/task/${row.id}/fixture`;
    await git(primary, "worktree", "add", "-b", branch, folder, start);
    const file = conflicting && ["A", "B"].includes(name) ? "shared.txt" : `${name}.txt`;
    await writeFile(path.join(folder, file), conflicting && ["A", "B"].includes(name) ? `base\n${name}\n` : `${name}\n`);
    const resultCommit = await commit(folder, name);
    taskStore.recordTaskGitReference({ taskId: row.id, projectRoot: primary, branch, resultSnapshot: { repoRoot: primary, tree: resultCommit } });
    taskStore.setWorkflowStatus(row.id, status);
    const value = { id: row.id, name, branch, folder, resultCommit, file }; results.set(row.id, value); return value;
  };
  const a = await add("A"), b = await add("B"), draft = await add("Draft", "testing");
  const taskGit = {
    assertExplicitUpstreamAdoption: async () => assert.fail("Native prepared capture must not synthesize adoption"),
    releaseEvidence: async ({ taskId }) => ({ changedFiles: [{ projectRoot: primary, path: results.get(taskId).file, operation: "added" }] }),
    releaseBaseEvidence: async () => ({ baseCommit: base, publishedBaseCommit: base }),
    releaseIntegrationEvidence: async ({ tasks }) => ({ tasks: tasks.map(x => ({ ...x, baseCommit: base })) }),
  };
  const planner = new TaskReleasePlanService({ taskBoard: board, taskGitWorkspaces: taskGit });
  const environment = { ...process.env, LOCALAPPDATA: path.join(root, "state"), XDG_STATE_HOME: path.join(root, "state") };
  const releaseGit = new ReleaseGitWorkspaceService({ dataDir, environment });
  let prepareCalls = 0, freezeCalls = 0;
  const originalPrepare = releaseGit.prepareCandidate.bind(releaseGit);
  releaseGit.prepareCandidate = async args => { prepareCalls++; return originalPrepare(args); };
  const originalGeneration = releaseGit.prepareGeneration.bind(releaseGit);
  releaseGit.prepareGeneration = async args => { freezeCalls++; return originalGeneration(args); };
  const publication = { generation: "private-fixture", repositories: [{ root: primary, revision: base }] };
  const spans = [];
  const preflight = new WorkspaceReleasePreflightService({ releasePlanner: planner, taskGitWorkspaces: taskGit,
    releaseGitWorkspaces: releaseGit, readPublicationState: async () => publication,
    resolveReleaseValidationSource: () => ({ kind: "workspace-release-pipeline", projectRoot: primary }),
    validateProductionCandidate: () => assert.fail("No full validation in prepared capture"),
    measureOperation: async (stage, run) => { const begin = performance.now(); try { return await run(); } finally { spans.push({ stage, durationMs: performance.now() - begin }); } },
  });
  const prepare = async () => {
    const plan = await planner.plan(workspace.id);
    assert.ok(plan.ready.length > 0, "synthetic accepted Task refs must be registered before preparation");
    const tasks = plan.ready.map(x => ({ ...x, baseCommit: base }));
    const request = { workspaceId: workspace.id, projectRoot: primary, approvedBaseCommit: base,
      planRevision: plan.revision, frozenTasks: tasks, baseProvenance: { schemaVersion: 1, kind: "agreed-main-native-git-v1", publishedBaseCommit: base, agreedMainCommit: base } };
    try { return await releaseGit.prepareCandidate(request); }
    catch (error) {
      if (!conflicting || error.code !== "RELEASE_NATIVE_MERGE_CONFLICT") throw error;
      await writeFile(path.join(error.conflictRoot, "shared.txt"), "base\nA\nB\n");
      await commit(error.conflictRoot, "retain both true-marker additions");
      return releaseGit.prepareCandidate(request);
    }
  };
  let validationCalls = 0;
  await mkdir(path.join(root, "operations"));
  const operationStore = new ReleaseOperationStore({ dataDir: path.join(root, "operations") });
  const never = () => assert.fail("Private release fixture never publishes or finalizes");
  const adapter = new WorkspaceReleaseOperationAdapter({ releasePreflight: preflight,
    publication: { publish: never, readback: async () => ({ status: "not_applied", fixture: true }) }, finalization: { finalize: never } });
  const scheduled = [];
  const operations = new ReleaseOperationService({ store: operationStore, schedule: fn => scheduled.push(fn),
    processAlive: pid => pid === process.pid, compose: input => adapter.compose(input),
    validate: async () => { validationCalls++; throw Object.assign(new Error("controlled affected validation failure"), { code: "RELEASE_VALIDATION_FAILED" }); },
    publishTarget: never, readTarget: async () => ({ status: "not_applied", fixture: true }), finalize: never,
    reservePublication: input => adapter.reservePublication(input), withTaskSelection: input => adapter.withTaskSelection(input),
  });
  const mcp = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, releasePreflight: preflight,
    releaseOperations: operations, workLog: { threadTurns: () => [] }, attachmentDirectory: path.join(root, "attachments"),
    secret: "private-synthetic-prepared-fixture", reconcilePendingOnStartup: false,
    releaseCompleter: { completeRelease: never } });
  const context_token = mcp.contextToken({ provider: "codex", threadId: "prepared-fixture" });
  let nextRequest = 0;
  const admitted = [];
  const run = async taskIds => {
    const ack = await mcp.call("hub_release_run", { context_token, request_id: `prepared-public-${++nextRequest}`,
      ...(taskIds == null ? {} : { task_ids: taskIds }), validation_mode: "full",
      approved_targets: [{ targetId: "private-target", kind: "agent-hub-publication", repositoryRoot: primary,
        approvedLocalMainCommit: base, approvedOriginMainCommit: base }] });
    assert.equal(ack.accepted, true); admitted.push(ack.operationId); scheduled.shift()();
    return { ack, snapshot: await operations.drain(ack.operationId) };
  };
  const continueOriginal = async operationId => {
    await mcp.call("hub_release_continue", { context_token, request_id: `prepared-continue-${++nextRequest}`, operation_id: operationId });
    if (scheduled.length) scheduled.shift()();
    return operations.drain(operationId);
  };
  const runLegacy = async () => {
    const ack = operations.start({ requestId: `legacy-public-${++nextRequest}`, workspaceId: workspace.id,
      streamId: stream.id, threadId: "prepared-fixture", authorization: { taskIds: [a.id, b.id].sort(), validationMode: "full",
        approvedTargets: [{ targetId: "private-target", kind: "agent-hub-publication", repositoryRoot: primary,
          approvedLocalMainCommit: base, approvedOriginMainCommit: base }] } });
    admitted.push(ack.operationId); scheduled.shift()();
    return { ack, snapshot: await operations.drain(ack.operationId) };
  };
  t.after(async () => {
    while (scheduled.length) scheduled.shift()();
    for (const id of admitted) await operations.drain(id);
    operationStore.close?.(); taskStore.close(); catalog.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, primary, base, a, b, draft, add, prepare, run, runLegacy, continueOriginal, planner, taskStore, board, results,
    releaseGit, preflight, operations, operationStore, mcp, context_token, workspace, adapter, spans, scheduled,
    counters: () => ({ prepareCalls, freezeCalls, validationCalls }) };
}

test("public release refuses a subset of an already prepared full Await composition", async t => {
  const f = await fixture(t);
  const candidate = await f.prepare(), before = f.counters();
  let outcome; const gitCounts = {};
  await observeNativeGit(gitCounts, async () => {
    try { outcome = await f.run([f.a.id]); } catch (error) { outcome = { refusal: error.message }; }
  });
  t.diagnostic(JSON.stringify({ stages: f.spans, before, after: f.counters(),
    gitCounts, selected: outcome.snapshot?.generations?.[0]?.selectedResults?.map(x => x.taskId), refusal: outcome.refusal }));
  assert.match(outcome.refusal ?? "", /whole current Await set/u);
  assert.equal(f.counters().freezeCalls, before.freezeCalls);
  assert.equal((await f.releaseGit.frozenCandidate(f.primary)).preReleaseHead, candidate.preReleaseHead);
});

test("public whole prepared release retains conflict resolution and captures without composing again", async t => {
  const f = await fixture(t, { conflicting: true });
  const candidate = await f.prepare(), before = f.counters();
  const checkpointFile = path.join(path.dirname(candidate.releaseRoot), "checkpoint.json");
  const checkpoint = await readFile(checkpointFile);
  const gitCounts = {};
  const result = await observeNativeGit(gitCounts, () => f.run());
  assert.equal(result.snapshot.operation.waitReason.code, "validation_failed");
  assert.equal(result.snapshot.generations.length, 1);
  const generation = result.snapshot.generations[0];
  assert.deepEqual(generation.authorizedTaskIds, [f.a.id, f.b.id].sort());
  assert.equal(generation.selectedResults.some(x => x.taskId === f.draft.id), false);
  assert.equal(generation.candidates[0].manifest.preparedCandidate.commit, candidate.preReleaseHead);
  assert.equal(await git(generation.candidates[0].releaseRoot, "show", `${candidate.preReleaseHead}:shared.txt`), "base\nA\nB");
  assert.equal(f.counters().prepareCalls, before.prepareCalls);
  assert.equal(f.spans.some(x => x.stage === "release:compose"), false);
  assert.equal(f.spans.filter(x => x.stage === "release:capture-prepared").length, 1);
  assert.equal(gitCounts.merge ?? 0, 0, "verification merge-tree must not become an ordinary Task merge");
  assert.ok(gitCounts["merge-tree"] > 0, "actual native history/content verification remains active");
  assert.deepEqual(await readFile(checkpointFile), checkpoint);
  assert.equal(await git(f.primary, "rev-parse", "HEAD"), f.base);
  t.diagnostic(JSON.stringify({ before, after: f.counters(), gitCounts, stages: f.spans }));
});

test("same public original captures corrected whole Await as next generation and preserves failed evidence", async t => {
  const f = await fixture(t);
  await f.prepare(); const first = await f.run();
  const original = first.snapshot.operation, generation = first.snapshot.generations[0];
  assert.ok(generation, JSON.stringify(first.snapshot.operation.lastError));
  const firstBytes = JSON.stringify(generation), receipts = first.snapshot.receipts;
  // Synthetic prior-acceptance port changes; the actual candidate owner prepares
  // the complete new set. No release call may perform this work implicitly.
  f.taskStore.setWorkflowStatus(f.b.id, "testing");
  const c = await f.add("C");
  assert.equal(f.operationStore.forTask(c.id).some(x => x.operationId === original.operationId), false);
  assert.equal(f.operationStore.forTask(c.id, { workspaceId: f.workspace.id }).some(x => x.operationId === original.operationId), true);
  assert.deepEqual(f.operationStore.forTask(c.id, { workspaceId: "foreign-workspace" }), []);
  await writeFile(path.join(f.a.folder, "A.txt"), "A corrected\n");
  const corrected = await commit(f.a.folder, "affected correction");
  f.a.resultCommit = corrected;
  f.taskStore.recordTaskGitReference({ taskId: f.a.id, projectRoot: f.primary, branch: f.a.branch, resultSnapshot: { repoRoot: f.primary, tree: corrected } });
  await f.prepare(); const before = f.counters();
  assert.deepEqual(f.operations.wakeForTask(c.id, { workspaceId: f.workspace.id }), [original.operationId]);
  const next = await f.continueOriginal(original.operationId);
  assert.equal(next.operation.operationId, original.operationId);
  assert.equal(next.operation.authorization.fingerprint, original.authorization.fingerprint);
  assert.equal(next.operation.currentGeneration, 2, JSON.stringify(next.operation.lastError));
  assert.equal(JSON.stringify(next.generations[0]), firstBytes);
  assert.deepEqual(next.generations[1].authorizedTaskIds, [f.a.id, c.id].sort());
  assert.equal(next.generations[1].selectedResults.find(x => x.taskId === f.a.id).resultCommit, corrected);
  assert.equal(next.generations[1].selectedResults.some(x => x.taskId === f.b.id || x.taskId === f.draft.id), false);
  assert.equal(f.counters().prepareCalls, before.prepareCalls);
  assert.equal(f.counters().validationCalls, 2, "changed code cannot borrow old validation success");
  assert.deepEqual(next.receipts.filter(x => x.generation === 1), receipts.filter(x => x.generation === 1));
  const restored = restoreReleaseOperation(structuredClone(next.operation));
  assert.equal(effectiveReleaseTaskScope(restored), "all_await");
  assert.equal(f.operationStore.forTask(c.id).some(x => x.operationId === original.operationId), true);
  let reserved = 0, recaptured = 0;
  const boundary = () => f.adapter.reservePublication({ operation: next.operation, generation: next.generations[1],
    reserve: () => { reserved++; return "reserved"; }, recompose: () => { recaptured++; return "recapture"; } });
  assert.equal(await boundary(), "reserved");
  f.taskStore.setWorkflowStatus(f.draft.id, "awaiting_implementation");
  assert.equal(await boundary(), "recapture");
  assert.deepEqual([reserved, recaptured], [1, 1]);
  const evidence = f.preflight.taskGitWorkspaces.releaseEvidence;
  f.preflight.taskGitWorkspaces.releaseEvidence = async input => {
    if (input.taskId === f.draft.id) throw new Error("controlled unavailable accepted result");
    return evidence(input);
  };
  await assert.rejects(boundary(), { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  assert.equal(reserved, 1, "a blocked Await must not disappear from publication membership");
});

test("prepared release refuses concurrent Await drift before immutable capture without hidden repair", async t => {
  const f = await fixture(t); await f.prepare();
  const before = f.counters(), source = await f.releaseGit.frozenCandidate(f.primary);
  const original = f.releaseGit.prepareGeneration.bind(f.releaseGit);
  let changed = false;
  f.releaseGit.prepareGeneration = async args => {
    if (!changed) { changed = true; f.taskStore.setWorkflowStatus(f.b.id, "testing"); }
    return original(args);
  };
  const result = await f.run();
  assert.equal(result.snapshot.operation.state, "waiting");
  assert.equal(result.snapshot.generations.length, 0);
  assert.equal(result.snapshot.operation.waitReason.code, "prepared_candidate_stale");
  assert.equal(f.counters().prepareCalls, before.prepareCalls);
  assert.equal((await f.releaseGit.frozenCandidate(f.primary)).preReleaseHead, source.preReleaseHead);
});

test("legacy authorization fingerprint stays exact and whole-set scope is explicit on same-original amendment", async t => {
  const f = await fixture(t); await f.prepare();
  const legacy = createReleaseOperation({ operationId: "legacy-snapshot", requestId: "legacy-request", workspaceId: f.workspace.id,
    streamId: "original-stream", threadId: "original-thread", runnerVersion: "fixture", createdAt: new Date().toISOString(),
    authorization: { taskIds: [f.a.id, f.b.id], validationMode: "full", approvedTargets: [{ targetId: "private", kind: "runtime" }] } });
  assert.equal(Object.hasOwn(legacy.authorization, "taskScope"), false);
  assert.deepEqual(restoreReleaseOperation(structuredClone(legacy)).authorization, legacy.authorization);
  const results = await f.runLegacy();
  const current = results.snapshot.operation;
  assert.equal(Object.hasOwn(current.authorization, "taskScope"), false);
  assert.equal(current.currentGeneration, 1, JSON.stringify(current.lastError));
  const args = { context_token: f.context_token, request_id: "explicit-whole-amendment", operation_id: current.operationId,
    task_scope: "all_await", expected_revision: current.revision, expected_generation: current.currentGeneration };
  const amended = await f.mcp.call("hub_release_continue", args);
  assert.equal(amended.accepted, true);
  const replay = await f.mcp.call("hub_release_continue", args);
  assert.equal(replay.duplicate, amended.duplicate, "MCP original replay returns its captured outcome");
  const saved = f.operationStore.get(current.operationId).testSelectionAmendments.at(-1);
  assert.equal(saved.taskScope, "all_await");
  assert.equal(saved.requestArguments.taskScope, "all_await");
  assert.equal(Object.hasOwn(saved.requestArguments, "taskIds"), false);
  assert.deepEqual(restoreReleaseOperation(f.operationStore.get(current.operationId)).authorization, current.authorization);
  await assert.rejects(f.mcp.call("hub_release_continue", { ...args, task_scope: undefined }), /MCP request_id was already used for another operation/u);
  f.scheduled.shift()();
  const captured = await f.operations.drain(current.operationId);
  assert.equal(captured.generations[1].sourceFingerprint.endsWith(`:all_await:${saved.identitySha256}`), true);
  assert.equal(captured.generations[0].sourceFingerprint.includes(":all_await:"), false);
});

test("whole-set scope cannot be removed or forged during restore and legacy fingerprints remain unchanged", () => {
  const args = { operationId: "scoped-original", requestId: "scoped-request", workspaceId: "workspace",
    streamId: "stream", threadId: "thread", runnerVersion: "fixture", createdAt: "2026-10-29T00:00:00.000Z",
    authorization: { taskIds: ["accepted-task"], taskScope: "all_await", validationMode: "full",
      approvedTargets: [{ targetId: "runtime", kind: "runtime" }] } };
  const original = createReleaseOperation(args);
  assert.deepEqual(restoreReleaseOperation(original), original);
  const omitted = structuredClone(original); delete omitted.authorization.taskScope;
  assert.equal(restoreReleaseOperation(omitted), null);
  const legacyArgs = structuredClone(args); delete legacyArgs.authorization.taskScope;
  const legacy = createReleaseOperation(legacyArgs);
  assert.deepEqual(restoreReleaseOperation(legacy), legacy);
  const forged = structuredClone(legacy); forged.authorization.taskScope = "all_await";
  assert.equal(restoreReleaseOperation(forged), null);
});

test("public release waits for a missing prepared set without invoking composition", async t => {
  const f = await fixture(t), before = f.counters();
  const result = await f.run();
  assert.equal(result.snapshot.operation.waitReason.code, "prepared_candidate_stale");
  assert.equal(result.snapshot.operation.state, "waiting");
  assert.equal(result.snapshot.generations.length, 0);
  assert.equal(f.counters().prepareCalls, before.prepareCalls);
  assert.equal(f.counters().freezeCalls, before.freezeCalls);
});

test("public prepared capture preserves a real read fault instead of hiding it as missing preparation", async t => {
  const f = await fixture(t);
  f.releaseGit.frozenCandidate = async () => { throw Object.assign(new Error("controlled fixture EIO"), { code: "EIO" }); };
  const result = await f.run();
  assert.equal(result.snapshot.operation.state, "failed");
  assert.equal(result.snapshot.operation.lastError.code, "EIO");
  assert.equal(result.snapshot.generations.length, 0);
  assert.equal(f.counters().prepareCalls, 0);
  assert.equal(f.counters().freezeCalls, 0);
});
