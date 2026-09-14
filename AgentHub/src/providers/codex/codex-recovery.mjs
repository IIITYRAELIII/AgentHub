const MISSING_TOOL_OUTPUT = /Custom tool call output is missing for call id:/i;
const THREAD_NOT_LOADED = /thread not found:/i;

export function needsInterruptedTurnRollback(error) {
  return MISSING_TOOL_OUTPUT.test(String(error?.message ?? error ?? ""));
}

export function needsThreadResume(error) {
  return THREAD_NOT_LOADED.test(String(error?.message ?? error ?? ""));
}

export function activeTurnMissing(error) {
  return /no active turn|active turn not found|turn not found/i.test(
    String(error?.message ?? error ?? ""),
  );
}

export async function interruptCodexTurnWithRecovery({ threadId, turnId, interrupt, resume }) {
  try {
    return await interrupt({ threadId, turnId });
  } catch (error) {
    if (!needsThreadResume(error)) throw error;
    await resume({ threadId });
    return interrupt({ threadId, turnId });
  }
}

export async function steerCodexTurnWithRecovery({ threadId, steer, resume }) {
  try {
    return await steer();
  } catch (error) {
    if (!needsThreadResume(error)) throw error;
    await resume({ threadId });
    return steer();
  }
}

export async function updateCodexThreadSettingsWithRecovery({ threadId, update, resume }) {
  try {
    return await update();
  } catch (error) {
    if (!needsThreadResume(error)) throw error;
    await resume({ threadId });
    return update();
  }
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
