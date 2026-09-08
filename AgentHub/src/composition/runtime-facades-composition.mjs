import { emptyTokenUsage } from "../domain/token-usage.mjs";

export function createRuntimeFacadesComposition({
  sendTaskSelection,
  currentChatId,
  runJournal,
  deferredInputs,
  codexUsageTracker,
  codexRunFinalizer,
  turnEndDelivery,
  agentPreferences,
  journalBackfill,
  claudeTranscriptAudit,
  taskCatalogFinalization,
  taskCatalogService,
}) {
  function sendTaskSelectionNotification(options = {}) {
    return sendTaskSelection({ targetChatId: currentChatId(), ...options });
  }

  return {
    setBoundedMapValue(map, key, value, limit) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    sendTaskSelectionNotification,
    sendTaskSwitchNotification(options = {}) {
      return sendTaskSelectionNotification(options);
    },
    sendTaskAlreadySelectedNotification(options = {}) {
      return sendTaskSelectionNotification({ ...options, alreadySelected: true });
    },
    rememberLastTaskMessage(run, text, options = {}) {
      return runJournal.rememberLastMessage(run, text, options);
    },
    savedLastTaskMessage(task) {
      return runJournal.lastMessage(task);
    },
    savedLastTaskMessageRecord(task) {
      return runJournal.lastMessageRecord(task);
    },
    lastTaskMessageRevision() {
      return runJournal.revision;
    },
    deferredTaskMessageAtMs(task) {
      return deferredInputs.latestActivityAt(task);
    },
    latestThreadContextUsage(contextThreadId, contextTurnId = "") {
      return codexUsageTracker.latestContext(contextThreadId, contextTurnId);
    },
    trackTurnTokenUsage(params, options = {}) {
      return codexUsageTracker.track(params, options);
    },
    consumeTurnTokenTracker(turnId) {
      return codexUsageTracker.consume(turnId);
    },
    finalizeCodexRunDelivery(run, {
      answer,
      turnId: completedTurnId = run?.turnId,
      status = "completed",
      tracker = { usage: emptyTokenUsage(), reported: false },
      forceSpeechButton = false,
      deliver,
      silent = false,
      description = "финальный ответ Codex",
    } = {}) {
      return codexRunFinalizer.finalize(run, {
        answer,
        turnId: completedTurnId,
        status,
        tracker,
        forceSpeechButton,
        deliver,
        silent,
        description,
      });
    },
    deliverTurnEndNotification(completion) {
      return turnEndDelivery.deliver(completion);
    },
    repairTurnEndAttachments(identity, options) {
      return turnEndDelivery.reconcileResponseAttachments(identity, options);
    },
    retryPendingTurnEndNotifications() {
      return turnEndDelivery.retryPending();
    },
    waitForTurnEndCompletion(identity, timeoutMs = 2_000) {
      return turnEndDelivery.waitForCompletion(identity, timeoutMs);
    },
    rememberCodexTaskSettings(...args) {
      return agentPreferences.rememberCodexTaskSettings(...args);
    },
    restoreCodexTaskSettings(...args) {
      return agentPreferences.restoreCodexTaskSettings(...args);
    },
    applyCodexThreadSettings(...args) {
      return agentPreferences.applyCodexThreadSettings(...args);
    },
    backfillWorkLogPricingMetadata(codexThreads) {
      return journalBackfill.backfill(codexThreads);
    },
    auditClaudeTranscriptSnapshots(snapshots) {
      return claudeTranscriptAudit.audit(snapshots);
    },
    finalizeTaskCatalog(mergedEntries) {
      return taskCatalogFinalization.finalize(mergedEntries);
    },
    refreshTaskCatalog({ force = false } = {}) {
      return taskCatalogService.refresh({ force });
    },
  };
}
