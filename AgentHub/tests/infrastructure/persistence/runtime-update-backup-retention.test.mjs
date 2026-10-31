import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { StorageRetentionService } from "../../../src/application/storage-retention-service.mjs";
import { createStorageRetentionComposition } from "../../../src/composition/storage-retention-composition.mjs";
import { backupStoppedRuntime } from "../../../src/infrastructure/persistence/runtime-maintenance-backup.mjs";
import { deleteVerifiedWindowsEntry } from "../../../src/infrastructure/persistence/windows-delete-verified-entry.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quiet = { log() {}, warn() {}, error() {} };

async function fixture(t, { states = [], copies = 6 } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "hb383-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, "AgentHub"), data = path.join(root, "data");
  await mkdir(data, { recursive: true }); await mkdir(path.join(root, "releases"));
  await writeFile(path.join(root, "current.json"), '{"current":"fixture-release","previous":null}');
  await writeFile(path.join(root, "config.json"), '{"cursor":17,"auth":"private-fixture"}');
  const store = new MaintenanceOperationStore({ dataDir: data }), backups = [];
  for (let i = 0; i < copies; i++) {
    const operationId = `update-${i}`, scratchRoot = path.join(base, `transport-${i}`);
    await mkdir(scratchRoot);
    const binding = { operationId, runtimeRoot: root, scratchRoot, target: { releaseId: `new-${i}` } };
    let original = store.create({ operationId, kind: "restart", streamId: "agent-hub-runtime", threadId: "agent-hub-runtime",
      status: "running", createdAt: `2026-01-0${i + 1}T00:00:00.000Z`, metadata: { packageHandoff: { schema: 1, binding, sha256: digest(binding) } } });
    const { sealRuntimeUpdateBackup } = await import("../../../src/infrastructure/persistence/runtime-update-backup-retention.mjs");
    const snapshot = await sealRuntimeUpdateBackup(await backupStoppedRuntime({ runtimeRoot: root,
      destination: path.join(scratchRoot, "backup"), assertStopped: async () => {} }));
    original = store.transition(operationId, { metadata: { packageBackup: snapshot } }, { expectedRevision: original.revision }).operation;
    if (states[i] === "unknown") store.transition(operationId, { status: "reconciling", outcome: "unknown" }, { expectedRevision: original.revision });
    else if (states[i] === "active") { /* retained running original */ }
    else store.settle(operationId, { succeeded: true });
    backups.push(snapshot.directory);
  }
  const lease = { assertOwned: async () => {} };
  const emptyOwner = id => ({ id, list: async () => ({ items: [], done: true }), preview: async () => ({}),
    prune: () => assert.fail("unrelated retention"), reconcile: () => assert.fail("unrelated reconciliation") });
  const composition = () => createStorageRetentionComposition({ config: { dataDir: data }, store,
    taskGitWorkspaces: { storageRetentionOwner: () => emptyOwner("native-merge-transport") },
    releaseGitWorkspaces: { storageRetentionOwner: () => emptyOwner("release-generation-transport") },
    releaseOperations: {}, taskBoard: {}, timers: { schedule() {}, clear() {} },
    readReady: () => true, readBusy: () => false, isStopping: () => false,
    health: { setDiagnosticSource() {} },
    environment: { LOCALAPPDATA: base, AGENT_HUB_RUNTIME_ROOT: root, AGENT_HUB_RELEASE_ID: "fixture-release" } });
  const make = async options => {
    const { RuntimeUpdateBackupRetention } = await import("../../../src/infrastructure/persistence/runtime-update-backup-retention.mjs");
    const owner = new RuntimeUpdateBackupRetention({ runtimeRoot: root, store, ...options });
    const service = new StorageRetentionService({ store, owners: [owner], logger: quiet,
      readContext: () => ({ ready: true, busy: false, isolated: false, releaseId: "fixture-release" }),
      withLease: fn => fn(lease) });
    return { owner, service };
  };
  const count = async () => (await Promise.all(backups.map(p => lstat(p).then(() => 1, e => { if (e.code === "ENOENT") return 0; throw e; })))).reduce((a, b) => a + b, 0);
  return { base, root, data, store, backups, make, composition, count };
}

test("ordinary after-ready storage owner automatically retires six confirmed update backups to five across scratch roots", async t => {
  const f = await fixture(t), originals = Array.from({ length: 6 }, (_, i) => f.store.getReadonly(`update-${i}`));
  const service = f.composition();
  await service.runOnce();
  assert.equal(await f.count(), 5, JSON.stringify({ status: service.status(),
    child: f.store.latestStorageArtifactReadonly("runtime-update-backup", "update-0") }));
  await assert.rejects(lstat(f.backups[0]), { code: "ENOENT" });
  assert.equal(service.status().owners["runtime-update-backup"].limitMet, true);
  assert.equal(service.status().owners["runtime-update-backup"].knownBackups, 5);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => f.store.getReadonly(`update-${i}`)), originals);
  const child = f.store.latestStorageArtifactReadonly("runtime-update-backup", "update-0");
  assert.equal(child.status, "succeeded");
  await service.runOnce();
  assert.equal(await f.count(), 5);
  assert.equal(f.store.getReadonly(child.operationId).revision, child.revision);
  assert.equal(JSON.parse(await readFile(path.join(f.root, "config.json"), "utf8")).cursor, 17);
});

test("active and UNKNOWN recovery backups consume protected slots and are never deleted or rewritten", async t => {
  const f = await fixture(t, { states: ["active", ...Array(5).fill("unknown")] });
  const { owner, service } = await f.make();
  const before = f.store.getReadonly("update-0");
  await service.runOnce();
  assert.equal(await f.count(), 6);
  assert.equal(owner.status().limitMet, false); assert.equal(owner.status().protected, 6);
  assert.deepEqual(f.store.getReadonly("update-0"), before);
});

test("a recreated path after confirmed backup retirement is foreign evidence, never a newly adopted copy", async t => {
  const f = await fixture(t);
  const { service } = await f.make(); await service.runOnce();
  assert.equal(await f.count(), 5);
  await mkdir(f.backups[0]); await writeFile(path.join(f.backups[0], "foreign"), "new physical directory");
  const { owner } = await f.make();
  const proposed = await owner.list({ after: null, limit: 3 });
  assert.ok(!proposed.items.some(item => item.id === "update-0"));
  assert.equal(owner.status().unverified, 1);
  assert.equal(owner.status().limitMet, false);
  assert.equal(await readFile(path.join(f.backups[0], "foreign"), "utf8"), "new physical directory");
});

test("more than three excess backups converge in bounded pages without a false cached five", async t => {
  const f = await fixture(t, { copies: 9 });
  const { owner, service } = await f.make();
  await service.runOnce();
  const remaining = await f.count();
  assert.ok(remaining > 5 && remaining >= 6, "one scheduler pass has at most three candidate effects");
  assert.equal(owner.status().knownBackups, remaining);
  assert.equal(owner.status().limitMet, false);
  for (let i = 0; i < 6 && await f.count() > 5; i++) await service.runOnce();
  assert.equal(await f.count(), 5);
  assert.equal(owner.status().limitMet, true);
});

test("extra files or empty directories and reparse backups are retained without traversal or false cap success", async t => {
  const f = await fixture(t, { states: ["unknown", "unknown", "unknown", "unknown", "unknown"] });
  // Only the newest is eligible by status, but every old root is protected.
  const foreign = path.join(f.backups[5], "extra-empty-directory"); await mkdir(foreign);
  const { owner, service } = await f.make();
  await service.runOnce();
  assert.equal(await f.count(), 6); assert.equal(owner.status().limitMet, false);
  assert.ok((await lstat(foreign)).isDirectory());
  await rm(foreign, { recursive: true });
  const outside = path.join(f.base, "foreign"); await mkdir(outside); await writeFile(path.join(outside, "keep"), "foreign");
  await rename(f.backups[5], f.backups[5] + "-saved");
  await symlink(outside, f.backups[5], process.platform === "win32" ? "junction" : "dir");
  const again = await f.make(); await again.service.runOnce();
  assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "foreign");
  assert.equal(again.owner.status().limitMet, false);
});

test("lost native deletion reply reconciles absence under SAME child and never reissues the admitted entry", async t => {
  const f = await fixture(t); let once = true, first, calls = 0;
  const { owner, service } = await f.make({ deleteEntry: async (...args) => {
    calls++; if (!first) first = args[0];
    await deleteVerifiedWindowsEntry(...args);
    if (once) { once = false; throw new Error("lost native reply after effect"); }
  } });
  await service.runOnce();
  const child = f.store.latestStorageArtifactReadonly(owner.id, "update-0");
  assert.equal(child.status, "reconciling"); assert.equal(calls, 1);
  await assert.rejects(lstat(first), { code: "ENOENT" });
  await service.runOnce();
  const settled = f.store.getReadonly(child.operationId);
  assert.equal(settled.status, "succeeded");
  assert.equal(await f.count(), 5);
  assert.equal(settled.operationId, child.operationId);
});

test("failed delete with existing entry stays UNKNOWN and is not blindly retried", async t => {
  const f = await fixture(t); let calls = 0;
  const { owner, service } = await f.make({ deleteEntry: async () => { calls++; throw new Error("failure before native receipt"); } });
  await service.runOnce(); await service.runOnce();
  assert.equal(calls, 1); assert.equal(await f.count(), 6);
  assert.equal(owner.status().limitMet, false);
  assert.equal(f.store.latestStorageArtifactReadonly(owner.id, "update-0").status, "reconciling");
});

test("ancestor replacement with a junction preserves foreign bytes before the native deletion port", async t => {
  const f = await fixture(t); let switched = false, calls = 0;
  const outside = path.join(f.base, "outside"); await mkdir(outside);
  await writeFile(path.join(outside, "runtime.sqlite"), "foreign bytes");
  const { owner, service } = await f.make({
    beforeDelete: async target => {
      if (!switched && target.relative.startsWith(`data${path.sep}`)) {
        switched = true;
        const parent = path.dirname(target.file);
        await rename(parent, parent + "-saved");
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
      }
    }, deleteEntry: async (...args) => { calls++; await deleteVerifiedWindowsEntry(...args); } });
  await service.runOnce();
  assert.equal(switched, true);
  assert.equal(await readFile(path.join(outside, "runtime.sqlite"), "utf8"), "foreign bytes");
  assert.equal(owner.status().limitMet, false);
  const before = calls; await service.runOnce(); assert.equal(calls, before);
});
