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


test("automatic worker sampling retains a bounded join while native statistics stay pending", async () => {
  const { observeRuntimeWorkerMemory } = await import("../../src/application/runtime-worker-memory.mjs");
  let finish, calls = 0;
  const held = new Promise(resolve => { finish = resolve; });
  const worker = fakeWorker(701, () => { calls += 1; return held; });
  observeRuntimeWorkerMemory("rollout", worker);
  const sampler = createRuntimePerformanceSampler({
    instanceId: "held-worker-fixture", trace: { recordBestEffort() {} },
    readHealth: () => ({ diagnostics: {} }), cpuSample: { start() {}, stop() {} },
  });
  const originalAllSettled = Promise.allSettled;
  const originalThen = Promise.prototype.then;
  let operation, joins = 0;
  Promise.allSettled = function (iterable) {
    const inputs = Array.from(iterable);
    if (!operation && inputs.length === 1) operation = inputs[0];
    return Reflect.apply(originalAllSettled, this, [inputs]);
  };
  Promise.prototype.then = function (...args) {
    if (this === operation) joins += 1;
    return Reflect.apply(originalThen, this, args);
  };
  let firstJoins, repeatedJoins;
  try {
    sampler.sample(); await Promise.resolve();
    firstJoins = joins;
    for (let index = 0; index < 32; index += 1) sampler.sample();
    await Promise.resolve();
    repeatedJoins = joins;
  } finally {
    Promise.allSettled = originalAllSettled;
    Promise.prototype.then = originalThen;
    finish(values);
    await sampleRuntimeWorkerMemory();
    worker.emit("exit", 0);
    await sampler.stop();
  }
  assert.equal(calls, 1, "native observation itself remains single-flight");
  assert.ok(firstJoins > 0, "instrumentation observed the real aggregate join");
  assert.equal(repeatedJoins, firstJoins,
    "pending automatic samples must not attach another retained join on every tick");
});

test("automatic worker sampling admits fresh workers while explicit sampling awaits held work", async () => {
  const observer = createRuntimeWorkerMemoryObserver();
  let finish, heldCalls = 0, freshCalls = 0;
  const held = fakeWorker(702, () => { heldCalls += 1; return new Promise(resolve => { finish = resolve; }); });
  const fresh = fakeWorker(703, () => { freshCalls += 1; return values; });
  observer.register("rollout", held);
  const scheduled = observer.schedule();
  await Promise.resolve();
  let explicitFinished = false;
  const explicit = observer.sample().then(() => { explicitFinished = true; });
  try {
    for (let index = 0; index < 32; index += 1) assert.equal(observer.schedule(), null);
    observer.register("usageSync", fresh);
    const freshOnly = observer.schedule();
    assert.ok(freshOnly instanceof Promise);
    await freshOnly;
    assert.equal(explicitFinished, false, "explicit await still includes existing held work");
    assert.equal(heldCalls, 1);
    assert.equal(freshCalls, 1);
    assert.equal(observer.snapshot().rollout.pendingSamples, 1);
    assert.equal(observer.snapshot().usageSync.usedHeapBytes, values.used_heap_size);
    fresh.emit("exit", 0);
    assert.equal(observer.schedule(), null);
  } finally {
    finish(values);
    await Promise.all([scheduled, explicit]);
    held.emit("exit", 0);
    fresh.emit("exit", 0);
  }
  assert.equal(explicitFinished, true);
  assert.equal(observer.snapshot().rollout.activeWorkers, 0);
});

test("automatic worker sampling preserves unknown failures and ignores exited generations", async () => {
  const observer = createRuntimeWorkerMemoryObserver();
  let finish;
  const old = fakeWorker(704, () => new Promise(resolve => { finish = resolve; }));
  observer.register("runtimeState", old);
  const scheduled = observer.schedule();
  await Promise.resolve();
  old.emit("exit", 0);
  const replacement = fakeWorker(704, () => { throw new Error("SECRET"); });
  observer.register("runtimeState", replacement);
  try {
    await observer.schedule();
    finish(values);
    await scheduled;
    const view = observer.snapshot().runtimeState;
    assert.equal(view.workers[0].generation, 2);
    assert.equal(view.failedSamples, 1);
    assert.equal(view.usedHeapBytes, null);
    assert.equal(view.pendingSamples, 0);
    assert.equal(view.workers[0].state, "unavailable");
    assert.doesNotMatch(JSON.stringify(view), /SECRET/);
  } finally {
    finish(values);
    await scheduled;
    replacement.emit("exit", 0);
  }
});
