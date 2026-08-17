import { appendRunActivity } from "../domain/run-activity.mjs";
import { providerThreadKey } from "../domain/workspace-stream-identity.mjs";
import { ClaudeEventService } from "../providers/claude/claude-event-service.mjs";
import { ClaudeTaskSnapshotService } from "../providers/claude/claude-task-snapshot-service.mjs";
import {
  codexObservedRuntimeActive,
  resolveCodexObservedExecutionOwner,
} from "../providers/codex/codex-runtime-owner.mjs";
import {
  CodexTaskSnapshotService,
  codexTurnSnapshot,
  codexTurnStartedAt,
  describeCodexItem,
} from "../providers/codex/codex-task-snapshot-service.mjs";
import {
  codexRolloutTurnState,
  readCodexRolloutActivity,
  selectCodexTurn,
} from "../providers/codex/codex-rollout-activity.mjs";
import {
  claudeSnapshotActivityAtMs,
  claudeSnapshotActivityState,
} from "../providers/claude/claude-task-activity.mjs";
import {
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
} from "../domain/task-execution-owner.mjs";

export function createProviderSnapshotComposition({
  readClaudeSessionSnapshot,
  findProject,
  saveState,
  cancelledManagedClaudeTasks,
  isSelectedRun,
  taskRuns,
  hostState,
  selectionStore,
  workspaceCatalogStore,
  runTaskTitle,
  bindRunMessage,
  taskProgress,
  knownCodexRolloutPath,
  capturedCodexExecutionOwner,
  readCodexThread,
  codexTransportPid,
  codexModelLabel,
  reasoningLabels,
  trackClaudeContextUsage = () => {},
  invalidateTaskCatalog,
  delay,
}) {
  const claudeTaskSnapshots = new ClaudeTaskSnapshotService({
    readSession: readClaudeSessionSnapshot,
    findProject,
    cancellationKey: providerThreadKey,
    activityAtMs: claudeSnapshotActivityAtMs,
    activityState: claudeSnapshotActivityState,
    saveState,
    cancelledTasks: cancelledManagedClaudeTasks,
    logError: (...args) => console.error(...args),
  });
  const claudeEventService = new ClaudeEventService({
    isSelectedRun,
    reindexRun: (run, previous) => taskRuns.reindex(run, previous),
    invalidateCatalog: invalidateTaskCatalog,
    setSelectedThread: (threadId, title) => {
      const streamId = selectionStore.streamId;
      selectionStore.setThread(threadId, { provider: "claude", streamId, title });
      if (streamId && threadId && !workspaceCatalogStore.thread({ provider: "claude", threadId })) {
        workspaceCatalogStore.bindThread({
          provider: "claude",
          threadId,
          streamId,
          projectRoot: selectionStore.activeProjectRoot,
          source: "created",
        });
      }
    },
    retargetClientSelection: (run, threadId, title) => {
      if (run?.clientSource !== "telegram" || !Number.isSafeInteger(run?.chatId)) return;
      const clientId = `telegram:${run.chatId}`;
      const current = hostState.clientTaskSelection(clientId);
      if (!current
        || current.provider !== "claude"
        || current.threadId
        || (current.streamId && run.streamId && current.streamId !== run.streamId)) return;
      hostState.setClientTaskSelection(clientId, {
        ...current,
        streamId: run.streamId ?? current.streamId ?? null,
        threadId,
        taskTitle: title,
      });
    },
    runTitle: runTaskTitle,
    bindRunMessage,
    saveState,
    noteActivity: (...args) => taskProgress().noteActivity(...args),
    scheduleProgress: (...args) => taskProgress().schedule(...args),
    appendReasoning: (...args) => taskProgress().appendReasoning(...args),
    setStage: (...args) => taskProgress().setStage(...args),
    appendActivity: appendRunActivity,
    trackContextUsage: trackClaudeContextUsage,
    logError: (...args) => console.error(...args),
  });
  const codexTaskSnapshots = new CodexTaskSnapshotService({
    knownRolloutPath: knownCodexRolloutPath,
    readRolloutActivity: readCodexRolloutActivity,
    rolloutTurnState: codexRolloutTurnState,
    capturedOwner: capturedCodexExecutionOwner,
    runtimeActive: codexObservedRuntimeActive,
    resolveOwner: resolveCodexObservedExecutionOwner,
    readThread: readCodexThread,
    selectTurn: selectCodexTurn,
    turnSnapshot: codexTurnSnapshot,
    turnStartedAt: codexTurnStartedAt,
    describeItem: describeCodexItem,
    hubOwner: () => TASK_EXECUTION_OWNERS.HUB,
    agentHubPid: codexTransportPid,
    modelLabel: codexModelLabel,
    reasoningLabels,
    runtimeLabel: taskExecutionRuntimeLabel,
    delay,
    reindexRun: (run) => taskRuns.reindex(run),
    logger: console,
  });
  return { claudeTaskSnapshots, claudeEventService, codexTaskSnapshots };
}
