import crypto from "node:crypto";
import { parentPort, threadId, workerData } from "node:worker_threads";

import {
  normalizePersistedWorkLog,
  normalizeProjectRoot,
  projectWorkLogAccountUsage,
  projectWorkLogUsage,
  sameProjectRoot,
  taskThreadId,
  WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
} from "../application/work-log-usage-projection.mjs";
import { buildLazyJournalPayload } from "../application/journal-projection-data.mjs";
import { JournalDatabase } from "../infrastructure/persistence/journal-database.mjs";
import { AsyncSqliteMutationQueue } from "../infrastructure/persistence/async-sqlite-mutation-queue.mjs";
import { WorkLogUsageSyncStore } from "../infrastructure/persistence/work-log-usage-sync-store.mjs";
import { readTurnMetadataCandidates, synchronizeTurnMetadata } from "./work-log-turn-metadata.mjs";
import { projectUsageHistory } from "./usage-history-projection.mjs";

const store = new WorkLogUsageSyncStore(workerData);
const journal = new JournalDatabase(workerData.databaseFile);
const journalOperations = new AsyncSqliteMutationQueue();
const workspaceRequests = new Map();
const mutationRequests = new Map();

async function synchronizeTaskTitles(payload) {
  const startedAt = performance.now();
  const phases = { metadataReadMs: 0, recordReadMs: 0, normalizeMs: 0, commitMs: 0 };
  const measure = async (name, operation) => {
    const start = performance.now();
    try { return await operation(); }
    finally { phases[name] += performance.now() - start; }
  };
  const titles = new Map((payload.titles ?? []).map((item) => {
    const provider = String(item?.provider ?? "").trim().toLowerCase();
    const threadId = String(item?.threadId ?? "").trim();
    const taskTitle = String(item?.taskTitle ?? "").replace(/\s+/g, " ").trim();
    return provider && threadId && taskTitle
      ? [`${provider}\0${threadId}`, { provider, threadId, taskTitle }] : null;
  }).filter(Boolean));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expectedRevision = await journalOperations.run(() => journal.currentRevision());
    const source = await journal.projectionSource();
    const covered = source && (!source.projectRoots.some(Boolean)
      || source.projectRoots.some((root) => sameProjectRoot(root, payload.projectRoot)));
    let projectionRequired = false;
    const records = [];
    for (const title of titles.values()) {
      const metadataRows = await measure("metadataReadMs", () => journal.taskTitleMetadata(title));
      for (const metadata of metadataRows) {
        if (!sameProjectRoot(metadata.projectRoot, payload.projectRoot)) continue;
        projectionRequired ||= !covered || metadata.changedRevision > source.revision;
        if (metadata.taskTitle === title.taskTitle) continue;
        const record = await measure("recordReadMs", () => journal.getRecord(metadata));
        if (!record) continue;
        const key = `${record.provider}\0${record.threadId}\0${record.turnId}`;
        const normalized = await measure("normalizeMs", () => normalizePersistedWorkLog({ version: 9, turns: { [key]: record } }, {
          defaultProjectRoot: payload.defaultProjectRoot,
        }));
        if (!normalized.ledger.turns[key]) continue;
        records.push({ ...record, taskTitle: title.taskTitle });
      }
    }
    try {
      const result = records.length
        ? await measure("commitMs", () => journalOperations.run(() => journal.upsertRecords(records, { expectedRevision })))
        : { revision: expectedRevision };
      return {
        updated: records.length, revision: result.revision,
        projectionRequired: records.length > 0 || projectionRequired,
        ...phases,
        workerThreadId: threadId, durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      if (error.code !== "JOURNAL_REVISION_CONFLICT" || attempt === 1) throw error;
    }
  }
}

async function projectJournal(payload, id) {
  const startedAt = performance.now();
  const phases = {};
  const measure = async (name, operation) => {
    const start = performance.now();
    try { return await operation(); }
    finally { phases[name] = performance.now() - start; }
  };
  const observedRevision = await measure("revisionReadMs", () => journalOperations.run(() => journal.currentRevision()));
  const expectedRevision = payload.expectedRevision ?? observedRevision;
  const current = await measure("projectionReadMs", () => journal.payload());
  const persisted = await measure("ledgerReadMs", () => journal.loadLedger());
  const normalized = await measure("normalizeMs", () => normalizePersistedWorkLog(persisted, {
    defaultProjectRoot: payload.defaultProjectRoot,
  }));
  const invalidRecordReasonCounts = {};
  for (const invalid of normalized.invalidRecords) {
    const reason = invalid.error === "inherited parent turn was copied into a subagent rollout"
      ? "inherited-parent-turn"
      : invalid.error === "work-log id must be a UUID" ? "invalid-work-log-id" : "normalization-error";
    invalidRecordReasonCounts[reason] = (invalidRecordReasonCounts[reason] ?? 0) + 1;
  }
  const roots = (payload.projectRoots ?? []).map((root) => normalizeProjectRoot(root));
  const turns = Object.fromEntries(Object.entries(normalized.ledger.turns).filter(([, record]) => (
    !roots.some(Boolean) || roots.some((root) => sameProjectRoot(record.projectRoot, root))
  )));
  const bindings = new Map();
  const bindingKey = (reference) => `${reference.provider}\0${reference.threadId}`;
  const workspaceStartedAt = performance.now();
  if (payload.resolveWorkspaces) {
    const references = [...new Map(Object.values(turns).map((record) => {
      const reference = {
        provider: record.provider, threadId: taskThreadId(record), projectRoot: record.projectRoot,
      };
      return [bindingKey(reference), reference];
    })).values()];
    for (let offset = 0; offset < references.length; offset += 128) {
      const batch = references.slice(offset, offset + 128);
      const resolved = await new Promise((resolve, reject) => {
        workspaceRequests.set(id, { resolve, reject });
        parentPort.postMessage({ id, type: "journal-workspaces", references: batch });
      });
      batch.forEach((reference, index) => bindings.set(bindingKey(reference), resolved[index] ?? null));
    }
  }
  phases.workspaceResolveMs = performance.now() - workspaceStartedAt;
  const rateLimits = String(current?.html ?? "").match(
    /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
  )?.[0] ?? "";
  const syncedUsageFacts = await measure("factsReadMs", () => store.facts());
  const accountCatalog = await measure("accountCatalogReadMs", () => journal.accountCatalog());
  const updated = await measure("renderMs", () => projectWorkLogUsage(`# Глобальный журнал работ\n${rateLimits ? `${rateLimits}\n` : ""}`, turns, {
    includeClaudeUsage: payload.includeClaudeUsage,
    workspaceResolver: payload.resolveWorkspaces ? (reference) => bindings.get(bindingKey(reference)) : null,
    accountCatalog,
    syncedUsageEvents: syncedUsageFacts,
    localDeviceId: payload.localDeviceId,
    localDeviceLabel: payload.localDeviceLabel,
    now: payload.now,
  }));
  const version = `sha256:${crypto.createHash("sha256").update(updated, "utf8").digest("hex")}`;
  let result;
  const projectionSource = { revision: expectedRevision, projectRoots: roots };
  const previousSource = await journal.projectionSource();
  if (current?.version === version && await journal.currentRevision() === expectedRevision
    && previousSource?.revision + 1 >= expectedRevision
    && JSON.stringify(previousSource.projectRoots) === JSON.stringify(roots)) {
    result = { projected: false, reason: "unchanged", version, revision: expectedRevision };
  } else {
    const lazyPayload = await measure("lazyBuildMs", () => buildLazyJournalPayload(updated));
    result = await measure("commitMs", () => journalOperations.run(() => journal.replaceProjection(lazyPayload, {
      expectedRevision, version, projectionSource,
      accountUsageProjectionVersion: WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
    })));
  }
  return {
    ...result,
    ...(result.conflict ? { projectionDeferred: true, reason: "stale-journal-revision" } : {}),
    recordCount: Object.keys(turns).length,
    invalidRecordCount: normalized.invalidRecords.length,
    invalidRecordReasonCounts,
    eventCount: syncedUsageFacts.length,
    ...phases,
    durationMs: performance.now() - startedAt,
    workerThreadId: threadId,
  };
}

function serializedError(error) {
  return {
    message: String(error?.message ?? error),
    code: error?.code,
    errcode: error?.errcode,
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
    syncedUsageEvents: syncedUsageFacts,
    localDeviceId: payload.localDeviceId,
    localDeviceLabel: payload.localDeviceLabel,
    now: payload.now,
  });
  const unchanged = updatedHtml === String(payload.html ?? "");
  const projected = payload.force === true || !unchanged;
  return {
    projected,
    reason: unchanged ? (payload.force === true ? "forced" : "unchanged") : "updated",
    ...(projected ? {
      html: updatedHtml,
      version: `sha256:${crypto.createHash("sha256").update(updatedHtml, "utf8").digest("hex")}`,
    } : {}),
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
    case "usage-history": {
      const result = await projectUsageHistory({
        journal, store, payload: message.payload,
        resolveWorkspaces: (references) => new Promise((resolve, reject) => {
          workspaceRequests.set(message.id, { resolve, reject });
          parentPort.postMessage({ id: message.id, type: "journal-workspaces", references });
        }),
      });
      result.measurements.queueWaitMs = message.queueWaitMs;
      return result;
    }
    case "import-snapshot": return store.importSnapshot(message.payload.snapshot);
    case "reconcile-snapshot": return store.reconcileSnapshot(message.payload.snapshot);
    case "replace-events": return store.replaceEvents(message.payload.events);
    case "adopt-device-ids": return store.adoptDeviceIds(message.payload.deviceIds);
    case "project-account-usage": return projectAccountUsage(message.payload);
    case "project-journal": return {
      ...await projectJournal(message.payload, message.id), queueWaitMs: message.queueWaitMs,
    };
    case "read-turn-metadata-candidates": {
      const result = await readTurnMetadataCandidates(journal, message.payload);
      return { ...result, candidateCount: result.candidates.length, workerThreadId: threadId,
        queueWaitMs: message.queueWaitMs };
    }
    case "synchronize-turn-metadata":
    case "synchronize-task-titles": {
      if (message.payload.serializeMutation) {
        await new Promise((resolve, reject) => {
          mutationRequests.set(message.id, { resolve, reject });
          parentPort.postMessage({ id: message.id, type: "journal-mutation" });
        });
      }
      if (message.type === "synchronize-turn-metadata") {
        const result = await synchronizeTurnMetadata(journal, journalOperations, message.payload);
        return { ...result, workerThreadId: threadId, queueWaitMs: message.queueWaitMs };
      }
      return { ...await synchronizeTaskTitles(message.payload), queueWaitMs: message.queueWaitMs };
    }
    case "usage-sync-snapshot": return usageSyncSnapshot(message.payload);
    case "usage-sync-state": return store.usageSyncState();
    case "close": {
      journal.close();
      return store.close();
    }
    default: throw new Error(`unknown usage sync worker request: ${message.type}`);
  }
}

let queue = Promise.resolve();
parentPort.on("message", (message) => {
  if (message.type === "journal-mutation-granted") {
    const request = mutationRequests.get(message.id);
    mutationRequests.delete(message.id);
    if (message.error) request?.reject(new Error(message.error.message));
    else request?.resolve();
    return;
  }
  if (message.type === "journal-workspaces-result") {
    const request = workspaceRequests.get(message.id);
    workspaceRequests.delete(message.id);
    if (message.error) request?.reject(new Error(message.error.message));
    else request?.resolve(message.bindings);
    return;
  }
  const queuedAt = performance.now();
  queue = queue.then(async () => {
    message.queueWaitMs = performance.now() - queuedAt;
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
