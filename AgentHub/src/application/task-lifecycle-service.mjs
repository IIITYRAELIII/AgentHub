import { createHash } from "node:crypto";

import { taskProjectRoot } from "../domain/task-project-root.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function confirmation(task, action, preview) {
  const cleanupToken = createHash("sha256").update(JSON.stringify({
    action,
    taskId: task.id,
    revision: task.revision,
    workspaces: (preview.workspaces ?? []).map((item) => ({
      projectRoot: item.projectRoot,
      branch: item.branch,
      headCommit: item.headCommit,
      dirty: item.dirty,
      changedPaths: item.changedPaths,
      untrackedPaths: item.untrackedPaths,
    })),
    gitReferences: preview.gitReferences ?? [],
    deleting: preview.deleting ?? [],
  })).digest("hex");
  return {
    confirmationRequired: true,
    action,
    cleanupToken,
    warning: action === "delete"
      ? "Delete permanently destroys the listed Task Git artifacts, including unpublished work."
      : "Complete closes the Task and removes only exact results already contained in published main.",
    task,
    preview,
  };
}

export class TaskLifecycleService {
  constructor({ taskBoard, workspaceCatalog, taskGitWorkspaces = null, releasePreflight = null } = {}) {
    for (const name of [
      "task", "beginLifecycleTransition", "commitWorkflowTransition", "failLifecycleTransition",
      "rollbackWorkflowOutcome", "finalizeCleanupTransition",
    ]) requiredMethod(taskBoard, name);
    requiredMethod(workspaceCatalog, "workspace");
    requiredMethod(workspaceCatalog, "stream");
    if (taskGitWorkspaces) {
      for (const name of ["withTaskLock", "prepareOwned", "snapshotAndMergeOwned", "cleanupOwned", "cleanupPreview"]) {
        requiredMethod(taskGitWorkspaces, name);
      }
    }
    if (releasePreflight) {
      requiredMethod(releasePreflight, "prepareAwaitSet");
      requiredMethod(releasePreflight, "withAwaitTransition");
    }
    this.taskBoard = taskBoard;
    this.workspaceCatalog = workspaceCatalog;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.releasePreflight = releasePreflight;
  }

  #task(taskId) {
    const task = this.taskBoard.task(taskId);
    if (!task) throw new Error("Task not found");
    return task;
  }

  #projectRoot(task) {
    const workspace = task.workspaceId ? this.workspaceCatalog.workspace(task.workspaceId) : null;
    const stream = task.streamId ? this.workspaceCatalog.stream(task.streamId) : null;
    return workspace ? taskProjectRoot({ workspace, stream }) : null;
  }

  #withLock(taskId, operation, { git = true } = {}) {
    return git && this.taskGitWorkspaces?.withTaskLock
      ? this.taskGitWorkspaces.withTaskLock(taskId, operation)
      : operation({ signal: null, async assertOwned() {} });
  }

  #mutation(operation, operationId) {
    void operationId;
    return Promise.resolve().then(operation);
  }

  async #assertOwned(lease) {
    requiredMethod(lease, "assertOwned");
    const ownership = lease.assertOwned();
    if (!ownership || typeof ownership.then !== "function") {
      throw new TypeError("Task lifecycle assertOwned must be asynchronous");
    }
    await ownership;
  }

  async #failWhileOwned(lease, operationId, error) {
    try {
      await this.#assertOwned(lease);
      await this.#mutation(() => this.taskBoard.failLifecycleTransition(operationId, error), operationId);
    } catch {
      // A fenced owner must not write after lease loss. Startup reconciliation
      // owns the remaining durable transition.
    }
  }

  async updateWorkflowStatus(options = {}) {
    const task = this.#task(options.taskId);
    const workspace = task.workspaceId ? this.workspaceCatalog.workspace(task.workspaceId) : null;
    if (workspace?.settings?.releaseWorkflowEnabled !== true) {
      return this.#updateWorkflowStatusLocked(options);
    }
    if (!this.releasePreflight) {
      throw new Error("Release preflight is unavailable; workflow status was not changed");
    }
    return this.releasePreflight.withAwaitTransition(
      workspace.id,
      () => this.#updateWorkflowStatusLocked(options, { releaseWorkflow: true }),
    );
  }

  async #updateWorkflowStatusLocked({
    taskId, status, operationId, binding = {}, projectRoot = null,
    expectedRevision = null, expectedWorkflowStatus = null,
  } = {}, { releaseWorkflow = false } = {}) {
    return this.#withLock(taskId, (lease = {}) => this.#updateWorkflowStatusWithLease({
      taskId, status, operationId, binding, projectRoot, expectedRevision, expectedWorkflowStatus,
    }, { releaseWorkflow, lease }), { git: releaseWorkflow });
  }

  async #updateWorkflowStatusWithLease({
    taskId, status, operationId, binding = {}, projectRoot = null,
    expectedRevision = null, expectedWorkflowStatus = null,
  } = {}, { releaseWorkflow = false, lease = {} } = {}) {
      const task = this.#task(taskId);
      const workflowStatus = String(status ?? "").trim();
      if (expectedRevision != null && task.revision !== Number(expectedRevision)) {
        throw new Error("Task workflow cutover revision changed");
      }
      if (expectedWorkflowStatus != null
          && task.workflowStatus !== String(expectedWorkflowStatus).trim()) {
        throw new Error("Task workflow cutover status changed");
      }
      const snapshotsResult = releaseWorkflow && ["testing", "awaiting_implementation", "done"].includes(workflowStatus);
      const workspace = task.workspaceId ? this.workspaceCatalog.workspace(task.workspaceId) : null;
      const affectsAwait = workspace?.settings?.releaseWorkflowEnabled === true
        && (task.workflowStatus === "awaiting_implementation" || workflowStatus === "awaiting_implementation");
      const selectedProjectRoot = releaseWorkflow ? projectRoot || this.#projectRoot(task) : null;
      if (affectsAwait && !selectedProjectRoot) {
        throw new Error("Task project root is unavailable; Await set was not changed");
      }
      await this.#assertOwned(lease);
      await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
        id: task.id,
        operationId,
        kind: "workflow",
        targetWorkflowStatus: workflowStatus,
        expectedRevision: task.revision,
      }), operationId);
      let committed = false;
      try {
        if (!snapshotsResult) {
          await this.#assertOwned(lease);
          const current = await this.#mutation(() => this.taskBoard.commitWorkflowTransition({
            operationId,
            gitReferences: [],
            replaceGitReferences: false,
            ...binding,
            evidence: { outcome: "not_required" },
          }), operationId);
          committed = true;
          if (!affectsAwait) return current;
          const preReleaseIntegration = await this.releasePreflight.prepareAwaitSet({
            workspaceId: workspace.id,
            fallbackProjectRoots: [selectedProjectRoot],
          });
          return { task: current, preReleaseIntegration };
        }
        if (!selectedProjectRoot || !this.taskGitWorkspaces) {
          throw new Error("Task Git workspace is unavailable; workflow status was not changed");
        }
        const gitWorkspace = await this.taskGitWorkspaces.prepareOwned({
          taskId: task.id,
          taskNumber: task.taskNumber,
          projectRoot: selectedProjectRoot,
          lease,
        });
        const { snapshot, integration } = await this.taskGitWorkspaces.snapshotAndMergeOwned({
          taskId: task.id,
          taskNumber: task.taskNumber,
          projectRoot: gitWorkspace.projectRoot,
          turnId: null,
          summary: task.title,
          lease,
        });
        if (!integration.resultProved || !integration.integrated) {
          throw new Error(integration.error || "Task result was not integrated into dev");
        }
        await this.#assertOwned(lease);
        const gitWorkspaceResult = {
          branch: snapshot.branch,
          projectRoot: snapshot.projectRoot,
          baseCommit: snapshot.baseCommit,
          headCommit: snapshot.headCommit,
        };
        const gitIntegrationResult = {
          outcome: integration.outcome,
          integrated: true,
          alreadyIntegrated: integration.alreadyIntegrated === true,
          devBranch: integration.dev?.branch ?? "dev",
          devHeadCommit: integration.dev?.headCommit ?? null,
          conflicts: [],
          error: null,
        };
        const current = await this.#mutation(() => this.taskBoard.commitWorkflowTransition({
          operationId,
          gitReferences: [{
            projectRoot: snapshot.repositoryRoot,
            resultCommit: snapshot.headCommit,
            branch: snapshot.branch,
          }],
          ...binding,
          evidence: {
            outcome: integration.outcome,
            resultCommit: snapshot.headCommit,
            devHeadCommit: integration.dev?.headCommit ?? null,
            response: { gitWorkspace: gitWorkspaceResult, gitIntegration: gitIntegrationResult },
          },
        }), operationId);
        committed = true;
        const preReleaseIntegration = affectsAwait
          ? await this.releasePreflight.prepareAwaitSet({
            workspaceId: workspace.id,
            fallbackProjectRoots: [selectedProjectRoot],
          })
          : null;
        return {
          task: current,
          gitWorkspace: gitWorkspaceResult,
          gitIntegration: gitIntegrationResult,
          ...(preReleaseIntegration ? { preReleaseIntegration } : {}),
        };
      } catch (error) {
        if (committed && affectsAwait) {
          await this.#assertOwned(lease);
          await this.#mutation(() => this.taskBoard.rollbackWorkflowOutcome(operationId, error), operationId);
        } else {
          await this.#failWhileOwned(lease, operationId, error);
        }
        throw error;
      }
  }

  withUnknownWorkflowReconciliationLock({ taskId, projectRoot } = {}, operation) {
    const task = this.#task(taskId);
    const workspace = task.workspaceId ? this.workspaceCatalog.workspace(task.workspaceId) : null;
    if (workspace?.settings?.releaseWorkflowEnabled !== true || !this.releasePreflight) {
      throw new Error("Unknown workflow reconciliation requires an enabled release workflow");
    }
    requiredMethod(this.taskGitWorkspaces, "withTaskRecoveryLock");
    requiredMethod(this.taskGitWorkspaces, "withTaskRepositoryRecoveryLock");
    return this.releasePreflight.withAwaitTransition(workspace.id, () => (
      this.taskGitWorkspaces.withTaskRecoveryLock(task.id, (taskLease) => (
        this.taskGitWorkspaces.withTaskRepositoryRecoveryLock(
          task.id, projectRoot, taskLease, operation,
        )
      ))
    ));
  }

  async reconcileUnknownWorkflowStatusOwned({
    taskId, operationId, projectRoot, guardId, proof, lease,
  } = {}) {
    await this.#assertOwned(lease);
    const current = this.#task(taskId);
    const transition = this.taskBoard.lifecycleTransition?.(operationId);
    if (
      transition?.operationId !== operationId
      || transition.taskId !== current.id
      || transition.kind !== "workflow"
      || transition.phase !== "pending_git"
      || transition.targetWorkflowStatus !== "awaiting_implementation"
      || transition.expectedRevision !== current.revision
      || current.workflowStatus !== "testing"
    ) {
      throw new Error("Unknown workflow reconciliation identity or Task CAS does not match");
    }
    const recovery = await this.taskGitWorkspaces.recoverProcessTreeGuard(current.id, {
      repositoryRoot: projectRoot,
      guardId,
      proof,
      lease,
    });
    const result = await this.#updateWorkflowStatusWithLease({
      taskId: current.id,
      status: transition.targetWorkflowStatus,
      operationId,
      projectRoot,
    }, { releaseWorkflow: true, lease });
    return { result, recovery };
  }

  reconcileUnknownWorkflowStatus(options = {}) {
    return this.withUnknownWorkflowReconciliationLock(options, (lease) => (
      this.reconcileUnknownWorkflowStatusOwned({ ...options, lease })
    ));
  }

  async #cleanupPreview(task, action) {
    const preview = this.taskGitWorkspaces?.cleanupPreview
      ? await this.taskGitWorkspaces.cleanupPreview(task.id, { gitReferences: task.gitReferences })
      : { taskId: task.id, workspaces: [], gitReferences: task.gitReferences ?? [], dirty: false, unpublished: [], deleting: [] };
    return confirmation(task, action, preview);
  }

  async complete({ taskId, operationId, confirmCleanup = false, expectedCleanupToken = null } = {}) {
    return this.#withLock(taskId, async (lease = {}) => {
      const task = this.#task(taskId);
      const resumed = this.taskBoard.lifecycleTransition?.(operationId);
      const resumingCleanup = resumed?.taskId === task.id && resumed.kind === "complete" && resumed.phase === "cleanup";
      const preview = await this.#cleanupPreview(task, "complete");
      if (confirmCleanup !== true) return preview;
      if (!resumingCleanup && String(expectedCleanupToken ?? "") !== preview.cleanupToken) {
        throw new Error("Task cleanup confirmation is stale or missing; read the preview again");
      }
      const hasGitArtifacts = preview.preview.workspaces.length > 0 || (task.gitReferences?.length ?? 0) > 0;
      if (hasGitArtifacts && task.workflowStatus !== "done") {
        throw new Error("Implementation Task can be completed only after workflow Done");
      }
      if (hasGitArtifacts && !(task.gitReferences?.length ?? 0)) {
        throw new Error("Task Complete blocked: no exact result commit is recorded; use Delete only for intentional destruction");
      }
      if (preview.preview.dirty) throw new Error("Task Complete blocked: managed worktree is dirty");
      if (hasGitArtifacts && preview.preview.unpublished.length) {
        throw new Error("Task Complete blocked: exact result commit is not contained in durable published main evidence");
      }
      await this.#assertOwned(lease);
      await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
        id: task.id, operationId, kind: "complete", expectedRevision: task.revision,
      }), operationId);
      try {
        await this.#assertOwned(lease);
        if (hasGitArtifacts) await this.taskGitWorkspaces.cleanupOwned(task.id, {
          allowDirty: false, requirePublished: true, gitReferences: task.gitReferences,
          expectedPreview: preview.preview, lease,
        });
        await this.#assertOwned(lease);
        return await this.#mutation(() => this.taskBoard.finalizeCleanupTransition(operationId), operationId);
      } catch (error) {
        await this.#failWhileOwned(lease, operationId, error);
        throw error;
      }
    });
  }

  async delete({ taskId, operationId, confirmCleanup = false, expectedCleanupToken = null } = {}) {
    return this.#withLock(taskId, async (lease = {}) => {
      const task = this.#task(taskId);
      const resumed = this.taskBoard.lifecycleTransition?.(operationId);
      const resumingCleanup = resumed?.taskId === task.id && resumed.kind === "delete" && resumed.phase === "cleanup";
      const preview = await this.#cleanupPreview(task, "delete");
      if (confirmCleanup !== true) return preview;
      if (!resumingCleanup && String(expectedCleanupToken ?? "") !== preview.cleanupToken) {
        throw new Error("Task deletion confirmation is stale or missing; read the preview again");
      }
      await this.#assertOwned(lease);
      await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
        id: task.id, operationId, kind: "delete", expectedRevision: task.revision,
      }), operationId);
      try {
        await this.#assertOwned(lease);
        await this.taskGitWorkspaces?.cleanupOwned(task.id, {
          allowDirty: true, requirePublished: false, gitReferences: task.gitReferences,
          expectedPreview: preview.preview, lease,
        });
        await this.#assertOwned(lease);
        const result = await this.#mutation(
          () => this.taskBoard.finalizeCleanupTransition(operationId, {
            deleteTask: true, receiptEvidence: { cleanup: preview.preview },
          }),
          operationId,
        );
        return { deleted: true, task: result.task, cleanup: preview.preview };
      } catch (error) {
        await this.#failWhileOwned(lease, operationId, error);
        throw error;
      }
    });
  }
}
