import {
  normalizeEstimatedCredits, normalizePersistedWorkLog, sameProjectRoot, workLogTurnKey,
} from "../application/work-log-usage-projection.mjs";
import {
  IMAGE_GENERATION_ESTIMATE_CREDITS, looksLikeImageGenerationPrompt,
} from "../domain/codex-usage-estimate.mjs";
import { normalizeServiceTier } from "../domain/token-usage.mjs";

function canonicalRecord(record, defaultProjectRoot) {
  const key = workLogTurnKey(record);
  return normalizePersistedWorkLog({ version: 9, turns: { [key]: record } }, {
    defaultProjectRoot,
  }).ledger.turns[key];
}

export async function readTurnMetadataCandidates(journal, payload) {
  const startedAt = performance.now();
  const candidates = [];
  let inspected = 0;
  const provider = String(payload.provider ?? "codex").trim().toLowerCase();
  for await (const raw of journal.metadataRecords({ provider })) {
    inspected += 1;
    const record = canonicalRecord(raw, payload.defaultProjectRoot);
    if (!record) continue;
    const missing = payload.kind === "pricing"
      ? !record.model || !record.pricingMetadataResolved
      : normalizeEstimatedCredits(record.estimatedCredits) === 0
        && looksLikeImageGenerationPrompt(record.prompt);
    if (missing) candidates.push({
      provider: record.provider, threadId: record.threadId, turnId: record.turnId,
      projectRoot: record.projectRoot, startedAt: record.startedAt,
    });
  }
  return { candidates, inspected, durationMs: performance.now() - startedAt };
}

function metadataPatch(item, kind) {
  if (kind === "pricing") {
    const model = String(item?.model ?? "").trim().toLowerCase();
    return model ? {
      model, serviceTier: normalizeServiceTier(item?.serviceTier), pricingMetadataResolved: true,
    } : null;
  }
  const estimatedCredits = normalizeEstimatedCredits(item?.estimatedCredits);
  if (!estimatedCredits) return null;
  const estimateKind = String(item?.estimateKind ?? "").trim();
  const imageGenerationCount = Math.max(
    0, Math.floor(Number(item?.imageGenerationCount) || 0),
    estimateKind === "imagegen-default"
      ? Math.round(estimatedCredits / IMAGE_GENERATION_ESTIMATE_CREDITS) : 0,
  );
  return { estimatedCredits, estimateKind, imageGenerationCount };
}

export async function synchronizeTurnMetadata(journal, journalOperations, payload) {
  const startedAt = performance.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expectedRevision = await journalOperations.run(() => journal.currentRevision());
    const source = await journal.projectionSource();
    const covered = source && (!source.projectRoots.some(Boolean)
      || source.projectRoots.some((root) => sameProjectRoot(root, payload.projectRoot)));
    const records = new Map();
    let updated = 0;
    // A restarted backfill rediscovers only still-missing metadata. The changed
    // rows themselves retain the projection fence after its old items are gone.
    let projectionRequired = (await journal.changedRecordProjectRoots({
      afterRevision: covered ? source.revision : -1, throughRevision: expectedRevision,
    })).some((root) => sameProjectRoot(root, payload.projectRoot));
    for (const item of payload.items ?? []) {
      const identity = {
        provider: String(item?.provider ?? "codex").trim().toLowerCase(),
        threadId: String(item?.threadId ?? "").trim(),
        turnId: String(item?.turnId ?? "").trim(),
      };
      const patch = metadataPatch(item, payload.kind);
      if (!identity.provider || !identity.threadId || !identity.turnId || !patch) continue;
      const key = workLogTurnKey(identity);
      const raw = records.get(key) ?? await journal.getRecord(identity);
      if (!raw) continue;
      const record = canonicalRecord(raw, payload.defaultProjectRoot);
      if (!record || !sameProjectRoot(record.projectRoot, payload.projectRoot)) continue;
      projectionRequired ||= !covered
        || await journal.recordRevision(identity) > source.revision;
      if (Object.entries(patch).every(([field, value]) => record[field] === value)) continue;
      records.set(key, { ...raw, ...patch });
      updated += 1;
    }
    try {
      const result = records.size
        ? await journalOperations.run(() => journal.upsertRecords([...records.values()], { expectedRevision }))
        : { revision: expectedRevision };
      return {
        updated, revision: result.revision, projectionRequired: updated > 0 || projectionRequired,
        durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      if (error.code !== "JOURNAL_REVISION_CONFLICT" || attempt === 1) throw error;
    }
  }
}
