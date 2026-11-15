import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { createHash } from "node:crypto";

// Read-only projection of EXISTING Task/MCP lifecycle ownership, never a new
// registry, migration, terminal repair or inference from a missing process.
export function nativeCaptureRetirementEvidence(dataDir, taskId, requiredOriginalId) {
  const db = new DatabaseSync(path.join(dataDir, "journal.sqlite"), { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!["hub_mcp_operations", "hub_task_turn_bindings", "hub_task_lifecycle_transitions", "hub_task_lifecycle_outcomes"].every(t => tables.has(t))) throw new Error("Canonical native retirement evidence unavailable");
    const columns = new Set(db.prepare("PRAGMA table_info(hub_mcp_operations)").all().map(c => c.name));
    if (!columns.has("task_execution_json")) throw new Error("Canonical Task execution identity unavailable");
    const transitions = db.prepare("SELECT * FROM hub_task_lifecycle_transitions WHERE task_id=? ORDER BY operation_id").all(taskId);
    const outcomes = db.prepare("SELECT * FROM hub_task_lifecycle_outcomes WHERE task_id=? ORDER BY operation_id").all(taskId);
    // Older successful/compacted receipts predate task_execution_json and may
    // have no result Task projection. Their existing lifecycle outcome binds
    // the original to this Task; never infer it from request text or absence.
    const originals = db.prepare(`SELECT * FROM hub_mcp_operations
      WHERE json_extract(task_execution_json,'$.taskId')=? OR request_id IN (
        SELECT operation_id FROM hub_task_turn_bindings WHERE task_id=?
        UNION SELECT operation_id FROM hub_task_lifecycle_transitions WHERE task_id=?
        UNION SELECT operation_id FROM hub_task_lifecycle_outcomes WHERE task_id=?)
      ORDER BY request_id`).all(taskId, taskId, taskId, taskId);
    if (!originals.some(row => row.request_id === requiredOriginalId)) throw new Error("Original native capture lacks canonical Task custody");
    const unresolved = originals.filter(row => !["succeeded", "failed"].includes(row.status)
      || !["succeeded", "failed"].includes(row.receipt_state)
      || JSON.parse(row.task_execution_json || "null")?.cancellation?.phase === "requested");
    const pending = transitions.filter(row => ["pending_git", "cleanup"].includes(row.phase));
    if (pending.length || unresolved.length) throw Object.assign(new Error("Canonical Task original remains unresolved"), {
      originalIds: [...pending.map(r => r.operation_id), ...unresolved.map(r => r.request_id)] });
    const digest = createHash("sha256").update(JSON.stringify({ transitions, outcomes, originals })).digest("hex");
    return { taskId, originalsSha256: digest, originalCount: originals.length };
  } finally { db.close(); }
}
