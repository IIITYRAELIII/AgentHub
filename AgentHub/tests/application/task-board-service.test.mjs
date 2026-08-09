import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t, classify) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskBoardStore({ databaseFile: path.join(directory, "journal.sqlite") });
  const workspaces = [{ id: "agent-hub", name: "Agent Hub", streams: [] }];
  const workspaceCatalog = {
    hierarchy: () => workspaces,
    workspace: (id) => workspaces.find((item) => item.id === id) ?? null,
    stream: () => null,
  };
  return new TaskBoardService({ store, workspaceCatalog, classify, autoPlaceConfidence: 0.82 });
}

test("Spark correction and confident Workspace suggestion place a Task automatically", async (t) => {
  const service = await fixture(t, async () => ({
    correctedText: "Исправить дашборд Agent Hub",
    category: "task",
    workspaceId: "agent-hub",
    confidence: 0.94,
    reason: "Упомянут Agent Hub",
  }));
  const created = service.create({ text: "исправить дашборд агент хаб" });
  await service.waitForTriage();
  const task = service.task(created.id);
  assert.equal(task.correctedText, "Исправить дашборд Agent Hub");
  assert.equal(task.bucket, "workspace");
  assert.equal(task.workspaceId, "agent-hub");
});

test("uncertain Spark suggestion leaves a Task in the backlog", async (t) => {
  const service = await fixture(t, async () => ({
    correctedText: "Что-то проверить",
    category: "unknown",
    workspaceId: null,
    confidence: 0.31,
    reason: "Не хватает контекста",
  }));
  const created = service.create({ text: "чтото проверить" });
  await service.waitForTriage();
  const task = service.task(created.id);
  assert.equal(task.bucket, "backlog");
  assert.equal(task.triageStatus, "completed");
});

test("disabled Spark leaves new Tasks idle and clears recovered triage", () => {
  let disabled = 0;
  const created = [];
  const service = new TaskBoardService({
    store: {
      create: (value) => {
        created.push(value);
        return { id: "task-disabled", triageStatus: value.triageStatus };
      },
      task: () => null,
      list: () => [],
      move: () => null,
      markStarted: () => null,
      disablePendingTriage: () => { disabled += 1; },
    },
    workspaceCatalog: { hierarchy: () => [] },
    autoPlaceConfidence: 0,
  });
  const task = service.create({ text: "Без классификации" });
  service.recoverPendingTriage();
  assert.equal(task.triageStatus, "disabled");
  assert.equal(created[0].triageStatus, "disabled");
  assert.equal(service.autoPlaceConfidence, 0);
  assert.equal(disabled, 1);
});
