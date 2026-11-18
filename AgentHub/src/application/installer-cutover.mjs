import path from "node:path";
import { taskRunIsActive } from "../domain/task-runs.mjs";

// The maintenance original owns the fence. This adapter creates no operation,
// timer, run state or provider effect. Every admission reads the current row.
export function installerCutoverOperation(store, dataDir) {
  const root = path.resolve(dataDir, "..");
  const key = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const operation = store.activeForReadonly({ kind: "restart",
    streamId: "agent-hub-installer", threadId: key(root) });
  const binding = operation?.metadata?.autonomousInstaller;
  if (!binding || key(binding.runtimeRoot) !== key(root)
    || !["wait", "force"].includes(binding.mode)) return null;
  return operation;
}

export function installerCutoverSnapshot({ operation, runs, pendingAdmission, maintenanceCount = 0 }) {
  const active = runs.filter(taskRunIsActive);
  return {
    protocol: 1,
    operationId: operation?.operationId ?? null,
    revision: operation?.revision ?? null,
    mode: operation?.metadata?.autonomousInstaller?.mode ?? null,
    admissionClosed: Boolean(operation),
    activeCount: active.length + maintenanceCount,
    unknownCount: active.filter(run => run.activityUnknown === true).length,
    pendingAdmission: pendingAdmission === true,
  };
}
