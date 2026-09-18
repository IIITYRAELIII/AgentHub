export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRuntimeTimersComposition({
  telegramEnabled,
  runtimeTimers,
  stopTyping,
  contextCompactions,
  deferredInputController,
  taskRuns,
  taskProgress,
  taskObserver,
  claudeRunController,
  codexContextMaintenance,
  queuedInputs,
  scheduleQueuedInput,
  scheduleDeliveryOutboxFlush,
  turnEndDelivery = null,
  selectedTaskWatch,
  scheduleCodexTerminalAudit,
  scheduleBugReportScan,
  rateLimitTelemetry,
  usageSyncAuto = null,
  testContourJournalSync = null,
  providerLogin = null,
}) {
  function stopRuntimeTimers() {
    stopTyping();
    contextCompactions.dispose();
    providerLogin?.dispose?.();
    usageSyncAuto?.stop?.();
    testContourJournalSync?.stop?.();
    turnEndDelivery?.stopProjectionRecovery?.();
    runtimeTimers.clearAll();
    deferredInputController.stop();
    for (const run of taskRuns.values()) {
      taskProgress.pause(run);
      taskObserver.pause(run);
      claudeRunController.pause(run);
    }
  }

  function startRuntimeTimers() {
    codexContextMaintenance.schedulePeriodic();
    if (!deferredInputController.wakeAll()) {
      for (const item of queuedInputs.values()) scheduleQueuedInput(item, 500);
    }
    if (telegramEnabled) scheduleDeliveryOutboxFlush(1_000);
    turnEndDelivery?.startProjectionRecovery?.();
    selectedTaskWatch.schedule(500);
    scheduleCodexTerminalAudit(500);
    scheduleBugReportScan(500);
    rateLimitTelemetry.schedule(1_000);
    usageSyncAuto?.scheduleInitial?.();
    testContourJournalSync?.scheduleInitial?.();
  }

  return {
    stopRuntimeTimers,
    startRuntimeTimers,
  };
}
