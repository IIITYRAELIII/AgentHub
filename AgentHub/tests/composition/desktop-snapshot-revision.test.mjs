import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecentRestartFailure } from "../../src/application/restart-failure-notice.mjs";
import { createDesktopSnapshotRevision } from "../../src/composition/desktop-snapshot-revision.mjs";
import { RESTART_FAILURE_NOTICE_WINDOW_MS } from "../../src/domain/maintenance-operation.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";

function dependencies(overrides = {}) {
  return {
    pendingInputs: new Map(),
    queuedInputs: new Map(),
    approvalController: { pending: new Map() },
    hostState: { restartRequest: null, autoApprove: false },
    contextCompactions: { runningCount: () => 0 },
    taskCatalogService: { entries: [], snapshotRevision: 7 },
    streamMaintenance: { entry: () => null },
    taskRuns: { revision: 3 },
    selectionStore: { revision: 5 },
    agentPreferences: { snapshot: () => ({ model: "gpt-test" }) },
    modelCatalogRevision: () => 0,
    taskBoard: { snapshotRevision: 11 },
    lastTaskMessageRevision: () => 13,
    taskReadStateStore: { revision: 17 },
    desktopMessageReceipts: { revision: 19 },
    messagePins: { revision: 23 },
    taskSyncStore: { revision: 29 },
    usdRubRateStore: { snapshot: () => null },
    serverControlController: { snapshot: async () => ({ status: "ready" }) },
    recentRestartFailure: () => null,
    ...overrides,
  };
}

test("the desktop snapshot revision follows the recent restart failure owner", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-snapshot-revision-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let clock = Date.parse("2026-09-13T20:00:00.000Z");
  const store = new MaintenanceOperationStore({ dataDir: directory, now: () => new Date(clock).toISOString() });
  const revision = createDesktopSnapshotRevision(dependencies({
    recentRestartFailure: createRecentRestartFailure({ operations: store, now: () => clock }),
  }));
  const settleRestart = (succeeded) => {
    const operation = store.create({
      kind: "restart", streamId: "stream-1", threadId: "thread-1", status: "requested", phase: "requested",
    });
    clock += 1_000;
    store.settle(operation.operationId, {
      succeeded,
      phase: succeeded ? "completed" : "failed",
      metadata: succeeded ? {} : { error: "replacement bot 84 exited before becoming ready" },
    });
  };

  const idle = await revision();
  assert.equal(await revision(), idle, "unchanged sources keep the revision stable");

  settleRestart(false);
  const failed = await revision();
  assert.notEqual(failed, idle, "a settled failure invalidates the cached revision");

  clock += 60_000;
  settleRestart(true);
  const recovered = await revision();
  assert.notEqual(recovered, failed, "a later success changes the revision again");
  assert.equal(recovered, idle);

  settleRestart(false);
  const expiring = await revision();
  assert.notEqual(expiring, idle);
  clock += RESTART_FAILURE_NOTICE_WINDOW_MS + 1_000;
  assert.equal(await revision(), expiring, "elapsed time cannot erase an undelivered failure");
});

test("transient work still disables the desktop snapshot revision", async () => {
  const revision = createDesktopSnapshotRevision(dependencies({
    hostState: { restartRequest: { operationId: "restart-1" }, autoApprove: false },
    recentRestartFailure: () => { throw new Error("not read while transient work is in flight"); },
  }));
  assert.equal(await revision(), null);
});

test("a completed model catalog refresh invalidates the Desktop notModified revision", async () => {
  let catalogRevision = 0;
  const revision = createDesktopSnapshotRevision(dependencies({
    modelCatalogRevision: () => catalogRevision,
  }));
  const before = await revision();
  catalogRevision += 1;
  assert.notEqual(await revision(), before);
});

test("canonical Task CRUD and Workspace mutations invalidate the real Desktop revision", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desktop-task-revision-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  const board = new TaskBoardService({ store, workspaceCatalog: catalog });
  t.after(async () => { board.close(); catalog.close(); await rm(directory, { recursive: true, force: true }); });
  const revision = createDesktopSnapshotRevision(dependencies({ taskBoard: board }));
  const before = await revision();
  assert.equal(await revision(), before, "read-only polling stays stable");
  const task = await board.create({ text: "New visible Task" });
  const created = await revision();
  assert.notEqual(created, before, "a new Task must not reuse the Desktop cache identity");
  assert.equal(JSON.parse(created).board, board.snapshotRevision);
  await board.update({ id: task.id, title: "Edited visible Task", description: "Preserved details" });
  const edited = await revision();
  assert.notEqual(edited, created, "Task presentation changes must reach Desktop");
  assert.equal(board.card(task.id).title, "Edited visible Task");
  catalog.createWorkspace({ name: "New Task column" });
  assert.notEqual(await revision(), edited, "Task column changes remain part of the canonical revision");
  assert.equal(await revision(), await revision());
});
