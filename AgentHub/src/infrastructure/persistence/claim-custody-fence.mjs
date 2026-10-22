import { claimCustodyState, TaskClaimCustodyRejectedError } from "../../domain/claim-forward-custody.mjs";

// Read the existing MCP ledger, not a second authority. Both canonical SQL writers
// call this inside their own transaction before any binding/baseline mutation.
export function readClaimCustodyFence(database, scope, id) {
  if (!["task", "original"].includes(scope)) throw new Error("Invalid custody fence scope");
  const columns = database.prepare("PRAGMA table_info(hub_mcp_operations)").all();
  if (!columns.some(c => c.name === "claim_custody_json")) return null;
  const field = scope === "task" ? "taskId" : "original.requestId";
  const rows = database.prepare(`SELECT * FROM hub_mcp_operations
    WHERE json_extract(claim_custody_json, '$.phase') = 'fenced'
      AND json_extract(claim_custody_json, '$.${field}') = ? ORDER BY created_at_ms DESC`).all(String(id));
  for (const row of rows) {
    const state = claimCustodyState({ requestId: row.request_id, workspaceId: row.workspace_id,
      streamId: row.stream_id, threadId: row.provider_thread_id, provider: row.provider, argumentsHash: row.arguments_hash,
      toolName: row.tool_name, claimCustody: JSON.parse(row.claim_custody_json) });
    if (!state) throw new TaskClaimCustodyRejectedError("Invalid durable custody fence");
    if (scope === "original") return state;
    const consumed = database.prepare("SELECT * FROM hub_task_turn_bindings WHERE operation_id = ?").get(state.successorClaimRequestId);
    if (!consumed) return state;
    if (consumed.task_id !== state.taskId || consumed.provider !== state.original.provider
        || consumed.provider_thread_id !== state.original.threadId) throw new TaskClaimCustodyRejectedError("Foreign custody binding");
  }
  return null;
}

export function configureClaimCustodyBindingFences(database) {
  const hasBindings = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hub_task_turn_bindings'").get();
  if (!hasBindings || !database.prepare("PRAGMA table_info(hub_mcp_operations)").all().some(c => c.name === "claim_custody_json")) return;
  for (const event of ["INSERT", "UPDATE"]) database.exec(`
    CREATE TRIGGER IF NOT EXISTS hub_claim_withdrawn_binding_${event.toLowerCase()}
    BEFORE ${event} ON hub_task_turn_bindings
    WHEN EXISTS (SELECT 1 FROM hub_mcp_operations fence
      WHERE json_extract(fence.claim_custody_json, '$.phase') = 'fenced'
        AND json_extract(fence.claim_custody_json, '$.original.requestId') = NEW.operation_id)
    BEGIN SELECT RAISE(ABORT, 'Task claim future continuation was withdrawn before binding mutation'); END;
  `);
}
