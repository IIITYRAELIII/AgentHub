import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileTransferService } from "../../src/infrastructure/filesystem/file-transfer-service.mjs";
import { FileTransferStore } from "../../src/infrastructure/persistence/file-transfer-store.mjs";
import { fileTransferPolicy } from "../../src/domain/file-transfer.mjs";
import { createRuntimeRestartComposition } from "../../src/composition/runtime-restart-composition.mjs";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("actual restart resources drain transfer work before releasing ownership and recover the same open store", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-restart-drain-"));
  const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test", freeBytes: 0 });
  const store = new FileTransferStore({ dataDir: root, policy });
  const entered = deferred(), release = deferred();
  const candidates = store.gcCandidates.bind(store), close = store.close.bind(store);
  let calls = 0, closes = 0, released = false;
  store.gcCandidates = async () => {
    calls++; entered.resolve(); await release.promise; return candidates();
  };
  store.close = async () => { closes++; await close(); };
  const service = new FileTransferService({ dataDir: root, roots: [root], store, policy,
    keyring: { currentKid: "fixture", keys: { fixture: Buffer.alloc(32, 7) } } });
  t.after(async () => { release.resolve(); await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.initialize();
  service.startOperationalGc(); await entered.promise;
  const { runtimeResources } = createRuntimeRestartComposition({
    fileTransferService: service, instanceGuard: { release: () => { released = true; } },
    stopCodexAppServerTree: async () => {},
    getRestartRequest: () => null, updateOffset: () => 0, hasBlockingWork: () => false,
    setWaiting: async () => {}, updateRestartMessage: async () => {}, saveState: async () => {},
    beginStopping: () => true, stopRuntimeTimers: () => {},
  });
  let quiesced = false;
  const quiesce = runtimeResources.quiesce().then(() => { quiesced = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quiesced, false, "the original transfer GC still owns unfinished filesystem work");
  assert.equal(released, false);
  await assert.rejects(service.gc(), /transfer-service-quiescing/u);
  await assert.rejects(service.prepare({}), /transfer-service-quiescing/u);
  assert.equal(closes, 0);
  release.resolve(); await quiesce;
  assert.deepEqual(await candidates(), [], "SQLite remains available for recovery");
  await runtimeResources.releaseLock(); assert.equal(released, true);
  await runtimeResources.recover();
  await new Promise(resolve => setImmediate(resolve));
  const resumedCalls = calls;
  assert.ok(resumedCalls > 1, "the original operational GC resumes");
  await runtimeResources.recover();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, resumedCalls, "repeated recovery does not add another timer or GC");
  const sourcePath = path.join(root, "after-recovery.bin"); await writeFile(sourcePath, "preserved store");
  const artifact = await service.prepare({ owner: "local", sourcePath, requestId: "after-recovery" });
  await service.waitForPreparation(artifact.id);
  assert.equal(closes, 0);
  await service.close(); assert.equal(closes, 1);
});

for (const mode of ["manual", "timer", "overlap-error"]) {
  test(`shutdown drains ${mode} GC before closing SQLite and fences new work`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "transfer-shutdown-"));
    const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test", freeBytes: 0 });
    const store = new FileTransferStore({ dataDir: root, policy });
    const events = [], entered = deferred(), release = deferred();
    const candidates = store.gcCandidates.bind(store), deleted = store.gcDeleted.bind(store), close = store.close.bind(store);
    let calls = 0;
    store.gcCandidates = async () => {
      const ordinal = ++calls;
      const result = await candidates(); entered.resolve(); await release.promise;
      if (mode === "overlap-error" && ordinal > 1) throw new Error("synthetic GC failure");
      return result;
    };
    store.gcDeleted = async id => { await deleted(id); events.push("deleted"); };
    store.close = async () => { await close(); events.push("closed"); };
    const service = new FileTransferService({ dataDir: root, roots: [root], store, policy,
      keyring: { currentKid: "fixture", keys: { fixture: Buffer.alloc(32, 7) } } });
    t.after(async () => { release.resolve(); await service.close(); await rm(root, { recursive: true, force: true }); });
    await service.initialize();
    const artifact = await store.reserve({ owner: "local", sourceKey: "synthetic", requestId: "synthetic",
      name: "synthetic.bin", size: 1, availableBytes: 1e9 });
    await store.failPreparation("local", artifact.id);
    const directory = path.join(root, "file-transfers", "artifacts");
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, `${artifact.id}.partial`), Buffer.from([42]));
    let work;
    if (mode === "timer") service.startOperationalGc();
    else work = service.gc();
    await entered.promise;
    let second;
    if (mode === "overlap-error") {
      second = assert.rejects(service.gc(), /synthetic GC failure/u);
      // Both calls are already admitted synchronously, independent of dequeue.
    }
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    assert.equal(service.close(), service.close(), "close shares one settlement");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    await assert.rejects(service.gc(), /transfer-service-closed/u);
    await assert.rejects(service.prepare({}), /transfer-service-closed/u);
    await assert.rejects(service.initialize(), /transfer-service-closed/u);
    service.startOperationalGc();
    release.resolve(); await work; await second; await closing;
    assert.equal(events.at(-1), "closed"); assert.equal(events.filter(x => x === "closed").length, 1);
    if (mode !== "overlap-error") assert.ok(events.includes("deleted"));
    const count = calls;
    await assert.rejects(service.gc(), /transfer-service-closed/u);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, count);
  });
}
