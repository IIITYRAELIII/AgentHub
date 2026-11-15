export function assertNoPendingTaskInterruption(database, taskId) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_mcp_operations'").get()
      || !database.prepare("PRAGMA table_info(hub_mcp_operations)").all().some(row => row.name === "task_execution_json")) return;
  if (database.prepare(`SELECT 1 FROM hub_mcp_operations
      WHERE json_extract(task_execution_json, '$.taskId')=?
      AND json_extract(task_execution_json, '$.cancellation.phase')='requested'`).get(taskId)) {
    throw Object.assign(new Error("Task operation stop is not confirmed; continue its cancellation first"), {
      code: "TASK_OPERATION_STOP_PENDING",
    });
  }
}
