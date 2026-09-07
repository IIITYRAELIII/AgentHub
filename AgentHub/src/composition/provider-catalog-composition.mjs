import path from "node:path";

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
  mergeTaskCatalog,
} from "../application/task-catalog-projection.mjs";
import {
  preferredCodexTaskTitle,
} from "../domain/task-catalog-titles.mjs";
import {
  catalogEntriesWithoutLiveActivity,
  codexCatalogEntry,
  readCodexRolloutActivity,
  selectExactActiveCodexTurnId,
} from "../providers/codex/codex-rollout-activity.mjs";
import { catalogTaskKey } from "../domain/task-catalog-identity.mjs";
import { TASK_EXECUTION_OWNERS } from "../domain/task-execution-owner.mjs";
import { claudeCatalogEntry } from "../providers/claude/claude-task-activity.mjs";
import { listClaudeSessionSnapshots } from "../providers/claude/claude-session-reader.mjs";

export function currentStreamEntries(entries) {
  const byIdentity = new Map();
  for (const entry of entries) {
    const key = entry.streamId && entry.provider && entry.threadId
      ? `stream:${entry.streamId}:${entry.provider}:${entry.threadId}`
      : entry.streamId ? `stream:${entry.streamId}` : `${entry.provider}:${entry.threadId}`;
    const previous = byIdentity.get(key);
    if (!previous
      || (entry.running === true && previous.running !== true)
      || (entry.running === previous.running
        && (Number(entry.threadPosition) || 1) > (Number(previous.threadPosition) || 1))) {
      byIdentity.set(key, entry);
    }
  }
  return [...byIdentity.values()];
}

export function currentWorkspaceThreadEntries(workspaceCatalogStore) {
  const workspaces = workspaceCatalogStore?.hierarchy?.() ?? [];
  return workspaces.flatMap((workspace) => (workspace.streams ?? []).flatMap((stream) => {
    const thread = (stream.threads ?? []).at(-1);
    if (!thread) return [];
    return [{
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceKind: workspace.kind,
      streamId: stream.id,
      streamName: stream.name ?? null,
      streamDisplayName: stream.displayName ?? "",
      streamOrdinal: Number(stream.ordinal) || 1,
      threadPosition: Number(thread.position) || 1,
      provider: thread.provider,
      threadId: thread.threadId,
      projectRoot: thread.projectRoot ?? "",
      projectName: path.basename(thread.projectRoot ?? "") || "Проект",
      title: "",
      model: null,
      updatedAtMs: 0,
      running: false,
    }];
  }));
}

export function createProviderCatalogComposition({
  taskSyncStore,
  workspaceCatalogStore,
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
  steerClaudeTurn = null,
  claudeTaskSnapshots,
  claudeRuntimeOwner,
  claudeRunAdmission,
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
  providerTurnTelemetryStore = null,
  terminalCommits = null,
  commandTrace = null,
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
    telemetryStore: providerTurnTelemetryStore,
    terminalCommits,
    commandTrace,
  });
  if (typeof claudeRuntimeOwner?.state !== "function") {
    throw new TypeError("claudeRuntimeOwner is required");
  }
  if (typeof claudeRunAdmission?.consumeLaunch !== "function") {
    throw new TypeError("claudeRunAdmission is required");
  }
  const providerTaskActivity = new ProviderTaskActivityService({
    knownCodexRolloutPath,
    codexRunning: codexTransportRunning,
    codexPid: codexTransportPid,
    ensureCodex,
    readCodexThread,
    capturedCodexExecutionOwner,
    claudeTaskSnapshots,
    claudeRuntimeState: (snapshot, options) => claudeRuntimeOwner.state(snapshot, options),
    readRolloutActivity: readCodexRolloutActivity,
    selectActiveTurnId: selectExactActiveCodexTurnId,
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
      findCodexTurnByClientMessage: (...args) => codexTurnService.findByClientMessage(...args),
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
      launchClaudeTurn: (run, input, temporaryFiles, options = {}) => {
        const { launchAdmission, ...providerOptions } = options;
        claudeRunAdmission.consumeLaunch(run, "claude", launchAdmission);
        return startClaudeTurn(run, input, temporaryFiles, providerOptions);
      },
      steerClaudeTurn: (...args) => (steerClaudeTurn ?? unsupportedProviderSteer)(...args),
      cancelClaudeProviderRun: (...args) => providerCancellationService.cancelClaude(...args),
      readClaudeTaskActivity: (target, options) => providerTaskActivity.readClaude(target, options),
      readClaudeTaskSnapshot: (...args) => claudeTaskSnapshots.read(...args),
      completeObservedClaudeRun: (...args) => claudeCompletionService.completeObserved(...args),
      completeManagedClaudeRun: (...args) => claudeCompletionService.completeManaged(...args),
      recoverClaudeRun: (...args) => claudeRecoveryService.recover(...args),
    },
  });
  const providerTaskCatalogBuilder = new ProviderTaskCatalogBuilder({
    durableEntries: async () => currentStreamEntries(await workspaceCatalogStore.assignCatalogEntries(
      [
        ...catalogEntriesWithoutLiveActivity(taskSyncStore.catalog()),
        ...currentWorkspaceThreadEntries(workspaceCatalogStore),
      ],
    )),
    sources: agentProviders.catalogSources(),
    managedRuns: () => taskRuns.values().map((run) => ({
      ...run,
      projectName: runProject(run).name,
    })),
    merge: mergeTaskCatalog,
    finalize: async (entries, context) => finalizeTaskCatalog(
      currentStreamEntries(await workspaceCatalogStore.assignCatalogEntries(entries)),
      context,
    ),
    onSourceError: ({ name, reason }) => {
      console.error(`Cannot discover ${name} tasks:`, reason?.message ?? reason);
    },
  });
  const taskCatalogService = new TaskCatalogService({
    initialEntries: currentStreamEntries([
      ...catalogEntriesWithoutLiveActivity(taskSyncStore.catalog()),
      ...currentWorkspaceThreadEntries(workspaceCatalogStore),
    ]),
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
