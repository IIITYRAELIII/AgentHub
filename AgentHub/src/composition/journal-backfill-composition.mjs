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
}) {
  let attempted = false;

  async function backfill(codexThreads) {
    if (attempted) return;
    attempted = true;
    try {
      const missing = await workLogUsageStore.missingPricingTurns({ provider: "codex" });
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
        let rolloutPath = String(threadsById.get(threadId)?.path ?? "").trim();
        if (!rolloutPath) rolloutPath = await findCodexRolloutPath(threadId, turns[0]?.startedAt);
        if (!rolloutPath) continue;
        const metadata = await scanCodexTurnPricingMetadata(
          rolloutPath,
          turns.map((item) => item.turnId),
        );
        for (const item of turns) {
          const pricing = metadata.get(item.turnId);
          if (pricing?.model) resolved.push({ ...item, ...pricing });
        }
      }
      for (const project of projects) {
        await workLogUsageStore.synchronizePricingMetadataAndProject({
          items: resolved,
          projectRoot: project.path,
          projectionProjectRoots,
        });
      }

      const missingImageEstimates = await workLogUsageStore
        .missingImageGenerationEstimateTurns({ provider: "codex" });
      const imageEstimates = [];
      for (const item of missingImageEstimates) {
        let rolloutPath = String(threadsById.get(item.threadId)?.path ?? "").trim();
        if (!rolloutPath) rolloutPath = await findCodexRolloutPath(item.threadId, item.startedAt);
        if (!rolloutPath) continue;
        const usage = await readCodexTurnUsage(rolloutPath, item.turnId);
        if (Number(usage?.estimatedCredits) > 0) {
          imageEstimates.push({
            ...item,
            estimatedCredits: usage.estimatedCredits,
            estimateKind: usage.estimateKind,
          });
        }
      }
      for (const project of projects) {
        await workLogUsageStore.synchronizeUsageEstimatesAndProject({
          items: imageEstimates,
          projectRoot: project.path,
          projectionProjectRoots,
        });
      }
      if (resolved.length) {
        logger.log(`Backfilled credit pricing metadata for ${resolved.length} journal turn(s)`);
      }
      if (imageEstimates.length) {
        logger.log(`Backfilled image generation estimates for ${imageEstimates.length} journal turn(s)`);
      }
    } catch (error) {
      logger.error("Cannot backfill journal credit pricing metadata:", error.message);
    }
  }

  return { backfill };
}
