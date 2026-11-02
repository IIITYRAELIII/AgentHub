import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { OwnedNativeObjectStore } from "../../../src/infrastructure/filesystem/owned-native-object-store.mjs";
import { NativeCaptureRetirement, nativeCaptureCandidate } from "../../../src/infrastructure/filesystem/native-capture-retirement.mjs";
import { StorageRetentionService } from "../../../src/application/storage-retention-service.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { retireSealedNativeCapture, measureNativeCaptureAllocation } from "../../../src/infrastructure/filesystem/sealed-native-capture.mjs";
import { inventoryNativeCapture } from "../../../src/infrastructure/filesystem/native-capture-inventory.mjs";
import { withInterprocessLocks } from "../../../src/infrastructure/process/interprocess-lock.mjs";

const hash = b => createHash("sha256").update(b).digest("hex");
function git(cwd, args, { input = null, stdoutFd = null, rawOutput = false, binaryOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", stdoutFd ?? "pipe", "pipe"] }), out = [], err = [];
    c.stdout?.on("data", b => out.push(b)); c.stderr.on("data", b => err.push(b)); c.on("error", reject);
    c.on("close", code => code === 0 ? resolve(binaryOutput ? Buffer.concat(out) : rawOutput ? Buffer.concat(out).toString("utf8") : Buffer.concat(out).toString("utf8").trim()) : reject(Error("Git " + JSON.stringify(args) + " exit " + code + ": " + Buffer.concat(err).toString("utf8") + Buffer.concat(out).toString("utf8"))));
    c.stdin.end(input);
  });
}
async function fixture(t, { legacyOriginal = false, ...options } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-retire-native-")), dataDir = path.join(root, "data"), source = path.join(root, "primary");
  await mkdir(dataDir); await mkdir(source); await mkdir(path.join(root, "releases"));
  await writeFile(path.join(root, "current.json"), JSON.stringify({ current: "fixture-current", previous: null, runtimeRetention: { retired: [] } }));
  let board, catalog, service;
  t.after(async () => { await service?.close(); board?.close(); catalog?.close(); await rm(root, { recursive: true, force: true }); });
  const db = path.join(dataDir, "journal.sqlite");
  catalog = await new WorkspaceCatalogStore({ databaseFile: db }).load();
  const workspace = catalog.createWorkspace({ name: "Native retention fixture" });
  board = new TaskBoardStore({ databaseFile: db });
  let task = board.create({ text: "Preserve exact native result", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "T" });
  const originalId = "fixture-native-test-" + task.id;
  const legacyStream = legacyOriginal ? catalog.createStream({ workspaceId: workspace.id, name: "Historical native original" }) : null;
  catalog.beginMcpOperation({ requestId: originalId, workspaceId: workspace.id,
    ...(legacyOriginal ? { actorKind: "provider", streamId: legacyStream.id, provider: "codex", threadId: "fixture-native-thread" }
      : { actorKind: "authenticated-user" }),
    toolName: "hub_task_status_update", argumentsHash: "a".repeat(64),
    ...(!legacyOriginal ? { taskExecution: { protocol: "task-operation-interruption-v1", taskId: task.id, taskWorkspaceId: workspace.id,
      arguments: { task_id: task.id, status: "testing" } } } : {}) });
  await git(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, "history.bin"), randomBytes(1024 * 1024));
  await writeFile(path.join(source, "line-endings.txt"), "line one\nline two\n");
  await git(source, ["add", "."]); await git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const origin = path.join(root, "origin.git"); await git(root, ["init", "--bare", origin]); await git(source, ["remote", "add", "origin", origin]);
  await git(source, ["push", "origin", "main"]); await git(source, ["fetch", "origin"]);
  let publication = null;
  const taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const prepared = await taskGit.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: source });
  for (let i = 0; i < 75; i++) await writeFile(path.join(prepared.projectRoot, "value-" + i + ".txt"), "selected " + i);
  const snapshot = await taskGit.snapshot({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: prepared.projectRoot });
  const integrated = await taskGit.withTaskLock(task.id, lease => taskGit.mergeIntoDevOwned(snapshot, { lease, operationId: originalId }));
  board.beginLifecycleTransition(task.id, { operationId: originalId, kind: "workflow", targetWorkflowStatus: "testing", expectedRevision: task.revision });
  board.commitWorkflowTransition({ operationId: originalId, gitReferences: [{ projectRoot: source, branch: prepared.branch, resultCommit: snapshot.headCommit }] });
  catalog.completeMcpOperation(originalId, { taskId: task.id, integrated: true });
  await git(source, ["push", "origin", integrated.dev.headCommit + ":refs/heads/main"]);
  await git(source, ["fetch", "origin"]);
  publication = { generation: "verified-local-origin-publication", repositories: [{ root: source, revision: integrated.dev.headCommit }] };
  board.setWorkflowStatus(task.id, "done"); board.complete(task.id); task = board.task(task.id);
  const captures = await readdir(path.join(dataDir, "task-native-merges"));
  assert.equal(captures.length, 1);
  const captureId = captures[0], candidate = nativeCaptureCandidate(captureId), capture = path.join(dataDir, "task-native-merges", captureId);
  const state = JSON.parse(await readFile(path.join(capture, "merge.json"), "utf8"));
  const store = new MaintenanceOperationStore({ dataDir });
  const nativeOwner = taskGit.storageRetentionOwner({ taskBoard: board, isStopping: () => false });
  const owner = nativeOwner.captureRetirement;
  Object.assign(owner, options); // Only controlled native lost-reply injection in the owning test.
  const prune = nativeOwner.prune.bind(nativeOwner);
  nativeOwner.prune = async x => { try { return await prune(x); } catch (e) { t.diagnostic("Owning prune failure: " + e.stack); throw e; } };
  service = new StorageRetentionService({ store, owners: [nativeOwner], readContext: async () => ({ ready: true, releaseId: "fixture", isolated: false, busy: false }),
    withLease: fn => withInterprocessLocks([path.join(dataDir, "storage-retention")], fn) });
  return { root, dataDir, source, board, catalog, workspace, taskGit, store, owner, nativeOwner, service, candidate, capture, state, task, originalId };
}

test("real TaskGit/SQLite owner archives all objects and raw evidence then retires the whole private repository in SAME partial original", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, { legacyOriginal: true }), repository = path.join(f.capture, "repository"), journal = await readFile(path.join(f.capture, "merge.json"));
  const dangling = await git(repository, ["hash-object", "-w", "--stdin"], { input: "unique unreferenced proof bytes\n" });
  const rawTree = await git(repository, ["mktree"], { input: "100644 blob " + dangling + "\tevidence\n" });
  const orphan = await git(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", rawTree], { input: "orphan original\n" });
  const tag = await git(repository, ["mktag"], { input: "object " + orphan + "\ntype commit\ntag preserved-proof\ntagger Test <test@example.invalid> 1700000000 +0000\n\nunique tag\n" });
  const originalHead = await git(f.source, ["rev-parse", "HEAD"]), refs = await git(f.source, ["show-ref"]);
  const before = await measureNativeCaptureAllocation([repository, path.join(f.dataDir, "native-git-objects")]);
  const listed = await f.nativeOwner.list({ after: "", limit: 8 });
  assert.ok(listed.items.some(x => x.id === f.candidate.id), "existing automatic owner discovers the distinct repository resource");
  assert.ok(listed.items.some(x => x.id === f.candidate.captureId), "legacy bundle resource keeps its identity");
  const preview = await f.owner.preview({ candidate: f.candidate }); assert.equal(preview.status, "eligible", JSON.stringify(preview));
  let status, row, id;
  for (let n = 0; n < 20; n++) {
    status = await f.service.runApproved([{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }]);
    row = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
    id ??= row.operationId; assert.equal(row.operationId, id);
    if (row.status === "succeeded") break;
    assert.equal(row.phase, "partial", JSON.stringify(row));
  }
  assert.equal(row.status, "succeeded", JSON.stringify(status));
  assert.equal(row.metadata.result.status, "removed");
  await assert.rejects(lstat(repository), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(f.capture, "merge.json")), journal);
  const objects = new OwnedNativeObjectStore({ dataDir: f.dataDir, gitAt: git });
  const archived = await objects.readArchive(row.metadata.captureArchive);
  assert.equal(archived.manifest.binding.state.head, f.state.head);
  for (const original of archived.manifest.objects) await git(archived.repository, ["cat-file", "-e", original.oid]);
  const index = archived.manifest.files.find(file => file.path === ".git/index"); assert.ok(index);
  const keptIndex = await git(archived.repository, ["cat-file", "blob", index.blob], { binaryOutput: true });
  assert.equal(hash(keptIndex), index.identity.sha256);
  await git(archived.repository, ["gc", "--prune=now"]);
  for (const id of [dangling, rawTree, orphan, tag]) await git(archived.repository, ["cat-file", "-e", id]);
  await f.taskGit.withTaskLock(f.task.id, lease => f.taskGit.verifyNativeCaptureArchiveOwned({ state: f.state, record: preview.binding.record, archive: archived, lease }));
  assert.equal(await git(f.source, ["rev-parse", "HEAD"]), originalHead);
  assert.equal(await git(f.source, ["show-ref"]), refs);
  const after = await measureNativeCaptureAllocation([path.join(f.dataDir, "native-git-objects")]);
  assert.ok(after.uniqueAllocatedBytes < before.uniqueAllocatedBytes, JSON.stringify({ before, after }));
  t.diagnostic("Exact native roots+pool net allocated BEFORE/AFTER " + JSON.stringify({ before, after }));
});

test("lost native delete reply resumes SAME original from verified archive; late useful WIP refuses before another delete", { skip: process.platform !== "win32" }, async t => {
  let calls = 0;
  const f = await fixture(t, { retire: async (...args) => { ++calls; const r = await retireSealedNativeCapture(...args); if (calls === 1) throw Error("lost native reply"); return r; } });
  const preview = await f.owner.preview({ candidate: f.candidate }); assert.equal(preview.status, "eligible", JSON.stringify(preview));
  await f.service.runApproved([{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }]);
  const original = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
  assert.equal(original.outcome, "unknown"); assert.ok(original.metadata.captureArchive);
  const foreign = path.join(f.capture, "repository", "useful-wip.txt"); await writeFile(foreign, "preserve late user data");
  const before = await inventoryNativeCapture(path.join(f.capture, "repository"), { allowSharedObjects: true });
  const rejected = await f.owner.reconcile({ candidate: f.candidate, binding: preview.binding, operationId: original.operationId });
  assert.equal(rejected.status, "unknown"); assert.equal(calls, 2);
  assert.deepEqual(await inventoryNativeCapture(path.join(f.capture, "repository"), { allowSharedObjects: true }), before);
  assert.equal(await readFile(foreign, "utf8"), "preserve late user data");
  // Remove ONLY our disposable fixture's injected file, then finish original.
  await rm(foreign);
  for (let n = 0; n < 20; n++) {
    await f.service.runApproved([{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }]);
    const row = f.store.getReadonly(original.operationId);
    if (row.status === "succeeded") break;
    assert.equal(row.metadata.binding.inventorySha256, preview.binding.inventorySha256);
  }
  assert.equal(f.store.getReadonly(original.operationId).status, "succeeded");
});

test("unresolved original, current source pin and dirty private data remain retained", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), repository = path.join(f.capture, "repository");
  await writeFile(path.join(repository, "unique.txt"), "useful");
  assert.equal((await f.owner.preview({ candidate: f.candidate })).status, "retained");
  await rm(path.join(repository, "unique.txt"));
  const preview = await f.owner.preview({ candidate: f.candidate }); assert.equal(preview.status, "eligible", JSON.stringify(preview));
  await writeFile(path.join(repository, "value-0.txt"), "later changed tracked data");
  await f.service.runApproved([{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }]);
  assert.equal(f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id), null, "changed source refuses before original destructive admission");
  assert.equal(await readFile(path.join(repository, "value-0.txt"), "utf8"), "later changed tracked data");
  await writeFile(path.join(repository, "value-0.txt"), "selected 0");
  await git(repository, ["update-index", "--assume-unchanged", "value-0.txt"]);
  await writeFile(path.join(repository, "value-0.txt"), "hidden useful source");
  assert.equal((await f.owner.preview({ candidate: f.candidate })).status, "retained");
  assert.equal(await readFile(path.join(repository, "value-0.txt"), "utf8"), "hidden useful source");
  await writeFile(path.join(repository, "value-0.txt"), "selected 0");
  await git(repository, ["update-index", "--no-assume-unchanged", "value-0.txt"]);
  const inventory = await inventoryNativeCapture(repository, { allowSharedObjects: true }), bytes = Buffer.from(JSON.stringify(inventory));
  const plan = path.join(f.root, "negative-plan.json"); await writeFile(plan, bytes);
  const foreign = path.join(f.root, "foreign"); await mkdir(foreign); await writeFile(path.join(foreign, "keep.txt"), "foreign user data");
  const redirected = path.join(repository, "late-junction"); await symlink(foreign, redirected, "junction");
  await assert.rejects(retireSealedNativeCapture(repository, plan, hash(bytes)), /outcome-unknown/u);
  assert.equal(await readFile(path.join(foreign, "keep.txt"), "utf8"), "foreign user data");
  await rm(redirected, { recursive: true, force: true });
  assert.deepEqual(await inventoryNativeCapture(repository, { allowSharedObjects: true }), inventory);
  // A late change near the end of the allowlist must refuse before any earlier
  // file is deleted, rather than discovering its changed hash mid-batch.
  await writeFile(path.join(repository, "value-74.txt"), "different74");
  const lateInventory = await inventoryNativeCapture(repository, { allowSharedObjects: true });
  await assert.rejects(retireSealedNativeCapture(repository, plan, hash(bytes)), /content-time-changed/u);
  assert.deepEqual(await inventoryNativeCapture(repository, { allowSharedObjects: true }), lateInventory);
  await writeFile(path.join(repository, "value-74.txt"), "selected 74");
  const manifestRoot = path.join(f.root, "releases", "prepared-fixture"); await mkdir(manifestRoot);
  await writeFile(path.join(manifestRoot, "runtime-manifest.json"), JSON.stringify({ releaseId: "prepared-fixture", sourceRoot: repository, files: [] }));
  const pinned = await f.owner.preview({ candidate: f.candidate }); assert.equal(pinned.status, "retained"); assert.match(pinned.reason, /source/u);
  await rm(manifestRoot, { recursive: true });
  const workspaceId = f.workspace.id;
  f.catalog.beginMcpOperation({ requestId: "unresolved-fixture-original", workspaceId, actorKind: "authenticated-user",
    toolName: "hub_task_update", argumentsHash: "b".repeat(64), taskExecution: { protocol: "task-operation-interruption-v1", taskId: f.task.id, taskWorkspaceId: workspaceId, arguments: { task_id: f.task.id } } });
  const rejected = await f.owner.preview({ candidate: f.candidate }); assert.equal(rejected.status, "retained");
  assert.match(rejected.reason, /unresolved/u);
  assert.ok(await lstat(repository));
});
