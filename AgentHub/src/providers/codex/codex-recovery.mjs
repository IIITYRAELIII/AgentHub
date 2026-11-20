const THREAD_NOT_LOADED = /thread not found:/i;

export function needsThreadResume(error) {
  return THREAD_NOT_LOADED.test(String(error?.message ?? error ?? ""));
}

export function activeTurnMissing(error) {
  return /no active turn|active turn not found|turn not found/i.test(
    String(error?.message ?? error ?? ""),
  );
}

export async function interruptCodexTurnWithRecovery({ threadId, turnId, interrupt }) {
  return interrupt({ threadId, turnId });
}

export async function steerCodexTurnWithRecovery({ steer }) {
  return steer();
}

export async function updateCodexThreadSettingsWithRecovery({ update }) {
  return update();
}

export async function startCodexTurnWithRecovery({
  threadId,
  startTurn,
  resume,
}) {
  let resumed = false;
  while (true) {
    try {
      return await startTurn();
    } catch (error) {
      if (!resumed && needsThreadResume(error)) {
        await resume({ threadId });
        resumed = true;
        continue;
      }
      throw error;
    }
  }
}
