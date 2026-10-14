import { taskReleasePlan } from "../domain/task-release-snapshot.mjs";

export class TaskReleasePlanService {
  constructor({ taskBoard, taskGitWorkspaces } = {}) {
    if (typeof taskBoard?.releaseTasks !== "function") throw new TypeError("taskBoard.releaseTasks is required");
    if (typeof taskBoard?.selectedCompositionForRelease !== "function") {
      throw new TypeError("taskBoard.selectedCompositionForRelease is required");
    }
    if (typeof taskGitWorkspaces?.releaseEvidence !== "function") {
      throw new TypeError("taskGitWorkspaces.releaseEvidence is required");
    }
    this.taskBoard = taskBoard;
    this.taskGitWorkspaces = taskGitWorkspaces;
  }

  async plan(workspaceId, { acceptingTask = null, selectedTaskIds = null } = {}) {
    let tasks = this.taskBoard.releaseTasks(workspaceId);
    if (selectedTaskIds != null) {
      const selected = [...new Set((Array.isArray(selectedTaskIds) ? selectedTaskIds : [])
        .map((taskId) => String(taskId ?? "").trim()).filter(Boolean))];
      if (!selected.length) throw new Error("release operation requires at least one selected Task");
      const available = new Set(tasks.map((task) => task.id));
      const missing = selected.filter((taskId) => !available.has(taskId));
      if (missing.length) throw new Error(`selected release Tasks were not found: ${missing.join(", ")}`);
      const selectedSet = new Set(selected);
      tasks = tasks.filter((task) => selectedSet.has(task.id));
    }
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
      const selectedCompositions = [];
      let gitError = null;
      // Metadata remains available for draft/legacy audit projections, but only
      // the prospective Await set needs live Git evidence. Archived branches
      // may already have been cleaned up and cannot affect this release.
      if (task.status === "done" || task.workflowStatus !== "awaiting_implementation") {
        resolved.push({ ...task, changedFiles, gitError });
        continue;
      }
      try {
        for (const reference of task.gitReferences ?? []) {
          const selected = this.taskBoard.selectedCompositionForRelease({
            taskId: task.id, ...reference,
          });
          if (selected) selectedCompositions.push({ projectRoot: reference.projectRoot, ...selected });
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
      resolved.push({ ...task, changedFiles, gitError,
        ...(selectedCompositions.length ? { selectedCompositions } : {}) });
    }
    return taskReleasePlan(workspaceId, resolved);
  }
}
