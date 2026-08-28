export const CODEX_AUTO_COMPACTION_TURN_ID_PREFIX = "auto-compact-";

const CODEX_AUTO_COMPACTION_TURN_ID = new RegExp(
  `^${CODEX_AUTO_COMPACTION_TURN_ID_PREFIX}`,
  "u",
);

export function isCodexAutoCompactionTurnId(value) {
  return CODEX_AUTO_COMPACTION_TURN_ID.test(String(value ?? "").trim());
}
