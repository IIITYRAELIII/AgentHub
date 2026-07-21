const MISSING_TOOL_OUTPUT = /Custom tool call output is missing for call id:/i;
const THREAD_NOT_LOADED = /thread not found:/i;

export function needsInterruptedTurnRollback(error) {
  return MISSING_TOOL_OUTPUT.test(String(error?.message ?? error ?? ""));
}

export function needsThreadResume(error) {
  return THREAD_NOT_LOADED.test(String(error?.message ?? error ?? ""));
}

export async function startCodexTurnWithRecovery({
  threadId,
  startTurn,
  resume,
  rollback,
}) {
  let resumed = false;
  let rolledBack = false;
  while (true) {
    try {
      return await startTurn();
    } catch (error) {
      if (!resumed && needsThreadResume(error)) {
        await resume({ threadId });
        resumed = true;
        continue;
      }
      if (!rolledBack && needsInterruptedTurnRollback(error)) {
        await rollback({ threadId, numTurns: 1 });
        rolledBack = true;
        continue;
      }
      throw error;
    }
  }
}
