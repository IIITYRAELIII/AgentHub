import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readManualTaskDelivery } from "../../../src/infrastructure/filesystem/manual-task-delivery.mjs";
import { createManualDevResolutionBinding, assertNativeMergedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { verifyManualDevResolutionReview } from "../../../src/infrastructure/persistence/manual-dev-resolution-review.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { HubMcpService } from "../../../src/application/hub-mcp-service.mjs";
import { DesktopControlServer, readDesktopControlEndpoint, desktopControlEndpointFile, desktopControlSecretFile } from "../../../src/infrastructure/process/desktop-control.mjs";
import { runtimeStatus } from "../../../src/runtime/runtime-manager.mjs";
import { mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import { runtimeHostSourceHash } from "../../../src/infrastructure/process/runtime-host-source-identity.mjs";

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
  const install = async (revision, sourceGit = git) => {
    const release = path.join(runtimeRoot, "releases/manual");
    await mkdir(release, { recursive: true });
    const body = Buffer.from(await sourceGit(["show", `${revision}:AgentHub/app.mjs`], { rawOutput: true }));
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

async function publicFixture(t) {
  const f = await fixture(t), databaseFile = path.join(f.root, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  const raw = new TaskBoardStore({ databaseFile });
  f.beforeCleanup.push(() => { raw.close(); catalog.close(); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Manual", settings: {
    workingDirectory: f.repo, releaseWorkflowEnabled: true,
  } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true } }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "rm", streamId: stream.id }));
  const board = new TaskBoardService({ store: raw, workspaceCatalog: catalog });
  const task = raw.create({ text: "Actual delivery", bucket: "workspace", workspaceId: workspace.id });
  const taskGit = new TaskGitWorkspaceService({ dataDir: path.join(f.root, "data"), runtimeRoot: f.runtimeRoot,
    recordTiming: () => {}, readManualDelivery: args => readManualTaskDelivery({ ...args, ...f.ports }) });
  const managed = await taskGit.prepare({ taskId: task.id, projectRoot: f.repo, dependencyMode: "skip" });
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: taskGit });
  const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, taskGitWorkspaces: taskGit, taskLifecycle: lifecycle,
    workLog: { threadTurns: () => [] }, attachmentDirectory: f.root, secret: "fixture", reconcilePendingOnStartup: false });
  const token = hub.contextToken({ provider: "codex", threadId: "rm" });
  return { ...f, raw, catalog, board, task, taskGit, managed, lifecycle, hub,
    call: (name, args) => hub.call(name, { context_token: token, ...args }) };
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

async function reviewedSyncFixture(t) {
  const f = await fixture(t), dataDir = path.join(f.root, "reviewed-data");
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(dataDir, "journal.sqlite") }); await catalog.load();
  const raw = new TaskBoardStore({ databaseFile: path.join(dataDir, "journal.sqlite") });
  f.beforeCleanup.push(() => { raw.close(); catalog.close(); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Manual sync", settings: {
    workingDirectory: f.repo, releaseWorkflowEnabled: true,
  } }));
  const streams = {};
  for (const [name, settings] of [["author", {}], ["reviewer", { model: "gpt-6.1-sol" }], ["operator", { releaseManager: true }]]) {
    streams[name] = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name, settings }));
    await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: name, streamId: streams[name].id }));
  }
  const task = raw.create({ text: "Retain Task compatibility", bucket: "workspace", workspaceId: workspace.id });
  raw.claim(task.id, { workspaceId: workspace.id, streamId: streams.author.id, provider: "codex", threadId: "author",
    turnId: "author-turn", operationId: "own-task" });
  const board = new TaskBoardService({ store: raw, workspaceCatalog: catalog });
  const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, workLog: { threadTurns: () => [] },
    attachmentDirectory: f.root, secret: "private-review-fixture", reconcilePendingOnStartup: false });
  // Only recipient transport is controlled. Authentication, origin content hash
  // and durable inter-Stream receipt are the actual public MCP owner, not a
  // callback claiming that a native review is valid.
  hub.setStreamMessenger(async input => ({ accepted: true, id: input.clientUserMessageId, provider: "codex" }));
  const send = async (binding, requestId, sender = "reviewer") => {
    const text = `<native-merge-review>${JSON.stringify({ kind: "native-merge-review-v1", verdict: "ACCEPT", binding })}</native-merge-review>`;
    const result = await hub.call("hub_stream_message_send", { context_token: hub.contextToken({ provider: "codex", threadId: sender }),
      request_id: requestId, stream_id: streams.operator.id, mode: "steer", text, confirm_send: true });
    assert.equal(result.delivery.accepted, true);
    assert.equal(catalog.mcpOperation(requestId).status, "succeeded");
    return { requestId, text };
  };
  const service = new TaskGitWorkspaceService({ dataDir, runtimeRoot: f.runtimeRoot, recordTiming: () => {},
    readManualDelivery: args => readManualTaskDelivery({ ...args, ...f.ports }) });
  const dev = await service.prepareDev(f.repo);
  await writeFile(path.join(dev.projectRoot, "left.txt"), "left Task\n");
  const left = await f.commit(dev.projectRoot);
  await writeFile(path.join(f.repo, "right.txt"), "published side\n");
  const right = await f.commit();
  const merge = (cwd, revision) => runTaskGitCommand(["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
    "merge", "--no-ff", "-m", "real criss-cross context", revision], { cwd });
  await merge(dev.projectRoot, right); await merge(f.repo, left);
  await writeFile(path.join(dev.projectRoot, "AgentHub/app.mjs"), "export const version = 'later-dev';\n");
  await writeFile(path.join(dev.projectRoot, "later.txt"), "later Task remains\n");
  const oldDev = await f.commit(dev.projectRoot);
  await writeFile(path.join(f.repo, "AgentHub/app.mjs"), "export const version = 'published';\n");
  const main = await f.commit(); await f.git(["update-ref", "refs/remotes/origin/main", main]);
  assert.deepEqual((await f.git(["merge-base", "--all", oldDev, main])).split("\n").sort(), [left, right].sort());
  const delivery = await f.install(main);
  const args = { projectRoot: f.repo, publishedRevision: main, manualSync: {
    operationId: "same-manual-sync", workspaceId: workspace.id, expectedDevCommit: oldDev, delivery } };
  const issued = await service.synchronizeMainIntoDev(args), native = issued.nativeConflictRoot;
  assert.equal(issued.status, "review_required");
  await writeFile(path.join(native, "AgentHub/app.mjs"), "export const version = 'published';\nexport const later = 'later-dev';\n");
  await writeFile(path.join(native, "compatibility.mjs"), "export const retainedTaskOwner = true;\n");
  const commit = await f.commit(native), journalFile = path.join(native, "../merge.json");
  const git = (a, opts) => runTaskGitCommand(a, { ...opts, cwd: native });
  const binding = async () => {
    const bytes = await readFile(journalFile), journal = JSON.parse(bytes);
    return createManualDevResolutionBinding({ git, root: path.dirname(native), identity: journal.identity,
      commit: await git(["rev-parse", "HEAD"]), taskId: task.id, originalJournalSha256: sha(bytes) });
  };
  return { ...f, dataDir, service, args, native, oldDev, dev, main, commit, journalFile, nativeGit: git, binding, send, catalog, task, streams };
}

test("manual sync authenticates exact independent review at the full consumer and retains it through SAME CAS recovery", async t => {
  const f = await reviewedSyncFixture(t);
  // The original full production selected consumer refuses the extra native
  // compatibility contribution. This is not a fabricated private-export error.
  await assert.rejects(f.service.synchronizeMainIntoDev(f.args), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING");
  assert.equal(await f.nativeGit(["rev-parse", "HEAD"]), f.commit);
  assert.equal(await f.git(["rev-parse", "dev"]), f.oldDev);
  const binding = await f.binding(), review = await f.send(binding, "real-review");
  const before = await readFile(f.journalFile), run = f.service.runCommand;
  let lost = false;
  f.service.runCommand = async (args, options) => {
    const value = await run(args, options);
    if (!lost && args[0] === "update-ref" && args[1] === "refs/heads/dev") {
      lost = true; throw Object.assign(Error("lost reviewed sync CAS reply"), { processTreeStopped: true });
    }
    return value;
  };
  await assert.rejects(f.service.synchronizeMainIntoDev({ ...f.args, nativeResolutionReview: review }), error => error.code === "PUBLISHED_DEV_SYNC_UNKNOWN");
  assert.equal(lost, true);
  const journal = JSON.parse(await readFile(f.journalFile));
  assert.deepEqual(journal.manualCompatibilityReview, { review, binding });
  assert.deepEqual(journal.identity, JSON.parse(before).identity);
  f.service.runCommand = run;
  // Omission cannot drop stored authority: the real read-only receipt verifier
  // and full content consumer run again before same-original readback.
  const result = await f.service.synchronizeMainIntoDev(f.args);
  assert.equal(result.integrated, true); assert.equal(result.headCommit, f.commit);
  assert.equal(await readFile(path.join(f.dev.projectRoot, "later.txt"), "utf8"), "later Task remains\n");
  assert.equal(await readFile(path.join(f.dev.projectRoot, "compatibility.mjs"), "utf8"), "export const retainedTaskOwner = true;\n");
  assert.equal(await f.git(["rev-parse", "main"]), f.main);
  assert.equal(await f.git(["status", "--porcelain"]), "");
  await assertNativeMergedResults({ git: f.nativeGit, baseCommit: journal.identity.devCommit,
    tasks: [{ taskId: `published:${journal.identity.operationId}`, mergeBases: journal.identity.mergeBases, resultCommit: f.main }],
    merges: journal.merges, head: f.commit, tree: binding.tree, identity: journal.identity,
    manualCompatibilityReview: journal.manualCompatibilityReview, root: path.dirname(f.native),
    verifyManualReview: (review, binding) => verifyManualDevResolutionReview({ dataDir: f.dataDir, review, binding }) });
});

test("manual sync refuses authored/forged/stale/foreign review and an additional delta before any dev promotion", async t => {
  const f = await reviewedSyncFixture(t), binding = await f.binding(), original = await readFile(f.journalFile);
  const authored = await f.send(binding, "authored", "author");
  await assert.rejects(f.service.synchronizeMainIntoDev({ ...f.args, nativeResolutionReview: authored }), /independent authority/);
  const review = await f.send(binding, "independent");
  await f.catalog.runMutation(() => f.catalog.updateStreamSettings(f.streams.reviewer.id, { model: "gpt-6-astra" }));
  await assert.rejects(f.service.synchronizeMainIntoDev({ ...f.args, nativeResolutionReview: review }), /independent authority/);
  await f.catalog.runMutation(() => f.catalog.updateStreamSettings(f.streams.reviewer.id, { model: "gpt-6.1-sol" }));
  await assert.rejects(f.service.synchronizeMainIntoDev({ ...f.args,
    nativeResolutionReview: { ...review, requestId: "not-admitted" } }), /independent authority/);
  let variant = 0;
  for (const patch of [{ tree: "a".repeat(40) }, { identityHash: "b".repeat(64) }, { nativeRoot: path.join(f.root, "foreign") },
    { originalJournalSha256: "c".repeat(64) }, { changes: [] }]) {
    const text = `<native-merge-review>${JSON.stringify({ kind: "native-merge-review-v1", verdict: "ACCEPT", binding: { ...binding, ...patch } })}</native-merge-review>`;
    await assert.rejects(f.service.synchronizeMainIntoDev({ ...f.args, nativeResolutionReview: { requestId: review.requestId, text } }));
    const signedForeign = await f.send({ ...binding, ...patch }, `signed-other-context-${variant++}`);
    await assert.rejects(f.service.synchronizeMainIntoDev({ ...f.args, nativeResolutionReview: signedForeign }));
    assert.deepEqual(await readFile(f.journalFile), original);
  }
  await writeFile(f.journalFile, Buffer.concat([original, Buffer.from("\n")]));
  await assert.rejects(f.service.synchronizeMainIntoDev({ ...f.args, nativeResolutionReview: review }), /original capture changed/);
  await writeFile(f.journalFile, original);
  await writeFile(path.join(f.native, "not-reviewed.txt"), "must not be accepted\n");
  await runTaskGitCommand(["add", "not-reviewed.txt"], { cwd: f.native });
  await runTaskGitCommand(["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit"], { cwd: f.native });
  await assert.rejects(f.service.synchronizeMainIntoDev({ ...f.args, nativeResolutionReview: review }), /binding changed/);
  assert.deepEqual(await readFile(f.journalFile), original);
  assert.equal(await runTaskGitCommand(["rev-parse", "dev"], { cwd: f.repo }), f.oldDev);
  assert.equal(await f.git(["rev-parse", "main"]), f.main);
});

test("manual sync rechecks genuine review authority before dev CAS and resumes the retained SAME proof", async t => {
  const f = await reviewedSyncFixture(t), review = await f.send(await f.binding(), "delivery-review");
  const run = f.service.runCommand;
  let changed = false;
  f.service.runCommand = async (args, options) => {
    const value = await run(args, options);
    if (!changed && args[0] === "fetch" && options.cwd === f.dev.projectRoot) {
      changed = true;
      await f.catalog.runMutation(() => f.catalog.updateStreamSettings(f.streams.operator.id, { releaseManager: false }));
    }
    return value;
  };
  await assert.rejects(f.service.synchronizeMainIntoDev({ ...f.args, nativeResolutionReview: review }), /independent authority/);
  assert.equal(changed, true);
  assert.equal(await f.git(["rev-parse", "dev"]), f.oldDev);
  assert.equal(await f.git(["rev-parse", "main"]), f.main);
  const journal = JSON.parse(await readFile(f.journalFile));
  assert.deepEqual(journal.manualCompatibilityReview.review, review);
  await f.catalog.runMutation(() => f.catalog.updateStreamSettings(f.streams.operator.id, { releaseManager: true }));
  f.service.runCommand = run;
  assert.equal((await f.service.synchronizeMainIntoDev(f.args)).headCommit, f.commit);
  assert.equal(await readFile(path.join(f.dev.projectRoot, "later.txt"), "utf8"), "later Task remains\n");
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

test("manual sync binds all criss-cross merge bases and retains its original conflict context", async t => {
  const f = await fixture(t);
  const service = new TaskGitWorkspaceService({ dataDir: path.join(f.root, "data"), runtimeRoot: f.runtimeRoot,
    recordTiming: () => {}, readManualDelivery: args => readManualTaskDelivery({ ...args, ...f.ports }) });
  const dev = await service.prepareDev(f.repo);
  await writeFile(path.join(dev.projectRoot, "left.txt"), "left Task work\n");
  const left = await f.commit(dev.projectRoot);
  await writeFile(path.join(f.repo, "right.txt"), "published work\n");
  const right = await f.commit();
  const merge = (cwd, revision) => runTaskGitCommand(["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "-m", "criss-cross fixture", revision], { cwd });
  await merge(dev.projectRoot, right);
  await merge(f.repo, left);
  await writeFile(path.join(dev.projectRoot, "AgentHub/app.mjs"), "export const version = 'later-dev';\n");
  const oldDev = await f.commit(dev.projectRoot);
  await writeFile(path.join(f.repo, "AgentHub/app.mjs"), "export const version = 'delivered-main';\n");
  const main = await f.commit();
  await f.git(["update-ref", "refs/remotes/origin/main", main]);
  const bases = (await f.git(["merge-base", "--all", oldDev, main])).split("\n").sort();
  assert.deepEqual(bases, [left, right].sort());
  const options = { projectRoot: f.repo, publishedRevision: main, manualSync: {
    operationId: "manual-criss-cross", workspaceId: "workspace", expectedDevCommit: oldDev, delivery: await f.install(main) } };
  const first = await service.synchronizeMainIntoDev(options);
  assert.equal(first.status, "review_required");
  const journal = path.join(path.dirname(first.nativeConflictRoot), "merge.json");
  const before = await readFile(journal);
  const state = JSON.parse(before);
  assert.deepEqual(state.identity.mergeBases, bases);
  assert.equal((await service.synchronizeMainIntoDev(options)).nativeConflictRoot, first.nativeConflictRoot);
  assert.deepEqual(await readFile(journal), before);
  assert.equal(await f.git(["rev-parse", "dev"]), oldDev);
  const task = { taskId: `published:${state.identity.operationId}`, mergeBases: bases, resultCommit: main };
  const reached = Error("validated binding reached original-state reader");
  const check = (identity, tasks) => mergeSelectedResults({ root: path.join(f.root, "guard-only"), sourceRoot: f.repo,
    baseCommit: oldDev, tasks, identity, gitAt: (cwd, args, opts = {}) => runTaskGitCommand(args, { ...opts, cwd }),
    readJson: () => { throw reached; }, writeJson: () => assert.fail("guard check cannot write state") });
  await assert.rejects(check({ ...state.identity, policy: "published-main-dev-sync-v1" }, [task]), error => error === reached);
  await assert.rejects(check({ ...state.identity, policy: "foreign-policy" }, [task]), error => error.code === "RELEASE_NATIVE_CHECKOUT_CHANGED");
  const wrong = [f.base, left].sort();
  await assert.rejects(check({ ...state.identity, mergeBases: wrong }, [{ ...task, mergeBases: wrong }]), error => error.code === "RELEASE_NATIVE_CHECKOUT_CHANGED");
  await writeFile(path.join(first.nativeConflictRoot, "AgentHub/app.mjs"), "export const version = 'delivered-main';\nexport const later = 'later-dev';\n");
  const resolved = await f.commit(first.nativeConflictRoot);
  assert.equal((await service.synchronizeMainIntoDev(options)).headCommit, resolved);
  assert.equal(await readFile(path.join(dev.projectRoot, "left.txt"), "utf8"), "left Task work\n");
  assert.equal(await readFile(path.join(dev.projectRoot, "right.txt"), "utf8"), "published work\n");
  await f.git(["merge-base", "--is-ancestor", oldDev, resolved]);
  await f.git(["merge-base", "--is-ancestor", main, resolved]);
});

test("manual Done and Complete verify delivered owned source without manufacturing a Test reference", async t => {
  const f = await publicFixture(t);
  await writeFile(path.join(f.managed.projectRoot, "AgentHub/app.mjs"), "export const version = 'own-delivered-change';\n");
  const own = await f.commit(f.managed.projectRoot);
  const before = f.board.task(f.task.id);
  await assert.rejects(f.lifecycle.updateWorkflowStatus({ taskId: f.task.id, operationId: "not-delivered",
    status: "done", manualDelivery: f.input, expectedRevision: before.revision, expectedWorkflowStatus: before.workflowStatus }));
  assert.equal(f.board.task(f.task.id).workflowStatus, before.workflowStatus);
  assert.deepEqual(f.board.task(f.task.id).gitReferences, []);
  await f.git(["merge", "--ff-only", own]);
  await f.git(["update-ref", "refs/remotes/origin/main", own]);
  const delivery = await f.install(own);
  await assert.rejects(f.call("hub_task_status_update", { request_id: "wrong-status", task_id: f.task.id,
    status: "testing", manual_delivery: delivery, expected_task_revision: before.revision, expected_workflow_status: before.workflowStatus }), /only.*Done|requires an RM/u);
  const ordinary = await f.catalog.runMutation(() => f.catalog.createStream({ workspaceId: before.workspaceId, name: "worker" }));
  await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "codex", threadId: "worker", streamId: ordinary.id }));
  await assert.rejects(f.hub.call("hub_task_status_update", { context_token: f.hub.contextToken({ provider: "codex", threadId: "worker" }),
    request_id: "foreign-caller", task_id: f.task.id, status: "done", manual_delivery: delivery,
    expected_task_revision: before.revision, expected_workflow_status: before.workflowStatus }), /requires an RM/u);
  const done = await f.call("hub_task_status_update", { request_id: "actual-delivery-done", task_id: f.task.id,
    status: "done", manual_delivery: delivery, expected_task_revision: before.revision, expected_workflow_status: before.workflowStatus });
  assert.equal(done.workflowStatus, "done"); assert.deepEqual(f.board.task(f.task.id).gitReferences, []);
  assert.equal(f.raw.lifecycleOutcome("actual-delivery-done").result.evidence.outcome, "verified_manual_delivery");
  const args = { task_id: f.task.id, completion_mode: "manual_delivery", manual_delivery: delivery };
  const p = await f.call("hub_task_complete", { ...args, request_id: "delivered-preview" });
  assert.equal(p.preview.manualDelivery[0].sourceKind, "owned-managed-source-without-test-ref");
  const closed = await f.call("hub_task_complete", { ...args, request_id: "delivered-close", confirm_cleanup: true, expected_cleanup_token: p.cleanupToken });
  assert.equal(closed.status, "done"); assert.deepEqual(f.board.task(f.task.id).gitReferences, []);
  assert.equal(await readFile(path.join(f.managed.projectRoot, "AgentHub/app.mjs"), "utf8"), "export const version = 'own-delivered-change';\n");
});

test("manual completion pins and preserves an unrepresented legacy repository and reconciles only its hash-bound read-only preview", async t => {
  const f = await publicFixture(t);
  const legacy = path.join(f.root, "legacy"); await mkdir(legacy);
  await runTaskGitCommand(["init", "-b", "main"], { cwd: legacy });
  await writeFile(path.join(legacy, ".gitignore"), "WIP/\n");
  await writeFile(path.join(legacy, "legacy.txt"), "historical base\n"); await f.commit(legacy);
  const historical = await f.taskGit.prepare({ taskId: f.task.id, projectRoot: legacy, dependencyMode: "skip" });
  await writeFile(path.join(historical.projectRoot, "legacy.txt"), "unique historical work\n");
  const legacyHead = await f.commit(historical.projectRoot);
  const evidence = path.join(historical.projectRoot, "WIP/evidence.txt"); await mkdir(path.dirname(evidence)); await writeFile(evidence, "preserve me");
  const task = f.board.task(f.task.id);
  f.raw.beginLifecycleTransition(task.id, { operationId: "done", targetWorkflowStatus: "done", expectedRevision: task.revision });
  f.raw.commitWorkflowTransition({ operationId: "done", gitReferences: [{ projectRoot: f.repo, branch: f.managed.branch, resultCommit: f.base }] });
  const original = { request_id: "old-preview", task_id: task.id, completion_mode: "manual_delivery", manual_delivery: f.input };
  await assert.rejects(f.call("hub_task_complete", original), /unrepresented/u);
  const receipt = f.catalog.mcpOperation(original.request_id); assert.equal(receipt.status, "unknown");
  const reconcile = { task_id: task.id, operation_request_id: original.request_id, expected_arguments_hash: receipt.argumentsHash,
    manual_preview_arguments: original, confirm_reconcile: true };
  await assert.rejects(f.call("hub_task_operation_reconcile", { ...reconcile, request_id: "not-preview", manual_preview_arguments: { ...original, confirm_cleanup: true } }), /read-only/u);
  assert.equal(f.catalog.mcpOperation(original.request_id).status, "unknown");
  await assert.rejects(f.call("hub_task_operation_reconcile", { ...reconcile, request_id: "wrong-hash", expected_arguments_hash: "0".repeat(64) }), /read-only/u);
  assert.equal((await f.call("hub_task_operation_reconcile", { ...reconcile, request_id: "address-preview" })).outcome, "NO_EFFECT");
  assert.equal(f.catalog.mcpOperation(original.request_id).status, "failed");
  const retained = [{ project_root: historical.projectRoot, head_commit: legacyHead }];
  await assert.rejects(f.taskGit.withTaskLock(task.id, lease => f.taskGit.manualDeliveryPreviewOwned({ task: f.board.task(task.id), input: f.input,
    lease, retainedRepositories: [{ ...retained[0], head_commit: f.base }] })), /exact preservation pins/u);
  const args = { task_id: task.id, completion_mode: "manual_delivery", manual_delivery: f.input, retained_repositories: retained };
  const p = await f.call("hub_task_complete", { ...args, request_id: "preserved-preview" });
  assert.equal(p.preview.retainedUnrepresented[0].headCommit, legacyHead);
  assert.equal(p.preview.manualDelivery.length, 1); assert.deepEqual(p.preview.deleting, []);
  const done = await f.call("hub_task_complete", { ...args, request_id: "preserved-close", confirm_cleanup: true, expected_cleanup_token: p.cleanupToken });
  assert.equal(done.status, "done");
  assert.equal(await readFile(evidence, "utf8"), "preserve me");
  assert.equal(await runTaskGitCommand(["rev-parse", historical.branch], { cwd: legacy }), legacyHead);
  assert.equal(await readFile(path.join(historical.projectRoot, "legacy.txt"), "utf8"), "unique historical work\n");
});

test("read-only preview reconciliation refuses a real confirmed UNKNOWN even with its exact original hash", async t => {
  const f = await publicFixture(t), task = f.board.task(f.task.id);
  f.raw.beginLifecycleTransition(task.id, { operationId: "done", targetWorkflowStatus: "done", expectedRevision: task.revision });
  f.raw.commitWorkflowTransition({ operationId: "done", gitReferences: [{ projectRoot: f.repo, branch: f.managed.branch, resultCommit: f.base }] });
  await writeFile(path.join(f.managed.projectRoot, "AgentHub/app.mjs"), "unsaved source\n");
  const original = { request_id: "confirmed-unknown", task_id: task.id, completion_mode: "manual_delivery",
    manual_delivery: f.input, confirm_cleanup: true, expected_cleanup_token: "not-valid" };
  await assert.rejects(f.call("hub_task_complete", original), /unfinished Task work/u);
  const receipt = f.catalog.mcpOperation(original.request_id); assert.equal(receipt.status, "unknown");
  await assert.rejects(f.call("hub_task_operation_reconcile", { request_id: "refuse-confirmed", task_id: task.id,
    operation_request_id: original.request_id, expected_arguments_hash: receipt.argumentsHash, manual_preview_arguments: original,
    confirm_reconcile: true }), /read-only/u);
  assert.equal(f.catalog.mcpOperation(original.request_id).status, "unknown");
  assert.equal(f.board.task(task.id).status, "open");
  assert.equal(await readFile(path.join(f.managed.projectRoot, "AgentHub/app.mjs"), "utf8"), "unsaved source\n");
});


async function standalonePublication(f, dataDir, { hostCRLF = false } = {}) {
  const remote = path.join(f.root, "origin.git");
  await f.git(["init", "--bare", "--initial-branch=main", remote]);
  await f.git(["remote", "add", "origin", remote]);
  await f.git(["push", "origin", "main"]);
  const managedRoot = path.join(dataDir, "release-repositories");
  const root = path.join(managedRoot, taskRepositoryKey(f.repo), "repository");
  await mkdir(path.dirname(root), { recursive: true });
  await f.git(["clone", "--no-local", "--no-hardlinks", remote, root]);
  const git = (args, options = {}) => runTaskGitCommand(args, { ...options, cwd: root });
  await git(["config", "core.autocrlf", "false"]);
  const markerFile = path.join(root, ".git/agent-hub-release-clone.json");
  const marker = { schemaVersion: 1, kind: "agent-hub-owned-release-clone", managedRoot,
    primaryRoot: f.repo, primaryGitCommonDir: path.join(f.repo, ".git"),
    releaseRoot: root, releaseGitCommonDir: path.join(root, ".git") };
  await writeFile(markerFile, JSON.stringify(marker));
  await writeFile(path.join(root, "AgentHub/app.mjs"), "export const version = 'published-standalone';\n");
  if (hostCRLF) {
    await mkdir(path.join(root, "AgentHub/RuntimeHost"), { recursive: true });
    await mkdir(path.join(root, "AgentHub/VSCodeExtension/media"), { recursive: true });
    await writeFile(path.join(root, ".gitattributes"), "*.cs text eol=crlf\n");
    for (const file of ["AgentHub.RuntimeHost.cs", "AgentHub.IconBuilder.cs", "app.manifest"]) {
      await writeFile(path.join(root, "AgentHub/RuntimeHost", file), "fixture Host source\nsecond line\n");
    }
    await writeFile(path.join(root, "AgentHub/VSCodeExtension/media/agent-hub-mark.png"), Buffer.from([137, 80, 78, 71, 0, 13, 10]));
  }
  const revision = await f.commit(root);
  await git(["push", "origin", "main"]);
  let delivery = await f.install(revision, git);
  if (hostCRLF) {
    for (const file of ["AgentHub.RuntimeHost.cs", "AgentHub.IconBuilder.cs"]) {
      await unlink(path.join(root, "AgentHub/RuntimeHost", file));
    }
    await git(["checkout-index", "--force", "-u", "--all"]);
    assert.equal(await git(["status", "--porcelain=v1"]), "");
    assert.ok((await readFile(path.join(root, "AgentHub/RuntimeHost/AgentHub.RuntimeHost.cs"))).includes(Buffer.from("\r\n")));
    const hash = Buffer.from(await runtimeHostSourceHash(path.join(root, "AgentHub")) + "\n");
    const installed = path.join(f.runtimeRoot, "releases/manual");
    await writeFile(path.join(installed, "AgentHub.RuntimeHost.source.sha256"), hash);
    const manifest = JSON.parse(await readFile(path.join(installed, "runtime-manifest.json"), "utf8"));
    manifest.files.push({ path: "AgentHub.RuntimeHost.source.sha256", bytes: hash.length, sha256: sha(hash) });
    const raw = JSON.stringify(manifest);
    await writeFile(path.join(installed, "runtime-manifest.json"), raw);
    delivery = { ...delivery, manifestSha256: sha(raw) };
  }
  return { root, git, remote, revision, delivery, markerFile, marker };
}

test("manual completion proves the owned published standalone without changing protected primary or retained Task source", async t => {
  const f = await publicFixture(t), published = await standalonePublication(f, f.taskGit.dataDir);
  const wip = path.join(f.managed.projectRoot, "WIP/evidence.txt");
  await mkdir(path.dirname(wip), { recursive: true }); await writeFile(wip, "keep original evidence");
  const primary = async () => ({ head: await f.git(["rev-parse", "HEAD"]),
    index: sha(await readFile(path.join(f.repo, ".git/index"))),
    status: await f.git(["status", "--porcelain=v1"]), main: await f.git(["rev-parse", "main"]),
    origin: await f.git(["rev-parse", "origin/main"]) });
  const before = await primary();
  await assert.rejects(f.read({ input: published.delivery }), /exact main\/origin/u);
  f.raw.beginLifecycleTransition(f.task.id, { operationId: "done-standalone", targetWorkflowStatus: "done", expectedRevision: f.task.revision });
  f.raw.commitWorkflowTransition({ operationId: "done-standalone", gitReferences: [{ projectRoot: f.repo,
    branch: f.managed.branch, resultCommit: f.base }] });
  const args = { taskId: f.task.id, completionMode: "manual_delivery", manualDelivery: published.delivery };
  const preview = await f.lifecycle.complete({ ...args, operationId: "standalone-preview" });
  assert.equal(preview.preview.manualDelivery[0].repositoryRoot, f.repo);
  assert.equal(preview.preview.manualDelivery[0].delivery.publishedRepository.root, published.root);
  assert.deepEqual(preview.preview.deleting, []);
  const result = await f.lifecycle.complete({ ...args, operationId: "standalone-close", confirmCleanup: true,
    expectedCleanupToken: preview.cleanupToken, originalArguments: { task_id: f.task.id, request_id: "standalone-close",
      completion_mode: "manual_delivery", manual_delivery: published.delivery,
      confirm_cleanup: true, expected_cleanup_token: preview.cleanupToken } });
  assert.equal(result.status, "done");
  assert.equal(await readFile(wip, "utf8"), "keep original evidence");
  assert.deepEqual(await primary(), before);
  assert.equal((await f.taskGit.describe(f.task.id))[0].headCommit, f.base);
});

test("manual standalone compiled Host proof retains exact permitted checkout line endings", async t => {
  const f = await publicFixture(t), published = await standalonePublication(f, f.taskGit.dataDir, { hostCRLF: true });
  const git = published.git;
  await assert.rejects(f.read({ input: published.delivery, git }), /compiled Host source differs/u);
  const read = () => f.taskGit.withTaskLock(f.task.id, lease => f.taskGit.manualDeliveryPreviewOwned({
    task: { ...f.task, gitReferences: [{ projectRoot: f.repo, resultCommit: f.base }] }, input: published.delivery, lease }));
  assert.equal((await read()).manualDelivery[0].delivery.revision, published.revision);
  const hashPath = path.join(f.runtimeRoot, "releases/manual/AgentHub.RuntimeHost.source.sha256");
  const original = await readFile(hashPath);
  await writeFile(hashPath, Buffer.from("0".repeat(64) + "\n"));
  await assert.rejects(read(), /compiled Host source differs/u);
  await writeFile(hashPath, original);
  await writeFile(path.join(published.root, "AgentHub/RuntimeHost/AgentHub.RuntimeHost.cs"), "different Host input\n");
  await assert.rejects(read(), /main\/origin\/current/u);
});

test("manual standalone authority refuses foreign markers/remotes, stale tracking and proof drift", async t => {
  const f = await publicFixture(t), published = await standalonePublication(f, f.taskGit.dataDir);
  const read = () => f.taskGit.withTaskLock(f.task.id, lease => f.taskGit.manualDeliveryPreviewOwned({
    task: { ...f.task, gitReferences: [{ projectRoot: f.repo, resultCommit: f.base }] }, input: published.delivery, lease }));
  for (const wrong of [{ primaryRoot: f.root }, { primaryGitCommonDir: f.root },
    { releaseRoot: f.repo }, { managedRoot: f.root }, { kind: "foreign" }]) {
    await writeFile(published.markerFile, JSON.stringify({ ...published.marker, ...wrong }));
    await assert.rejects(read(), /registered primary/u);
  }
  await writeFile(published.markerFile, JSON.stringify(published.marker));
  await published.git(["remote", "set-url", "origin", f.repo]);
  await assert.rejects(read(), /origin differs/u);
  await published.git(["remote", "set-url", "origin", published.remote]);
  await published.git(["update-ref", "refs/remotes/origin/main", f.base]);
  await assert.rejects(read(), /main\/origin/u);
  await published.git(["update-ref", "refs/remotes/origin/main", published.revision]);
  await f.git(["--git-dir", published.remote, "update-ref", "refs/heads/main", f.base]);
  await assert.rejects(read(), /current remote/u);
  await f.git(["--git-dir", published.remote, "update-ref", "refs/heads/main", published.revision]);
  const original = f.taskGit.readManualDelivery;
  f.taskGit.readManualDelivery = async args => {
    const proof = await original(args);
    await writeFile(published.markerFile, JSON.stringify({ ...published.marker, primaryRoot: f.root }));
    return proof;
  };
  await assert.rejects(read(), /registered primary/u);
  await writeFile(published.markerFile, JSON.stringify(published.marker));
  f.taskGit.readManualDelivery = original;
  await assert.rejects(f.taskGit.withTaskLock(f.task.id, lease => f.taskGit.manualDeliveryPreviewOwned({
    task: { ...f.task, gitReferences: [{ projectRoot: f.repo, resultCommit: f.base }] }, input: f.input, lease })), /main\/origin/u);
});

test("manual standalone sync merges disjoint object stores through existing isolated owner and preserves primary and later dev", async t => {
  const f = await fixture(t), dataDir = path.join(f.root, "data");
  const service = new TaskGitWorkspaceService({ dataDir, runtimeRoot: f.runtimeRoot, recordTiming: () => {},
    readPublication: async () => { throw Error("No fabricated publication history"); },
    readManualDelivery: args => readManualTaskDelivery({ ...args, ...f.ports }) });
  const dev = await service.prepareDev(f.repo);
  await writeFile(path.join(dev.projectRoot, "AgentHub/app.mjs"), "export const version = 'later-dev';\n");
  await writeFile(path.join(dev.projectRoot, "later.txt"), "retain Task work\n");
  const devCommit = await f.commit(dev.projectRoot);
  const published = await standalonePublication(f, dataDir);
  await assert.rejects(f.git(["cat-file", "-e", `${published.revision}^{commit}`]));
  await assert.rejects(published.git(["cat-file", "-e", `${devCommit}^{commit}`]));
  const indexBefore = sha(await readFile(path.join(f.repo, ".git/index")));
  const args = { projectRoot: f.repo, publishedRevision: published.revision, manualSync: {
    operationId: "standalone-main-to-dev", workspaceId: "workspace", expectedDevCommit: devCommit, delivery: published.delivery } };
  const conflict = await service.synchronizeMainIntoDev(args);
  assert.equal(conflict.status, "review_required"); assert.equal(await f.git(["rev-parse", "dev"]), devCommit);
  await writeFile(path.join(conflict.nativeConflictRoot, "AgentHub/app.mjs"),
    "export const version = 'published-standalone';\nexport const later = 'later-dev';\n");
  const resolved = await f.commit(conflict.nativeConflictRoot);
  const result = await service.synchronizeMainIntoDev(args);
  assert.equal(result.integrated, true); assert.equal(result.headCommit, resolved); assert.equal(result.repositoryRoot, f.repo);
  await runTaskGitCommand(["merge-base", "--is-ancestor", devCommit, resolved], { cwd: dev.projectRoot });
  await runTaskGitCommand(["merge-base", "--is-ancestor", published.revision, resolved], { cwd: dev.projectRoot });
  assert.equal(await readFile(path.join(dev.projectRoot, "later.txt"), "utf8"), "retain Task work\n");
  assert.equal(await f.git(["rev-parse", "HEAD"]), f.base);
  assert.equal(await f.git(["rev-parse", "main"]), f.base);
  assert.equal(await f.git(["rev-parse", "origin/main"]), f.base);
  assert.equal(sha(await readFile(path.join(f.repo, ".git/index"))), indexBefore);
  assert.equal((await service.synchronizeMainIntoDev(args)).headCommit, resolved);
});
