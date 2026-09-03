export const CODEX_TERMINAL_ATTACHMENT_TAIL_BYTES = 16 * 1024 * 1024;
export const CODEX_TERMINAL_ATTACHMENT_RETRY_DELAYS_MS = Object.freeze([0, 100, 300, 600, 1_000, 2_000]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exactTurnFinalized(activity, turnId) {
  return Object.prototype.hasOwnProperty.call(activity?.finalMessages ?? {}, turnId);
}

function completedImageGenerationCount(activity, turnId) {
  return (Array.isArray(activity?.activityGroups?.[turnId]) ? activity.activityGroups[turnId] : [])
    .flatMap((group) => Array.isArray(group?.activities) ? group.activities : [])
    .filter((item) => (
      item?.type === "tool"
      && item?.status === "completed"
      && item?.detail === "image_gen__imagegen"
    )).length;
}

export function codexTerminalAttachmentSources(activity, turnId) {
  return (Array.isArray(activity?.generatedImageSources?.[turnId])
    ? activity.generatedImageSources[turnId]
    : [])
    .filter((source) => ["generated-path", "display-path"].includes(source?.type))
    .map((source) => ({ ...source }));
}

export function createCodexTerminalAttachmentResolver({
  knownRolloutPath,
  readRolloutActivity,
  importAttachments,
  retryDelaysMs = CODEX_TERMINAL_ATTACHMENT_RETRY_DELAYS_MS,
  wait = delay,
  logger = console,
}) {
  return async function resolveCodexTerminalAttachments(run, turnId) {
    try {
      const normalizedTurnId = String(turnId ?? "").trim();
      let bestAttachments = [];
      for (const retryDelayMs of retryDelaysMs) {
        if (retryDelayMs > 0) await wait(retryDelayMs);
        const rolloutPath = String(run?.rolloutPath ?? "").trim()
          || await knownRolloutPath?.(run?.threadId, run?.startedAt);
        if (!rolloutPath) continue;
        const activity = await readRolloutActivity(rolloutPath, {
          freshnessMs: Number.POSITIVE_INFINITY,
          tailBytes: CODEX_TERMINAL_ATTACHMENT_TAIL_BYTES,
          reparseTail: true,
        });
        const sources = codexTerminalAttachmentSources(activity, normalizedTurnId);
        const expectedImages = completedImageGenerationCount(activity, normalizedTurnId);
        if (!sources.length) {
          if (exactTurnFinalized(activity, normalizedTurnId) && expectedImages === 0) {
            return [];
          }
          continue;
        }
        if (typeof importAttachments !== "function") return [];
        const attachments = await importAttachments(sources);
        if (Array.isArray(attachments) && attachments.length) {
          bestAttachments = attachments.map((attachment) => ({ ...attachment }));
          if (bestAttachments.length >= Math.max(1, expectedImages)) return bestAttachments;
        }
      }
      return bestAttachments;
    } catch (error) {
      logger.error(`Cannot capture terminal attachments for Codex turn ${turnId}:`, error.message);
      return [];
    }
  };
}
