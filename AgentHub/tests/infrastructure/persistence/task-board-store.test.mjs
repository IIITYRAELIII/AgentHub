import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-board-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let sequence = 0;
  return new TaskBoardStore({
    databaseFile: path.join(directory, "journal.sqlite"),
    now: () => 1_700_000_000_000 + sequence,
    idFactory: () => `task-${++sequence}`,
  });
}

test("Task store deduplicates Telegram updates and persists capture mode", async (t) => {
  const store = await fixture(t);
  const first = store.create({ text: "  Купить молоко ", source: "telegram", sourceKey: "telegram:1:2" });
  const duplicate = store.create({ text: "Другой текст", source: "telegram", sourceKey: "telegram:1:2" });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.rawText, "Купить молоко");
  assert.equal(store.captureEnabled(1), false);
  store.setCaptureEnabled(1, true);
  assert.equal(store.captureEnabled(1), true);
});

test("Task store can persist disabled Spark triage", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Сохранить без Spark", triageStatus: "disabled" });
  assert.equal(task.triageStatus, "disabled");
  assert.equal(store.pendingTriage().length, 0);
});

test("manual Task placement is not overwritten by a late Spark result", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "посмотреть дюну" });
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-manual" });
  const triaged = store.applyTriage(task.id, {
    correctedText: "Посмотреть «Дюну»",
    category: "note",
    confidence: 0.98,
    bucket: "notes",
    autoPlace: true,
  });
  assert.equal(triaged.correctedText, "Посмотреть «Дюну»");
  assert.equal(triaged.bucket, "workspace");
  assert.equal(triaged.workspaceId, "workspace-manual");
  assert.equal(triaged.placementSource, "manual");
});
