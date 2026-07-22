export async function restorePreviousBotAfterFailedReplacement({
  replacementError,
  acquireLock,
  startCommandServer,
  setStopping,
  restoreProvider,
  recoverRuns,
  updateMessage,
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
  clearRestartRequest();
  await saveState();
  startTimers();
  await markReady();
}
