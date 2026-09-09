export async function restorePreviousBotAfterFailedReplacement({
  replacementError,
  acquireLock,
  startCommandServer,
  setStopping,
  restoreProvider,
  recoverRuns,
  updateMessage,
  failRestartOperation,
  clearRestartRequest,
  saveState,
  startTimers,
  markReady,
}) {
  await acquireLock();
  await startCommandServer();
  setStopping(false);
  await restoreProvider();
  await recoverRuns();
  await updateMessage(
    `⚠️ Новая копия бота не запустилась: ${replacementError.message}\n\nСтарая копия восстановлена и продолжает работу.`,
  );
  await failRestartOperation(replacementError);
  clearRestartRequest();
  await saveState();
  await markReady();
  startTimers();
}

export async function finalizeSuccessfulReplacement({
  updateMessage,
  sendFallback,
  clearRestartRequest,
  saveState,
  logError = () => {},
}) {
  try {
    await updateMessage();
  } catch (updateError) {
    logError("Cannot update restart message", updateError);
    try {
      await sendFallback();
    } catch (fallbackError) {
      logError("Cannot send restart fallback", fallbackError);
    }
  }
  clearRestartRequest();
  await saveState();
  return true;
}
