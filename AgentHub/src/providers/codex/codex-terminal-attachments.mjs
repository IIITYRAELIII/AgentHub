import { contourRolloutPolicy } from "../../infrastructure/filesystem/test-contour-rollout-policy.mjs";
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
    .filter((source) => source?.type === "generated-path")
    .map((source) => ({ ...source }));
}

export function createCodexTerminalAttachmentResolver({
  recordingRoot = null,
  knownRolloutPath,
  readRolloutActivity,
  importAttachments,
  retryDelaysMs = CODEX_TERMINAL_ATTACHMENT_RETRY_DELAYS_MS,
  wait = delay,
  logger = console,
}) {
  const rolloutPolicy = recordingRoot ? contourRolloutPolicy({ testContourRecording: { root: recordingRoot } }) : null;
  return async function resolveCodexTerminalAttachments(run, turnId) {
    if (rolloutPolicy) {
      rolloutPolicy.exclude("terminal-attachments");
      return [];
    }
    try {
      const normalizedTurnId = String(turnId ?? "").trim();
      const exactSources = (Array.isArray(run?.generatedImageSources)
        ? run.generatedImageSources
        : []).filter((source) => (
        source?.type === "generated-path" && String(source.value ?? "").trim()
      ));
      if (exactSources.length) {
        if (typeof importAttachments !== "function") return [];
        const attachments = await importAttachments(exactSources);
        return Array.isArray(attachments)
          ? attachments.map((attachment) => ({ ...attachment }))
          : [];
      }
      let bestAttachments = [];
      const delays = run?.historicalRecovery === true ? retryDelaysMs.slice(0, 1) : retryDelaysMs;
      for (const retryDelayMs of delays) {
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
