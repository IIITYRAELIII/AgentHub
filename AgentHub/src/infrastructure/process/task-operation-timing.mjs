import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const context = new AsyncLocalStorage();
const MAX_DETAIL_SPANS = 512;
let nextTraceId = 0;

function emit(state, event) {
  if (!state || state.closed) return;
  const started = performance.now();
  try {
    const result = state.record({ component: "task-operation-timing", operationId: state.operationId,
      traceId: state.traceId,
      taskId: state.taskId, at: new Date().toISOString(), ...event });
    result?.catch?.(() => {});
  } catch { /* Diagnostics never change the operation outcome. */ }
  finally {
    const durationMs = Math.max(0, performance.now() - started);
    state.synchronousRecordMs += durationMs;
    state.maxSynchronousRecordMs = Math.max(state.maxSynchronousRecordMs, durationMs);
  }
}

export function createTaskOperationTimingBatchRecorder(writeBatch, { maxEvents = 16, maxDelayMs = 250 } = {}) {
  if (typeof writeBatch !== "function" || !Number.isSafeInteger(maxEvents) || maxEvents < 1
    || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < 1) {
    throw new TypeError("Task timing batch recorder requires a writer and positive bounds");
  }
  const pending = new Map();
  const sinkCosts = new Map();
  const flush = (key) => {
    const batch = pending.get(key);
    if (!batch) return null;
    pending.delete(key);
    clearTimeout(batch.timer);
    const started = performance.now();
    let elapsedMs = 0;
    try { writeBatch(batch.events); }
    finally {
      elapsedMs = Math.max(0, performance.now() - started);
      const cost = sinkCosts.get(key) ?? { totalMs: 0, maxMs: 0, writes: 0 };
      cost.totalMs += elapsedMs;
      cost.maxMs = Math.max(cost.maxMs, elapsedMs);
      cost.writes += 1;
      if (batch.events.some(event => event.stage === "trace-summary")) sinkCosts.delete(key);
      else {
        sinkCosts.set(key, cost);
        if (sinkCosts.size > 512) sinkCosts.delete(sinkCosts.keys().next().value);
      }
    }
    return elapsedMs;
  };
  return (event) => {
    const key = event.traceId ?? event.operationId;
    let batch = pending.get(key);
    if (!batch) {
      const timer = setTimeout(() => {
        try { flush(key); } catch { /* Diagnostics never change the operation outcome. */ }
      }, maxDelayMs);
      timer.unref?.();
      batch = { events: [], timer };
      pending.set(key, batch);
    }
    if (event.stage === "trace-summary") {
      const cost = sinkCosts.get(key) ?? { totalMs: 0, maxMs: 0, writes: 0 };
      event.batchWriteMs = cost.totalMs;
      event.maxBatchWriteMs = cost.maxMs;
      event.batchWrites = cost.writes;
    }
    batch.events.push(event);
    if (batch.events.length >= maxEvents || event.stage === "trace-summary"
      || (event.stage === "workflow" && event.phase === "start")) {
      const priorTotalMs = sinkCosts.get(key)?.totalMs ?? 0;
      const priorWrites = sinkCosts.get(key)?.writes ?? 0;
      const finalBatch = event.stage === "trace-summary";
      const finalBatchWriteMs = flush(key);
      if (finalBatch && finalBatchWriteMs != null) {
        // This second, bounded diagnostic write reports the cost of the final
        // summary batch. Its own latency is the one explicitly unmeasured tail.
        writeBatch([{ component: event.component, operationId: event.operationId,
          traceId: event.traceId, taskId: event.taskId, at: new Date().toISOString(),
          stage: "timing-sink-final", phase: "checkpoint", finalBatchWriteMs,
          totalBatchWriteMs: priorTotalMs + finalBatchWriteMs,
          batchWrites: priorWrites + 1, unmeasuredTailWrites: 1 }]);
      }
    }
  };
}

export async function measureTaskOperationAwait(stage, operation, { reportAtMs = 50 } = {}) {
  const state = context.getStore();
  if (!state || state.closed) return operation();
  const started = performance.now();
  let outcome = "ok";
  try { return await operation(); }
  catch (error) { outcome = "error"; throw error; }
  finally {
    const durationMs = Math.max(0, performance.now() - started);
    if (durationMs >= reportAtMs) recordTaskOperationTiming(stage, { durationMs, outcome });
  }
}

export async function measureTaskOperation(stage, operation, { detail = false, ...metadata } = {}) {
  const state = context.getStore();
  if (!state) return operation();
  if (detail && state.details++ >= MAX_DETAIL_SPANS) {
    state.suppressed += 1;
    return operation();
  }
  const spanId = ++state.sequence;
  const started = performance.now();
  emit(state, { stage, spanId, phase: "start", ...metadata });
  let outcome = "ok";
  try { return await operation(); }
  catch (error) { outcome = "error"; throw error; }
  finally {
    emit(state, { stage, spanId, phase: "end", outcome,
      durationMs: Math.max(0, performance.now() - started), ...metadata });
  }
}

export function recordTaskOperationTiming(stage, metadata = {}) {
  emit(context.getStore(), { stage, phase: "checkpoint", ...metadata });
}

export function withTaskOperationTiming({ operationId, taskId, record }, operation) {
  if (!operationId || typeof record !== "function") return operation();
  const state = { operationId: String(operationId).slice(0, 512), taskId: String(taskId ?? "").slice(0, 160),
    traceId: ++nextTraceId,
    record, sequence: 0, details: 0, suppressed: 0, closed: false,
    synchronousRecordMs: 0, maxSynchronousRecordMs: 0 };
  return context.run(state, async () => {
    const loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
    try { return await measureTaskOperation("workflow", operation); }
    finally {
      loopDelay.disable();
      emit(state, { stage: "trace-summary", phase: "end", suppressedDetailSpans: state.suppressed,
        synchronousRecordMs: state.synchronousRecordMs,
        maxSynchronousRecordMs: state.maxSynchronousRecordMs,
        eventLoopDelayMaxMs: loopDelay.max / 1_000_000,
        eventLoopDelayP99Ms: loopDelay.percentile(99) / 1_000_000 });
      state.closed = true;
    }
  });
}
