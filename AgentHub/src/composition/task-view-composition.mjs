import { TaskViewController } from "../interfaces/telegram/task-view-controller.mjs";

export function createTaskViewComposition({
  ensureCodex,
  findCodexRolloutPath,
  readCodexThread,
  readCodexRolloutActivity,
  readCodexSnapshot,
  readClaudeSnapshot,
  attachmentImporter,
  taskSyncStore,
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
    ensureCodex,
    findCodexRolloutPath,
    readCodexThread,
    readCodexRolloutActivity,
    readCodexSnapshot,
    readClaudeSnapshot,
    attachmentImporter,
    taskSyncStore,
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
