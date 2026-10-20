import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecentRestartFailure } from "../../src/application/restart-failure-notice.mjs";
import { createDesktopSnapshotRevision } from "../../src/composition/desktop-snapshot-revision.mjs";
import { RESTART_FAILURE_NOTICE_WINDOW_MS } from "../../src/domain/maintenance-operation.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";

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
