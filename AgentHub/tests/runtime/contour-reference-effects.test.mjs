import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createContourOperationalPaths } from "../../src/domain/test-contour-operational-paths.mjs";
import { createContourReferenceProjection } from "../../src/runtime/test-contour-reference-projection.mjs";
import { prepareContourCatalog } from "../../src/runtime/test-contour-catalog-preparation.mjs";
import { createContourExternalEffects } from "../../src/infrastructure/filesystem/test-contour-external-effects.mjs";
import { reconcileContourAwareStartupGit, refreshContourAwareExchangeRate } from "../../src/application/contour-effect-operations.mjs";
import { DeferredInputStore, deferredInputTaskKey } from "../../src/application/deferred-input-store.mjs";
import { UsageSyncAutoService } from "../../src/application/usage-sync-auto-service.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { taskRepositoryKey } from "../../src/domain/task-git-reference.mjs";

const execFileAsync = promisify(execFile);

test("recording Git owners reject copied Task cleanup before CAS and preserve real source refs", async (t) => {
  const { root, policy } = await fixture(t);
  const source = path.join(root, "source-sentinel");
  await mkdir(source);
  const git = async (...args) => (await execFileAsync("git", args, { cwd: source, windowsHide: true })).stdout.trim();
  await git("init", "-b", "main");
  await git("-c", "user.name=Contour test", "-c", "user.email=contour@example.invalid", "commit", "--allow-empty", "-m", "sentinel");
  const commit = await git("rev-parse", "HEAD");
  const task = { id: "captured-task", revision: 7, workspaceId: "workspace", gitReferences: [{
    projectRoot: source, branch: "captured-task-branch", resultCommit: commit,
  }] };
  const baseRef = `refs/agent-hub/task-bases/${task.id}/${taskRepositoryKey(await realpath(source))}`;
  await git("branch", task.gitReferences[0].branch);
  await git("update-ref", baseRef, commit);
  const mutations = [];
  const board = { task: () => task, lifecycleTransition: () => null };
  for (const method of ["beginLifecycleTransition", "commitWorkflowTransition", "failLifecycleTransition", "rollbackWorkflowOutcome", "finalizeCleanupTransition"]) {
    board[method] = async () => { mutations.push(method); return { task }; };
  }
  const workspaceCatalog = { workspace: () => ({ settings: {} }), stream: () => null };
  const dataDir = path.join(root, "data");
  const ordinary = new TaskGitWorkspaceService({ dataDir, readPublication: async () => null });
  const ordinaryLifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog, taskGitWorkspaces: ordinary });
  const preview = await ordinaryLifecycle.delete({ taskId: task.id, operationId: "preview" });
  assert(preview.preview.deleting.some((item) => item.name === baseRef));
  const guarded = new TaskGitWorkspaceService({ dataDir, contourExternalEffects: policy, readPublication: async () => null });
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog, taskGitWorkspaces: guarded });
  const traceFile = path.join(root, "git-trace.jsonl");
  const priorTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = traceFile;
  try {
    await assert.rejects(lifecycle.delete({ taskId: task.id, operationId: "delete-copy", confirmCleanup: true,
      expectedCleanupToken: preview.cleanupToken }), { code: "CONTOUR_EXTERNAL_EFFECT_EXCLUDED" });
  } finally {
    if (priorTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = priorTrace;
  }
  assert.deepEqual(mutations, []);
  await assert.rejects(readFile(traceFile), { code: "ENOENT" }, "not even a Git read starts");
  assert.equal(await git("rev-parse", `refs/heads/${task.gitReferences[0].branch}`), commit);
  assert.equal(await git("rev-parse", baseRef), commit);
  assert.equal(task.revision, 7);
  // The default owner retains the normal explicit cleanup contract.
  const result = await ordinaryLifecycle.delete({ taskId: task.id, operationId: "ordinary-delete", confirmCleanup: true,
    expectedCleanupToken: preview.cleanupToken });
  assert.equal(result.deleted, true);
  await assert.rejects(git("show-ref", "--verify", baseRef));
  await assert.rejects(git("show-ref", "--verify", `refs/heads/${task.gitReferences[0].branch}`));
  assert.deepEqual(mutations, ["beginLifecycleTransition", "finalizeCleanupTransition"]);
});

test("recording Git owners deny every executable public operation before argument or lease processing", async (t) => {
  const { root, policy } = await fixture(t);
  for (const Owner of [TaskGitWorkspaceService, ReleaseGitWorkspaceService]) {
    assert.throws(() => new Owner({ dataDir: root, contourExternalEffects: { exclude() {} } }), /Unverified/);
    const owner = new Owner({ dataDir: root, contourExternalEffects: policy });
    for (const method of Object.getOwnPropertyNames(Owner.prototype)
      .filter((name) => !["constructor", "diagnostics", "withOperationTrace", "measureOperation"].includes(name))) {
      await assert.rejects(async () => owner[method](), { code: "CONTOUR_EXTERNAL_EFFECT_EXCLUDED" }, `${Owner.name}.${method}`);
    }
  }
  const release = new ReleaseGitWorkspaceService({ dataDir: root, contourExternalEffects: policy });
  let changed = false;
  await assert.rejects(release.withAwaitTransition("workspace", async () => { changed = true; }), { code: "CONTOUR_EXTERNAL_EFFECT_EXCLUDED" });
  assert.equal(changed, false);
});

test("recording claim custody and cleanup entries refuse before reading supplied arguments or lease ports", async (t) => {
  const { root, recording, policy } = await fixture(t);
  const methods = ["claimAdmissionNoEffectEvidence", "reuseClaimWorkspaceOwned",
    "planIndependentClaimNamespace", "stageIndependentClaimNamespaceOwned", "readIndependentClaimNamespaceOwned",
    "publishedDeliveryPreviewOwned", "confirmedDeleteResumePreviewOwned"];
  let argumentReads = 0;
  const forbidden = new Proxy({}, { get() {
    argumentReads += 1;
    throw new Error("Recording refusal must precede argument and lease access");
  } });
  const owner = new TaskGitWorkspaceService({ dataDir: root, contourExternalEffects: policy,
    runCommand: () => assert.fail("Recording custody must not run Git"),
    prepareDependencies: () => assert.fail("Recording custody must not prepare dependencies"),
    readClaimCustodyNamespace: () => assert.fail("Recording custody must not read live authority"),
  });
  for (const method of methods) {
    await assert.rejects(async () => owner[method](forbidden),
      { code: "CONTOUR_EXTERNAL_EFFECT_EXCLUDED", operation: method });
  }
  assert.equal(argumentReads, 0);
  const records = (await readFile(path.join(recording, "external-effects.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(records.map(row => row.operation), methods);
  assert.ok(records.every(row => row.kind === "task-git" && row.status === "excluded"));
});

test("ordinary claim custody keeps deterministic planning and the existing owned lease boundary", async (t) => {
  const { root } = await fixture(t);
  const owner = new TaskGitWorkspaceService({ dataDir: root });
  const input = { taskId: "ordinary-custody-task", requestId: "ordinary-plan",
    originalHash: "a".repeat(64), source: { repositoryRoot: path.join(root, "source") } };
  const first = owner.planIndependentClaimNamespace(input);
  assert.deepEqual(owner.planIndependentClaimNamespace(input), first);
  assert.equal(first.logicalRepositoryRoot, input.source.repositoryRoot);
  assert.equal(path.dirname(first.root), path.join(root, "task-custody", first.epoch.slice(0, 32)));
  assert.notEqual(owner.planIndependentClaimNamespace({ ...input, requestId: "different-plan" }).epoch, first.epoch);
  let leaseChecks = 0;
  const failure = new Error("ordinary lease witness");
  const lease = { assertOwned() { leaseChecks += 1; throw failure; }, beginProcessTreeGuard() {} };
  for (const method of ["reuseClaimWorkspaceOwned", "stageIndependentClaimNamespaceOwned", "readIndependentClaimNamespaceOwned",
    "publishedDeliveryPreviewOwned", "confirmedDeleteResumePreviewOwned"]) {
    await assert.rejects(owner[method]({ lease }), error => error === failure);
  }
  assert.equal(leaseChecks, 5);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "contour-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recording = path.join(root, "recording");
  await mkdir(recording);
  await writeFile(path.join(recording, "recording-provider.json"), JSON.stringify({ schemaVersion: 1, kind: "literal-recording-provider", root: recording, externalEffects: "deny" }));
  await writeFile(path.join(root, "contour-preparation.json"), JSON.stringify({ schemaVersion: 1, kind: "owned-contour-preparation", root, bootable: false }));
  const sources = [{ source: "C:\\Original\\Project", kind: "project" }, { source: "C:\\Original\\Attachments", kind: "attachment" }];
  const paths = createContourOperationalPaths({ root: recording, sources });
  return { root, recording, paths, policy: createContourExternalEffects({ root: recording }) };
}

function command(id = "message-1") {
  return { id: `queue-${id}`, clientUserMessageId: id, provider: "codex", streamId: "stream-real", threadId: "thread-real",
    projectRoot: "c:/Original/Project/Sub", fingerprint: "canonical-fingerprint", receipt: { clientUserMessageId: id, accepted: true },
    input: [{ type: "text", text: "[child:] C:\\Original\\Project — это буквальная цитата", annotations: [{ source: { threadId: "thread-real", contentHash: "sha256:original" }, text: "Ц".repeat(80000) }] },
      { type: "localImage", path: "C:\\Original\\Attachments\\image.png" }],
    temporaryFiles: ["C:\\Original\\Attachments\\image.png"], attempts: 2 };
}

test("queue projection preserves canonical identities, complete quotation, FIFO and receipt; bookkeeping round-trips", async (t) => {
  const { paths } = await fixture(t);
  const projection = createContourReferenceProjection(paths);
  const original = command();
  const unchanged = structuredClone(original);
  const first = projection.queueItem(original);
  const second = projection.queueItem(command("message-2"));
  const queue = new DeferredInputStore();
  queue.put(first.view, "queued"); queue.put(second.view, "queued");
  assert.equal(deferredInputTaskKey(first.view), deferredInputTaskKey(original));
  assert.equal(queue.hasBacklog(original), true);
  assert.deepEqual([...queue.queued.values()].map((item) => item.clientUserMessageId), ["message-1", "message-2"]);
  assert.deepEqual(first.view.input[0], original.input[0]);
  assert.equal(first.view.input[1].path, paths.map(original.input[1].path, "attachment"));
  first.view.attempts = 3;
  assert.deepEqual(projection.canonicalize(first.token), { ...original, attempts: 3 });
  assert.deepEqual(original, unchanged);
  const selected = projection.selection({ provider: original.provider, threadId: original.threadId, streamId: original.streamId, projectRoot: original.projectRoot });
  assert.equal(selected.view.projectRoot, first.view.projectRoot);
  assert.equal(projection.canonicalize(selected.token).projectRoot, original.projectRoot);
});

test("projection rejects legacy root-keyed occupancy, unknown roots, mutated identity and same-ID altered prompt", async (t) => {
  const { paths } = await fixture(t);
  const projection = createContourReferenceProjection(paths);
  assert.throws(() => projection.queueItem({ ...command(), streamId: "" }), /legacy occupancy/);
  assert.throws(() => projection.queueItem({ ...command(), projectRoot: "C:\\Elsewhere" }), /Unmapped/);
  const changed = projection.queueItem(command()); changed.view.clientUserMessageId = "different";
  assert.throws(() => projection.canonicalize(changed.token), /identity changed/);
  const edited = projection.queueItem(command()); edited.view.input[0].text = "different";
  assert.throws(() => projection.canonicalize(edited.token), /evidence changed/);
  const moved = projection.queueItem(command()); moved.view.projectRoot = "C:\\Original\\Project";
  assert.throws(() => projection.canonicalize(moved.token), /reference changed/);
  assert.throws(() => projection.canonicalize({}), /Unknown/);
});

function seedCatalog(file, { unknown = false } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE hub_workspaces(id TEXT PRIMARY KEY, settings_json TEXT);
    CREATE TABLE hub_streams(id TEXT PRIMARY KEY, workspace_id TEXT, settings_json TEXT);
    CREATE TABLE hub_threads(provider TEXT, provider_thread_id TEXT, stream_id TEXT, project_root TEXT);
    CREATE TABLE journal_records(record_json TEXT);
    CREATE TABLE message_commands(client_user_message_id TEXT, fingerprint TEXT, item_json TEXT);`);
  db.prepare("INSERT INTO hub_workspaces VALUES (?, ?)").run("workspace-real", JSON.stringify({ workingDirectory: "C:\\Original\\Project", releaseWorkflowEnabled: true, comment: "C:\\Original\\Project" }));
  db.prepare("INSERT INTO hub_streams VALUES (?, ?, ?)").run("stream-real", "workspace-real", JSON.stringify({ project: "c:/Original/Project/Sub", name: "C:\\Original\\Project" }));
  db.prepare("INSERT INTO hub_threads VALUES (?, ?, ?, ?)").run("codex", "thread-real", "stream-real", unknown ? "C:\\Unknown" : "C:\\Original\\Project\\Sub");
  db.prepare("INSERT INTO journal_records VALUES (?)").run(JSON.stringify({ projectRoot: "C:\\Original\\Project", ...command() }));
  db.prepare("INSERT INTO message_commands VALUES (?, ?, ?)").run("message-1", "exact-fingerprint", JSON.stringify(command()));
  db.close();
}

function rows(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row })); } finally { db.close(); }
}

test("catalog copy remaps only typed operational fields and preserves canonical journal/ledger bytes", async (t) => {
  const { root, paths } = await fixture(t);
  const file = path.join(root, "journal.sqlite"); seedCatalog(file);
  const journal = rows(file, "journal_records"); const ledger = rows(file, "message_commands");
  const report = prepareContourCatalog({ databaseFile: file, preparedRoot: root, paths });
  assert.equal(report.bootable, false);
  assert.deepEqual(report.counts, { workspaces: 1, streams: 1, threads: 1 });
  const workspace = rows(file, "hub_workspaces")[0];
  assert.equal(workspace.id, "workspace-real");
  const settings = JSON.parse(workspace.settings_json);
  assert.equal(settings.workingDirectory, paths.map("C:\\Original\\Project", "project"));
  assert.equal(settings.comment, "C:\\Original\\Project"); assert.equal(settings.releaseWorkflowEnabled, true);
  assert.deepEqual(rows(file, "journal_records"), journal); assert.deepEqual(rows(file, "message_commands"), ledger);
  assert.equal(rows(file, "hub_threads")[0].provider_thread_id, "thread-real");
});

test("unmapped late catalog reference rolls back earlier updates; unowned paths fail before SQLite writes", async (t) => {
  const { root, paths } = await fixture(t);
  const file = path.join(root, "journal.sqlite"); seedCatalog(file, { unknown: true });
  const before = rows(file, "hub_workspaces");
  assert.throws(() => prepareContourCatalog({ databaseFile: file, preparedRoot: root, paths }), /Unmapped/);
  assert.deepEqual(rows(file, "hub_workspaces"), before);
  assert.throws(() => prepareContourCatalog({ databaseFile: path.join(root, "..", "journal.sqlite"), preparedRoot: root, paths }), /escapes/);
  await writeFile(path.join(root, "contour-preparation.json"), JSON.stringify({ schemaVersion: 1, kind: "owned-contour-preparation", root, bootable: true }));
  assert.throws(() => prepareContourCatalog({ databaseFile: file, preparedRoot: root, paths }), /ownership marker/);
});

test("excluded Git and CBR owners never execute; audit records original Workspace target and explicit exclusion", async (t) => {
  const { policy, recording } = await fixture(t);
  const forbidden = () => { throw new Error("external owner called"); };
  const targets = [{ workspaceId: "workspace-real", projectRoot: "C:\\Original\\Project", registrationSource: "workspace_setting" }];
  const result = await reconcileContourAwareStartupGit({ policy, releaseGitWorkspaces: { reconcile: forbidden }, taskGitWorkspaces: { reconcile: forbidden }, projectRoots: targets, startupStep: (_, operation) => operation() });
  assert.equal(result.releaseReconciliation.status, "excluded"); assert.deepEqual(result.taskGitReconciliation.repositories, []);
  assert.equal((await refreshContourAwareExchangeRate({ policy, store: { refresh: forbidden } })).skipped, true);
  const records = (await readFile(path.join(recording, "external-effects.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records[0].targets, targets); assert.equal(records[2].kind, "exchange-rate");
  assert.throws(() => policy.exclude("core-deferred-recovery", "stop"), /Unclassified/);
});

test("ordinary Git startup remains ordered and CBR refresh calls real owner once", async () => {
  const calls = []; const roots = [{ projectRoot: "project" }];
  const service = (kind) => ({ reconcile: async (options) => { calls.push([kind, options]); return { repositories: [{ status: "ready" }] }; } });
  const result = await reconcileContourAwareStartupGit({ releaseGitWorkspaces: service("release"), taskGitWorkspaces: service("task"), projectRoots: roots, startupStep: (_, operation) => operation() });
  assert.deepEqual(calls, [["release", { projectRoots: roots }], ["task", { projectRoots: roots }]]);
  assert.equal(result.taskGitReconciliation.repositories[0].status, "ready");
  let refreshed = 0; await refreshContourAwareExchangeRate({ store: { refresh: async () => ++refreshed } }); assert.equal(refreshed, 1);
});

test("usage auto/manual/enrollment/suggestion boundaries block before credentials, provider account lookup or network", async (t) => {
  const { policy, recording } = await fixture(t);
  const forbidden = () => { throw new Error("external dependency touched"); };
  const service = new UsageSyncAutoService({ externalEffects: policy, timers: { schedule: forbidden }, remoteConfigStore: { load: forbidden }, identityStore: { deviceId: "isolated-device", label: "local" }, workLogUsageStore: { usageSyncSnapshot: forbidden }, clientFactory: forbidden, accountBackfill: forbidden, suggestedDeviceLabel: forbidden });
  service.scheduleInitial(); assert.equal((await service.sync()).skipped, true);
  assert.equal((await service.enroll({ serverUrl: "https://never.invalid", code: "secret-not-recorded" })).status, "excluded");
  assert.equal((await service.createEnrollmentCode()).status, "excluded");
  assert.equal((await service.deviceLabelStatus()).suggestedDeviceLabel, "local");
  const log = await readFile(path.join(recording, "external-effects.jsonl"), "utf8");
  assert.equal(log.includes("secret-not-recorded"), false); assert.equal(log.includes("never.invalid"), false);
});

test("normal usage service still schedules and evaluates remote configuration", async () => {
  let reads = 0; const schedules = [];
  const service = new UsageSyncAutoService({ timers: { schedule: (...args) => schedules.push(args) }, remoteConfigStore: { load: async () => { reads++; return {}; } }, identityStore: { deviceId: "ordinary" }, workLogUsageStore: { usageSyncSnapshot() {} }, clientFactory() {} });
  service.scheduleInitial(); assert.equal(schedules.length, 1);
  assert.deepEqual(await service.sync(), { skipped: true, reason: "not-configured" });
  assert.equal(reads, 1); assert.equal(schedules.length, 2);
});
