import { buildClaudePrompt } from "../providers/claude/claude.mjs";
import { createRunObservationComposition } from "./run-observation-composition.mjs";

export function createCodexTerminalAuditScheduler({
  codexTerminalAudit,
  codexTransport,
  saveState,
  isStopping,
  runtimeTimers,
  terminalAuditIntervalMs = 30_000,
  terminalAuditCatchUpIntervalMs = 1_000,
  terminalAuditEnabled = true,
  logger = console,
}) {
  async function auditNow() {
    if (isStopping()) return false;
    try {
      let changed = false;
      if (codexTransport.running) {
        changed = await codexTerminalAudit.run();
      } else if (codexTerminalAudit.hasPendingHistoricalMaintenance?.()) {
        // Historical migration reads retained rollout files only. It must be
        // able to checkpoint while the provider transport is reconnecting.
        changed = await codexTerminalAudit.runHistoricalMaintenance({
          localOnlyAccounting: true,
        });
      }
      if (changed && !codexTerminalAudit.persistsProgress) await saveState();
      return changed;
    } catch (error) {
      logger.error("Cannot audit Codex terminal turns:", error.message);
      return false;
    }
  }

  function schedule(delayMs = terminalAuditIntervalMs) {
    if (!terminalAuditEnabled || isStopping()) return false;
    return runtimeTimers.schedule("codex-terminal-audit", async () => {
      const progressed = await auditNow();
      const catchingUp = progressed && codexTransport.running
        && codexTerminalAudit.lastRun?.backlog === true;
      schedule(catchingUp
        ? Math.max(250, Number(terminalAuditCatchUpIntervalMs) || 1_000)
        : terminalAuditIntervalMs);
    }, Math.max(0, Number(delayMs) || 0));
  }

  return { auditNow, schedule };
}

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
  attachmentImporter,
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

  function importCodexAssistantAttachments(...args) {
    return attachmentImporter(...args);
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

  // Отправка в идущий ход Claude: прерывание и продолжение тем же процессом.
  // Без живого управляемого хода канала нет, и координатор оставит сообщение в очереди.
  async function steerClaudeTurn({ run, input }) {
    if (!run) throw new Error("Active turn not steerable: no active Claude run");
    return claudeRunController.steer(run, buildClaudePrompt(input));
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

  const terminalAuditScheduler = createCodexTerminalAuditScheduler({
    codexTerminalAudit,
    codexTransport,
    saveState,
    isStopping,
    runtimeTimers,
    terminalAuditIntervalMs,
    terminalAuditEnabled,
    logger,
  });

  return {
    claudeRunController,
    taskObserver,
    runRecovery,
    selectedTaskWatch,
    persistManagedRunHistory,
    persistClaudeRunHistory,
    importCodexAssistantAttachments,
    startClaudeTurn,
    steerClaudeTurn,
    stopClaudeRunProcess,
    attachClaudeRunAfterRestart,
    handleCodexMessage,
    completedCodexAnswer,
    applyCodexObservedSnapshot,
    applyCodexActiveSnapshot,
    readCodexTaskSnapshot,
    scheduleCodexTerminalAudit: terminalAuditScheduler.schedule,
  };
}
