import { taskReleasePlan } from "../domain/task-release-snapshot.mjs";

export class TaskReleasePlanService {
  constructor({ taskBoard, taskGitWorkspaces } = {}) {
    if (typeof taskBoard?.releaseTasks !== "function") throw new TypeError("taskBoard.releaseTasks is required");
    if (typeof taskGitWorkspaces?.releaseEvidence !== "function") {
      throw new TypeError("taskGitWorkspaces.releaseEvidence is required");
    }
    this.taskBoard = taskBoard;
    this.taskGitWorkspaces = taskGitWorkspaces;
  }

  async plan(workspaceId, { acceptingTask = null } = {}) {
    let tasks = this.taskBoard.releaseTasks(workspaceId);
    if (acceptingTask) {
      const current = tasks.find((task) => task.id === acceptingTask.id);
      if (!current || current.revision !== acceptingTask.revision
          || !["testing", "awaiting_implementation"].includes(current.workflowStatus)
          || current.status === "done") {
        throw new Error("Task changed before PreRelease acceptance preparation");
      }
      // Project the one future SQLite CAS without exposing Await before Git succeeds.
      tasks = tasks.map((task) => task.id === current.id ? {
        ...task, workflowStatus: "awaiting_implementation", revision: task.revision + 1,
        releaseRevision: (task.releaseRevision ?? task.revision)
          + (task.workflowStatus === "awaiting_implementation" ? 0 : 1),
      } : task);
    }
    const resolved = [];
    for (const task of tasks) {
      const changedFiles = [];
      let gitError = null;
      try {
        for (const reference of task.gitReferences ?? []) {
          const evidence = await this.taskGitWorkspaces.releaseEvidence({
            taskId: task.id,
            ...(task.taskNumber ? { taskNumber: task.taskNumber } : {}),
            ...reference,
          });
          changedFiles.push(...evidence.changedFiles);
        }
      } catch (error) {
        gitError = error.message;
      }
      resolved.push({ ...task, changedFiles, gitError });
    }
    return taskReleasePlan(workspaceId, resolved);
  }
}
