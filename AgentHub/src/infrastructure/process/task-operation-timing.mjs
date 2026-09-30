import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();
const MAX_DETAIL_SPANS = 512;

function emit(state, event) {
  if (!state || state.closed) return;
  try {
    const result = state.record({ component: "task-operation-timing", operationId: state.operationId,
      taskId: state.taskId, at: new Date().toISOString(), ...event });
    result?.catch?.(() => {});
  } catch { /* Diagnostics never change the operation outcome. */ }
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
    record, sequence: 0, details: 0, suppressed: 0, closed: false };
  return context.run(state, async () => {
    try { return await measureTaskOperation("workflow", operation); }
    finally {
      emit(state, { stage: "trace-summary", phase: "end", suppressedDetailSpans: state.suppressed });
      state.closed = true;
    }
  });
}
