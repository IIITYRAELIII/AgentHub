import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const context = new AsyncLocalStorage();
const MAX_DETAIL_SPANS = 512;
// Fixed diagnostic classes only; no argv, paths or caller-provided stage labels.
const AGGREGATE_STAGES = new Set(["git-child", "owned-command", "lease-assert", "process-guard",
  "repository-guards", "release:git-command", "release:git-input", "release:base-evidence",
  "release:integration-evidence", "native:history-authority", "native:task-histories",
  "native:cutover", "native:promotion-authority", "lock-native-bootstrap", "lock-native-publish"]);
const AGGREGATE_COMMANDS = new Set(["rev-parse", "status", "log", "show", "diff", "merge-base", "merge",
  "worktree", "sparse-checkout", "config", "symbolic-ref", "update-ref", "for-each-ref", "cat-file",
  "rev-list", "add", "commit", "reset", "read-tree", "checkout", "ls-files", "merge-abort", "external"]);

function aggregate(state, stage, metadata, durationMs, outcome, suppressed) {
  try {
    if (state.closed) return;
    const group = AGGREGATE_STAGES.has(stage) ? stage : "other";
    const command = ["git-child", "owned-command"].includes(group)
      ? (AGGREGATE_COMMANDS.has(metadata.command) ? metadata.command : "other") : null;
    const key = `${group}:${command ?? ""}`;
    const prior = state.aggregates.get(key) ?? { stage: group, ...(command ? { command } : {}),
      count: 0, errorCount: 0, suppressedCount: 0, inclusiveMs: 0, maxMs: 0 };
    prior.count += 1;
    prior.errorCount += Number(outcome === "error");
    prior.suppressedCount += Number(suppressed);
    prior.inclusiveMs += durationMs;
    prior.maxMs = Math.max(prior.maxMs, durationMs);
    state.aggregates.set(key, prior);
  } catch { /* Diagnostic aggregation cannot change an operation outcome. */ }
}
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
  const suppressed = detail && state.details++ >= MAX_DETAIL_SPANS;
  if (suppressed) state.suppressed += 1;
  const spanId = suppressed ? null : ++state.sequence;
  const started = performance.now();
  if (!suppressed) emit(state, { stage, spanId, phase: "start", ...metadata });
  let outcome = "ok";
  try { return await operation(); }
  catch (error) { outcome = "error"; throw error; }
  finally {
    const durationMs = Math.max(0, performance.now() - started);
    aggregate(state, stage, metadata, durationMs, outcome, suppressed);
    if (!suppressed) emit(state, { stage, spanId, phase: "end", outcome, durationMs, ...metadata });
  }
}

export function recordTaskOperationTiming(stage, metadata = {}) {
  emit(context.getStore(), { stage, phase: "checkpoint", ...metadata });
}

export function withTaskOperationTiming({ operationId, taskId, record }, operation) {
  if (!operationId || typeof record !== "function") return operation();
  const state = { operationId: String(operationId).slice(0, 512), taskId: String(taskId ?? "").slice(0, 160),
    traceId: ++nextTraceId,
    record, sequence: 0, details: 0, suppressed: 0, closed: false, aggregates: new Map(),
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
        eventLoopDelayP99Ms: loopDelay.percentile(99) / 1_000_000,
        aggregateSemantics: "inclusive-nested-not-additive",
        stageAggregates: [...state.aggregates.values()].map(group => ({ ...group })) });
      state.closed = true;
    }
  });
}
