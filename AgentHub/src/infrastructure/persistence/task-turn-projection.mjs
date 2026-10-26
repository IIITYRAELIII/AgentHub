// A derived SQL index, maintained by the existing journal/binding transactions.
// No snapshot reader scans journal bodies and no second writer or timer is added.
export function configureTaskTurnProjection(database) {
  const exists = name => Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
  if (!exists("journal_records") || !exists("hub_task_turn_bindings")) return;
  // Let the journal owner migrate its own legacy columns when it opens later.
  const columns = new Set(database.prepare("PRAGMA table_info(journal_records)").all().map(row => row.name));
  if (!["provider", "thread_id", "turn_id", "task_thread_id", "project_root",
    "completed_at_ms", "changed_revision", "record_json"].every(name => columns.has(name))) return;
  const migrated = exists("hub_task_turn_projection");
  const select = where => [
    "SELECT b.task_id, j.provider, j.thread_id, j.turn_id, b.operation_id,",
    "j.task_thread_id, j.project_root, j.completed_at_ms, j.changed_revision,",
    "substr(json_extract(j.record_json, '$.title'), 1, 2000),",
    "json_extract(j.record_json, '$.status')",
    "FROM hub_task_turn_bindings b JOIN journal_records j",
    "ON j.provider = b.provider AND j.thread_id = b.provider_thread_id AND j.turn_id = b.turn_id",
    "WHERE (" + where + ") AND CASE WHEN json_valid(j.record_json) THEN",
    "j.completed_at_ms IS NOT NULL",
    "AND coalesce(json_extract(j.record_json, '$.provisional'), 0) = 0",
    "AND coalesce(json_extract(j.record_json, '$.aggregateOnly'), 0) = 0",
    "AND json_extract(j.record_json, '$.status') IN ('completed','failed','cancelled','interrupted')",
    "ELSE 0 END",
  ].join(" ");
  const insert = where => "INSERT OR REPLACE INTO hub_task_turn_projection " + select(where) + ";";
  const journalIdentity = prefix => [
    "provider = " + prefix + ".provider",
    "thread_id = " + prefix + ".thread_id",
    "turn_id = " + prefix + ".turn_id",
  ].join(" AND ");
  const bindingIdentity = prefix => [
    "task_id = " + prefix + ".task_id",
    "provider = " + prefix + ".provider",
    "thread_id = " + prefix + ".provider_thread_id",
    "turn_id = " + prefix + ".turn_id",
    "operation_id = " + prefix + ".operation_id",
  ].join(" AND ");
  database.exec("SAVEPOINT task_turn_projection_setup");
  try {
    database.exec([
      "CREATE TABLE IF NOT EXISTS hub_task_turn_projection (",
      "task_id TEXT NOT NULL, provider TEXT NOT NULL, thread_id TEXT NOT NULL,",
      "turn_id TEXT NOT NULL, operation_id TEXT NOT NULL, task_thread_id TEXT NOT NULL,",
      "project_root TEXT NOT NULL, completed_at_ms INTEGER NOT NULL,",
      "source_revision INTEGER NOT NULL, summary TEXT, status TEXT NOT NULL,",
      "PRIMARY KEY(task_id, provider, thread_id, turn_id, operation_id),",
      "FOREIGN KEY(task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE) WITHOUT ROWID;",
      "CREATE INDEX IF NOT EXISTS hub_task_turn_projection_source",
      "ON hub_task_turn_projection(provider, thread_id, turn_id);",
      "CREATE TABLE IF NOT EXISTS hub_task_turn_projection_versions (",
      "task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,",
      "FOREIGN KEY(task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE) WITHOUT ROWID;",
      "CREATE TRIGGER IF NOT EXISTS hub_task_turn_projection_version_insert",
      "AFTER INSERT ON hub_task_turn_projection BEGIN",
      "INSERT INTO hub_task_turn_projection_versions VALUES(NEW.task_id,1)",
      "ON CONFLICT(task_id) DO UPDATE SET revision=revision+1; END;",
      "CREATE TRIGGER IF NOT EXISTS hub_task_turn_projection_version_delete",
      "AFTER DELETE ON hub_task_turn_projection WHEN EXISTS",
      "(SELECT 1 FROM hub_board_tasks WHERE id=OLD.task_id) BEGIN",
      "INSERT INTO hub_task_turn_projection_versions VALUES(OLD.task_id,1)",
      "ON CONFLICT(task_id) DO UPDATE SET revision=revision+1; END;",
      "CREATE TRIGGER IF NOT EXISTS hub_task_turn_projection_journal_insert",
      "AFTER INSERT ON journal_records BEGIN",
      "DELETE FROM hub_task_turn_projection WHERE " + journalIdentity("NEW") + ";",
      insert("j.provider=NEW.provider AND j.thread_id=NEW.thread_id AND j.turn_id=NEW.turn_id"),
      "END;",
      "CREATE TRIGGER IF NOT EXISTS hub_task_turn_projection_journal_update",
      "AFTER UPDATE ON journal_records BEGIN",
      "DELETE FROM hub_task_turn_projection WHERE " + journalIdentity("OLD") + ";",
      insert("j.provider=NEW.provider AND j.thread_id=NEW.thread_id AND j.turn_id=NEW.turn_id"),
      "END;",
      "CREATE TRIGGER IF NOT EXISTS hub_task_turn_projection_binding_insert",
      "AFTER INSERT ON hub_task_turn_bindings BEGIN",
      insert("b.provider=NEW.provider AND b.provider_thread_id=NEW.provider_thread_id"
        + " AND b.turn_id=NEW.turn_id AND b.operation_id=NEW.operation_id"),
      "END;",
      "CREATE TRIGGER IF NOT EXISTS hub_task_turn_projection_binding_update",
      "AFTER UPDATE OF task_id,provider,provider_thread_id,turn_id,operation_id ON hub_task_turn_bindings BEGIN",
      "DELETE FROM hub_task_turn_projection WHERE " + bindingIdentity("OLD") + ";",
      insert("b.provider=NEW.provider AND b.provider_thread_id=NEW.provider_thread_id"
        + " AND b.turn_id=NEW.turn_id AND b.operation_id=NEW.operation_id"),
      "END;",
      "CREATE TRIGGER IF NOT EXISTS hub_task_turn_projection_binding_delete",
      "AFTER DELETE ON hub_task_turn_bindings BEGIN",
      "DELETE FROM hub_task_turn_projection WHERE " + bindingIdentity("OLD") + ";",
      "END;",
    ].join("\n"));
    // One atomic migration of retained exact bindings, never a per-snapshot scan.
    if (!migrated) database.exec(insert("1"));
    // Journal retention deliberately does not erase already recorded Task history.
    database.exec("RELEASE task_turn_projection_setup");
  } catch (error) {
    try { database.exec("ROLLBACK TO task_turn_projection_setup; RELEASE task_turn_projection_setup"); }
    catch { /* Preserve the original failure if SQLite already rolled back. */ }
    throw error;
  }
}
