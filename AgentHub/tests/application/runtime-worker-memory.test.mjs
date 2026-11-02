import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRuntimeWorkerMemoryObserver, sampleRuntimeWorkerMemory, runtimeWorkerMemorySnapshot } from "../../src/application/runtime-worker-memory.mjs";
import { createRuntimePerformanceSampler } from "../../src/application/runtime-performance-sampler.mjs";
import { createCommandTraceComposition } from "../../src/composition/command-trace-composition.mjs";

function fakeWorker(threadId, read) {
  const worker = new EventEmitter();
  worker.threadId = threadId;
  worker.getHeapStatistics = read;
  for (const name of ["ref", "unref", "terminate", "postMessage"]) {
    worker[name] = () => { throw new Error(`diagnostics must not call ${name}`); };
  }
  return worker;
}
const values = { used_heap_size: 101, total_heap_size: 203, external_memory: 17, total_physical_size: 181 };

test("worker memory observations are single-flight, numeric and unknown until measured", async () => {
  let finish, calls = 0, now = 10;
  const read = new Promise(resolve => { finish = resolve; });
  const worker = fakeWorker(7, () => { calls += 1; return read; });
  worker.privatePayload = "SECRET";
  const observer = createRuntimeWorkerMemoryObserver({ clock: () => now });
  assert.equal(observer.register("private-owner-SECRET", worker), false);
  assert.equal(observer.register("usageSync", worker), true);
  assert.equal(observer.register("usageSync", worker), false);
  assert.equal(observer.snapshot().usageSync.usedHeapBytes, null);
  const first = observer.sample(), second = observer.sample();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(observer.snapshot().usageSync.pendingSamples, 1);
  now = 20; finish({ ...values, private: "SECRET" });
  await Promise.all([first, second]);
  const snapshot = observer.snapshot();
  assert.equal(snapshot.usageSync.usedHeapBytes, 101);
  assert.equal(snapshot.usageSync.totalHeapBytes, 203);
  assert.equal(snapshot.usageSync.externalBytes, 17);
  assert.equal(snapshot.usageSync.workers[0].requestedAtMs, 10);
  assert.equal(snapshot.usageSync.workers[0].completedAtMs, 20);
  assert.equal(snapshot.usageSync.workers[0].generation, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|privatePayload/);
  snapshot.usageSync.workers[0].usedHeapBytes = 999;
  assert.equal(observer.snapshot().usageSync.usedHeapBytes, 101);
  worker.emit("exit", 0);
  assert.equal(observer.snapshot().usageSync.activeWorkers, 0);
  assert.equal(observer.snapshot().usageSync.usedHeapBytes, null);
});

test("worker memory failures and missing native fields remain explicitly unknown", async () => {
  const observer = createRuntimeWorkerMemoryObserver();
  const worker = fakeWorker(8, () => { throw new Error("private exception SECRET"); });
  observer.register("runtimeState", worker);
  await observer.sample();
  assert.equal(observer.snapshot().runtimeState.failedSamples, 1);
  assert.equal(observer.snapshot().runtimeState.workers[0].state, "unavailable");
  worker.getHeapStatistics = () => ({ used_heap_size: NaN, total_heap_size: 3 });
  await observer.sample();
  assert.equal(observer.snapshot().runtimeState.usedHeapBytes, null);
  assert.equal(observer.snapshot().runtimeState.externalBytes, null);
  assert.equal(observer.snapshot().runtimeState.totalHeapBytes, 3);
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /SECRET|exception/);
  worker.getHeapStatistics = undefined;
  await observer.sample();
  assert.equal(observer.snapshot().runtimeState.sampledWorkers, 0);
  worker.emit("exit", 0);
});

test("worker memory observation bound never restricts actual worker admission or guesses omitted heaps", async () => {
  const observer = createRuntimeWorkerMemoryObserver();
  const workers = Array.from({ length: 18 }, (_, index) => fakeWorker(index + 1, () => values));
  for (const worker of workers) assert.equal(observer.register("historicalBackfill", worker), true);
  await observer.sample();
  const snapshot = observer.snapshot().historicalBackfill;
  assert.equal(snapshot.activeWorkers, 18);
  assert.equal(snapshot.trackedWorkers, 16);
  assert.equal(snapshot.sampledWorkers, 16);
  assert.equal(snapshot.unobservedWorkers, 2);
  assert.equal(snapshot.usedHeapBytes, 16 * 101);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 6000);
  for (const worker of workers) worker.emit("exit", 0);
  assert.equal(observer.snapshot().historicalBackfill.activeWorkers, 0);
  assert.equal(observer.snapshot().historicalBackfill.workers.length, 0);
});

test("late worker statistics cannot become a replacement generation or restore an exited observation", async () => {
  const observer = createRuntimeWorkerMemoryObserver();
  let finish;
  const first = fakeWorker(9, () => new Promise(resolve => { finish = resolve; }));
  observer.register("rollout", first);
  const pending = observer.sample(); await Promise.resolve();
  first.emit("exit", 0);
  const replacement = fakeWorker(9, () => ({ ...values, used_heap_size: 5 }));
  observer.register("rollout", replacement);
  await observer.sample(); finish({ ...values, used_heap_size: 99999 }); await pending;
  const snapshot = observer.snapshot().rollout;
  assert.equal(snapshot.activeWorkers, 1);
  assert.equal(snapshot.usedHeapBytes, 5);
  assert.equal(snapshot.workers[0].generation, 2);
  replacement.emit("exit", 0);
});

test("supported native worker statistics observe an existing benign worker without a debugger or dump", async () => {
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');
    globalThis.held=new Uint8Array(256*1024);parentPort.postMessage('ready');
    parentPort.once('message',()=>parentPort.close());`, { eval: true });
  const exited = once(worker, "exit");
  await once(worker, "message");
  try {
    const observer = createRuntimeWorkerMemoryObserver();
    observer.register("journalPublication", worker);
    await observer.sample();
    const result = observer.snapshot().journalPublication;
    assert.equal(result.sampledWorkers, 1);
    assert.ok(result.usedHeapBytes > 0);
    assert.ok(result.totalHeapBytes >= result.usedHeapBytes);
    assert.ok(result.externalBytes >= 256 * 1024);
    assert.equal("rssBytes" in result, false);
  } finally { worker.postMessage("close-own-fixture"); await exited; }
});

test("existing trace persists bounded worker numeric frames without replacing its original metrics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-worker-memory-"));
  const databaseFile = path.join(root, "trace.sqlite");
  const trace = createCommandTraceComposition({ databaseFile, instanceId: "worker-memory", releaseId: "fixture", logger: { warn() {} } });
  await trace.initialize();
  try {
    const privateView = { activeWorkers: 1, sampledWorkers: 0, usedHeapBytes: null,
      failedSamples: 1, private: 123, workers: [{ path: "SECRET" }] };
    const sampler = createRuntimePerformanceSampler({ trace: trace.service, instanceId: "worker-memory",
      cpuSample: { start() {}, stop() {} },
      readHealth: () => ({ diagnostics: {
        process: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`field${i}`, i])),
        workerMemory: { usageSync: privateView, "SECRET": privateView },
      } }),
    });
    sampler.sample();
    await trace.store.readCommandTimeline("runtime:worker-memory");
    await sampleRuntimeWorkerMemory();
  } finally { await trace.store.close(); }
  try {
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    const rows = database.prepare("SELECT metadata_json FROM command_trace_spans WHERE command_id = ? ORDER BY sequence").all("runtime:worker-memory");
    database.close();
    assert.equal(rows.length, 2);
    const frames = rows.map(row => JSON.parse(row.metadata_json));
    assert.equal(Object.keys(frames[0].metrics).length, 64);
    assert.deepEqual(frames[1].metrics, { "workers.usageSync.activeWorkers": 1,
      "workers.usageSync.sampledWorkers": 0, "workers.usageSync.failedSamples": 1 });
    assert.doesNotMatch(JSON.stringify(frames), /SECRET|private|usedHeapBytes/);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("hub-worker-memory-"));
    await rm(root, { recursive: true, force: true });
  }
});


test("actual existing state, usage and publication owners expose heap observations without changing their results", async () => {
  const { RuntimeStateStore } = await import("../../src/infrastructure/persistence/runtime-state-store.mjs");
  const { WorkLogUsageSyncWorkerStore } = await import("../../src/runtime/work-log-usage-sync-worker-client.mjs");
  const { JournalDatabase } = await import("../../src/infrastructure/persistence/journal-database.mjs");
  const { JournalPublicationWorker } = await import("../../src/interfaces/web/journal-publication.mjs");
  const { gunzipSync } = await import("node:zlib");
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-worker-memory-"));
  const state = new RuntimeStateStore({ dataDir: root });
  const file = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(file);
  const usage = new WorkLogUsageSyncWorkerStore({ databaseFile: file });
  const publication = new JournalPublicationWorker(file);
  try {
    await state.save({ version: 1, chosen: "preserved", pendingInputs: [], queuedInputs: [] });
    assert.equal((await state.load()).value.chosen, "preserved");
    assert.ok(Array.isArray(await usage.events()));
    await journal.replaceProjection({ html: "<p>index</p>", days: { "23.10.2026": "<p>whole day</p>" }, turns: { turn: "<p>whole answer</p>" } });
    const expected = await journal.snapshot();
    const result = await publication.prepare();
    assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(result.chunks))), expected);
    await sampleRuntimeWorkerMemory();
    const observed = runtimeWorkerMemorySnapshot();
    for (const owner of ["runtimeState", "usageSync", "journalPublication"]) {
      assert.equal(observed[owner].activeWorkers, 1);
      assert.equal(observed[owner].sampledWorkers, 1);
      assert.ok(observed[owner].usedHeapBytes > 0);
    }
    assert.equal(await journal.currentRevision(), expected.revision);
  } finally {
    await publication.close(); await usage.close(); await state.close(); await journal.close();
    await sampleRuntimeWorkerMemory();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("hub-worker-memory-"));
    await rm(root, { recursive: true, force: true });
  }
});
