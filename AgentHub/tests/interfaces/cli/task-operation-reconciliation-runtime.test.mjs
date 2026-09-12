import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openTaskOperationReconciliationStores } from "../../../src/interfaces/cli/task-operation-reconciliation-runtime.mjs";

test("operator reconciliation store composition waits for a live Hub writer", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-operation-reconcile-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const initial = await openTaskOperationReconciliationStores({ databaseFile });
  initial.taskBoardStore.close();
  initial.workspaceCatalogStore.close();

  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const release = setTimeout(() => blocker.exec("COMMIT"), 60);
  let opened;
  t.after(async () => {
    clearTimeout(release);
    opened?.taskBoardStore.close();
    opened?.workspaceCatalogStore.close();
    try { blocker.exec("ROLLBACK"); } catch {}
    blocker.close();
    await rm(directory, { recursive: true, force: true });
  });

  opened = await openTaskOperationReconciliationStores({ databaseFile, timeoutMs: 1_000 });
  assert.equal(opened.workspaceCatalogStore.hierarchy().length, 1);
});

test("operator reconciliation store composition closes partial stores and preserves non-contention failures", async () => {
  let catalogClosed = 0;
  const failure = new Error("schema mismatch");
  await assert.rejects(openTaskOperationReconciliationStores({
    databaseFile: "unused.sqlite",
    createWorkspaceCatalogStore: () => ({ load: async () => {}, close: () => { catalogClosed += 1; } }),
    createTaskBoardStore: () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(catalogClosed, 1);
});
