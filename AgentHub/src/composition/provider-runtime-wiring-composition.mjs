import { createRunObservationComposition } from "./run-observation-composition.mjs";

export function createProviderRuntimeWiring({
  observation,
  managedRunHistory,
  claudeEventService,
  runCoordinator,
  codexEventService,
  codexTaskSnapshots,
  codexTerminalAudit,
  codexTransport,
  saveState,
  isStopping,
  runtimeTimers,
  selectedTaskWatchIntervalMs,
  terminalAuditIntervalMs = 30_000,
  terminalAuditEnabled = true,
  logger = console,
}) {
  function persistManagedRunHistory(...args) {
    return managedRunHistory.persist(...args);
  }

  function persistClaudeRunHistory(run, options = {}) {
    return persistManagedRunHistory(run, options);
  }

  function handleClaudeStreamEvent(run, parsed) {
    return claudeEventService.handle(run, parsed);
  }

  async function finishClaudeRun(run, completion = {}) {
    return runCoordinator.completeManaged(run, completion);
  }

  const {
    claudeRunController,
    taskObserver,
    claudeTurnLauncher,
    runRecovery,
    selectedTaskWatch,
  } = createRunObservationComposition({
    ...observation,
    handleClaudeStreamEvent,
    finishClaudeRun,
    persistClaudeRunHistory,
  });

  async function startClaudeTurn(run, input, temporaryFiles, { forceSpeechButton = false } = {}) {
    return claudeTurnLauncher.start(run, input, temporaryFiles, { forceSpeechButton });
  }

  async function stopClaudeRunProcess(run) {
    const pid = Number(run?.pid ?? run?.process?.pid);
    const stopped = await claudeRunController.stop(run);
    if (!stopped) logger.error(`Cannot stop Claude process tree ${pid}`);
    return stopped;
  }

  async function attachClaudeRunAfterRestart(run) {
    await claudeRunController.attachAfterRestart(run);
  }

  async function handleCodexMessage(message) {
    return codexEventService.handle(message);
  }

  function completedCodexAnswer(...args) {
    return codexTaskSnapshots.completedAnswer(...args);
  }

  function applyCodexObservedSnapshot(...args) {
    return codexTaskSnapshots.applyObserved(...args);
  }

  function applyCodexActiveSnapshot(...args) {
    return codexTaskSnapshots.applyActive(...args);
  }

  async function readCodexTaskSnapshot(run, { threadResult = null, fresh = false } = {}) {
    return codexTaskSnapshots.read(run, { threadResult, fresh });
  }

  async function auditRecentCodexTerminalTurns() {
    if (isStopping() || !codexTransport.running) return;
    try {
      const changed = await codexTerminalAudit.run();
      if (changed) await saveState();
    } catch (error) {
      logger.error("Cannot audit Codex terminal turns:", error.message);
    }
  }

  function scheduleCodexTerminalAudit(delayMs = terminalAuditIntervalMs) {
    if (!terminalAuditEnabled || isStopping()) return;
    runtimeTimers.schedule("codex-terminal-audit", async () => {
      await auditRecentCodexTerminalTurns();
      scheduleCodexTerminalAudit();
    }, Math.max(0, Number(delayMs) || 0));
  }

  return {
    claudeRunController,
    taskObserver,
    runRecovery,
    selectedTaskWatch,
    persistManagedRunHistory,
    persistClaudeRunHistory,
    startClaudeTurn,
    stopClaudeRunProcess,
    attachClaudeRunAfterRestart,
    handleCodexMessage,
    completedCodexAnswer,
    applyCodexObservedSnapshot,
    applyCodexActiveSnapshot,
    readCodexTaskSnapshot,
    scheduleCodexTerminalAudit,
  };
}
