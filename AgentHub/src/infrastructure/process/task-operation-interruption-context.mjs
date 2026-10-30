import { taskOperationExecution } from "../../ports/task-operation-execution-context.mjs";
export { taskOperationExecutionStorage, taskOperationInterrupted, assertTaskOperationExecuting,
  taskOperationExecution } from "../../ports/task-operation-execution-context.mjs";
export function interruptibleTaskLease(lease) {
  const current = taskOperationExecution();
  if (!current) return lease;
  return { ...lease,
    signal: lease.signal ? AbortSignal.any([lease.signal, current.signal]) : current.signal,
    async assertOwned() { current.assertExecuting(); await lease.assertOwned(); current.assertExecuting(); },
    async beginProcessTreeGuard(input) { current.assertExecuting(); return lease.beginProcessTreeGuard(input); },
  };
}

