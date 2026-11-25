import { createHash } from "node:crypto";
import { mcpArgumentsHash } from "./mcp-arguments-hash.mjs";

export class TaskCleanupConfirmationRejectedError extends Error {
  constructor(taskId, action) {
    super(`Task ${action} confirmation is stale or missing; read the preview again`);
    this.code = "TASK_CLEANUP_CONFIRMATION_REJECTED";
    this.evidence = { kind: "cleanup-confirmation-validation-v1", taskId, action, admission: "not_entered" };
  }
}

export function cleanupConfirmationCapsule(result) {
  if (result?.confirmationRequired !== true || !["complete", "delete"].includes(result.action)
      || !/^[a-f0-9]{64}$/u.test(result.cleanupToken ?? "") || !result.task?.id
      || !Number.isSafeInteger(result.task.revision)) return null;
  const task = Object.fromEntries(["id", "taskNumber", "revision", "status", "workflowStatus"]
    .filter(key => result.task[key] != null).map(key => [key, result.task[key]]));
  const previewBytes = JSON.stringify(result.preview ?? null);
  const absorbed = result.preview?.absorbedInto ?? result.absorption ?? null;
  if (absorbed && (result.action !== "complete" || typeof absorbed.taskId !== "string" || !absorbed.taskId
      || absorbed.taskId === result.task.id || !Number.isSafeInteger(absorbed.taskRevision))) return null;
  const capsule = { confirmationRequired: true, action: result.action, cleanupToken: result.cleanupToken, task,
    previewIdentity: { sha256: createHash("sha256").update(previewBytes).digest("hex"), bytes: Buffer.byteLength(previewBytes) },
    ...(absorbed ? { absorption: { taskId: absorbed.taskId, taskRevision: absorbed.taskRevision } } : {}),
    warning: result.warning, receiptCompacted: true,
    ...(result.preview?.archive ? { archivePreview: true,
      archiveArtifactsRemain: result.preview.remainingArtifacts.length > 0 } : {}),
    ...(result.previewRecovery ? { previewRecovery: result.previewRecovery } : {}) };
  const complete = { ...capsule, preview: result.preview };
  return Buffer.byteLength(JSON.stringify(complete)) <= 65536 ? complete : { ...capsule, previewOmitted: true };
}

export function archivedArtifactPreview(result) {
  return result?.status === "done" && Array.isArray(result.archive?.remainingArtifacts)
    ? { archive: true, remainingArtifacts: result.archive.remainingArtifacts } : null;
}

export function archivedArtifactCapsule(result) {
  const preview = archivedArtifactPreview(result);
  if (!preview || !/^[a-f0-9]{64}$/u.test(result.cleanupToken ?? "")) return null;
  const raw = JSON.stringify(preview);
  return { id: result.id, taskId: result.id, status: result.status, workflowStatus: result.workflowStatus,
    cleanupToken: result.cleanupToken, archivePreview: true, archiveArtifactsRemain: preview.remainingArtifacts.length > 0,
    receiptCompacted: true, previewOmitted: true,
    previewIdentity: { sha256: createHash("sha256").update(raw).digest("hex"), bytes: Buffer.byteLength(raw) } };
}

export function cleanupConfirmationOriginal(receipt, confirm) {
  const execution = receipt?.taskExecution, args = execution?.arguments;
  const absorption = args && Object.hasOwn(args, "absorbed_into_task_id");
  // Only a read-only ordinary combined-closure preview joins this migration.
  // Historical UNKNOWN special confirmations keep their original refusal.
  if (absorption && (confirm || receipt.toolName !== "hub_task_complete"
      || typeof args.absorbed_into_task_id !== "string" || !args.absorbed_into_task_id.trim()
      || args.absorbed_into_task_id === args.task_id)) return null;
  if (!["hub_task_complete", "hub_task_delete"].includes(receipt?.toolName)
      || execution?.version !== 1 || execution.protocol !== "task-operation-interruption-v1"
      || !execution.ownerId || execution.cancellation || !args
      || Object.keys(args).some(key => !["request_id", "task_id", "confirm_cleanup",
        ...(absorption ? ["absorbed_into_task_id"] : [])].includes(key))
      || args.request_id !== receipt.requestId || args.task_id !== execution.taskId
      || mcpArgumentsHash(args) !== receipt.argumentsHash
      || (confirm ? args.confirm_cleanup !== true : args.confirm_cleanup != null && args.confirm_cleanup !== false)) return null;
  return args;
}
