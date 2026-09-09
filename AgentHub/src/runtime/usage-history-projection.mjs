import { threadId } from "node:worker_threads";
import {
  buildWorkLogUsageHistory,
  normalizePersistedWorkLog,
  taskThreadId,
} from "../application/work-log-usage-projection.mjs";

// Reads the canonical ledger; this is not a separately materialized usage cache.
export async function projectUsageHistory({ journal, store, payload, resolveWorkspaces }) {
  const startedAt = performance.now();
  const measurements = {};
  let phaseAt = startedAt;
  const persisted = await journal.loadLedger({ usageHistory: true });
  measurements.ledgerReadMs = performance.now() - phaseAt;
  phaseAt = performance.now();
  const normalized = normalizePersistedWorkLog(persisted, {
    defaultProjectRoot: payload.defaultProjectRoot,
  });
  measurements.normalizeMs = performance.now() - phaseAt;
  phaseAt = performance.now();
  const bindings = new Map();
  const key = (reference) => `${reference.provider}\0${reference.threadId}`;
  if (payload.resolveWorkspaces) {
    const references = [...new Map(Object.values(normalized.ledger.turns).map((record) => {
      const reference = {
        provider: record.provider, threadId: taskThreadId(record), projectRoot: record.projectRoot,
      };
      return [key(reference), reference];
    })).values()];
    for (let offset = 0; offset < references.length; offset += 128) {
      const batch = references.slice(offset, offset + 128);
      const resolved = await resolveWorkspaces(batch);
      batch.forEach((reference, index) => bindings.set(key(reference), resolved[index] ?? null));
    }
  }
  measurements.workspaceReadMs = performance.now() - phaseAt;
  phaseAt = performance.now();
  const facts = await store.facts();
  measurements.factsReadMs = performance.now() - phaseAt;
  phaseAt = performance.now();
  const history = buildWorkLogUsageHistory(normalized.ledger.turns, {
    ...payload,
    syncedUsageEvents: facts,
    workspaceResolver: payload.resolveWorkspaces ? (reference) => bindings.get(key(reference)) : null,
  });
  measurements.aggregateMs = performance.now() - phaseAt;
  return {
    history,
    measurements: {
      ...measurements, durationMs: performance.now() - startedAt, workerThreadId: threadId,
      recordCount: Object.keys(normalized.ledger.turns).length,
      invalidRecordCount: normalized.invalidRecords.length, factCount: facts.length,
    },
  };
}
