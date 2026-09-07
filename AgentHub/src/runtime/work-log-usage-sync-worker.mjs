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
  const [syncedUsageFacts, turns] = await Promise.all([
    store.facts(),
    store.journalTurns({ projectRoots: payload.projectRoots }),
  ]);
  const updatedHtml = projectWorkLogAccountUsage(payload.html, turns, {
    accountCatalog: payload.accountCatalog,
    includeClaudeUsage: payload.includeClaudeUsage,
    syncedUsageEvents: syncedUsageFacts,
    localDeviceId: payload.localDeviceId,
    localDeviceLabel: payload.localDeviceLabel,
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
    eventCount: syncedUsageFacts.length,
    durationMs: performance.now() - startedAt,
  };
}

async function usageSyncSnapshot(payload = {}) {
  const startedAt = performance.now();
  const snapshot = await store.usageSyncSnapshot(payload);
  return { ...snapshot, durationMs: performance.now() - startedAt, workerThreadId: threadId };
}

async function handle(message) {
  switch (message.type) {
    case "events": return store.events();
    case "facts": return store.facts();
    case "import-snapshot": return store.importSnapshot(message.payload.snapshot);
    case "reconcile-snapshot": return store.reconcileSnapshot(message.payload.snapshot);
    case "replace-events": return store.replaceEvents(message.payload.events);
    case "adopt-device-ids": return store.adoptDeviceIds(message.payload.deviceIds);
    case "project-account-usage": return projectAccountUsage(message.payload);
    case "usage-sync-snapshot": return usageSyncSnapshot(message.payload);
    case "usage-sync-state": return store.usageSyncState();
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
