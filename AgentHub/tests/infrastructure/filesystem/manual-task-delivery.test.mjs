import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readManualTaskDelivery } from "../../../src/infrastructure/filesystem/manual-task-delivery.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { HubMcpService } from "../../../src/application/hub-mcp-service.mjs";
import { DesktopControlServer, readDesktopControlEndpoint, desktopControlEndpointFile, desktopControlSecretFile } from "../../../src/infrastructure/process/desktop-control.mjs";
import { runtimeStatus } from "../../../src/runtime/runtime-manager.mjs";

const sha = b => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-manual-delivery-"));
  const beforeCleanup = [];
  t.after(async () => { for (const close of beforeCleanup) await close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const repo = path.join(root, "repo"), runtimeRoot = path.join(root, "runtime");
  await mkdir(path.join(repo, "AgentHub"), { recursive: true });
  const git = (args, options = {}) => runTaskGitCommand(args, { ...options, cwd: repo });
  await git(["init", "-b", "main"]);
  await git(["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repo, ".gitignore"), "WIP/\nnode_modules/\n");
  await writeFile(path.join(repo, "AgentHub/app.mjs"), "export const version = 'base';\n");
  const commit = async (cwd = repo) => {
    await runTaskGitCommand(["add", "."], { cwd });
    await runTaskGitCommand(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd });
    return runTaskGitCommand(["rev-parse", "HEAD"], { cwd });
  };
  const base = await commit();
  await git(["update-ref", "refs/remotes/origin/main", base]);
  let observed = { pid: 1, running: true, ready: true, current: "manual", runningRelease: "manual", restartRequired: false };
  const ports = { verifyInstalled: async () => true, status: async () => ({ ...observed }) };
  const install = async revision => {
    const release = path.join(runtimeRoot, "releases/manual");
    await mkdir(release, { recursive: true });
    const body = Buffer.from(await git(["show", `${revision}:AgentHub/app.mjs`], { rawOutput: true }));
    await writeFile(path.join(release, "app.mjs"), body);
    const raw = JSON.stringify({ releaseId: "manual", publicationRevision: revision,
      files: [{ path: "app.mjs", bytes: body.length, sha256: sha(body) }] });
    await writeFile(path.join(release, "runtime-manifest.json"), raw);
    await writeFile(path.join(runtimeRoot, "current.json"), JSON.stringify({ current: "manual" }));
    return { revision, releaseId: "manual", manifestSha256: sha(raw) };
  };
  const input = await install(base);
  let health = { live: true, ready: true, process: { pid: observed.pid, releaseId: "manual", instanceId: "fixture" } };
  const control = new DesktopControlServer({ runtimeRoot, protectSecret: async () => {}, handler: ({ action }) => {
    assert.equal(action, "runtime-health"); return health;
  } });
  await control.start();
  beforeCleanup.push(() => control.close());
  const read = options => readManualTaskDelivery({ runtimeRoot, input, git, ...ports, ...options });
  return { root, repo, runtimeRoot, git, commit, base, input, read, ports, install, beforeCleanup,
    control, setHealth: value => { health = value; },
    setStatus: value => { observed = { ...observed, ...value }; } };
}

test("manual delivery verifies actual Git containment and rejects source/manifest/pointer/ready/installation drift", async t => {
  const f = await fixture(t);
  assert.equal((await f.read({ resultCommits: [f.base] })).revision, f.base);
  await assert.rejects(f.read({ input: { ...f.input, manifestSha256: "0".repeat(64) } }), /manifest/u);
  await assert.rejects(f.read({ verifyInstalled: async () => false }), /verification failed/u);
  f.setStatus({ ready: false });
  await assert.rejects(f.read(), /ready installed/u); f.setStatus({ ready: true });
  await writeFile(path.join(f.runtimeRoot, "releases/manual/app.mjs"), "forged\n");
  // Even a positive installation port cannot turn different runtime bytes into Git source proof.
  await assert.rejects(f.read(), /source differs/u);
  await f.install(f.base);
  await assert.rejects(f.read({ resultCommits: ["f".repeat(40)] }));
  await assert.rejects(f.read({ verifyInstalled: async () => {
    await writeFile(path.join(f.runtimeRoot, "current.json"), '{"current":"other"}'); return true;
  } }), /changed during/u);
});

test("manual delivery requires authenticated live control matching the Ready PID/release and stable endpoint", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.runtimeRoot, "data"), { recursive: true });
  await writeFile(path.join(f.runtimeRoot, "data/bot.lock"), JSON.stringify({ pid: process.pid, releaseId: "manual", ready: true }));
  const health = { live: true, ready: true, process: { pid: process.pid, releaseId: "manual", instanceId: "exact" } };
  f.setHealth(health);
  const read = options => f.read({ status: runtimeStatus, ...options });
  const positive = await read();
  assert.equal(positive.running.pid, process.pid);
  assert.equal(positive.running.endpoint.endpointId, (await readDesktopControlEndpoint(f.runtimeRoot)).endpointId);
  for (const wrong of [
    { ...health, live: false }, { ...health, ready: false },
    { ...health, process: { ...health.process, pid: process.pid + 1 } },
    { ...health, process: { ...health.process, releaseId: "foreign" } },
  ]) { f.setHealth(wrong); await assert.rejects(read(), /authenticated ready/u); }
  f.setHealth(health);
  const secretFile = desktopControlSecretFile(f.runtimeRoot);
  const secret = await readFile(secretFile);
  try {
    await writeFile(secretFile, "foreign-fixture-secret-".repeat(4));
    await assert.rejects(read(), /authentication failed/u);
  } finally { await writeFile(secretFile, secret); }
  const originalEndpoint = await readDesktopControlEndpoint(f.runtimeRoot);
  await assert.rejects(read({ verifyInstalled: async () => {
    const endpointId = "f".repeat(64);
    await writeFile(desktopControlEndpointFile(f.runtimeRoot), JSON.stringify({ protocol: 2, endpointId,
      pipeName: `agent-hub-desktop-${endpointId}` }));
    return true;
  } }));
  await writeFile(desktopControlEndpointFile(f.runtimeRoot), JSON.stringify(originalEndpoint));
  await assert.rejects(read({ verifyInstalled: async () => {
    f.setHealth({ ...health, process: { ...health.process, instanceId: "replacement" } }); return true;
  } }), /changed during/u);
  f.setHealth(health);
  await f.control.close();
  // This live PID and retained Ready lock belong to the test process, not Hub.
  const stale = await runtimeStatus({ runtimeRoot: f.runtimeRoot, requireProcessEvidence: true });
  assert.equal(stale.ready, true); assert.equal(stale.pid, process.pid);
  await assert.rejects(read(), /ENOENT/u);
});

test("manual completion closes through SQLite lifecycle while retaining ignored data, branch and worktree; exact retry survives reopen", async t => {
  const f = await fixture(t);
  let raw = new TaskBoardStore({ databaseFile: path.join(f.root, "journal.sqlite") });
  f.beforeCleanup.push(() => raw.close());
  const workspace = { id: "workspace", settings: {} };
  const catalog = { hierarchy: () => [workspace], workspace: () => workspace, stream: () => null };
  const task = raw.create({ text: "Delivered", bucket: "workspace", workspaceId: workspace.id });
  const service = new TaskGitWorkspaceService({ dataDir: path.join(f.root, "data"), runtimeRoot: f.runtimeRoot,
    recordTiming: () => {}, readManualDelivery: args => readManualTaskDelivery({ ...args, ...f.ports }) });
  const source = await service.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: f.repo, dependencyMode: "skip" });
  const wip = path.join(source.projectRoot, "WIP/evidence.txt");
  await mkdir(path.dirname(wip), { recursive: true }); await writeFile(wip, "unique evidence");
  raw.beginLifecycleTransition(task.id, { operationId: "done", targetWorkflowStatus: "done", expectedRevision: task.revision });
  raw.commitWorkflowTransition({ operationId: "done", gitReferences: [{ projectRoot: f.repo, branch: source.branch, resultCommit: f.base }] });
  const lifecycle = () => new TaskLifecycleService({ taskBoard: new TaskBoardService({ store: raw, workspaceCatalog: catalog }),
    workspaceCatalog: catalog, taskGitWorkspaces: service });
  const args = { taskId: task.id, completionMode: "manual_delivery", manualDelivery: f.input };
  const preview = await lifecycle().complete({ ...args, operationId: "preview" });
  assert.deepEqual(preview.preview.deleting, []);
  assert.ok(preview.preview.retainedIgnored.some(x => x.path === "WIP/"));
  await assert.rejects(lifecycle().complete({ ...args, operationId: "bad", confirmCleanup: true, expectedCleanupToken: "bad" }), /confirmation/u);
  const confirmed = { ...args, operationId: "close", confirmCleanup: true, expectedCleanupToken: preview.cleanupToken };
  confirmed.originalArguments = { task_id: task.id, request_id: "close", completion_mode: "manual_delivery",
    manual_delivery: f.input, confirm_cleanup: true, expected_cleanup_token: preview.cleanupToken };
  const result = await lifecycle().complete(confirmed);
  assert.equal(result.status, "done"); assert.equal(result.workflowStatus, "done");
  assert.equal(await readFile(wip, "utf8"), "unique evidence");
  assert.equal(await f.git(["rev-parse", source.branch]), f.base);
  assert.equal((await service.describe(task.id))[0].headCommit, f.base);
  raw.close(); raw = new TaskBoardStore({ databaseFile: path.join(f.root, "journal.sqlite") });
  assert.deepEqual(await lifecycle().complete(confirmed), result);
  assert.ok(raw.lifecycleOutcome("close").result.evidence.manualDelivery);
});

test("manual main-to-dev sync retains an isolated conflict, refuses origin drift, then consumes normal resolution without losing later dev work", async t => {
  const f = await fixture(t);
  const service = new TaskGitWorkspaceService({ dataDir: path.join(f.root, "data"), runtimeRoot: f.runtimeRoot,
    recordTiming: () => {}, readPublication: async () => { throw Error("old publication must not be read"); },
    readManualDelivery: args => readManualTaskDelivery({ ...args, ...f.ports }) });
  const dev = await service.prepareDev(f.repo);
  await writeFile(path.join(dev.projectRoot, "AgentHub/app.mjs"), "export const version = 'later-dev';\n");
  await writeFile(path.join(dev.projectRoot, "later.txt"), "keep later Task work\n");
  const oldDev = await f.commit(dev.projectRoot);
  await writeFile(path.join(f.repo, "AgentHub/app.mjs"), "export const version = 'delivered-main';\n");
  const main = await f.commit(); await f.git(["update-ref", "refs/remotes/origin/main", main]);
  const delivery = await f.install(main);
  const options = { projectRoot: f.repo, publishedRevision: main, manualSync: {
    operationId: "manual-post-delivery", workspaceId: "workspace", expectedDevCommit: oldDev, delivery } };
  const conflict = await service.synchronizeMainIntoDev(options);
  assert.equal(conflict.status, "review_required"); assert.equal(conflict.integrated, false);
  assert.equal(await f.git(["rev-parse", "dev"]), oldDev);
  const native = conflict.nativeConflictRoot;
  assert.ok(native && native !== dev.projectRoot);
  await writeFile(path.join(native, "AgentHub/app.mjs"), "export const version = 'delivered-main';\nexport const later = 'later-dev';\n");
  const resolution = await f.commit(native);
  await f.git(["update-ref", "refs/remotes/origin/main", f.base]);
  await assert.rejects(service.synchronizeMainIntoDev(options), /main\/origin/u);
  assert.equal(await f.git(["rev-parse", "dev"]), oldDev);
  await f.git(["update-ref", "refs/remotes/origin/main", main]);
  const run = service.runCommand;
  let injected = false;
  service.runCommand = async (args, options) => {
    const result = await run(args, options);
    if (!injected && args[0] === "update-ref" && args[1] === "refs/heads/dev") {
      injected = true; throw Object.assign(Error("lost dev CAS reply"), { processTreeStopped: true });
    }
    return result;
  };
  await assert.rejects(service.synchronizeMainIntoDev(options), error => error.code === "PUBLISHED_DEV_SYNC_UNKNOWN");
  assert.equal(injected, true);
  assert.equal(await f.git(["rev-parse", "dev"]), resolution);
  service.runCommand = run;
  const result = await service.synchronizeMainIntoDev(options);
  assert.equal(result.integrated, true); assert.equal(result.headCommit, resolution);
  await f.git(["merge-base", "--is-ancestor", oldDev, resolution]);
  await f.git(["merge-base", "--is-ancestor", main, resolution]);
  assert.equal(await readFile(path.join(dev.projectRoot, "later.txt"), "utf8"), "keep later Task work\n");
  assert.equal((await service.synchronizeMainIntoDev(options)).headCommit, resolution);
  assert.equal(await f.git(["rev-parse", "main"]), main);
  assert.equal(await f.git(["status", "--porcelain"]), "");
});

test("public manual Complete reconciles its exact lost reply without replaying completion or deleting artifacts", async t => {
  const f = await fixture(t);
  const databaseFile = path.join(f.root, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const raw = new TaskBoardStore({ databaseFile });
  f.beforeCleanup.push(() => { raw.close(); catalog.close(); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Manual", settings: { workingDirectory: f.repo } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true } }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "rm", streamId: stream.id }));
  const board = new TaskBoardService({ store: raw, workspaceCatalog: catalog });
  const task = raw.create({ text: "Manually delivered", bucket: "workspace", workspaceId: workspace.id });
  const taskGit = new TaskGitWorkspaceService({ dataDir: path.join(f.root, "data"), runtimeRoot: f.runtimeRoot,
    recordTiming: () => {}, readManualDelivery: args => readManualTaskDelivery({ ...args, ...f.ports }) });
  const managed = await taskGit.prepare({ taskId: task.id, projectRoot: f.repo, dependencyMode: "skip" });
  raw.beginLifecycleTransition(task.id, { operationId: "done", targetWorkflowStatus: "done", expectedRevision: task.revision });
  raw.commitWorkflowTransition({ operationId: "done", gitReferences: [{ projectRoot: f.repo, branch: managed.branch, resultCommit: f.base }] });
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: taskGit });
  const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, taskGitWorkspaces: taskGit, taskLifecycle: lifecycle,
    workLog: { threadTurns: () => [] }, attachmentDirectory: f.root, secret: "fixture", reconcilePendingOnStartup: false });
  const token = hub.contextToken({ provider: "codex", threadId: "rm" });
  const call = (name, args) => hub.call(name, { context_token: token, ...args });
  const business = { task_id: task.id, completion_mode: "manual_delivery", manual_delivery: f.input };
  const p = await call("hub_task_complete", { ...business, request_id: "preview" });
  const complete = catalog.completeMcpOperation.bind(catalog);
  let lost = false;
  catalog.completeMcpOperation = (id, ...args) => {
    if (id === "original" && !lost) { lost = true; throw Error("controlled lost terminal MCP write"); }
    return complete(id, ...args);
  };
  await assert.rejects(call("hub_task_complete", { ...business, request_id: "original", confirm_cleanup: true,
    expected_cleanup_token: p.cleanupToken }), /effect completed but receipt reconciliation is required/);
  assert.equal(board.task(task.id).status, "done");
  const outcome = board.lifecycleOutcome("original");
  assert.ok(outcome.result.evidence.manualDelivery);
  taskGit.manualDeliveryPreviewOwned = () => assert.fail("terminal readback must not replay proof or completion");
  const recovered = await call("hub_task_operation_reconcile", { request_id: "recover", task_id: task.id,
    operation_request_id: "original", confirm_reconcile: true });
  assert.equal(recovered.outcome, "COMPLETED");
  assert.equal(recovered.result.id, task.id);
  assert.equal(catalog.mcpOperation("original").status, "succeeded");
  assert.deepEqual(board.lifecycleOutcome("original"), outcome);
  assert.equal(await f.git(["rev-parse", managed.branch]), f.base);
  assert.equal((await taskGit.describe(task.id))[0].headCommit, f.base);
});
