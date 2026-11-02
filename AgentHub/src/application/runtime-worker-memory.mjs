// Numeric observations of already-owned workers. This module never creates,
// refs, stops or messages a business worker, and owns no admission authority.
export const RUNTIME_WORKER_MEMORY_OWNERS = Object.freeze(["usageSync", "runtimeState", "commandTrace", "rollout",
  "journalPublication", "historicalBackfill", "claudeTranscript"]);
const OWNERS = new Set(RUNTIME_WORKER_MEMORY_OWNERS);
export const RUNTIME_WORKER_MEMORY_METRICS = Object.freeze(["activeWorkers", "trackedWorkers", "sampledWorkers",
  "pendingSamples", "unobservedWorkers", "failedSamples", "usedHeapBytes", "totalHeapBytes", "externalBytes",
  "physicalHeapBytes", "oldestSampleAtMs", "newestSampleAtMs"]);
const MAX_TRACKED_PER_OWNER = 16;
const fields = { used_heap_size: "usedHeapBytes", total_heap_size: "totalHeapBytes",
  external_memory: "externalBytes", total_physical_size: "physicalHeapBytes" };

export function createRuntimeWorkerMemoryObserver({ clock = Date.now } = {}) {
  const pools = new Map();
  function register(owner, worker) {
    if (!OWNERS.has(owner) || !worker || typeof worker.once !== "function") return false;
    let pool = pools.get(owner);
    if (!pool) {
      pool = { activeWorkers: 0, sequence: 0, failedSamples: 0, records: new Map() };
      pools.set(owner, pool);
    }
    for (const record of pool.records.values()) if (record.ref.deref() === worker) return false;
    const sequence = ++pool.sequence;
    const record = { ref: new WeakRef(worker), threadId: worker.threadId, generation: sequence,
      pending: null, sample: null, state: "unmeasured" };
    if (pool.records.size < MAX_TRACKED_PER_OWNER) pool.records.set(sequence, record);
    pool.activeWorkers += 1;
    let exited = false;
    worker.once("exit", () => {
      if (exited) return;
      exited = true;
      pool.activeWorkers -= 1;
      pool.records.delete(sequence);
    });
    return true;
  }

  function sample() {
    const pending = [];
    for (const pool of pools.values()) for (const [sequence, record] of pool.records) {
      if (record.pending) { pending.push(record.pending); continue; }
      const worker = record.ref.deref();
      if (!worker || typeof worker.getHeapStatistics !== "function") {
        record.state = "unavailable";
        record.sample = null;
        continue;
      }
      const requestedAtMs = clock();
      record.state = "pending";
      const operation = Promise.resolve().then(() => worker.getHeapStatistics()).then((value) => {
        if (pool.records.get(sequence) !== record) return;
        const observation = { requestedAtMs, completedAtMs: clock() };
        for (const [source, target] of Object.entries(fields)) {
          const number = value?.[source];
          observation[target] = typeof number === "number" && Number.isFinite(number) && number >= 0
            ? number : null;
        }
        record.sample = observation;
        record.state = "observed";
      }).catch(() => {
        if (pool.records.get(sequence) !== record) return;
        pool.failedSamples += 1;
        record.sample = null;
        record.state = "unavailable";
      }).finally(() => { if (record.pending === operation) record.pending = null; });
      record.pending = operation;
      pending.push(operation);
    }
    return Promise.allSettled(pending);
  }

  function snapshot() {
    const result = {};
    for (const [owner, pool] of pools) {
      const records = [...pool.records.values()];
      const samples = records.map(record => record.sample).filter(Boolean);
      const sum = key => samples.length ? samples.reduce((total, value) =>
        total === null || value[key] === null ? null : total + value[key], 0) : null;
      result[owner] = {
        activeWorkers: pool.activeWorkers, trackedWorkers: records.length,
        sampledWorkers: samples.length, pendingSamples: records.filter(record => record.pending).length,
        unobservedWorkers: pool.activeWorkers - samples.length, failedSamples: pool.failedSamples,
        usedHeapBytes: sum("usedHeapBytes"), totalHeapBytes: sum("totalHeapBytes"),
        externalBytes: sum("externalBytes"), physicalHeapBytes: sum("physicalHeapBytes"),
        oldestSampleAtMs: samples.length ? Math.min(...samples.map(value => value.completedAtMs)) : null,
        newestSampleAtMs: samples.length ? Math.max(...samples.map(value => value.completedAtMs)) : null,
        workers: records.map(record => ({ threadId: Number.isSafeInteger(record.threadId) ? record.threadId : null,
          generation: record.generation, state: record.state, ...(record.sample ?? {}) })),
      };
    }
    return result;
  }
  return { register, sample, snapshot };
}

const observer = createRuntimeWorkerMemoryObserver();
export function observeRuntimeWorkerMemory(owner, worker) {
  try { return observer.register(owner, worker); } catch { return false; }
}
export const sampleRuntimeWorkerMemory = () => observer.sample();
export const runtimeWorkerMemorySnapshot = () => observer.snapshot();
