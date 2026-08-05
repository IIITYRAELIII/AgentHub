import { appendRunActivity } from "../domain/run-activity.mjs";
import { taskRunKey } from "../domain/task-runs.mjs";
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
  claudeSnapshotActivityAtMs,
  claudeSnapshotActivityState,
  codexRolloutTurnState,
  readCodexRolloutActivity,
  selectCodexTurn,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
} from "../../task-catalog.mjs";

export function createProviderSnapshotComposition({
  readClaudeSessionSnapshot,
  findProject,
  saveState,
  cancelledManagedClaudeTasks,
  isSelectedRun,
  taskRuns,
  selectionStore,
  runTaskTitle,
  bindRunMessage,
  taskProgress,
  knownCodexRolloutPath,
  capturedCodexExecutionOwner,
  readCodexThread,
  codexTransportPid,
  codexModelLabel,
  reasoningLabels,
  delay,
}) {
  const claudeTaskSnapshots = new ClaudeTaskSnapshotService({
    readSession: readClaudeSessionSnapshot,
    findProject,
    taskRunKey,
    activityAtMs: claudeSnapshotActivityAtMs,
    activityState: claudeSnapshotActivityState,
    saveState,
    cancelledTasks: cancelledManagedClaudeTasks,
    logError: (...args) => console.error(...args),
  });
  const claudeEventService = new ClaudeEventService({
    isSelectedRun,
    reindexRun: (run, previous) => taskRuns.reindex(run, previous),
    setSelectedThread: (threadId, title) => selectionStore.setThread(threadId, {
      provider: "claude",
      title,
    }),
    runTitle: runTaskTitle,
    bindRunMessage,
    saveState,
    noteActivity: (...args) => taskProgress().noteActivity(...args),
    scheduleProgress: (...args) => taskProgress().schedule(...args),
    appendReasoning: (...args) => taskProgress().appendReasoning(...args),
    setStage: (...args) => taskProgress().setStage(...args),
    appendActivity: appendRunActivity,
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
