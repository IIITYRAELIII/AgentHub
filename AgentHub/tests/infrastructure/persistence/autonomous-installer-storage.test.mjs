import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { backupStoppedRuntime } from "../../../src/infrastructure/persistence/runtime-maintenance-backup.mjs";
import { packageFile } from "../../../src/infrastructure/filesystem/runtime-package-target.mjs";
import { installerDirectory, installerBackupIntent, installerStorageDigest, sealAutonomousInstallerStorage,
  registerInstallerStorageEvidence } from "../../../src/infrastructure/persistence/autonomous-installer-storage.mjs";
import { registerLegacyInstallerCustody } from "../../../src/infrastructure/persistence/autonomous-installer-storage.mjs";
import { RuntimeUpdateBackupRetention, sealRuntimeUpdateBackup } from "../../../src/infrastructure/persistence/runtime-update-backup-retention.mjs";
import { StorageRetentionService } from "../../../src/application/storage-retention-service.mjs";
import { deleteVerifiedWindowsEntry } from "../../../src/infrastructure/persistence/windows-delete-verified-entry.mjs";
import { queryInstallerWorkerRetired } from "../../../src/infrastructure/persistence/windows-delete-verified-entry.mjs";
import { trustedWindowsPowerShellPath } from "../../../src/infrastructure/process/system-boot-identity.mjs";

const json = (file, value) => writeFile(file, JSON.stringify(value));
const exists = file => lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "hub471-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, "Hub"), data = path.join(root, "data"); await mkdir(data, { recursive: true });
  await json(path.join(root, "config.json"), { marker: "user-data" });
  const db = new DatabaseSync(path.join(data, "sample.sqlite")); db.exec("CREATE TABLE sample(value); INSERT INTO sample VALUES(71)"); db.close();
  const store = new MaintenanceOperationStore({ dataDir: data });
  const archive = path.join(base, "borrowed.zip"); await writeFile(archive, "borrowed original must survive");
  const runtime = await installerDirectory(root);
  async function create(id, { partial = false, unknown = false, historical = false, legacy = false, downloaded = false, creatorScope = false, unprovenPartial = false } = {}) {
    const cache = path.join(base, id); await mkdir(cache); await mkdir(path.join(cache, "verified"));
    await writeFile(path.join(cache, "install_release.py"), "verified creator fixture");
    const installerSha256 = (await packageFile(path.join(cache, "install_release.py"))).sha256;
    const worker = { pid: 2147483647, created: "132000000000000000", image: "python.exe", outsideAllJobs: true };
    const request = { runtimeRoot: root, runtimeIdentity: { dev: runtime.dev, ino: runtime.ino }, operationId: id,
      archive, release: null, sha256: "a".repeat(64), installerSha256 };
    await json(path.join(cache, "request.json"), request); await json(path.join(cache, "worker-started.json"), worker);
    await json(path.join(cache, "dispatch.json"), worker);
    const payload = path.join(cache, "verified", "body.bin"); await writeFile(payload, Buffer.alloc(1024, 17));
    const manifest = { schema: 1, repository: "IIITYRAELIII/AgentHub", releaseId: id,
      files: [{ path: "body.bin", ...await packageFile(payload) }] };
    await json(path.join(cache, "verified", "package-manifest.json"), manifest);
    if (downloaded) {
      request.archive = null; request.release = "2.1.8";
      await writeFile(path.join(cache, "release.zip"), "owned downloaded archive");
    }
    if (legacy) {
      request.archive = path.join(base, id + ".zip");
      await promisify(execFile)("python", ["-I", "-c", "import zipfile,sys,os; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2]+'/package-manifest.json','package-manifest.json'); z.write(sys.argv[2]+'/body.bin','body.bin'); z.close()", request.archive, path.join(cache, "verified")]);
      const observed = await promisify(execFile)("python", ["-I", "-c", "import os,json,sys; s=os.stat(sys.argv[1]); print(json.dumps(dict(dev=str(s.st_dev),ino=str(s.st_ino))))", root]);
      request.runtimeIdentity = JSON.parse(observed.stdout);
    }
    await json(path.join(cache, "request.json"), request);
    const binding = { runtimeRoot: root, releaseId: id, installerSha256, workerPid: worker.pid,
      archiveSha256: "a".repeat(64), packageManifestSha256: (await packageFile(path.join(cache, "verified", "package-manifest.json"))).sha256 };
    if (downloaded) binding.archiveSha256 = (await packageFile(path.join(cache, "release.zip"))).sha256;
    if (legacy) { delete binding.packageManifestSha256; binding.archiveSha256 = (await packageFile(request.archive)).sha256; }
    if (creatorScope) binding.storageScope = { cache: { path: cache, ...await installerDirectory(cache) }, worker,
      requestSha256: (await packageFile(path.join(cache, "request.json"))).sha256 };
    let op = store.create({ operationId: id, kind: "restart", streamId: "agent-hub-installer", threadId: root, status: "running",
      createdAt: `2026-01-${id.match(/\d+/)?.[0]?.padStart(2, "0") ?? "01"}T00:00:00Z`, metadata: { autonomousInstaller: binding } });
    const backup = path.join(cache, "backup");
    if (partial) {
      await mkdir(backup); await mkdir(path.join(backup, "data"));
      const attempt = await installerBackupIntent({ directory: backup, files: [{ relative: "data/partial.bin", sqlite: false }] });
      if (!unprovenPartial) op = store.transition(id, { metadata: { autonomousBackupAttempt: attempt } }, { expectedRevision: op.revision }).operation;
      await json(path.join(cache, "input-backup.json"), { destination: backup });
      await writeFile(path.join(backup, "data", "partial.bin"), "producer-written prefix before caught failure");
    } else {
      const raw = await backupStoppedRuntime({ runtimeRoot: root, destination: backup, assertStopped: async () => {} });
      const snapshot = legacy ? raw : await sealRuntimeUpdateBackup(raw);
      op = store.transition(id, { metadata: { autonomousBackup: snapshot } }, { expectedRevision: op.revision }).operation;
    }
    const evidence = await sealAutonomousInstallerStorage({ runtimeRoot: root, operation: op, cache });
    if (!historical) op = store.transition(id, { metadata: { autonomousStorage: evidence } }, { expectedRevision: op.revision }).operation;
    op = store.transition(id, unknown ? { status: "reconciling", outcome: "unknown" }
      : partial ? { status: "failed", outcome: "rolled-back", phase: "previous-ready", metadata: { autonomousRecovery: { releaseId: "old" } } }
        : { status: "succeeded", outcome: "succeeded", phase: "ready", metadata: { autonomousReady: { releaseId: id } } }, { expectedRevision: op.revision }).operation;
    return { id, cache, backup, evidence, original: op };
  }
  const make = options => {
    const owner = new RuntimeUpdateBackupRetention({ runtimeRoot: root, store, ...options });
    const service = new StorageRetentionService({ store, owners: [owner], logger: { warn() {} },
      readContext: () => ({ ready: true, busy: false, isolated: false, releaseId: "installed" }),
      withLease: fn => fn({ assertOwned: async () => {} }) });
    return { owner, service };
  };
  async function drain(service, check) {
    for (let i = 0; i < 30 && !await check(); i++) await service.runOnce();
    assert.ok(await check(), JSON.stringify(service.status()));
  }
  return { base, root, store, archive, create, make, drain };
}

test("six real SQLite backups converge to five; every owned payload retires, borrowed archive/data/history stay", async t => {
  const f = await fixture(t), updates = [];
  for (let i = 1; i <= 6; i++) updates.push(await f.create(`update-${i}`));
  const { owner, service } = f.make();
  const before = performance.now();
  await f.drain(service, async () => !(await exists(updates[0].backup)) && !(await exists(path.join(updates.at(-1).cache, "verified"))));
  assert.equal((await Promise.all(updates.map(u => exists(u.backup)))).filter(Boolean).length, 5);
  assert.equal(owner.status().limitMet, true);
  for (const update of updates) {
    assert.deepEqual(f.store.getReadonly(update.id), update.original);
    assert.equal(await exists(path.join(update.cache, "request.json")), true);
  }
  assert.equal(await readFile(f.archive, "utf8"), "borrowed original must survive");
  assert.equal(JSON.parse(await readFile(path.join(f.root, "config.json"), "utf8")).marker, "user-data");
  t.diagnostic(JSON.stringify({ elapsedMs: performance.now() - before, logicalBytes: service.status().logicalBytes,
    knownBackups: owner.status().knownBackups }));
});

test("explicit contemporary custody admits only the exact disposed legacy partial and preserves whole source history", async t => {
  const f = await fixture(t), legacy = await f.create("update-1", { partial: true, historical: true, unprovenPartial: true });
  const successor = await f.create("update-2");
  await json(path.join(f.root, "current.json"), { current: successor.id });
  const body = path.join(legacy.backup, "data", "partial.bin"), file = await packageFile(body);
  const identity = async name => {
    const stat = await lstat(name, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino), bytes: Number(stat.size) };
  };
  const preview = { target: legacy.backup, rootIdentity: await identity(legacy.backup), original: legacy.original,
    files: [{ relative: path.join("data", "partial.bin"), identity: await identity(body), sha256: file.sha256 }],
    directories: [{ relative: ".", identity: await identity(legacy.backup) }, { relative: "data", identity: await identity(path.dirname(body)) }],
    effects: 0, retiredWorker: legacy.evidence.worker };
  const previewFile = path.join(f.base, "explicit-custody-preview.json"); await json(previewFile, preview);
  const input = { runtimeRoot: f.root, store: f.store, previewFile, previewSha256: (await packageFile(previewFile)).sha256,
    successorOperationId: successor.id, decisionId: "delivery-owner-exact-partial-custody" };
  await assert.rejects(registerLegacyInstallerCustody({ ...input, previewSha256: "f".repeat(64) }), /preview-changed/);
  await json(path.join(f.root, "current.json"), { current: "foreign-current" });
  await assert.rejects(registerLegacyInstallerCustody(input), /current-changed/);
  await json(path.join(f.root, "current.json"), { current: successor.id });
  await writeFile(body, "foreign replacement contents");
  await assert.rejects(registerLegacyInstallerCustody(input), /content-changed/);
  await writeFile(body, "producer-written prefix before caught failure");
  const { service } = f.make(); await service.runOnce();
  assert.equal(await exists(legacy.backup), true, "absence of creator proof is not automatic custody");
  const checked = await registerLegacyInstallerCustody({ ...input, inspectOnly: true }); assert.equal(checked.readOnly, true);
  assert.equal(f.store.getReadonly(checked.intake.operationId), null);
  const receipt = await registerLegacyInstallerCustody(input);
  const next = f.make(); await f.drain(next.service, async () => !await exists(legacy.backup));
  assert.deepEqual(await registerLegacyInstallerCustody(input), receipt, "readback after deleted heavy body is not readmission");
  assert.deepEqual(f.store.getReadonly(legacy.id), legacy.original);
  assert.equal(await exists(path.join(legacy.cache, "request.json")), true);
});

test("existing command trace receives numeric per-original cleanup bytes/time and diagnostic rejection cannot change deletion", async t => {
  const f = await fixture(t), update = await f.create("update-1"), spans = [];
  const { service } = f.make({ trace: { recordBestEffort: span => { spans.push(span); return Promise.reject(Error("trace unavailable")); } } });
  await f.drain(service, async () => !await exists(path.join(update.cache, "verified")));
  assert.ok(spans.length > 0); assert.ok(spans.some(span => span.metadata.logicalBytes >= 1024));
  for (const span of spans) {
    assert.equal(span.stage, "storage-update-artifact-prune");
    assert.ok(f.store.getReadonly(span.commandId));
    assert.ok(span.monotonicDurationMs >= 0);
    assert.deepEqual(Object.keys(span.metadata).sort(), ["artifactClass", "logicalBytes", "partial", "reconciliation"]);
  }
});

test("native worker proof distinguishes its retained birth from PID reuse without stopping either process", async () => {
  const result = await promisify(execFile)(trustedWindowsPowerShellPath(process.env), ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`], { windowsHide: true });
  const created = result.stdout.trim();
  assert.equal(await queryInstallerWorkerRetired({ pid: process.pid, created }), false);
  assert.equal(await queryInstallerWorkerRetired({ pid: process.pid, created: String(BigInt(created) - 1n) }), true);
});

test("old successful original is automatically adopted from its actual ZIP and Python file identities", async t => {
  const f = await fixture(t), old = await f.create("update-1", { historical: true, legacy: true });
  const { service } = f.make();
  await f.drain(service, async () => !await exists(path.join(old.cache, "verified")));
  assert.deepEqual(f.store.getReadonly(old.id), old.original);
  assert.equal(await exists(old.backup), true);
  const receipts = f.store.listInstallerStorageEvidenceReadonly().items;
  assert.equal(receipts.length, 1); assert.equal(receipts[0].metadata.owner, "runtime-update-backup");
});

test("owned download is deleted separately, compact receipts and borrowed input are preserved", async t => {
  const f = await fixture(t), update = await f.create("update-1", { downloaded: true, creatorScope: true });
  await rm(path.join(update.cache, "dispatch.json")); // caller died before its acknowledgement write
  const sealed = await sealAutonomousInstallerStorage({ runtimeRoot: f.root, operation: update.original, cache: update.cache });
  assert.deepEqual(sealed, update.evidence);
  const { service } = f.make();
  await f.drain(service, async () => !await exists(path.join(update.cache, "release.zip")));
  assert.equal(await exists(path.join(update.cache, "request.json")), true);
  assert.equal(await exists(f.archive), true);
  assert.deepEqual(f.store.getReadonly(update.id), update.original);
});

test("exclusive backup intent precedes a real missing-source failure and bounds the empty partial cleanup", async t => {
  const f = await fixture(t), update = await f.create("update-1", { historical: true });
  // A separate actual backup attempt fails on the source after exclusive creation.
  const destination = path.join(f.base, "partial-real"), saved = path.join(f.base, "saved-config.json");
  let intent;
  await assert.rejects(backupStoppedRuntime({ runtimeRoot: f.root, destination, assertStopped: async () => {},
    onCreated: async scope => {
      intent = await installerBackupIntent(scope);
      await rename(path.join(f.root, "config.json"), saved);
    } }), /ENOENT/);
  assert.ok(intent.files.some(file => file.path === "config.json"));
  assert.equal(intent.root.ino, String((await lstat(destination, { bigint: true })).ino));
  await rename(saved, path.join(f.root, "config.json"));
  assert.equal(await exists(update.backup), true);
});

test("rolled-back creator-pinned partial backup is removed; unresolved UNKNOWN retains all artifacts", async t => {
  const f = await fixture(t), failed = await f.create("update-1", { partial: true }), unresolved = await f.create("update-2", { unknown: true });
  const { service } = f.make();
  await f.drain(service, async () => !await exists(failed.backup) && !await exists(path.join(failed.cache, "verified")));
  assert.equal(await exists(unresolved.backup), true);
  assert.equal(await exists(path.join(unresolved.cache, "verified")), true);
  assert.deepEqual(f.store.getReadonly(unresolved.id), unresolved.original);
});

test("addressed canonical provenance import is idempotent and preserves historical source; UNKNOWN refuses", async t => {
  const f = await fixture(t), old = await f.create("update-1", { historical: true });
  const input = { runtimeRoot: f.root, store: f.store, operationId: old.id, cache: old.cache,
    expectedOriginalSha256: installerStorageDigest(old.original) };
  const receipt = await registerInstallerStorageEvidence(input);
  assert.deepEqual(await registerInstallerStorageEvidence(input), receipt);
  const { service } = f.make();
  await f.drain(service, async () => !await exists(path.join(old.cache, "verified")));
  assert.equal(await exists(old.backup), true);
  assert.deepEqual(f.store.getReadonly(old.id), old.original);
  const unknown = await f.create("update-2", { historical: true, unknown: true });
  await assert.rejects(registerInstallerStorageEvidence({ ...input, operationId: unknown.id, cache: unknown.cache,
    expectedOriginalSha256: installerStorageDigest(unknown.original) }), /disposition/);
});

test("lost native reply reconciles SAME child after reopen; unadmitted entries continue without deleting receipts", async t => {
  const f = await fixture(t), update = await f.create("update-1"); let once = true, calls = 0, first;
  let { owner, service } = f.make({ deleteEntry: async (...args) => {
    calls++; first ??= args[0]; await deleteVerifiedWindowsEntry(...args);
    if (once) { once = false; throw Error("reply lost after native effect"); }
  } });
  await service.runOnce();
  const candidates = f.store.listPackageBackupOriginsReadonly(); assert.equal(candidates.items.length, 1);
  const candidateId = `${update.id}:installer:payload:${installerStorageDigest(update.evidence.cache).slice(0, 16)}`;
  const child = f.store.latestStorageArtifactReadonly(owner.id, candidateId);
  assert.equal(child.status, "reconciling"); assert.equal(calls, 1); assert.equal(await exists(first), false);
  ({ owner, service } = f.make());
  await f.drain(service, async () => !await exists(path.join(update.cache, "verified")));
  assert.equal(f.store.getReadonly(child.operationId).status, "succeeded");
  assert.deepEqual(f.store.getReadonly(update.id), update.original);
});

test("lost final owner reply reopens its compact completion receipt and never repeats completed deletion", async t => {
  const f = await fixture(t), update = await f.create("update-1");
  const first = f.make(), prune = first.owner.prune.bind(first.owner);
  first.owner.prune = async input => { await prune(input); throw Error("final owner reply lost"); };
  await first.service.runOnce();
  assert.equal(await exists(path.join(update.cache, "verified")), false);
  const id = `${update.id}:installer:payload:${installerStorageDigest(update.evidence.cache).slice(0, 16)}`;
  const child = f.store.latestStorageArtifactReadonly(first.owner.id, id);
  assert.equal(child.status, "reconciling");
  assert.equal(child.metadata.updateBackupPrune.complete, true);
  assert.equal(child.metadata.updateBackupPrune.proof, undefined);
  let calls = 0;
  const reopened = f.make({ deleteEntry: async () => { calls++; assert.fail("completed effect repeated"); } });
  await reopened.service.runOnce();
  assert.equal(calls, 0);
  assert.equal(f.store.getReadonly(child.operationId).status, "succeeded");
  assert.equal(f.store.getReadonly(child.operationId).metadata.result.status, "already-removed");
});

test("extra file, replaced cache, reparse target and a live worker retain foreign bytes", async t => {
  const f = await fixture(t), update = await f.create("update-1");
  await writeFile(path.join(update.cache, "verified", "foreign"), "foreign");
  let { service } = f.make(); await service.runOnce();
  assert.equal(await readFile(path.join(update.cache, "verified", "foreign"), "utf8"), "foreign");
  await rename(path.join(update.cache, "verified"), path.join(update.cache, "saved"));
  const foreign = path.join(f.base, "foreign"); await mkdir(foreign); await writeFile(path.join(foreign, "keep"), "keep");
  await symlink(foreign, path.join(update.cache, "verified"), process.platform === "win32" ? "junction" : "dir");
  ({ service } = f.make()); await service.runOnce();
  assert.equal(await readFile(path.join(foreign, "keep"), "utf8"), "keep");
  const live = await f.create("update-2", { historical: true });
  const binding = f.store.getReadonly(live.id).metadata.autonomousInstaller;
  // Test a live creator before terminal through the public seal/disposition route.
  const active = f.store.create({ operationId: "live", kind: "restart", streamId: "agent-hub-installer", threadId: f.root,
    status: "running", metadata: { autonomousInstaller: { ...binding, workerPid: process.pid } } });
  await assert.rejects(registerInstallerStorageEvidence({ runtimeRoot: f.root, store: f.store, operationId: active.operationId,
    cache: live.cache, expectedOriginalSha256: installerStorageDigest(active) }), /disposition/);
});
