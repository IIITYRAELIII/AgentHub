import { TaskViewController } from "../interfaces/telegram/task-view-controller.mjs";
import { recoverCodexRolloutSubagents } from "../providers/codex/codex-rollout-activity-worker-client.mjs";

export function createTaskViewComposition({
  ensureCodex,
  findCodexRolloutPath,
  readCodexThread,
  readCodexRolloutActivity,
  readCodexSnapshot,
  readClaudeSnapshot,
  attachmentImporter,
  taskSyncStore,
  workspaceCatalogStore,
  taskRuns,
  deleteTaskMessages,
  sendRunMessage,
  sendTaskViewText,
  runTaskTitle,
  savedLastTaskMessage,
  dismissedExternalTasks,
  saveState,
  resolveRunningTitle,
  taskProgress,
  taskObserver,
  findMessageBinding,
  taskCatalog,
  refreshTaskCatalog,
  selectedTask,
  activeThreadTitle,
  logger,
}) {
  let taskViewController;
  taskViewController = new TaskViewController({
    recoverCodexRolloutSubagents,
    ensureCodex,
    findCodexRolloutPath,
    readCodexThread,
    readCodexRolloutActivity,
    readCodexSnapshot,
    readClaudeSnapshot,
    attachmentImporter,
    taskSyncStore,
    workspaceCatalogStore,
    taskRuns,
    deleteTaskMessages,
    sendRunMessage,
    sendTaskViewText,
    runTaskTitle,
    savedLastTaskMessage,
    dismissedExternalTasks,
    saveState,
    resolveRunningTitle,
    startProgressMessage: (...args) => taskProgress.start(...args),
    createObservedRun: (...args) => taskObserver.create(...args),
    scheduleObservedRun: (...args) => taskObserver.schedule(...args),
    findMessageBinding,
    findCatalogEntry: async (identity) => {
      let entry = taskCatalog().find((item) => taskViewController.identityMatches(item, identity));
      if (!entry) {
        entry = (await refreshTaskCatalog())
          .find((item) => taskViewController.identityMatches(item, identity));
      }
      return entry ?? null;
    },
    selectedTask,
    activeThreadTitle,
    logger,
  });
  return taskViewController;
}
