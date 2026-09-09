import { setImmediate } from "node:timers/promises";
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

      const missingImageEstimates = await workLogUsageStore
        .missingImageGenerationEstimateTurns({ provider: "codex" });
      const imageEstimates = [];
      for (const item of missingImageEstimates) {
        await setImmediate(undefined, { signal });
        signal?.throwIfAborted();
        let rolloutPath = String(threadsById.get(item.threadId)?.path ?? "").trim();
        if (!rolloutPath) rolloutPath = await findCodexRolloutPath(item.threadId, item.startedAt);
        if (!rolloutPath) continue;
        const usage = await measure("pricing-image-usage-read", { threadId: item.threadId, turnId: item.turnId },
          () => readCodexTurnUsage(rolloutPath, item.turnId, { signal }));
        signal?.throwIfAborted();
        if (Number(usage?.estimatedCredits) > 0) {
          imageEstimates.push({
            ...item,
            estimatedCredits: usage.estimatedCredits,
            estimateKind: usage.estimateKind,
          });
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
      if (resolved.length) {
        logger.log(`Backfilled credit pricing metadata for ${resolved.length} journal turn(s)`);
      }
      if (imageEstimates.length) {
        logger.log(`Backfilled image generation estimates for ${imageEstimates.length} journal turn(s)`);
      }
    } catch (error) {
      attempted = false;
      logger.error("Cannot backfill journal credit pricing metadata:", error.message);
      if (propagateErrors) throw error;
    }
  }

  return { backfill };
}
