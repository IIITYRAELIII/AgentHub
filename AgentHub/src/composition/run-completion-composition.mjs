import { ManagedRunLifecycleService } from "../application/managed-run-lifecycle-service.mjs";
import { TurnEndDeliveryService } from "../application/turn-end-delivery-service.mjs";
import { CodexRunFinalizer } from "../providers/codex/codex-run-finalizer.mjs";
import { captureTaskGitBaseline } from "../infrastructure/filesystem/task-git-diff.mjs";
import { taskRunKey } from "../domain/task-runs.mjs";

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
    modelLabel: codexModelLabel,
    claudeModelLabels,
    reasoningLabels,
    clearClaudeCancellation: (key) => cancelledManagedClaudeTasks.delete(key),
    captureGitBaseline: (projectRoot, runId) => (
      captureTaskGitBaseline(projectRoot, config.dataDir, runId)
    ),
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
    afterCompletion,
  });

  const turnEndDelivery = new TurnEndDeliveryService({
    notifications: turnEndNotifications,
    taskRuns,
    projectTurn: (...args) => runJournal.projectTurn(...args),
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
    persistHistory: persistManagedRunHistory,
    projectTurn: (...args) => runJournal.projectTurn(...args),
    completeRun: (run) => managedRunLifecycle.complete(run),
  });

  return { managedRunLifecycle, turnEndDelivery, codexRunFinalizer };
}
