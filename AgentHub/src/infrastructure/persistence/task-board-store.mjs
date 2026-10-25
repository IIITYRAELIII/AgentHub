import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readClaimCustodyFence, configureClaimCustodyBindingFences, configureClaimCustodyNamespaceFences,
  claimCustodySqlConnection, captureClaimCustodySqlAuthorities } from "./claim-custody-fence.mjs";
import { claimCustodyState, TaskClaimCustodyRejectedError, TaskClaimContinuationWithdrawnError } from "../../domain/claim-forward-custody.mjs";
import { nativeTestMetadataDrift } from "../../domain/native-test-terminal-recovery.mjs";
import { AsyncSqliteMutationQueue } from "./async-sqlite-mutation-queue.mjs";

import {
  LEGACY_TELEGRAM_BUNDLE_PREFIX,
  normalizedTaskBucket,
  normalizedTaskCategory,
  normalizedTaskDescription,
  normalizedTaskText,
  normalizedTaskTitle,
  normalizedTaskWorkflowStatus,
  TASK_WORKFLOW_STATUSES,
  TaskLifecycleBeginRejectedError,
  workflowAdmissionNoEffectEvidence,
  taskPresentation,
} from "../../domain/task-board-task.mjs";
import {
  normalizedTaskChangedFiles,
  taskReleasePlanRevision,
} from "../../domain/task-release-snapshot.mjs";
import { normalizedTaskGitReferences, taskBranchName, normalizedInitialNativeTest } from "../../domain/task-git-reference.mjs";
import { normalizedTaskSquashTransfer } from "../../domain/task-squash-transfer.mjs";
import { normalizedTaskSquashCutover } from "../../domain/task-squash-cutover.mjs";
import { selectedCompositionFields, selectedCompositionIdentity, selectedCompositionRequiredError,
  normalizedSelectedAbsorption, selectedAbsorptionHandoff, assertSelectedAbsorptionTasks } from "../../domain/task-selected-composition.mjs";
import { normalizedTaskNumber, normalizedWorkspaceTaskPrefix, taskNumberParts } from "../../domain/task-number.mjs";
import { taskProjectRoot } from "../../domain/task-project-root.mjs";
import {
  assertTaskChecklistWorkspaceReassignmentAllowed,
  assertTaskChecklistWorkspaceTransitionAllowed,
  configureTaskChecklist,
  markTaskChecklistEventDelivered,
  mutateTaskChecklist,
  mutateTaskChecklistLinkedAction,
  nextTaskChecklistEvent,
  quarantineTaskChecklistEvent,
  taskChecklistProjectionMap,
  taskChecklistRequestOutcome,
} from "./task-checklist-repository.mjs";

const NOTES_COLUMN_ID = "notes";

export const LATEST_TASK_SQUASH_TRANSFER_OUTCOME_SQL = `
  SELECT result_json FROM (
    SELECT result_json, completed_at_ms FROM hub_task_lifecycle_outcomes
    WHERE kind = 'workflow'
      AND json_extract(result_json, '$.evidence.squashTransfer.survivor.taskId') = ?
    UNION ALL
    SELECT result_json, completed_at_ms FROM hub_task_lifecycle_outcomes
    WHERE kind = 'workflow'
      AND json_extract(result_json, '$.evidence.squashTransfer.source.taskId') = ?
  ) ORDER BY completed_at_ms DESC LIMIT 1
`;

function sameResolvedPath(left, right) {
  const canonical = (value) => {
    const resolved = path.resolve(String(value ?? ""));
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parsedSettings(value) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function gitBaselineJson(value) {
  const repositories = Array.isArray(value?.repositories) ? value.repositories : [value];
  const valid = repositories.some((repository) => (
    String(repository?.repoRoot ?? "").trim()
    && String(repository?.tree ?? "").trim()
  ));
  return valid ? JSON.stringify(value) : "{}";
}

function blockedByJson(value) {
  return value?.taskId ? JSON.stringify(value) : null;
}

function configure(database) {
  database.exec("PRAGMA busy_timeout = 0");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS hub_board_tasks (
      id TEXT PRIMARY KEY,
      raw_text TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      task_number TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      presentation_source TEXT NOT NULL DEFAULT 'automatic',
      corrected_text TEXT,
      category TEXT NOT NULL DEFAULT 'unknown',
      bucket TEXT NOT NULL DEFAULT 'backlog',
      status TEXT NOT NULL DEFAULT 'open',
      workflow_status TEXT NOT NULL DEFAULT 'new',
      workspace_id TEXT,
      stream_id TEXT,
      source TEXT NOT NULL DEFAULT 'hub',
      source_key TEXT UNIQUE,
      source_json TEXT NOT NULL DEFAULT '{}',
      placement_source TEXT NOT NULL DEFAULT 'default',
      triage_status TEXT NOT NULL DEFAULT 'pending',
      triage_confidence REAL,
      triage_reason TEXT,
      triage_error TEXT,
      board_order INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      start_request_id TEXT,
      start_stream_name TEXT,
      start_destination_stream_id TEXT,
      start_effect_state TEXT,
      start_effect_owner_id TEXT,
      row_revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS hub_workspace_deletion_fences (
      workspace_id TEXT PRIMARY KEY,
      confirmed_name TEXT NOT NULL,
      deleted_at_ms INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS hub_board_tasks_no_deleted_workspace_insert
      BEFORE INSERT ON hub_board_tasks
      WHEN NEW.workspace_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM hub_workspace_deletion_fences WHERE workspace_id = NEW.workspace_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'workspace was permanently deleted');
      END;
    CREATE TRIGGER IF NOT EXISTS hub_board_tasks_no_deleted_workspace_update
      BEFORE UPDATE OF workspace_id ON hub_board_tasks
      WHEN NEW.workspace_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM hub_workspace_deletion_fences WHERE workspace_id = NEW.workspace_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'workspace was permanently deleted');
      END;
    CREATE TABLE IF NOT EXISTS hub_board_workspace_order (
      workspace_id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_board_column_order (
      column_id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO hub_board_column_order (column_id, position, updated_at_ms)
      SELECT workspace_id, position, updated_at_ms FROM hub_board_workspace_order;
    CREATE TABLE IF NOT EXISTS hub_board_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_board_tasks_location_idx
      ON hub_board_tasks(status, bucket, workspace_id, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS hub_board_tasks_triage_idx
      ON hub_board_tasks(triage_status, created_at_ms);
    CREATE TABLE IF NOT EXISTS hub_task_number_sequences (
      prefix TEXT PRIMARY KEY,
      last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
      updated_at_ms INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_board_capture_chats (
      chat_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_task_release_state (
      task_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      frozen_revision INTEGER,
      manifest_hash TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_task_turn_bindings (
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('claim', 'legacy')),
      baseline_json TEXT NOT NULL DEFAULT '{}',
      requested_workflow_status TEXT,
      claimed_at_ms INTEGER NOT NULL,
      terminal_at_ms INTEGER,
      PRIMARY KEY (provider, provider_thread_id, turn_id, operation_id),
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_task_turn_bindings_task_idx
      ON hub_task_turn_bindings(task_id, claimed_at_ms DESC);
    CREATE TABLE IF NOT EXISTS hub_task_work_log (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      changed_files_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE,
      UNIQUE (task_id, provider, provider_thread_id, turn_id, operation_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_task_work_log_task_idx
      ON hub_task_work_log(task_id, created_at_ms, id);
    CREATE TABLE IF NOT EXISTS hub_task_git_references (
      task_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      branch TEXT NOT NULL,
      result_commit TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, project_root),
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_task_legacy_git_adoptions (
      task_id TEXT NOT NULL,
      task_number TEXT NOT NULL DEFAULT '',
      project_root TEXT NOT NULL,
      branch TEXT NOT NULL,
      reported_result_commit TEXT NOT NULL,
      main_result_commit TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      evidence_stream_id TEXT NOT NULL,
      evidence_provider TEXT NOT NULL,
      evidence_thread_id TEXT NOT NULL,
      evidence_turn_id TEXT NOT NULL,
      actor_stream_id TEXT NOT NULL,
      actor_provider TEXT NOT NULL,
      actor_thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      adopted_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, project_root)
    ) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS hub_task_legacy_git_adoptions_no_update
      BEFORE UPDATE ON hub_task_legacy_git_adoptions
      BEGIN SELECT RAISE(ABORT, 'legacy Git adoption audit is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS hub_task_legacy_git_adoptions_no_delete
      BEFORE DELETE ON hub_task_legacy_git_adoptions
      BEGIN SELECT RAISE(ABORT, 'legacy Git adoption audit is immutable'); END;
    CREATE TABLE IF NOT EXISTS hub_task_lifecycle_transitions (
      operation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('workflow', 'complete', 'delete')),
      phase TEXT NOT NULL CHECK (phase IN ('pending_git', 'cleanup', 'failed')),
      target_workflow_status TEXT,
      expected_task_revision INTEGER NOT NULL,
      prior_state_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      error_text TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE UNIQUE INDEX IF NOT EXISTS hub_task_lifecycle_active_idx
      ON hub_task_lifecycle_transitions(task_id)
      WHERE phase IN ('pending_git', 'cleanup');
    CREATE UNIQUE INDEX IF NOT EXISTS hub_task_lifecycle_active_secondary_idx
      ON hub_task_lifecycle_transitions(json_extract(evidence_json, '$.squashTransfer.source.taskId'))
      WHERE phase IN ('pending_git', 'cleanup')
        AND json_extract(evidence_json, '$.squashTransfer.source.taskId') IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS hub_task_lifecycle_active_absorption_source_idx
      ON hub_task_lifecycle_transitions(json_extract(
        json_extract(evidence_json, '$.selectedComposition.absorptionInput.text'), '$.sourceTaskId'))
      WHERE phase IN ('pending_git', 'cleanup');
    CREATE TABLE IF NOT EXISTS hub_task_lifecycle_outcomes (
      operation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('workflow', 'complete', 'delete')),
      result_json TEXT NOT NULL,
      completed_at_ms INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_task_lifecycle_outcome_squash_survivor_idx
      ON hub_task_lifecycle_outcomes(json_extract(result_json, '$.evidence.squashTransfer.survivor.taskId'))
      WHERE kind = 'workflow';
    CREATE INDEX IF NOT EXISTS hub_task_lifecycle_outcome_squash_source_idx
      ON hub_task_lifecycle_outcomes(json_extract(result_json, '$.evidence.squashTransfer.source.taskId'))
      WHERE kind = 'workflow';
    CREATE TABLE IF NOT EXISTS hub_task_release_revisions (
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      repositories_json TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, task_revision),
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_task_release_revision_files (
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      project_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('added', 'modified', 'deleted')),
      base_blob TEXT NOT NULL,
      result_blob TEXT NOT NULL,
      patch_hash TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (task_id, task_revision, project_root, file_path),
      FOREIGN KEY (task_id, task_revision)
        REFERENCES hub_task_release_revisions(task_id, task_revision) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_task_release_completions (
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      completed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, task_revision),
      FOREIGN KEY (task_id, task_revision)
        REFERENCES hub_task_release_revisions(task_id, task_revision) ON DELETE RESTRICT
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_release_registry_history (
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      migrated_task_id TEXT,
      archived_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_kind, source_id)
    ) WITHOUT ROWID;
  `);
  configureClaimCustodyBindingFences(database);
  const tableExists = (name) => Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
  const archive = database.prepare(`
    INSERT OR IGNORE INTO hub_release_registry_history (
      source_kind, source_id, status, payload_json, payload_sha256, archived_at_ms
    ) VALUES (?, ?, 'retired', ?, ?, ?)
  `);
  const hasRepositoryRevisions = tableExists("hub_task_repository_revisions");
  const hasChangedFiles = tableExists("hub_task_changed_files");
  if (hasRepositoryRevisions || hasChangedFiles) database.exec("BEGIN IMMEDIATE");
  try {
    if (hasRepositoryRevisions) {
      const insert = database.prepare(`
        INSERT OR IGNORE INTO hub_task_git_references
          (task_id, project_root, branch, result_commit, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of database.prepare(`
        SELECT * FROM hub_task_repository_revisions ORDER BY task_id, project_root
      `).all()) {
        const payload = JSON.stringify(row);
        archive.run(
          "task-repository-revision-v3", `${row.task_id}\0${row.project_root}`, payload,
          createHash("sha256").update(payload, "utf8").digest("hex"), Date.now(),
        );
        if (String(row.result_revision ?? "").trim()) {
          insert.run(
            row.task_id, row.project_root, taskBranchName(row.task_id, row.project_root),
            row.result_revision, Number(row.updated_at_ms) || Date.now(),
          );
        }
      }
      database.exec("DROP TABLE hub_task_repository_revisions");
    }
    if (hasChangedFiles) {
      for (const row of database.prepare(`
        SELECT * FROM hub_task_changed_files ORDER BY task_id, project_root, file_path
      `).all()) {
        const payload = JSON.stringify(row);
        archive.run(
          "task-changed-file-v3", `${row.task_id}\0${row.project_root}\0${row.file_path}`, payload,
          createHash("sha256").update(payload, "utf8").digest("hex"), Date.now(),
        );
      }
      database.exec("DROP TABLE hub_task_changed_files");
    }
    if (hasRepositoryRevisions || hasChangedFiles) database.exec("COMMIT");
  } catch (error) {
    if (hasRepositoryRevisions || hasChangedFiles) database.exec("ROLLBACK");
    throw error;
  }
  const taskColumns = database.prepare("PRAGMA table_info(hub_board_tasks)").all();
  if (!taskColumns.some((column) => column.name === "blocked_by_json")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN blocked_by_json TEXT");
  }
  if (!taskColumns.some((column) => column.name === "board_order")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN board_order INTEGER NOT NULL DEFAULT 0");
  }
  if (!taskColumns.some((column) => column.name === "title")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  }
  if (!taskColumns.some((column) => column.name === "task_number")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN task_number TEXT NOT NULL DEFAULT ''");
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS hub_board_tasks_number_idx
      ON hub_board_tasks(task_number) WHERE task_number != '';
  `);
  if (!taskColumns.some((column) => column.name === "description")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!taskColumns.some((column) => column.name === "presentation_source")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN presentation_source TEXT NOT NULL DEFAULT 'automatic'");
  }
  if (!taskColumns.some((column) => column.name === "start_request_id")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN start_request_id TEXT");
  }
  if (!taskColumns.some((column) => column.name === "start_stream_name")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN start_stream_name TEXT");
  }
  if (!taskColumns.some((column) => column.name === "start_destination_stream_id")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN start_destination_stream_id TEXT");
  }
  if (!taskColumns.some((column) => column.name === "start_effect_state")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN start_effect_state TEXT");
  }
  if (!taskColumns.some((column) => column.name === "start_effect_owner_id")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN start_effect_owner_id TEXT");
  }
  database.exec(`
    UPDATE hub_board_tasks
    SET start_effect_state = CASE
      WHEN start_request_id IS NULL THEN NULL
      WHEN status = 'starting' THEN 'prepared'
      WHEN status = 'started' AND start_destination_stream_id IS NOT stream_id THEN 'prepared'
      ELSE 'completed'
    END
    WHERE start_effect_state IS NULL AND start_request_id IS NOT NULL
  `);
  if (!taskColumns.some((column) => column.name === "workflow_status")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'new'");
    database.exec(`
      UPDATE hub_board_tasks SET workflow_status = CASE
        WHEN status = 'done' THEN 'done'
        WHEN status IN ('starting', 'started') THEN 'in_progress'
        ELSE 'new'
      END
    `);
  }
  if (!taskColumns.some((column) => column.name === "row_revision")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN row_revision INTEGER NOT NULL DEFAULT 1");
  }
  if (!taskColumns.some((column) => column.name === "release_revision")) {
    // Preserve the exact pre-upgrade identity; never reseed it on later opens.
    database.exec(`
      SAVEPOINT task_release_revision_migration;
      ALTER TABLE hub_board_tasks ADD COLUMN release_revision INTEGER NOT NULL DEFAULT 1;
      UPDATE hub_board_tasks SET release_revision = row_revision;
      RELEASE task_release_revision_migration;
    `);
  }
  let bindingColumns = database.prepare("PRAGMA table_info(hub_task_turn_bindings)").all();
  if (!bindingColumns.some((column) => column.name === "requested_workflow_status")) {
    database.exec("ALTER TABLE hub_task_turn_bindings ADD COLUMN requested_workflow_status TEXT");
    bindingColumns = database.prepare("PRAGMA table_info(hub_task_turn_bindings)").all();
  }
  const workLogColumns = database.prepare("PRAGMA table_info(hub_task_work_log)").all();
  const migrateBindings = !bindingColumns.some((column) => column.name === "operation_id");
  const migrateWorkLog = !workLogColumns.some((column) => column.name === "operation_id");
  if (migrateBindings || migrateWorkLog) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (migrateBindings) {
        database.exec(`
          DROP INDEX IF EXISTS hub_task_turn_bindings_task_idx;
          ALTER TABLE hub_task_turn_bindings RENAME TO hub_task_turn_bindings_turn_scope;
          CREATE TABLE hub_task_turn_bindings (
            task_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            operation_kind TEXT NOT NULL CHECK (operation_kind IN ('claim', 'legacy')),
            baseline_json TEXT NOT NULL DEFAULT '{}',
            requested_workflow_status TEXT,
            claimed_at_ms INTEGER NOT NULL,
            terminal_at_ms INTEGER,
            PRIMARY KEY (provider, provider_thread_id, turn_id, operation_id),
            FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
          ) WITHOUT ROWID;
          INSERT INTO hub_task_turn_bindings (
            task_id, provider, provider_thread_id, turn_id, operation_id, operation_kind,
            baseline_json, requested_workflow_status, claimed_at_ms, terminal_at_ms
          )
          SELECT task_id, provider, provider_thread_id, turn_id, 'legacy:' || task_id, 'legacy',
            baseline_json, requested_workflow_status, claimed_at_ms, terminal_at_ms
          FROM hub_task_turn_bindings_turn_scope;
          DROP TABLE hub_task_turn_bindings_turn_scope;
        `);
      }
      if (migrateWorkLog) {
        database.exec(`
          DROP INDEX IF EXISTS hub_task_work_log_task_idx;
          ALTER TABLE hub_task_work_log RENAME TO hub_task_work_log_turn_scope;
          CREATE TABLE hub_task_work_log (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            project_root TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            changed_files_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE,
            UNIQUE (task_id, provider, provider_thread_id, turn_id, operation_id)
          ) WITHOUT ROWID;
          INSERT INTO hub_task_work_log (
            id, task_id, provider, provider_thread_id, turn_id, operation_id,
            project_root, summary, status, changed_files_json, created_at_ms
          )
          SELECT id, task_id, provider, provider_thread_id, turn_id, 'legacy:' || task_id,
            project_root, summary, status, changed_files_json, created_at_ms
          FROM hub_task_work_log_turn_scope;
          DROP TABLE hub_task_work_log_turn_scope;
        `);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS hub_task_turn_bindings_task_idx
      ON hub_task_turn_bindings(task_id, claimed_at_ms DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS hub_task_turn_bindings_active_idx
      ON hub_task_turn_bindings(provider, provider_thread_id, turn_id)
      WHERE terminal_at_ms IS NULL;
    CREATE INDEX IF NOT EXISTS hub_task_work_log_task_idx
      ON hub_task_work_log(task_id, created_at_ms, id);
  `);
  const legacyPrefixPattern = `${LEGACY_TELEGRAM_BUNDLE_PREFIX}%`;
  const contentOffset = LEGACY_TELEGRAM_BUNDLE_PREFIX.length + 1;
  database.prepare(`
    UPDATE hub_board_tasks SET
      raw_text = substr(raw_text, ?),
      corrected_text = CASE
        WHEN corrected_text LIKE ? THEN substr(corrected_text, ?)
        ELSE corrected_text
      END,
      title = '', description = '', presentation_source = 'automatic',
      triage_status = CASE WHEN status = 'done' THEN triage_status ELSE 'pending' END,
      triage_error = NULL
    WHERE source_key LIKE 'shared-dashboard:%' AND raw_text LIKE ?
  `).run(contentOffset, legacyPrefixPattern, contentOffset, legacyPrefixPattern);
  database.exec(`
    CREATE INDEX IF NOT EXISTS hub_board_tasks_board_order_idx
      ON hub_board_tasks(status, bucket, workspace_id, board_order);
    DROP TRIGGER IF EXISTS hub_board_tasks_revision_update;
    CREATE TRIGGER hub_board_tasks_revision_update
      AFTER UPDATE ON hub_board_tasks
      WHEN NEW.row_revision = OLD.row_revision AND (
        NEW.raw_text IS NOT OLD.raw_text OR NEW.title IS NOT OLD.title OR NEW.task_number IS NOT OLD.task_number
        OR NEW.description IS NOT OLD.description OR NEW.presentation_source IS NOT OLD.presentation_source
        OR NEW.corrected_text IS NOT OLD.corrected_text OR NEW.category IS NOT OLD.category
        OR NEW.bucket IS NOT OLD.bucket OR NEW.status IS NOT OLD.status
        OR NEW.workflow_status IS NOT OLD.workflow_status OR NEW.workspace_id IS NOT OLD.workspace_id
        OR NEW.stream_id IS NOT OLD.stream_id OR NEW.source_json IS NOT OLD.source_json
        OR NEW.placement_source IS NOT OLD.placement_source OR NEW.triage_status IS NOT OLD.triage_status
        OR NEW.triage_confidence IS NOT OLD.triage_confidence OR NEW.triage_reason IS NOT OLD.triage_reason
        OR NEW.triage_error IS NOT OLD.triage_error OR NEW.started_at_ms IS NOT OLD.started_at_ms
        OR NEW.completed_at_ms IS NOT OLD.completed_at_ms OR NEW.start_request_id IS NOT OLD.start_request_id
        OR NEW.start_stream_name IS NOT OLD.start_stream_name
        OR NEW.start_destination_stream_id IS NOT OLD.start_destination_stream_id
        OR NEW.start_effect_state IS NOT OLD.start_effect_state
        OR NEW.start_effect_owner_id IS NOT OLD.start_effect_owner_id
      )
      BEGIN
        UPDATE hub_board_tasks SET row_revision = OLD.row_revision + 1 WHERE id = OLD.id;
      END;
  `);
  configureTaskChecklist(database);
  // Revision-changing edits are fenced, including updates via the existing
  // revision trigger. Opening a store may perform a no-op housekeeping UPDATE.
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS hub_task_absorption_source_update_fence
      BEFORE UPDATE ON hub_board_tasks WHEN NEW.row_revision IS NOT OLD.row_revision AND EXISTS (
        SELECT 1 FROM hub_task_lifecycle_transitions WHERE phase IN ('pending_git', 'cleanup')
          AND json_extract(json_extract(evidence_json, '$.selectedComposition.absorptionInput.text'), '$.sourceTaskId') = OLD.id
      ) BEGIN SELECT RAISE(ABORT, 'Absorbed source is owned by a pending selected transition'); END;
    CREATE TRIGGER IF NOT EXISTS hub_task_absorption_source_delete_fence
      BEFORE DELETE ON hub_board_tasks WHEN EXISTS (
        SELECT 1 FROM hub_task_lifecycle_transitions WHERE phase IN ('pending_git', 'cleanup')
          AND json_extract(json_extract(evidence_json, '$.selectedComposition.absorptionInput.text'), '$.sourceTaskId') = OLD.id
      ) BEGIN SELECT RAISE(ABORT, 'Absorbed source is owned by a pending selected transition'); END;
    CREATE TRIGGER IF NOT EXISTS hub_task_absorption_source_claim_fence
      BEFORE INSERT ON hub_task_turn_bindings WHEN EXISTS (
        SELECT 1 FROM hub_task_lifecycle_transitions WHERE phase IN ('pending_git', 'cleanup')
          AND json_extract(json_extract(evidence_json, '$.selectedComposition.absorptionInput.text'), '$.sourceTaskId') = NEW.task_id
      ) BEGIN SELECT RAISE(ABORT, 'Absorbed source is owned by a pending selected transition'); END;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS hub_board_tasks_release_revision_update
      AFTER UPDATE ON hub_board_tasks
      WHEN NEW.workflow_status IS NOT OLD.workflow_status
        OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.bucket IS NOT OLD.bucket
        OR (NEW.status = 'done') IS NOT (OLD.status = 'done')
      BEGIN
        UPDATE hub_board_tasks SET release_revision = OLD.release_revision + 1 WHERE id = OLD.id;
      END;
  `);
}

function taskLocationRows(database, bucket, workspaceId = null) {
  return database.prepare(`
    SELECT id FROM hub_board_tasks
    WHERE status != 'done' AND bucket = ?
      AND ((? IS NULL AND workspace_id IS NULL) OR workspace_id = ?)
    ORDER BY board_order, created_at_ms, id
  `).all(bucket, workspaceId, workspaceId);
}

function writeTaskOrder(database, bucket, workspaceId, ids) {
  const update = database.prepare(`
    UPDATE hub_board_tasks SET board_order = ?
    WHERE id = ? AND bucket = ?
      AND ((? IS NULL AND workspace_id IS NULL) OR workspace_id = ?)
  `);
  ids.forEach((id, position) => update.run(position, id, bucket, workspaceId, workspaceId));
}

function advanceTaskNumberSequence(database, taskNumber, timestamp) {
  const parts = taskNumberParts(taskNumber);
  if (!parts) return;
  database.prepare(`
    INSERT INTO hub_task_number_sequences (prefix, last_number, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(prefix) DO UPDATE SET
      last_number = MAX(last_number, excluded.last_number), updated_at_ms = excluded.updated_at_ms
  `).run(parts.prefix, parts.ordinal, timestamp);
}

function allocateTaskNumber(database, prefix, timestamp) {
  const normalizedPrefix = normalizedWorkspaceTaskPrefix(prefix);
  if (!normalizedPrefix) return "";
  database.prepare(`
    INSERT OR IGNORE INTO hub_task_number_sequences (prefix, last_number, updated_at_ms)
    VALUES (?, 0, ?)
  `).run(normalizedPrefix, timestamp);
  let ordinal = Number(database.prepare(
    "SELECT last_number FROM hub_task_number_sequences WHERE prefix = ?",
  ).get(normalizedPrefix)?.last_number) || 0;
  let taskNumber = "";
  do {
    ordinal += 1;
    taskNumber = `${normalizedPrefix}-${ordinal}`;
  } while (database.prepare("SELECT 1 FROM hub_board_tasks WHERE task_number = ?").get(taskNumber));
  database.prepare(`
    UPDATE hub_task_number_sequences SET last_number = ?, updated_at_ms = ? WHERE prefix = ?
  `).run(ordinal, timestamp, normalizedPrefix);
  return taskNumber;
}

function taskNumberForRow(database, row, prefix, timestamp) {
  if (String(row?.task_number ?? "").trim()) return String(row.task_number);
  return allocateTaskNumber(database, prefix, timestamp);
}

function createExtractedChecklistTask(database, {
  parentTask, itemId, text, timestamp, taskPrefix, idFactory,
}) {
  const id = String(idFactory());
  const presentation = taskPresentation(text);
  const taskNumber = allocateTaskNumber(database, taskPrefix, timestamp);
  const boardOrder = taskLocationRows(database, "workspace", parentTask.workspace_id).length;
  database.prepare(`
    INSERT INTO hub_board_tasks (
      id, raw_text, title, description, task_number, presentation_source,
      category, bucket, status, workflow_status, workspace_id, stream_id,
      source, source_key, source_json, placement_source, triage_status,
      board_order, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, 'manual', 'task', 'workspace', 'open', 'new', ?, NULL,
      'hub-checklist', NULL, ?, 'manual', 'disabled', ?, ?, ?)
  `).run(
    id,
    text,
    presentation.title,
    presentation.description,
    taskNumber,
    parentTask.workspace_id,
    JSON.stringify({ parentTaskId: parentTask.id, checklistItemId: itemId }),
    boardOrder,
    timestamp,
    timestamp,
  );
  return id;
}

function assignTaskNumber(database, row, prefix, timestamp) {
  const taskNumber = taskNumberForRow(database, row, prefix, timestamp);
  if (taskNumber) database.prepare("UPDATE hub_board_tasks SET task_number = ? WHERE id = ?").run(taskNumber, row.id);
  return taskNumber;
}

function normalizedColumnIds(workspaceIds) {
  return [...new Set((workspaceIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))];
}

function ensureColumnOrder(database, workspaceIds, timestamp) {
  const ids = [...normalizedColumnIds(workspaceIds), NOTES_COLUMN_ID];
  const rows = database.prepare(`
    SELECT column_id, position FROM hub_board_column_order
    ORDER BY position, column_id
  `).all();
  const known = new Map(rows.map((row) => [row.column_id, Number(row.position)]));
  let position = rows.reduce((maximum, row) => Math.max(maximum, Number(row.position)), -1) + 1;
  const insert = database.prepare(`
    INSERT INTO hub_board_column_order (column_id, position, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(column_id) DO NOTHING
  `);
  for (const id of ids) {
    if (known.has(id)) continue;
    insert.run(id, position, timestamp);
    known.set(id, position);
    position += 1;
  }
  const originalPosition = new Map(ids.map((id, index) => [id, index]));
  return ids.sort((left, right) => (
    known.get(left) - known.get(right) || originalPosition.get(left) - originalPosition.get(right)
  ));
}

function readColumnOrder(database, workspaceIds) {
  const ids = [...normalizedColumnIds(workspaceIds), NOTES_COLUMN_ID];
  const rows = database.prepare(`
    SELECT column_id, position FROM hub_board_column_order
    ORDER BY position, column_id
  `).all();
  const known = new Map(rows.map((row) => [row.column_id, Number(row.position)]));
  const originalPosition = new Map(ids.map((id, index) => [id, index]));
  return ids.sort((left, right) => {
    const leftPosition = known.has(left) ? known.get(left) : Number.MAX_SAFE_INTEGER;
    const rightPosition = known.has(right) ? known.get(right) : Number.MAX_SAFE_INTEGER;
    return leftPosition - rightPosition || originalPosition.get(left) - originalPosition.get(right);
  });
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sourceTaskRow(database, { source, chatId, userId, messageId }) {
  const identity = [chatId, userId, messageId].map((value) => String(value ?? "").trim());
  if (identity.some((value) => !value)) return null;
  return database.prepare(`
    SELECT * FROM hub_board_tasks
    WHERE source = ?
    ORDER BY created_at_ms DESC, id DESC
  `).all(String(source)).find((candidate) => {
    const details = parseJson(candidate.source_json);
    const linkedMessageIds = [
      details.messageId,
      ...(Array.isArray(details.messageIds) ? details.messageIds : []),
      ...(Array.isArray(details.items) ? details.items.map((item) => item?.messageId) : []),
    ].map((value) => String(value ?? "").trim()).filter(Boolean);
    return String(details.chatId ?? "") === identity[0]
      && String(details.userId ?? "") === identity[1]
      && linkedMessageIds.includes(identity[2]);
  }) ?? null;
}

function taskFromRow(row) {
  if (!row) return null;
  const presentation = String(row.title ?? "").trim()
    ? { title: row.title, description: row.description ?? "" }
    : taskPresentation(row.corrected_text ?? row.raw_text);
  const workflowStatus = TASK_WORKFLOW_STATUSES.includes(row.workflow_status)
    ? row.workflow_status
    : (row.status === "done" ? "done" : (["starting", "started"].includes(row.status) ? "in_progress" : "new"));
  return {
    id: row.id,
    taskNumber: row.task_number ?? "",
    rawText: row.raw_text,
    title: presentation.title,
    description: presentation.description,
    correctedText: row.corrected_text ?? "",
    category: row.category,
    bucket: row.bucket,
    status: row.status,
    workflowStatus,
    ...(workflowStatus === "blocked" && row.blocked_by_json ? { blockedBy: parseJson(row.blocked_by_json) } : {}),
    workspaceId: row.workspace_id ?? null,
    streamId: row.stream_id ?? null,
    source: row.source,
    sourceKey: row.source_key ?? null,
    sourceDetails: parseJson(row.source_json),
    placementSource: row.placement_source,
    triageStatus: row.triage_status,
    triageConfidence: row.triage_confidence == null ? null : Number(row.triage_confidence),
    triageReason: row.triage_reason ?? "",
    triageError: row.triage_error ?? "",
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    startedAt: row.started_at_ms == null ? null : new Date(Number(row.started_at_ms)).toISOString(),
    completedAt: row.completed_at_ms == null ? null : new Date(Number(row.completed_at_ms)).toISOString(),
    revision: Number(row.row_revision) || 1,
    releaseRevision: Number(row.release_revision) || 1,
    startRequestId: row.start_request_id ?? null,
    startStreamName: row.start_stream_name ?? null,
    startDestinationStreamId: row.start_destination_stream_id ?? null,
    startEffectState: row.start_effect_state ?? null,
    startEffectOwnerId: row.start_effect_owner_id ?? null,
    boardOrder: Number(row.board_order) || 0,
  };
}

export class TaskBoardStore {
  #database;
  #revision = 0;
  #checklistEventDrain = null;
  #mutations = new AsyncSqliteMutationQueue();
  #custodyWriteAuthorities = [];

  constructor({ databaseFile, now = () => Date.now(), idFactory = randomUUID, readOnly = false } = {}) {
    if (!databaseFile) throw new TypeError("databaseFile is required");
    this.databaseFile = path.resolve(databaseFile);
    this.now = now;
    this.idFactory = idFactory;
    if (!readOnly) mkdirSync(path.dirname(this.databaseFile), { recursive: true });
    this.#database = new DatabaseSync(this.databaseFile, { readOnly });
    try {
      if (readOnly) {
        this.#database.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA query_only = ON");
        this.#assertReleaseReadSchema();
      } else {
        configure(this.#database);
        this.#migrateLegacyReleaseRegistry();
        this.#removeReleaseRegistry();
        configureClaimCustodyNamespaceFences(this.#database);
        this.#database = claimCustodySqlConnection(this.#database, () => this.#custodyWriteAuthorities);
      }
    } catch (error) {
      this.#database.close();
      this.#database = null;
      throw error;
    }
  }

  #tableExists(database, name) {
    return Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name));
  }

  #assertReleaseReadSchema() {
    const required = {
      hub_board_tasks: [
        "id", "raw_text", "title", "task_number", "description", "presentation_source",
        "corrected_text", "category", "bucket", "status", "workflow_status", "workspace_id",
        "stream_id", "source", "source_key", "source_json", "placement_source", "triage_status",
        "triage_confidence", "triage_reason", "triage_error", "blocked_by_json", "board_order",
        "created_at_ms", "updated_at_ms", "started_at_ms", "completed_at_ms", "start_request_id",
        "start_stream_name", "start_destination_stream_id", "start_effect_state",
        "start_effect_owner_id", "row_revision", "release_revision",
      ],
      hub_task_git_references: ["task_id", "project_root", "branch", "result_commit"],
      hub_task_lifecycle_outcomes: ["task_id", "kind", "result_json", "completed_at_ms"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const actual = new Set(this.#database.prepare(`PRAGMA table_info(${table})`).all()
        .map((column) => String(column.name)));
      const missing = columns.filter((column) => !actual.has(column));
      if (missing.length) {
        throw new Error(`Task board release schema is incompatible: ${table}.${missing.join(",")}`);
      }
    }
  }

  #migrateLegacyReleaseRegistry() {
    const database = this.#database;
    const marker = database.prepare(
      "SELECT value FROM hub_board_settings WHERE key = 'task_release_registry_migrated_v1'",
    ).get();
    if (marker) return;
    const hasLegacy = this.#legacyArchiveTables().some(({ table }) => this.#tableExists(database, table));
    database.exec("BEGIN IMMEDIATE");
    try {
      if (hasLegacy) {
        this.#archiveLegacyReleaseRegistry(database);
        this.#importLegacyReleaseEntries(database);
      }
      if (hasLegacy) {
        this.#verifyLegacyReleaseArchive(database);
        this.#makeLegacyReleaseTablesReadOnly(database);
      }
      database.prepare(`
        INSERT INTO hub_board_settings (key, value, updated_at_ms)
        VALUES ('task_release_registry_migrated_v1', 'completed', ?)
      `).run(this.now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  #archiveLegacyReleaseRegistry(database, tables = this.#legacyArchiveTables()) {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO hub_release_registry_history (
        source_kind, source_id, status, payload_json, payload_sha256, archived_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const { kind, table, order, identity } of tables) {
      if (!this.#tableExists(database, table)) continue;
      for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()) {
        const payload = JSON.stringify(row);
        insert.run(
          kind, identity(row), String(row.status ?? "archived"), payload,
          createHash("sha256").update(payload, "utf8").digest("hex"), this.now(),
        );
      }
    }
  }

  #legacyArchiveTables() {
    return [
      { kind: "legacy", table: "hub_release_changes", order: "id", identity: (row) => String(row.id) },
      { kind: "batch", table: "hub_release_batches", order: "id", identity: (row) => String(row.id) },
      { kind: "changeset", table: "hub_release_change_sets", order: "id", identity: (row) => String(row.id) },
      { kind: "observation", table: "hub_release_turn_observations", order: "id", identity: (row) => String(row.id) },
      {
        kind: "file", table: "hub_release_change_set_files",
        order: "change_set_id, project_root, file_path",
        identity: (row) => [row.change_set_id, row.project_root, row.file_path].join("\0"),
      },
      { kind: "binding", table: "hub_release_change_set_bindings", order: "stream_id", identity: (row) => String(row.stream_id) },
      { kind: "event", table: "hub_release_change_set_events", order: "id", identity: (row) => String(row.id) },
    ];
  }

  #retiredReleaseTables() {
    return [
      ...this.#legacyArchiveTables(),
      {
        kind: "task-state", table: "hub_task_release_state", order: "task_id",
        identity: (row) => String(row.task_id),
      },
      {
        kind: "task-revision", table: "hub_task_release_revisions",
        order: "task_id, task_revision",
        identity: (row) => [row.task_id, row.task_revision].join("\0"),
      },
      {
        kind: "task-revision-file", table: "hub_task_release_revision_files",
        order: "task_id, task_revision, project_root, file_path",
        identity: (row) => [
          row.task_id, row.task_revision, row.project_root, row.file_path,
        ].join("\0"),
      },
      {
        kind: "task-completion", table: "hub_task_release_completions",
        order: "task_id, task_revision",
        identity: (row) => [row.task_id, row.task_revision].join("\0"),
      },
    ];
  }

  #verifyLegacyReleaseArchive(database, tables = this.#legacyArchiveTables()) {
    for (const { kind, table, order, identity } of tables) {
      if (!this.#tableExists(database, table)) continue;
      const sourceRows = database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
      const archivedRows = database.prepare(`
        SELECT source_id, payload_json, payload_sha256 FROM hub_release_registry_history
        WHERE source_kind = ? ORDER BY source_id
      `).all(kind);
      const archived = new Map(archivedRows.map((row) => [row.source_id, row]));
      for (const source of sourceRows) {
        const payload = JSON.stringify(source);
        const expectedHash = createHash("sha256").update(payload, "utf8").digest("hex");
        const sourceId = identity(source);
        const stored = archived.get(sourceId);
        if (!stored || stored.payload_json !== payload || stored.payload_sha256 !== expectedHash) {
          throw new Error(`legacy release ${kind} archive checksum mismatch: ${sourceId}`);
        }
      }
    }
  }

  #makeLegacyReleaseTablesReadOnly(database) {
    for (const table of [
      "hub_release_changes", "hub_release_batches", "hub_release_change_sets",
      "hub_release_turn_observations", "hub_release_change_set_files",
      "hub_release_change_set_bindings", "hub_release_change_set_events",
    ]) {
      if (!this.#tableExists(database, table)) continue;
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const trigger = `task_release_archive_${table}_${operation.toLowerCase()}`;
        database.exec(`
          CREATE TRIGGER IF NOT EXISTS ${trigger}
          BEFORE ${operation} ON ${table}
          BEGIN
            SELECT RAISE(ABORT, 'legacy release registry is a read-only archive');
          END
        `);
      }
    }
  }

  #importLegacyReleaseEntries(database) {
    const coveredLegacyIds = new Set();
    if (this.#tableExists(database, "hub_release_turn_observations")) {
      for (const row of database.prepare(`
        SELECT legacy_release_change_id AS id FROM hub_release_turn_observations
        WHERE legacy_release_change_id IS NOT NULL
      `).all()) coveredLegacyIds.add(String(row.id));
    }
    if (this.#tableExists(database, "hub_release_change_sets")) {
      const rows = database.prepare(`
        SELECT * FROM hub_release_change_sets WHERE status IN ('draft', 'ready')
        ORDER BY created_at_ms, id
      `).all();
      for (const row of rows) this.#importLegacyChangeSet(database, row);
    }
    if (this.#tableExists(database, "hub_release_changes")) {
      const rows = database.prepare(`
        SELECT * FROM hub_release_changes
        WHERE status NOT IN ('released', 'discarded') ORDER BY created_at_ms, id
      `).all();
      for (const row of rows) {
        if (!coveredLegacyIds.has(String(row.id))) this.#importLegacyReleaseChange(database, row);
      }
    }
  }

  #ensureMigratedTask(database, { taskId = null, workspaceId, streamId, title, workflowStatus, sourceKey }) {
    const existing = taskId && database.prepare("SELECT id FROM hub_board_tasks WHERE id = ?").get(taskId);
    const id = existing?.id ?? this.idFactory();
    const timestamp = this.now();
    if (!existing) {
      const normalizedTitle = String(title ?? "").trim().slice(0, 160) || "Migrated release task";
      database.prepare(`
        INSERT INTO hub_board_tasks (
          id, raw_text, title, description, presentation_source, category, bucket, status,
          workflow_status, workspace_id, stream_id, source, source_key, source_json,
          placement_source, triage_status, board_order, created_at_ms, updated_at_ms, started_at_ms
        ) VALUES (?, ?, ?, '', 'manual', 'task', 'workspace', 'started', ?, ?, ?,
          'release-registry-migration', ?, '{}', 'migration', 'disabled', 0, ?, ?, ?)
      `).run(
        id, normalizedTitle, normalizedTitle, workflowStatus, workspaceId, streamId,
        sourceKey, timestamp, timestamp, timestamp,
      );
    } else {
      database.prepare(`
        UPDATE hub_board_tasks SET bucket = 'workspace', status = 'started', workflow_status = ?,
          workspace_id = ?, stream_id = ?, completed_at_ms = NULL, updated_at_ms = ? WHERE id = ?
      `).run(workflowStatus, workspaceId, streamId, timestamp, id);
    }
    database.prepare(`
      INSERT INTO hub_task_release_state (task_id, revision, frozen_revision, manifest_hash, updated_at_ms)
      VALUES (?, 0, NULL, '', ?) ON CONFLICT(task_id) DO NOTHING
    `).run(id, timestamp);
    return id;
  }

  #importLegacyChangeSet(database, row) {
    let files = [];
    if (this.#tableExists(database, "hub_release_change_set_files")) {
      const storedFiles = database.prepare(`
        SELECT project_root AS projectRoot, file_path AS path, operation, NULL AS turnId,
          base_blob AS baseBlob, result_blob AS resultBlob, patch_hash AS patchHash
        FROM hub_release_change_set_files WHERE change_set_id = ?
      `).all(row.id);
      files = storedFiles.filter((file) => ["added", "modified", "deleted"].includes(file.operation));
    }
    const frozenEvent = this.#tableExists(database, "hub_release_change_set_events")
      ? database.prepare(`
        SELECT payload_json FROM hub_release_change_set_events
        WHERE change_set_id = ? AND event_type = 'changeset.frozen'
        ORDER BY created_at_ms DESC, id DESC LIMIT 1
      `).get(row.id)
      : null;
    let frozenAudit = null;
    try { frozenAudit = JSON.parse(String(frozenEvent?.payload_json ?? "null")); } catch { frozenAudit = null; }
    const verifiedReady = row.status === "ready"
      && Boolean(String(row.manifest_hash ?? "").trim())
      && String(row.repository_evidence_json ?? "[]") !== "[]"
      && files.length > 0
      && files.every((file) => String(file.base_blob ?? file.baseBlob ?? "").trim()
        && String(file.result_blob ?? file.resultBlob ?? "").trim())
      && Boolean(frozenAudit?.verification?.verifier?.name || frozenAudit?.verifier?.name);
    const workflowStatus = verifiedReady ? "awaiting_implementation" : "in_progress";
    const taskId = this.#ensureMigratedTask(database, {
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      streamId: row.owner_stream_id,
      title: row.title,
      workflowStatus,
      sourceKey: `release-migration:changeset:${row.id}`,
    });
    if (this.#tableExists(database, "hub_release_turn_observations")) {
      for (const observation of database.prepare(`
        SELECT * FROM hub_release_turn_observations WHERE change_set_id = ? ORDER BY created_at_ms, id
      `).all(row.id)) {
        let observed = [];
        try { observed = JSON.parse(String(observation.files_json ?? "[]")); } catch { observed = []; }
        if (observed.length) this.#insertMigratedWorkLog(database, taskId, observation, observed);
      }
    }
    this.#migrateRepositoryEvidence(database, taskId, row.repository_evidence_json);
    this.#freezeMigratedTask(database, taskId, verifiedReady, Number(row.revision) || 1, {
      manifestHash: row.manifest_hash,
      repositoriesJson: row.repository_evidence_json,
      verificationJson: JSON.stringify(frozenAudit?.verification ?? frozenAudit ?? {}),
      files,
    });
    database.prepare(`
      UPDATE hub_release_registry_history SET migrated_task_id = ?
      WHERE source_kind = 'changeset' AND source_id = ?
    `).run(taskId, row.id);
  }

  #importLegacyReleaseChange(database, row) {
    const workflowStatus = "in_progress";
    const taskId = this.#ensureMigratedTask(database, {
      workspaceId: row.workspace_id,
      streamId: row.stream_id,
      title: row.summary,
      workflowStatus,
      sourceKey: `release-migration:legacy:${row.id}`,
    });
    let files = [];
    for (const field of ["files_json", "observed_files_json"]) {
      try { files = JSON.parse(String(row[field] ?? "[]")); } catch { files = []; }
      if (files.length) break;
    }
    const changedFiles = files.map((file) => ({
      projectRoot: row.project_root, path: file, operation: "modified", turnId: row.turn_id,
    }));
    this.#insertMigratedWorkLog(database, taskId, row, files);
    this.#freezeMigratedTask(database, taskId, false, Number(row.revision) || 1);
    database.prepare(`
      UPDATE hub_release_registry_history SET migrated_task_id = ?
      WHERE source_kind = 'legacy' AND source_id = ?
    `).run(taskId, row.id);
  }

  #insertMigratedWorkLog(database, taskId, row, files) {
    if (!files.length) return;
    database.prepare(`
      INSERT OR IGNORE INTO hub_task_work_log (
        id, task_id, provider, provider_thread_id, turn_id, operation_id,
        project_root, summary, status, changed_files_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.idFactory(), String(taskId), String(row.provider ?? "migration"),
      String(row.provider_thread_id ?? `migration:${taskId}`),
      String(row.turn_id ?? row.id ?? `migration:${taskId}`),
      `migration:${String(row.id ?? taskId)}`,
      String(row.project_root ?? ""), String(row.summary ?? "").slice(0, 2_000),
      String(row.status ?? row.observed_status ?? "completed"),
      JSON.stringify(files), Number(row.created_at_ms) || this.now(),
    );
  }

  #migrateRepositoryEvidence(database, taskId, rawEvidence) {
    let values = [];
    try { values = JSON.parse(String(rawEvidence ?? "[]")); } catch { values = []; }
    const insert = database.prepare(`
      INSERT OR REPLACE INTO hub_task_git_references
        (task_id, project_root, branch, result_commit, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const value of Array.isArray(values) ? values : []) {
      const projectRoot = String(value.projectRoot ?? value.project_root ?? "").trim();
      const result = String(value.resultRevision ?? value.result_revision ?? "").trim();
      if (projectRoot && result) {
        insert.run(taskId, projectRoot, taskBranchName(taskId, projectRoot), result, this.now());
      }
    }
  }

  #freezeMigratedTask(database, taskId, frozen, revision, evidence = {}) {
    const details = this.#releaseDetails(database, taskId);
    const taskRevision = Number(database.prepare(
      "SELECT row_revision AS value FROM hub_board_tasks WHERE id = ?",
    ).get(taskId)?.value) || revision;
    const manifestHash = frozen && Array.isArray(evidence.files) && evidence.files.length
      ? String(evidence.manifestHash ?? "").trim()
      : "";
    if (manifestHash) {
      database.prepare(`
        INSERT OR IGNORE INTO hub_task_release_revisions (
          task_id, task_revision, manifest_hash, repositories_json, verification_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        taskId, taskRevision, manifestHash, String(evidence.repositoriesJson ?? "[]"),
        String(evidence.verificationJson ?? "{}"), this.now(),
      );
      const insert = database.prepare(`
        INSERT OR IGNORE INTO hub_task_release_revision_files (
          task_id, task_revision, project_root, file_path, operation,
          base_blob, result_blob, patch_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of Array.isArray(evidence.files) ? evidence.files : []) {
        insert.run(
          taskId, taskRevision, file.projectRoot, file.path, file.operation,
          String(file.base_blob ?? file.baseBlob ?? ""),
          String(file.result_blob ?? file.resultBlob ?? ""),
          String(file.patch_hash ?? file.patchHash ?? ""),
        );
      }
    }
    database.prepare(`
      UPDATE hub_task_release_state SET revision = ?, frozen_revision = ?, manifest_hash = ?, updated_at_ms = ?
      WHERE task_id = ?
    `).run(taskRevision, manifestHash ? taskRevision : null, manifestHash, this.now(), taskId);
  }

  #withDatabase(operation) {
    const database = this.#database;
    if (!database) throw new Error("Task board store is closed");
    const changesBefore = Number(database.prepare("SELECT total_changes() AS value").get()?.value) || 0;
    try {
      return operation(database);
    } finally {
      const changesAfter = Number(database.prepare("SELECT total_changes() AS value").get()?.value) || 0;
      if (changesAfter !== changesBefore) this.#revision += 1;
    }
  }

  #taskRow(database, id) {
    const taskId = String(id ?? "").trim();
    const row = database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId);
    if (!row) throw new Error("Task не найден");
    return row;
  }

  #releaseIdentityDetails(database, taskId) {
    const gitReferences = normalizedTaskGitReferences(database.prepare(`
      SELECT project_root AS projectRoot, branch, result_commit AS resultCommit
      FROM hub_task_git_references WHERE task_id = ? ORDER BY project_root
    `).all(taskId));
    let squashTransfer = null;
    let resultReleaseRevision = null;
    let squashAbsorbedBy = null;
    const transferRow = database.prepare(LATEST_TASK_SQUASH_TRANSFER_OUTCOME_SQL).get(taskId, taskId);
    if (transferRow) {
      try {
        const outcome = JSON.parse(transferRow.result_json);
        const proof = normalizedTaskSquashTransfer(outcome?.evidence?.squashTransfer);
        if (proof.survivor.taskId === taskId) {
          squashTransfer = proof;
          const outcomeTask = outcome?.task;
          const outcomeRevision = Number(outcomeTask?.releaseRevision);
          const references = normalizedTaskGitReferences(outcomeTask?.gitReferences);
          const matchingReferences = references.filter((reference) => (
            sameResolvedPath(reference.projectRoot, proof.projectRoot)
            && reference.branch === proof.survivor.branch
            && reference.resultCommit === proof.survivor.resultCommit
          ));
          if (outcomeTask?.id === taskId
              && outcomeTask.workflowStatus === "testing"
              && Number(outcomeTask.revision) === proof.survivor.revision + 1
              && Number.isInteger(outcomeRevision)
              && outcomeRevision === proof.survivor.releaseRevision + 1
              && matchingReferences.length === 1) {
            resultReleaseRevision = outcomeRevision;
          }
        }
        if (proof.source.taskId === taskId) squashAbsorbedBy = proof;
      } catch {
        // Invalid durable evidence cannot grant release or cleanup authority.
      }
    }
    return {
      gitReferences,
      ...(squashTransfer ? { squashTransfer } : {}),
      ...(resultReleaseRevision ? { resultReleaseRevision } : {}),
      ...(squashAbsorbedBy ? { squashAbsorbedBy } : {}),
    };
  }

  #releaseDetails(database, taskId) {
    const workLog = database.prepare(`
      SELECT provider, provider_thread_id AS threadId, turn_id AS turnId,
        operation_id AS operationId, project_root AS projectRoot,
        summary, status, changed_files_json, created_at_ms
      FROM hub_task_work_log WHERE task_id = ? ORDER BY created_at_ms, id
    `).all(taskId).map((row) => {
      let files = [];
      try { files = JSON.parse(String(row.changed_files_json ?? "[]")); } catch { files = []; }
      return {
        provider: row.provider,
        threadId: row.threadId,
        turnId: row.turnId,
        operationId: row.operationId,
        projectRoot: row.projectRoot,
        summary: row.summary,
        status: row.status,
        changedFiles: files,
        createdAt: new Date(Number(row.created_at_ms)).toISOString(),
      };
    });
    // The journal owns terminal turns; exact Task bindings own membership.
    // Read scalar fields only: prompts, bodies and diffs do not belong in board snapshots.
    if (this.#tableExists(database, "journal_records")) {
      const rows = database.prepare(`
        SELECT DISTINCT j.provider, j.thread_id AS threadId, j.turn_id AS turnId,
          j.task_thread_id AS taskThreadId, j.project_root AS projectRoot,
          j.completed_at_ms AS completedAtMs,
          substr(json_extract(j.record_json, '$.title'), 1, 2000) AS summary,
          json_extract(j.record_json, '$.status') AS status
        FROM hub_task_turn_bindings b
        JOIN journal_records j ON j.provider = b.provider
          AND j.thread_id = b.provider_thread_id AND j.turn_id = b.turn_id
        WHERE b.task_id = ? AND json_valid(j.record_json)
          AND j.completed_at_ms IS NOT NULL
          AND coalesce(json_extract(j.record_json, '$.provisional'), 0) = 0
          AND coalesce(json_extract(j.record_json, '$.aggregateOnly'), 0) = 0
          AND json_extract(j.record_json, '$.status') IN ('completed', 'failed', 'cancelled', 'interrupted')
      `).all(taskId);
      const key = (row) => JSON.stringify([row.provider, row.threadId, row.turnId]);
      const current = new Map(rows.map((row) => [key(row), {
        provider: row.provider, threadId: row.threadId, turnId: row.turnId,
        taskThreadId: row.taskThreadId || row.threadId, projectRoot: row.projectRoot,
        summary: row.summary || "", status: row.status, changedFiles: [],
        createdAt: new Date(Number(row.completedAtMs)).toISOString(),
      }]));
      // Keep pre-journal entries when their exact source record is no longer retained.
      for (let index = workLog.length - 1; index >= 0; index -= 1) {
        if (current.has(key(workLog[index]))) workLog.splice(index, 1);
      }
      workLog.push(...current.values());
      workLog.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || key(a).localeCompare(key(b)));
    }
    const gitAdoptions = database.prepare(`
      SELECT task_number AS taskNumber, project_root AS projectRoot, branch,
        reported_result_commit AS reportedResultCommit, main_result_commit AS mainResultCommit,
        patch_id AS patchId, evidence_stream_id AS evidenceStreamId,
        evidence_provider AS evidenceProvider, evidence_thread_id AS evidenceThreadId,
        evidence_turn_id AS evidenceTurnId, actor_stream_id AS actorStreamId,
        actor_provider AS actorProvider, actor_thread_id AS actorThreadId,
        request_id AS requestId, adopted_at_ms
      FROM hub_task_legacy_git_adoptions WHERE task_id = ? ORDER BY project_root
    `).all(taskId).map(({ adopted_at_ms: adoptedAtMs, ...row }) => ({
      ...row,
      adoptedAt: new Date(Number(adoptedAtMs)).toISOString(),
    }));
    return {
      workLog,
      gitAdoptions,
      ...this.#releaseIdentityDetails(database, taskId),
    };
  }

  #taskWithRelease(database, row, checklistProjections = null) {
    const task = taskFromRow(row);
    if (!task) return null;
    const checklist = (checklistProjections ?? taskChecklistProjectionMap(database, [task.id])).get(task.id)
      ?? { checklist: [], checklistParent: null };
    return { ...task, ...this.#releaseDetails(database, task.id), ...checklist };
  }

  #withChecklistWrite(operation) {
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(database);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  get revision() {
    const journalRevision = this.#database && this.#tableExists(this.#database, "journal_store_meta")
      ? Number(this.#database.prepare("SELECT value FROM journal_store_meta WHERE key = 'revision'").get()?.value) || 0
      : 0;
    return this.#revision + journalRevision;
  }

  get snapshotRevision() {
    if (!this.#database) return null;
    const externalRevision = Number(
      this.#database.prepare("PRAGMA data_version").get()?.data_version,
    ) || 0;
    return `${this.revision}:${externalRevision}`;
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }

  create({
    text, source = "hub", sourceKey = null, sourceDetails = {}, triageStatus = "pending",
    bucket = "backlog", workspaceId = null, taskPrefix = "",
  } = {}) {
    const normalizedText = normalizedTaskText(text);
    const legacyBundle = normalizedText.startsWith(LEGACY_TELEGRAM_BUNDLE_PREFIX);
    const rawText = legacyBundle
      ? normalizedTaskText(normalizedText.slice(LEGACY_TELEGRAM_BUNDLE_PREFIX.length))
      : normalizedText;
    const presentation = taskPresentation(rawText);
    const normalizedSourceKey = String(sourceKey ?? "").trim() || null;
    const initialTriageStatus = !legacyBundle && triageStatus === "disabled" ? "disabled" : "pending";
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (normalizedSourceKey) {
          const existing = database.prepare(
            "SELECT * FROM hub_board_tasks WHERE source_key = ?",
          ).get(normalizedSourceKey);
          if (existing) {
            database.exec("COMMIT");
            return taskFromRow(existing);
          }
        }
        const timestamp = this.now();
        const id = String(this.idFactory());
        const normalizedBucket = normalizedTaskBucket(bucket);
        const normalizedWorkspaceId = normalizedBucket === "workspace" ? String(workspaceId ?? "").trim() : null;
        if (normalizedBucket === "workspace" && !normalizedWorkspaceId) throw new Error("Выберите Workspace");
        const taskNumber = normalizedBucket === "workspace" ? allocateTaskNumber(database, taskPrefix, timestamp) : "";
        const boardOrder = taskLocationRows(database, normalizedBucket, normalizedWorkspaceId).length;
        database.prepare(`
          INSERT INTO hub_board_tasks (
            id, raw_text, title, description, task_number, bucket, workspace_id,
            source, source_key, source_json, triage_status, board_order, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          rawText,
          presentation.title,
          presentation.description,
          taskNumber,
          normalizedBucket,
          normalizedWorkspaceId,
          String(source ?? "hub").trim() || "hub",
          normalizedSourceKey,
          JSON.stringify(sourceDetails ?? {}),
          initialTriageStatus,
          boardOrder,
          timestamp,
          timestamp,
        );
        const result = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(id));
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  attachToSourceMessage({ source = "telegram", chatId, userId, messageId, attachments = [] } = {}) {
    const identity = [chatId, userId, messageId].map((value) => String(value ?? "").trim());
    const incoming = (Array.isArray(attachments) ? attachments : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    if (identity.some((value) => !value) || !incoming.length) {
      throw new Error("Не удалось определить задачу или вложение");
    }
    return this.#withDatabase((database) => {
      const row = sourceTaskRow(database, { source, chatId, userId, messageId });
      if (!row) throw new Error("Задача для исходного сообщения не найдена");
      this.#taskRow(database, row.id);
      const details = parseJson(row.source_json);
      details.attachments = [...new Set([
        ...(Array.isArray(details.attachments) ? details.attachments : []),
        ...incoming,
      ])];
      database.prepare(`
        UPDATE hub_board_tasks SET source_json = ?, updated_at_ms = ? WHERE id = ?
      `).run(JSON.stringify(details), this.now(), row.id);
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(row.id));
    });
  }

  addAttachment(id, attachment) {
    const taskId = String(id ?? "").trim();
    const file = String(attachment ?? "").trim();
    if (!taskId || !file) throw new Error("Не удалось определить задачу или вложение");
    return this.#withDatabase((database) => {
      const row = this.#taskRow(database, taskId);
      const details = parseJson(row.source_json);
      details.attachments = [...new Set([
        ...(Array.isArray(details.attachments) ? details.attachments : []),
        file,
      ])];
      database.prepare(`
        UPDATE hub_board_tasks SET source_json = ?, updated_at_ms = ? WHERE id = ?
      `).run(JSON.stringify(details), this.now(), taskId);
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
    });
  }

  appendSourceMessage({
    source = "telegram",
    chatId,
    userId,
    messageId,
    text,
    sourceDetails = {},
    attachments = [],
    triageStatus = "pending",
  } = {}) {
    const addition = normalizedTaskText(text);
    const nextTriageStatus = triageStatus === "disabled" ? "disabled" : "pending";
    return this.#withDatabase((database) => {
      const row = sourceTaskRow(database, { source, chatId, userId, messageId });
      if (!row) throw new Error("Задача для исходного сообщения не найдена");
      this.#taskRow(database, row.id);
      const currentDetails = parseJson(row.source_json);
      const currentBlocks = String(row.raw_text).match(/^--- Сообщение \d+ ·/gmu)?.length ?? 0;
      const priorText = currentBlocks
        ? String(row.raw_text)
        : `--- Сообщение 1 · Вы ---\n${String(row.raw_text).trim()}`;
      const rawText = `${priorText}\n\n--- Сообщение ${Math.max(1, currentBlocks) + 1} · Вы ---\n${addition}`;
      const presentation = taskPresentation(rawText);
      const linkedMessageIds = [...new Set([
        currentDetails.messageId,
        ...(Array.isArray(currentDetails.messageIds) ? currentDetails.messageIds : []),
        sourceDetails?.messageId,
      ].map((value) => Number(value)).filter(Number.isSafeInteger))];
      const nextDetails = {
        ...currentDetails,
        ...(sourceDetails && typeof sourceDetails === "object" ? sourceDetails : {}),
        chatId: currentDetails.chatId ?? chatId,
        userId: currentDetails.userId ?? userId,
        messageId: currentDetails.messageId ?? messageId,
        messageIds: linkedMessageIds,
      };
      const nextAttachments = [...new Set([
        ...(Array.isArray(currentDetails.attachments) ? currentDetails.attachments : []),
        ...(Array.isArray(attachments) ? attachments : []),
      ].map((value) => String(value ?? "").trim()).filter(Boolean))];
      if (nextAttachments.length) nextDetails.attachments = nextAttachments;
      database.prepare(`
        UPDATE hub_board_tasks SET
          raw_text = ?,
          title = CASE WHEN presentation_source = 'manual' THEN title ELSE ? END,
          description = CASE WHEN presentation_source = 'manual' THEN description ELSE ? END,
          corrected_text = CASE WHEN presentation_source = 'manual' THEN corrected_text ELSE NULL END,
          category = CASE WHEN presentation_source = 'manual' THEN category ELSE 'unknown' END,
          source_json = ?, triage_status = ?, triage_confidence = NULL,
          triage_reason = NULL, triage_error = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(
        rawText,
        presentation.title,
        presentation.description,
        JSON.stringify(nextDetails),
        nextTriageStatus,
        this.now(),
        row.id,
      );
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(row.id));
    });
  }

  mergeSourceMessage({
    source = "telegram",
    chatId,
    userId,
    messageId,
    text,
    sourceDetails = {},
    triageStatus = "pending",
  } = {}) {
    const rawText = normalizedTaskText(text);
    const presentation = taskPresentation(rawText);
    const nextTriageStatus = triageStatus === "disabled" ? "disabled" : "pending";
    return this.#withDatabase((database) => {
      const row = sourceTaskRow(database, { source, chatId, userId, messageId });
      if (!row) throw new Error("Задача для исходного сообщения не найдена");
      this.#taskRow(database, row.id);
      const currentDetails = parseJson(row.source_json);
      const nextDetails = {
        ...currentDetails,
        ...(sourceDetails && typeof sourceDetails === "object" ? sourceDetails : {}),
        chatId: currentDetails.chatId ?? chatId,
        userId: currentDetails.userId ?? userId,
        messageId: currentDetails.messageId ?? messageId,
      };
      const attachments = [...new Set([
        ...(Array.isArray(currentDetails.attachments) ? currentDetails.attachments : []),
        ...(Array.isArray(sourceDetails?.attachments) ? sourceDetails.attachments : []),
      ])];
      if (attachments.length) nextDetails.attachments = attachments;
      database.prepare(`
        UPDATE hub_board_tasks SET
          raw_text = ?,
          title = CASE WHEN presentation_source = 'manual' THEN title ELSE ? END,
          description = CASE WHEN presentation_source = 'manual' THEN description ELSE ? END,
          corrected_text = CASE WHEN presentation_source = 'manual' THEN corrected_text ELSE NULL END,
          category = CASE WHEN presentation_source = 'manual' THEN category ELSE 'unknown' END,
          source_json = ?, triage_status = ?, triage_confidence = NULL,
          triage_reason = NULL, triage_error = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(
        rawText,
        presentation.title,
        presentation.description,
        JSON.stringify(nextDetails),
        nextTriageStatus,
        this.now(),
        row.id,
      );
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(row.id));
    });
  }

  task(id) {
    const taskId = String(id ?? "").trim();
    if (!taskId) return null;
    return this.#withDatabase((database) => this.#taskWithRelease(database,
      database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId),
    ));
  }

  list({ includeDone = true } = {}) {
    return this.#withDatabase((database) => {
      const rows = database.prepare(`
        SELECT * FROM hub_board_tasks
        ${includeDone ? "" : "WHERE status != 'done'"}
        ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'started' THEN 1 ELSE 2 END,
          bucket, workspace_id, board_order, created_at_ms, id
      `).all();
      const checklistProjections = taskChecklistProjectionMap(database, rows.map((row) => row.id));
      return rows.map((row) => this.#taskWithRelease(database, row, checklistProjections));
    });
  }

  updateChecklist({
    id, operation, itemId = null, text = null, completed = null,
    beforeItemId = null, linkedTaskId = null, expectedRevision, requestId, taskPrefix = "",
  } = {}) {
    const payload = {
      taskId: String(id ?? "").trim(), operation, itemId, text, completed,
      beforeItemId, linkedTaskId, expectedRevision, requestId: String(requestId ?? "").trim(),
    };
    const outcome = this.#withChecklistWrite((database) => mutateTaskChecklist(database, payload, {
      now: this.now,
      idFactory: this.idFactory,
      createExtractedTask: (target, extracted) => createExtractedChecklistTask(target, {
        ...extracted,
        taskPrefix,
        idFactory: this.idFactory,
      }),
    }));
    return this.checklistRequestResult(payload, outcome);
  }

  applyChecklistLinkedTaskAction({
    id, itemId, linkedTaskId, action, expectedTaskRevision,
    expectedLinkedTaskRevision, requestId,
  } = {}) {
    const payload = {
      taskId: String(id ?? "").trim(),
      itemId: String(itemId ?? "").trim(),
      linkedTaskId: String(linkedTaskId ?? "").trim(),
      action: String(action ?? "").trim(),
      expectedTaskRevision,
      expectedLinkedTaskRevision,
      requestId: String(requestId ?? "").trim(),
    };
    let firstReplay = null;
    for (let phase = 0; phase < 2; phase += 1) {
      const outcome = this.#withChecklistWrite((database) => (
        mutateTaskChecklistLinkedAction(database, payload, { now: this.now })
      ));
      if (firstReplay == null) firstReplay = outcome.replayed;
      if (outcome.completed) return { ...outcome, replayed: firstReplay };
    }
    throw new Error("Действие связанной Task не завершило durable-фазу");
  }

  checklistRequestResult(payload = {}, knownOutcome = null) {
    return this.#withDatabase((database) => {
      const outcome = knownOutcome ?? taskChecklistRequestOutcome(database, {
        taskId: payload.taskId ?? payload.id,
        operation: payload.operation,
        itemId: payload.itemId,
        text: payload.text,
        completed: payload.completed,
        beforeItemId: payload.beforeItemId,
        linkedTaskId: payload.linkedTaskId,
        expectedRevision: payload.expectedRevision,
        requestId: payload.requestId,
      });
      if (!outcome) return null;
      const taskId = String(payload.taskId ?? payload.id);
      const ids = [taskId, outcome.createdTaskId].filter(Boolean);
      const checklistProjections = taskChecklistProjectionMap(database, ids);
      const project = (id) => this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(id),
        checklistProjections,
      );
      return {
        task: project(taskId),
        createdTask: outcome.createdTaskId ? project(outcome.createdTaskId) : null,
        itemId: outcome.itemId,
        replayed: outcome.replayed,
      };
    });
  }

  deliverChecklistEvents(deliver) {
    if (typeof deliver !== "function") throw new TypeError("Task checklist event delivery is required");
    if (this.#checklistEventDrain) return this.#checklistEventDrain;
    this.#checklistEventDrain = (async () => {
      let delivered = 0;
      let quarantined = 0;
      const diagnostics = [];
      for (;;) {
        const event = this.#withDatabase((database) => nextTaskChecklistEvent(database));
        if (!event) break;
        if (event.invalidReason) {
          await this.#mutations.run(() => this.#withDatabase((database) => {
            quarantineTaskChecklistEvent(database, event.id, event.invalidReason, this.now());
          }), { requestId: `task:checklist-event:${event.id}:quarantine` });
          quarantined += 1;
          diagnostics.push({ eventId: event.id, reason: event.invalidReason });
          continue;
        }
        await deliver(event);
        await this.#mutations.run(() => this.#withDatabase((database) => {
          markTaskChecklistEventDelivered(database, event.id, this.now());
        }), { requestId: `task:checklist-event:${event.id}:delivered` });
        delivered += 1;
      }
      return { delivered, quarantined, diagnostics };
    })().finally(() => {
      this.#checklistEventDrain = null;
    });
    return this.#checklistEventDrain;
  }

  pendingTriage() {
    return this.#withDatabase((database) => database.prepare(`
      SELECT * FROM hub_board_tasks
      WHERE triage_status IN ('pending', 'running')
      ORDER BY created_at_ms, id
    `).all().map(taskFromRow));
  }

  disablePendingTriage() {
    return this.#withDatabase((database) => Number(database.prepare(`
      UPDATE hub_board_tasks SET triage_status = 'disabled', updated_at_ms = ?
      WHERE triage_status IN ('pending', 'running')
    `).run(this.now()).changes));
  }

  markTriageRunning(id) {
    return this.#withDatabase((database) => {
      this.#taskRow(database, id);
      database.prepare(`
        UPDATE hub_board_tasks
        SET triage_status = 'running', triage_error = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(this.now(), String(id));
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
    });
  }

  updatePresentation(id, { title, description = "", taskNumber = undefined } = {}) {
    const taskId = String(id ?? "").trim();
    const normalizedTitle = normalizedTaskTitle(title);
    const normalizedDescription = normalizedTaskDescription(description);
    const correctedText = normalizedDescription
      ? `${normalizedTitle}\n\n${normalizedDescription}`
      : normalizedTitle;
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#taskRow(database, taskId);
        const nextTaskNumber = taskNumber === undefined
          ? String(current.task_number ?? "")
          : normalizedTaskNumber(taskNumber, { allowEmpty: false });
        const duplicate = nextTaskNumber && database.prepare(
          "SELECT id FROM hub_board_tasks WHERE task_number = ? AND id != ?",
        ).get(nextTaskNumber, taskId);
        if (duplicate) throw new Error(`Номер Task уже используется: ${nextTaskNumber}`);
        const result = database.prepare(`
          UPDATE hub_board_tasks SET
            title = ?, description = ?, corrected_text = ?, task_number = ?, presentation_source = 'manual',
            updated_at_ms = ?
          WHERE id = ?
        `).run(normalizedTitle, normalizedDescription, correctedText, nextTaskNumber, this.now(), taskId);
        if (!result.changes) throw new Error("Задача не найдена");
        if (nextTaskNumber) advanceTaskNumberSequence(database, nextTaskNumber, this.now());
        const updated = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
        database.exec("COMMIT");
        return updated;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  applyTriage(id, {
    title,
    description,
    correctedText,
    category,
    confidence,
    reason = "",
    bucket = "backlog",
    workspaceId = null,
    taskPrefix = "",
    autoPlace = false,
  } = {}) {
    const taskId = String(id ?? "").trim();
    const normalizedCorrectedText = normalizedTaskText(correctedText);
    const presentation = taskPresentation(normalizedCorrectedText, { title, description });
    const normalizedCategory = normalizedTaskCategory(category);
    const normalizedBucket = normalizedTaskBucket(bucket);
    const numericConfidence = Math.max(0, Math.min(1, Number(confidence) || 0));
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#taskRow(database, taskId);
        const canAutoPlace = autoPlace
          && current.placement_source === "default"
          && current.bucket === "backlog"
          && current.status === "open";
        const targetWorkspaceId = canAutoPlace && normalizedBucket === "workspace"
          ? String(workspaceId ?? "").trim() || null
          : current.workspace_id;
        if (canAutoPlace && targetWorkspaceId !== current.workspace_id) {
          assertTaskChecklistWorkspaceTransitionAllowed(database, taskId, targetWorkspaceId);
        }
        const taskNumber = canAutoPlace && normalizedBucket === "workspace"
          ? taskNumberForRow(database, current, taskPrefix, this.now())
          : String(current.task_number ?? "");
        database.prepare(`
          UPDATE hub_board_tasks SET
            title = CASE WHEN presentation_source = 'manual' THEN title ELSE ? END,
            description = CASE WHEN presentation_source = 'manual' THEN description ELSE ? END,
            corrected_text = CASE WHEN presentation_source = 'manual' THEN corrected_text ELSE ? END,
            category = ?, triage_status = 'completed',
            triage_confidence = ?, triage_reason = ?, triage_error = NULL,
            bucket = ?, workspace_id = ?, task_number = ?, placement_source = ?, updated_at_ms = ?
          WHERE id = ?
        `).run(
          presentation.title,
          presentation.description,
          normalizedCorrectedText,
          normalizedCategory,
          numericConfidence,
          String(reason ?? "").trim().slice(0, 1000),
          canAutoPlace ? normalizedBucket : current.bucket,
          targetWorkspaceId,
          taskNumber,
          canAutoPlace ? "ai" : current.placement_source,
          this.now(),
          taskId,
        );
        const result = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  markTriageFailed(id, error) {
    return this.#withDatabase((database) => {
      this.#taskRow(database, id);
      database.prepare(`
        UPDATE hub_board_tasks
        SET triage_status = 'failed', triage_error = ?, updated_at_ms = ?
        WHERE id = ?
      `).run(String(error?.message ?? error ?? "Неизвестная ошибка").slice(0, 2000), this.now(), String(id));
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
    });
  }

  retryTriage(id) {
    return this.#withDatabase((database) => {
      this.#taskRow(database, id);
      database.prepare(`
        UPDATE hub_board_tasks
        SET triage_status = 'pending', triage_error = NULL,
          presentation_source = 'automatic', updated_at_ms = ?
        WHERE id = ?
      `).run(this.now(), String(id));
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
    });
  }

  move(id, { bucket, workspaceId = null, beforeId = null, taskPrefix = "" } = {}) {
    const normalizedBucket = normalizedTaskBucket(bucket);
    const normalizedWorkspaceId = normalizedBucket === "workspace"
      ? String(workspaceId ?? "").trim()
      : null;
    if (normalizedBucket === "workspace" && !normalizedWorkspaceId) throw new Error("Выберите Workspace");
    return this.#withDatabase((database) => {
      const taskId = String(id ?? "").trim();
      const current = this.#taskRow(database, taskId);
      const oldBucket = current.bucket;
      const oldWorkspaceId = current.workspace_id ?? null;
      database.exec("BEGIN IMMEDIATE");
      try {
        assertTaskChecklistWorkspaceTransitionAllowed(database, taskId, normalizedWorkspaceId);
        const taskNumber = normalizedBucket === "workspace"
          ? taskNumberForRow(database, current, taskPrefix, this.now())
          : String(current.task_number ?? "");
        database.prepare(`
          UPDATE hub_board_tasks
          SET bucket = ?, workspace_id = ?, stream_id = NULL,
            task_number = ?, placement_source = 'manual', updated_at_ms = ?
          WHERE id = ?
        `).run(normalizedBucket, normalizedWorkspaceId, taskNumber, this.now(), taskId);
        const targetIds = taskLocationRows(database, normalizedBucket, normalizedWorkspaceId)
          .map((row) => row.id)
          .filter((candidateId) => candidateId !== taskId);
        const normalizedBeforeId = String(beforeId ?? "").trim();
        const targetIndex = normalizedBeforeId ? targetIds.indexOf(normalizedBeforeId) : -1;
        targetIds.splice(targetIndex < 0 ? targetIds.length : targetIndex, 0, taskId);
        if (oldBucket !== normalizedBucket || oldWorkspaceId !== normalizedWorkspaceId) {
          writeTaskOrder(
            database,
            oldBucket,
            oldWorkspaceId,
            taskLocationRows(database, oldBucket, oldWorkspaceId).map((row) => row.id),
          );
        }
        writeTaskOrder(database, normalizedBucket, normalizedWorkspaceId, targetIds);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
    });
  }

  reassignWorkspace(sourceWorkspaceId, targetWorkspaceId, { taskPrefix = "" } = {}) {
    const sourceId = String(sourceWorkspaceId ?? "").trim();
    const targetId = String(targetWorkspaceId ?? "").trim();
    if (!sourceId || !targetId) throw new Error("Workspace не найден");
    if (sourceId === targetId) return 0;
    return this.#withDatabase((database) => {
      const allSourceIds = database.prepare(
        "SELECT id FROM hub_board_tasks WHERE workspace_id = ? ORDER BY id",
      ).all(sourceId).map((row) => row.id);
      for (const taskId of allSourceIds) this.#taskRow(database, taskId);
      const sourceIds = taskLocationRows(database, "workspace", sourceId).map((row) => row.id);
      const targetIds = taskLocationRows(database, "workspace", targetId).map((row) => row.id);
      database.exec("BEGIN IMMEDIATE");
      try {
        assertTaskChecklistWorkspaceReassignmentAllowed(database, sourceId, targetId);
        for (const taskId of allSourceIds) {
          assignTaskNumber(database, this.#taskRow(database, taskId), taskPrefix, this.now());
        }
        const result = database.prepare(`
          UPDATE hub_board_tasks
          SET workspace_id = ?, updated_at_ms = ?
          WHERE workspace_id = ?
        `).run(targetId, this.now(), sourceId);
        writeTaskOrder(database, "workspace", targetId, [...targetIds, ...sourceIds]);
        database.prepare("DELETE FROM hub_board_column_order WHERE column_id = ?").run(sourceId);
        database.prepare("DELETE FROM hub_board_workspace_order WHERE workspace_id = ?").run(sourceId);
        database.exec("COMMIT");
        return Number(result.changes);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  assignWorkspaceTaskNumbers(workspaceId, taskPrefix) {
    const targetWorkspaceId = String(workspaceId ?? "").trim();
    if (!targetWorkspaceId) throw new Error("Workspace не найден");
    return this.#withDatabase((database) => {
      const prefix = normalizedWorkspaceTaskPrefix(taskPrefix);
      if (!prefix) return 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        const rows = database.prepare(`
          SELECT * FROM hub_board_tasks WHERE workspace_id = ? AND task_number = '' ORDER BY created_at_ms, id
        `).all(targetWorkspaceId);
        const timestamp = this.now();
        for (const row of rows) assignTaskNumber(database, row, prefix, timestamp);
        database.exec("COMMIT");
        return rows.length;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  orderedColumnIds(workspaceIds) {
    return this.#withDatabase((database) => readColumnOrder(database, workspaceIds));
  }

  moveColumn(workspaceIds, { columnId, beforeColumnId = null } = {}) {
    const movedColumnId = String(columnId ?? "").trim();
    const targetColumnId = String(beforeColumnId ?? "").trim() || null;
    return this.#withDatabase((database) => {
      const ordered = ensureColumnOrder(database, workspaceIds, this.now());
      if (!ordered.includes(movedColumnId)) throw new Error("Колонка не найдена");
      if (targetColumnId && !ordered.includes(targetColumnId)) throw new Error("Колонка не найдена");
      const reordered = ordered.filter((id) => id !== movedColumnId);
      const targetIndex = targetColumnId ? reordered.indexOf(targetColumnId) : -1;
      reordered.splice(targetIndex < 0 ? reordered.length : targetIndex, 0, movedColumnId);
      const update = database.prepare(`
        UPDATE hub_board_column_order SET position = ?, updated_at_ms = ? WHERE column_id = ?
      `);
      database.exec("BEGIN IMMEDIATE");
      try {
        const timestamp = this.now();
        reordered.forEach((id, position) => update.run(position, timestamp, id));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return reordered;
    });
  }

  notesComment() {
    return this.#withDatabase((database) => String(database.prepare(
      "SELECT value FROM hub_board_settings WHERE key = 'notes_comment'",
    ).get()?.value ?? ""));
  }

  setNotesComment(comment) {
    const value = String(comment ?? "").trim().slice(0, 1000);
    this.#withDatabase((database) => database.prepare(`
      INSERT INTO hub_board_settings (key, value, updated_at_ms)
      VALUES ('notes_comment', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
    `).run(value, this.now()));
    return value;
  }

  prepareStart(id, {
    workspaceId, streamId, requestId, streamName = null, reassign = false, expectedRevision = null,
  } = {}) {
    const taskId = String(id);
    const normalizedRequestId = String(requestId ?? "").trim();
    if (!normalizedRequestId) throw new Error("Task launch request id is required");
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
      const current = this.#taskRow(database, taskId);
      if (expectedRevision != null && Number(expectedRevision) !== Number(current.row_revision)) {
        throw new Error("Task launch revision conflict");
      }
      const currentRequestId = String(current.start_request_id ?? "").trim();
      if (currentRequestId && currentRequestId !== normalizedRequestId && !reassign) {
        throw new Error("Task launch is already pending; retry it with the original request_id");
      }
      if (reassign && current.status !== "started") throw new Error("Переназначить можно только запущенную Task");
      if (!reassign && current.status === "started" && !currentRequestId) throw new Error("Task уже запущена");
      if (reassign && String(current.stream_id ?? "") === String(streamId)) {
        throw new Error("Task уже назначена этому Stream");
      }
      let changed = { changes: 0 };
      if (currentRequestId === normalizedRequestId) {
        const replay = taskFromRow(current);
        database.exec("COMMIT");
        return replay;
      } else if (reassign) {
        changed = database.prepare(`
          UPDATE hub_board_tasks
          SET start_request_id = ?, start_stream_name = ?, start_destination_stream_id = ?,
            start_effect_state = 'prepared', start_effect_owner_id = NULL, updated_at_ms = ?
          WHERE id = ? AND row_revision = ? AND status = 'started'
        `).run(
          normalizedRequestId, String(streamName ?? "").trim() || null, String(streamId),
          timestamp, taskId, current.row_revision,
        );
      } else if (!currentRequestId) {
        assertTaskChecklistWorkspaceTransitionAllowed(database, taskId, String(workspaceId));
        changed = database.prepare(`
          UPDATE hub_board_tasks
          SET bucket = 'workspace', status = 'starting', workspace_id = ?, stream_id = ?,
            placement_source = 'manual', start_request_id = ?, start_stream_name = ?,
            start_destination_stream_id = ?, start_effect_state = 'prepared', start_effect_owner_id = NULL,
            completed_at_ms = NULL, updated_at_ms = ?
          WHERE id = ? AND row_revision = ? AND start_request_id IS NULL
        `).run(
          String(workspaceId), String(streamId), normalizedRequestId,
          String(streamName ?? "").trim() || null, String(streamId), timestamp, taskId, current.row_revision,
        );
      }
      if (!Number(changed.changes)) throw new Error("Task launch ownership CAS failed");
      const result = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
      database.exec("COMMIT");
      return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  admitPreparedStart(id, { requestId, attemptId, expectedRevision } = {}) {
    const taskId = String(id);
    const normalizedRequestId = String(requestId ?? "").trim();
    const normalizedAttemptId = String(attemptId ?? "").trim();
    if (!normalizedRequestId) throw new Error("Task launch request id is required");
    if (!normalizedAttemptId) throw new Error("Task launch attempt id is required");
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#taskRow(database, taskId);
        if (Number(expectedRevision) !== Number(current.row_revision)) {
          throw new Error("Task launch effect admission revision conflict");
        }
        if (String(current.start_request_id ?? "") !== normalizedRequestId) {
          throw new Error("Task launch effect admission owner does not match the prepared request");
        }
        if (
          current.start_effect_state === "admitted"
          && current.start_effect_owner_id === normalizedAttemptId
        ) {
          database.exec("COMMIT");
          return taskFromRow(current);
        }
        if (current.start_effect_state !== "prepared") {
          throw new Error("Task launch effects are not available for admission");
        }
        const changed = database.prepare(`
          UPDATE hub_board_tasks
          SET start_effect_state = 'admitted', start_effect_owner_id = ?, updated_at_ms = ?
          WHERE id = ? AND row_revision = ? AND start_request_id = ? AND start_effect_state = 'prepared'
        `).run(
          normalizedAttemptId, this.now(), taskId, Number(expectedRevision), normalizedRequestId,
        );
        if (!Number(changed.changes)) throw new Error("Task launch effect admission CAS failed");
        const task = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
        database.exec("COMMIT");
        return task;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  fencePreparedStartCancellation(id, { requestId, cancellationRequestId, expectedRevision } = {}) {
    const taskId = String(id);
    const normalizedRequestId = String(requestId ?? "").trim();
    const normalizedCancellationId = String(cancellationRequestId ?? "").trim();
    if (!normalizedRequestId) throw new Error("Task launch request id is required");
    if (!normalizedCancellationId) throw new Error("Task launch cancellation request id is required");
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#taskRow(database, taskId);
        if (Number(expectedRevision) !== Number(current.row_revision)) {
          throw new Error("Task launch cancel revision conflict");
        }
        if (String(current.start_request_id ?? "") !== normalizedRequestId) {
          throw new Error("Task launch cancel owner does not match the prepared request");
        }
        if (current.start_effect_state === "cancelling") {
          database.exec("COMMIT");
          return taskFromRow(current);
        }
        if (current.start_effect_state !== "prepared") {
          throw new Error("Task launch effects were already admitted");
        }
        const changed = database.prepare(`
          UPDATE hub_board_tasks
          SET start_effect_state = 'cancelling', start_effect_owner_id = ?, updated_at_ms = ?
          WHERE id = ? AND row_revision = ? AND start_request_id = ? AND start_effect_state = 'prepared'
        `).run(
          normalizedCancellationId, this.now(), taskId, Number(expectedRevision), normalizedRequestId,
        );
        if (!Number(changed.changes)) throw new Error("Task launch cancellation fence CAS failed");
        const task = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
        database.exec("COMMIT");
        return task;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  completePreparedStartCancellation(id, { requestId, expectedRevision } = {}) {
    const taskId = String(id);
    const normalizedRequestId = String(requestId ?? "").trim();
    if (!normalizedRequestId) throw new Error("Task launch request id is required");
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#taskRow(database, taskId);
        if (Number(expectedRevision) !== Number(current.row_revision)) {
          throw new Error("Task launch cancel completion revision conflict");
        }
        if (
          String(current.start_request_id ?? "") !== normalizedRequestId
          || current.start_effect_state !== "cancelling"
        ) throw new Error("Task launch cancellation fence is not owned by the prepared request");
        const changed = database.prepare(`
          UPDATE hub_board_tasks
          SET status = 'open', stream_id = NULL, start_request_id = NULL, start_stream_name = NULL,
            start_destination_stream_id = NULL, start_effect_state = NULL, start_effect_owner_id = NULL,
            updated_at_ms = ?
          WHERE id = ? AND status = 'starting' AND row_revision = ?
            AND start_request_id = ? AND start_effect_state = 'cancelling'
        `).run(this.now(), taskId, Number(expectedRevision), normalizedRequestId);
        if (!Number(changed.changes)) throw new Error("Task launch cancel completion CAS failed");
        const task = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
        database.exec("COMMIT");
        return task;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  runMutation(operation, options = {}) {
    const authorities = captureClaimCustodySqlAuthorities(this.#database, options.method, options.args ?? []);
    return this.#mutations.run(() => {
      this.#custodyWriteAuthorities = authorities;
      try {
        const result = operation();
        if (result?.then) throw new TypeError("Task SQL mutation must remain synchronous");
        return result;
      } finally { this.#custodyWriteAuthorities = []; }
    }, options);
  }

  mutationDiagnostics() {
    return this.#mutations.diagnostics();
  }

  cancelPreparedStart(id, {
    requestId, reassign = false, expectedRevision = null, attemptId = null,
  } = {}) {
    const taskId = String(id);
    const normalizedRequestId = String(requestId ?? "").trim();
    if (!normalizedRequestId) throw new Error("Task launch request id is required");
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
      const current = this.#taskRow(database, taskId);
      if (expectedRevision != null && Number(expectedRevision) !== Number(current.row_revision)) {
        throw new Error("Task launch cancel revision conflict");
      }
      if (String(current.start_request_id ?? "") !== normalizedRequestId) {
        throw new Error("Task launch cancel owner does not match the prepared request");
      }
      if (
        String(current.start_effect_state ?? "") !== "admitted"
        || String(current.start_effect_owner_id ?? "") !== String(attemptId ?? "").trim()
      ) throw new Error("Task launch rollback does not own effect admission");
      let changed;
      if (reassign) {
        changed = database.prepare(`
          UPDATE hub_board_tasks
          SET start_request_id = NULL, start_stream_name = NULL, start_destination_stream_id = NULL,
            start_effect_state = NULL, start_effect_owner_id = NULL, updated_at_ms = ?
          WHERE id = ? AND status = 'started' AND start_request_id = ? AND row_revision = ?
        `).run(this.now(), taskId, normalizedRequestId, current.row_revision);
      } else {
        changed = database.prepare(`
          UPDATE hub_board_tasks
          SET status = 'open', stream_id = NULL, start_request_id = NULL, start_stream_name = NULL,
            start_destination_stream_id = NULL, start_effect_state = NULL, start_effect_owner_id = NULL,
            updated_at_ms = ?
          WHERE id = ? AND status = 'starting' AND start_request_id = ? AND row_revision = ?
        `).run(this.now(), taskId, normalizedRequestId, current.row_revision);
      }
      if (!Number(changed.changes)) throw new Error("Task launch cancel CAS failed");
      const task = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
      if (!task) throw new Error("Task не найден");
      database.exec("COMMIT");
      return task;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  markStarted(id, {
    workspaceId, streamId, requestId = null, expectedRevision = null, attemptId = null,
  } = {}) {
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
      const normalizedRequestId = String(requestId ?? "").trim();
      if (!normalizedRequestId) throw new Error("Task launch completion requires its exact request owner");
      const current = this.#taskRow(database, id);
      if (String(current.start_request_id ?? "") !== normalizedRequestId) {
        throw new Error("Task launch request does not match the prepared Task");
      }
      if (
        current.start_effect_state !== "admitted"
        || String(current.start_effect_owner_id ?? "") !== String(attemptId ?? "").trim()
      ) throw new Error("Task launch completion does not own effect admission");
      if (!Number.isInteger(Number(expectedRevision)) || Number(current.row_revision) !== Number(expectedRevision)) {
        throw new Error("Task launch completion revision CAS failed");
      }
      if (!['starting', 'started'].includes(String(current.status))) {
        throw new Error("Task launch completion state does not match a prepared Task");
      }
      if (String(current.workspace_id ?? "") !== String(workspaceId)
          || String(current.start_destination_stream_id ?? "") !== String(streamId)) {
        throw new Error("Task launch completion owner does not match its prepared destination");
      }
      assertTaskChecklistWorkspaceTransitionAllowed(database, String(id), String(workspaceId));
      const changed = database.prepare(`
        UPDATE hub_board_tasks
        SET bucket = 'workspace', status = 'started', workspace_id = ?, stream_id = ?,
          workflow_status = CASE WHEN workflow_status IN ('testing', 'awaiting_implementation', 'blocked') THEN workflow_status ELSE 'in_progress' END, placement_source = 'manual',
          started_at_ms = COALESCE(started_at_ms, ?),
          completed_at_ms = NULL, start_effect_state = 'completed', start_effect_owner_id = NULL,
          updated_at_ms = ?
        WHERE id = ? AND row_revision = ? AND start_request_id = ?
          AND status IN ('starting', 'started') AND workspace_id = ? AND start_destination_stream_id = ?
          AND start_effect_state = 'admitted' AND start_effect_owner_id = ?
      `).run(
        String(workspaceId), String(streamId), timestamp, timestamp, String(id),
        Number(expectedRevision), normalizedRequestId, String(workspaceId), String(streamId),
        String(attemptId ?? "").trim(),
      );
      if (!Number(changed.changes)) throw new Error("Task launch completion CAS changed no rows");
      const task = this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)),
      );
      if (!task) throw new Error("Task не найден");
      database.exec("COMMIT");
      return task;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  complete(id) {
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      this.#taskRow(database, id);
      database.prepare(`
        UPDATE hub_board_tasks
        SET status = 'done', completed_at_ms = ?, updated_at_ms = ? WHERE id = ?
      `).run(timestamp, timestamp, String(id));
      const task = this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)),
      );
      if (!task) throw new Error("Task не найден");
      return task;
    });
  }

  setWorkflowStatus(id, status) {
    const workflowStatus = normalizedTaskWorkflowStatus(status);
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      const taskId = String(id);
      const current = this.#taskRow(database, taskId);
      const lifecycleStatus = current.status === "done"
        ? (current.stream_id ? "started" : "open")
        : current.status;
      if (workflowStatus !== "awaiting_implementation") {
        database.prepare(`
          UPDATE hub_task_turn_bindings SET requested_workflow_status = NULL
          WHERE task_id = ? AND requested_workflow_status IS NOT NULL
        `).run(taskId);
      }
      database.prepare(`
        UPDATE hub_board_tasks
        SET status = ?, workflow_status = ?, completed_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(lifecycleStatus, workflowStatus, timestamp, taskId);
      return this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId),
      );
    });
  }

  claim(id, {
    workspaceId, streamId, provider, threadId, turnId, operationId,
    operationKind = "claim", gitBaseline = null, forwardCustodyRequestId = null, validateClaimAdmission = null,
  } = {}) {
    const taskId = String(id ?? "").trim();
    const identity = [provider, threadId, turnId, operationId].map((value) => String(value ?? "").trim());
    const kind = String(operationKind ?? "claim").trim();
    if (!taskId || identity.some((value) => !value)) {
      throw new Error("Task claim requires an exact provider operation");
    }
    if (kind !== "claim") throw new Error("invalid Task operation kind");
    const baselineJson = gitBaselineJson(gitBaseline);
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
      if (validateClaimAdmission != null) {
        if (typeof validateClaimAdmission !== "function" || validateClaimAdmission()?.then) throw new TypeError("Claim admission validator must be synchronous");
      }
      const current = this.#taskRow(database, taskId);
      if (current.status === "done") throw new Error("Closed Tasks are an archive; claim an open Task");
      if (String(current.workspace_id ?? "") !== String(workspaceId ?? "")) {
        throw new Error("Task is outside the current Workspace");
      }
      if (current.status === "starting" && String(current.start_request_id ?? "").trim()) {
        throw new Error("prepared Task launch must be cancelled before claim");
      }
      const claimReceiptTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hub_mcp_operations'").get();
      if (claimReceiptTable && database.prepare(`
        SELECT 1 FROM hub_mcp_operations WHERE request_id = ?
          AND (json_extract(result_json, '$.evidence.kind') IN ('task-claim-executor-busy-v1', 'task-claim-lock-admission-v1')
            OR json_extract(result_json, '$.operatorReconciliation.evidence.kind') IN ('task-claim-executor-busy-v1', 'task-claim-lock-admission-v1'))
      `).get(String(operationId))) throw new Error("Task claim was durably refused before admission");
      if (readClaimCustodyFence(database, "original", operationId)) throw new TaskClaimContinuationWithdrawnError();
      const reservation = readClaimCustodyFence(database, "task", taskId);
      if (reservation && (reservation.requestId !== forwardCustodyRequestId
          || reservation.successorClaimRequestId !== operationId)) throw new TaskClaimCustodyRejectedError("Task is reserved by a forward custody fence");
      if (forwardCustodyRequestId) {
        const raw = database.prepare("SELECT * FROM hub_mcp_operations WHERE request_id = ?").get(forwardCustodyRequestId);
        const fence = raw && claimCustodyState({ requestId: raw.request_id, workspaceId: raw.workspace_id,
          streamId: raw.stream_id, threadId: raw.provider_thread_id, provider: raw.provider, toolName: raw.tool_name,
          argumentsHash: raw.arguments_hash, claimCustody: JSON.parse(raw.claim_custody_json ?? "null") });
        if (!fence || fence.phase !== "fenced" || fence.taskId !== taskId || fence.workspaceId !== workspaceId
            || fence.successorClaimRequestId !== operationId || fence.original.provider !== provider
            || fence.original.threadId !== threadId || fence.original.streamId !== streamId
            || Number(current.row_revision) !== fence.taskRevision || current.stream_id !== fence.envelope.expected_owner_stream_id) {
          throw new TaskClaimCustodyRejectedError("Custody assignment identity or Task CAS differs");
        }
        const intake = database.prepare("SELECT * FROM hub_mcp_operations WHERE request_id = ?").get(operationId);
        if (!intake || intake.tool_name !== "hub_task_claim" || intake.workspace_id !== workspaceId || intake.stream_id !== streamId
            || intake.provider !== provider || intake.provider_thread_id !== threadId || intake.arguments_hash !== fence.successorArgumentsHash
            || intake.status !== "pending" || !["pending", "unknown"].includes(intake.receipt_state)) throw new TaskClaimCustodyRejectedError("Custody successor intake differs");
        if (baselineJson !== gitBaselineJson(fence.namespace?.workspace?.gitBaseline ?? fence.source.gitBaseline)) throw new TaskClaimCustodyRejectedError("Custody baseline differs");
      }
      const bound = database.prepare(`
        SELECT * FROM hub_task_turn_bindings
        WHERE provider = ? AND provider_thread_id = ? AND turn_id = ? AND operation_id = ?
      `).get(...identity);
      if (bound && bound.task_id !== taskId) throw new Error("provider operation is already claimed by another Task");
      if (bound && bound.operation_kind !== kind) throw new Error("provider operation kind conflicts with its Task binding");
      if (bound?.task_id === taskId) {
        if (baselineJson !== "{}") {
          database.prepare(`
            UPDATE hub_task_turn_bindings SET baseline_json = ?
            WHERE provider = ? AND provider_thread_id = ? AND turn_id = ?
              AND operation_id = ? AND baseline_json = '{}'
          `).run(baselineJson, ...identity);
        }
        const result = this.#taskWithRelease(database, current);
        database.exec("COMMIT");
        return result;
      }
      const active = database.prepare(`
        SELECT * FROM hub_task_turn_bindings
        WHERE provider = ? AND provider_thread_id = ? AND turn_id = ? AND terminal_at_ms IS NULL
      `).get(...identity.slice(0, 3));
      if (active) database.prepare(`
        UPDATE hub_task_turn_bindings SET terminal_at_ms = ?
        WHERE provider = ? AND provider_thread_id = ? AND turn_id = ?
          AND operation_id = ? AND terminal_at_ms IS NULL
      `).run(timestamp, active.provider, active.provider_thread_id, active.turn_id, active.operation_id);
      database.prepare(`
        INSERT INTO hub_task_turn_bindings (
          task_id, provider, provider_thread_id, turn_id, operation_id, operation_kind,
          baseline_json, claimed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(taskId, ...identity, kind, baselineJson, timestamp);
      assertTaskChecklistWorkspaceTransitionAllowed(database, taskId, String(workspaceId));
      database.prepare(`
        UPDATE hub_board_tasks SET bucket = 'workspace', status = 'started', workflow_status = CASE WHEN workflow_status IN ('testing', 'awaiting_implementation', 'blocked') THEN workflow_status ELSE 'in_progress' END,
          workspace_id = ?, stream_id = ?, placement_source = 'manual',
          started_at_ms = COALESCE(started_at_ms, ?), completed_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(String(workspaceId), String(streamId), timestamp, timestamp, taskId);
      const result = this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId),
      );
      database.exec("COMMIT");
      return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  claimedTaskForTurn({ provider, threadId, turnId, operationId = null } = {}) {
    const identity = [provider, threadId, turnId].map((value) => String(value ?? "").trim());
    const operation = String(operationId ?? "").trim();
    if (identity.some((value) => !value)) return null;
    return this.#withDatabase((database) => {
      const row = database.prepare(`
        SELECT task.*, binding.baseline_json, binding.requested_workflow_status,
          binding.operation_id, binding.operation_kind
        FROM hub_task_turn_bindings binding
        JOIN hub_board_tasks task ON task.id = binding.task_id
        WHERE binding.provider = ? AND binding.provider_thread_id = ? AND binding.turn_id = ?
          AND (? = '' OR binding.operation_id = ?)
        ORDER BY (binding.terminal_at_ms IS NULL) DESC, binding.claimed_at_ms DESC,
          binding.operation_id DESC
        LIMIT 1
      `).get(...identity, operation, operation);
      if (!row) return null;
      let gitBaseline = null;
      try { gitBaseline = JSON.parse(String(row.baseline_json ?? "{}")); } catch { gitBaseline = null; }
      return {
        ...this.#taskWithRelease(database, row),
        gitBaseline,
        operationId: row.operation_id,
        operationKind: row.operation_kind,
        requestedWorkflowStatus: row.requested_workflow_status ?? null,
      };
    });
  }

  claimBindingForOperation(operationId) {
    const operation = String(operationId ?? "").trim();
    if (!operation) return null;
    return this.#withDatabase((database) => {
      const rows = database.prepare(`
        SELECT binding.task_id, task.workspace_id, binding.provider,
          binding.provider_thread_id, binding.turn_id, binding.operation_id,
          binding.operation_kind, binding.claimed_at_ms
        FROM hub_task_turn_bindings binding
        JOIN hub_board_tasks task ON task.id = binding.task_id
        WHERE binding.operation_id = ?
        ORDER BY binding.claimed_at_ms, binding.task_id
      `).all(operation);
      if (rows.length > 1) throw new Error("Task claim operation binding is ambiguous");
      const row = rows[0];
      return row ? {
        taskId: row.task_id,
        workspaceId: row.workspace_id,
        provider: row.provider,
        threadId: row.provider_thread_id,
        turnId: row.turn_id,
        operationId: row.operation_id,
        operationKind: row.operation_kind,
        claimedAtMs: row.claimed_at_ms,
      } : null;
    });
  }

  requestWorkflowStatus(id, {
    status, provider, threadId, turnId, operationId, expectedRevision = null, expectedStatus = null,
  } = {}) {
    const workflowStatus = normalizedTaskWorkflowStatus(status);
    const identity = [provider, threadId, turnId, operationId].map((value) => String(value ?? "").trim());
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const taskId = String(id);
        const current = this.#taskRow(database, taskId);
        if (expectedRevision != null && Number(current.row_revision) !== Number(expectedRevision)) {
          throw new Error("Task revision changed during workflow transition");
        }
        if (expectedStatus != null && current.workflow_status !== normalizedTaskWorkflowStatus(expectedStatus)) {
          throw new Error("Task workflow status changed during workflow transition");
        }
        const lifecycleStatus = current.status === "done"
          ? (current.stream_id ? "started" : "open")
          : current.status;
        if (workflowStatus !== "awaiting_implementation") {
          database.prepare(`
            UPDATE hub_task_turn_bindings SET requested_workflow_status = NULL
            WHERE task_id = ? AND requested_workflow_status IS NOT NULL
          `).run(taskId);
        }
        database.prepare(`
          UPDATE hub_board_tasks
          SET status = ?, workflow_status = ?, completed_at_ms = NULL, updated_at_ms = ?,
            row_revision = row_revision + 1
          WHERE id = ?
        `).run(lifecycleStatus, workflowStatus, timestamp, taskId);
        if (workflowStatus === "awaiting_implementation") {
        if (!identity.some((value) => !value)) {
          const binding = database.prepare(`
            SELECT task_id FROM hub_task_turn_bindings
            WHERE provider = ? AND provider_thread_id = ? AND turn_id = ? AND operation_id = ?
          `).get(...identity);
          if (binding?.task_id === String(id)) {
            database.prepare(`
              UPDATE hub_task_turn_bindings SET requested_workflow_status = 'awaiting_implementation'
              WHERE provider = ? AND provider_thread_id = ? AND turn_id = ? AND operation_id = ?
            `).run(...identity);
          }
        }
        }
        const task = this.#taskWithRelease(database, this.#taskRow(database, taskId));
        database.exec("COMMIT");
        return task;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  #selectedAbsorptionPriorResults(database, tasks, handoffTime) {
    const priorResults = [];
    for (const task of tasks) {
      const refs = task.gitReferences ?? [];
      if (!refs.length) continue;
      if (refs.length !== 1) throw selectedCompositionRequiredError("absorbed prior result repository is ambiguous");
      const ref = refs[0];
      const returnedRow = database.prepare(`SELECT operation_id, result_json, completed_at_ms
        FROM hub_task_lifecycle_outcomes WHERE task_id = ? AND kind = 'workflow'
          AND json_extract(result_json, '$.evidence.outcome') = 'returned_for_correction'
        ORDER BY completed_at_ms DESC, operation_id DESC LIMIT 1`).get(task.id);
      const returned = returnedRow ? JSON.parse(returnedRow.result_json) : null;
      const matches = value => value?.id === task.id && value.workspaceId === task.workspaceId
        && value.gitReferences?.length === 1 && value.gitReferences[0].resultCommit === ref.resultCommit
        && sameResolvedPath(value.gitReferences[0].projectRoot, ref.projectRoot);
      if (!returned || !matches(returned.task) || !matches(returned.priorTask)
          || !["testing", "awaiting_implementation"].includes(returned.priorTask.workflowStatus)
          || !["in_progress", "new", "blocked"].includes(returned.task.workflowStatus)
          || returned.task.revision !== returned.priorTask.revision + 1 || returned.task.revision > task.revision
          || returned.evidence.acceptedResult?.resultCommit !== ref.resultCommit
          || !sameResolvedPath(returned.evidence.acceptedResult?.projectRoot, ref.projectRoot)
          || returned.evidence.acceptedResult?.taskRevision !== returned.priorTask.revision
          || returned.evidence.response?.acceptedResultPreserved !== true || returnedRow.completed_at_ms > handoffTime) {
        throw selectedCompositionRequiredError("absorbed prior result has no exact normal return receipt");
      }
      const testedRows = database.prepare(`SELECT operation_id, result_json FROM hub_task_lifecycle_outcomes
        WHERE task_id = ? AND kind = 'workflow'
          AND json_extract(result_json, '$.task.workflowStatus') = 'testing'
          AND json_extract(result_json, '$.evidence.resultCommit') = ?
          AND json_extract(result_json, '$.task.revision') <= ? AND completed_at_ms <= ?
        ORDER BY completed_at_ms DESC, operation_id DESC LIMIT 65`).all(task.id, ref.resultCommit,
          returned.priorTask.revision, returnedRow.completed_at_ms);
      if (testedRows.length > 64) throw selectedCompositionRequiredError("absorbed prior Test history exceeds bounded lookup");
      const testedRow = testedRows.find(row => matches(JSON.parse(row.result_json).task));
      const tested = testedRow ? JSON.parse(testedRow.result_json) : null;
      if (!tested || !/^[0-9a-f]{40}$/u.test(tested.evidence.devHeadCommit ?? "")) {
        throw selectedCompositionRequiredError("absorbed prior result has no exact successful Test receipt");
      }
      if (tested.evidence.selectedCompositionRequired || tested.evidence.selectedComposition) {
        selectedCompositionFields({ taskId: task.id, resultCommit: ref.resultCommit,
          selectedCompositionRequired: true, selectedComposition: tested.evidence.selectedComposition });
      }
      priorResults.push({ taskId: task.id, projectRoot: ref.projectRoot, resultCommit: ref.resultCommit,
        testOperationId: testedRow.operation_id, returnOperationId: returnedRow.operation_id,
        testRevision: tested.task.revision, returnRevision: returned.task.revision,
        testOutcomeHash: createHash("sha256").update(testedRow.result_json).digest("hex"),
        returnOutcomeHash: createHash("sha256").update(returnedRow.result_json).digest("hex") });
    }
    return priorResults;
  }

  returnedNativeTestPriorResult(taskId) {
    return this.#withDatabase(database => {
      const task = this.#taskWithRelease(database, this.#taskRow(database, taskId));
      const [prior] = this.#selectedAbsorptionPriorResults(database, [task], this.now());
      if (!prior) throw new Error("Returned native Test has no exact normal return result");
      return prior;
    });
  }

  #assertAbsorptionPriorOutcomes(database, input) {
    for (const prior of normalizedSelectedAbsorption(input)?.priorResults ?? []) {
      for (const [operationId, hash] of [[prior.testOperationId, prior.testOutcomeHash],
        [prior.returnOperationId, prior.returnOutcomeHash]]) {
        const row = database.prepare(`SELECT result_json FROM hub_task_lifecycle_outcomes
          WHERE operation_id = ? AND task_id = ? AND kind = 'workflow'`).get(operationId, prior.taskId);
        if (!row || createHash("sha256").update(row.result_json).digest("hex") !== hash) {
          throw selectedCompositionRequiredError("absorbed immutable prior outcome changed");
        }
      }
    }
  }

  #assertSelectedAbsorptionState(database, { binding, survivorTaskId, operationId = null, bindPriorResults = false }) {
    let input = normalizedSelectedAbsorption(binding);
    const { declaration: d } = selectedAbsorptionHandoff({ requestId: input.requestId, text: input.text });
    const source = this.#taskWithRelease(database, this.#taskRow(database, d.sourceTaskId));
    const survivor = this.#taskWithRelease(database, this.#taskRow(database, survivorTaskId));
    const priorResults = this.#selectedAbsorptionPriorResults(database, [source, survivor], input.createdAtMs);
    if (bindPriorResults && !input.priorResults && priorResults.length) {
      input = normalizedSelectedAbsorption({ ...input, priorResults });
    } else if (JSON.stringify(input.priorResults ?? []) !== JSON.stringify(priorResults)) {
      throw selectedCompositionRequiredError("absorbed original prior result identity changed");
    }
    assertSelectedAbsorptionTasks(input, source, survivor);
    const receipt = database.prepare("SELECT * FROM hub_mcp_operations WHERE request_id = ?").get(input.requestId);
    const result = receipt?.result_json ? JSON.parse(receipt.result_json) : null;
    if (receipt?.receipt_state !== "succeeded" || receipt.tool_name !== "hub_stream_message_send"
        || receipt.workspace_id !== input.origin.workspaceId || receipt.stream_id !== input.origin.streamId
        || receipt.provider !== input.origin.provider || receipt.provider_thread_id !== input.origin.sourceThreadId
        || receipt.interstream_content_hash !== input.contentHash || receipt.created_at_ms !== input.createdAtMs
        || result?.delivery?.accepted !== true || result.target?.streamId !== survivor.streamId) {
      throw selectedCompositionRequiredError("durable absorbed handoff receipt changed");
    }
    const reopened = database.prepare(`SELECT 1 FROM hub_task_turn_bindings
      WHERE task_id = ? AND claimed_at_ms >= ? LIMIT 1`).get(source.id, input.createdAtMs);
    const active = database.prepare(`SELECT operation_id FROM hub_task_lifecycle_transitions
      WHERE phase IN ('pending_git', 'cleanup') AND operation_id != ? AND (
        task_id IN (?, ?) OR json_extract(evidence_json, '$.squashTransfer.source.taskId') IN (?, ?)
        OR json_extract(json_extract(evidence_json, '$.selectedComposition.absorptionInput.text'), '$.sourceTaskId') IN (?, ?)
        OR json_extract(json_extract(evidence_json, '$.nativeAbsorptionInput.text'), '$.sourceTaskId') IN (?, ?)
      ) LIMIT 1`).get(operationId ?? "", source.id, survivor.id, source.id, survivor.id, source.id, survivor.id, source.id, survivor.id);
    if (reopened || active) throw selectedCompositionRequiredError("absorbed source reopened or has a competing transition");
    return input;
  }

  assertSelectedAbsorptionState(options) {
    return this.#withDatabase((database) => this.#assertSelectedAbsorptionState(database, options));
  }

  #assertNativeAbsorptionHistory(database, history, taskId) {
    const proof = selectedCompositionFields({ taskId, resultCommit: history?.taskCommit,
      selectedComposition: history }).selectedComposition;
    if (proof?.kind !== "native-task-integration-v1" || proof.absorptionHistory) {
      throw selectedCompositionRequiredError("native accepted absorption root missing");
    }
    const row = database.prepare(`SELECT result_json FROM hub_task_lifecycle_outcomes
      WHERE operation_id = ? AND task_id = ? AND kind = 'workflow'`).get(proof.operationId, taskId);
    const outcome = row?.result_json ? JSON.parse(row.result_json) : null;
    if (outcome?.task?.workflowStatus !== "testing" || outcome.evidence?.selectedCompositionRequired !== true
        || outcome.evidence?.resultCommit !== proof.taskCommit
        || outcome.evidence?.devHeadCommit !== proof.proofCommit
        || JSON.stringify(outcome.evidence?.selectedComposition) !== JSON.stringify(proof)
        || !(outcome.task.gitReferences ?? []).some(ref => ref.resultCommit === proof.taskCommit
          && sameResolvedPath(ref.projectRoot, proof.repositoryRoot))) {
      throw selectedCompositionRequiredError("native accepted absorption outcome changed");
    }
    return proof;
  }

  #assertInitialNativeTestContext(database, current, evidence) {
    normalizedInitialNativeTest(evidence.identity);
    const { authority, projectRoot } = evidence;
    const workspace = database.prepare("SELECT id, settings_json FROM hub_workspaces WHERE id = ?").get(authority.workspaceId);
    const stream = database.prepare("SELECT id, workspace_id, settings_json FROM hub_streams WHERE id = ?").get(authority.streamId);
    const thread = database.prepare(`SELECT provider, provider_thread_id FROM hub_threads
      WHERE stream_id = ? AND detached_at_ms IS NULL ORDER BY position DESC LIMIT 1`).get(authority.streamId);
    const refs = database.prepare("SELECT COUNT(*) AS count FROM hub_task_git_references WHERE task_id = ?").get(current.id);
    const returned = evidence.identity.returnedResultCommit;
    if (returned) {
      const task = this.#taskWithRelease(database, current);
      const [prior] = this.#selectedAbsorptionPriorResults(database, [task], this.now());
      if (Number(refs.count) !== 1 || prior?.resultCommit !== returned
          || !sameResolvedPath(prior.projectRoot, projectRoot)
          || JSON.stringify(prior) !== JSON.stringify(evidence.priorResult)) {
        throw new Error("Returned native Test original prior result or outcome changed");
      }
    } else if (evidence.priorResult) throw new Error("Initial native Test cannot bind a prior result");
    const root = workspace && stream ? taskProjectRoot({
      workspace: { settings: parsedSettings(workspace.settings_json) },
      stream: { settings: parsedSettings(stream.settings_json) },
    }) : null;
    if (current.id !== evidence.taskId || Number(current.row_revision) !== evidence.taskRevision
        || current.workflow_status !== "in_progress" || current.status !== "started" || (!returned && Number(refs.count))
        || current.workspace_id !== authority.workspaceId || current.stream_id !== authority.streamId
        || stream?.workspace_id !== workspace?.id || !root || !sameResolvedPath(root, projectRoot)
        || parsedSettings(workspace.settings_json).releaseWorkflowEnabled !== true
        || thread?.provider !== authority.provider || thread?.provider_thread_id !== authority.threadId) {
      throw new Error("Initial native Test current SQL caller, assignment, Task or repository changed");
    }
  }

  beginLifecycleTransition(id, {
    operationId, kind = "workflow", targetWorkflowStatus = null, expectedRevision, evidence = null,
    releaseContext = null,
  } = {}) {
    const taskId = String(id ?? "").trim();
    const operation = String(operationId ?? "").trim();
    if (!operation) throw new Error("Task lifecycle operation id is required");
    const normalizedKind = String(kind ?? "workflow");
    const target = targetWorkflowStatus == null ? null : normalizedTaskWorkflowStatus(targetWorkflowStatus);
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (database.prepare("SELECT 1 FROM hub_task_lifecycle_outcomes WHERE operation_id = ?").get(operation)) {
          throw new Error("Task lifecycle operation already has a terminal outcome");
        }
        const current = this.#taskRow(database, taskId);
        const revision = Number(expectedRevision);
        if (!Number.isInteger(revision) || revision !== Number(current.row_revision)) {
          throw new Error("Task lifecycle revision conflict; read the Task and retry with a new request_id");
        }
        const existing = database.prepare(
          "SELECT * FROM hub_task_lifecycle_transitions WHERE operation_id = ?",
        ).get(operation);
        if (existing) {
          if (existing.task_id !== taskId || existing.kind !== normalizedKind
              || Number(existing.expected_task_revision) !== revision) {
            throw new Error("Task lifecycle operation id was already used for another transition");
          }
          const existingTransfer = JSON.parse(existing.evidence_json ?? "{}")?.squashTransfer;
          const existingCutover = JSON.parse(existing.evidence_json ?? "{}")?.squashCutover;
          const existingAbsorbed = JSON.parse(existing.evidence_json ?? "{}")?.absorbedInto;
          if (JSON.stringify(JSON.parse(existing.evidence_json ?? "{}")?.nativeAbsorptionInput ?? null)
              !== JSON.stringify(evidence?.nativeAbsorptionInput ?? null)) {
            throw new Error("Task lifecycle original native absorption changed");
          }
          if (JSON.stringify(JSON.parse(existing.evidence_json ?? "{}")?.nativeAbsorptionHistory ?? null)
              !== JSON.stringify(evidence?.nativeAbsorptionHistory ?? null)) {
            throw new Error("Task lifecycle original native absorption history changed");
          }
          if (JSON.stringify(JSON.parse(existing.evidence_json ?? "{}")?.selectedComposition ?? null)
              !== JSON.stringify(evidence?.selectedComposition ?? null)) {
            throw new Error("Task lifecycle operation id was already used for another selected composition");
          }
          if (Boolean(existingTransfer) !== Boolean(evidence?.squashTransfer)
              || (existingTransfer && normalizedTaskSquashTransfer(existingTransfer).transferHash
                !== normalizedTaskSquashTransfer(evidence.squashTransfer).transferHash)) {
            throw new Error("Task lifecycle operation id was already used for another squash transfer");
          }
          if (Boolean(existingCutover) !== Boolean(evidence?.squashCutover)
              || (existingCutover && normalizedTaskSquashCutover(existingCutover).cutoverHash
                !== normalizedTaskSquashCutover(evidence.squashCutover).cutoverHash)) {
            throw new Error("Task lifecycle operation id was already used for another squash cutover");
          }
          if (JSON.stringify(JSON.parse(existing.evidence_json ?? "{}")?.initialNativeTest ?? null)
              !== JSON.stringify(evidence?.initialNativeTest ?? null)) throw new Error("Initial native Test lifecycle binding changed");
          if (JSON.stringify(existingAbsorbed ?? null) !== JSON.stringify(evidence?.absorbedInto ?? null)) {
            throw new Error("Task lifecycle operation id was already used for another absorption");
          }
          database.exec("COMMIT");
          return { task: this.#taskWithRelease(database, current), replayed: true, phase: existing.phase };
        }
        if (evidence?.initialNativeTest) this.#assertInitialNativeTestContext(database, current, evidence.initialNativeTest);
        if (releaseContext) {
          const workspaceId = String(releaseContext.workspaceId ?? "").trim();
          const streamId = String(releaseContext.streamId ?? "").trim();
          const rootText = String(releaseContext.projectRoot ?? "").trim();
          const expectedRoot = rootText ? path.resolve(rootText) : null;
          const workspace = database.prepare(
            "SELECT id, settings_json FROM hub_workspaces WHERE id = ?",
          ).get(workspaceId);
          const stream = streamId ? database.prepare(
            "SELECT id, workspace_id, settings_json FROM hub_streams WHERE id = ?",
          ).get(streamId) : null;
          const currentRoot = workspace ? taskProjectRoot({
            workspace: { id: workspace.id, settings: parsedSettings(workspace.settings_json) },
            stream: stream ? { id: stream.id, settings: parsedSettings(stream.settings_json) } : null,
          }) : null;
          const sourceContext = releaseContext.source ?? null;
          const sourceTaskId = String(sourceContext?.taskId ?? "").trim();
          const sourceTask = sourceContext ? database.prepare(
            "SELECT * FROM hub_board_tasks WHERE id = ?",
          ).get(sourceTaskId) : null;
          const sourceStream = sourceTask?.stream_id ? database.prepare(
            "SELECT id, workspace_id, settings_json FROM hub_streams WHERE id = ?",
          ).get(sourceTask.stream_id) : null;
          const sourceRoot = sourceTask && workspace ? taskProjectRoot({
            workspace: { id: workspace.id, settings: parsedSettings(workspace.settings_json) },
            stream: sourceStream ? { id: sourceStream.id, settings: parsedSettings(sourceStream.settings_json) } : null,
          }) : null;
          const sourceReferences = sourceTask ? database.prepare(`
            SELECT project_root, result_commit FROM hub_task_git_references WHERE task_id = ?
          `).all(sourceTaskId).filter((reference) => sameResolvedPath(reference.project_root, expectedRoot)) : [];
          const sourceMatches = !sourceContext || (
            sourceTask
            && sourceTaskId !== taskId
            && Number(sourceTask.row_revision) === Number(sourceContext.revision)
            && sourceTask.workflow_status === String(sourceContext.workflowStatus ?? "")
            && sourceTask.workflow_status === "testing"
            && String(sourceTask.workspace_id ?? "") === workspaceId
            && sourceStream
            && String(sourceStream.workspace_id ?? "") === workspaceId
            && sourceRoot
            && sameResolvedPath(sourceRoot, expectedRoot)
            && sameResolvedPath(sourceContext.projectRoot, expectedRoot)
            && sourceReferences.length === 1
            && String(sourceReferences[0].result_commit ?? "").trim().toLowerCase()
              === String(sourceContext.resultCommit ?? "").trim().toLowerCase()
          );
          if (String(current.workspace_id ?? "") !== workspaceId
              || String(current.stream_id ?? "") !== streamId
              || !workspace
              || (streamId && (!stream || String(stream.workspace_id ?? "") !== workspaceId))
              || parsedSettings(workspace.settings_json).releaseWorkflowEnabled !== true
              || !expectedRoot
              || !currentRoot
              || !sourceMatches
              || !sameResolvedPath(currentRoot, expectedRoot)) {
            throw new Error("Task release context changed during lifecycle transition");
          }
        }
        const squashTransfer = evidence?.squashTransfer
          ? normalizedTaskSquashTransfer(evidence.squashTransfer)
          : null;
        const absorptionInput = evidence?.nativeAbsorptionInput ?? evidence?.selectedComposition?.absorptionInput;
        if (evidence?.nativeAbsorptionHistory) {
          if (absorptionInput || normalizedKind !== "workflow" || target !== "testing") {
            throw selectedCompositionRequiredError("native accepted history requires ordinary Test");
          }
          this.#assertNativeAbsorptionHistory(database, evidence.nativeAbsorptionHistory, taskId);
        }
        if (absorptionInput) {
          if (normalizedKind !== "workflow" || target !== "testing") {
            throw selectedCompositionRequiredError("absorbed proof requires an exact Test transition");
          }
          this.#assertSelectedAbsorptionState(database, { binding: absorptionInput, survivorTaskId: taskId });
        }
        const squashCutover = evidence?.squashCutover
          ? normalizedTaskSquashCutover(evidence.squashCutover)
          : null;
        if (squashTransfer) {
          if (Boolean(squashCutover) && squashCutover.squashTransfer.transferHash !== squashTransfer.transferHash) {
            throw new Error("Task squash cutover and transfer evidence do not match");
          }
          const expectedSurvivorStatus = squashCutover ? "in_progress" : "testing";
          if (normalizedKind !== "workflow" || target !== "testing"
              || squashTransfer.survivor.taskId !== taskId
              || squashTransfer.survivor.revision !== revision
              || squashTransfer.authority.workspaceId !== String(current.workspace_id ?? "")
              || current.workflow_status !== expectedSurvivorStatus) {
            throw new Error("Task squash transfer survivor identity changed");
          }
          const source = this.#taskRow(database, squashTransfer.source.taskId);
          const sourceReferences = database.prepare(`
            SELECT project_root, branch, result_commit FROM hub_task_git_references WHERE task_id = ?
          `).all(source.id);
          const survivorReferences = database.prepare(`
            SELECT project_root, branch, result_commit FROM hub_task_git_references WHERE task_id = ?
          `).all(taskId);
          if (source.workflow_status !== "testing"
              || source.workspace_id !== current.workspace_id
              || Number(source.row_revision) !== squashTransfer.source.revision
              || Number(source.release_revision) !== squashTransfer.source.releaseRevision
              || Number(current.release_revision) !== squashTransfer.survivor.releaseRevision
              || sourceReferences.length !== 1 || survivorReferences.length !== 1
              || !sameResolvedPath(sourceReferences[0].project_root, squashTransfer.projectRoot)
              || !sameResolvedPath(survivorReferences[0].project_root, squashTransfer.projectRoot)
              || sourceReferences[0].result_commit !== squashTransfer.source.resultCommit
              || sourceReferences[0].branch !== squashTransfer.source.branch
              || survivorReferences[0].result_commit !== squashTransfer.previousResultCommit
              || survivorReferences[0].branch !== squashTransfer.survivor.branch) {
            throw new Error("Task squash transfer source, survivor or Test results changed");
          }
        }
        const active = database.prepare(`
          SELECT operation_id FROM hub_task_lifecycle_transitions
          WHERE phase IN ('pending_git', 'cleanup') AND (
            task_id = ? OR json_extract(evidence_json, '$.squashTransfer.source.taskId') = ?
            OR json_extract(json_extract(evidence_json, '$.selectedComposition.absorptionInput.text'), '$.sourceTaskId') = ?
            OR json_extract(json_extract(evidence_json, '$.nativeAbsorptionInput.text'), '$.sourceTaskId') = ?
          )
        `).get(taskId, taskId, taskId, taskId);
        if (active) throw new Error(`Task lifecycle transition is already active: ${active.operation_id}`);
        if (squashTransfer) {
          const sourceActive = database.prepare(`
            SELECT operation_id FROM hub_task_lifecycle_transitions
            WHERE phase IN ('pending_git', 'cleanup') AND (
              task_id = ? OR json_extract(evidence_json, '$.squashTransfer.source.taskId') = ?
              OR json_extract(json_extract(evidence_json, '$.selectedComposition.absorptionInput.text'), '$.sourceTaskId') = ?
            )
          `).get(squashTransfer.source.taskId, squashTransfer.source.taskId, squashTransfer.source.taskId);
          if (sourceActive) {
            throw new Error(`Source Task lifecycle transition is already active: ${sourceActive.operation_id}`);
          }
        }
        if (evidence?.absorbedInto) {
          const absorbed = evidence.absorbedInto;
          const targetTask = this.#taskRow(database, absorbed.taskId);
          const targetActive = database.prepare(
            "SELECT operation_id FROM hub_task_lifecycle_transitions WHERE task_id = ? AND phase IN ('pending_git', 'cleanup')",
          ).get(absorbed.taskId);
          const publishedDuplicate = absorbed.mode === "published_duplicate";
          const validTargetState = publishedDuplicate
            ? targetTask.status === "done" && targetTask.workflow_status === "done"
            : targetTask.status !== "done";
          if (!validTargetState || targetTask.workspace_id !== current.workspace_id
              || Number(current.row_revision) !== Number(absorbed.sourceTaskRevision ?? current.row_revision)
              || Number(targetTask.row_revision) !== absorbed.taskRevision || targetActive) {
            throw new Error("Surviving Task changed or has a pending operation");
          }
        }
        database.prepare(`
          INSERT INTO hub_task_lifecycle_transitions (
            operation_id, task_id, kind, phase, target_workflow_status,
            expected_task_revision, prior_state_json, evidence_json, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          operation, taskId, normalizedKind, normalizedKind === "workflow" ? "pending_git" : "cleanup",
          target, revision, JSON.stringify({
            task: this.#taskWithRelease(database, current),
            ...(squashTransfer || absorptionInput ? {
              sourceTask: this.#taskWithRelease(database, this.#taskRow(database, squashTransfer?.source.taskId
                ?? selectedAbsorptionHandoff({ requestId: absorptionInput.requestId,
                  text: absorptionInput.text }).declaration.sourceTaskId)),
            } : {}),
            bindingRequests: database.prepare(`
              SELECT provider, provider_thread_id, turn_id, operation_id, requested_workflow_status
              FROM hub_task_turn_bindings WHERE task_id = ?
            `).all(taskId),
          }), JSON.stringify(evidence ?? {}), timestamp, timestamp,
        );
        database.exec("COMMIT");
        return { task: this.#taskWithRelease(database, current), replayed: false, phase: normalizedKind === "workflow" ? "pending_git" : "cleanup" };
      } catch (error) {
        database.exec("ROLLBACK");
        throw new TaskLifecycleBeginRejectedError(error.message);
      }
    });
  }

  lifecycleTransition(operationId) {
    const operation = String(operationId ?? "").trim();
    return this.#withDatabase((database) => {
      const row = database.prepare(
        "SELECT * FROM hub_task_lifecycle_transitions WHERE operation_id = ?",
      ).get(operation);
      return row ? {
        operationId: row.operation_id,
        taskId: row.task_id,
        kind: row.kind,
        phase: row.phase,
        targetWorkflowStatus: row.target_workflow_status ?? null,
        expectedRevision: Number(row.expected_task_revision),
        priorTask: (() => {
          const priorState = JSON.parse(row.prior_state_json);
          return priorState?.task ?? priorState;
        })(),
        priorSourceTask: (() => {
          const priorState = JSON.parse(row.prior_state_json);
          return priorState?.sourceTask ?? null;
        })(),
        error: row.error_text,
        evidence: JSON.parse(row.evidence_json ?? "{}"),
      } : null;
    });
  }

  lifecycleOutcome(operationId) {
    const operation = String(operationId ?? "").trim();
    return this.#withDatabase((database) => {
      const row = database.prepare(
        "SELECT * FROM hub_task_lifecycle_outcomes WHERE operation_id = ?",
      ).get(operation);
      if (!row) return null;
      try {
        return {
          operationId: row.operation_id,
          taskId: row.task_id,
          kind: row.kind,
          result: JSON.parse(row.result_json),
          completedAtMs: Number(row.completed_at_ms),
        };
      } catch {
        throw new Error("Task lifecycle outcome is corrupt");
      }
    });
  }

  recordWorkflowAdmissionRefusal({ taskId, receipt, projectRoot, targetWorkflowStatus,
    expectedRevision = null, expectedWorkflowStatus = null } = {}) {
    if (receipt?.replayed !== false || receipt.status !== "pending"
        || receipt.operationStatus !== "pending") throw new Error("Workflow refusal requires a fresh MCP intake");
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#taskRow(database, taskId);
        const operation = receipt.requestId;
        if (current.workspace_id !== receipt.workspaceId
            || database.prepare("SELECT 1 FROM hub_task_lifecycle_transitions WHERE operation_id = ?").get(operation)
            || database.prepare("SELECT 1 FROM hub_task_lifecycle_outcomes WHERE operation_id = ?").get(operation)) {
          throw new Error("Workflow refusal cannot overwrite admitted or foreign lifecycle state");
        }
        const observedRevision = Number(current.row_revision);
        const code = expectedRevision !== null && expectedRevision !== observedRevision
          ? "WORKFLOW_REVISION_CHANGED"
          : expectedWorkflowStatus !== null && expectedWorkflowStatus !== current.workflow_status
            ? "WORKFLOW_STATUS_CHANGED" : null;
        const noEffect = { version: 1, code, taskId, projectRoot, targetWorkflowStatus,
          expectedRevision, expectedWorkflowStatus, observedRevision, observedWorkflowStatus: current.workflow_status,
          ...Object.fromEntries(["requestId", "workspaceId", "streamId", "provider", "threadId", "toolName",
            "argumentsHash", "createdAtMs"].map((key) => [key, receipt[key]])) };
        const outcome = { operationId: operation, taskId, kind: "workflow", result: { noEffect } };
        if (!workflowAdmissionNoEffectEvidence(outcome, receipt)) throw new Error("Workflow refusal identity or CAS is invalid");
        database.prepare(`INSERT INTO hub_task_lifecycle_outcomes
          (operation_id, task_id, kind, result_json, completed_at_ms) VALUES (?, ?, 'workflow', ?, ?)`)
          .run(operation, taskId, JSON.stringify(outcome.result), this.now());
        database.exec("COMMIT");
        return outcome;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  // The committed Test outcome is authoritative even if a filesystem receipt
  // disappears. Read the existing outcome owner; never infer ordinary protocol
  // from the absence of an optional field in downstream release objects.
  selectedCompositionForRelease({ taskId, projectRoot, resultCommit } = {}) {
    return this.#withDatabase(database => this.#selectedCompositionForRelease(database, { taskId, projectRoot, resultCommit }));
  }

  #selectedCompositionForRelease(database, { taskId, projectRoot, resultCommit }) {
      const rows = database.prepare(`
        SELECT result_json FROM hub_task_lifecycle_outcomes
        WHERE task_id = ? AND kind = 'workflow'
          AND json_extract(result_json, '$.task.workflowStatus') = 'testing'
          AND EXISTS (SELECT 1 FROM json_each(result_json, '$.task.gitReferences')
            WHERE json_extract(value, '$.resultCommit') = ?)
          AND (json_extract(result_json, '$.evidence.selectedCompositionRequired') = 1
            OR json_type(result_json, '$.evidence.selectedComposition') IS NOT NULL)
        ORDER BY completed_at_ms DESC, operation_id LIMIT 65
      `).all(taskId, resultCommit);
      if (rows.length > 64) throw selectedCompositionRequiredError("Test outcome history exceeds bounded proof lookup");
      let selected = null;
      for (const row of rows) {
        const outcome = JSON.parse(row.result_json);
        if (!(outcome.task.gitReferences ?? []).some((reference) => (
          reference.resultCommit === resultCommit && sameResolvedPath(reference.projectRoot, projectRoot)
        ))) continue;
        const evidence = outcome.evidence;
        if (!evidence.selectedCompositionRequired && !Object.hasOwn(evidence, "selectedComposition")) continue;
        const fields = selectedCompositionFields({ taskId, resultCommit,
          selectedCompositionRequired: true, selectedComposition: evidence.selectedComposition });
        if (fields.selectedComposition.kind === "native-task-integration-v1") {
          this.#assertAbsorptionPriorOutcomes(database, fields.selectedComposition.absorptionInput);
        }
        if (evidence.resultCommit !== resultCommit
            || !sameResolvedPath(fields.selectedComposition.repositoryRoot, projectRoot)
            || evidence.devHeadCommit !== fields.selectedComposition.proofCommit) {
          throw selectedCompositionRequiredError("durable Test repository/integration changed");
        }
        if (selected && selectedCompositionIdentity({ taskId, resultCommit, ...selected })
            !== selectedCompositionIdentity({ taskId, resultCommit, ...fields })) {
          throw selectedCompositionRequiredError("ambiguous durable selected Test outcomes");
        }
        selected = fields;
      }
      return selected;
  }

  failLifecycleTransition(operationId, error) {
    const operation = String(operationId ?? "").trim();
    return this.#withDatabase((database) => {
      const updated = database.prepare(`
        UPDATE hub_task_lifecycle_transitions
        SET phase = 'failed', error_text = ?, updated_at_ms = ?
        WHERE operation_id = ? AND phase IN ('pending_git', 'cleanup')
      `).run(String(error?.message ?? error ?? "lifecycle transition failed").slice(0, 4000), this.now(), operation);
      return Number(updated.changes) > 0;
    });
  }

  commitWorkflowTransition({
    operationId, provider = null, threadId = null, turnId = null, bindingOperationId = null,
    gitReferences = [], evidence = null, replaceGitReferences = true,
    metadataRecovery = null,
  } = {}) {
    const operation = String(operationId ?? "").trim();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const transition = database.prepare(`
          SELECT * FROM hub_task_lifecycle_transitions
          WHERE operation_id = ? AND kind = 'workflow' AND phase = 'pending_git'
        `).get(operation);
        if (!transition) throw new Error("Task workflow transition is not pending");
        const current = this.#taskRow(database, transition.task_id);
        const expectedRevision = metadataRecovery?.expectedCurrentRevision ?? transition.expected_task_revision;
        if (metadataRecovery) {
          const prior = JSON.parse(transition.prior_state_json);
          if (metadataRecovery.kind !== "native-test-metadata-terminal-v1"
              || !Number.isSafeInteger(metadataRecovery.expectedCurrentRevision)
              || metadataRecovery.originalExpectedRevision !== transition.expected_task_revision
              || !nativeTestMetadataDrift(this.#taskWithRelease(database, current), {
                taskId: transition.task_id, kind: transition.kind, phase: transition.phase,
                targetWorkflowStatus: transition.target_workflow_status,
                expectedRevision: transition.expected_task_revision, priorTask: prior.task ?? prior,
                evidence: JSON.parse(transition.evidence_json),
              })
              || JSON.stringify(evidence?.nativeTerminalRecovery) !== JSON.stringify(metadataRecovery)
              || evidence.resultCommit !== metadataRecovery.sourceCommit
              || evidence.devHeadCommit !== metadataRecovery.devCommit
              || gitReferences.length !== 1 || gitReferences[0].resultCommit !== metadataRecovery.sourceCommit
              || evidence.response?.gitIntegration?.alreadyIntegrated !== true) {
            throw new Error("Native Test metadata terminal proof changed");
          }
        }
        if (Number(current.row_revision) !== Number(expectedRevision)) {
          throw new Error("Task changed while Git evidence was prepared");
        }
        const initialNativeTest = JSON.parse(transition.evidence_json ?? "{}")?.initialNativeTest;
        if (initialNativeTest) {
          this.#assertInitialNativeTestContext(database, current, initialNativeTest);
          if (JSON.stringify(evidence?.initialNativeTest) !== JSON.stringify(initialNativeTest)
              || evidence.resultCommit !== initialNativeTest.identity.sourceCommit
              || evidence.response?.gitWorkspace?.headCommit !== initialNativeTest.identity.sourceCommit
              || evidence.response?.gitWorkspace?.branch !== initialNativeTest.identity.sourceBranch
              || evidence.response?.gitIntegration?.integrated !== true) throw new Error("Initial native Test terminal binding changed");
        }
        const pendingSelected = JSON.parse(transition.evidence_json ?? "{}")?.selectedComposition;
        const pendingNativeInput = JSON.parse(transition.evidence_json ?? "{}")?.nativeAbsorptionInput;
        const pendingNativeHistory = JSON.parse(transition.evidence_json ?? "{}")?.nativeAbsorptionHistory;
        if (pendingNativeHistory) {
          this.#assertNativeAbsorptionHistory(database, pendingNativeHistory, transition.task_id);
          if (pendingNativeInput || JSON.stringify(evidence?.nativeAbsorptionHistory) !== JSON.stringify(pendingNativeHistory)) {
            throw selectedCompositionRequiredError("native accepted history changed before terminal");
          }
          if (evidence?.selectedComposition) {
            const descriptor = selectedCompositionFields({ taskId: transition.task_id,
              resultCommit: evidence.resultCommit, selectedComposition: evidence.selectedComposition }).selectedComposition;
            if (descriptor.kind !== "native-task-integration-v1" || descriptor.operationId !== operation
                || descriptor.expectedTaskRevision !== Number(transition.expected_task_revision)
                || descriptor.proofCommit !== evidence.devHeadCommit
                || JSON.stringify(descriptor.absorptionHistory) !== JSON.stringify(pendingNativeHistory)) {
              throw selectedCompositionRequiredError("native corrected terminal lost accepted history");
            }
          } else {
            const reused = this.#selectedCompositionForRelease(database, { taskId: transition.task_id,
              projectRoot: pendingNativeHistory.repositoryRoot, resultCommit: evidence?.resultCommit })?.selectedComposition;
            if (reused?.kind !== "native-task-integration-v1"
                || JSON.stringify(reused.absorptionHistory ?? reused) !== JSON.stringify(pendingNativeHistory)
                || evidence?.response?.gitIntegration?.alreadyIntegrated !== true) {
              throw selectedCompositionRequiredError("native reuse has no exact original Test result");
            }
          }
        }
        if (pendingNativeInput) {
          const descriptor = selectedCompositionFields({ taskId: transition.task_id,
            resultCommit: evidence?.resultCommit, selectedCompositionRequired: true,
            selectedComposition: evidence?.selectedComposition }).selectedComposition;
          if (descriptor.kind !== "native-task-integration-v1" || descriptor.operationId !== operation
              || descriptor.expectedTaskRevision !== Number(transition.expected_task_revision)
              || descriptor.proofCommit !== evidence?.devHeadCommit
              || JSON.stringify(descriptor.absorptionInput) !== JSON.stringify(pendingNativeInput)
              || JSON.stringify(evidence?.nativeAbsorptionInput) !== JSON.stringify(pendingNativeInput)) {
            throw selectedCompositionRequiredError("native absorbed terminal differs from original admission");
          }
          this.#assertSelectedAbsorptionState(database, { binding: pendingNativeInput,
            survivorTaskId: transition.task_id, operationId: operation });
        } else if (!pendingNativeHistory && evidence?.selectedComposition?.kind === "native-task-integration-v1") {
          throw selectedCompositionRequiredError("native terminal has no original absorbed admission");
        }
        if (pendingSelected?.absorptionInput) {
          if (JSON.stringify(evidence?.selectedComposition) !== JSON.stringify(pendingSelected)) {
            throw selectedCompositionRequiredError("absorbed terminal proof differs from original admission");
          }
          this.#assertSelectedAbsorptionState(database, { binding: pendingSelected.absorptionInput,
            survivorTaskId: transition.task_id, operationId: operation });
        }
        if (replaceGitReferences) {
          database.prepare("DELETE FROM hub_task_git_references WHERE task_id = ?").run(transition.task_id);
          for (const reference of gitReferences) {
            this.#recordGitReference(
              database,
              transition.task_id,
              reference.projectRoot,
              reference.branch,
              { repoRoot: reference.projectRoot, tree: reference.resultCommit },
            );
          }
        }
        const lifecycleStatus = current.status === "done"
          ? (current.stream_id ? "started" : "open")
          : current.status;
        const changed = database.prepare(`
          UPDATE hub_board_tasks
          SET status = ?, workflow_status = ?, completed_at_ms = NULL, updated_at_ms = ?, blocked_by_json = ?,
            row_revision = row_revision + 1
          WHERE id = ? AND row_revision = ?
        `).run(
          lifecycleStatus, transition.target_workflow_status, this.now(),
          transition.target_workflow_status === "blocked"
            ? blockedByJson(evidence?.blockedBy ?? (current.workflow_status === "blocked" ? parseJson(current.blocked_by_json) : null))
            : null,
          transition.task_id,
          expectedRevision,
        );
        if (!Number(changed.changes)) throw new Error("Task workflow CAS failed");
        if (transition.target_workflow_status !== "awaiting_implementation") {
          database.prepare(`
            UPDATE hub_task_turn_bindings SET requested_workflow_status = NULL
            WHERE task_id = ? AND requested_workflow_status IS NOT NULL
          `).run(transition.task_id);
        } else if ([provider, threadId, turnId, bindingOperationId].every((value) => String(value ?? "").trim())) {
          database.prepare(`
            UPDATE hub_task_turn_bindings SET requested_workflow_status = 'awaiting_implementation'
            WHERE task_id = ? AND provider = ? AND provider_thread_id = ? AND turn_id = ? AND operation_id = ?
          `).run(transition.task_id, provider, threadId, turnId, bindingOperationId);
        }
        database.prepare(`
          UPDATE hub_task_lifecycle_transitions SET evidence_json = ?, updated_at_ms = ?
          WHERE operation_id = ?
        `).run(JSON.stringify(evidence ?? {}), this.now(), operation);
        const task = this.#taskWithRelease(database, this.#taskRow(database, transition.task_id));
        const priorState = JSON.parse(transition.prior_state_json);
        const priorTask = priorState?.task ?? priorState;
        database.prepare(`
          INSERT OR REPLACE INTO hub_task_lifecycle_outcomes (
            operation_id, task_id, kind, result_json, completed_at_ms
          ) VALUES (?, ?, 'workflow', ?, ?)
        `).run(operation, transition.task_id, JSON.stringify({
          task,
          priorTask,
          priorBindingRequests: priorState?.bindingRequests ?? [],
          evidence: evidence ?? {},
        }), this.now());
        database.prepare("DELETE FROM hub_task_lifecycle_transitions WHERE operation_id = ?").run(operation);
        database.exec("COMMIT");
        return task;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  commitSquashTransferTransition({ operationId, squashTransfer, squashCutover = null } = {}) {
    const operation = String(operationId ?? "").trim();
    const proof = normalizedTaskSquashTransfer(squashTransfer);
    if (!proof.integrationCommit) throw new Error("Task squash transfer requires exact Git integration readback");
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const transition = database.prepare(`
          SELECT * FROM hub_task_lifecycle_transitions
          WHERE operation_id = ? AND kind = 'workflow' AND phase = 'pending_git'
        `).get(operation);
        if (!transition) throw new Error("Task squash transfer is not pending");
        const pendingProof = normalizedTaskSquashTransfer(
          JSON.parse(transition.evidence_json)?.squashTransfer,
        );
        const pendingCutoverValue = JSON.parse(transition.evidence_json)?.squashCutover ?? null;
        const pendingCutover = pendingCutoverValue ? normalizedTaskSquashCutover(pendingCutoverValue) : null;
        const suppliedCutover = squashCutover ? normalizedTaskSquashCutover(squashCutover) : null;
        if (pendingProof.transferHash !== proof.transferHash
            || transition.task_id !== proof.survivor.taskId
            || transition.target_workflow_status !== "testing"
            || Boolean(pendingCutover) !== Boolean(suppliedCutover)
            || (pendingCutover && pendingCutover.cutoverHash !== suppliedCutover.cutoverHash)) {
          throw new Error("Task squash transfer evidence changed before commit");
        }
        const survivor = this.#taskRow(database, proof.survivor.taskId);
        const source = this.#taskRow(database, proof.source.taskId);
        if (Number(survivor.row_revision) !== proof.survivor.revision
            || Number(source.row_revision) !== proof.source.revision
            || Number(survivor.release_revision) !== proof.survivor.releaseRevision
            || Number(source.release_revision) !== proof.source.releaseRevision
            || survivor.workflow_status !== (pendingCutover ? "in_progress" : "testing")
            || source.workflow_status !== "testing") {
          throw new Error("Task squash transfer rows changed while Git was applied");
        }
        database.prepare("DELETE FROM hub_task_git_references WHERE task_id = ?").run(survivor.id);
        this.#recordGitReference(database, survivor.id, proof.projectRoot, proof.survivor.branch, {
          repoRoot: proof.projectRoot,
          tree: proof.survivor.resultCommit,
        });
        const now = this.now();
        const survivorChanged = database.prepare(`
          UPDATE hub_board_tasks SET workflow_status = 'testing', row_revision = row_revision + 1,
            release_revision = release_revision + 1, updated_at_ms = ?
          WHERE id = ? AND row_revision = ? AND workflow_status = ?
        `).run(now, survivor.id, proof.survivor.revision, pendingCutover ? "in_progress" : "testing");
        const sourceChanged = database.prepare(`
          UPDATE hub_board_tasks SET workflow_status = 'in_progress', completed_at_ms = NULL,
            row_revision = row_revision + 1, release_revision = release_revision + 1, updated_at_ms = ?
          WHERE id = ? AND row_revision = ? AND workflow_status = 'testing'
        `).run(now, source.id, proof.source.revision);
        if (!Number(survivorChanged.changes) || !Number(sourceChanged.changes)) {
          throw new Error("Task squash transfer row CAS failed");
        }
        database.prepare(`
          UPDATE hub_task_turn_bindings SET requested_workflow_status = NULL
          WHERE task_id IN (?, ?) AND requested_workflow_status IS NOT NULL
        `).run(survivor.id, source.id);
        const survivorTask = this.#taskWithRelease(database, this.#taskRow(database, survivor.id));
        const sourceTask = this.#taskWithRelease(database, this.#taskRow(database, source.id));
        const priorState = JSON.parse(transition.prior_state_json);
        const evidence = {
          ...JSON.parse(transition.evidence_json),
          squashTransfer: proof,
          ...(pendingCutover ? { squashCutover: pendingCutover } : {}),
        };
        database.prepare(`
          INSERT OR REPLACE INTO hub_task_lifecycle_outcomes (
            operation_id, task_id, kind, result_json, completed_at_ms
          ) VALUES (?, ?, 'workflow', ?, ?)
        `).run(operation, survivor.id, JSON.stringify({
          task: survivorTask,
          sourceTask,
          priorTask: priorState.task,
          priorSourceTask: priorState.sourceTask,
          evidence,
        }), now);
        database.prepare("DELETE FROM hub_task_lifecycle_transitions WHERE operation_id = ?").run(operation);
        database.exec("COMMIT");
        return {
          task: survivorTask, sourceTask, squashTransfer: proof,
          ...(pendingCutover ? { squashCutover: pendingCutover } : {}),
        };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  rollbackWorkflowOutcome(operationId, error) {
    const operation = String(operationId ?? "").trim();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const outcome = database.prepare(`
          SELECT * FROM hub_task_lifecycle_outcomes
          WHERE operation_id = ? AND kind = 'workflow'
        `).get(operation);
        if (!outcome) throw new Error("Task workflow outcome is unavailable for rollback");
        const result = JSON.parse(outcome.result_json);
        if (result.rollback?.completed === true) {
          database.exec("COMMIT");
          return this.#taskWithRelease(database, this.#taskRow(database, outcome.task_id));
        }
        const committed = result.task;
        const prior = result.priorTask;
        if (!committed || !prior) throw new Error("Task workflow outcome has no rollback state");
        const current = this.#taskRow(database, outcome.task_id);
        if (Number(current.row_revision) !== Number(committed.revision)
          || current.workflow_status !== committed.workflowStatus) {
          throw new Error("Task changed after workflow commit; rollback was not applied");
        }
        database.prepare("DELETE FROM hub_task_git_references WHERE task_id = ?").run(outcome.task_id);
        for (const reference of prior.gitReferences ?? []) {
          this.#recordGitReference(database, outcome.task_id, reference.projectRoot, reference.branch, {
            repoRoot: reference.projectRoot,
            tree: reference.resultCommit,
          });
        }
        const restored = database.prepare(`
          UPDATE hub_board_tasks SET status = ?, workflow_status = ?, completed_at_ms = ?, blocked_by_json = ?,
            updated_at_ms = ?, row_revision = row_revision + 1
          WHERE id = ? AND row_revision = ? AND workflow_status = ?
        `).run(
          prior.status,
          prior.workflowStatus,
          prior.completedAt ? Date.parse(prior.completedAt) : null,
          prior.blockedBy ? JSON.stringify(prior.blockedBy) : null,
          this.now(), outcome.task_id, committed.revision, committed.workflowStatus,
        );
        if (!Number(restored.changes)) throw new Error("Task workflow rollback CAS failed");
        database.prepare(`
          UPDATE hub_task_turn_bindings SET requested_workflow_status = NULL WHERE task_id = ?
        `).run(outcome.task_id);
        for (const binding of result.priorBindingRequests ?? []) {
          if (!binding.requested_workflow_status) continue;
          database.prepare(`
            UPDATE hub_task_turn_bindings SET requested_workflow_status = ?
            WHERE task_id = ? AND provider = ? AND provider_thread_id = ?
              AND turn_id = ? AND operation_id = ?
          `).run(
            binding.requested_workflow_status, outcome.task_id, binding.provider,
            binding.provider_thread_id, binding.turn_id, binding.operation_id,
          );
        }
        const task = this.#taskWithRelease(database, this.#taskRow(database, outcome.task_id));
        const rollback = {
          completed: true,
          reason: String(error?.message ?? error ?? "Await rebuild failed").slice(0, 4000),
          completedAtMs: this.now(),
        };
        database.prepare(`
          UPDATE hub_task_lifecycle_outcomes SET result_json = ?, completed_at_ms = ?
          WHERE operation_id = ?
        `).run(JSON.stringify({ ...result, rollback, restoredTask: task }), rollback.completedAtMs, operation);
        database.exec("COMMIT");
        return task;
      } catch (rollbackError) {
        database.exec("ROLLBACK");
        throw rollbackError;
      }
    });
  }

  finalizeCleanupTransition(operationId, { deleteTask = false, receiptEvidence = null } = {}) {
    const operation = String(operationId ?? "").trim();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const transition = database.prepare(`
          SELECT * FROM hub_task_lifecycle_transitions
          WHERE operation_id = ? AND phase = 'cleanup'
        `).get(operation);
        if (!transition) throw new Error("Task cleanup transition is not pending");
        const current = this.#taskRow(database, transition.task_id);
        if (Number(current.row_revision) !== Number(transition.expected_task_revision)) {
          throw new Error("Task changed while cleanup was running");
        }
        let result;
        if (deleteTask) {
          result = { deleted: true, task: taskFromRow(current) };
          database.prepare(`
            INSERT OR REPLACE INTO hub_task_lifecycle_outcomes (
              operation_id, task_id, kind, result_json, completed_at_ms
            ) VALUES (?, ?, 'delete', ?, ?)
          `).run(operation, transition.task_id, JSON.stringify({ result, evidence: receiptEvidence ?? {} }), this.now());
          database.prepare("DELETE FROM hub_board_tasks WHERE id = ? AND row_revision = ?")
            .run(transition.task_id, transition.expected_task_revision);
        } else {
          const changed = database.prepare(`
            UPDATE hub_board_tasks SET status = 'done', completed_at_ms = ?, updated_at_ms = ?
            WHERE id = ? AND row_revision = ?
          `).run(this.now(), this.now(), transition.task_id, transition.expected_task_revision);
          if (!Number(changed.changes)) throw new Error("Task complete CAS failed");
          result = this.#taskWithRelease(database, this.#taskRow(database, transition.task_id));
          database.prepare(`
            INSERT OR REPLACE INTO hub_task_lifecycle_outcomes (
              operation_id, task_id, kind, result_json, completed_at_ms
            ) VALUES (?, ?, 'complete', ?, ?)
          `).run(operation, transition.task_id, JSON.stringify({ result, evidence: receiptEvidence ?? {} }), this.now());
          database.prepare("DELETE FROM hub_task_lifecycle_transitions WHERE operation_id = ?").run(operation);
        }
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  recordTaskTurn({
    taskId = null, provider, threadId, turnId, operationId, projectRoot, summary = "", status = "completed",
    changedFiles = [], gitBaseline = null, resultSnapshot = null, branch = null,
  } = {}) {
    const identity = [provider, threadId, turnId, operationId].map((value) => String(value ?? "").trim());
    const files = normalizedTaskChangedFiles(changedFiles);
    if (identity.some((value) => !value)) return null;
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
      const binding = database.prepare(`
        SELECT * FROM hub_task_turn_bindings
        WHERE provider = ? AND provider_thread_id = ? AND turn_id = ? AND operation_id = ?
      `).get(...identity);
      if (!binding) throw new Error("terminal Task evidence requires an exact durable provider operation binding");
      const resolvedTaskId = String(taskId ?? binding.task_id).trim();
      if (binding.task_id !== resolvedTaskId) throw new Error("terminal Task identity conflicts with its exact operation binding");
      this.#taskRow(database, resolvedTaskId);
      let baselineJson = String(binding.baseline_json ?? "{}");
      const recoveredBaselineJson = gitBaselineJson(gitBaseline);
      if (baselineJson === "{}" && recoveredBaselineJson !== "{}") {
        database.prepare(`
          UPDATE hub_task_turn_bindings SET baseline_json = ?
          WHERE provider = ? AND provider_thread_id = ? AND turn_id = ? AND operation_id = ?
        `).run(recoveredBaselineJson, ...identity);
        baselineJson = recoveredBaselineJson;
      }
      if (files.length) database.prepare(`
        INSERT INTO hub_task_work_log (
          id, task_id, provider, provider_thread_id, turn_id, operation_id,
          project_root, summary, status, changed_files_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, provider, provider_thread_id, turn_id, operation_id) DO UPDATE SET
          summary = excluded.summary, status = excluded.status,
          changed_files_json = excluded.changed_files_json
      `).run(
        this.idFactory(), resolvedTaskId, ...identity, String(projectRoot ?? ""),
        String(summary ?? "").trim().slice(0, 2_000), String(status ?? "completed"),
        JSON.stringify(files), timestamp,
      );
      this.#recordGitReference(database, resolvedTaskId, projectRoot, branch, resultSnapshot);
      database.prepare(`
        UPDATE hub_board_tasks SET updated_at_ms = ? WHERE id = ?
      `).run(timestamp, resolvedTaskId);
      database.prepare(`
        UPDATE hub_task_turn_bindings SET terminal_at_ms = ?
        WHERE provider = ? AND provider_thread_id = ? AND turn_id = ? AND operation_id = ?
      `).run(timestamp, ...identity);
      const result = this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(resolvedTaskId),
      );
      database.exec("COMMIT");
      return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  recordTaskGitReference({ taskId, projectRoot, branch, resultSnapshot } = {}) {
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.#taskRow(database, taskId);
        this.#recordGitReference(database, row.id, projectRoot, branch, resultSnapshot);
        database.prepare(`
          UPDATE hub_board_tasks
          SET updated_at_ms = ?, row_revision = row_revision + 1
          WHERE id = ?
        `).run(timestamp, row.id);
        const task = this.#taskWithRelease(database, this.#taskRow(database, row.id));
        database.exec("COMMIT");
        return task;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  adoptLegacyGitReference({
    taskId, expectedRevision, projectRoot, branch, reportedResultCommit, mainResultCommit, patchId,
    evidenceStreamId, evidenceProvider, evidenceThreadId, evidenceTurnId,
    actorStreamId, actorProvider, actorThreadId, requestId,
  } = {}) {
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.#taskRow(database, taskId);
        if (row.status === "done" || row.workflow_status !== "awaiting_implementation") {
          throw new Error("Legacy Git adoption requires an open Await Task");
        }
        if (Number(row.row_revision) !== Number(expectedRevision)) {
          throw new Error("Task revision changed before legacy Git adoption");
        }
        const referenceCount = Number(database.prepare(
          "SELECT COUNT(*) AS value FROM hub_task_git_references WHERE task_id = ?",
        ).get(row.id)?.value) || 0;
        if (referenceCount) throw new Error("Task already has Git evidence");
        const root = path.resolve(String(projectRoot ?? ""));
        database.prepare(`
          INSERT INTO hub_task_git_references (
            task_id, project_root, branch, result_commit, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?)
        `).run(row.id, root, String(branch), String(mainResultCommit), timestamp);
        database.prepare(`
          INSERT INTO hub_task_legacy_git_adoptions (
            task_id, task_number, project_root, branch,
            reported_result_commit, main_result_commit, patch_id,
            evidence_stream_id, evidence_provider, evidence_thread_id, evidence_turn_id,
            actor_stream_id, actor_provider, actor_thread_id, request_id, adopted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.id, row.task_number ?? "", root, String(branch),
          String(reportedResultCommit), String(mainResultCommit), String(patchId),
          String(evidenceStreamId), String(evidenceProvider), String(evidenceThreadId), String(evidenceTurnId),
          String(actorStreamId), String(actorProvider), String(actorThreadId), String(requestId), timestamp,
        );
        const updated = database.prepare(`
          UPDATE hub_board_tasks SET updated_at_ms = ?, row_revision = row_revision + 1
          WHERE id = ? AND row_revision = ? AND workflow_status = 'awaiting_implementation' AND status != 'done'
        `).run(timestamp, row.id, Number(expectedRevision));
        if (updated.changes !== 1) throw new Error("Task changed during legacy Git adoption");
        const task = this.#taskWithRelease(database, this.#taskRow(database, row.id));
        database.exec("COMMIT");
        return task;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  #recordGitReference(database, taskId, projectRoot, branch, resultSnapshot) {
    const flatten = (snapshot) => Array.isArray(snapshot?.repositories)
      ? snapshot.repositories
      : (snapshot?.repoRoot ? [snapshot] : []);
    const insert = database.prepare(`
      INSERT INTO hub_task_git_references (
        task_id, project_root, branch, result_commit, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id, project_root) DO UPDATE SET
        branch = excluded.branch, result_commit = excluded.result_commit,
        updated_at_ms = excluded.updated_at_ms
    `);
    for (const value of flatten(resultSnapshot)) {
      const root = path.resolve(value.repoRoot || projectRoot);
      const resultCommit = String(value.tree ?? "").trim();
      const taskBranch = String(branch ?? "").trim() || taskBranchName(taskId, root);
      if (root && resultCommit) insert.run(taskId, root, taskBranch, resultCommit, this.now());
    }
  }

  #removeReleaseRegistry() {
    const database = this.#database;
    const retiredTables = this.#retiredReleaseTables();
    database.exec("BEGIN IMMEDIATE");
    try {
      const removalCompleted = database.prepare(
        "SELECT value FROM hub_board_settings WHERE key = 'task_release_registry_removed_v2'",
      ).get()?.value === "completed";
      // After cutover the Task aggregate is authoritative. Retired tables can
      // only reappear when an older runtime starts, so their mutable rows must
      // not be compared with the canonical immutable audit archive again.
      if (!removalCompleted) {
        this.#archiveLegacyReleaseRegistry(database, retiredTables);
        this.#verifyLegacyReleaseArchive(database, retiredTables);
      }
      for (const { table } of retiredTables.toReversed()) {
        database.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      database.prepare(`
        INSERT INTO hub_board_settings (key, value, updated_at_ms)
        VALUES ('task_release_registry_removed_v2', 'completed', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
      `).run(this.now());
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS hub_release_registry_history_no_update
        BEFORE UPDATE ON hub_release_registry_history
        BEGIN
          SELECT RAISE(ABORT, 'release history is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS hub_release_registry_history_no_delete
        BEFORE DELETE ON hub_release_registry_history
        BEGIN
          SELECT RAISE(ABORT, 'release history is immutable');
        END;
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseTasks(workspaceId) {
    return this.list({ includeDone: true }).filter((task) => task.workspaceId === String(workspaceId));
  }

  releaseTasksSnapshot(workspaceId) {
    return this.#withDatabase((database) => {
      database.exec("BEGIN");
      try {
        const rows = database.prepare(`
          SELECT * FROM hub_board_tasks WHERE workspace_id = ?
          ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'started' THEN 1 ELSE 2 END,
            bucket, workspace_id, board_order, created_at_ms, id
        `).all(String(workspaceId));
        const tasks = rows.map((row) => ({
          ...taskFromRow(row),
          ...this.#releaseIdentityDetails(database, row.id),
        }));
        database.exec("COMMIT");
        return tasks;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  awaitRebuildPending(workspaceId) {
    const key = `release_await_rebuild_pending:${String(workspaceId)}`;
    return this.#withDatabase((database) => {
      const value = database.prepare("SELECT value FROM hub_board_settings WHERE key = ?").get(key)?.value;
      if (!value) return null;
      try {
        const parsed = JSON.parse(value);
        if (parsed.completed === true) return null;
        if (parsed.version != null && parsed.version !== 2) throw new Error("unsupported finalization version");
        if (parsed.version === 2 && (!Array.isArray(parsed.repositories) || !parsed.repositories.length
          || parsed.repositories.some((repository) => !repository.projectRoot || !repository.publishedRevision))) {
          throw new Error("invalid exact finalization repositories");
        }
        return {
          ...(parsed.version === 2 ? {
            version: 2,
            repositories: parsed.repositories,
            awaitResult: parsed.awaitResult ?? null,
          } : {}),
          planRevision: String(parsed.planRevision ?? ""),
          fallbackProjectRoots: Array.isArray(parsed.fallbackProjectRoots)
            ? parsed.fallbackProjectRoots.map((root) => String(root)).filter(Boolean)
            : [],
        };
      } catch {
        throw new Error(`invalid pending Await rebuild evidence for Workspace ${workspaceId}`);
      }
    });
  }

  releaseFinalizationOutcome(workspaceId, planRevision) {
    const key = `release_await_rebuild_pending:${String(workspaceId)}`;
    return this.#withDatabase((database) => {
      const value = database.prepare("SELECT value FROM hub_board_settings WHERE key = ?").get(key)?.value;
      if (!value) return null;
      const saved = JSON.parse(value);
      return (saved.completedOutcomes ?? []).find((outcome) => outcome.planRevision === planRevision) ?? null;
    });
  }

  recordReleaseFinalizationStage(workspaceId, { planRevision, stage, projectRoot, receipt }) {
    const key = `release_await_rebuild_pending:${String(workspaceId)}`;
    return this.#withDatabase((database) => {
      const value = database.prepare("SELECT value FROM hub_board_settings WHERE key = ?").get(key)?.value;
      const pending = value ? JSON.parse(value) : null;
      if (!pending || pending.version !== 2 || pending.planRevision !== planRevision) {
        throw new Error("release finalization revision conflict");
      }
      if (!receipt || typeof receipt.completed !== "boolean" || !receipt.result) {
        throw new Error("release finalization requires a stage receipt");
      }
      let holder;
      let field;
      if (stage === "await") {
        holder = pending;
        field = "awaitResult";
      } else if (["primary", "dev"].includes(stage)) {
        holder = pending.repositories.find((repository) => repository.projectRoot === projectRoot);
        field = stage;
      }
      if (!holder) throw new Error("unknown release finalization stage or repository");
      if (holder[field]?.completed) return false;
      holder[field] = receipt;
      const updated = database.prepare(`
        UPDATE hub_board_settings SET value = ?, updated_at_ms = ? WHERE key = ? AND value = ?
      `).run(JSON.stringify(pending), this.now(), key, value);
      if (!Number(updated.changes)) throw new Error("release finalization checkpoint changed");
      return true;
    });
  }

  clearAwaitRebuildPending(workspaceId, expectedPlanRevision = null) {
    const key = `release_await_rebuild_pending:${String(workspaceId)}`;
    return this.#withDatabase((database) => {
      const value = database.prepare("SELECT value FROM hub_board_settings WHERE key = ?").get(key)?.value;
      if (!value) return false;
      const pending = JSON.parse(value);
      if (expectedPlanRevision && pending.planRevision !== expectedPlanRevision) {
        throw new Error("release finalization revision conflict");
      }
      if (pending.completed === true) return false;
      if (pending.version === 2 && (!pending.awaitResult?.completed
        || pending.repositories.some((repository) => !repository.primary?.completed || !repository.dev?.completed))) {
        throw new Error("release finalization has unfinished stages");
      }
      if (pending.version === 2) {
        const completedOutcomes = [...(pending.completedOutcomes ?? []), {
          planRevision: pending.planRevision,
          repositories: pending.repositories.map(({ projectRoot, publishedRevision }) => ({ projectRoot, publishedRevision })),
        }].slice(-16);
        return Number(database.prepare(`
          UPDATE hub_board_settings SET value = ?, updated_at_ms = ? WHERE key = ? AND value = ?
        `).run(JSON.stringify({ version: 2, completed: true, completedOutcomes }), this.now(), key, value).changes) > 0;
      }
      return Number(database.prepare("DELETE FROM hub_board_settings WHERE key = ? AND value = ?").run(key, value).changes) > 0;
    });
  }

  completeRelease(workspaceId, {
    expectedPlanRevision = null, plan = null, verificationEvidence = null, awaitRebuild = null,
  } = {}) {
    const expected = String(expectedPlanRevision ?? "").trim();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
      if (this.awaitRebuildPending(workspaceId)) {
        throw new Error("release finalization is still pending");
      }
      const tasks = this.releaseTasks(workspaceId);
      const awaiting = tasks.filter((task) => task.status !== "done"
        && task.workflowStatus === "awaiting_implementation");
      const doneAudit = tasks.filter((task) => task.status !== "done" && task.workflowStatus === "done");
      const releaseRevision = taskReleasePlanRevision(workspaceId, awaiting);
      const legacyRevision = taskReleasePlanRevision(workspaceId, [...awaiting, ...doneAudit], { legacy: true });
      const legacy = expected !== releaseRevision && expected === legacyRevision;
      const currentRevision = legacy ? legacyRevision : releaseRevision;
      if (!expected || currentRevision !== expected || plan?.revision !== expected) {
        throw new Error("release plan revision conflict; verify the current release plan again");
      }
      if (!plan.candidates.length) throw new Error("release has no awaiting Task candidates");
      if (taskReleasePlanRevision(workspaceId, plan.candidates) !== releaseRevision) {
        throw new Error("release Task results or membership changed before closure");
      }
      if (!verificationEvidence || typeof verificationEvidence !== "object") {
        throw new Error("release completion requires durable publication evidence");
      }
      const rebuildPlanRevision = String(awaitRebuild?.planRevision ?? "").trim();
      const fallbackProjectRoots = Array.isArray(awaitRebuild?.fallbackProjectRoots)
        ? awaitRebuild.fallbackProjectRoots.map((root) => String(root).trim()).filter(Boolean)
        : [];
      if (rebuildPlanRevision !== expected || !fallbackProjectRoots.length) {
        throw new Error("release completion requires durable Await rebuild evidence");
      }
      const previousValue = database.prepare("SELECT value FROM hub_board_settings WHERE key = ?")
        .get(`release_await_rebuild_pending:${String(workspaceId)}`)?.value;
      const completedOutcomes = previousValue ? JSON.parse(previousValue).completedOutcomes ?? [] : [];
      const pending = { planRevision: rebuildPlanRevision, fallbackProjectRoots };
      if (awaitRebuild.version === 2) {
        const expectedRepositories = verificationEvidence.publication?.repositories ?? [];
        if (!expectedRepositories.length || !Array.isArray(awaitRebuild.repositories)
          || awaitRebuild.repositories.length !== expectedRepositories.length
          || awaitRebuild.repositories.some((repository, index) => (
            repository.projectRoot !== expectedRepositories[index].root
            || repository.publishedRevision !== expectedRepositories[index].revision
            || !repository.publishedRevision
          ))) throw new Error("release finalization requires exact verified repositories");
        Object.assign(pending, {
          version: 2,
          completedOutcomes,
          repositories: awaitRebuild.repositories.map(({ projectRoot, publishedRevision }) => ({
            projectRoot, publishedRevision, primary: null, dev: null,
          })),
          awaitResult: null,
        });
      }
      const timestamp = this.now();
      const released = [];
      for (const task of plan.candidates) {
        const current = database.prepare(`
          SELECT row_revision, release_revision, workflow_status FROM hub_board_tasks WHERE id = ?
        `).get(task.id);
        if (!current
           || (legacy && Number(current.row_revision) !== task.revision)
           || Number(current.release_revision) !== (task.releaseRevision ?? task.revision)
          || current.workflow_status !== "awaiting_implementation") {
          throw new Error(`release Task revision changed: ${task.id}`);
        }
        const result = database.prepare(`
          UPDATE hub_board_tasks SET workflow_status = 'done', status = 'done',
            completed_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND row_revision = ? AND workflow_status = 'awaiting_implementation'
        `).run(timestamp, timestamp, task.id, Number(current.row_revision));
        if (!Number(result.changes)) throw new Error(`release Task disappeared: ${task.id}`);
        released.push({ id: task.id, revision: Number(current.row_revision),
          releaseRevision: Number(current.release_revision), gitReferences: task.gitReferences });
      }
      const result = {
        workspaceId: String(workspaceId),
        released,
        verificationEvidence,
      };
      database.prepare(`
        INSERT INTO hub_board_settings (key, value, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
      `).run(
        `release_await_rebuild_pending:${String(workspaceId)}`,
        JSON.stringify(pending),
        timestamp,
      );
      database.exec("COMMIT");
      return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  completeReleaseOperation(workspaceId, {
    operationId, generation, selectedResults = [], publicationEffects = {},
  } = {}) {
    const releaseOperationId = String(operationId ?? "").trim();
    const generationNumber = Number(generation);
    if (!releaseOperationId || !Number.isSafeInteger(generationNumber) || generationNumber < 1) {
      throw new Error("release operation finalization requires exact operation and generation");
    }
    if (!Array.isArray(selectedResults) || !selectedResults.length) {
      throw new Error("release operation finalization requires selected results");
    }
    const key = `release_operation_finalized:${releaseOperationId}:${generationNumber}`;
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = database.prepare("SELECT value FROM hub_board_settings WHERE key = ?").get(key)?.value;
        if (existing) {
          database.exec("ROLLBACK");
          return { ...JSON.parse(existing), alreadyFinalized: true };
        }
        const timestamp = this.now();
        const deliveries = [];
        for (const selected of selectedResults) {
          const taskId = String(selected?.taskId ?? "").trim();
          const resultCommit = String(selected?.resultCommit ?? "").trim();
          const task = database.prepare(`
            SELECT workspace_id, row_revision, release_revision, workflow_status, status
            FROM hub_board_tasks WHERE id = ?
          `).get(taskId);
          if (!task || String(task.workspace_id ?? "") !== String(workspaceId)) {
            throw new Error(`release operation Task is missing from its Workspace: ${taskId}`);
          }
          const references = database.prepare(`
            SELECT project_root AS projectRoot, branch, result_commit AS resultCommit
            FROM hub_task_git_references WHERE task_id = ? ORDER BY project_root
          `).all(taskId);
          const currentResult = references.some((reference) => reference.resultCommit === resultCommit);
          const closesCurrent = currentResult
            && task.workflow_status === "awaiting_implementation"
            && task.status !== "done";
          if (closesCurrent) {
            const updated = database.prepare(`
              UPDATE hub_board_tasks SET workflow_status = 'done', status = 'done',
                completed_at_ms = ?, updated_at_ms = ?
              WHERE id = ? AND row_revision = ? AND workflow_status = 'awaiting_implementation'
            `).run(timestamp, timestamp, taskId, Number(task.row_revision));
            if (Number(updated.changes) !== 1) throw new Error(`release operation Task CAS changed: ${taskId}`);
          }
          deliveries.push({
            taskId,
            resultCommit,
            delivered: true,
            closedCurrentTask: closesCurrent,
            currentWorkflowStatus: closesCurrent ? "done" : task.workflow_status,
            currentResult,
            taskRevision: Number(task.row_revision),
            releaseRevision: Number(task.release_revision),
          });
        }
        const result = {
          schemaVersion: 1,
          workspaceId: String(workspaceId),
          operationId: releaseOperationId,
          generation: generationNumber,
          deliveries,
          publicationEffects: structuredClone(publicationEffects),
          completedAtMs: timestamp,
        };
        database.prepare(`
          INSERT INTO hub_board_settings (key, value, updated_at_ms) VALUES (?, ?, ?)
        `).run(key, JSON.stringify(result), timestamp);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }

  remove(id) {
    return this.#withDatabase((database) => {
      const taskId = String(id);
      return Number(database.prepare("DELETE FROM hub_board_tasks WHERE id = ?").run(taskId).changes) > 0;
    });
  }

  captureEnabled(chatId) {
    if (!Number.isSafeInteger(Number(chatId))) return false;
    return this.#withDatabase((database) => (
      Number(database.prepare(
        "SELECT enabled FROM hub_board_capture_chats WHERE chat_id = ?",
      ).get(Number(chatId))?.enabled ?? 0) === 1
    ));
  }

  setCaptureEnabled(chatId, enabled) {
    const value = Number(chatId);
    if (!Number.isSafeInteger(value)) throw new Error("Некорректный Telegram chat ID");
    this.#withDatabase((database) => database.prepare(`
      INSERT INTO hub_board_capture_chats (chat_id, enabled, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled, updated_at_ms = excluded.updated_at_ms
    `).run(value, enabled ? 1 : 0, this.now()));
    return Boolean(enabled);
  }
}
