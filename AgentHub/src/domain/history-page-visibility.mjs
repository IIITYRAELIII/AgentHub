import { CODEX_AUTO_COMPACTION_TURN_ID_PREFIX } from "./codex-internal-turn.mjs";

export const EMPTY_TURN_COMPLETION_TEXT = "Ход завершён без текстового ответа.";
export const CHAT_HISTORY_VISIBILITY = Object.freeze({
  hiddenProvider: "codex",
  hiddenTurnIdPrefixes: Object.freeze([CODEX_AUTO_COMPACTION_TURN_ID_PREFIX]),
  emptyCompletionText: EMPTY_TURN_COMPLETION_TEXT,
});
