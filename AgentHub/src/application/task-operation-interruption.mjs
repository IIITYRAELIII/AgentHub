import { taskOperationExecutionStorage as execution, taskOperationInterrupted } from "../infrastructure/process/task-operation-interruption-context.mjs";
export { taskOperationInterrupted } from "../infrastructure/process/task-operation-interruption-context.mjs";
import { randomUUID } from "node:crypto";
import { mcpArgumentsHash } from "../domain/mcp-arguments-hash.mjs";

export const INTERRUPTIBLE_TASK_TOOLS = new Set(["hub_task_claim", "hub_task_status_update"]);
function publicCancellation(value) {
  return { phase: value.phase, requestId: value.requestId, taskId: value.taskId,
    effects: value.effects, requestedAtMs: value.requestedAtMs,
    ...(value.stoppedAtMs == null ? {} : { stoppedAtMs: value.stoppedAtMs }),
    ...(value.waitingFor ? { waitingFor: value.waitingFor } : {}) };
}

// This owner adds execution disposition to the EXISTING MCP receipt. Original
// history never becomes NO_EFFECT merely because execution stopped.
export class TaskOperationInterruption {
  #live = new Map();
  #instance = randomUUID();
  constructor({ catalog, tasks, taskGit, runtime = null, record = () => {} }) {
    Object.assign(this, { catalog, tasks, taskGit, runtime, record });
  }
  binding(args) {
    return { version: 1, protocol: "task-operation-interruption-v1", taskId: args.task_id,
      taskWorkspaceId: this.tasks.task(args.task_id)?.workspaceId ?? null,
      ownerId: this.#instance,
      arguments: Object.fromEntries(Object.entries(args).filter(([key]) => key !== "context_token")) };
  }
  async run(receipt, args, operation) {
    const existing = this.catalog.mcpOperation(receipt.requestId)?.taskExecution;
    if (existing?.cancellation) throw taskOperationInterrupted();
    const controller = new AbortController();
    const binding = this.binding(args);
    await this.catalog.bindTaskOperationExecution(receipt.requestId, binding);
    const current = { signal: controller.signal, assertExecuting: () => {
      if (controller.signal.aborted || this.catalog.mcpOperation(receipt.requestId)?.taskExecution?.cancellation) {
        throw taskOperationInterrupted();
      }
    } };
    let resolveStopped;
    const stopped = new Promise(resolve => { resolveStopped = resolve; });
    this.#live.set(receipt.requestId, { controller, stopped });
    try { return await execution.run(current, async () => {
      current.assertExecuting();
      const result = await operation();
      current.assertExecuting();
      return result;
    }); } finally {
      this.#live.delete(receipt.requestId);
      resolveStopped();
    }
  }
  list(taskId) {
    return this.catalog.taskOperationExecutions(taskId).map(row => ({
      requestId: row.requestId, toolName: row.toolName, argumentsHash: row.argumentsHash,
      streamId: row.streamId, provider: row.provider, threadId: row.threadId,
      createdAtMs: row.createdAtMs, status: row.status, error: row.error,
      targetStatus: row.taskExecution.arguments?.status ?? null,
      cancellation: row.taskExecution.cancellation ? publicCancellation(row.taskExecution.cancellation) : null,
    }));
  }
  async cancel({ actor, taskId, operationRequestId, originalArguments = null,
    expectedArgumentsHash, expectedTaskRevision, cancellationRequestId, runtimeWitness = null }) {
    const original = this.catalog.mcpOperation(operationRequestId);
    const task = this.tasks.task(taskId);
    if (!original || !task || !INTERRUPTIBLE_TASK_TOOLS.has(original.toolName)
      || (!actor.user && actor.workspaceId !== original.workspaceId)
      || (!actor.user && !actor.releaseManager && actor.streamId !== original.streamId)
      || original.argumentsHash !== expectedArgumentsHash) throw new Error("Task operation cancellation identity or authority differs");
    const old = original.taskExecution;
    if (old && old.taskId !== taskId) throw new Error("Task operation cancellation Task identity differs");
    if (typeof cancellationRequestId !== "string" || !cancellationRequestId.trim()) throw new Error("Cancellation request id is required");
    if (typeof this.taskGit?.withTaskRecoveryLock !== "function") throw new Error("Task cancellation Git owner is unavailable");
    const args = old?.arguments ?? originalArguments;
    if (!args || args.task_id !== taskId || args.request_id !== operationRequestId
      || Object.hasOwn(args, "context_token")
      || mcpArgumentsHash(args) !== original.argumentsHash) throw new Error("Exact original Task arguments are required");
    if (old?.cancellation?.phase === "stopped") return publicCancellation(old.cancellation);
    if (task.revision !== expectedTaskRevision) throw new Error("Task revision changed before operation cancellation");
    if (["succeeded", "failed"].includes(original.status) && !old?.cancellation) {
      return { phase: "already_terminal", requestId: operationRequestId, status: original.status };
    }
    if (original.claimCustody || this.catalog.claimCustodyForOriginal?.(operationRequestId)) throw new Error("Original already has a forward custody owner");
    let cohort = old?.cancellation?.cohort ?? null;
    const live = this.#live.get(operationRequestId);
    const local = old?.ownerId === this.#instance;
    const aware = old?.protocol === "task-operation-interruption-v1" && typeof old.ownerId === "string" && old.ownerId.length > 0;
    if (!local && !aware && !cohort) {
      if (!this.runtime?.capture) throw new Error("Historical worker retirement evidence is unavailable");
      if (this.runtime.requiresRetainedWitness && !runtimeWitness) {
        throw new Error("Historical worker cancellation requires its retained native runtime witness before retirement");
      }
      cohort = await this.runtime.capture({ original, witness: runtimeWitness });
    }
    const cancellation = await this.catalog.requestTaskOperationInterruption(operationRequestId, {
      taskId, targetWorkspaceId: task.workspaceId, expectedArgumentsHash, expectedTaskRevision, actor,
      arguments: args, cohort, cancellationRequestId, requestedAtMs: Date.now(),
    });
    try { this.record({ commandId: operationRequestId, stage: "task-operation-cancel-requested", outcome: "requested" }); } catch {}
    live?.controller.abort(taskOperationInterrupted());
    if (live) await live.stopped;
    let retirement;
    if (local) retirement = { kind: "joined-local-worker", ownerId: this.#instance };
    else if (aware) retirement = { kind: "durable-execution-fence-and-owned-task-lease", ownerId: old.ownerId };
    else {
      try { retirement = await this.runtime.assertRetired(cancellation.cohort); }
      catch { return publicCancellation({ ...cancellation, waitingFor: "previous-runtime-retirement" }); }
    }
    const finalize = async lease => {
      await lease.assertOwned();
      await this.taskGit.assertNoProcessTreeGuardOwned(taskId, { lease });
      // Failure of this existing transition does not roll back Git or replace
      // a committed lifecycle outcome. Its original evidence stays retained.
      await this.tasks.failLifecycleTransition(operationRequestId, taskOperationInterrupted());
      const result = await this.catalog.finishTaskOperationInterruption(operationRequestId, retirement);
      try { this.record({ commandId: operationRequestId, stage: "task-operation-cancel-stopped", outcome: "stopped",
        durationMs: result.stoppedAtMs - result.requestedAtMs }); } catch {}
      return publicCancellation(result);
    };
    return this.taskGit.withTaskRecoveryLock(taskId, finalize);
  }
}
