import { AsyncLocalStorage } from "node:async_hooks";

// Shared execution capability: application and adapters observe one context.
// It owns no process, persistence or cancellation decision.
export const taskOperationExecutionStorage = new AsyncLocalStorage();
export function taskOperationInterrupted() {
  return Object.assign(new Error("Task operation execution was explicitly interrupted; prior effects are retained"), {
    code: "TASK_OPERATION_INTERRUPTED",
  });
}
export function assertTaskOperationExecuting() { taskOperationExecutionStorage.getStore()?.assertExecuting(); }
export function taskOperationExecution() { return taskOperationExecutionStorage.getStore() ?? null; }
