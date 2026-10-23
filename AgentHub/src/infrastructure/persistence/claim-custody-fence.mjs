import { claimCustodyHash, claimCustodyState, TaskClaimCustodyRejectedError } from "../../domain/claim-forward-custody.mjs";

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

// The permit is visible only inside the current SQLite write transaction. An
// already-open legacy connection cannot observe/use it between statements: the
// database has one writer, and we remove it before releasing that transaction.
// This protects against the actual old owners, not arbitrary SQL with OS access.
export function withClaimCustodySqlPermit(database, authority, operation) {
  if (!authority) return operation();
  const ownTransaction = !database.isTransaction;
  if (ownTransaction) database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare(`SELECT request_id, claim_custody_json, claim_custody_write_json
      FROM hub_mcp_operations WHERE request_id = ?`).get(authority.fenceRequestId);
    const state = row && JSON.parse(row.claim_custody_json ?? "null");
    if (state?.phase !== "fenced" || state.taskId !== authority.taskId
        || !state.namespace?.epoch || state.namespace.epoch !== authority.epoch
        || row.claim_custody_write_json != null) throw new TaskClaimCustodyRejectedError("Namespace SQL authority differs");
    const permit = JSON.stringify({ taskId: state.taskId, epoch: state.namespace.epoch, operationId: authority.operationId });
    database.prepare("UPDATE hub_mcp_operations SET claim_custody_write_json = ? WHERE request_id = ?").run(permit, row.request_id);
    const result = operation();
    if (result?.then) throw new TypeError("Custody SQL permit must not cross an asynchronous boundary");
    database.prepare("UPDATE hub_mcp_operations SET claim_custody_write_json = NULL WHERE request_id = ?").run(row.request_id);
    if (ownTransaction) database.exec("COMMIT");
    return result;
  } catch (error) {
    if (ownTransaction) database.exec("ROLLBACK");
    else database.prepare("UPDATE hub_mcp_operations SET claim_custody_write_json = NULL WHERE request_id = ?")
      .run(authority.fenceRequestId);
    throw error;
  }
}

// These are data triggers, not checks in new JavaScript. They apply to legacy
// open connections/cached statements as SQLite revalidates their schema, and to
// DELETE/REPLACE/cascades as well as ordinary UPDATE/UPSERT paths.
export function configureClaimCustodyNamespaceFences(database) {
  const columns = database.prepare("PRAGMA table_info(hub_mcp_operations)").all();
  if (!columns.some(c => c.name === "claim_custody_write_json")) return;
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const scoped = [];
  for (const { name } of tables) {
    if (!/^hub_[a-z_]+$/.test(name)) continue;
    const keys = custodyTaskExpressions(database, name);
    if (!keys.length) continue;
    // REPLACE's implicit DELETE does not run DELETE triggers on legacy
    // connections with recursive_triggers=OFF. Inspect the existing rows that
    // NEW could evict through ANY column-based unique key before the write.
    const uniqueKeys = database.prepare(`PRAGMA index_list(${name})`).all()
      .filter(index => index.unique).map(index => database.prepare(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`).all())
      .filter(index => index.length && index.every(column => /^[a-z_]+$/.test(column.name ?? "")))
      .map(index => index.map(column => column.name));
    scoped.push({ table: name, keys });
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const sides = event === "INSERT" ? ["NEW"] : event === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
      const ids = sides.flatMap(side => custodyTaskExpressions(database, name, `${side}.`)).join(", ");
      const replaced = event === "DELETE" ? [] : uniqueKeys.map(columns => `EXISTS (
        SELECT 1 FROM ${name} custody_conflict WHERE
          json_extract(fence.claim_custody_json, '$.taskId') IN (${custodyTaskExpressions(database, name, "custody_conflict.").join(", ")})
          AND ${columns.map(column => `custody_conflict.${column} = NEW.${column}`).join(" AND ")})`);
      database.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_custody_namespace_${event.toLowerCase()}
        BEFORE ${event} ON ${name}
        WHEN EXISTS (SELECT 1 FROM hub_mcp_operations fence
          WHERE json_extract(fence.claim_custody_json, '$.phase') = 'fenced'
            AND json_extract(fence.claim_custody_json, '$.namespace.epoch') IS NOT NULL
            AND (json_extract(fence.claim_custody_json, '$.taskId') IN (${ids})${replaced.map(expression => ` OR ${expression}`).join("")})
            AND (fence.claim_custody_write_json IS NULL
              OR json_extract(fence.claim_custody_write_json, '$.epoch') IS NOT json_extract(fence.claim_custody_json, '$.namespace.epoch')
              OR json_extract(fence.claim_custody_write_json, '$.taskId') IS NOT json_extract(fence.claim_custody_json, '$.taskId')))
        BEGIN SELECT RAISE(ABORT, 'Task namespace authority required by durable custody fence'); END;`);
    }
  }
  for (const event of ["DELETE", "UPDATE"]) {
    database.exec(`CREATE TRIGGER IF NOT EXISTS hub_claim_namespace_ledger_${event.toLowerCase()}
      BEFORE ${event} ON hub_mcp_operations
      WHEN EXISTS (SELECT 1 FROM hub_mcp_operations fence
        WHERE json_extract(fence.claim_custody_json, '$.phase') = 'fenced'
          AND (json_extract(fence.claim_custody_json, '$.original.requestId') = OLD.request_id
            OR (fence.request_id = OLD.request_id AND ${event === "DELETE" ? "1" : "NEW.claim_custody_json IS NOT OLD.claim_custody_json"})))
      BEGIN SELECT RAISE(ABORT, 'Historical receipt and custody authority cannot be replaced'); END;`);
  }
  database.exec(`CREATE TRIGGER IF NOT EXISTS hub_claim_namespace_ledger_insert
    BEFORE INSERT ON hub_mcp_operations
    WHEN EXISTS (SELECT 1 FROM hub_mcp_operations fence
      WHERE json_extract(fence.claim_custody_json, '$.phase') = 'fenced'
        AND (json_extract(fence.claim_custody_json, '$.original.requestId') = NEW.request_id OR fence.request_id = NEW.request_id
          OR json_extract(fence.claim_custody_json, '$.original.requestId') = json_extract(NEW.claim_custody_json, '$.original.requestId')
          OR json_extract(fence.claim_custody_json, '$.taskId') = json_extract(NEW.claim_custody_json, '$.taskId')))
    BEGIN SELECT RAISE(ABORT, 'Historical receipt and custody authority cannot be upserted'); END;`);
  database.exec(`CREATE TRIGGER IF NOT EXISTS hub_claim_namespace_ledger_rekey
    BEFORE UPDATE ON hub_mcp_operations
    WHEN EXISTS (SELECT 1 FROM hub_mcp_operations fence
      WHERE json_extract(fence.claim_custody_json, '$.phase') = 'fenced' AND fence.request_id != OLD.request_id
        AND (fence.request_id = NEW.request_id OR json_extract(fence.claim_custody_json, '$.original.requestId') = NEW.request_id
          OR json_extract(fence.claim_custody_json, '$.original.requestId') = json_extract(NEW.claim_custody_json, '$.original.requestId')
          OR json_extract(fence.claim_custody_json, '$.taskId') = json_extract(NEW.claim_custody_json, '$.taskId')))
    BEGIN SELECT RAISE(ABORT, 'Custody identity cannot be replaced through another row'); END;`);
  return scoped;
}

export function claimCustodyNamespaces(database) {
  if (!database.prepare("PRAGMA table_info(hub_mcp_operations)").all().some(c => c.name === "claim_custody_write_json")) return [];
  return database.prepare(`SELECT * FROM hub_mcp_operations
    WHERE json_extract(claim_custody_json, '$.phase') = 'fenced'
      AND json_extract(claim_custody_json, '$.namespace.epoch') IS NOT NULL`).all().map(row => {
    const state = claimCustodyState({ requestId: row.request_id, workspaceId: row.workspace_id,
      streamId: row.stream_id, threadId: row.provider_thread_id, provider: row.provider,
      argumentsHash: row.arguments_hash, toolName: row.tool_name, claimCustody: JSON.parse(row.claim_custody_json) });
    if (!state) throw new TaskClaimCustodyRejectedError("Invalid namespace authority in the existing ledger");
    return state;
  });
}

// Capture once BEFORE entering the existing asynchronous mutation queue. A
// callback admitted before a fence never silently refreshes to its new epoch.
export function captureClaimCustodySqlAuthorities(database, method, args) {
  return claimCustodyNamespaces(database).map(state => {
    const first = args[0];
    let taskId = typeof first === "string" ? first : first?.taskId ?? first?.id;
    if (method === "recordTaskTurn" && !taskId) taskId = database.prepare(`SELECT task_id FROM hub_task_turn_bindings
      WHERE operation_id=? AND provider=? AND provider_thread_id=? AND turn_id=?`)
      .get(first.operationId, first.provider, first.threadId, first.turnId)?.task_id;
    if (taskId === state.taskId && method === "claim") {
      const input = args[1];
      if (input?.streamId !== state.original.streamId || input?.gitBaseline?.custodyEpoch !== state.namespace.epoch
          || (input.forwardCustodyRequestId !== state.requestId && input.operationId === state.successorClaimRequestId)) {
        throw new TaskClaimCustodyRejectedError("Claim does not carry current source custody authority");
      }
    }
    if (taskId === state.taskId && ["prepareStart", "markStarted", "reassignWorkspace", "move"].includes(method)) {
      throw new TaskClaimCustodyRejectedError("Namespace custody cannot be reassigned by a legacy assignment path");
    }
    if (taskId === state.taskId && method === "recordTaskTurn") {
      const binding = database.prepare(`SELECT baseline_json FROM hub_task_turn_bindings
        WHERE task_id = ? AND operation_id = ? AND provider = ? AND provider_thread_id = ? AND turn_id = ?`)
        .get(taskId, first.operationId, first.provider, first.threadId, first.turnId);
      if (JSON.parse(binding?.baseline_json ?? "{}").custodyEpoch !== state.namespace.epoch) {
        throw new TaskClaimCustodyRejectedError("Historical turn cannot write successor Task authority");
      }
    }
    if (taskId === state.taskId && method === "recordTaskGitReference"
        && first.resultSnapshot?.custodyEpoch !== state.namespace.epoch) {
      throw new TaskClaimCustodyRejectedError("Historical result reference cannot write successor authority");
    }
    return { taskId: state.taskId, epoch: state.namespace.epoch, fenceRequestId: state.requestId,
      operationId: `${method}:${taskId ?? "selected"}` };
  });
}

// A transparent adapter for the NEW canonical store connection only. It does
// not weaken the persistent triggers: legacy connections never acquire a SQL
// permit. Each statement removes its permit before its surrounding COMMIT.
export function claimCustodySqlConnection(database, currentAuthorities) {
  function permitted(operation) {
    const authorities = currentAuthorities();
    const visit = i => i === authorities.length ? operation()
      : withClaimCustodySqlPermit(database, authorities[i], () => visit(i + 1));
    return visit(0);
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return sql => {
        const statement = target.prepare(sql);
        return new Proxy(statement, { get(s, member) {
          if (member === "run") return (...args) => permitted(() => s.run(...args));
          const value = Reflect.get(s, member, s);
          return typeof value === "function" ? value.bind(s) : value;
        } });
      };
      if (property === "exec") return sql => /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)
        ? target.exec(sql) : permitted(() => target.exec(sql));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function claimCustodyTaskSnapshot(database, taskId) {
  const rows = [];
  let bytes = 0;
  for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
    if (!/^hub_[a-z_]+$/.test(name)) continue;
    const keys = custodyTaskExpressions(database, name);
    if (!keys.length) continue;
    const selected = database.prepare(`SELECT * FROM ${name} WHERE ${keys.map(k => `${k}=?`).join(" OR ")} LIMIT 10001`).all(...keys.map(() => taskId));
    if (selected.length > 10000) throw new TaskClaimCustodyRejectedError("Task custody state exceeds its bounded row inventory");
    selected.sort((a, b) => claimCustodyHash(a).localeCompare(claimCustodyHash(b)));
    bytes += Buffer.byteLength(JSON.stringify(selected));
    if (bytes > 16 * 1024 * 1024) throw new TaskClaimCustodyRejectedError("Task custody state exceeds its bounded byte inventory");
    rows.push({ table: name, count: selected.length, hash: claimCustodyHash(selected) });
  }
  return { hash: claimCustodyHash(rows), rows };
}

function custodyTaskExpressions(database, table, prefix = "") {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const keys = table === "hub_board_tasks" ? ["id"] : columns.filter(c =>
    c === "task_id" || c.endsWith("_task_id"));
  if (table === "hub_task_checklist_event_outbox") keys.push("subject_id");
  const expressions = keys.map(key => prefix + key);
  if (table === "hub_task_lifecycle_transitions" && columns.includes("evidence_json")) {
    for (const side of ["source", "survivor"]) expressions.push(`json_extract(${prefix}evidence_json, '$.squashTransfer.${side}.taskId')`);
    expressions.push(`json_extract(json_extract(${prefix}evidence_json, '$.selectedComposition.absorptionInput.text'), '$.sourceTaskId')`);
  }
  if (table === "hub_task_lifecycle_outcomes" && columns.includes("result_json")) {
    for (const side of ["source", "survivor"]) expressions.push(`json_extract(${prefix}result_json, '$.evidence.squashTransfer.${side}.taskId')`);
    expressions.push(`json_extract(json_extract(${prefix}result_json, '$.evidence.selectedComposition.absorptionInput.text'), '$.sourceTaskId')`);
  }
  return expressions;
}

export function assertNoPendingClaimCustodyWriters(database, taskId) {
  const refs = custodyTaskExpressions(database, "hub_task_lifecycle_transitions");
  if (database.prepare(`SELECT 1 FROM hub_task_lifecycle_transitions WHERE phase IN ('pending_git','cleanup')
    AND (${refs.map(expr => `${expr}=?`).join(" OR ")})`).get(...refs.map(() => taskId))) {
    throw new TaskClaimCustodyRejectedError("An admitted Task lifecycle writer must finish/reconcile before custody");
  }
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_task_checklist_linked_actions'").get()
      && database.prepare(`SELECT 1 FROM hub_task_checklist_linked_actions WHERE phase!='completed'
        AND (task_id=? OR linked_task_id=?)`).get(taskId, taskId)) {
    throw new TaskClaimCustodyRejectedError("A linked Task writer must finish/reconcile before custody");
  }
}
