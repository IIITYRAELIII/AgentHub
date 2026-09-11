import { createContourClaudeAuthority } from "../runtime/test-contour-runtime-effects.mjs";
import { ClaudeRunController } from "../providers/claude/claude-run-controller.mjs";
import { ClaudeTurnLauncher } from "../providers/claude/claude-turn-launcher.mjs";
import { TaskObservationService } from "../application/task-observation-service.mjs";
import { SelectedTaskWatchService } from "../application/selected-task-watch-service.mjs";
import { RunRecoveryCoordinator } from "../application/run-recovery-coordinator.mjs";
import { resolveHubDeveloperInstructions } from "./hub-developer-instructions-composition.mjs";

export function createRunObservationComposition({
  dataDir,
  recordingContourRoot = null,
  claudeOutputPollIntervalMs,
  taskRuns,
  isStopping,
  handleClaudeStreamEvent,
  finishClaudeRun,
  saveState,
  startTyping,
  taskProgress,
  agentProviders,
  runCoordinator,
  findProject,
  invalidateTaskCatalog,
  syncTaskRun,
  codexModelLabel,
  reasoningLabels,
  markProgressHeartbeat,
  progressStalledAfterMs,
  managedRunLifecycle,
  discardContextCompactionRun,
  savedLastTaskMessage,
  savedLastTaskMessageRecord,
  externalPollIntervalMs,
  managedPollIntervalMs,
  turnTemporaryFiles,
  claudeTaskSnapshots,
  claudePermissionMode,
  autoApprove,
  persistClaudeRunHistory,
  resolveClaudeInvocation,
  hubMcpServer,
  hubMcpService,
  workspaceCatalogStore,
  preTurnInstructions,
  logWarning,
  safelyDeliverRunMessage,
  sendRunMessage,
  dismissedExternalTasks,
  lastSeenTaskTurnIds,
  runtimeTimers,
  selectedTaskWatchIntervalMs,
  selectedTask,
  selectedTasks,
  chatId,
  activeTaskTitle,
  rememberLastTaskMessage,
  logError,
}) {
  const claudeRunController = new ClaudeRunController({
    dataDir,
    processAuthority: recordingContourRoot ? createContourClaudeAuthority({ root: recordingContourRoot, dataDir }) : null,
    onRecoveryUnavailable: (run) => runRecovery.finishInterrupted(run),
    pollIntervalMs: claudeOutputPollIntervalMs,
    isCurrentRun: (run) => taskRuns.forTask(run) === run,
    isStopping,
    onStreamEvent: handleClaudeStreamEvent,
    onComplete: finishClaudeRun,
    onPersist: saveState,
    onActive: startTyping,
    onReconnect: (run, alive) => taskProgress.setStage(run, alive
      ? "Переподключился к выполняющемуся ходу Claude."
      : "Дочитываю прерванный ход Claude…"),
  });

  const taskObserver = new TaskObservationService({
    providers: agentProviders,
    taskRuns,
    runCoordinator,
    findProject,
    invalidateTaskCatalog,
    syncTaskRun,
    modelLabel: codexModelLabel,
    reasoningLabels,
    noteRunActivity: (...args) => taskProgress.noteActivity(...args),
    scheduleProgressUpdate: (...args) => taskProgress.schedule(...args),
    setProgressStage: (...args) => taskProgress.setStage(...args),
    markProgressHeartbeat,
    progressHeartbeatState: (run, now) => taskProgress.heartbeatState(
      run,
      now,
      progressStalledAfterMs,
    ),
    finishProgress: (...args) => taskProgress.finish(...args),
    completeRun: (run) => managedRunLifecycle.complete(run),
    discardContextCompactionRun,
    savedLastTaskMessage,
    savedLastTaskMessageRecord,
    interstreamOriginForClientMessage: (clientUserMessageId) => (
      workspaceCatalogStore.interstreamOriginForClientMessage(clientUserMessageId)
    ),
    externalPollIntervalMs,
    managedPollIntervalMs,
  });

  const claudeTurnLauncher = new ClaudeTurnLauncher({
    recordingContourRoot,
    taskRuns,
    turnTemporaryFiles,
    taskSnapshots: claudeTaskSnapshots,
    permissionMode: claudePermissionMode,
    autoApprove,
    persistHistory: persistClaudeRunHistory,
    resolveInvocation: resolveClaudeInvocation,
    mcpConfig: () => hubMcpServer.claudeConfig(),
    developerContext: ({ threadId, streamId }) => resolveHubDeveloperInstructions({
      provider: "claude",
      threadId,
      streamId,
      workspaceCatalogStore,
      preTurnInstructions,
      hubMcpService,
    }),
    runController: claudeRunController,
    logWarning,
  });

  const runRecovery = new RunRecoveryCoordinator({
    taskRuns,
    providers: agentProviders,
    runCoordinator,
    observer: taskObserver,
    progress: taskProgress,
    startTyping,
    saveState,
    safeDeliver: safelyDeliverRunMessage,
    sendRunMessage,
    completeRun: (run) => managedRunLifecycle.complete(run),
    logError,
  });

  const selectedTaskWatch = new SelectedTaskWatchService({
    providers: agentProviders,
    taskRuns,
    dismissedTasks: dismissedExternalTasks,
    lastSeenTurnIds: lastSeenTaskTurnIds,
    timers: runtimeTimers,
    intervalMs: selectedTaskWatchIntervalMs,
    isStopping,
    selectedTask,
    selectedTasks,
    chatId,
    activeTaskTitle,
    rememberLastTaskMessage,
    createObservedRun: (...args) => taskObserver.create(...args),
    scheduleObservedRun: (...args) => taskObserver.schedule(...args),
    saveState,
    shouldWatchTask: (task) => workspaceCatalogStore.thread({
      provider: task.provider,
      threadId: task.threadId,
    })?.detachedAtMs == null,
  });

  return {
    claudeRunController,
    taskObserver,
    claudeTurnLauncher,
    runRecovery,
    selectedTaskWatch,
  };
}
