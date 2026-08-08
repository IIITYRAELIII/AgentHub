const CODEX_AUTO_COMPACTION_TURN_ID = /^auto-compact-/u;

export function isCodexAutoCompactionTurnId(value) {
  return CODEX_AUTO_COMPACTION_TURN_ID.test(String(value ?? "").trim());
}
