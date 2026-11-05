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
  const evidence = transition?.evidence ?? {};
  // Only presentation may advance while the already applied original waits
  // for terminal persistence. Unknown evidence families stay with their owner.
  const semanticState = value => {
    const { title, description, correctedText, revision, updatedAt, detailsRevision, ...state } = value ?? {};
    const canonical = item => Array.isArray(item) ? item.map(canonical)
      : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
    return JSON.stringify(canonical(state));
  };
  return transition?.kind === "workflow" && transition.phase === "pending_git"
    && transition.taskId === task?.id && transition.targetWorkflowStatus === "testing"
    && task.status === "started" && task.workflowStatus === "in_progress"
    && Number.isSafeInteger(task.revision) && task.revision > transition.expectedRevision
    && transition.priorTask?.revision === transition.expectedRevision
    && Object.keys(evidence).every(key => key === "nativeResolutionReview")
    && sameTaskWorkflowState(task, transition.priorTask, { allowMetadataRevision: true })
    && semanticState(task) === semanticState(transition.priorTask);
}
