import { TaskIdentityResolver } from "../application/task-identity-resolver.mjs";

export function createTaskStateWiring({
  taskCatalogService,
  taskSyncStore,
  selectionStore,
  projects,
  findContainingProject,
  taskCatalog,
  catalogEntryIsSelected,
  taskRuns,
  taskMetadata,
  agentPreferences,
  currentChatId,
  contextualCallback,
  samePath,
  taskDiffs,
  logger = console,
  contourCommandMapping = null,
}) {
  const identity = new TaskIdentityResolver({
    canonicalProjectRoot: contourCommandMapping?.canonicalPath,
    selectionStore,
    projects,
    findContainingProject,
    catalogEntries: taskCatalog,
    catalogEntryIsSelected,
    taskRuns,
    taskMetadata,
    preferences: agentPreferences,
    currentChatId,
    contextualCallback,
    samePath,
  });

  function invalidateTaskCatalog() {
    taskCatalogService.invalidate();
  }

  async function syncTaskRun(run, {
    active = run?.status === "running",
    stage = run?.progressStage,
    answer = run?.responseText,
    activityAtMs = Date.parse(run?.lastMeaningfulProgressAt ?? run?.startedAt ?? "") || Date.now(),
  } = {}) {
    if (!run?.provider || !run?.threadId) return;
    try {
      const changed = await taskSyncStore.recordSnapshot(run, {
        active,
        turnId: run.turnId,
        model: run.model,
        activityAtMs,
        stage,
        answer,
        executionOwner: run.executionOwner,
      }, {
        executionOwner: run.executionOwner,
      });
      if (changed) {
        invalidateTaskCatalog();
      }
    } catch (error) {
      logger.error("Cannot save local task sync:", error.message);
    }
  }

  async function persistTaskDiff(key, value) {
    taskDiffs.remember(key, value);
    try {
      await taskDiffs.set(key, value);
    } catch (error) {
      logger.error("Cannot persist task diff:", error.message);
    }
  }

  return {
    invalidateTaskCatalog,
    syncTaskRun,
    persistTaskDiff,
    findProject: (...args) => identity.findProject(...args),
    activeProject: (...args) => identity.activeProject(...args),
    selectedTask: (...args) => identity.selectedTask(...args),
    selectedTurnTarget: (...args) => identity.selectedTurnTarget(...args),
    currentUiContextToken: (...args) => identity.currentUiContextToken(...args),
    uiCallback: (...args) => identity.uiCallback(...args),
    selectedRun: (...args) => identity.selectedRun(...args),
    isSelectedRun: (...args) => identity.isSelectedRun(...args),
    runProject: (...args) => identity.runProject(...args),
    runTaskTitle: (...args) => identity.runTaskTitle(...args),
    pinnedTaskTitle: (...args) => identity.pinnedTaskTitle(...args),
    pinTaskTitle: (...args) => identity.pinTaskTitle(...args),
    pendingTaskTitle: (...args) => identity.pendingTaskTitle(...args),
    expectTaskTitleConfirmation: (...args) => identity.expectTaskTitleConfirmation(...args),
  };
}
