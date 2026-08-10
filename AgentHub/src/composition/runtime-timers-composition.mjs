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
  selectedTaskWatch,
  scheduleCodexTerminalAudit,
  scheduleBugReportScan,
  rateLimitTelemetry,
}) {
  function stopRuntimeTimers() {
    stopTyping();
    contextCompactions.dispose();
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
    for (const item of queuedInputs.values()) scheduleQueuedInput(item, 500);
    if (telegramEnabled) scheduleDeliveryOutboxFlush(1_000);
    selectedTaskWatch.schedule(500);
    scheduleCodexTerminalAudit(500);
    scheduleBugReportScan(500);
    rateLimitTelemetry.schedule(1_000);
  }

  return {
    stopRuntimeTimers,
    startRuntimeTimers,
  };
}
