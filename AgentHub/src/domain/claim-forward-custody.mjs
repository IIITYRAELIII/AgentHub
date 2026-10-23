import { createHash } from "node:crypto";
import { canonicalMcpValue, mcpArgumentsHash } from "./mcp-arguments-hash.mjs";

export class TaskClaimCustodyRejectedError extends Error {
  constructor(message, options) { super(message, options); this.code = "TASK_CLAIM_CUSTODY_REJECTED"; }
}
export class TaskClaimContinuationWithdrawnError extends Error {
  constructor() {
    super("This claim's future continuation was withdrawn; its historical UNKNOWN is unchanged");
    this.code = "TASK_CLAIM_CONTINUATION_WITHDRAWN";
  }
}
export function claimCustodyHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalMcpValue(value))).digest("hex");
}
export function claimCustodyState(receipt) {
  const state = receipt?.claimCustody;
  if (!state || state.version !== 1 || state.kind !== "claim-forward-custody-v1"
      || !["planned", "fenced"].includes(state.phase)
      || receipt.toolName !== "hub_task_operation_reconcile" || state.requestId !== receipt.requestId
      || state.argumentsHash !== receipt.argumentsHash || state.workspaceId !== receipt.workspaceId
      || state.actorStreamId !== receipt.streamId || state.actorThreadId !== receipt.threadId || state.actorProvider !== receipt.provider
      || !state.original?.requestId || state.original.toolName !== "hub_task_claim"
      || !state.taskId || !Number.isSafeInteger(state.taskRevision)
      || !state.successorClaimRequestId || !state.source || !state.envelope
      || (state.phase === "fenced" && !/^[a-f0-9]{64}$/.test(state.successorArgumentsHash ?? ""))) return null;
  return state;
}
export function assertClaimCustodyOriginal(original, envelope, taskId, operationId) {
  const reject = message => { throw new TaskClaimCustodyRejectedError(message); };
  if (!original || original.toolName !== "hub_task_claim" || original.requestId !== operationId
      || original.status !== "unknown" || !Number.isSafeInteger(original.completedAtMs)
      || original.completedAtMs < original.createdAtMs) reject("Original claim is not a completed ambiguous intake");
  if (original.result !== null || original.preparationState != null) reject("Original retains partial effect evidence requiring its own review");
  const allowed = new Set(["action", "authorization_id", "handoff_id", "expected_original", "original_arguments",
    "expected_task_revision", "expected_owner_stream_id", "successor_claim_request_id", "source", "runtime_witness", "admission"]);
  if (!envelope || Object.keys(envelope).some(k => !allowed.has(k))) reject("Unexpected forward custody argument");
  const expected = envelope?.expected_original;
  for (const key of ["workspaceId", "streamId", "provider", "threadId", "argumentsHash", "createdAtMs"]) {
    if (!expected || expected[key] !== original[key]) reject(`Original claim ${key} differs`);
  }
  const args = envelope.original_arguments;
  if (envelope.admission != null && envelope.admission !== "isolated-source-v1") reject("Unknown custody admission guarantee");
  if (envelope.admission && envelope.runtime_witness != null) reject("Isolation cannot manufacture a retirement witness");
  if (!args || args.task_id !== taskId || args.request_id !== operationId
      || Object.keys(args).some(k => !["task_id", "request_id", "dependency_mode", "dependency_override_reason"].includes(k))
      || mcpArgumentsHash(args) !== original.argumentsHash) reject("Original claim argument identity differs");
  if (!Number.isSafeInteger(envelope.expected_task_revision) || envelope.expected_task_revision < 1
      || !envelope.expected_owner_stream_id || !envelope.successor_claim_request_id
      || envelope.successor_claim_request_id === original.requestId
      || typeof envelope.authorization_id !== "string" || !envelope.authorization_id || envelope.authorization_id.length > 200
       || typeof envelope.handoff_id !== "string" || !envelope.handoff_id || envelope.handoff_id.length > 200
       || typeof envelope.successor_claim_request_id !== "string" || envelope.successor_claim_request_id.length > 200
      || !/^[0-9a-f]{40}$/.test(envelope.source?.headCommit ?? "")
      || !/^[0-9a-f]{40}$/.test(envelope.source?.tree ?? "")
      || !/^[0-9a-f]{64}$/.test(envelope.source?.wipDigest ?? "")
      || typeof envelope.source?.projectRoot !== "string") reject("Incomplete forward custody pins");
  if (Buffer.byteLength(JSON.stringify(envelope)) > 24 * 1024) reject("Forward custody envelope exceeds its budget");
  return original;
}
