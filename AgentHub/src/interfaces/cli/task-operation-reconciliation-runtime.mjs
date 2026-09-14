import { performance } from "node:perf_hooks";

import { sqliteContention } from "../../infrastructure/persistence/async-sqlite-mutation-queue.mjs";
import { TaskBoardStore } from "../../infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../infrastructure/persistence/workspace-catalog-store.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function openTaskOperationReconciliationStores({
  databaseFile,
  timeoutMs = 10_000,
  createWorkspaceCatalogStore = (options) => new WorkspaceCatalogStore(options),
  createTaskBoardStore = (options) => new TaskBoardStore(options),
  waitForRetry = wait,
} = {}) {
  if (!databaseFile) throw new TypeError("databaseFile is required");
  const startedAt = performance.now();
  const deadline = startedAt + Math.max(1, Number(timeoutMs) || 10_000);
  let delayMs = 10;
  for (;;) {
    let workspaceCatalogStore;
    let taskBoardStore;
    try {
      workspaceCatalogStore = createWorkspaceCatalogStore({ databaseFile });
      taskBoardStore = createTaskBoardStore({ databaseFile });
      await workspaceCatalogStore.load();
      return { workspaceCatalogStore, taskBoardStore };
    } catch (error) {
      taskBoardStore?.close();
      workspaceCatalogStore?.close();
      if (!sqliteContention(error) || performance.now() >= deadline) throw error;
      const remainingMs = Math.max(1, deadline - performance.now());
      await waitForRetry(Math.min(delayMs, remainingMs));
      delayMs = Math.min(200, delayMs * 2);
    }
  }
}
