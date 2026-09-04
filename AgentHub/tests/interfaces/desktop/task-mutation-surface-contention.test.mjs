import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { DesktopTaskBoardController } from "../../../src/interfaces/desktop/desktop-task-board-controller.mjs";

test("Desktop ingest retries the owning Task transaction without duplicate effect or blocking HTTP", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-surface-contention-"));
  const databaseFile = path.join(root, "hub.sqlite");
  const workspaceCatalog = new WorkspaceCatalogStore({ databaseFile });
  await workspaceCatalog.load();
  const taskStore = new TaskBoardStore({ databaseFile });
  const taskBoard = new TaskBoardService({ store: taskStore, workspaceCatalog });
  const controller = new DesktopTaskBoardController({
    taskBoard,
    workspaceCatalog,
    taskLauncher: { start: async () => { throw new Error("not used"); } },
    snapshot: async () => ({ tasks: taskBoard.snapshot() }),
  });
  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const server = http.createServer((_request, response) => response.end("responsive"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let timerFired = false;
  const release = setTimeout(() => {
    timerFired = true;
    blocker.exec("COMMIT");
  }, 80);
  context.after(async () => {
    clearTimeout(release);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { blocker.close(); } catch {}
    taskStore.close();
    workspaceCatalog.close();
    await rm(root, { recursive: true, force: true });
  });

  const pending = controller.ingest({
    text: "one exact effect",
    sourceKey: "telegram:1:100",
    sourceDetails: { chatId: 1, messageId: 100, userId: 7 },
  });
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(await response.text(), "responsive");
  const first = await pending;
  const second = await controller.ingest({
    text: "one exact effect",
    sourceKey: "telegram:1:100",
    sourceDetails: { chatId: 1, messageId: 100, userId: 7 },
  });

  assert.equal(timerFired, true);
  assert.equal(second.taskId, first.taskId);
  assert.equal(taskBoard.snapshot().filter((task) => task.sourceDetails?.messageId === 100).length, 1);
  assert.ok(taskBoard.mutationDiagnostics().retries > 0);
});
