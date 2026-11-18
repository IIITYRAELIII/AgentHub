export const TASK_RECOVERY_ACTIONS = Object.freeze({
  OBSERVE: "observe",
  FINISH_OBSERVED: "finish-observed",
  UNKNOWN_OBSERVED: "unknown-observed",
  ATTACH_CLAUDE: "attach-claude",
  INTERRUPTED_LOCAL: "interrupted-local",
  MISSING_CODEX_TURN: "missing-codex-turn",
  ATTACH_CODEX: "attach-codex",
  DISMISS_RESTART_INTERRUPTION: "dismiss-restart-interruption",
  DELIVER_CODEX_RESULT: "deliver-codex-result",
});

export function resolveTaskRecoveryAction({
  run,
  observerSnapshot = null,
  codexAvailable = false,
  codexTurn = null,
  restartRequested = false,
} = {}) {
  if (run?.observer) {
    if (observerSnapshot?.active) return TASK_RECOVERY_ACTIONS.OBSERVE;
    if (observerSnapshot?.completed) return TASK_RECOVERY_ACTIONS.FINISH_OBSERVED;
    if (observerSnapshot?.activityUnknown) return TASK_RECOVERY_ACTIONS.UNKNOWN_OBSERVED;
  }
  if (run?.provider === "claude" && run?.claudeOutputPath) {
    return TASK_RECOVERY_ACTIONS.ATTACH_CLAUDE;
  }
  if (run?.provider !== "codex" || !codexAvailable) {
    return TASK_RECOVERY_ACTIONS.INTERRUPTED_LOCAL;
  }
  if (!codexTurn) return TASK_RECOVERY_ACTIONS.MISSING_CODEX_TURN;
  if (codexTurn.status === "inProgress") return TASK_RECOVERY_ACTIONS.ATTACH_CODEX;
  if (restartRequested && codexTurn.status === "interrupted") {
    return TASK_RECOVERY_ACTIONS.DISMISS_RESTART_INTERRUPTION;
  }
  return TASK_RECOVERY_ACTIONS.DELIVER_CODEX_RESULT;
}
