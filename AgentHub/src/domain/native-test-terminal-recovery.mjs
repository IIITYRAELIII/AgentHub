import path from "node:path";
import { normalizedTaskGitReferences } from "./task-git-reference.mjs";

export function sameTaskWorkflowState(current, expected, { allowMetadataRevision = false } = {}) {
  const state = (task) => task ? {
    id: task.id, workspaceId: task.workspaceId ?? null, streamId: task.streamId ?? null,
    status: task.status ?? null, workflowStatus: task.workflowStatus,
    ...(allowMetadataRevision ? {} : { revision: Number(task.revision) }),
    gitReferences: normalizedTaskGitReferences(task.gitReferences).map((ref) => ({
      projectRoot: path.resolve(ref.projectRoot), branch: ref.branch, resultCommit: ref.resultCommit,
    })),
  } : null;
  return JSON.stringify(state(current)) === JSON.stringify(state(expected));
}

export function nativeTestMetadataDrift(task, transition) {
  return transition?.kind === "workflow" && transition.phase === "pending_git"
    && transition.taskId === task?.id && transition.targetWorkflowStatus === "testing"
    && task.status === "started" && task.workflowStatus === "in_progress"
    && Number.isSafeInteger(task.revision) && task.revision > transition.expectedRevision
    && transition.priorTask?.revision === transition.expectedRevision
    && Object.keys(transition.evidence ?? {}).length === 0
    && sameTaskWorkflowState(task, transition.priorTask, { allowMetadataRevision: true });
}
