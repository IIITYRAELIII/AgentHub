import { ManagedRunLifecycleService } from "../application/managed-run-lifecycle-service.mjs";
import { TerminalTurnCommitService } from "../application/terminal-turn-commit-service.mjs";
import { TurnEndDeliveryService } from "../application/turn-end-delivery-service.mjs";
import { CodexRunFinalizer } from "../providers/codex/codex-run-finalizer.mjs";
import { ProviderTurnTerminalStore } from "../infrastructure/persistence/provider-turn-terminal-store.mjs";
import { taskRunKey } from "../domain/task-runs.mjs";
import { providerThreadKey } from "../domain/workspace-stream-identity.mjs";

function setBoundedMapValue(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

export function createRunCompletionComposition({
  config,
  taskRuns,
  currentTarget,
  findProject,
  taskMetadata,
  agentPreferences,
  normalizeCodexModel,
  codexModelLabel,
  claudeModelLabels,
  reasoningLabels,
  cancelledManagedClaudeTasks,
  persistTaskDiff,
  syncTaskRun,
  invalidateTaskCatalog,
  saveState,
  scheduleProgressStart,
  clearSelectedDiff,
  clearApprovals,
  pauseObservation,
  pauseClaude,
  stopTyping,
  beforeCompletion,
  completionAborted,
  afterCompletion,
  turnEndNotifications,
  runJournal,
  lastSeenTaskTurnIds,
  codexTurnStarts,
  discardContextCompactionRun,
  finalizeRunDelivery,
  refreshTaskDiff,
  runTaskTitle,
  currentChatId,
  defaultNotificationChatId,
  changedFilesForRun,
  persistManagedRunHistory,
  runtimeStateStore,
  commandTrace = null,
}) {
  const managedRunLifecycle = new ManagedRunLifecycleService({
    taskRuns,
    currentTarget,
    findProject,
    codexSettings: (target) => taskMetadata.codexSettings(target),
    currentPreferences: (provider) => ({
      ...agentPreferences.current(provider),
      defaultModel: provider === "codex"
        ? agentPreferences.defaultCodexModel
        : agentPreferences.claudeModel,
      defaultReasoningEffort: provider === "codex"
        ? agentPreferences.defaultCodexReasoningEffort
        : agentPreferences.claudeReasoningEffort,
    }),
    normalizeCodexModel,
    modelLabel: codexModelLabel,
    claudeModelLabels,
    reasoningLabels,
    clearClaudeCancellation: (task) => cancelledManagedClaudeTasks.delete(providerThreadKey(task)),
    persistTaskDiff,
    syncRun: syncTaskRun,
    invalidateCatalog: invalidateTaskCatalog,
    saveState,
    scheduleProgressStart,
    clearSelectedDiff,
    clearApprovals,
    pauseObservation,
    pauseClaude,
    stopTyping,
    beforeCompletion,
    completionAborted,
    afterCompletion,
    commandTrace,
  });

  const terminalStore = new ProviderTurnTerminalStore({ dataDir: config.dataDir });
  const terminalCommits = new TerminalTurnCommitService({
    store: terminalStore,
    messageCommands: runtimeStateStore,
    commandTrace,
  });

  const turnEndDelivery = new TurnEndDeliveryService({
    notifications: turnEndNotifications,
    terminalCommits,
    taskRuns,
    persistHistory: persistManagedRunHistory,
    projectTurn: (...args) => runJournal.projectTurn(...args),
    finalizeRunDelivery,
    rememberLastMessage: (...args) => runJournal.rememberLastMessage(...args),
    rememberSeenTurn: (task, turnId) => {
      setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey(task), turnId, 500);
    },
    saveState,
  });

  const codexRunFinalizer = new CodexRunFinalizer({
    turnStarts: codexTurnStarts,
    notifications: turnEndNotifications,
    discardContextCompaction: discardContextCompactionRun,
    finalizeRunDelivery,
    refreshTaskDiff,
    runTitle: runTaskTitle,
    currentChatId,
    defaultNotificationChatId,
    changedFiles: changedFilesForRun,
    saveState,
    commandTrace,
    commitTerminal: (...args) => turnEndDelivery.commit(...args),
    deliverTerminal: (...args) => turnEndDelivery.deliverOutbox(...args),
    markRunCompleted: (run) => managedRunLifecycle.markCompleted(run),
    completeRun: (run) => managedRunLifecycle.complete(run),
  });

  return {
    managedRunLifecycle,
    terminalStore,
    terminalCommits,
    turnEndDelivery,
    codexRunFinalizer,
  };
}
