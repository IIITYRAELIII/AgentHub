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

test("archive tag-anchor loss and GC preserve the SAME unknown original and source at the final deletion boundary", { skip: process.platform !== "win32" }, async t => {
  let nativeCalls = 0;
  const f = await fixture(t, { retire: async (...args) => {
    nativeCalls++;
    if (nativeCalls === 1) throw Error("controlled stop before first native deletion");
    return retireSealedNativeCapture(...args);
  } });
  const repository = path.join(f.capture, "repository");
  const tag = await git(repository, ["mktag"], { input: "object " + f.state.head
    + "\ntype commit\ntag original-proof\ntagger Test <test@example.invalid> 1700000000 +0000\n\nretained annotated proof\n" });
  const preview = await f.owner.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const approved = [{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }];
  await f.service.runApproved(approved);
  const original = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
  assert.equal(original.outcome, "unknown"); assert.equal(nativeCalls, 1);
  const objects = new OwnedNativeObjectStore({ dataDir: f.dataDir, gitAt: git });
  const archive = original.metadata.captureArchive;
  const tagRef = archive.ref + "-tag/" + tag;
  await objects.readArchive(archive);
  await git(objects.repository, ["update-ref", "-d", tagRef, tag]);
  await git(objects.repository, ["cat-file", "-e", tag]);
  await assert.rejects(objects.readArchive(archive), /[Aa]rchive.*(?:root|anchor)/u);
  await git(objects.repository, ["update-ref", tagRef, tag, "0".repeat(40)]);
  await objects.readArchive(archive);
  const before = await inventoryNativeCapture(repository, { allowSharedObjects: true });
  const journalBefore = await readFile(path.join(f.capture, "merge.json"));
  const actualReadArchive = OwnedNativeObjectStore.prototype.readArchive;
  let drifted = false;
  OwnedNativeObjectStore.prototype.readArchive = async function (...args) {
    const value = await actualReadArchive.apply(this, args);
    if (!drifted && args[0].operationId === archive.operationId) {
      drifted = true;
      // Actual private drift AFTER a successful read. The final leased read
      // must notice it before admitting even the first native file deletion.
      await git(objects.repository, ["update-ref", "-d", tagRef, tag]);
      await git(objects.repository, ["gc", "--prune=now"]);
      await assert.rejects(git(objects.repository, ["cat-file", "-e", tag]));
    }
    return value;
  };
  try { await f.service.runApproved(approved); }
  finally { OwnedNativeObjectStore.prototype.readArchive = actualReadArchive; }
  assert.equal(drifted, true);
  assert.equal(nativeCalls, 1, "No native deletion after an archive root was lost");
  assert.equal(f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id).operationId, original.operationId);
  assert.equal(f.store.getReadonly(original.operationId).outcome, "unknown");
  const after = await inventoryNativeCapture(repository, { allowSharedObjects: true });
  // Pool GC legitimately removes its links to old pack encodings. Every
  // original physical file/byte still has to survive in the private consumer.
  const content = value => ({ ...value, files: value.files.map(file => file.objectFile ? { ...file, sharedObject: false } : file) });
  assert.deepEqual(content(after), content(before));
  assert.deepEqual(await readFile(path.join(f.capture, "merge.json")), journalBefore);
  await git(repository, ["cat-file", "-e", tag]);
  await assert.rejects(objects.readArchive(archive), /[Aa]rchive.*(?:root|anchor)/u);
});

test("slow native preview persists unadmitted intake then performs fresh real owner retirement on SAME original", { skip: process.platform !== "win32" }, async t => {
  let nativeCalls = 0, clock = 0, previews = 0;
  const f = await fixture(t, { retire: async (...args) => { nativeCalls++; return retireSealedNativeCapture(...args); } });
  const journal = await readFile(path.join(f.capture, "merge.json"));
  const preview = await f.owner.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const ownerPreview = f.nativeOwner.preview.bind(f.nativeOwner);
  f.nativeOwner.preview = async input => { previews++; const p = await ownerPreview(input); clock += 20_001; return p; };
  const make = store => new StorageRetentionService({ store, owners: [f.nativeOwner], clock: () => clock,
    readContext: async () => ({ ready: true, releaseId: "fixture", isolated: false, busy: false }),
    withLease: fn => withInterprocessLocks([path.join(f.dataDir, "storage-retention")], fn) });
  const input = [{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }];
  const first = make(f.store); await first.runApproved(input); await first.close();
  const original = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
  assert.equal(original.metadata.admitted, false); assert.equal(original.metadata.previewCompleted, true);
  assert.equal(nativeCalls, 0);
  const restarted = new MaintenanceOperationStore({ dataDir: f.dataDir });
  const second = make(restarted);
  try { await second.runApproved(input); } finally { await second.close(); }
  const row = restarted.get(original.operationId);
  assert.equal(previews, 1); assert.equal(nativeCalls, 1);
  assert.equal(row.metadata.admitted, true);
  assert.ok(["partial", "removed"].includes(row.phase), JSON.stringify(row));
  assert.deepEqual(row.metadata.binding, original.metadata.binding);
  assert.ok(row.metadata.captureArchive);
  const objects = new OwnedNativeObjectStore({ dataDir: f.dataDir, gitAt: git });
  const archived = await objects.readArchive(row.metadata.captureArchive);
  assert.equal(archived.manifest.binding.state.head, f.state.head);
  assert.deepEqual(await readFile(path.join(f.capture, "merge.json")), journal);
});

test("ordinary native archive entries still require their exact owning lease", async () => {
  const owner = new TaskGitWorkspaceService({ dataDir: os.tmpdir(), runCommand: () => assert.fail("No Git before lease") });
  for (const method of ["nativeCaptureRetirementRecordOwned", "verifyNativeCaptureArchiveOwned"]) {
    await assert.rejects(owner[method]({}), /owned process-tree guard lease/u);
    let calls = 0;
    const lease = { beginProcessTreeGuard() { assert.fail("No process before lease ownership"); },
      async assertOwned() { calls++; throw Error("exact original lease rejected"); } };
    await assert.rejects(owner[method]({ lease }), /exact original lease rejected/u);
    assert.equal(calls, 1);
  }
});

test("terminal prepared-only originals preserve their records while one exact completed capture retires", { skip: process.platform !== "win32" }, async t => {
  let nativeCalls = 0;
  const f = await fixture(t, { retire: async (...args) => { nativeCalls++; return retireSealedNativeCapture(...args); } });
  const identity = await f.taskGit.withTaskLock(f.task.id, lease => f.taskGit.nativeCaptureRetirementRecordOwned({ taskId: f.task.id, root: f.capture, state: f.state, lease }));
  const record = JSON.parse(await readFile(identity.path, "utf8")), previousId = "fixture-earlier-prepared-" + f.task.id;
  const previous = { ...record, operationId: previousId, phase: "prepared" };
  delete previous.target; delete previous.targetTree; delete previous.stageRoot;
  const previousFile = path.join(path.dirname(identity.path), hash(previousId) + ".json");
  const previousBytes = Buffer.from(JSON.stringify(previous) + "\n"); await writeFile(previousFile, previousBytes);
  f.catalog.beginMcpOperation({ requestId: previousId, workspaceId: f.workspace.id, actorKind: "authenticated-user",
    toolName: "hub_task_status_update", argumentsHash: "b".repeat(64),
    taskExecution: { protocol: "task-operation-interruption-v1", taskId: f.task.id, taskWorkspaceId: f.workspace.id,
      arguments: { task_id: f.task.id, status: "testing" } } });
  assert.equal((await f.owner.preview({ candidate: f.candidate })).status, "retained", "pending original still blocks");
  f.catalog.failMcpOperation(previousId, Error("retained original failure"));
  const preview = await f.owner.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  assert.equal(preview.binding.record.operationId, f.originalId);
  assert.deepEqual(preview.binding.record.priorPreparedRecords, [{ operationId: previousId, path: previousFile, sha256: hash(previousBytes) }]);
  // A foreign original is not certified merely because a later positive exists.
  const foreignId = "missing-canonical-prepared", foreignFile = path.join(path.dirname(identity.path), hash(foreignId) + ".json");
  await writeFile(foreignFile, JSON.stringify({ ...previous, operationId: foreignId }));
  assert.equal((await f.owner.preview({ candidate: f.candidate })).status, "retained");
  await rm(foreignFile);
  // Two positive originals are still ambiguous, even if their head matches.
  await writeFile(previousFile, JSON.stringify({ ...record, operationId: previousId }));
  assert.equal((await f.owner.preview({ candidate: f.candidate })).status, "retained");
  await writeFile(previousFile, Buffer.concat([previousBytes, Buffer.from("\n")]));
  const refused = await f.service.runApproved([{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }]);
  assert.equal(nativeCalls, 0); assert.equal(refused.reasons["approved-preview-changed"], 1);
  await writeFile(previousFile, previousBytes);
  await f.service.runApproved([{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }]);
  const child = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
  assert.ok(["partial", "removed"].includes(child.phase), JSON.stringify(child));
  assert.equal(nativeCalls, 1);
  assert.deepEqual(await readFile(previousFile), previousBytes);
  assert.equal(f.catalog.mcpOperation(previousId).status, "failed");
  assert.equal(f.catalog.mcpOperation(previousId).error, "retained original failure");
});
