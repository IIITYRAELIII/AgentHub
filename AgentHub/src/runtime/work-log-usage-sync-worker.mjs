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
  workLogAccountUsageWindow,
} from "../application/work-log-usage-projection.mjs";
import { buildLazyJournalPayload } from "../application/journal-projection-data.mjs";
import { incrementalJournalProjection, accountingRecord } from "../application/incremental-journal-projection.mjs";
import { WORK_LOG_ACCOUNTING_PROJECTION_VERSION } from "../domain/quota-units.mjs";
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
// One bounded receipt of a verified rendering in this worker lifetime. It
// retains only hashes/scalars, not HTML/facts/records; SQLite remains authority.
// Restart, a failed rendering or any changed dependency requires reconstruction.
let journalReuse = null;

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
  const roots = (payload.projectRoots ?? []).map((root) => normalizeProjectRoot(root));
  const scope = JSON.stringify([roots, payload.includeClaudeUsage, Boolean(payload.resolveWorkspaces),
    payload.defaultProjectRoot, Intl.DateTimeFormat().resolvedOptions().timeZone]);
  const selectRecord = record => !roots.some(Boolean) || roots.some(root =>
    sameProjectRoot(normalizeProjectRoot(record.projectRoot, payload.defaultProjectRoot), root));
  const accountingProjector = record => accountingRecord(record, payload.defaultProjectRoot);
  let input = await measure("ledgerReadMs", () => journalOperations.run(() => journal.projectionInput({ scope, selectRecord, accountingProjector })));
  let accountingVersionCurrent = await journal.pricingProjectionVersion()
    === WORK_LOG_ACCOUNTING_PROJECTION_VERSION;
  let imageVersionCurrent = payload.imageBackfillVersion == null
    || await journal.imageBackfillVersion() === payload.imageBackfillVersion;
  if (!input.full && (!accountingVersionCurrent || !imageVersionCurrent)) {
    input = await measure("ledgerReadMs", () => journalOperations.run(() => journal.projectionInput({
      full: true, scope, selectRecord, accountingProjector,
    })));
  }
  const previousSource = input.source;
  const current = input.current;
  let full = input.full;
  const expectedRevision = payload.expectedRevision ?? input.revision;
  const select = turns => Object.fromEntries(Object.entries(turns).filter(([, record]) => (
    !roots.some(Boolean) || roots.some(root => sameProjectRoot(record.projectRoot, root))
  )));
  const accounting = select(input.accounting);
  const bindings = new Map();
  const bindingKey = reference => `${reference.provider}\0${reference.threadId}`;
  const workspaceStartedAt = performance.now();
  if (payload.resolveWorkspaces) {
    const references = [...new Map(Object.values(accounting).map(record => {
      const reference = { provider: record.provider, threadId: taskThreadId(record), projectRoot: record.projectRoot };
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
  // Callbacks may let another SQLite owner change markers without changing the
  // journal revision. Initial observations cannot authorize the consuming path.
  accountingVersionCurrent = await journal.pricingProjectionVersion()
    === WORK_LOG_ACCOUNTING_PROJECTION_VERSION;
  imageVersionCurrent = payload.imageBackfillVersion == null
    || await journal.imageBackfillVersion() === payload.imageBackfillVersion;
  // Rebinding existing Threads can affect historical days without a ledger edit.
  // New Threads only affect their dirty dates. Scope/version changes use one rebuild.
  if (!full && (!accountingVersionCurrent || !imageVersionCurrent
    || (previousSource.bindings ?? []).some(([key, value]) => bindings.has(key)
      && JSON.stringify(bindings.get(key)) !== JSON.stringify(value)))) {
    full = true;
    input = await measure("ledgerReadMs", () => journal.projectionInput({ full: true, scope, selectRecord, accountingProjector }));
  }
  const rateLimits = String(current?.html ?? "").match(
    /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
  )?.[0] ?? "";
  const factsIdentity = await measure("factsRevisionReadMs", () => store.projectionFactsIdentity());
  const accountCatalog = await measure("accountCatalogReadMs", () => journal.accountCatalog());
  const now = payload.now === undefined ? Date.now() : Number(payload.now);
  const options = {
    preferredOpenDate: input.openDate,
    includeClaudeUsage: payload.includeClaudeUsage,
    workspaceResolver: payload.resolveWorkspaces ? (reference) => bindings.get(bindingKey(reference)) : null,
    accountCatalog,
    localDeviceId: payload.localDeviceId,
    localDeviceLabel: payload.localDeviceLabel,
    now,
  };
  const reuseKey = version => {
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify([scope, version, payload.imageBackfillVersion,
      payload.localDeviceId, payload.localDeviceLabel, new Date().toLocaleDateString("ru-RU")]));
    // Hash each existing scalar binding/catalog object; retain no second set.
    for (const entry of bindings) hash.update(JSON.stringify(entry));
    for (const account of accountCatalog) hash.update(JSON.stringify(account));
    return hash.digest("hex");
  };
  phases.reuseCheckMs = 0;
  const reuseCandidate = journalReuse;
  const reuseEligible = !full && input.dirtyDates.length === 0 && accountingVersionCurrent && imageVersionCurrent
    && expectedRevision === input.revision && expectedRevision === reuseCandidate?.revision
    && reuseCandidate.key === reuseKey(current?.version)
    && factsIdentity.revision === reuseCandidate.factsRevision
    && factsIdentity.generation === reuseCandidate.factsGeneration
    && Number.isSafeInteger(now) && now >= reuseCandidate.window.from && now < reuseCandidate.window.until;
  if (reuseEligible && await measure("reuseCheckMs", () => journal.projectionReuseFence({
      revision: expectedRevision, factsRevision: factsIdentity.revision, factsGeneration: factsIdentity.generation,
      pricingProjectionVersion: WORK_LOG_ACCOUNTING_PROJECTION_VERSION,
      imageBackfillVersion: payload.imageBackfillVersion,
    }).catch(() => false))) {
    return {
      projected: false, reason: "unchanged", projectionReused: true,
      version: current.version, revision: expectedRevision,
      recordCount: 0, accountingRecordsRead: input.accountingRecordsRead,
      projectionMode: "days", changedDayCount: 0, invalidRecordCount: 0, invalidRecordReasonCounts: {},
      eventCount: reuseCandidate.eventCount, factsSourceRead: false,
      factsCacheBytes: reuseCandidate.factsCacheBytes, factsCacheRetained: reuseCandidate.factsCacheRetained,
      ...phases, factsReadMs: 0, renderMs: 0, durationMs: performance.now() - startedAt, workerThreadId: threadId,
    };
  }
  journalReuse = null;
  if (reuseEligible) {
    // A failed final snapshot can include a marker change after the callback
    // observation. Reconstruct fully, preserving the original revision CAS.
    full = true;
    input = await measure("ledgerReadMs", () => journal.projectionInput({ full: true, scope, selectRecord, accountingProjector }));
  }
  const persisted = { version: 9, turns: input.turns };
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
  const turns = Object.fromEntries(Object.entries(normalized.ledger.turns).filter(([, record]) => (
    !roots.some(Boolean) || roots.some((root) => sameProjectRoot(record.projectRoot, root))
  )));
  const factsSnapshot = await measure("factsReadMs", () => store.projectionFacts());
  const syncedUsageFacts = factsSnapshot.facts;
  options.syncedUsageEvents = syncedUsageFacts;
  const lazyPayload = await measure("renderMs", () => full
    ? buildLazyJournalPayload(projectWorkLogUsage(`# Глобальный журнал работ\n${rateLimits ? `${rateLimits}\n` : ""}`, turns, options))
    : incrementalJournalProjection(current?.html ?? '', turns, accounting, input.dirtyDates, options));
  // Include changed lazy bodies and the source revision, not only the compact
  // index: an answer correction can leave every day heading unchanged.
  const version = `sha256:${crypto.createHash("sha256")
    .update(JSON.stringify([expectedRevision, lazyPayload]), "utf8").digest("hex")}`;
  let result;
  const projectionSource = { revision: expectedRevision, projectRoots: roots,
    incrementalVersion: 1, scope, bindings: [...bindings], openDate: input.openDate };
  if (!full && input.dirtyDates.length === 0 && current?.html === lazyPayload.html
    && accountingVersionCurrent && imageVersionCurrent
    && await journal.currentRevision() === expectedRevision
    && previousSource?.revision + 1 >= expectedRevision
    && JSON.stringify(previousSource.projectRoots) === JSON.stringify(roots)) {
    result = { projected: false, reason: "unchanged", version: current.version, revision: expectedRevision };
  } else {
    result = await measure("commitMs", () => journalOperations.run(() => journal.replaceProjection(lazyPayload, {
      expectedRevision, version, projectionSource,
      incrementalSource: true,
      accountUsageProjectionVersion: WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
      pricingProjectionVersion: WORK_LOG_ACCOUNTING_PROJECTION_VERSION,
      imageBackfillVersion: payload.imageBackfillVersion,
    })));
  }
  try {
    if (!result.conflict && factsSnapshot.revision && factsSnapshot.generation) {
      const window = await measure("reuseWindowMs", () => workLogAccountUsageWindow(accounting, options));
      if (window && await journal.projectionReuseFence({
        revision: result.revision, factsRevision: factsSnapshot.revision, factsGeneration: factsSnapshot.generation,
        pricingProjectionVersion: WORK_LOG_ACCOUNTING_PROJECTION_VERSION,
        imageBackfillVersion: payload.imageBackfillVersion,
      })) {
        journalReuse = { key: reuseKey(result.version), revision: result.revision,
          factsRevision: factsSnapshot.revision, factsGeneration: factsSnapshot.generation, window,
          eventCount: syncedUsageFacts.length, factsCacheBytes: factsSnapshot.cacheBytes,
          factsCacheRetained: factsSnapshot.cacheRetained };
      }
    }
  } catch {
    // An optional reuse receipt cannot turn a committed projection into a
    // failure. No proof means no reuse; the next request reconstructs normally.
    journalReuse = null;
    phases.reuseReceiptFailed = 1;
  }
  return {
    ...result,
    projectionReused: false,
    ...(result.conflict ? { projectionDeferred: true, reason: "stale-journal-revision" } : {}),
    recordCount: Object.keys(turns).length,
    accountingRecordsRead: input.accountingRecordsRead,
    projectionMode: full ? "full" : "days",
    changedDayCount: input.dirtyDates.length,
    invalidRecordCount: normalized.invalidRecords.length,
    invalidRecordReasonCounts,
    eventCount: syncedUsageFacts.length,
    factsSourceRead: factsSnapshot.sourceRead,
    factsCacheBytes: factsSnapshot.cacheBytes ?? null,
    factsCacheRetained: factsSnapshot.cacheRetained ?? true,
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
    case "ensure-turn-fact": return store.ensureTurnFact(message.payload.fact);
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
