import { parentPort, workerData } from "node:worker_threads";

import { CommandTraceSpanStore } from "./command-trace-span-store.mjs";

const store = new CommandTraceSpanStore({
  databaseFile: workerData.databaseFile,
  ...(workerData.retentionMs ? { retentionMs: workerData.retentionMs } : {}),
  ...(workerData.maxSpans ? { maxSpans: workerData.maxSpans } : {}),
  ...(Number.isSafeInteger(workerData.fixedClockMs)
    ? { clock: () => workerData.fixedClockMs }
    : {}),
});

function serializedError(error) {
  return {
    message: String(error?.message ?? error),
    code: error?.code,
    stack: error?.stack,
  };
}

async function handle(message) {
  switch (message.type) {
    case "initialize": return store.initialize();
    case "append": return store.append(message.payload.span);
    case "append-many": return store.appendMany(message.payload.spans);
    case "append-best-effort": return store.append(message.payload.span);
    case "timeline": return store.readCommandTimeline(message.payload.commandId, message.payload.options);
    case "percentiles": return store.readStagePercentiles(message.payload.query);
    case "prune": return store.prune();
    case "close": return store.close();
    default: throw new Error(`unknown command trace worker request: ${message.type}`);
  }
}

let queue = Promise.resolve();
let cleanupPending = false;
const cleanupIntervalMs = Number.isSafeInteger(workerData.cleanupIntervalMs) && workerData.cleanupIntervalMs > 0
  ? workerData.cleanupIntervalMs : 60_000;
const cleanupTimer = setInterval(() => {
  if (cleanupPending) return;
  cleanupPending = true;
  queue = queue.then(async () => {
    try {
      await store.prune();
    } catch (error) {
      parentPort.postMessage({ maintenanceError: serializedError(error) });
    } finally {
      cleanupPending = false;
    }
  });
}, cleanupIntervalMs);
cleanupTimer.unref();
parentPort.on("message", (message) => {
  if (message.type === "close") clearInterval(cleanupTimer);
  queue = queue.then(async () => {
    try {
      const value = await handle(message);
      parentPort.postMessage({ id: message.id, bestEffort: message.bestEffort === true, value });
      if (message.type === "close") parentPort.close();
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        bestEffort: message.bestEffort === true,
        error: serializedError(error),
      });
      if (message.type === "close") parentPort.close();
    }
  });
});
