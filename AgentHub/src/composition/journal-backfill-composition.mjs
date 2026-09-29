import { setImmediate } from "node:timers/promises";
import { WORK_LOG_ACCOUNTING_PROJECTION_VERSION } from "../domain/quota-units.mjs";
import { scanCodexHistoricalRolloutInWorker } from "../providers/codex/codex-historical-backfill.mjs";
import { WORK_LOG_IMAGE_BACKFILL_VERSION } from "../domain/codex-usage-estimate.mjs";
import {
  findCodexRolloutPath,
  readCodexTurnUsage,
  scanCodexTurnPricingMetadata,
} from "../providers/codex/codex-turn-usage.mjs";

export function createJournalBackfillComposition({
  projects,
  workLogUsageStore,
  projectionProjectRoots,
  logger = console,
  commandTrace = null,
}) {
  let attempted = false;
  const measure = (stage, metadata, operation) => commandTrace?.measureBestEffort
    ? commandTrace.measureBestEffort({ commandId: "startup-provider-metadata", stage,
      transport: "server-runtime", metadata }, operation) : operation();

  async function backfill(codexThreads, { signal, propagateErrors = false } = {}) {
    signal?.throwIfAborted();
    if (attempted) return;
    attempted = true;
    try {
      const missing = await measure("pricing-missing-turns", {}, () => workLogUsageStore.missingPricingTurns({ provider: "codex" }));
      const missingByThread = new Map();
      for (const item of missing) {
        const values = missingByThread.get(item.threadId) ?? [];
        values.push(item);
        missingByThread.set(item.threadId, values);
      }
      const threadsById = new Map(
        (codexThreads ?? []).map((thread) => [String(thread.id), thread]),
      );
      const resolved = [];
      for (const [threadId, turns] of missingByThread) {
        await setImmediate(undefined, { signal });
        signal?.throwIfAborted();
        let rolloutPath = String(threadsById.get(threadId)?.path ?? "").trim();
        if (!rolloutPath) rolloutPath = await findCodexRolloutPath(threadId, turns[0]?.startedAt);
        if (!rolloutPath) continue;
        const metadata = await measure("pricing-rollout-scan", { threadId, turnCount: turns.length },
          () => scanCodexTurnPricingMetadata(rolloutPath, turns.map((item) => item.turnId), { signal }));
        for (const item of turns) {
          const pricing = metadata.get(item.turnId);
          if (pricing?.model) resolved.push({ ...item, ...pricing });
        }
      }
      for (const project of projects) {
        await setImmediate(undefined, { signal });
        signal?.throwIfAborted();
        await measure("pricing-metadata-project", { turnCount: resolved.length }, () => workLogUsageStore.synchronizePricingMetadataAndProject({
          items: resolved,
          projectRoot: project.path,
          projectionProjectRoots,
        }));
      }

      const recheckHistoricalImages = typeof workLogUsageStore.imageBackfillVersion === "function"
        && await workLogUsageStore.imageBackfillVersion() !== WORK_LOG_IMAGE_BACKFILL_VERSION;
      const missingImageEstimates = await workLogUsageStore
        .missingImageGenerationEstimateTurns({ provider: "codex", allUnestimated: recheckHistoricalImages });
      const imageEstimates = [];
      let unavailableImageThreads = 0;
      const missingImagesByThread = new Map();
      for (const item of missingImageEstimates) {
        const turns = missingImagesByThread.get(item.threadId) ?? [];
        turns.push(item);
        missingImagesByThread.set(item.threadId, turns);
      }
      for (const [threadId, turns] of missingImagesByThread) {
        await setImmediate(undefined, { signal });
        signal?.throwIfAborted();
        let rolloutPath = String(threadsById.get(threadId)?.path ?? "").trim();
        if (!rolloutPath) rolloutPath = await findCodexRolloutPath(threadId, turns[0]?.startedAt);
        if (!rolloutPath) {
          unavailableImageThreads += 1;
          continue;
        }
        if (recheckHistoricalImages) {
          const scanned = await measure("pricing-image-rollout-read", { threadId, turnCount: turns.length },
            () => scanCodexHistoricalRolloutInWorker({ id: threadId, path: rolloutPath }));
          const byTurn = new Map(scanned.turns.map((turn) => [turn.turnId, turn]));
          for (const item of turns) {
            const usage = byTurn.get(item.turnId);
            if (Number(usage?.imageGenerationCount) > 0) imageEstimates.push({
              ...item, estimatedCredits: usage.estimatedCredits, estimateKind: usage.estimateKind,
              imageGenerationCount: usage.imageGenerationCount,
            });
          }
        } else {
          for (const item of turns) {
            const usage = await measure("pricing-image-usage-read", { threadId, turnId: item.turnId },
              () => readCodexTurnUsage(rolloutPath, item.turnId, { signal }));
            signal?.throwIfAborted();
            if (Number(usage?.imageGenerationCount) > 0) imageEstimates.push({
              ...item, estimatedCredits: usage.estimatedCredits, estimateKind: usage.estimateKind,
              imageGenerationCount: usage.imageGenerationCount,
            });
          }
        }
      }
      for (const project of projects) {
        await setImmediate(undefined, { signal });
        signal?.throwIfAborted();
        await measure("pricing-image-project", { turnCount: imageEstimates.length }, () => workLogUsageStore.synchronizeUsageEstimatesAndProject({
          items: imageEstimates,
          projectRoot: project.path,
          projectionProjectRoots,
        }));
      }
      if (recheckHistoricalImages && projects.length && unavailableImageThreads === 0) {
        signal?.throwIfAborted();
        await measure("pricing-image-version-project", {}, () => workLogUsageStore.project(null, {
          projectRoot: projects[0].path, projectionProjectRoots,
          imageBackfillVersion: WORK_LOG_IMAGE_BACKFILL_VERSION,
        }));
      }
      // Prices are derived from immutable token facts. A shipped tariff change
      // needs one full projection even when every turn already has metadata.
      if (projects.length && typeof workLogUsageStore.pricingProjectionVersion === "function"
        && await workLogUsageStore.pricingProjectionVersion() !== WORK_LOG_ACCOUNTING_PROJECTION_VERSION) {
        signal?.throwIfAborted();
        await measure("pricing-version-project", {}, () => workLogUsageStore.project(null, {
          projectRoot: projects[0].path, projectionProjectRoots,
        }));
      }
      if (resolved.length) {
        logger.log(`Backfilled credit pricing metadata for ${resolved.length} journal turn(s)`);
      }
      if (imageEstimates.length) {
        logger.log(`Backfilled image generation estimates for ${imageEstimates.length} journal turn(s)`);
      }
      if (unavailableImageThreads) {
        logger.warn?.(`Image generation backfill awaits ${unavailableImageThreads} unavailable rollout(s)`);
      }
    } catch (error) {
      attempted = false;
      logger.error("Cannot backfill journal credit pricing metadata:", error.message);
      if (propagateErrors) throw error;
    }
  }

  return { backfill };
}
