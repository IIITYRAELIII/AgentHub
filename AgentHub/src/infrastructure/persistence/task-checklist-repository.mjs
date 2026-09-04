import { createHash } from "node:crypto";

import {
  TASK_CHECKLIST_ITEMS_MAX,
  normalizedTaskChecklistOperation,
  normalizedTaskChecklistText,
} from "../../domain/task-checklist.mjs";
import { taskPresentation } from "../../domain/task-board-task.mjs";

const TASK_CHECKLIST_REQUEST_ID_MAX_LENGTH = 200;
const LEGACY_TASK_CHECKLIST_EVENT_ID_PREFIX = "task-checklist:";
const TASK_CHECKLIST_EVENT_ID_PREFIX = "task-checklist-v2:";
const TASK_CHECKLIST_PROJECTION_BATCH_SIZE = 250;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function argumentsHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function checklistEventId(requestId, eventKind) {
  const digest = createHash("sha256")
    .update(String(requestId), "utf8")
    .update("\0", "utf8")
    .update(String(eventKind), "utf8")
    .digest("hex");
  return `${TASK_CHECKLIST_EVENT_ID_PREFIX}${digest}:${eventKind}`;
}

function checklistEventDedupeKey(eventId) {
  const identity = String(eventId ?? "");
  if (identity && identity.length <= TASK_CHECKLIST_REQUEST_ID_MAX_LENGTH && !identity.includes("\0")) {
    return identity;
  }
  return `${TASK_CHECKLIST_EVENT_ID_PREFIX}${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function legacyChecklistEventCausality(row) {
  const id = String(row.id ?? "");
  const createdSuffix = id.endsWith(":created");
  const updatedSuffix = id.endsWith(":updated");
  const created = row.event_type === "task.created" || createdSuffix;
  const updated = row.event_type === "task.checklist.updated" || updatedSuffix;
  const suffix = created ? ":created" : updated ? ":updated" : "";
  const knownPrefix = id.startsWith(TASK_CHECKLIST_EVENT_ID_PREFIX)
    ? TASK_CHECKLIST_EVENT_ID_PREFIX
    : id.startsWith(LEGACY_TASK_CHECKLIST_EVENT_ID_PREFIX)
      ? LEGACY_TASK_CHECKLIST_EVENT_ID_PREFIX
      : "";
  const mutationKey = knownPrefix && suffix && id.endsWith(suffix)
    ? id.slice(knownPrefix.length, -suffix.length)
    : id;
  return { mutationKey, ordinal: created ? 1 : 0, knownCausality: created || updated };
}

function taskSummary(row) {
  if (!row) return null;
  const presentation = String(row.title ?? "").trim()
    ? { title: row.title }
    : taskPresentation(row.corrected_text ?? row.raw_text);
  const workflowStatus = String(row.workflow_status ?? "").trim() || "new";
  return {
    id: row.id,
    taskNumber: String(row.task_number ?? ""),
    title: presentation.title,
    workflowStatus,
    status: row.status,
    workspaceId: row.workspace_id ?? null,
    streamId: row.stream_id ?? null,
  };
}

export function configureTaskChecklist(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS hub_task_checklist_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      text TEXT NOT NULL,
      manual_completed INTEGER NOT NULL DEFAULT 0 CHECK (manual_completed IN (0, 1)),
      linked_task_id TEXT UNIQUE,
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (linked_task_id) REFERENCES hub_board_tasks(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS hub_task_checklist_position_idx
      ON hub_task_checklist_items(task_id, position);
    CREATE INDEX IF NOT EXISTS hub_task_checklist_parent_idx
      ON hub_task_checklist_items(linked_task_id);
    CREATE TABLE IF NOT EXISTS hub_task_checklist_requests (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      item_id TEXT,
      created_task_id TEXT,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_task_checklist_event_outbox (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      mutation_ordinal INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      stream_id TEXT,
      event_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      delivered_at_ms INTEGER,
      quarantined_at_ms INTEGER,
      quarantine_reason TEXT NOT NULL DEFAULT ''
    ) WITHOUT ROWID;
  `);
  const outboxColumns = new Set(database.prepare(
    "PRAGMA table_info(hub_task_checklist_event_outbox)",
  ).all().map((column) => String(column.name)));
  const migrateSequence = !outboxColumns.has("sequence");
  const migrateOrdinal = !outboxColumns.has("mutation_ordinal");
  if (!outboxColumns.has("quarantined_at_ms")) {
    database.exec("ALTER TABLE hub_task_checklist_event_outbox ADD COLUMN quarantined_at_ms INTEGER");
  }
  if (!outboxColumns.has("quarantine_reason")) {
    database.exec("ALTER TABLE hub_task_checklist_event_outbox ADD COLUMN quarantine_reason TEXT NOT NULL DEFAULT ''");
  }
  if (migrateSequence || migrateOrdinal) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (migrateSequence) database.exec("ALTER TABLE hub_task_checklist_event_outbox ADD COLUMN sequence INTEGER");
      if (migrateOrdinal) database.exec("ALTER TABLE hub_task_checklist_event_outbox ADD COLUMN mutation_ordinal INTEGER");
      let nextSequence = Number(database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) AS value FROM hub_task_checklist_event_outbox
      `).get()?.value) || 0;
      const existingSequence = outboxColumns.has("sequence") ? "sequence" : "NULL AS sequence";
      const pendingMigration = database.prepare(`
        SELECT id, event_type, payload_json, created_at_ms, ${existingSequence}
        FROM hub_task_checklist_event_outbox
      `).all().map((row) => ({ ...row, ...legacyChecklistEventCausality(row) }));
      pendingMigration.sort((left, right) => {
        if (!migrateSequence) return Number(left.sequence) - Number(right.sequence);
        return Number(left.created_at_ms) - Number(right.created_at_ms)
          || compareText(left.mutationKey, right.mutationKey)
          || left.ordinal - right.ordinal
          || compareText(String(left.id), String(right.id));
      });
      const assignSequence = database.prepare(`
        UPDATE hub_task_checklist_event_outbox SET sequence = ?, mutation_ordinal = ?
        WHERE id = ?
      `);
      for (const row of pendingMigration) {
        const sequence = row.sequence == null ? ++nextSequence : Number(row.sequence);
        assignSequence.run(sequence, row.ordinal, row.id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  database.exec(`
    DROP INDEX IF EXISTS hub_task_checklist_event_outbox_pending_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS hub_task_checklist_event_outbox_sequence_idx
      ON hub_task_checklist_event_outbox(sequence);
    CREATE INDEX IF NOT EXISTS hub_task_checklist_event_outbox_pending_idx
      ON hub_task_checklist_event_outbox(delivered_at_ms, quarantined_at_ms, sequence);
  `);
}

export function taskChecklistProjectionMap(database, taskIds) {
  const requestedTaskIds = [...new Set((Array.isArray(taskIds) ? taskIds : [])
    .map((value) => String(value ?? "").trim()).filter(Boolean))];
  const result = new Map();
  const ensure = (taskId) => {
    if (!result.has(taskId)) result.set(taskId, { checklist: [], checklistParent: null });
    return result.get(taskId);
  };
  requestedTaskIds.forEach(ensure);
  if (!requestedTaskIds.length) return result;
  const rows = [];
  const parents = [];
  for (let offset = 0; offset < requestedTaskIds.length; offset += TASK_CHECKLIST_PROJECTION_BATCH_SIZE) {
    const batch = requestedTaskIds.slice(offset, offset + TASK_CHECKLIST_PROJECTION_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    rows.push(...database.prepare(`
      SELECT item.*, linked.id AS linked_id, linked.task_number AS linked_task_number,
        linked.raw_text AS linked_raw_text, linked.title AS linked_title,
        linked.corrected_text AS linked_corrected_text, linked.status AS linked_status,
        linked.workflow_status AS linked_workflow_status,
        linked.workspace_id AS linked_workspace_id, linked.stream_id AS linked_stream_id
      FROM hub_task_checklist_items AS item
      LEFT JOIN hub_board_tasks AS linked ON linked.id = item.linked_task_id
      WHERE item.task_id IN (${placeholders})
      ORDER BY item.task_id, item.position, item.created_at_ms, item.id
    `).all(...batch));
    parents.push(...database.prepare(`
      SELECT item.linked_task_id AS child_id, item.id AS item_id, item.text AS item_text,
        parent.id, parent.task_number, parent.raw_text, parent.title,
        parent.corrected_text, parent.status, parent.workflow_status,
        parent.workspace_id, parent.stream_id
      FROM hub_task_checklist_items AS item
      JOIN hub_board_tasks AS parent ON parent.id = item.task_id
      WHERE item.linked_task_id IN (${placeholders})
      ORDER BY item.linked_task_id, item.created_at_ms, item.id
    `).all(...batch));
  }
  for (const row of rows) {
    const linkedTask = row.linked_id ? taskSummary({
      id: row.linked_id,
      task_number: row.linked_task_number,
      raw_text: row.linked_raw_text,
      title: row.linked_title,
      corrected_text: row.linked_corrected_text,
      status: row.linked_status,
      workflow_status: row.linked_workflow_status,
      workspace_id: row.linked_workspace_id,
      stream_id: row.linked_stream_id,
    }) : null;
    ensure(row.task_id).checklist.push({
      id: row.id,
      text: row.text,
      position: Number(row.position),
      manualCompleted: Number(row.manual_completed) === 1,
      completed: Number(row.manual_completed) === 1
        || linkedTask?.status === "done"
        || linkedTask?.workflowStatus === "done",
      linkedTaskId: linkedTask?.id ?? null,
      linkedTask,
    });
  }
  for (const row of parents) {
    ensure(row.child_id).checklistParent = {
      itemId: row.item_id,
      text: row.item_text,
      task: taskSummary(row),
    };
  }
  return result;
}

function checklistItem(database, taskId, itemId) {
  const row = database.prepare(`
    SELECT * FROM hub_task_checklist_items WHERE id = ? AND task_id = ?
  `).get(itemId, taskId);
  if (!row) throw new Error("Пункт чек-листа не найден");
  return row;
}

function assertLinkAllowed(database, taskId, linkedTaskId, itemId) {
  if (taskId === linkedTaskId) throw new Error("Task нельзя связать с самой собой");
  const parent = database.prepare("SELECT workspace_id, status FROM hub_board_tasks WHERE id = ?").get(taskId);
  const linked = database.prepare("SELECT workspace_id, status FROM hub_board_tasks WHERE id = ?").get(linkedTaskId);
  if (!linked) {
    throw new Error("Связанная Task не найдена");
  }
  if (!parent?.workspace_id || !linked.workspace_id || parent.workspace_id !== linked.workspace_id) {
    throw new Error("Связанная Task должна находиться в том же Workspace");
  }
  if (parent.status === "starting" || linked.status === "starting") {
    throw new Error("Нельзя менять связи чек-листа во время запуска Task");
  }
  const owner = database.prepare(`
    SELECT task_id, id FROM hub_task_checklist_items
    WHERE linked_task_id = ? AND id != ?
  `).get(linkedTaskId, itemId);
  if (owner) throw new Error("Task уже связана с другим пунктом чек-листа");
  const cycle = database.prepare(`
    WITH RECURSIVE ancestors(id) AS (
      SELECT task_id FROM hub_task_checklist_items WHERE linked_task_id = ?
      UNION
      SELECT item.task_id
      FROM hub_task_checklist_items AS item
      JOIN ancestors ON item.linked_task_id = ancestors.id
    )
    SELECT 1 FROM ancestors WHERE id = ? LIMIT 1
  `).get(taskId, linkedTaskId);
  if (cycle) throw new Error("Связь создаёт цикл Task");
}

export function assertTaskChecklistWorkspaceTransitionAllowed(database, taskId, workspaceId) {
  const relations = database.prepare(`
    SELECT item.task_id AS parent_id, item.linked_task_id AS child_id,
      parent.workspace_id AS parent_workspace_id, child.workspace_id AS child_workspace_id
    FROM hub_task_checklist_items AS item
    JOIN hub_board_tasks AS parent ON parent.id = item.task_id
    JOIN hub_board_tasks AS child ON child.id = item.linked_task_id
    WHERE item.linked_task_id IS NOT NULL AND (item.task_id = ? OR item.linked_task_id = ?)
  `).all(taskId, taskId);
  if (!relations.length) return;
  const targetWorkspaceId = String(workspaceId ?? "").trim();
  const allowed = targetWorkspaceId && relations.every((relation) => {
    const counterpartWorkspaceId = relation.parent_id === taskId
      ? relation.child_workspace_id
      : relation.parent_workspace_id;
    return counterpartWorkspaceId && counterpartWorkspaceId === targetWorkspaceId;
  });
  if (!allowed) {
    throw new Error("Нельзя переместить связанную Task в другой Workspace; сначала отвяжите пункт");
  }
}

export function assertTaskChecklistWorkspaceReassignmentAllowed(database, sourceWorkspaceId, targetWorkspaceId) {
  const sourceId = String(sourceWorkspaceId ?? "").trim();
  const targetId = String(targetWorkspaceId ?? "").trim();
  if (!sourceId || !targetId) throw new Error("Workspace reassignment requires two Workspaces");
  const invalid = database.prepare(`
    SELECT 1
    FROM hub_task_checklist_items AS item
    JOIN hub_board_tasks AS parent ON parent.id = item.task_id
    JOIN hub_board_tasks AS child ON child.id = item.linked_task_id
    WHERE item.linked_task_id IS NOT NULL
      AND (parent.workspace_id = ? OR child.workspace_id = ?)
      AND NOT (parent.workspace_id = ? AND child.workspace_id = ?)
    LIMIT 1
  `).get(sourceId, sourceId, sourceId, sourceId);
  if (invalid) {
    throw new Error("Workspace reassignment cannot split linked Tasks");
  }
}

function rewritePositions(database, taskId, itemIds, timestamp) {
  const update = database.prepare(`
    UPDATE hub_task_checklist_items SET position = ?, updated_at_ms = ? WHERE id = ? AND task_id = ?
  `);
  itemIds.forEach((id, index) => update.run(itemIds.length + index, timestamp, id, taskId));
  itemIds.forEach((id, index) => update.run(index, timestamp, id, taskId));
}

function boundedChecklistItemIds(database, taskId) {
  const rows = database.prepare(`
    SELECT id FROM hub_task_checklist_items
    WHERE task_id = ?
    ORDER BY position, created_at_ms, id
    LIMIT ?
  `).all(taskId, TASK_CHECKLIST_ITEMS_MAX + 1);
  if (rows.length > TASK_CHECKLIST_ITEMS_MAX) {
    throw new Error(`Чек-лист содержит больше ${TASK_CHECKLIST_ITEMS_MAX} пунктов; сначала сократите его`);
  }
  return rows.map((row) => row.id);
}

function enqueueEvent(database, {
  id, ordinal, workspaceId, streamId = null, type, subjectId, payload, timestamp,
}) {
  if (!workspaceId) return;
  const sequence = (Number(database.prepare(`
    SELECT COALESCE(MAX(sequence), 0) AS value FROM hub_task_checklist_event_outbox
  `).get()?.value) || 0) + 1;
  database.prepare(`
    INSERT INTO hub_task_checklist_event_outbox (
      id, sequence, mutation_ordinal, workspace_id, stream_id,
      event_type, subject_id, payload_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sequence, ordinal, workspaceId, streamId, type, subjectId, JSON.stringify(payload), timestamp);
}

export function nextTaskChecklistEvent(database) {
  const row = database.prepare(`
    SELECT * FROM hub_task_checklist_event_outbox
    WHERE delivered_at_ms IS NULL AND quarantined_at_ms IS NULL ORDER BY sequence LIMIT 1
  `).get();
  if (!row) return null;
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (error) {
    return {
      id: row.id,
      invalid: true,
      invalidReason: `invalid checklist outbox payload: ${String(error?.message ?? error).slice(0, 500)}`,
    };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      id: row.id,
      invalid: true,
      invalidReason: "invalid checklist outbox payload: expected an object",
    };
  }
  return {
    id: row.id,
    sequence: Number(row.sequence),
    mutationOrdinal: Number(row.mutation_ordinal),
    workspaceId: row.workspace_id,
    streamId: row.stream_id ?? null,
    type: row.event_type,
    subjectId: row.subject_id,
    payload,
    dedupeKey: checklistEventDedupeKey(row.id),
  };
}

export function quarantineTaskChecklistEvent(database, eventId, reason, timestamp) {
  return Number(database.prepare(`
    UPDATE hub_task_checklist_event_outbox
    SET quarantined_at_ms = ?, quarantine_reason = ?
    WHERE id = ? AND delivered_at_ms IS NULL AND quarantined_at_ms IS NULL
  `).run(timestamp, String(reason ?? "").slice(0, 1_000), eventId).changes) > 0;
}

function taskChecklistRequestIdentity(payload) {
  const operation = normalizedTaskChecklistOperation(payload.operation);
  const taskId = String(payload.taskId ?? "").trim();
  const requestId = String(payload.requestId ?? "").trim();
  const itemId = String(payload.itemId ?? "").trim();
  const expectedRevision = String(payload.expectedRevision ?? "").trim();
  if (
    !taskId
    || !requestId
    || requestId.length > TASK_CHECKLIST_REQUEST_ID_MAX_LENGTH
    || requestId.includes("\0")
    || !/^[1-9]\d*$/u.test(expectedRevision)
  ) {
    throw new Error("Операция чек-листа требует Task, request id и актуальную revision");
  }
  if (operation === "toggle" && typeof payload.completed !== "boolean") {
    throw new Error("Для отметки пункта требуется completed");
  }
  const semantic = {
    taskId,
    operation,
    itemId,
    text: payload.text == null ? null : String(payload.text),
    completed: payload.completed == null ? null : Boolean(payload.completed),
    beforeItemId: String(payload.beforeItemId ?? "").trim() || null,
    linkedTaskId: String(payload.linkedTaskId ?? "").trim() || null,
    expectedRevision,
  };
  return { taskId, requestId, itemId, operation, expectedRevision, semantic, hash: argumentsHash(semantic) };
}

export function taskChecklistRequestOutcome(database, payload) {
  const identity = taskChecklistRequestIdentity(payload);
  const replay = database.prepare(`
    SELECT * FROM hub_task_checklist_requests WHERE request_id = ?
  `).get(identity.requestId);
  if (!replay) return null;
  if (
    replay.task_id !== identity.taskId
    || replay.operation !== identity.operation
    || replay.arguments_hash !== identity.hash
  ) {
    throw new Error("request id уже использован для другой операции чек-листа");
  }
  return {
    itemId: replay.item_id ?? null,
    createdTaskId: replay.created_task_id ?? null,
    replayed: true,
  };
}

export function markTaskChecklistEventDelivered(database, eventId, timestamp) {
  return Number(database.prepare(`
    UPDATE hub_task_checklist_event_outbox SET delivered_at_ms = ?
    WHERE id = ? AND delivered_at_ms IS NULL
  `).run(timestamp, eventId).changes) > 0;
}

export function mutateTaskChecklist(database, payload, {
  now,
  idFactory,
  createExtractedTask,
} = {}) {
  const identity = taskChecklistRequestIdentity(payload);
  const { operation, taskId, requestId, itemId, expectedRevision, semantic, hash } = identity;
  const replay = taskChecklistRequestOutcome(database, payload);
  if (replay) return replay;
  const task = database.prepare(`
    SELECT id, workspace_id, stream_id, status, bucket,
      CAST(row_revision AS TEXT) AS exact_row_revision
    FROM hub_board_tasks WHERE id = ?
  `).get(taskId);
  if (!task) throw new Error("Задача не найдена");
  if (String(task.exact_row_revision) !== expectedRevision) {
    throw new Error("Task revision changed; reload the card and retry");
  }
  const timestamp = now();
  let affectedItemId = itemId;
  let createdTaskId = null;
  if (operation === "add") {
    affectedItemId = String(idFactory());
    const text = normalizedTaskChecklistText(payload.text);
    const position = Number(database.prepare(`
      SELECT COUNT(*) AS value FROM hub_task_checklist_items WHERE task_id = ?
    `).get(taskId)?.value) || 0;
    if (position >= TASK_CHECKLIST_ITEMS_MAX) {
      throw new Error(`Чек-лист не может содержать больше ${TASK_CHECKLIST_ITEMS_MAX} пунктов`);
    }
    database.prepare(`
      INSERT INTO hub_task_checklist_items
        (id, task_id, text, position, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(affectedItemId, taskId, text, position, timestamp, timestamp);
  } else {
    if (!itemId) throw new Error("Пункт чек-листа не указан");
    const item = checklistItem(database, taskId, itemId);
    if (operation === "edit") {
      database.prepare(`
        UPDATE hub_task_checklist_items SET text = ?, updated_at_ms = ? WHERE id = ?
      `).run(normalizedTaskChecklistText(payload.text), timestamp, itemId);
    } else if (operation === "remove") {
      database.prepare("DELETE FROM hub_task_checklist_items WHERE id = ?").run(itemId);
      const maximumPosition = Number(database.prepare(`
        SELECT COALESCE(MAX(position), 0) AS value
        FROM hub_task_checklist_items WHERE task_id = ?
      `).get(taskId)?.value) || 0;
      const shift = maximumPosition + 1;
      database.prepare(`
        UPDATE hub_task_checklist_items
        SET position = position + ?, updated_at_ms = ?
        WHERE task_id = ? AND position > ?
      `).run(shift, timestamp, taskId, Number(item.position));
      database.prepare(`
        UPDATE hub_task_checklist_items
        SET position = position - ?, updated_at_ms = ?
        WHERE task_id = ? AND position > ?
      `).run(shift + 1, timestamp, taskId, Number(item.position) + shift);
    } else if (operation === "toggle") {
      database.prepare(`
        UPDATE hub_task_checklist_items SET manual_completed = ?, updated_at_ms = ? WHERE id = ?
      `).run(payload.completed === true ? 1 : 0, timestamp, itemId);
    } else if (operation === "move") {
      const beforeItemId = String(payload.beforeItemId ?? "").trim() || null;
      const ids = boundedChecklistItemIds(database, taskId).filter((id) => id !== itemId);
      if (beforeItemId && !ids.includes(beforeItemId)) throw new Error("Целевая позиция чек-листа не найдена");
      ids.splice(beforeItemId ? ids.indexOf(beforeItemId) : ids.length, 0, itemId);
      rewritePositions(database, taskId, ids, timestamp);
    } else if (operation === "link") {
      const linkedTaskId = String(payload.linkedTaskId ?? "").trim();
      if (!linkedTaskId) throw new Error("Связанная Task не указана");
      assertLinkAllowed(database, taskId, linkedTaskId, itemId);
      database.prepare(`
        UPDATE hub_task_checklist_items SET linked_task_id = ?, updated_at_ms = ? WHERE id = ?
      `).run(linkedTaskId, timestamp, itemId);
    } else if (operation === "unlink") {
      database.prepare(`
        UPDATE hub_task_checklist_items SET linked_task_id = NULL, updated_at_ms = ? WHERE id = ?
      `).run(timestamp, itemId);
    } else if (operation === "extract") {
      if (item.linked_task_id) throw new Error("Пункт уже связан с Task");
      createdTaskId = createExtractedTask(database, {
        parentTask: task,
        itemId,
        text: item.text,
        timestamp,
      });
      assertLinkAllowed(database, taskId, createdTaskId, itemId);
      database.prepare(`
        UPDATE hub_task_checklist_items SET linked_task_id = ?, updated_at_ms = ? WHERE id = ?
      `).run(createdTaskId, timestamp, itemId);
    }
  }
  database.prepare(`
    UPDATE hub_board_tasks SET row_revision = row_revision + 1, updated_at_ms = ? WHERE id = ?
  `).run(timestamp, taskId);
  database.prepare(`
    INSERT INTO hub_task_checklist_requests
      (request_id, task_id, operation, arguments_hash, item_id, created_task_id, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(requestId, taskId, operation, hash, affectedItemId || null, createdTaskId, timestamp);
  const linkedTaskId = operation === "unlink" || operation === "remove"
    ? null
    : createdTaskId ?? semantic.linkedTaskId;
  enqueueEvent(database, {
    id: checklistEventId(requestId, "updated"),
    ordinal: 0,
    workspaceId: task.workspace_id,
    streamId: task.stream_id,
    type: "task.checklist.updated",
    subjectId: taskId,
    payload: {
      taskId,
      status: task.status,
      bucket: task.bucket,
      operation,
      itemId: affectedItemId || null,
      linkedTaskId,
    },
    timestamp,
  });
  if (createdTaskId) {
    const created = database.prepare(`
      SELECT workspace_id, stream_id, status, bucket
      FROM hub_board_tasks
      WHERE id = ?
    `).get(createdTaskId);
    enqueueEvent(database, {
      id: checklistEventId(requestId, "created"),
      ordinal: 1,
      workspaceId: created.workspace_id,
      streamId: created.stream_id,
      type: "task.created",
      subjectId: createdTaskId,
      payload: {
        taskId: createdTaskId,
        status: created.status,
        bucket: created.bucket,
        parentTaskId: taskId,
        checklistItemId: affectedItemId,
      },
      timestamp,
    });
  }
  return { itemId: affectedItemId || null, createdTaskId, replayed: false };
}
