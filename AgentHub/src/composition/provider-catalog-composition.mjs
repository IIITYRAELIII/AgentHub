import { ManagedRunHistoryService } from "../application/managed-run-history-service.mjs";
import { ProviderTaskActivityService } from "../application/provider-task-activity-service.mjs";
import { TaskCatalogService } from "../application/task-catalog-service.mjs";
import { mergeActiveTaskHistory } from "../application/task-history.mjs";
import { taskRunIsActive } from "../domain/task-runs.mjs";
import { ClaudeCatalogProjectionService, CodexCatalogProjectionService } from "../providers/provider-catalog-services.mjs";
import { createAgentProviderRegistry } from "../providers/provider-adapters.mjs";
import { ProviderTaskCatalogBuilder } from "../providers/provider-task-catalog-builder.mjs";
import { unsupportedProviderSteer } from "../providers/provider-turn-services.mjs";
import {
  catalogEntriesWithoutLiveActivity,
  codexCatalogEntry,
  mergeTaskCatalog,
  preferredCodexTaskTitle,
  readCodexRolloutActivity,
  selectExactActiveCodexTurnId,
} from "../../task-catalog.mjs";
import { catalogTaskKey } from "../domain/task-catalog-identity.mjs";
import { TASK_EXECUTION_OWNERS } from "../domain/task-execution-owner.mjs";
import { claudeCatalogEntry } from "../providers/claude/claude-task-activity.mjs";
import { listClaudeSessionSnapshots } from "../providers/claude/claude-session-reader.mjs";

export function createProviderCatalogComposition({
  taskSyncStore,
  taskRuns,
  taskCatalogCacheMs,
  runProject,
  finalizeTaskCatalog,
  findProject,
  saveState,
  codexProviderTasks,
  claudeProviderTasks,
  codexCompletionService,
  claudeCompletionService,
  codexRecoveryService,
  claudeRecoveryService,
  codexTurnService,
  providerCancellationService,
  readCodexTaskSnapshot,
  readCodexThread,
  applyCodexObservedSnapshot,
  applyCodexActiveSnapshot,
  startClaudeTurn,
  claudeTaskSnapshots,
  backfillWorkLogPricingMetadata,
  readCodexThreadTitleHistories,
  rememberCodexRolloutPath,
  capturedCodexExecutionOwner,
  codexObservedRuntimeActive,
  codexTransportPid,
  resolveCodexObservedExecutionOwner,
  codexModelLabel,
  codexThreadResponseTitle,
  pendingTaskTitle,
  clearExpectedTitle,
  pinnedTaskTitle,
  reconcilePinnedTitle,
  savePinnedTaskTitles,
  sendRpc,
  auditClaudeTranscriptSnapshots,
  knownCodexRolloutPath,
  codexTransportRunning,
  ensureCodex,
  resolveCodexTaskActivity,
  persistNow = () => new Date().toISOString(),
  clock = () => Date.now(),
}) {
  const codexCatalogProjection = new CodexCatalogProjectionService({
    backfillPricing: backfillWorkLogPricingMetadata,
    readTitleHistories: readCodexThreadTitleHistories,
    findProject,
    rememberRolloutPath: rememberCodexRolloutPath,
    readActivity: readCodexRolloutActivity,
    runForTask: (reference) => taskRuns.forTask(reference),
    selectActiveTurnId: selectExactActiveCodexTurnId,
    capturedOwner: capturedCodexExecutionOwner,
    runtimeActive: codexObservedRuntimeActive,
    agentHubPid: codexTransportPid,
    resolveOwner: resolveCodexObservedExecutionOwner,
    hubOwner: TASK_EXECUTION_OWNERS.HUB,
    catalogEntry: codexCatalogEntry,
    modelLabel: codexModelLabel,
    threadResponseTitle: codexThreadResponseTitle,
    confirmationKey: catalogTaskKey,
    expectedTitle: pendingTaskTitle,
    clearExpectedTitle,
    preferredTitle: preferredCodexTaskTitle,
    pinnedTitle: pinnedTaskTitle,
    setThreadName: (providerTaskId, name) => sendRpc("thread/name/set", {
      threadId: providerTaskId,
      name,
    }),
    reconcilePinnedTitle,
    savePinnedTitles: savePinnedTaskTitles,
    saveState,
  });
  const claudeCatalogProjection = new ClaudeCatalogProjectionService({
    audit: auditClaudeTranscriptSnapshots,
    findProject,
    applyManagedCancellation: (snapshot) => claudeTaskSnapshots.applyManagedCancellation(snapshot),
    catalogEntry: claudeCatalogEntry,
    logError: (...args) => console.error(...args),
  });
  const managedRunHistory = new ManagedRunHistoryService({
    taskSyncStore,
    mergeActiveHistory: mergeActiveTaskHistory,
    hubExecutionOwner: TASK_EXECUTION_OWNERS.HUB,
    nowIso: persistNow,
    nowMs: clock,
  });
  const providerTaskActivity = new ProviderTaskActivityService({
    knownCodexRolloutPath,
    codexRunning: codexTransportRunning,
    codexPid: codexTransportPid,
    ensureCodex,
    readCodexThread,
    capturedCodexExecutionOwner,
    claudeTaskSnapshots,
    resolveActivity: resolveCodexTaskActivity,
  });
  const agentProviders = createAgentProviderRegistry({
    taskRunIsActive,
    codex: {
      listAllCodexThreads: () => codexProviderTasks.discoverTasks(),
      buildCodexTaskCatalogEntries: (threads) => codexCatalogProjection.project(threads),
      createCodexTask: () => codexProviderTasks.createTask(),
      launchCodexTurn: (...args) => codexTurnService.launch(...args),
      steerCodexTurn: (...args) => codexTurnService.steer(...args),
      cancelCodexProviderRun: (...args) => providerCancellationService.cancelCodex(...args),
      readCodexTaskActivity: (target) => providerTaskActivity.readCodex(target),
      readCodexTaskSnapshot,
      completeObservedCodexRun: (...args) => codexCompletionService.completeObserved(...args),
      completeManagedCodexRun: (...args) => codexCompletionService.completeManaged(...args),
      recoverCodexRun: (...args) => codexRecoveryService.recover(...args),
      readCodexRecoverySnapshot: (...args) => codexRecoveryService.readSnapshot(...args),
      prepareCodexRecovery: (...args) => codexRecoveryService.prepare(...args),
      applyCodexObservedSnapshot,
      applyCodexActiveSnapshot,
    },
    claude: {
      listClaudeSessionSnapshots,
      buildClaudeTaskCatalogEntries: (snapshots) => claudeCatalogProjection.project(snapshots),
      createClaudeTask: () => claudeProviderTasks.createTask(),
      launchClaudeTurn: (...args) => startClaudeTurn(...args),
      steerClaudeTurn: unsupportedProviderSteer,
      cancelClaudeProviderRun: (...args) => providerCancellationService.cancelClaude(...args),
      readClaudeTaskActivity: (target) => providerTaskActivity.readClaude(target),
      readClaudeTaskSnapshot: (...args) => claudeTaskSnapshots.read(...args),
      completeObservedClaudeRun: (...args) => claudeCompletionService.completeObserved(...args),
      completeManagedClaudeRun: (...args) => claudeCompletionService.completeManaged(...args),
      recoverClaudeRun: (...args) => claudeRecoveryService.recover(...args),
    },
  });
  const providerTaskCatalogBuilder = new ProviderTaskCatalogBuilder({
    durableEntries: () => catalogEntriesWithoutLiveActivity(taskSyncStore.catalog()),
    sources: agentProviders.catalogSources(),
    managedRuns: () => taskRuns.values().map((run) => ({
      ...run,
      projectName: runProject(run).name,
    })),
    merge: mergeTaskCatalog,
    finalize: finalizeTaskCatalog,
    onSourceError: ({ name, reason }) => {
      console.error(`Cannot discover ${name} tasks:`, reason?.message ?? reason);
    },
  });
  const taskCatalogService = new TaskCatalogService({
    initialEntries: catalogEntriesWithoutLiveActivity(taskSyncStore.catalog()),
    cacheMs: taskCatalogCacheMs,
    build: () => providerTaskCatalogBuilder.build(),
  });
  return {
    managedRunHistory,
    agentProviders,
    taskCatalogService,
    taskCatalog: taskCatalogService.entries,
  };
}
