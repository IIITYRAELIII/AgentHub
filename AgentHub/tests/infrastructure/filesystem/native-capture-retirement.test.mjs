import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Transform } from "node:stream";
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

import { ReleaseOperationStore } from "../../../src/infrastructure/persistence/release-operation-store.mjs";
import { ReleaseOperationService } from "../../../src/application/release-operation-service.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";

import { assertNativeCaptureNotSourcePinned } from "../../../src/infrastructure/filesystem/native-capture-source-pins.mjs";

import { assertNativeMergedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import historicalReplayLines from "../../fixtures/native-historical-replay-lines.json" with { type: "json" };
import { withStorageRetentionLease } from "../../../src/composition/storage-retention-composition.mjs";
import { createTaskOperationTimingLogRecorder } from "../../../src/infrastructure/persistence/task-operation-timing-log.mjs";

const hash = b => createHash("sha256").update(b).digest("hex");
function git(cwd, args, { input = null, stdoutFd = null, rawOutput = false, binaryOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", stdoutFd ?? "pipe", "pipe"] }), out = [], err = [];
    c.stdout?.on("data", b => out.push(b)); c.stderr.on("data", b => err.push(b)); c.on("error", reject);
    c.on("close", code => code === 0 ? resolve(binaryOutput ? Buffer.concat(out) : rawOutput ? Buffer.concat(out).toString("utf8") : Buffer.concat(out).toString("utf8").trim()) : reject(Error("Git " + JSON.stringify(args) + " exit " + code + ": " + Buffer.concat(err).toString("utf8") + Buffer.concat(out).toString("utf8"))));
    c.stdin.end(input);
  });
}
async function fixture(t, { legacyOriginal = false, historicalReplay = null, selectedFiles = 75, ...options } = {}) {
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
  if (historicalReplay) await writeFile(path.join(source, "replay.txt"), historicalReplay.base);
  await git(source, ["add", "."]); await git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const historicalAgreedBase = historicalReplay ? await git(source, ["rev-parse", "HEAD"]) : null;
  if (historicalReplay) {
    await writeFile(path.join(source, "replay.txt"), historicalReplay.source); await git(source, ["add", "."]);
    await git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "shared historical prefix"]);
  }
  const origin = path.join(root, "origin.git"); await git(root, ["init", "--bare", origin]); await git(source, ["remote", "add", "origin", origin]);
  await git(source, ["push", "origin", "main"]); await git(source, ["fetch", "origin"]);
  let publication = null;
  const taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const prepared = await taskGit.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: source });
  for (let i = 0; i < selectedFiles; i++) await writeFile(path.join(prepared.projectRoot, "value-" + i + ".txt"), "selected " + i);
  const snapshot = await taskGit.snapshot({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: prepared.projectRoot });
  if (historicalReplay) {
    await writeFile(path.join(source, "replay.txt"), historicalReplay.prefix); await git(source, ["add", "."]);
    await git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "independent prefix correction"]);
  }
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
  return { root, dataDir, source, board, catalog, workspace, taskGit, store, owner, nativeOwner, service, candidate, capture, state, task, originalId, historicalAgreedBase };
}

async function admitBeforeArchiveFailure(f) {
  const preview = await f.owner.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const installationLease = f.owner.installationLease, prune = f.nativeOwner.prune.bind(f.nativeOwner);
  let refuse = false;
  f.owner.installationLease = (...args) => {
    if (refuse) { refuse = false; throw Error("controlled installation admission failure before archive"); }
    return installationLease(...args);
  };
  f.nativeOwner.prune = async input => {
    refuse = true;
    f.nativeOwner.prune = prune;
    return prune(input);
  };
  const approved = [{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }];
  await f.service.runApproved(approved);
  const original = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
  assert.equal(original.metadata.admitted, true);
  assert.equal(original.outcome, "unknown");
  assert.equal(original.metadata.captureArchiveIntent, undefined);
  assert.equal(original.metadata.captureArchive, undefined);
  return { approved, original };
}

test("native foreground lease series uses one producer and one leased archive proof per continuation", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, { selectedFiles: 140 }), producers = [], archiveReads = [], passes = [];
  const originalSpawn = childProcess.spawn, originalRead = OwnedNativeObjectStore.prototype.readArchive;
  const logFile = path.join(f.root, "native-timing.log");
  f.taskGit.recordTiming = createTaskOperationTimingLogRecorder({ logFile, maxBytes: 4 * 1024 * 1024, maxFiles: 2 });
  const observed = t.mock.method(childProcess, "spawn", (...args) => {
    const child = originalSpawn(...args);
    const input = args[2]?.env?.AGENT_HUB_CAPTURE_INPUT;
    if (input && JSON.parse(input).root === path.join(f.capture, "repository")) {
      const record = { closed: false }; producers.push(record); child.once("close", () => { record.closed = true; });
    }
    return child;
  });
  const observedRead = t.mock.method(OwnedNativeObjectStore.prototype, "readArchive", async function (...args) {
    const held = await lstat(path.join(this.dataDir, "native-git-objects.lock")).then(() => true, () => false);
    archiveReads.push({ held });
    return originalRead.apply(this, args);
  });
  syncBuiltinESMExports();
  let originalId, archiveId;
  const began = performance.now();
  try {
    const preview = await f.owner.preview({ candidate: f.candidate });
    assert.equal(preview.status, "eligible", JSON.stringify(preview));
    const approved = [{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }];
    await f.service.close();
    await withStorageRetentionLease(f.dataDir, async lease => {
      const service = new StorageRetentionService({ store: f.store, owners: [f.nativeOwner],
        readContext: () => ({ ready: true, releaseId: "fixture", isolated: false, busy: false }), withLease: fn => fn(lease) });
      try {
        for (let pass = 0; pass < 16; pass++) {
          await lease.assertOwned(); const beforeReads = archiveReads.length;
          await service.runApproved(approved);
          const row = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
          originalId ??= row.operationId; archiveId ??= row.metadata.captureArchive?.operationId;
          assert.equal(row.operationId, originalId); assert.equal(row.metadata.captureArchive?.operationId, archiveId);
          const result = row.status === "succeeded" ? row.metadata.result : row.metadata.lastObservation;
          assert.ok(["partial", "removed"].includes(result?.status), JSON.stringify(row));
          assert.equal(row.metadata.captureBatchSequence, pass + 1);
          assert.equal(row.metadata.captureTiming.batchSequence, pass + 1);
          assert.equal(row.metadata.captureTiming.candidateHash, hash(JSON.stringify(f.candidate)));
          assert.equal(row.metadata.captureTiming.phases["native-retire:archive-read"].count, archiveReads.length - beforeReads);
          assert.ok(row.metadata.captureTiming.phases["native-retire:current"].count >= 2);
          assert.ok(row.metadata.captureTiming.phases["native-retire:source-pins"].count >= 3);
          assert.equal(result.nativeTelemetry.producerSequence, pass + 1);
          assert.equal(result.nativeTelemetry.native.unlinkedFiles, result.files);
          assert.equal(result.nativeTelemetry.producerStarts, pass === 0 ? 1 : 0);
          for (const field of ["planMs", "prevalidateMs", "hashUnlinkMs", "directoryCleanupMs", "nativeMs"]) assert.ok(result.nativeTelemetry.native[field] >= 0);
          passes.push({ status: result.status, reads: archiveReads.slice(beforeReads), files: result.files });
          if (row.status === "succeeded") break;
        }
        assert.equal(f.store.getReadonly(originalId).status, "succeeded");
      } finally { await service.close(); }
    });
    t.diagnostic(JSON.stringify({ originalId, passes: passes.map(x => ({ status: x.status, files: x.files, archiveReads: x.reads.length })),
      producerStarts: producers.length, elapsedMs: performance.now() - began }));
    assert.ok(passes.filter(x => x.status === "partial").length >= 2, "Exercise real continuation batches");
    assert.equal(producers.length, 1, "Actual finite owning series reuses one verified native producer");
    assert.ok(producers.every(x => x.closed), "Every producer joins before the held lease exits");
    for (const pass of passes.slice(1)) {
      assert.equal(pass.reads.length, 1, "One full archive verification for each continuation");
      assert.ok(pass.reads[0].held, "Full archive proof stays inside the real object-store lease");
    }
    await assert.rejects(lstat(path.join(f.capture, "repository")), { code: "ENOENT" });
    assert.equal(f.store.getReadonly(archiveId).status, "succeeded");
    const reopened = new MaintenanceOperationStore({ dataDir: f.dataDir });
    assert.equal(reopened.getReadonly(originalId).metadata.captureArchive.operationId, archiveId);
    assert.equal(reopened.getReadonly(originalId).metadata.captureTiming.batchSequence, passes.length);
    const events = (await readFile(logFile, "utf8")).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line.slice(line.indexOf("{"))));
    const nativeEvents = events.filter(event => event.stage.startsWith("native-retire:"));
    assert.ok(nativeEvents.some(event => event.stage === "native-retire:producer-close" && event.joined && event.exitCode === 0));
    assert.ok(nativeEvents.every(event => event.operationId === originalId && event.candidateHash === hash(JSON.stringify(f.candidate))));
    assert.ok(!JSON.stringify(nativeEvents).includes(f.root), "New phase records contain no filesystem paths");
    t.diagnostic(JSON.stringify({ finalBatchTiming: reopened.getReadonly(originalId).metadata.captureTiming,
      nativePhaseEvents: nativeEvents.filter(event => event.stage === "native-retire:native-phases" && event.owningBatch)
        .map(({ producerSequence, producerStarts, compileMs, producerStartupMs, roundTripMs, native }) => ({ producerSequence, producerStarts, compileMs, producerStartupMs, roundTripMs, native })) }));
  } finally { observedRead.mock.restore(); observed.mock.restore(); syncBuiltinESMExports(); }
});

test("held native owner keeps source/current refusals and foreign-file failure on SAME original with durable timings", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, { selectedFiles: 140 }), repository = path.join(f.capture, "repository");
  const stateFile = path.join(f.capture, "merge.json"), stateBytes = await readFile(stateFile), logFile = path.join(f.root, "failure-timing.log");
  f.taskGit.recordTiming = createTaskOperationTimingLogRecorder({ logFile, maxBytes: 4 * 1024 * 1024, maxFiles: 2 });
  const preview = await f.owner.preview({ candidate: f.candidate }); assert.equal(preview.status, "eligible");
  const approved = [{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }];
  await f.service.close(); let originalId;
  await assert.rejects(withStorageRetentionLease(f.dataDir, async lease => {
    const service = new StorageRetentionService({ store: f.store, owners: [f.nativeOwner], withLease: fn => fn(lease),
      readContext: () => ({ ready: true, releaseId: "fixture", isolated: false, busy: false }) });
    try {
      await service.runApproved(approved);
      const first = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
      originalId = first.operationId; assert.equal(first.metadata.lastObservation.status, "partial");
      const late = path.join(f.root, "releases", "late-source"); await mkdir(late);
      await writeFile(path.join(late, "runtime-manifest.json"), JSON.stringify({ releaseId: "late-source", sourceRoot: repository, files: [] }));
      await service.runApproved(approved);
      const pinned = f.store.getReadonly(originalId);
      assert.equal(pinned.outcome, "unknown"); assert.match(pinned.metadata.lastObservation.reason, /source/iu);
      assert.equal(pinned.metadata.captureTiming.phases["native-retire:source-pins"].errorCount, 1);
      await rm(late, { recursive: true }); // Only the injected private fixture pin.
      await writeFile(stateFile, JSON.stringify({ ...JSON.parse(stateBytes), diagnosticForeignState: true }));
      await service.runApproved(approved);
      const changed = f.store.getReadonly(originalId);
      assert.equal(changed.outcome, "unknown"); assert.match(changed.metadata.lastObservation.reason, /changed|context/iu);
      await writeFile(stateFile, stateBytes); // Restore only the private injected journal drift.
      await writeFile(path.join(repository, "foreign-useful.txt"), "retain this foreign work");
      await service.runApproved(approved);
      const failed = f.store.getReadonly(originalId);
      assert.equal(failed.outcome, "unknown"); assert.match(failed.metadata.lastObservation.reason, /capture-unexpected-file/u);
      assert.equal(failed.metadata.captureArchive.operationId, first.metadata.captureArchive.operationId);
      assert.equal(failed.metadata.captureTiming.phases["native-retire:native-call"].errorCount, 1);
      assert.equal(await readFile(path.join(repository, "foreign-useful.txt"), "utf8"), "retain this foreign work");
    } finally { await service.close(); }
  }), /capture-unexpected-file/u);
  await withStorageRetentionLease(f.dataDir, lease => lease.assertOwned());
  const reopened = new MaintenanceOperationStore({ dataDir: f.dataDir }), retained = reopened.getReadonly(originalId);
  assert.equal(retained.outcome, "unknown"); assert.equal(retained.metadata.captureTiming.batchSequence, 4);
  const events = (await readFile(logFile, "utf8")).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line.slice(line.indexOf("{"))));
  assert.ok(events.some(x => x.stage === "native-retire:producer-close" && x.joined && x.outcome === "error" && x.operationId === originalId));
  assert.ok(events.some(x => x.stage === "native-retire:native-phases" && x.outcome === "error" && x.native.unlinkedFiles === 0));
  assert.ok((await lstat(repository)).isDirectory());
});

test("native owner preserves lost framed reply UNKNOWN after real partial effect and joins its child", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, { selectedFiles: 140 }), repository = path.join(f.capture, "repository"), logFile = path.join(f.root, "lost-reply-timing.log");
  f.taskGit.recordTiming = createTaskOperationTimingLogRecorder({ logFile, maxBytes: 4 * 1024 * 1024, maxFiles: 2 });
  const preview = await f.owner.preview({ candidate: f.candidate }); assert.equal(preview.status, "eligible");
  const before = await inventoryNativeCapture(repository, { allowSharedObjects: Boolean(f.state.objectStorage) }), starts = [], spawn = childProcess.spawn;
  const observed = t.mock.method(childProcess, "spawn", (...args) => {
    const child = spawn(...args), input = args[2]?.env?.AGENT_HUB_CAPTURE_INPUT;
    if (input && JSON.parse(input).root === repository) {
      const entry = { closed: false }; starts.push(entry); child.once("close", () => { entry.closed = true; });
      let buffered = "";
      const framed = new Transform({ transform(chunk, _encoding, done) {
        buffered += chunk.toString("utf8");
        for (let at; (at = buffered.indexOf("\n")) >= 0;) {
          const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
          const value = JSON.parse(line); if (value.kind === "result") value.sequence++;
          this.push(JSON.stringify(value) + "\n");
        }
        done();
      }, flush(done) { if (buffered) this.push(buffered); done(); } });
      child.stdout.pipe(framed); child.stdout = framed;
    }
    return child;
  }); syncBuiltinESMExports(); let originalId;
  try {
    await f.service.close();
    await assert.rejects(withStorageRetentionLease(f.dataDir, async lease => {
      const service = new StorageRetentionService({ store: f.store, owners: [f.nativeOwner], withLease: fn => fn(lease),
        readContext: () => ({ ready: true, releaseId: "fixture", isolated: false, busy: false }) });
      try {
        await service.runApproved([{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }]);
        const row = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id); originalId = row.operationId;
        assert.equal(row.outcome, "unknown"); assert.match(row.metadata.lastObservation.reason, /invalid-result/u);
        assert.equal(row.metadata.captureTiming.outcome, "error"); assert.ok(row.metadata.captureArchive);
      } finally { await service.close(); }
    }), /invalid-result/u);
    assert.equal(starts.length, 1); assert.equal(starts[0].closed, true);
    const missing = await Promise.all(before.files.map(file => lstat(path.join(repository, file.path)).then(() => false, error => { if (error.code === "ENOENT") return true; throw error; })));
    assert.equal(missing.filter(Boolean).length, 64, "Independent filesystem observation does not settle the unknown reply");
    const reopened = new MaintenanceOperationStore({ dataDir: f.dataDir });
    assert.equal(reopened.getReadonly(originalId).outcome, "unknown");
    assert.equal(reopened.getReadonly(originalId).metadata.captureTiming.phases["native-retire:native-call"].errorCount, 1);
    await withStorageRetentionLease(f.dataDir, lease => lease.assertOwned());
  } finally { observed.mock.restore(); syncBuiltinESMExports(); }
});

test("admitted native intake recovers SAME child from full source and retains a lost durable archive-intent reply", { skip: process.platform !== "win32" }, async t => {
  let nativeCalls = 0;
  const f = await fixture(t, { retire: async (...args) => { nativeCalls++; return retireSealedNativeCapture(...args); } });
  const repository = path.join(f.capture, "repository"), journal = await readFile(path.join(f.capture, "merge.json"));
  const { approved, original } = await admitBeforeArchiveFailure(f);
  assert.equal(nativeCalls, 0);
  const foreign = path.join(repository, "useful-late-wip.txt");
  await writeFile(foreign, "keep useful data before archive recovery");
  await f.service.runApproved(approved);
  assert.equal(nativeCalls, 0);
  assert.equal(f.store.getReadonly(original.operationId).metadata.captureArchiveIntent, undefined);
  assert.equal(await readFile(foreign, "utf8"), "keep useful data before archive recovery");
  const wrong = await f.owner.reconcile({ candidate: f.candidate, operationId: original.operationId,
    binding: { ...original.metadata.binding, inventorySha256: "0".repeat(64) } });
  assert.equal(wrong.status, "unknown"); assert.match(wrong.reason, /binding changed/u);
  await rm(foreign); // Only the disposable fixture's injected WIP.
  const transition = f.owner.store.transition.bind(f.owner.store);
  let lostReply = false;
  f.owner.store.transition = (...args) => {
    const result = transition(...args);
    if (!lostReply && args[0] === original.operationId && args[1].metadata?.captureArchiveIntent && result.applied) {
      lostReply = true;
      throw Error("lost reply AFTER durable original archive intent");
    }
    return result;
  };
  try { await f.service.runApproved(approved); }
  finally { f.owner.store.transition = transition; }
  assert.equal(lostReply, true, "Full unchanged source must reach SAME-child durable archive intake");
  const intake = f.store.getReadonly(original.operationId);
  assert.equal(intake.outcome, "unknown");
  assert.ok(intake.metadata.captureArchiveIntent);
  assert.equal(intake.metadata.captureArchive, undefined);
  assert.equal(nativeCalls, 0);
  assert.equal(f.store.getReadonly(intake.metadata.captureArchiveIntent.operationId), null);
  await f.service.close();
  const reopened = new MaintenanceOperationStore({ dataDir: f.dataDir });
  const resumed = new StorageRetentionService({ store: reopened, owners: [f.nativeOwner],
    readContext: async () => ({ ready: true, releaseId: "fixture", isolated: false, busy: false }),
    withLease: fn => withInterprocessLocks([path.join(f.dataDir, "storage-retention")], fn) });
  try { await resumed.runApproved(approved); } finally { await resumed.close(); }
  const recovered = reopened.getReadonly(original.operationId);
  assert.equal(nativeCalls, 1);
  assert.ok(["partial", "removed"].includes(recovered.phase), JSON.stringify(recovered));
  assert.deepEqual(recovered.metadata.binding, original.metadata.binding);
  assert.deepEqual(recovered.metadata.captureArchiveIntent, intake.metadata.captureArchiveIntent);
  assert.equal(recovered.metadata.captureArchive.operationId, intake.metadata.captureArchiveIntent.operationId);
  assert.equal(reopened.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id).operationId, original.operationId);
  const archive = await new OwnedNativeObjectStore({ dataDir: f.dataDir, gitAt: git }).readArchive(recovered.metadata.captureArchive);
  assert.deepEqual(archive.manifest.binding.retirement, original.metadata.binding);
  assert.deepEqual(await readFile(path.join(f.capture, "merge.json")), journal);
});

test("admitted native intake keeps incomplete source UNKNOWN without archive or native deletion", { skip: process.platform !== "win32" }, async t => {
  let nativeCalls = 0;
  const f = await fixture(t, { retire: async () => { nativeCalls++; assert.fail("No native deletion from incomplete source"); } });
  const { approved, original } = await admitBeforeArchiveFailure(f);
  const repository = path.join(f.capture, "repository"), kept = await readFile(path.join(repository, "value-0.txt"));
  await rm(path.join(repository, "value-74.txt")); // Simulated unconfirmed partial source in this disposable fixture only.
  const before = await inventoryNativeCapture(repository, { allowSharedObjects: true });
  await f.service.runApproved(approved);
  const row = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
  assert.equal(row.operationId, original.operationId);
  assert.equal(row.outcome, "unknown");
  assert.equal(row.metadata.captureArchiveIntent, undefined);
  assert.equal(row.metadata.captureArchive, undefined);
  assert.equal(nativeCalls, 0);
  assert.deepEqual(await inventoryNativeCapture(repository, { allowSharedObjects: true }), before);
  assert.deepEqual(await readFile(path.join(repository, "value-0.txt")), kept);
});

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
  const actualWithArchiveLease = OwnedNativeObjectStore.prototype.withArchiveLease;
  let drifted = false;
  OwnedNativeObjectStore.prototype.withArchiveLease = async function (...args) {
    if (!drifted && args[0].operationId === archive.operationId) {
      drifted = true;
      // Actual drift BEFORE acquiring the final object lease. Mutating refs
      // inside that held lease would bypass the very owner being exercised.
      await withInterprocessLocks([path.join(f.dataDir, "native-git-objects")], async lease => {
        await lease.assertOwned();
        await git(objects.repository, ["update-ref", "-d", tagRef, tag]);
        await git(objects.repository, ["gc", "--prune=now"]);
        await assert.rejects(git(objects.repository, ["cat-file", "-e", tag]));
        await lease.assertOwned();
      });
    }
    return actualWithArchiveLease.apply(this, args);
  };
  try { await f.service.runApproved(approved); }
  finally { OwnedNativeObjectStore.prototype.withArchiveLease = actualWithArchiveLease; }
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
  await writeFile(previousFile, JSON.stringify({ ...previous, target: 0 }));
  assert.equal((await f.owner.preview({ candidate: f.candidate })).status, "retained", "malformed falsy target is not an absent intake target");
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


test("completed generation Gitless source remainder preserves custody while unrelated SAME native retires", { skip: process.platform !== "win32" }, async t => {
  let nativeCalls = 0;
  const f = await fixture(t, { retire: async (...args) => { nativeCalls++; return retireSealedNativeCapture(...args); } });
  const operationId = "fixture-generation-original", generation = 1;
  const identity = { schemaVersion: 1, operationId, generation, repositoryRoot: f.source };
  identity.identitySha256 = hash(`${operationId}:${generation}:${f.source}`);
  const key = identity.identitySha256.slice(0, 24), generationRoot = path.join(f.dataDir, "release-gens", key);
  const repository = path.join(generationRoot, "release-repositories", taskRepositoryKey(f.source), "repository");
  const source = path.join(repository, "AgentHub"), archive = path.join(f.dataDir, "release-generation-evidence", key);
  await mkdir(path.join(source, "WIP"), { recursive: true });
  await writeFile(path.join(source, "source.mjs"), "export const retained = true;\n");
  await writeFile(path.join(source, "WIP", "useful.txt"), "retain this unique original source remainder");
  await mkdir(path.join(archive, "evidence"), { recursive: true });
  const manifest = Buffer.from(JSON.stringify({ workspaceId: f.workspace.id, compositionPolicy: "main-selected-git-merge-v1",
    tasks: [{ taskId: f.task.id, resultCommit: f.state.identity.resultCommit }] }));
  const manifestHash = hash(manifest), checkpoint = Buffer.from(JSON.stringify({ phase: "frozen", preReleaseHead: f.state.head, manifestHash }));
  await writeFile(path.join(archive, "identity.json"), JSON.stringify(identity));
  await writeFile(path.join(archive, "checkpoint.json"), checkpoint);
  const archivedManifest = path.join(archive, "evidence", manifestHash + ".json");
  await writeFile(archivedManifest, manifest);
  // This is a private reproduction of the real owner's partial removal state:
  // live generation identity/Git are absent, originals are archived, source stays.
  const prepared = path.join(f.root, "releases", "completed-generation-source"); await mkdir(prepared);
  const runtimeManifest = path.join(prepared, "runtime-manifest.json");
  const runtimeBytes = Buffer.from(JSON.stringify({ releaseId: "completed-generation-source", sourceRoot: source,
    publicationRevision: f.state.head, files: [] }));
  await writeFile(runtimeManifest, runtimeBytes);
  const store = new ReleaseOperationStore({ dataDir: f.dataDir, idFactory: () => operationId }), scheduled = [];
  const release = new ReleaseOperationService({ store, schedule: fn => scheduled.push(fn), processAlive: () => false,
    compose: async () => ({ repositoryBases: [{ repositoryRoot: f.source, baseCommit: f.state.identity.before }],
      selectedResults: [{ taskId: f.task.id, resultCommit: f.state.identity.resultCommit }],
      candidates: [{ repositoryRoot: f.source, releaseRoot: repository, generationRoot, commit: f.state.head,
        tree: await git(path.join(f.capture, "repository"), ["rev-parse", "HEAD^{tree}"]), manifestHash }] }),
    validate: async () => ({ status: "passed" }),
    publishTarget: async () => { await git(f.source, ["update-ref", "refs/heads/fixture-generation-published", f.state.head]); return { status: "applied", revision: f.state.head }; },
    readTarget: async () => ({ status: "not_applied" }), finalize: async () => ({ closed: [f.task.id] }),
  });
  f.owner.readGeneration = (id, n) => release.retentionGeneration(id, n);
  release.start({ requestId: "original-generation", workspaceId: f.workspace.id, streamId: "fixture-stream", threadId: "fixture-thread",
    authorization: { taskIds: [f.task.id], validationMode: "full", approvedTargets: [{ targetId: "git", kind: "git", repositoryRoot: f.source }] } });
  assert.equal((await f.owner.preview({ candidate: f.candidate })).status, "retained", "unfinished original is not source custody");
  scheduled.shift()(); await release.drain(operationId);
  assert.equal(store.get(operationId).state, "done");
  const before = store.snapshot(operationId), pointer = await readFile(path.join(f.root, "current.json"));
  const preview = await f.owner.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const priorGraft = process.env.GIT_GRAFT_FILE;
  try {
    let proofReads = 0;
    const read = (id, n) => { proofReads++; return release.retentionGeneration(id, n); };
    process.env.GIT_GRAFT_FILE = path.join(f.root, "foreign-history-input");
    await assert.rejects(f.owner.installationLease(f.root, () => assertNativeCaptureNotSourcePinned(f.root,
      path.join(f.capture, "repository"), { readGeneration: read })), /ordinary local Git source custody/u);
    assert.equal(proofReads, 0, "ambient history refuses before reading a derived authority");
    delete process.env.GIT_GRAFT_FILE;
    const late = (id, n) => { const value = read(id, n); process.env.GIT_GRAFT_FILE = path.join(f.root, "late-history-input"); return value; };
    await assert.rejects(f.owner.installationLease(f.root, () => assertNativeCaptureNotSourcePinned(f.root,
      path.join(f.capture, "repository"), { readGeneration: late })), /ordinary local Git source custody/u);
    assert.equal(proofReads, 1, "late ambient drift refuses the before-return fence");
    delete process.env.GIT_GRAFT_FILE; proofReads = 0;
    const finalRead = (id, n) => { const value = read(id, n); if (proofReads === 2) process.env.GIT_GRAFT_FILE = path.join(f.root, "final-history-input"); return value; };
    await assert.rejects(f.owner.installationLease(f.root, () => assertNativeCaptureNotSourcePinned(f.root,
      path.join(f.capture, "repository"), { readGeneration: finalRead })), /ordinary local Git source custody/u);
    assert.equal(proofReads, 2, "second canonical read cannot introduce ambient history at return");
    delete process.env.GIT_GRAFT_FILE; proofReads = 0;
    const restoredIdentity = async (id, n) => { const value = read(id, n); if (proofReads === 2) await writeFile(path.join(generationRoot, "identity.json"), JSON.stringify(identity)); return value; };
    await assert.rejects(f.owner.installationLease(f.root, () => assertNativeCaptureNotSourcePinned(f.root,
      path.join(f.capture, "repository"), { readGeneration: restoredIdentity })), /generation custody changed/u);
    await rm(path.join(generationRoot, "identity.json")); // Only this fixture's injected live identity.
  } finally { if (priorGraft === undefined) delete process.env.GIT_GRAFT_FILE; else process.env.GIT_GRAFT_FILE = priorGraft; }
  await writeFile(archivedManifest, Buffer.concat([manifest, Buffer.from(" ")]));
  assert.equal((await f.owner.preview({ candidate: f.candidate })).status, "retained", "archive raw hash drift retains");
  await writeFile(archivedManifest, manifest);
  await writeFile(runtimeManifest, JSON.stringify({ ...JSON.parse(runtimeBytes), publicationRevision: "0".repeat(40) }));
  assert.equal((await f.owner.preview({ candidate: f.candidate })).status, "retained", "wrong exact publication retains");
  await writeFile(runtimeManifest, runtimeBytes);
  const approved = [{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }];
  const borrower = path.join(source, ".git"); await mkdir(path.join(borrower, "objects", "info"), { recursive: true });
  await writeFile(path.join(borrower, "objects", "info", "alternates"), path.join(f.capture, "repository", ".git", "objects") + "\n");
  await f.service.runApproved(approved);
  assert.equal(nativeCalls, 0, "fresh effect guard must preserve a restored live borrower");
  const first = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
  assert.ok(!first?.metadata.captureArchive, "no archive/deletion authority from stale preview");
  assert.equal(await readFile(path.join(source, "WIP", "useful.txt"), "utf8"), "retain this unique original source remainder");
  assert.equal((await lstat(borrower)).isSymbolicLink(), false);
  assert.equal(borrower, path.join(source, ".git"));
  await rm(borrower, { recursive: true }); // Only this fixture's injected borrower.
  let child;
  for (let i = 0; i < 128; i++) {
    await f.service.runApproved(approved);
    const row = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
    assert.ok(row); child ??= row.operationId; assert.equal(row.operationId, child);
    if (row.status === "succeeded") break;
    assert.equal(row.metadata.lastObservation?.status, "partial", JSON.stringify(row.metadata.lastObservation));
    assert.ok(row.metadata.lastObservation.files > 0);
  }
  assert.equal(f.store.getReadonly(child).status, "succeeded");
  await assert.rejects(lstat(path.join(f.capture, "repository")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(source, "source.mjs"), "utf8"), "export const retained = true;\n");
  assert.equal(await readFile(path.join(source, "WIP", "useful.txt"), "utf8"), "retain this unique original source remainder");
  assert.deepEqual(await readFile(archivedManifest), manifest);
  assert.deepEqual(await readFile(path.join(archive, "checkpoint.json")), checkpoint);
  assert.deepEqual(await readFile(runtimeManifest), runtimeBytes);
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), pointer);
  assert.deepEqual(store.snapshot(operationId), before, "source custody proof is read-only under the original release");
});


test("retirement preserves historical original without granting current native result certification", { skip: process.platform !== "win32" }, async t => {
  let nativeCalls = 0;
  const f = await fixture(t, { historicalReplay: historicalReplayLines,
    retire: async (...args) => { nativeCalls++; return retireSealedNativeCapture(...args); } });
  const repository = path.join(f.capture, "repository"), stateFile = path.join(f.capture, "merge.json");
  const recordFile = path.join(f.dataDir, "task-native-integrations", f.task.id, taskRepositoryKey(f.source), hash(f.originalId) + ".json");
  const legacy = JSON.parse(await readFile(recordFile, "utf8"));
  // Historical-record fixture: its old agreed base predates the shared prefix.
  // The candidate stays the genuine automatic result produced by actual TaskGit.
  // No current-admission success for that old agreed base is invented.
  legacy.snapshot.baseCommit = f.historicalAgreedBase;
  legacy.snapshot.gitBaseline.tree = f.historicalAgreedBase;
  await writeFile(recordFile, JSON.stringify(legacy));
  const stateBytes = await readFile(stateFile), recordBytes = await readFile(recordFile), pointer = await readFile(path.join(f.root, "current.json"));
  const current = async gitPort => assertNativeMergedResults({ git: gitPort,
    baseCommit: f.state.identity.before, tasks: [{ taskId: f.task.id, baseCommit: legacy.snapshot.baseCommit, resultCommit: f.state.identity.resultCommit }],
    merges: f.state.merges, head: f.state.head, tree: legacy.targetTree, identity: f.state.identity });
  const isCurrentRefusal = error => error.code === "RELEASE_SELECTED_CONTENT_MISSING";
  await assert.rejects(current((args, options) => git(repository, args, options)), isCurrentRefusal);
  const originals = await git(repository, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]);
  const preview = await f.owner.preview({ candidate: f.candidate }); assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const approved = [{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }];
  const verification = f.taskGit.verifyNativeCaptureArchiveOwned.bind(f.taskGit);
  // One real ordinary certification call models the old consumer AFTER its
  // durable archive succeeded. It still refuses; no fake validator success.
  f.taskGit.verifyNativeCaptureArchiveOwned = async args => {
    f.taskGit.verifyNativeCaptureArchiveOwned = verification;
    return verification({ ...args, retirementOperationId: null });
  };
  await f.service.runApproved(approved);
  const first = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
  assert.equal(first.outcome, "unknown"); assert.equal(nativeCalls, 0);
  const archiveRow = f.store.getReadonly(first.metadata.captureArchiveIntent.operationId);
  assert.equal(archiveRow.status, "succeeded");
  const objects = new OwnedNativeObjectStore({ dataDir: f.dataDir, gitAt: git });
  const archived = await objects.readArchive(archiveRow.metadata.archive), record = preview.binding.record;
  await f.taskGit.withTaskLock(f.task.id, lease => assert.rejects(verification({ state: f.state, record, archive: archived, lease,
    retirementOperationId: "foreign-original" })));
  await f.taskGit.withTaskLock(f.task.id, lease => assert.rejects(verification({ state: f.state,
    record: { ...record, sha256: "0".repeat(64) }, archive: archived, lease, retirementOperationId: first.operationId })));
  assert.equal(nativeCalls, 0, "Foreign original/binding rejects without entering the native sink");
  await f.taskGit.withTaskLock(f.task.id, lease => assert.rejects(verification({ state: f.state, record, archive: archived, lease }), isCurrentRefusal));
  await writeFile(recordFile, Buffer.concat([recordBytes, Buffer.from(" ")]));
  await f.service.runApproved(approved); assert.equal(nativeCalls, 0, "Changed raw original cannot become storage authority");
  await writeFile(recordFile, recordBytes);
  for (let batch = 0; batch < 128; batch++) {
    await f.service.runApproved(approved);
    const row = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
    assert.equal(row.operationId, first.operationId);
    if (row.status === "succeeded") break;
    assert.equal(row.metadata.lastObservation?.status, "partial", JSON.stringify(row.metadata.lastObservation));
    assert.ok(row.metadata.lastObservation.files > 0);
  }
  const completed = f.store.getReadonly(first.operationId); assert.equal(completed.status, "succeeded");
  assert.ok(nativeCalls > 0); await assert.rejects(lstat(repository), { code: "ENOENT" });
  assert.equal(completed.metadata.captureArchive.operationId, archiveRow.operationId);
  assert.equal(f.store.getReadonly(archiveRow.operationId).revision, archiveRow.revision, "No new archive/transfer or successful-original rewrite");
  const retained = await objects.readArchive(completed.metadata.captureArchive);
  assert.deepEqual(retained.manifest.objects, originals.split(/\r?\n/u).filter(Boolean).map(line => { const [oid, type] = line.split(" "); return { oid, type }; }).sort((a,b) => a.oid.localeCompare(b.oid)));
  assert.equal(await git(objects.repository, ["show", f.state.identity.resultCommit + ":value-0.txt"]), "selected 0");
  assert.equal(await git(objects.repository, ["show", f.state.head + ":replay.txt"]), historicalReplayLines.prefix.trimEnd());
  await objects.withArchiveMath(retained.archive, math => assert.rejects(current((args, options) => git(math.repository, args, options)), isCurrentRefusal));
  await f.taskGit.withTaskLock(f.task.id, lease => assert.rejects(verification({ state: f.state, record, archive: retained, lease }), isCurrentRefusal));
  assert.deepEqual(await readFile(stateFile), stateBytes); assert.deepEqual(await readFile(recordFile), recordBytes);
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), pointer);
});

test("retirement still refuses a historical target with unreviewed native graph changes", { skip: process.platform !== "win32" }, async t => {
  let nativeCalls = 0;
  const f = await fixture(t, { retire: async (...args) => { nativeCalls++; return retireSealedNativeCapture(...args); } });
  const repository = path.join(f.capture, "repository"), stateFile = path.join(f.capture, "merge.json");
  const recordFile = path.join(f.dataDir, "task-native-integrations", f.task.id, taskRepositoryKey(f.source), hash(f.originalId) + ".json");
  const legacy = JSON.parse(await readFile(recordFile, "utf8")), beforeTree = await git(repository, ["rev-parse", f.state.identity.before + "^{tree}"]);
  const changed = await git(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", beforeTree,
    "-p", f.state.identity.before, "-p", f.state.identity.resultCommit], { input: "Seeded unreviewed historical target\n" });
  await git(repository, ["reset", "--hard", changed]); // Only this disposable fixture.
  f.state.head = changed; f.state.merges[0].commit = changed; legacy.target = changed; legacy.targetTree = beforeTree;
  await writeFile(stateFile, JSON.stringify(f.state)); await writeFile(recordFile, JSON.stringify(legacy));
  const stateBytes = await readFile(stateFile), recordBytes = await readFile(recordFile);
  const preview = await f.owner.preview({ candidate: f.candidate }); assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const approved = [{ ownerId: "native-merge-transport", candidate: f.candidate, binding: preview.binding }];
  await f.service.runApproved(approved);
  const first = f.store.latestStorageArtifactReadonly("native-merge-transport", f.candidate.id);
  await f.service.runApproved(approved);
  const after = f.store.getReadonly(first.operationId);
  assert.equal(after.outcome, "unknown"); assert.equal(nativeCalls, 0);
  assert.equal(after.metadata.captureArchive, undefined, "Graph refusal cannot become confirmed retirement archive");
  assert.equal((await lstat(repository)).isDirectory(), true);
  assert.deepEqual(await readFile(stateFile), stateBytes); assert.deepEqual(await readFile(recordFile), recordBytes);
});
