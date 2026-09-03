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

  async plan(workspaceId) {
    const tasks = this.taskBoard.releaseTasks(workspaceId);
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
