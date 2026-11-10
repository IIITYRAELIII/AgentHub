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
  const capsule = { confirmationRequired: true, action: result.action, cleanupToken: result.cleanupToken, task,
    previewIdentity: { sha256: createHash("sha256").update(previewBytes).digest("hex"), bytes: Buffer.byteLength(previewBytes) },
    warning: result.warning, receiptCompacted: true,
    ...(result.previewRecovery ? { previewRecovery: result.previewRecovery } : {}) };
  const complete = { ...capsule, preview: result.preview };
  return Buffer.byteLength(JSON.stringify(complete)) <= 65536 ? complete : { ...capsule, previewOmitted: true };
}

export function ordinaryCleanupOriginal(receipt, confirm) {
  const execution = receipt?.taskExecution, args = execution?.arguments;
  if (!["hub_task_complete", "hub_task_delete"].includes(receipt?.toolName)
      || execution?.version !== 1 || execution.protocol !== "task-operation-interruption-v1"
      || !execution.ownerId || execution.cancellation || !args
      || Object.keys(args).some(key => !["request_id", "task_id", "confirm_cleanup"].includes(key))
      || args.request_id !== receipt.requestId || args.task_id !== execution.taskId
      || mcpArgumentsHash(args) !== receipt.argumentsHash
      || (confirm ? args.confirm_cleanup !== true : args.confirm_cleanup != null && args.confirm_cleanup !== false)) return null;
  return args;
}
