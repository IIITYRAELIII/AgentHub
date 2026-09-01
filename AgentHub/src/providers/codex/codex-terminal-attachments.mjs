export const CODEX_TERMINAL_ATTACHMENT_TAIL_BYTES = 16 * 1024 * 1024;

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
  logger = console,
}) {
  return async function resolveCodexTerminalAttachments(run, turnId) {
    try {
      const rolloutPath = String(run?.rolloutPath ?? "").trim()
        || await knownRolloutPath?.(run?.threadId, run?.startedAt);
      if (!rolloutPath) return [];
      const activity = await readRolloutActivity(rolloutPath, {
        freshnessMs: Number.POSITIVE_INFINITY,
        tailBytes: CODEX_TERMINAL_ATTACHMENT_TAIL_BYTES,
      });
      const sources = codexTerminalAttachmentSources(activity, turnId);
      if (!sources.length || typeof importAttachments !== "function") return [];
      const attachments = await importAttachments(sources);
      return (Array.isArray(attachments) ? attachments : []).map((attachment) => ({ ...attachment }));
    } catch (error) {
      logger.error(`Cannot capture terminal attachments for Codex turn ${turnId}:`, error.message);
      return [];
    }
  };
}
