import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CommandTraceService } from "../application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../infrastructure/persistence/command-trace-worker-store.mjs";
import { createRuntimePerformanceSampler } from "../application/runtime-performance-sampler.mjs";

// Configuration and infrastructure precede the trace worker. Capture their real
// duration now, then submit to that same worker once infrastructure is available.
// A failure before the worker exists still belongs to the ordinary startup log.
export async function measureStartupBeforeTrace(stage, operation, {
  clock = Date.now, monotonicClock = () => performance.now(), logger = console,
} = {}) {
  const operationSpanId = randomUUID();
  const startedAtMs = clock();
  const startedMonotonicMs = monotonicClock();
  const checkpoint = (outcome, error = null) => {
    try {
      logger.info("[startup]", JSON.stringify({
        pid: process.pid, releaseId: process.env.AGENT_HUB_RELEASE_ID ?? "",
        operationSpanId, stage, outcome,
        durationMs: Math.max(0, monotonicClock() - startedMonotonicMs),
        ...(error ? { error: String(error.message ?? error) } : {}),
      }));
    } catch {}
  };
  checkpoint("started");
  let value;
  try {
    value = await operation();
  } catch (error) {
    checkpoint("failed", error);
    throw error;
  }
  checkpoint("succeeded");
  const observedAtMs = clock();
  const monotonicDurationMs = Math.max(0, monotonicClock() - startedMonotonicMs);
  const common = { commandId: `startup:${operationSpanId}`, stage: `startup-${stage}`, transport: "server-runtime",
    metadata: { operationSpanId, startedAtMs, operationId: stage, bufferedUntilTraceReady: true } };
  let recorded = false;
  return { value, record(trace) {
    if (recorded) return;
    recorded = true;
    trace.recordBestEffort({ ...common, outcome: "started", observedAtMs: startedAtMs });
    trace.recordBestEffort({ ...common, spanId: operationSpanId, outcome: "succeeded", observedAtMs, monotonicDurationMs });
  } };
}

export function createCommandTraceComposition({
  dataDir,
  instanceId,
  releaseId,
  readHealth,
  databaseFile = dataDir ? path.join(dataDir, "command-traces.sqlite") : null,
  retentionMs,
  maxSpans,
  clock = Date.now,
  monotonicClock,
  createSpanId,
  maxPendingWrites,
  maxPendingRequests,
  restartDelayMs,
  closeTimeoutMs,
  workerUrl,
  workerData,
  logger = console,
} = {}) {
  if (!databaseFile) throw new TypeError("dataDir or databaseFile is required");
  const store = new CommandTraceWorkerStore({
    databaseFile,
    retentionMs,
    maxSpans,
    ...(clock === Date.now ? {} : { fixedClockMs: clock() }),
    ...(maxPendingWrites ? { maxPendingWrites } : {}),
    ...(maxPendingRequests ? { maxPendingRequests } : {}),
    ...(restartDelayMs ? { restartDelayMs } : {}),
    ...(closeTimeoutMs ? { closeTimeoutMs } : {}),
    ...(workerUrl ? { workerUrl } : {}),
    ...(workerData ? { workerData } : {}),
    logger,
  });
  const service = new CommandTraceService({
    store,
    metadata: { instanceId, releaseId },
    clock,
    ...(monotonicClock ? { monotonicClock } : {}),
    ...(createSpanId ? { createSpanId } : {}),
    logger,
  });
  const sampler = readHealth && instanceId
    ? createRuntimePerformanceSampler({ trace: service, readHealth, instanceId }) : null;
  return Object.freeze({
    store,
    service,
    initialize: async () => {
      sampler?.start();
      try {
        return await store.initialize();
      } catch (error) {
        try {
          logger?.warn?.(`Command trace worker initialization deferred: ${error?.message ?? error}`);
        } catch {}
        return { ready: false, deferred: true };
      }
    },
    close: async () => {
      try { await sampler?.stop(); } catch { /* Diagnostic failure cannot skip trace-worker shutdown. */ }
      return store.close();
    },
  });
}
