import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import { taskProjectRoot } from "../domain/task-project-root.mjs";
import { TaskAbsorptionCompositionError } from "../domain/task-board-task.mjs";
import { normalizedTaskSquashCutover } from "../domain/task-squash-cutover.mjs";
import { TaskGitHistoryRejectedError } from "../domain/task-git-reference.mjs";

export class TaskIntegrationRejectedError extends Error {
  constructor(cause) {
    super(cause.message, { cause });
    this.code = "TASK_INTEGRATION_REJECTED";
  }
}

export class TaskWithdrawalBusyError extends Error {
  constructor(cause) {
    super(cause.message);
    this.code = "TASK_WITHDRAWAL_BUSY";
  }
}

export class TaskIntegrationConflictError extends Error {
  constructor(details) {
    super(`Task merge conflict: ${details.conflicts.join(", ")}. dev restored; continue in ${details.projectRoot}. ${JSON.stringify(details)}`);
    this.code = "TASK_INTEGRATION_CONFLICT";
    this.details = details;
  }
}

export class TaskAwaitIntegrationError extends Error {
  constructor(cause) {
    super(`Await integration evidence failed; Task status was not changed: ${cause.message}`);
    this.code = "TASK_AWAIT_INTEGRATION_FAILED";
  }
}

export class TaskWithdrawalDependencyError extends Error {
  constructor(taskId, cause) {
    super(`Task ${taskId} was not returned: ${cause.message}. Handle the dependent Task first, or consolidate the Tasks; no dependent Task was changed.`);
    this.code = "TASK_WITHDRAWAL_DEPENDENCY";
    this.details = { taskId, blockedTaskIds: cause.blockedTaskIds, integrationCommit: cause.integrationCommit };
  }
}

export class TaskSquashTransferRejectedError extends Error {
  constructor(message) {
    super(String(message ?? "Task squash transfer was rejected before effects"));
    this.code = "TASK_SQUASH_TRANSFER_REJECTED";
  }
}

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function samePath(left, right) {
  const canonical = (value) => {
    const resolved = path.resolve(String(value ?? ""));
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
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
    absorbedInto: preview.absorbedInto ?? null,
    releaseService: preview.releaseService ?? null,
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
  #releaseOperationWake = null;
  #releaseOperationPrepare = null;

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
      requiredMethod(releasePreflight, "withAwaitTransition");
    }
    this.taskBoard = taskBoard;
    this.workspaceCatalog = workspaceCatalog;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.releasePreflight = releasePreflight;
  }

  setReleaseOperationWake(wake) {
    if (wake != null && typeof wake !== "function") throw new TypeError("release operation wake must be a function");
    this.#releaseOperationWake = wake;
  }

  setReleaseOperationPrepare(prepare) {
    if (prepare != null && typeof prepare !== "function") throw new TypeError("release operation prepare must be a function");
    this.#releaseOperationPrepare = prepare;
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
    return this.#measure("persistence", () => Promise.resolve().then(operation));
  }

  #measure(stage, operation) {
    return this.taskGitWorkspaces?.measureOperation
      ? this.taskGitWorkspaces.measureOperation(stage, operation) : operation();
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
    const operation = () => this.#updateWorkflowStatusTraced(options);
    return this.taskGitWorkspaces?.withOperationTrace
      ? this.taskGitWorkspaces.withOperationTrace({ operationId: options.operationId, taskId: options.taskId }, operation)
      : operation();
  }

  async #updateWorkflowStatusTraced(options) {
    const task = this.#task(options.taskId);
    const workspace = task.workspaceId ? this.workspaceCatalog.workspace(task.workspaceId) : null;
    if (workspace?.settings?.releaseWorkflowEnabled !== true) {
      return this.#updateWorkflowStatusLocked(options);
    }
    if (!this.releasePreflight) {
      throw new Error("Release preflight is unavailable; workflow status was not changed");
    }
    const result = await this.#measure("await-transition", () => this.releasePreflight.withAwaitTransition(
      workspace.id,
      () => this.#measure("await-admitted", () => this.#updateWorkflowStatusLocked(options, { releaseWorkflow: true })),
    ));
    if (result?.task?.workflowStatus === "awaiting_implementation") this.#releaseOperationWake?.(result.task.id);
    return result;
  }

  // A proven withdrawal is durable before this runs. The remaining accepted
  // membership is recomposed so the candidate keeps matching the accepted set;
  // a failure here never undoes the withdrawal and never reports ready.
  async #recomposeAfterWithdrawal(workspaceId, projectRoot, lease) {
    try {
      const prepared = await this.releasePreflight.prepareAwaitSet({
        workspaceId,
        fallbackProjectRoots: projectRoot ? [projectRoot] : [],
        preserveFrozen: true,
        lease,
      });
      return { ...prepared, status: "ready" };
    } catch (error) {
      return {
        status: "blocked",
        reason: `Accepted result returned for rework; remaining Await set requires explicit preparation: ${
          String(error?.message ?? error)}`,
        ...(error?.code ? { code: error.code } : {}),
      };
    }
  }

  async updateWorkflowStatusFromSource(options = {}, {
    taskId: sourceTaskId,
    expectedRevision: expectedSourceRevision,
    expectedCommit: expectedSourceCommit,
    expectedProjectorSha256,
    verifySource,
  } = {}) {
    const target = this.#task(options.taskId);
    const source = this.#task(sourceTaskId);
    const workspace = target.workspaceId ? this.workspaceCatalog.workspace(target.workspaceId) : null;
    if (workspace?.settings?.releaseWorkflowEnabled !== true || !this.releasePreflight) {
      throw new Error("Cross-Task cutover requires an enabled release workflow");
    }
    if (source.id === target.id || source.workspaceId !== target.workspaceId) {
      throw new Error("Cross-Task cutover source and target identity does not match");
    }
    requiredMethod(this.taskGitWorkspaces, "withTaskLocks");
    requiredMethod({ verifySource }, "verifySource");
    const projectRoot = path.resolve(String(options.projectRoot || this.#projectRoot(target) || ""));
    if (!projectRoot || !samePath(this.#projectRoot(source), projectRoot)) {
      throw new Error("Cross-Task cutover source and target repository does not match");
    }
    return this.releasePreflight.withAwaitTransition(workspace.id, () => (
      this.taskGitWorkspaces.withTaskLocks(
        [source.id, target.id],
        async (lease) => {
          const lockedSource = this.#task(source.id);
          const lockedTarget = this.#task(target.id);
          const lockedWorkspace = lockedTarget.workspaceId
            ? this.workspaceCatalog.workspace(lockedTarget.workspaceId)
            : null;
          const lockedStream = lockedTarget.streamId
            ? this.workspaceCatalog.stream(lockedTarget.streamId)
            : null;
          const revision = Number(expectedSourceRevision);
          const commit = String(expectedSourceCommit ?? "").trim().toLowerCase();
          const projectorSha256 = String(expectedProjectorSha256 ?? "").trim().toLowerCase();
          if (!Number.isInteger(revision) || revision < 1
              || lockedSource.revision !== revision
              || lockedSource.workflowStatus !== "testing"
              || lockedSource.workspaceId !== lockedTarget.workspaceId
              || lockedTarget.workspaceId !== workspace.id
              || (lockedTarget.streamId && lockedStream?.workspaceId !== workspace.id)
              || lockedWorkspace?.settings?.releaseWorkflowEnabled !== true
              || !samePath(this.#projectRoot(lockedSource), projectRoot)
              || !samePath(taskProjectRoot({ workspace: lockedWorkspace, stream: lockedStream }), projectRoot)) {
            throw new Error("Cross-Task cutover source Task revision, status or repository changed");
          }
          const references = (lockedSource.gitReferences ?? [])
            .filter((reference) => samePath(reference?.projectRoot, projectRoot));
          if (references.length !== 1
              || String(references[0].resultCommit ?? "").trim().toLowerCase() !== commit) {
            throw new Error("Cross-Task cutover source is not the unique authoritative Task result");
          }
          const inspected = await verifySource();
          if (String(inspected?.headCommit ?? "").trim().toLowerCase() !== commit
              || String(inspected?.projectorSha256 ?? "").trim().toLowerCase() !== projectorSha256) {
            throw new Error("Cross-Task cutover source checkout changed while locked");
          }
          return this.#updateWorkflowStatusWithLease({
            ...options,
            projectRoot,
            operationEvidence: {
              cutoverSource: {
                taskId: lockedSource.id,
                revision,
                workflowStatus: lockedSource.workflowStatus,
                resultCommit: commit,
                projectorSha256,
                projectRoot,
              },
            },
          }, { releaseWorkflow: true, lease });
        },
        { guardTaskId: target.id },
      )
    ));
  }

  async squashTransfer({
    taskId, sourceTaskId, operationId, expectedTaskRevision = null,
    expectedSourceTaskRevision = null, baselineResultCommit, newResultCommit,
    devAfterTree, expectedTransferHash = null, authority = null, projectRoot = null,
  } = {}) {
    requiredMethod(this.taskBoard, "commitSquashTransferTransition");
    requiredMethod(this.taskGitWorkspaces, "withTaskLocks");
    requiredMethod(this.taskGitWorkspaces, "previewSquashTransferOwned");
    requiredMethod(this.taskGitWorkspaces, "applySquashTransferOwned");
    requiredMethod(this.taskGitWorkspaces, "readSquashTransferOwned");
    const initialSurvivor = this.#task(taskId);
    const initialSource = this.#task(sourceTaskId);
    const workspace = initialSurvivor.workspaceId
      ? this.workspaceCatalog.workspace(initialSurvivor.workspaceId)
      : null;
    if (!workspace || workspace.settings?.releaseWorkflowEnabled !== true
        || initialSource.workspaceId !== initialSurvivor.workspaceId
        || initialSource.id === initialSurvivor.id) {
      throw new TaskSquashTransferRejectedError("Task squash transfer requires two Tasks in one enabled release Workspace");
    }
    const root = path.resolve(String(projectRoot || this.#projectRoot(initialSurvivor) || ""));
    if (!root || !samePath(root, this.#projectRoot(initialSource))) {
      throw new TaskSquashTransferRejectedError("Task squash transfer source and survivor repository does not match");
    }
    const operation = String(operationId ?? "").trim();
    if (!operation) throw new TaskSquashTransferRejectedError("Task squash transfer operation id is required");
    return this.releasePreflight.withAwaitTransition(workspace.id, () => this.taskGitWorkspaces.withTaskLocks(
      [initialSource.id, initialSurvivor.id],
      async (lease) => {
        const survivor = this.#task(initialSurvivor.id);
        const source = this.#task(initialSource.id);
        if (survivor.workflowStatus !== "testing" || source.workflowStatus !== "testing"
            || (expectedTaskRevision != null && survivor.revision !== Number(expectedTaskRevision))
            || (expectedSourceTaskRevision != null && source.revision !== Number(expectedSourceTaskRevision))) {
          throw new TaskSquashTransferRejectedError("Task squash transfer revisions or Test status changed");
        }
        const preview = await this.taskGitWorkspaces.previewSquashTransferOwned({
          source,
          survivor,
          projectRoot: root,
          baselineResultCommit,
          newResultCommit,
          devAfterTree,
          authority,
          lease,
        });
        if (!expectedTransferHash) return {
          confirmationRequired: true,
          transferHash: preview.transferHash,
          squashTransfer: preview,
          task: survivor,
          sourceTask: source,
        };
        if (String(expectedTransferHash).trim().toLowerCase() !== preview.transferHash) {
          throw new TaskSquashTransferRejectedError("Task squash transfer confirmation hash changed");
        }
        await this.#assertOwned(lease);
        await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
          id: survivor.id,
          operationId: operation,
          kind: "workflow",
          targetWorkflowStatus: "testing",
          expectedRevision: survivor.revision,
          evidence: { squashTransfer: preview },
          releaseContext: {
            workspaceId: survivor.workspaceId,
            streamId: survivor.streamId,
            projectRoot: root,
            source: {
              taskId: source.id,
              revision: source.revision,
              workflowStatus: source.workflowStatus,
              resultCommit: preview.source.resultCommit,
              projectRoot: root,
            },
          },
        }), operation);
        let applied;
        try {
          applied = await this.taskGitWorkspaces.applySquashTransferOwned({
            source,
            survivor,
            projectRoot: root,
            baselineResultCommit,
            newResultCommit,
            devAfterTree,
            authority,
            expectedTransferHash: preview.transferHash,
            lease,
          });
        } catch (error) {
          const readback = await this.taskGitWorkspaces.readSquashTransferOwned(preview, {
            projectRoot: root, lease,
          });
          if (readback.status === "applied") applied = readback.proof;
          else if (readback.status === "not_applied") {
            await this.#failWhileOwned(lease, operation, error);
            throw error;
          } else {
            const unknown = new Error(`Task squash transfer Git outcome is unknown: ${error.message}`);
            unknown.code = "TASK_SQUASH_TRANSFER_UNKNOWN";
            throw unknown;
          }
        }
        await this.#assertOwned(lease);
        try {
          return await this.#mutation(() => this.taskBoard.commitSquashTransferTransition({
            operationId: operation,
            squashTransfer: applied,
          }), operation);
        } catch (error) {
          const outcome = this.taskBoard.lifecycleOutcome(operation);
          if (outcome?.taskId === survivor.id
              && outcome.result?.evidence?.squashTransfer?.transferHash === preview.transferHash) {
            return {
              task: outcome.result.task,
              sourceTask: outcome.result.sourceTask,
              squashTransfer: outcome.result.evidence.squashTransfer,
            };
          }
          const unknown = new Error(`Task squash transfer durable outcome is unknown: ${error.message}`);
          unknown.code = "TASK_SQUASH_TRANSFER_UNKNOWN";
          throw unknown;
        }
      },
      { guardTaskId: initialSurvivor.id },
    ));
  }

  async squashTransferCutover({
    taskId, sourceTaskId, operationId, expectedTaskRevision, expectedSourceTaskRevision,
    baselineResultCommit, newResultCommit, devAfterTree, expectedTransferHash = null,
    expectedCutoverHash = null, authority = null, projectRoot = null,
    reviewedSourceTree, expectedMainCommit, expectedDevCommit, expectedPreservedTree,
    projectorSha256, artifacts, verifySource,
  } = {}) {
    for (const name of [
      "withTaskLocks", "previewSquashCutoverOwned", "applySquashCutoverOwned", "readSquashCutoverOwned",
    ]) requiredMethod(this.taskGitWorkspaces, name);
    requiredMethod(this.taskBoard, "commitSquashTransferTransition");
    const initialSurvivor = this.#task(taskId);
    const initialSource = this.#task(sourceTaskId);
    const workspace = initialSurvivor.workspaceId
      ? this.workspaceCatalog.workspace(initialSurvivor.workspaceId)
      : null;
    if (!workspace || workspace.settings?.releaseWorkflowEnabled !== true
        || initialSource.workspaceId !== initialSurvivor.workspaceId
        || initialSource.id === initialSurvivor.id) {
      throw new TaskSquashTransferRejectedError("Task squash cutover requires two Tasks in one enabled release Workspace");
    }
    const root = path.resolve(String(projectRoot || this.#projectRoot(initialSurvivor) || ""));
    if (!root || !samePath(root, this.#projectRoot(initialSource))) {
      throw new TaskSquashTransferRejectedError("Task squash cutover repository does not match");
    }
    const operation = String(operationId ?? "").trim();
    if (!operation) throw new TaskSquashTransferRejectedError("Task squash cutover operation id is required");
    return this.releasePreflight.withAwaitTransition(workspace.id, () => this.taskGitWorkspaces.withTaskLocks(
      [initialSource.id, initialSurvivor.id],
      async (lease) => {
        const survivor = this.#task(initialSurvivor.id);
        const source = this.#task(initialSource.id);
        if (survivor.workflowStatus !== "in_progress" || source.workflowStatus !== "testing"
            || survivor.revision !== Number(expectedTaskRevision)
            || source.revision !== Number(expectedSourceTaskRevision)) {
          throw new TaskSquashTransferRejectedError("Task squash cutover revisions or statuses changed");
        }
        const cutoverIdentity = {
          expectedMainCommit, expectedDevCommit, expectedPreservedTree,
          reviewedSourceCommit: newResultCommit, reviewedSourceTree, projectorSha256, artifacts,
        };
        requiredMethod({ verifySource }, "verifySource");
        const inspected = await verifySource();
        const inspectedArtifacts = inspected?.artifacts ?? {};
        if (String(inspected?.headCommit ?? "").trim().toLowerCase() !== String(newResultCommit ?? "").trim().toLowerCase()
            || String(inspected?.headTree ?? "").trim().toLowerCase() !== String(reviewedSourceTree ?? "").trim().toLowerCase()
            || String(inspected?.projectorSha256 ?? "").trim().toLowerCase() !== String(projectorSha256 ?? "").trim().toLowerCase()
            || JSON.stringify(inspectedArtifacts) !== JSON.stringify(artifacts)) {
          throw new TaskSquashTransferRejectedError("Task squash cutover reviewed source or artifact identity changed");
        }
        const preview = await this.taskGitWorkspaces.previewSquashCutoverOwned({
          source, survivor, projectRoot: root, baselineResultCommit, newResultCommit,
          devAfterTree, authority, reviewedSourceRoot: inspected.sourceRoot,
          cutover: cutoverIdentity, lease,
        });
        if (preview.devBeforeCommit !== String(expectedDevCommit ?? "").trim().toLowerCase()) {
          throw new TaskSquashTransferRejectedError("Task squash cutover dev identity changed");
        }
        const cutover = normalizedTaskSquashCutover({
          version: 1, kind: "task-squash-cutover-v1", ...cutoverIdentity,
          squashTransfer: preview,
        });
        if (!expectedTransferHash && !expectedCutoverHash) return {
          confirmationRequired: true,
          transferHash: preview.transferHash,
          cutoverHash: cutover.cutoverHash,
          squashTransfer: preview,
          squashCutover: cutover,
          task: survivor,
          sourceTask: source,
        };
        if (String(expectedTransferHash ?? "").trim().toLowerCase() !== preview.transferHash
            || String(expectedCutoverHash ?? "").trim().toLowerCase() !== cutover.cutoverHash) {
          throw new TaskSquashTransferRejectedError("Task squash cutover confirmation hash changed");
        }
        await this.#assertOwned(lease);
        await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
          id: survivor.id,
          operationId: operation,
          kind: "workflow",
          targetWorkflowStatus: "testing",
          expectedRevision: survivor.revision,
          evidence: { squashTransfer: preview, squashCutover: cutover },
          releaseContext: {
            workspaceId: survivor.workspaceId,
            streamId: survivor.streamId,
            projectRoot: root,
            source: {
              taskId: source.id, revision: source.revision,
              workflowStatus: source.workflowStatus,
              resultCommit: preview.source.resultCommit, projectRoot: root,
            },
          },
        }), operation);
        let applied;
        try {
          applied = await this.taskGitWorkspaces.applySquashCutoverOwned({
            cutover, source, survivor, lease,
          });
        } catch (error) {
          const readback = await this.taskGitWorkspaces.readSquashCutoverOwned(cutover, {
            projectRoot: root, lease,
          });
          if (readback.status === "applied") applied = { cutover, squashTransfer: readback.proof };
          else if (readback.status === "not_staged") {
            await this.#failWhileOwned(lease, operation, error);
            throw error;
          } else {
            const unknown = new Error(`Task squash cutover Git outcome is unknown: ${error.message}`);
            unknown.code = "TASK_SQUASH_TRANSFER_UNKNOWN";
            throw unknown;
          }
        }
        await this.#assertOwned(lease);
        try {
          return await this.#mutation(() => this.taskBoard.commitSquashTransferTransition({
            operationId: operation,
            squashTransfer: applied.squashTransfer,
            squashCutover: cutover,
          }), operation);
        } catch (error) {
          const outcome = this.taskBoard.lifecycleOutcome(operation);
          if (outcome?.taskId === survivor.id
              && outcome.result?.evidence?.squashTransfer?.transferHash === preview.transferHash
              && outcome.result?.evidence?.squashCutover?.cutoverHash === cutover.cutoverHash) {
            return {
              task: outcome.result.task, sourceTask: outcome.result.sourceTask,
              squashTransfer: outcome.result.evidence.squashTransfer,
              squashCutover: outcome.result.evidence.squashCutover,
            };
          }
          const unknown = new Error(`Task squash cutover durable outcome is unknown: ${error.message}`);
          unknown.code = "TASK_SQUASH_TRANSFER_UNKNOWN";
          throw unknown;
        }
      },
      { guardTaskId: initialSurvivor.id },
    ));
  }

  async selectedComposition({
    taskId, operationId, expectedTaskRevision, projectRoot, bundlePath,
    bundleSha256, proofCommit, expectedPreviewHash = null, authority,
  } = {}) {
    for (const name of ["withTaskLock", "previewSelectedCompositionOwned",
      "applySelectedCompositionOwned", "readSelectedCompositionOwned"]) {
      requiredMethod(this.taskGitWorkspaces, name);
    }
    const initial = this.#task(taskId);
    const workspace = initial.workspaceId ? this.workspaceCatalog.workspace(initial.workspaceId) : null;
    if (workspace?.settings?.releaseWorkflowEnabled !== true || !this.releasePreflight
        || initial.workflowStatus !== "in_progress"
        || initial.revision !== Number(expectedTaskRevision)) {
      throw new Error("Selected composition requires one exact in-progress release Task revision");
    }
    const root = path.resolve(String(projectRoot || this.#projectRoot(initial) || ""));
    if (!root || !samePath(root, this.#projectRoot(initial))) {
      throw new Error("Selected composition Task project root changed");
    }
    const operation = String(operationId ?? "").trim();
    if (!operation) throw new Error("Selected composition operation id is required");
    return this.releasePreflight.withAwaitTransition(workspace.id, () => (
      this.taskGitWorkspaces.withTaskLock(initial.id, async (lease) => {
        const task = this.#task(initial.id);
        if (task.revision !== Number(expectedTaskRevision)
            || task.workflowStatus !== "in_progress" || task.workspaceId !== workspace.id) {
          throw new Error("Selected composition Task revision or status changed");
        }
        const preview = await this.taskGitWorkspaces.previewSelectedCompositionOwned({
          taskId: task.id, taskNumber: task.taskNumber, projectRoot: root,
          proofCommit, bundlePath, bundleSha256, authority,
          expectedTaskRevision, lease,
        });
        if (!expectedPreviewHash) return {
          confirmationRequired: true, previewHash: preview.previewHash,
          selectedComposition: preview, task,
        };
        if (String(expectedPreviewHash).trim().toLowerCase() !== preview.previewHash) {
          throw new Error("Selected composition confirmation hash changed");
        }
        await this.#assertOwned(lease);
        await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
          id: task.id, operationId: operation, kind: "workflow",
          targetWorkflowStatus: "testing", expectedRevision: task.revision,
          evidence: { selectedComposition: preview },
          releaseContext: {
            workspaceId: task.workspaceId, streamId: task.streamId, projectRoot: root,
          },
        }), operation);
        let applied;
        try {
          applied = await this.taskGitWorkspaces.applySelectedCompositionOwned(preview, {
            operationId: operation, lease,
          });
        } catch (error) {
          const state = await this.taskGitWorkspaces.readSelectedCompositionOwned(preview, {
            operationId: operation, lease,
          });
          if (state.status === "applied") applied = state;
          else if (["not_admitted", "before_cas"].includes(state.status)
              && error?.processTreeStopped !== false) {
            await this.#failWhileOwned(lease, operation, error);
            throw error;
          } else {
            const unknown = new Error(`Selected composition Git outcome is unknown: ${error.message}`);
            unknown.code = "TASK_SELECTED_COMPOSITION_UNKNOWN";
            throw unknown;
          }
        }
        await this.#assertOwned(lease);
        try {
          const updated = await this.#mutation(() => this.taskBoard.commitWorkflowTransition({
            operationId: operation,
            gitReferences: [{ projectRoot: preview.repositoryRoot,
              resultCommit: preview.taskCommit, branch: preview.branch }],
            evidence: {
              outcome: "integrated", resultCommit: preview.taskCommit,
              devHeadCommit: preview.proofCommit, selectedComposition: preview,
              response: {
                gitWorkspace: { branch: preview.branch, projectRoot: preview.taskRoot,
                  baseCommit: preview.taskBaseCommit, headCommit: preview.taskCommit },
                gitIntegration: { outcome: "integrated", integrated: true,
                  alreadyIntegrated: false, devBranch: "dev",
                  devHeadCommit: preview.proofCommit, conflicts: [], error: null },
              },
            },
          }), operation);
          return { task: updated, selectedComposition: preview,
            gitWorkspace: { branch: preview.branch, projectRoot: preview.taskRoot,
              baseCommit: preview.taskBaseCommit, headCommit: preview.taskCommit },
            gitIntegration: { outcome: "integrated", integrated: true,
              alreadyIntegrated: false, devBranch: "dev", devHeadCommit: preview.proofCommit,
              conflicts: [], error: null },
            gitReceipt: applied.receipt };
        } catch (error) {
          const outcome = this.taskBoard.lifecycleOutcome(operation);
          if (outcome?.taskId === task.id
              && outcome.result?.evidence?.selectedComposition?.previewHash === preview.previewHash
              && outcome.result?.task?.workflowStatus === "testing") {
            return { task: outcome.result.task, selectedComposition: preview,
              ...(outcome.result.evidence.response ?? {}), gitReceipt: applied.receipt };
          }
          const unknown = new Error(`Selected composition durable Task outcome is unknown: ${error.message}`);
          unknown.code = "TASK_SELECTED_COMPOSITION_UNKNOWN";
          throw unknown;
        }
      })
    ));
  }

  async #updateWorkflowStatusLocked({
    taskId, status, operationId, binding = {}, projectRoot = null,
    expectedRevision = null, expectedWorkflowStatus = null, operationEvidence = null,
  } = {}, { releaseWorkflow = false } = {}) {
    return this.#withLock(taskId, (lease = {}) => this.#updateWorkflowStatusWithLease({
      taskId, status, operationId, binding, projectRoot, expectedRevision, expectedWorkflowStatus,
      operationEvidence,
    }, { releaseWorkflow, lease }), { git: releaseWorkflow });
  }

  async #updateWorkflowStatusWithLease({
    taskId, status, operationId, binding = {}, projectRoot = null,
    expectedRevision = null, expectedWorkflowStatus = null, operationEvidence = null,
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
      const snapshotsResult = releaseWorkflow && workflowStatus === "testing";
      const withdrawsResult = releaseWorkflow && ["new", "in_progress", "blocked"].includes(workflowStatus)
        && ["testing", "awaiting_implementation"].includes(task.workflowStatus);
      const acceptsExistingResult = releaseWorkflow
        && ["awaiting_implementation", "done"].includes(workflowStatus);
      const workspace = task.workspaceId ? this.workspaceCatalog.workspace(task.workspaceId) : null;
      const affectsAwait = workspace?.settings?.releaseWorkflowEnabled === true
        && (task.workflowStatus === "awaiting_implementation" || workflowStatus === "awaiting_implementation");
      const selectedProjectRoot = releaseWorkflow ? projectRoot || this.#projectRoot(task) : null;
      if (releaseWorkflow && task.workflowStatus === "blocked" && workflowStatus !== "blocked") {
        await this.taskGitWorkspaces.prepareOwned({
          taskId: task.id, taskNumber: task.taskNumber, projectRoot: selectedProjectRoot, lease,
        });
      }
      let acceptedReference = null;
      if ((affectsAwait || acceptsExistingResult) && !selectedProjectRoot) {
        throw new Error("Task project root is unavailable; exact result was not accepted");
      }
      if (acceptsExistingResult) {
        if (!["testing", "awaiting_implementation"].includes(task.workflowStatus)) {
          throw new Error("Task must enter Test before its exact result can be accepted");
        }
        const references = (task.gitReferences ?? []).filter((reference) => (
          samePath(reference.projectRoot, selectedProjectRoot)
          && /^[a-f0-9]{40}$/u.test(String(reference.resultCommit ?? ""))
        ));
        if (references.length !== 1) {
          throw new Error(
            `Task has no unique Test-owned result for ${selectedProjectRoot}; `
            + `recorded roots: ${(task.gitReferences ?? []).map((reference) => reference.projectRoot).join(", ") || "none"}`,
          );
        }
        [acceptedReference] = references;
      }
      await this.#assertOwned(lease);
      await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
        id: task.id,
        operationId,
        kind: "workflow",
        targetWorkflowStatus: workflowStatus,
        expectedRevision: task.revision,
        evidence: operationEvidence,
        ...(releaseWorkflow && affectsAwait ? {
          releaseContext: {
            workspaceId: task.workspaceId,
            streamId: task.streamId,
            projectRoot: selectedProjectRoot,
            ...(operationEvidence?.cutoverSource ? {
              source: {
                taskId: operationEvidence.cutoverSource.taskId,
                revision: operationEvidence.cutoverSource.revision,
                workflowStatus: operationEvidence.cutoverSource.workflowStatus,
                resultCommit: operationEvidence.cutoverSource.resultCommit,
                projectRoot: operationEvidence.cutoverSource.projectRoot,
              },
            } : {}),
          },
        } : {}),
      }), operationId);
      try {
        if (withdrawsResult) {
          const references = task.gitReferences ?? [];
          const reference = references.find((item) => samePath(item.projectRoot, selectedProjectRoot))
            ?? (references.length === 1 ? references[0] : null);
          if (!reference) throw new Error("Task return requires its exact Test result");
          await this.#assertOwned(lease);
          const current = await this.#mutation(() => this.taskBoard.commitWorkflowTransition({
            operationId,
            gitReferences: [],
            replaceGitReferences: false,
            ...binding,
            evidence: {
              ...(operationEvidence ?? {}),
              outcome: "returned_for_correction",
              acceptedResult: {
                projectRoot: reference.projectRoot,
                resultCommit: reference.resultCommit,
                taskRevision: task.revision,
              },
              response: {
                acceptedResultPreserved: true,
                ...(affectsAwait ? {
                  releaseCandidate: {
                    status: "preserved",
                    reason: "The prior accepted result remains immutable; a corrected descendant can be accepted into a later generation",
                  },
                } : {}),
              },
            },
          }), operationId);
          return {
            task: current,
            acceptedResultPreserved: true,
            ...(affectsAwait ? {
              releaseCandidate: {
                status: "preserved",
                reason: "The prior accepted result remains immutable; a corrected descendant can be accepted into a later generation",
              },
            } : {}),
          };
        }
        if (!snapshotsResult) {
          if (releaseWorkflow && workflowStatus === "awaiting_implementation") {
            requiredMethod(this.taskGitWorkspaces, "withTaskRepositoryRecoveryLock");
            requiredMethod(this.releasePreflight, "prepareAwaitAcceptance");
            return await this.taskGitWorkspaces.withTaskRepositoryRecoveryLock(
              task.id,
              selectedProjectRoot,
              lease,
              async (repositoryLease) => {
                return this.releasePreflight.prepareAwaitAcceptance({
                  workspaceId: task.workspaceId,
                  acceptingTask: { id: task.id, revision: task.revision },
                  projectRoot: selectedProjectRoot,
                  lease: repositoryLease,
                  operationId,
                  commitPrepared: async (prepared) => {
                    if (prepared.task.resultCommit !== acceptedReference.resultCommit) {
                      throw new Error("Task prospective Await result changed before acceptance");
                    }
                    await this.#assertOwned(repositoryLease);
                    let current;
                    try {
                      current = await this.#mutation(() => this.taskBoard.commitWorkflowTransition({
                        operationId, gitReferences: [], replaceGitReferences: false, ...binding,
                        evidence: {
                          ...(operationEvidence ?? {}), outcome: "accepted_existing_result",
                          resultCommit: acceptedReference.resultCommit,
                          releaseIntegration: prepared.task,
                          response: { releaseCandidate: {
                            status: "prepared", reason: "LiveIntegration includes the accepted result",
                            planRevision: prepared.planRevision,
                          } },
                        },
                      }), operationId);
                    } catch (error) {
                      try {
                        const outcome = this.taskBoard.lifecycleOutcome(operationId);
                        if (outcome?.taskId === task.id
                            && outcome.result?.task?.workflowStatus === "awaiting_implementation"
                            && outcome.result?.task?.revision === task.revision + 1
                            && outcome.result?.evidence?.resultCommit === acceptedReference.resultCommit) {
                          current = outcome.result.task;
                        } else {
                          const transition = this.taskBoard.lifecycleTransition(operationId);
                          if (!outcome && transition?.taskId === task.id && transition.phase === "pending_git") throw error;
                          throw new Error("Await acceptance durable outcome does not match its exact result");
                        }
                      } catch (readError) {
                        if (readError === error) throw error;
                        const unknown = new Error(`Await acceptance outcome is unknown: ${readError.message}`);
                        unknown.code = "AWAIT_ACCEPTANCE_UNKNOWN";
                        throw unknown;
                      }
                    }
                    try {
                      this.#releaseOperationPrepare?.(task.id);
                    } catch {}
                    return {
                      task: current,
                      releaseIntegration: prepared.task,
                      releaseCandidate: {
                        status: "prepared", reason: "LiveIntegration includes the accepted result",
                        planRevision: prepared.planRevision,
                      },
                    };
                  },
                });
              },
            );
          }
          await this.#assertOwned(lease);
          const current = await this.#mutation(() => this.taskBoard.commitWorkflowTransition({
            operationId,
            gitReferences: [],
            replaceGitReferences: false,
            ...binding,
            evidence: {
              ...(operationEvidence ?? {}),
              outcome: acceptsExistingResult ? "accepted_existing_result" : "not_required",
              ...(acceptedReference ? { resultCommit: acceptedReference.resultCommit } : {}),
              ...(affectsAwait ? { response: { releaseCandidate: {
                status: "pending", reason: "Await membership changed; candidate preparation requires readback or retry",
              } } } : {}),
            },
          }), operationId);
          if (!affectsAwait) return current;
          return {
            task: current,
            releaseCandidate: { status: "invalidated", reason: "Await membership changed" },
          };
        }
        if (!selectedProjectRoot || !this.taskGitWorkspaces) {
          throw new Error("Task Git workspace is unavailable; workflow status was not changed");
        }
        const { snapshot, integration } = await this.taskGitWorkspaces.snapshotAndMergeOwned({
          taskId: task.id,
          taskNumber: task.taskNumber,
          projectRoot: selectedProjectRoot,
          turnId: null,
          summary: task.title,
          expectedResultReferences: task.workflowStatus === "testing" ? task.gitReferences ?? [] : null,
          lease,
        });
        if (!integration.resultProved || !integration.integrated) {
          if (integration.devRestored === true && integration.conflicts?.length) {
            const failure = new TaskIntegrationConflictError({
              taskId: task.id, operationId, projectRoot: snapshot.projectRoot,
              resultCommit: snapshot.headCommit, devCommit: integration.dev.headCommit,
              conflicts: integration.conflicts, devRestored: true,
            });
            await this.#assertOwned(lease);
            await this.#mutation(() => this.taskBoard.failLifecycleTransition(operationId, failure), operationId);
            const terminal = this.taskBoard.lifecycleTransition(operationId);
            if (terminal?.phase !== "failed" || terminal.taskId !== task.id || terminal.error !== failure.message.slice(0, 4000)) {
              throw new Error("Task conflict outcome could not be confirmed");
            }
            throw failure;
          }
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
            ...(operationEvidence ?? {}),
            outcome: integration.outcome,
            resultCommit: snapshot.headCommit,
            devHeadCommit: integration.dev?.headCommit ?? null,
            response: {
              gitWorkspace: gitWorkspaceResult, gitIntegration: gitIntegrationResult,
              ...(affectsAwait ? { releaseCandidate: {
                status: "pending", reason: "Await result changed; candidate preparation requires readback or retry",
              } } : {}),
            },
          },
        }), operationId);
        return {
          task: current,
          gitWorkspace: gitWorkspaceResult,
          gitIntegration: gitIntegrationResult,
          ...(affectsAwait ? {
            releaseCandidate: { status: "invalidated", reason: "Await result changed" },
          } : {}),
        };
      } catch (error) {
        if (["TASK_WITHDRAWAL_UNKNOWN", "AWAIT_ACCEPTANCE_UNKNOWN", "AWAIT_PREPARATION_UNKNOWN"].includes(error?.code)) throw error;
        if (releaseWorkflow && workflowStatus === "awaiting_implementation") {
          const failure = new TaskAwaitIntegrationError(error);
          await this.#failWhileOwned(lease, operationId, failure);
          const failed = this.taskBoard.lifecycleTransition(operationId);
          if (failed?.taskId === task.id && failed.phase === "failed"
              && failed.error === failure.message.slice(0, 4000)) throw failure;
          throw error;
        }
        if (["TASK_WITHDRAWAL_DEPENDENCY", "TASK_WITHDRAWAL_BUSY"].includes(error?.code)) {
          // The Git owner detects this before writing the withdrawal intent or
          // exchanging dev. Terminalize only our own failed transition.
          const failure = error.code === "TASK_WITHDRAWAL_BUSY"
            ? new TaskWithdrawalBusyError(error)
            : new TaskWithdrawalDependencyError(task.id, error);
          await this.#assertOwned(lease);
          await this.#mutation(() => this.taskBoard.failLifecycleTransition(operationId, failure), operationId);
          const saved = this.taskBoard.lifecycleTransition(operationId);
          if (saved?.taskId !== task.id || saved.phase !== "failed"
              || saved.error !== failure.message.slice(0, 4000)) {
            throw new Error("Task withdrawal refusal could not be confirmed");
          }
          throw failure;
        }
        await this.#failWhileOwned(lease, operationId, error);
        if (error instanceof TaskGitHistoryRejectedError) {
          await this.#assertOwned(lease);
          const failed = this.taskBoard.lifecycleTransition(operationId);
          if (failed?.taskId === task.id && failed.phase === "failed"
              && failed.error === error.message.slice(0, 4000)
              && !this.taskBoard.lifecycleOutcome(operationId)) {
            throw new TaskIntegrationRejectedError(error);
          }
        }
        throw error;
      }
  }

  withUnknownWorkflowReconciliationLock({ taskId, sourceTaskId = null, projectRoot, operationId } = {}, operation) {
    const task = this.#task(taskId);
    const workspace = task.workspaceId ? this.workspaceCatalog.workspace(task.workspaceId) : null;
    if (workspace?.settings?.releaseWorkflowEnabled !== true || !this.releasePreflight) {
      throw new Error("Unknown workflow reconciliation requires an enabled release workflow");
    }
    requiredMethod(this.taskGitWorkspaces, "withTaskRecoveryLock");
    if (sourceTaskId) requiredMethod(this.taskGitWorkspaces, "withTaskRecoveryLocks");
    requiredMethod(this.taskGitWorkspaces, "withTaskRepositoryRecoveryLock");
    const locked = () => (sourceTaskId
        ? this.taskGitWorkspaces.withTaskRecoveryLocks(
          [task.id, sourceTaskId],
          (taskLease) => this.taskGitWorkspaces.withTaskRepositoryRecoveryLock(
            task.id, projectRoot, taskLease, operation,
          ),
          { guardTaskId: task.id },
        )
        : this.taskGitWorkspaces.withTaskRecoveryLock(task.id, (taskLease) => (
        this.taskGitWorkspaces.withTaskRepositoryRecoveryLock(
          task.id, projectRoot, taskLease, operation,
        )
        )));
    return this.releasePreflight.withAwaitTransition(workspace.id, locked);
  }

  async reconcileUnknownWorkflowStatusOwned({
    taskId, operationId, projectRoot, guardId, proof, lease, finalizeCommittedWithdrawal = false,
  } = {}) {
    await this.#assertOwned(lease);
    const current = this.#task(taskId);
    const transition = this.taskBoard.lifecycleTransition?.(operationId);
    const selectedComposition = transition?.evidence?.selectedComposition ?? null;
    if (selectedComposition) {
      if (transition.operationId !== operationId || transition.taskId !== current.id
          || transition.kind !== "workflow" || transition.phase !== "pending_git"
          || transition.targetWorkflowStatus !== "testing"
          || transition.expectedRevision !== current.revision
          || current.workflowStatus !== "in_progress"
          || !samePath(projectRoot, selectedComposition.repositoryRoot)) {
        throw new Error("Selected composition original Task lifecycle identity changed");
      }
      const recovery = guardId ? await this.taskGitWorkspaces.recoverProcessTreeGuard(current.id, {
        repositoryRoot: projectRoot, guardId, proof, lease,
      }) : null;
      if (!guardId) await this.taskGitWorkspaces.assertNoProcessTreeGuardOwned(current.id, { lease });
      const applied = await this.taskGitWorkspaces.applySelectedCompositionOwned(selectedComposition, {
        operationId, lease,
      });
      if (applied.status !== "applied") {
        throw new Error("Selected composition original Git CAS cannot be reconciled");
      }
      const updated = await this.#mutation(() => this.taskBoard.commitWorkflowTransition({
        operationId,
        gitReferences: [{ projectRoot: selectedComposition.repositoryRoot,
          resultCommit: selectedComposition.taskCommit, branch: selectedComposition.branch }],
        evidence: {
          outcome: "integrated", resultCommit: selectedComposition.taskCommit,
          devHeadCommit: selectedComposition.proofCommit,
          selectedComposition,
          response: {
            gitWorkspace: { branch: selectedComposition.branch,
              projectRoot: selectedComposition.taskRoot,
              baseCommit: selectedComposition.taskBaseCommit,
              headCommit: selectedComposition.taskCommit },
            gitIntegration: { outcome: "integrated", integrated: true,
              alreadyIntegrated: false, devBranch: "dev",
              devHeadCommit: selectedComposition.proofCommit, conflicts: [], error: null },
          },
        },
      }), operationId);
      return { result: { task: updated, selectedComposition,
        gitReceipt: applied.receipt }, recovery };
    }
    const squashTransfer = transition?.evidence?.squashTransfer ?? null;
    if (squashTransfer) {
      const squashCutover = transition?.evidence?.squashCutover ?? null;
      for (const name of squashCutover
        ? ["readSquashCutoverOwned", "applySquashCutoverOwned"]
        : ["readSquashTransferOwned", "applySquashTransferOwned", "materializeSquashTransferOwned"]) {
        requiredMethod(this.taskGitWorkspaces, name);
      }
      requiredMethod(this.taskGitWorkspaces, "assertNoProcessTreeGuardOwned");
      requiredMethod(this.taskBoard, "commitSquashTransferTransition");
      const source = this.#task(squashTransfer.source.taskId);
      if (transition.operationId !== operationId || transition.taskId !== current.id
          || transition.phase !== "pending_git" || transition.targetWorkflowStatus !== "testing"
          || current.revision !== transition.expectedRevision
          || source.revision !== transition.priorSourceTask?.revision
          || current.workflowStatus !== (squashCutover ? "in_progress" : "testing")
          || source.workflowStatus !== "testing") {
        throw new Error("Unknown squash transfer identity or two-Task CAS does not match");
      }
      const recovery = guardId ? await this.taskGitWorkspaces.recoverProcessTreeGuard(current.id, {
        repositoryRoot: projectRoot, guardId, proof, lease,
      }) : null;
      if (!guardId) {
        await this.taskGitWorkspaces.assertNoProcessTreeGuardOwned(current.id, { lease });
      }
      let readback = squashCutover
        ? await this.taskGitWorkspaces.readSquashCutoverOwned(squashCutover, { projectRoot, lease })
        : await this.taskGitWorkspaces.readSquashTransferOwned(squashTransfer, { projectRoot, lease });
      if (squashCutover && [
        "not_staged", "pending_survivor_index", "materializing_additions",
        "staged_before_ref", "not_applied", "pending_materialization",
      ].includes(readback.status)) {
        const applied = await this.taskGitWorkspaces.applySquashCutoverOwned({
          cutover: squashCutover, source, survivor: current, lease,
        });
        readback = { status: "applied", proof: applied.squashTransfer };
      } else if (!squashCutover && readback.status === "not_applied") {
        const applied = await this.taskGitWorkspaces.applySquashTransferOwned({
          source, survivor: current, projectRoot,
          baselineResultCommit: squashTransfer.baselineResultCommit,
          newResultCommit: squashTransfer.survivor.resultCommit,
          devAfterTree: squashTransfer.devAfterTree, authority: squashTransfer.authority,
          expectedTransferHash: squashTransfer.transferHash, lease,
        });
        readback = { status: "applied", proof: applied };
      } else if (!squashCutover && readback.status === "pending_materialization") {
        await this.taskGitWorkspaces.materializeSquashTransferOwned(readback.proof, { projectRoot, lease });
        readback = await this.taskGitWorkspaces.readSquashTransferOwned(readback.proof, { projectRoot, lease });
      }
      if (readback.status !== "applied") {
        throw new Error("Unknown squash transfer Git effect cannot be reconciled safely");
      }
      const result = await this.#mutation(() => this.taskBoard.commitSquashTransferTransition({
        operationId,
        squashTransfer: readback.proof,
        ...(squashCutover ? { squashCutover } : {}),
      }), operationId);
      return { result, recovery };
    }
    if (finalizeCommittedWithdrawal) {
      const outcome = this.taskBoard.lifecycleOutcome(operationId);
      const withdrawal = outcome?.result?.evidence?.withdrawal;
      if (transition || outcome?.taskId !== current.id || outcome.result?.evidence?.outcome !== "withdrawn_result"
        || outcome.result?.task?.revision !== current.revision
        || outcome.result?.task?.workflowStatus !== current.workflowStatus
        || !["new", "in_progress", "blocked"].includes(current.workflowStatus)
        || withdrawal?.taskId !== current.id) {
        throw new Error("Committed Task withdrawal identity does not match");
      }
      const pending = await this.taskGitWorkspaces.pendingWithdrawal({ projectRoot, taskId, operationId });
      const recovery = pending && guardId ? await this.taskGitWorkspaces.recoverProcessTreeGuard(current.id, {
        repositoryRoot: projectRoot, guardId, proof, lease,
      }) : null;
      if (pending) {
        await this.taskGitWorkspaces.withdrawResultOwned({
          taskId, taskNumber: current.taskNumber, projectRoot,
          resultCommit: withdrawal.resultCommit, operationId, lease,
          readWorkflowOutcome: async () => ({ status: "committed", result: current }),
          commitWorkflow: async () => { throw new Error("Committed withdrawal must not replay status mutation"); },
        });
      }
      return { result: { task: current, ...(outcome.result.evidence.response ?? {}) }, recovery };
    }
    const pendingWithdrawal = ["new", "in_progress", "blocked"].includes(transition?.targetWorkflowStatus)
      && ["testing", "awaiting_implementation"].includes(current.workflowStatus);
    if (
      transition?.operationId !== operationId
      || transition.taskId !== current.id
      || transition.kind !== "workflow"
      || transition.phase !== "pending_git"
      || (!pendingWithdrawal && transition.targetWorkflowStatus !== "awaiting_implementation")
      || transition.expectedRevision !== current.revision
      || (!pendingWithdrawal && current.workflowStatus !== "testing")
    ) {
      throw new Error("Unknown workflow reconciliation identity or Task CAS does not match");
    }
    if (!pendingWithdrawal && !guardId) throw new Error("Pending Await recovery requires its process-tree guard");
    const recovery = guardId ? await this.taskGitWorkspaces.recoverProcessTreeGuard(current.id, {
      repositoryRoot: projectRoot,
      guardId,
      proof,
      lease,
    }) : null;
    const result = await this.#updateWorkflowStatusWithLease({
      taskId: current.id,
      status: transition.targetWorkflowStatus,
      operationId,
      projectRoot,
      operationEvidence: transition.evidence,
    }, { releaseWorkflow: true, lease });
    return {
      result: result?.releaseCandidate?.status === "invalidated"
        ? { ...result, releaseCandidate: { status: "pending", reason: "Status recovered; candidate preparation requires readback or retry" } }
        : result,
      recovery,
    };
  }

  reconcileUnknownWorkflowStatus(options = {}) {
    return this.withUnknownWorkflowReconciliationLock(options, (lease) => (
      this.reconcileUnknownWorkflowStatusOwned({ ...options, lease })
    ));
  }

  async #cleanupPreview(task, action) {
    const preview = this.taskGitWorkspaces?.cleanupPreview
      ? await this.taskGitWorkspaces.cleanupPreview(task.id, {
        gitReferences: task.gitReferences,
        squashAbsorbedBy: task.squashAbsorbedBy,
      })
      : { taskId: task.id, workspaces: [], gitReferences: task.gitReferences ?? [], dirty: false, unpublished: [], deleting: [] };
    return confirmation(task, action, preview);
  }

  async #completeAbsorbed({ taskId, operationId, confirmCleanup, expectedCleanupToken, absorbedIntoTaskId }) {
    if (taskId === absorbedIntoTaskId) throw new Error("A Task cannot absorb itself");
    requiredMethod(this.taskGitWorkspaces, "withTaskLocks");
    requiredMethod(this.taskGitWorkspaces, "withAbsorptionEvidenceOwned");
    const initial = this.#task(taskId);
    const workspace = initial.workspaceId ? this.workspaceCatalog.workspace(initial.workspaceId) : null;
    const releaseWorkflow = workspace?.settings?.releaseWorkflowEnabled === true;
    if (releaseWorkflow) requiredMethod(this.releasePreflight, "prepareAwaitSet");
    const complete = () => this.taskGitWorkspaces.withTaskLocks([taskId, absorbedIntoTaskId], async (lease) => {
      const task = this.#task(taskId);
      const target = this.#task(absorbedIntoTaskId);
      if (task.workspaceId !== initial.workspaceId
          || (this.workspaceCatalog.workspace(task.workspaceId)?.settings?.releaseWorkflowEnabled === true) !== releaseWorkflow) {
        throw new Error("Workspace changed during combined closure");
      }
      if (!task.workspaceId || task.workspaceId !== target.workspaceId || target.status === "done"
          || !["testing", "awaiting_implementation"].includes(target.workflowStatus)) {
        throw new Error("Surviving Task must be open and tested in the same Workspace");
      }
      if (!["new", "in_progress", "blocked"].includes(task.workflowStatus)) {
        throw new Error("Return the source Task from Test/Await before combining it");
      }
      return this.taskGitWorkspaces.withAbsorptionEvidenceOwned({ source: task, target, lease }, async (gitEvidence, ownedLease) => {
        let composition = null;
        // This gate precedes lifecycle admission. Only this bounded scope can
        // classify composition failure as proof that no source closure began.
        try {
          composition = releaseWorkflow ? await this.releasePreflight.prepareAwaitSet({
            workspaceId: task.workspaceId, validateOnly: true, lease: ownedLease,
            ...(target.workflowStatus === "testing" ? { acceptingTask: { id: target.id, revision: target.revision } } : {}),
          }) : null;
          if (composition && !composition.taskIds.includes(target.id)) {
            throw new Error("Surviving Task is absent from the verified release composition");
          }
          // External editors and Git do not take Hub's leases. Reuse the held
          // repository leases to read both workspaces again after slow validation.
          await this.taskGitWorkspaces.withAbsorptionEvidenceOwned({ source: task, target, lease: ownedLease }, async (fresh) => {
            if (JSON.stringify(fresh) !== JSON.stringify(gitEvidence)) {
              throw new Error("Task Git evidence changed during combined closure validation");
            }
          });
          if (this.#task(target.id).revision !== target.revision || this.#task(task.id).revision !== task.revision) {
            throw new Error("Task changed during combined closure validation");
          }
        } catch (error) {
          throw new TaskAbsorptionCompositionError(error);
        }
        const absorbedInto = { ...gitEvidence, taskRevision: target.revision,
          ...(composition ? { composition } : {}),
        };
        const exactSquash = (gitEvidence.repositories ?? []).length > 0
          && gitEvidence.repositories.every((item) => item.squashTransferHash
            && item.squashTransferHash === task.squashAbsorbedBy?.transferHash);
        const cleanup = exactSquash
          ? await this.taskGitWorkspaces.cleanupPreview(task.id, {
            gitReferences: task.gitReferences,
            squashAbsorbedBy: task.squashAbsorbedBy,
          })
          : { workspaces: [], gitReferences: [], dirty: false, unpublished: [], deleting: [] };
        const preview = confirmation(task, "complete", {
          ...cleanup,
          absorbedInto: { ...absorbedInto, taskRevision: target.revision },
        });
        preview.warning = exactSquash
          ? "Close the squash-absorbed source Task and remove only its exact clean Git artifacts after the survivor is durably published."
          : "Close the source Task as combined. Its branch, worktree and history are preserved; this does not mark it published.";
        if (confirmCleanup !== true) return preview;
        if (expectedCleanupToken !== preview.cleanupToken) throw new Error("Combined closure confirmation is stale; read the preview again");
        if (exactSquash && (cleanup.dirty || cleanup.unpublished.length)) {
          throw new Error("Squash-absorbed Task cleanup requires its exact clean source result and published survivor");
        }
        await this.#assertOwned(lease);
        await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
          id: task.id, operationId, kind: "complete", expectedRevision: task.revision,
          evidence: { absorbedInto },
        }), operationId);
        try {
          await this.#assertOwned(lease);
          if (exactSquash) await this.taskGitWorkspaces.cleanupOwned(task.id, {
            allowDirty: false,
            requirePublished: true,
            gitReferences: task.gitReferences,
            squashAbsorbedBy: task.squashAbsorbedBy,
            expectedPreview: cleanup,
            lease: ownedLease,
          });
          await this.#assertOwned(lease);
          return await this.#mutation(() => this.taskBoard.finalizeCleanupTransition(operationId, {
            receiptEvidence: { absorbedInto, ...(exactSquash ? { cleanup } : {}) },
          }), operationId);
        } catch (error) {
          await this.#failWhileOwned(lease, operationId, error);
          throw error;
        }
      });
    });
    return releaseWorkflow
      ? this.releasePreflight.withAwaitTransition(workspace.id, complete, { changesAwait: async () => true })
      : complete();
  }

  async #completePublishedDuplicate({ taskId, operationId, confirmCleanup, expectedCleanupToken, absorbedIntoTaskId }) {
    if (taskId === absorbedIntoTaskId) throw new Error("A Task cannot absorb itself");
    requiredMethod(this.taskGitWorkspaces, "withTaskLocks");
    requiredMethod(this.taskGitWorkspaces, "withPublishedDuplicateEvidenceOwned");
    const completed = this.taskBoard.lifecycleOutcome?.(operationId);
    if (completed?.taskId === taskId && completed.kind === "complete"
        && completed.result?.evidence?.absorbedInto?.mode === "published_duplicate"
        && completed.result.evidence.absorbedInto.taskId === absorbedIntoTaskId) {
      return completed.result.result;
    }
    const initial = this.#task(taskId);
    const workspace = initial.workspaceId ? this.workspaceCatalog.workspace(initial.workspaceId) : null;
    const releaseWorkflow = workspace?.settings?.releaseWorkflowEnabled === true;
    if (releaseWorkflow) requiredMethod(this.releasePreflight, "withAwaitTransition");
    const complete = () => this.taskGitWorkspaces.withTaskLocks([taskId, absorbedIntoTaskId], async (lease) => {
      const task = this.#task(taskId);
      if (task.workspaceId !== initial.workspaceId
          || (this.workspaceCatalog.workspace(task.workspaceId)?.settings?.releaseWorkflowEnabled === true) !== releaseWorkflow) {
        throw new Error("Workspace changed during published duplicate closure");
      }
      const resumed = this.taskBoard.lifecycleTransition?.(operationId);
      if (resumed) {
        const absorbedInto = resumed.evidence?.absorbedInto;
        const cleanup = resumed.evidence?.cleanup;
        const prior = resumed.priorTask;
        if (resumed.taskId !== task.id || resumed.kind !== "complete" || resumed.phase !== "cleanup"
            || absorbedInto?.mode !== "published_duplicate"
            || absorbedInto.taskId !== absorbedIntoTaskId
            || absorbedInto.source?.taskId !== task.id
            || absorbedInto.survivor?.taskId !== absorbedIntoTaskId
            || Number(absorbedInto.sourceTaskRevision) !== Number(task.revision)
            || Number(resumed.expectedRevision) !== Number(task.revision)
            || absorbedInto.cleanupPlan?.strategy !== "preserve_managed_source"
            || !cleanup || cleanup.taskId !== task.id || (cleanup.deleting ?? []).length
            || !prior || prior.workspaceId !== task.workspaceId || prior.status !== task.status
            || prior.workflowStatus !== task.workflowStatus || Number(prior.revision) !== Number(task.revision)) {
          throw new Error("Task lifecycle operation id does not match this published duplicate closure");
        }
        if (confirmCleanup !== true) {
          throw new Error("Published duplicate lifecycle is already admitted; retry the exact confirmed operation");
        }
        const storedPreview = confirmation(task, "complete", { ...cleanup, absorbedInto });
        if (String(expectedCleanupToken ?? "") !== storedPreview.cleanupToken) {
          throw new Error("Published duplicate retry does not match its admitted confirmation");
        }
        try {
          await this.#assertOwned(lease);
          return await this.#mutation(() => this.taskBoard.finalizeCleanupTransition(operationId, {
            receiptEvidence: { absorbedInto, cleanup },
          }), operationId);
        } catch (error) {
          const outcome = this.taskBoard.lifecycleOutcome?.(operationId);
          if (outcome?.taskId === task.id && outcome.kind === "complete"
              && JSON.stringify(outcome.result?.evidence?.absorbedInto) === JSON.stringify(absorbedInto)) {
            return outcome.result.result;
          }
          throw error;
        }
      }
      const target = this.#task(absorbedIntoTaskId);
      if (!task.workspaceId || task.workspaceId !== target.workspaceId
          || target.status !== "done" || target.workflowStatus !== "done") {
        throw new Error("Published duplicate survivor must be Done in the same Workspace");
      }
      if (task.status === "done" || !["new", "in_progress", "blocked"].includes(task.workflowStatus)) {
        throw new Error("Published duplicate source must remain open and outside Test/Await");
      }
      return this.taskGitWorkspaces.withPublishedDuplicateEvidenceOwned({ source: task, target, lease }, async (gitEvidence, ownedLease) => {
        await this.taskGitWorkspaces.withPublishedDuplicateEvidenceOwned({
          source: task, target, lease: ownedLease,
        }, async (fresh) => {
          if (JSON.stringify(fresh) !== JSON.stringify(gitEvidence)) {
            throw new Error("Published duplicate Git evidence changed during validation");
          }
        });
        if (this.#task(target.id).revision !== target.revision || this.#task(task.id).revision !== task.revision) {
          throw new Error("Task changed during published duplicate validation");
        }
        const absorbedInto = {
          ...gitEvidence,
          taskId: target.id,
          taskRevision: target.revision,
          sourceTaskRevision: task.revision,
        };
        const preservation = (gitEvidence.repositories ?? []).map((item) => ({
          kind: "managed_source",
          projectRoot: item.projectRoot,
          branch: item.sourceBranch,
          headCommit: item.sourceHead,
        }));
        const cleanup = {
          taskId: task.id,
          workspaces: [],
          gitReferences: [],
          dirty: false,
          unpublished: [],
          deleting: [],
          preserving: preservation,
        };
        const preview = confirmation(task, "complete", { ...cleanup, absorbedInto });
        preview.warning = "Close the published zero-delta duplicate and preserve its managed branch/worktree; no result commit is attributed to the duplicate.";
        if (confirmCleanup !== true) return preview;
        if (String(expectedCleanupToken ?? "") !== preview.cleanupToken) {
          throw new Error("Published duplicate closure confirmation is stale; read the preview again");
        }
        await this.#assertOwned(lease);
        const begun = await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
          id: task.id,
          operationId,
          kind: "complete",
          expectedRevision: task.revision,
          evidence: { absorbedInto, cleanup },
        }), operationId);
        if (begun?.phase !== "cleanup") throw new Error("Published duplicate lifecycle is not ready for cleanup finalization");
        try {
          await this.#assertOwned(lease);
          return await this.#mutation(() => this.taskBoard.finalizeCleanupTransition(operationId, {
            receiptEvidence: { absorbedInto, cleanup },
          }), operationId);
        } catch (error) {
          const outcome = this.taskBoard.lifecycleOutcome?.(operationId);
          if (outcome?.taskId === task.id && outcome.kind === "complete"
              && JSON.stringify(outcome.result?.evidence?.absorbedInto) === JSON.stringify(absorbedInto)) {
            return outcome.result.result;
          }
          // No Git deletion occurs in this mode. Retain the exact cleanup-phase
          // transition so retry of the same operation can finalize idempotently.
          throw error;
        }
      });
    });
    return releaseWorkflow
      ? this.releasePreflight.withAwaitTransition(workspace.id, complete, { changesAwait: async () => true })
      : complete();
  }

  async #completePublishedReleaseService({ taskId, operationId, confirmCleanup, expectedCleanupToken }) {
    requiredMethod(this.taskGitWorkspaces, "publishedReleaseServiceEvidenceOwned");
    const priorOutcome = this.taskBoard.lifecycleOutcome?.(operationId);
    if (priorOutcome?.taskId === taskId && priorOutcome.kind === "complete"
        && priorOutcome.result?.evidence?.releaseService?.mode === "published_release_service") {
      return priorOutcome.result.result;
    }
    return this.#withLock(taskId, async (lease) => {
      const task = this.#task(taskId);
      if (task.status === "done" || !["new", "in_progress", "blocked"].includes(task.workflowStatus)) {
        throw new Error("Published release service Task must remain open outside Test/Await");
      }
      const checklist = task.checklist ?? [];
      const taskIds = checklist.map((item) => {
        if (!item.completed) throw new Error("Published release service checklist is incomplete");
        const links = [...String(item.text ?? "").matchAll(/agent-hub:\/\/task\/([0-9a-f-]{36})/gu)];
        const linked = String(item.linkedTaskId ?? links[0]?.[1] ?? "").trim();
        if (!linked || links.length > 1 || (links.length && links[0][1] !== linked)) {
          throw new Error("Published release service checklist has no unique Task identity");
        }
        return linked;
      });
      if (!taskIds.length || new Set(taskIds).size !== taskIds.length) {
        throw new Error("Published release service checklist must select distinct Tasks");
      }
      const selectedTasks = taskIds.map((id) => {
        const selected = this.#task(id);
        if (selected.workspaceId !== task.workspaceId || selected.status !== "done"
            || selected.workflowStatus !== "done") {
          throw new Error("Published release service checklist contains an unfinished Task");
        }
        return selected;
      });
      const releaseService = await this.taskGitWorkspaces.publishedReleaseServiceEvidenceOwned({
        source: task, selectedTasks, lease,
      });
      const cleanup = { taskId: task.id, workspaces: [], gitReferences: [], dirty: false,
        unpublished: [], deleting: [], preserving: releaseService.preserving, releaseService };
      const preview = confirmation(task, "complete", cleanup);
      preview.warning = "Close only the verified published release service Task; preserve its managed worktree and history.";
      if (confirmCleanup !== true) return preview;
      if (String(expectedCleanupToken ?? "") !== preview.cleanupToken) {
        throw new Error("Published release service confirmation is stale");
      }
      const resumed = this.taskBoard.lifecycleTransition?.(operationId);
      if (resumed) {
        if (resumed.taskId !== task.id || resumed.kind !== "complete" || resumed.phase !== "cleanup"
            || Number(resumed.expectedRevision) !== Number(task.revision)
            || JSON.stringify(resumed.evidence?.releaseService) !== JSON.stringify(releaseService)
            || JSON.stringify(resumed.evidence?.cleanup) !== JSON.stringify(cleanup)) {
          throw new Error("Task lifecycle operation id does not match this release service closure");
        }
      } else {
        await this.#assertOwned(lease);
        const begun = await this.#mutation(() => this.taskBoard.beginLifecycleTransition({
          id: task.id, operationId, kind: "complete", expectedRevision: task.revision,
          evidence: { releaseService, cleanup },
        }), operationId);
        if (begun?.phase !== "cleanup") throw new Error("Published release service lifecycle is not ready for finalization");
      }
      await this.#assertOwned(lease);
      return this.#mutation(() => this.taskBoard.finalizeCleanupTransition(operationId, {
        receiptEvidence: { releaseService, cleanup },
      }), operationId);
    });
  }

  async complete({
    taskId, operationId, confirmCleanup = false, expectedCleanupToken = null,
    absorbedIntoTaskId = null, absorptionMode = null, completionMode = null,
  } = {}) {
    if (completionMode != null && completionMode !== "published_release_service") {
      throw new Error("Unsupported Task completion mode");
    }
    if (completionMode && (absorptionMode || absorbedIntoTaskId)) {
      throw new Error("Release service completion cannot absorb another Task");
    }
    if (completionMode === "published_release_service") return this.#completePublishedReleaseService({
      taskId, operationId, confirmCleanup, expectedCleanupToken,
    });
    if (absorptionMode != null && absorptionMode !== "published_duplicate") {
      throw new Error("Unsupported Task absorption mode");
    }
    if (absorptionMode && !absorbedIntoTaskId) {
      throw new Error("Task absorption mode requires absorbed_into_task_id");
    }
    if (absorptionMode === "published_duplicate") return this.#completePublishedDuplicate({
      taskId, operationId, confirmCleanup, expectedCleanupToken, absorbedIntoTaskId,
    });
    if (absorbedIntoTaskId) return this.#completeAbsorbed({
      taskId, operationId, confirmCleanup, expectedCleanupToken, absorbedIntoTaskId,
    });
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
          squashAbsorbedBy: task.squashAbsorbedBy,
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
          squashAbsorbedBy: task.squashAbsorbedBy,
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
