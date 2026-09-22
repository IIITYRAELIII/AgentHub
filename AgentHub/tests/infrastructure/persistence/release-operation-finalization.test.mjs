import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

test("release finalization closes only the exact currently accepted result and is idempotent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-operation-finalization-"));
  const databaseFile = path.join(root, "runtime.sqlite");
  const store = new TaskBoardStore({ databaseFile, now: () => 1_800_000_000_000 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const current = store.create({ text: "Current result" });
  const corrected = store.create({ text: "Correction in progress" });
  const currentTask = store.move(current.id, { bucket: "workspace", workspaceId: "workspace-1" });
  const correctedTask = store.move(corrected.id, { bucket: "workspace", workspaceId: "workspace-1" });
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare("UPDATE hub_board_tasks SET workflow_status = 'awaiting_implementation', status = 'started' WHERE id = ?").run(current.id);
  database.prepare("UPDATE hub_board_tasks SET workflow_status = 'in_progress', status = 'started' WHERE id = ?").run(corrected.id);
  database.prepare("INSERT INTO hub_task_git_references VALUES (?, ?, ?, ?, ?)")
    .run(current.id, root, currentTask.taskNumber, "result-r1", 1_800_000_000_000);
  database.prepare("INSERT INTO hub_task_git_references VALUES (?, ?, ?, ?, ?)")
    .run(corrected.id, root, correctedTask.taskNumber, "result-r2", 1_800_000_000_000);
  database.close();

  const request = {
    operationId: "release-operation-1",
    generation: 1,
    selectedResults: [
      { taskId: current.id, resultCommit: "result-r1" },
      { taskId: corrected.id, resultCommit: "result-r1" },
    ],
    publicationEffects: { targets: { production: { status: "applied", revision: "published" } } },
  };
  const first = store.completeReleaseOperation("workspace-1", request);
  assert.equal(first.deliveries[0].closedCurrentTask, true);
  assert.equal(first.deliveries[1].closedCurrentTask, false);
  assert.equal(store.task(current.id).workflowStatus, "done");
  assert.equal(store.task(corrected.id).workflowStatus, "in_progress");
  const replay = store.completeReleaseOperation("workspace-1", request);
  assert.equal(replay.alreadyFinalized, true);
  assert.deepEqual(replay.deliveries, first.deliveries);
});
