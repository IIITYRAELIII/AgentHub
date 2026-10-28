import { AsyncLocalStorage } from "node:async_hooks";
export const taskOperationExecutionStorage = new AsyncLocalStorage();
const execution = taskOperationExecutionStorage;
export function taskOperationInterrupted() {
  return Object.assign(new Error("Task operation execution was explicitly interrupted; prior effects are retained"), {
    code: "TASK_OPERATION_INTERRUPTED",
  });
}
export function assertTaskOperationExecuting() { execution.getStore()?.assertExecuting(); }
export function taskOperationExecution() { return execution.getStore() ?? null; }
export function interruptibleTaskLease(lease) {
  const current = execution.getStore();
  if (!current) return lease;
  return { ...lease,
    signal: lease.signal ? AbortSignal.any([lease.signal, current.signal]) : current.signal,
    async assertOwned() { current.assertExecuting(); await lease.assertOwned(); current.assertExecuting(); },
    async beginProcessTreeGuard(input) { current.assertExecuting(); return lease.beginProcessTreeGuard(input); },
  };
}

