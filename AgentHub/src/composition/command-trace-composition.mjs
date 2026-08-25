import path from "node:path";
import { CommandTraceService } from "../application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../infrastructure/persistence/command-trace-worker-store.mjs";

export function createCommandTraceComposition({
  dataDir,
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
    clock,
    ...(monotonicClock ? { monotonicClock } : {}),
    ...(createSpanId ? { createSpanId } : {}),
    logger,
  });
  return Object.freeze({
    store,
    service,
    initialize: async () => {
      try {
        return await store.initialize();
      } catch (error) {
        try {
          logger?.warn?.(`Command trace worker initialization deferred: ${error?.message ?? error}`);
        } catch {}
        return { ready: false, deferred: true };
      }
    },
    close: () => store.close(),
  });
}
