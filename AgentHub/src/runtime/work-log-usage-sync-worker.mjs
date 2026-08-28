import crypto from "node:crypto";
import { parentPort, threadId, workerData } from "node:worker_threads";

import { projectWorkLogAccountUsage } from "../application/work-log-usage-projection.mjs";
import { WorkLogUsageSyncStore } from "../infrastructure/persistence/work-log-usage-sync-store.mjs";

const store = new WorkLogUsageSyncStore(workerData);

function serializedError(error) {
  return {
    message: String(error?.message ?? error),
    code: error?.code,
    stack: error?.stack,
  };
}

async function projectAccountUsage(payload = {}) {
  const startedAt = performance.now();
  const syncedUsageEvents = await store.events();
  const updatedHtml = projectWorkLogAccountUsage(payload.html, payload.turns, {
    accountCatalog: payload.accountCatalog,
    includeClaudeUsage: payload.includeClaudeUsage,
    syncedUsageEvents,
    localDeviceId: payload.localDeviceId,
    now: payload.now,
  });
  const unchanged = updatedHtml === String(payload.html ?? "");
  return {
    projected: !unchanged,
    reason: unchanged ? "unchanged" : "updated",
    ...(unchanged ? {} : {
      html: updatedHtml,
      version: `sha256:${crypto.createHash("sha256").update(updatedHtml, "utf8").digest("hex")}`,
    }),
    workerThreadId: threadId,
    eventCount: syncedUsageEvents.length,
    durationMs: performance.now() - startedAt,
  };
}

async function handle(message) {
  switch (message.type) {
    case "events": return store.events();
    case "import-snapshot": return store.importSnapshot(message.payload.snapshot);
    case "replace-events": return store.replaceEvents(message.payload.events);
    case "adopt-device-ids": return store.adoptDeviceIds(message.payload.deviceIds);
    case "project-account-usage": return projectAccountUsage(message.payload);
    case "close": return store.close();
    default: throw new Error(`unknown usage sync worker request: ${message.type}`);
  }
}

let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue.then(async () => {
    try {
      const value = await handle(message);
      parentPort.postMessage({ id: message.id, value });
      if (message.type === "close") parentPort.close();
    } catch (error) {
      parentPort.postMessage({ id: message.id, error: serializedError(error) });
      if (message.type === "close") parentPort.close();
    }
  });
});
