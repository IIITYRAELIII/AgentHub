import { taskReleasePlan } from "../domain/task-release-snapshot.mjs";
import { normalizedTaskGitReferences } from "../domain/task-git-reference.mjs";

function releaseAuthority(tasks, acceptingTask, authorities) {
  return JSON.stringify(tasks.filter(task => task.id === acceptingTask.id
    || task.status !== "done" && task.workflowStatus === "awaiting_implementation")
    .map(task => ({ id: task.id, taskNumber: task.taskNumber ?? null, workspaceId: task.workspaceId, status: task.status,
      workflowStatus: task.workflowStatus, releaseRevision: task.releaseRevision ?? task.revision,
      ...(task.id === acceptingTask.id ? { revision: task.revision } : {}),
      gitReferences: normalizedTaskGitReferences(task.gitReferences),
      squashTransfer: task.squashTransfer ?? null, resultReleaseRevision: task.resultReleaseRevision ?? null,
      selected: authorities.get(task.id) ?? [],
    })).sort((left, right) => left.id.localeCompare(right.id)));
}


export class TaskCompositionPlanService {
  constructor({ taskBoard, taskGitWorkspaces, measureOperation = async (_stage, run) => run() } = {}) {
    if (typeof taskBoard?.releaseTasks !== "function") throw new TypeError("taskBoard.releaseTasks is required");
    if (typeof taskBoard?.selectedCompositionForRelease !== "function") {
      throw new TypeError("taskBoard.selectedCompositionForRelease is required");
    }
    if (typeof taskGitWorkspaces?.releaseEvidence !== "function") {
      throw new TypeError("taskGitWorkspaces.releaseEvidence is required");
    }
    this.taskBoard = taskBoard;
    this.taskGitWorkspaces = taskGitWorkspaces;
    if (typeof measureOperation !== "function") throw new TypeError("measureOperation is required");
    this.measureOperation = measureOperation;
  }

  async plan(workspaceId, { acceptingTask = null, selectedTaskIds = null } = {}) {
    const rows = await this.#readTasks(workspaceId);
    const tasks = this.#projectTasks(rows, acceptingTask, selectedTaskIds);
    const { evidence } = await this.#resolve(tasks);
    return this.#projection(workspaceId, tasks, evidence);
  }

  #projectTasks(rows, acceptingTask, selectedTaskIds) {
    let tasks = rows;
    if (selectedTaskIds != null) {
      const selected = [...new Set((Array.isArray(selectedTaskIds) ? selectedTaskIds : [])
        .map((taskId) => String(taskId ?? "").trim()).filter(Boolean))];
      if (!selected.length) throw new Error("release operation requires at least one selected Task");
      const available = new Set(tasks.map((task) => task.id));
      const missing = selected.filter((taskId) => !available.has(taskId));
      if (missing.length) throw new Error(`selected release Tasks were not found: ${missing.join(", ")}`);
      const awaiting = tasks.filter(task => task.status !== "done" && task.workflowStatus === "awaiting_implementation")
        .map(task => task.id).sort();
      if (JSON.stringify([...selected].sort()) !== JSON.stringify(awaiting)) {
        throw new Error("Release membership must equal the whole current Await set; return exclusions through the normal lifecycle");
      }
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
    return tasks;
  }

  async #resolve(tasks) {
    const evidence = new Map(), authorities = new Map();
    for (const task of tasks) {
      const changedFiles = [];
      const selectedCompositions = [];
      let gitError = null;
      // Metadata remains available for draft/legacy audit projections, but only
      // the prospective Await set needs live Git evidence. Archived branches
      // may already have been cleaned up and cannot affect this release.
      if (task.status === "done" || task.workflowStatus !== "awaiting_implementation") {
        continue;
      }
      try {
        for (const reference of task.gitReferences ?? []) {
          const selected = await this.#selected(task, reference);
          if (selected) selectedCompositions.push({ projectRoot: reference.projectRoot, ...selected });
          const result = await this.measureOperation("release:planner:git-evidence", () => this.taskGitWorkspaces.releaseEvidence({
            taskId: task.id,
            ...(task.taskNumber ? { taskNumber: task.taskNumber } : {}),
            ...reference,
          }), { detail: true });
          changedFiles.push(...result.changedFiles);
        }
      } catch (error) {
        gitError = error.message;
      }
      authorities.set(task.id, selectedCompositions);
      evidence.set(task.id, { changedFiles, gitError,
        ...(selectedCompositions.length ? { selectedCompositions } : {}) });
    }
    return { evidence, authorities };
  }

  #readTasks(workspaceId) {
    return this.measureOperation("release:planner:canonical-read", () =>
      structuredClone(this.taskBoard.releaseTasks(workspaceId)));
  }

  #selected(task, reference) {
    return this.measureOperation("release:planner:selected-authority", () =>
      this.taskBoard.selectedCompositionForRelease({ taskId: task.id, ...reference }), { detail: true });
  }

  #projection(workspaceId, tasks, evidence) {
    return this.measureOperation("release:planner:projection", () => taskReleasePlan(workspaceId,
      tasks.map(task => ({ ...task, ...(task.status !== "done" && task.workflowStatus === "awaiting_implementation"
        ? evidence.get(task.id) : { changedFiles: [], gitError: null }) }))));
  }

  async #currentAuthorities(tasks) {
    const result = new Map();
    for (const task of tasks.filter(task => task.status !== "done" && task.workflowStatus === "awaiting_implementation")) {
      const selected = [];
      for (const reference of task.gitReferences ?? []) {
        const value = await this.#selected(task, reference);
        if (value) selected.push({ projectRoot: reference.projectRoot, ...value });
      }
      result.set(task.id, selected);
    }
    return result;
  }

  // This pair is invocation-local to EACH existing preflight boundary.
  // It never grants authority to a later boundary, retry or process.
  async planAcceptance(workspaceId, { acceptingTask, selectedTaskIds = null } = {}) {
    const rows = await this.#readTasks(workspaceId);
    const tasks = this.#projectTasks(rows, acceptingTask, selectedTaskIds);
    const { evidence, authorities } = await this.#resolve(tasks);
    const baseline = await this.#projection(workspaceId, rows, evidence);
    const prospective = await this.#projection(workspaceId, tasks, evidence);
    if (!prospective.blocked.length) {
      // The old separate plans could observe changes while Git was awaited.
      // Reread full canonical rows AND durable selected/closure authority here;
      // an identity-only snapshot cannot stand in for those proofs.
      const fresh = await this.#readTasks(workspaceId);
      const currentTasks = this.#projectTasks(fresh, acceptingTask, selectedTaskIds);
      const currentAuthorities = await this.#currentAuthorities(currentTasks);
      if (releaseAuthority(rows, acceptingTask, authorities)
          !== releaseAuthority(fresh, acceptingTask, currentAuthorities)) {
        throw new Error("release plan authority changed during PreRelease rebuild");
      }
    }
    return { baseline, prospective };
  }
}
