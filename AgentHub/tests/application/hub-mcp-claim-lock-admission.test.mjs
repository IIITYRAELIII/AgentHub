import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { taskRepositoryKey } from "../../src/domain/task-git-reference.mjs";
import { TaskClaimLockAdmissionError } from "../../src/domain/task-board-task.mjs";

const execute = promisify(execFile);
async function fixture(t, { dependencies = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claim-lock-"));
  const repo = path.join(root, "repo"), dataDir = path.join(root, "data");
  await mkdir(repo);
  const git = async (...args) => (await execute("git", args, { cwd: repo, windowsHide: true })).stdout.trim();
  await git("init", "--initial-branch=main");
  await writeFile(path.join(repo, "source.txt"), "untouched\n");
  if (dependencies) {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    await writeFile(path.join(repo, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }));
  }
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "main");
  const databaseFile = path.join(root, "hub.sqlite"), sessions = [];
  const open = async () => {
    const rawCatalog = new WorkspaceCatalogStore({ databaseFile }); await rawCatalog.load();
    const rawTasks = new TaskBoardStore({ databaseFile }); sessions.push({ rawCatalog, rawTasks });
    const caps = createPersistenceMutationCapabilities({ rawWorkspaceCatalogStore: rawCatalog, rawTaskBoardStore: rawTasks });
    return { rawCatalog, rawTasks, catalog: caps.workspaceCatalogStore,
      tasks: new TaskBoardService({ store: caps.taskBoardStore, workspaceCatalog: caps.workspaceCatalogStore }) };
  };
  t.after(async () => {
    for (const s of sessions) { s.rawTasks.close(); s.rawCatalog.close(); }
    await rm(root, { recursive: true, force: true });
  });
  const current = await open();
  const workspace = await current.catalog.createWorkspace({ name: "Lock fixture", settings: { workingDirectory: repo } });
  const caller = await current.catalog.createStream({ workspaceId: workspace.id, name: "Caller" });
  const manager = await current.catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true } });
  for (const s of [caller, manager]) await current.catalog.bindThread({ streamId: s.id, provider: "codex", threadId: s.id, projectRoot: repo });
  const created = await current.tasks.create({ text: "Fresh source", bucket: "workspace", workspaceId: workspace.id });
  const prior = current.tasks.task(created.id);
  const taskGit = new TaskGitWorkspaceService({ dataDir, recordTiming: () => {},
    prepareDependencies: () => assert.fail("A refused claim cannot prepare dependencies") });
  const service = (stores = current, startup = false) => {
    const hub = new HubMcpService({ workspaceCatalog: stores.catalog, taskBoard: stores.tasks, taskGitWorkspaces: taskGit,
      workLog: { threadTurns: async () => [] }, secret: "fixture-secret", attachmentDirectory: root,
      reconcilePendingOnStartup: startup, taskLifecycle: {}, releasePreflight: { preflight: async () => ({}) },
      releasePlanner: { plan: async () => ({ ready: [] }) }, releaseCompleter: { completeRelease: async () => ({}) } });
    hub.setActiveRuns(() => [{ id: "caller-run", provider: "codex", threadId: caller.id,
      streamId: caller.id, turnId: "caller-turn", status: "running" }]);
    hub.setDeferredInputs(() => []); return hub;
  };
  const hub = service();
  const input = { context_token: hub.contextToken({ provider: "codex", threadId: caller.id }),
    task_id: prior.id, request_id: "original-lock-claim", dependency_mode: "ensure" };
  const reconcile = (h, requestId, overrides = {}) => h.call("hub_task_operation_reconcile", {
    context_token: h.contextToken({ provider: "codex", threadId: manager.id }), request_id: requestId,
    task_id: prior.id, operation_request_id: input.request_id, project_root: repo, confirm_reconcile: true, ...overrides });
  const untouched = async () => {
    assert.deepEqual(current.tasks.task(prior.id), prior);
    assert.equal(current.tasks.claimBindingForOperation(input.request_id), null);
    assert.equal(await git("status", "--porcelain"), "");
    assert.equal(await git("for-each-ref", "--format=%(refname)"), "refs/heads/main");
    await assert.rejects(access(path.join(dataDir, "task-worktrees", prior.id)), { code: "ENOENT" });
  };
  return { ...current, root, repo, dataDir, taskGit, service, open, hub, input, prior, reconcile, untouched, caller, manager, workspace };
}

async function holdRepository(f, target = path.join(f.dataDir, "locks", `task-git-dev-${taskRepositoryKey(f.repo)}`)) {
  const uri = pathToFileURL(path.resolve("src/infrastructure/process/interprocess-lock.mjs")).href;
  const script = `import { withInterprocessLocks } from ${JSON.stringify(uri)};
    await withInterprocessLocks([${JSON.stringify(target)}], async () => {
      console.log('OWNED');
      await new Promise(resolve => { const timer=setTimeout(resolve, 85000);
        process.stdin.once('end', () => { clearTimeout(timer); resolve(); }); process.stdin.resume(); });
      process.stdin.destroy();
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", b => { stderr += b; });
  const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr))); });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", b => { if (String(b).includes("OWNED")) resolve(); });
    child.once("exit", () => reject(new Error(`holder ended before acquisition: ${stderr}`)));
  });
  return { async release() { child.stdin.end(); await exit; } };
}

test("real repository lock timeout seals pre-effect claim refusal and exact readback never assigns", { timeout: 90000 }, async t => {
  let holder; t.after(async () => holder?.release());
  const f = await fixture(t); holder = await holdRepository(f);
  const pending = f.hub.call("hub_task_claim", f.input);
  await assert.rejects(f.reconcile(f.hub, "live-reconcile"), /active|still running|unavailable/);
  let refusal;
  await assert.rejects(pending, e => { refusal = e; return e.code === "TASK_CLAIM_LOCK_ADMISSION_TIMEOUT"; });
  const receipt = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.receiptState, "failed");
  assert.equal(receipt.result.outcome, "NO_EFFECT");
  assert.equal(receipt.result.evidence.kind, "task-claim-lock-admission-v1");
  assert.equal(await f.taskGit.claimAdmissionNoEffectEvidence({ taskId: f.prior.id,
    projectRoot: f.repo, operationId: "foreign-original", error: refusal }), null);
  await f.untouched();
  await holder.release(); holder = null;
  await assert.rejects(f.hub.call("hub_task_claim", f.input), e => e.code === "TASK_CLAIM_LOCK_ADMISSION_TIMEOUT");
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), receipt);
  await assert.rejects(f.hub.call("hub_task_claim", { ...f.input, dependency_mode: "verify" }), /already used/);
  await assert.rejects(f.hub.call("hub_task_claim", { ...f.input,
    context_token: f.hub.contextToken({ provider: "codex", threadId: f.manager.id }) }), /already used/);
  await assert.rejects(f.reconcile(f.hub, "foreign-task", { task_id: "different-task" }), /exact durable/);
  await assert.rejects(f.reconcile(f.hub, "foreign-root", { project_root: f.dataDir }), /locator/);
  await assert.rejects(f.tasks.claim({ id: f.prior.id, workspaceId: f.workspace.id, streamId: f.caller.id,
    provider: "codex", threadId: f.caller.id, turnId: "late-turn", operationId: f.input.request_id }), /durably refused/);
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), receipt);
  const read = await f.reconcile(f.hub, "terminal-readback");
  assert.equal(read.outcome, "NO_EFFECT");
  assert.equal(read.operationId, f.input.request_id);
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), receipt);
  await f.untouched();
});

test("typed timeout without the live Git owner's proof cannot settle an unsealed original", async t => {
  const f = await fixture(t);
  f.taskGit.prepareOwned = async () => { throw new TaskClaimLockAdmissionError(); };
  await assert.rejects(f.hub.call("hub_task_claim", f.input), { code: "TASK_CLAIM_LOCK_ADMISSION_TIMEOUT" });
  const original = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(original.status, "unknown"); assert.equal(original.result, null);
  await assert.rejects(f.reconcile(f.hub, "unsealed-readback"), /exact durable/);
  await assert.rejects(f.hub.call("hub_task_claim", f.input), /outcome is unknown/);
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), original);
  await f.untouched();
});

test("typed failure after real Git preparation remains UNKNOWN and is not a no-effect refusal", async t => {
  const f = await fixture(t);
  const prepare = f.taskGit.prepareOwned.bind(f.taskGit);
  f.taskGit.prepareOwned = async input => { await prepare(input); throw new TaskClaimLockAdmissionError(); };
  await assert.rejects(f.hub.call("hub_task_claim", f.input), { code: "TASK_CLAIM_LOCK_ADMISSION_TIMEOUT" });
  const original = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(original.status, "unknown"); assert.equal(original.result, null);
  await access(path.join(f.dataDir, "task-worktrees", f.prior.id));
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  await assert.rejects(f.reconcile(f.hub, "partial-readback"), /exact durable/);
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), original);
});

test("admitted assignment with a lost outer receipt cannot be classified as lock refusal", async t => {
  const f = await fixture(t);
  f.rawCatalog.completeMcpOperation = () => { throw Error("lost committed assignment reply"); };
  await assert.rejects(f.hub.call("hub_task_claim", f.input), /receipt reconciliation/);
  const original = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(original.status, "unknown"); assert.equal(original.result, null);
  assert.ok(f.tasks.claimBindingForOperation(f.input.request_id));
  await assert.rejects(f.reconcile(f.hub, "admitted-readback"), /exact durable/);
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), original);
});

test("sealed lock refusal survives receipt-write loss and RM reconciliation after reopen", { timeout: 90000 }, async t => {
  let holder; t.after(async () => holder?.release());
  const f = await fixture(t); holder = await holdRepository(f);
  f.rawCatalog.failMcpOperation = () => { throw Error("lost outer terminal write"); };
  await assert.rejects(f.hub.call("hub_task_claim", f.input), /lost outer terminal write/);
  const unknown = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.result.evidence.kind, "task-claim-lock-admission-v1");
  await f.untouched(); await holder.release(); holder = null;
  const second = await f.open(), hub = f.service(second);
  const result = await f.reconcile(hub, "reopen-reconcile");
  assert.equal(result.outcome, "NO_EFFECT");
  const terminal = second.catalog.mcpOperation(f.input.request_id);
  assert.equal(terminal.status, "failed");
  assert.deepEqual(terminal.result.operatorReconciliation.evidence, unknown.result.evidence);
  const again = await f.reconcile(hub, "second-readback");
  assert.equal(again.outcome, "NO_EFFECT");
  assert.deepEqual(second.catalog.mcpOperation(f.input.request_id), terminal);
  await f.untouched();
});

test("pending sealed lock refusal recovers at startup after both outer writes are lost", { timeout: 90000 }, async t => {
  let holder; t.after(async () => holder?.release());
  const f = await fixture(t); holder = await holdRepository(f);
  f.rawCatalog.failMcpOperation = () => { throw Error("process lost before terminal receipt"); };
  f.rawCatalog.markMcpOperationUnknown = () => { throw Error("process already lost"); };
  await assert.rejects(f.hub.call("hub_task_claim", f.input), /process lost/);
  const pending = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(pending.status, "pending"); assert.equal(pending.result.evidence.kind, "task-claim-lock-admission-v1");
  await holder.release(); holder = null;
  const stores = await f.open(), hub = f.service(stores, true);
  await assert.rejects(hub.call("hub_task_claim", f.input), { code: "TASK_CLAIM_LOCK_ADMISSION_TIMEOUT" });
  const terminal = stores.catalog.mcpOperation(f.input.request_id);
  assert.equal(terminal.status, "failed"); assert.deepEqual(terminal.result, pending.result);
  await f.untouched();
});

test("real dependency lock timeout after source preparation remains UNKNOWN", { timeout: 90000 }, async t => {
  let holder; t.after(async () => holder?.release());
  const f = await fixture(t, { dependencies: true });
  holder = await holdRepository(f, path.join(f.dataDir, "locks", `task-dependencies-${f.prior.id}-${taskRepositoryKey(f.repo)}`));
  await assert.rejects(f.hub.call("hub_task_claim", f.input), { code: "INTERPROCESS_LOCK_ADMISSION_TIMEOUT" });
  const original = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(original.status, "unknown"); assert.equal(original.result, null);
  await access(path.join(f.dataDir, "task-worktrees", f.prior.id));
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  await holder.release(); holder = null;
  await assert.rejects(f.reconcile(f.hub, "dependency-readback"), /exact durable/);
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), original);
});
