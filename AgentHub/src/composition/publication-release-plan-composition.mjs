import path from "node:path";

import { TaskReleasePlanService } from "../application/task-release-plan-service.mjs";
import { loadConfig } from "../infrastructure/filesystem/config.mjs";
import { TaskGitWorkspaceService } from "../infrastructure/filesystem/task-git-workspace.mjs";
import { TaskBoardStore } from "../infrastructure/persistence/task-board-store.mjs";

export async function readCandidatePublicationReleasePlan(workspaceId, {
  load = loadConfig,
  createStore = (options) => new TaskBoardStore(options),
  createTaskGitWorkspaces = (options) => new TaskGitWorkspaceService(options),
} = {}) {
  const selectedWorkspace = String(workspaceId ?? "").trim();
  if (!selectedWorkspace) throw new Error("Publication release plan requires a Workspace");
  const config = await load();
  const store = createStore({
    databaseFile: path.join(config.dataDir, "journal.sqlite"),
    readOnly: true,
  });
  let tasks;
  try {
    tasks = store.releaseTasksSnapshot(selectedWorkspace);
  } finally {
    store.close();
  }
  const taskBoard = {
    releaseTasks(requestedWorkspace) {
      if (String(requestedWorkspace) !== selectedWorkspace) {
        throw new Error("Publication release plan Workspace changed");
      }
      return tasks;
    },
  };
  const planner = new TaskReleasePlanService({
    taskBoard,
    taskGitWorkspaces: createTaskGitWorkspaces({ dataDir: config.dataDir }),
  });
  return planner.plan(selectedWorkspace);
}
