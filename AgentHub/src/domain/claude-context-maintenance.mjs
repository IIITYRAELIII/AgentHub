import { randomUUID } from "node:crypto";

export const CLAUDE_COMPACTION_PROMPT = "/compact";
export const CLAUDE_COMPACTION_CLIENT_ID_PREFIX = "agent-hub-claude-compaction:";

export function claudeCompactionClientId() {
  return `${CLAUDE_COMPACTION_CLIENT_ID_PREFIX}${randomUUID()}`;
}

export function isClaudeCompactionClientId(value) {
  return String(value ?? "").trim().startsWith(CLAUDE_COMPACTION_CLIENT_ID_PREFIX);
}

export function isClaudeCompactionRun(run) {
  if (String(run?.provider ?? "").trim().toLowerCase() !== "claude") return false;
  return run?.claudeCompaction === true
    || isClaudeCompactionClientId(run?.clientUserMessageId);
}

function nonNegativeTokens(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/* Claude Code описывает свёртку тремя служебными событиями потока: началом
   (`status: compacting`), исходом (`compact_result`) и границей, которая несёт
   точные счётчики контекста до и после. Поэтому провайдеру Claude не нужен
   скрытый замерочный ход: CLI сам отдаёт обе величины. */
export function claudeCompactionEvent(event) {
  if (event?.type !== "system") return null;
  if (event.subtype === "status") {
    if (String(event.status ?? "").trim().toLowerCase() === "compacting") {
      return { stage: "started" };
    }
    const result = String(event.compact_result ?? "").trim().toLowerCase();
    return result ? { stage: "settled", succeeded: result === "success", result } : null;
  }
  if (event.subtype !== "compact_boundary") return null;
  const metadata = event.compact_metadata ?? {};
  return {
    stage: "boundary",
    origin: String(metadata.trigger ?? "").trim().toLowerCase() === "manual"
      ? "manual"
      : "automatic",
    preTokens: nonNegativeTokens(metadata.pre_tokens),
    postTokens: nonNegativeTokens(metadata.post_tokens),
    droppedTokens: nonNegativeTokens(metadata.cumulative_dropped_tokens),
    durationMs: nonNegativeTokens(metadata.duration_ms),
  };
}
