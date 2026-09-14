import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";

test("exact provider-turn reads retain dedicated identity across restart and concurrent WAL writes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-maintenance-turn-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = new MaintenanceOperationStore({ dataDir: directory });
  const operation = original.create({
    kind: "context-compaction", streamId: "stream-1", threadId: "thread-1",
    providerTurnId: "dedicated-turn", metadata: { dedicatedProviderTurn: true },
    status: "succeeded", phase: "completed",
  });
  const restored = new MaintenanceOperationStore({ dataDir: directory });
  assert.equal(restored.get(operation.operationId).status, "succeeded");
  const writer = new DatabaseSync(path.join(directory, "runtime.sqlite"));
  try {
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("UPDATE maintenance_operations SET status = 'failed' WHERE operation_id = ?")
      .run(operation.operationId);
    const identity = { kind: "context-compaction", threadId: "thread-1", providerTurnId: "dedicated-turn" };
    const exact = restored.forProviderTurn(identity);
    assert.equal(exact.operationId, operation.operationId);
    assert.equal(exact.metadata.dedicatedProviderTurn, true);
    assert.equal(exact.status, "succeeded");
    assert.equal(restored.get(operation.operationId).status, "succeeded");
    assert.equal(restored.forProviderTurn({ ...identity, threadId: "thread-2" }), null);
    assert.equal(restored.forProviderTurn({ ...identity, providerTurnId: "inline-turn" }), null);
    assert.equal(restored.forProviderTurn({ ...identity, kind: "restart" }), null);
    assert.equal(restored.forProviderTurn({ ...identity, providerTurnId: "" }), null);
    assert.throws(() => restored.create({
      operationId: "blocked-write", kind: "context-compaction", streamId: "stream-1",
      threadId: "thread-1", providerTurnId: "next-turn",
    }), /database is locked|SQLITE_BUSY/u);
    assert.equal(restored.get("blocked-write"), null);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  assert.equal(restored.create({
    operationId: "blocked-write", kind: "context-compaction", streamId: "stream-1",
    threadId: "thread-1", providerTurnId: "next-turn",
  }).revision, 1, "retry after writer release keeps the original operation identity");
});

test("process death recovers running work as unknown, never as running fact", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-maintenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const times = [
    "2026-08-25T10:00:00.000Z",
    "2026-08-25T10:01:00.000Z",
  ];
  const store = new MaintenanceOperationStore({
    dataDir: directory,
    idFactory: () => "operation-crash",
    now: () => times.shift() ?? "2026-08-25T10:02:00.000Z",
  });
  const started = store.create({
    kind: "context-compaction",
    streamId: "stream-1",
    threadId: "thread-1",
    status: "running",
    phase: "compacting",
  });

  const recovered = store.recoverInterrupted({ operationIds: [started.operationId] });

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "reconciling");
  assert.equal(recovered[0].outcome, "unknown");
  assert.equal(recovered[0].revision, 2);
  assert.deepEqual(recovered[0].blockers, ["authoritative-state-unknown"]);
  assert.equal(store.activeFor({
    kind: "context-compaction",
    streamId: "stream-1",
    threadId: "thread-1",
  })?.status, "reconciling");
});

test("a reordered stale transition cannot overwrite a newer revision", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-maintenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MaintenanceOperationStore({
    dataDir: directory,
    idFactory: () => "operation-reorder",
  });
  const started = store.create({
    kind: "restart",
    streamId: "stream-1",
    threadId: "thread-1",
    status: "running",
    phase: "cutover",
  });
  const unknown = store.transition(started.operationId, {
    status: "reconciling",
    phase: "reconciling",
    blockers: ["authoritative-state-unknown"],
    outcome: "unknown",
  }, { expectedRevision: 1 });
  const stale = store.transition(started.operationId, {
    status: "succeeded",
    phase: "completed",
  }, { expectedRevision: 1 });

  assert.equal(unknown.applied, true);
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale-revision");
  assert.equal(store.get(started.operationId).status, "reconciling");
});

test("legacy restart migration is guarded and keeps exact scope", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-maintenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let nextId = 0;
  const store = new MaintenanceOperationStore({
    dataDir: directory,
    idFactory: () => "legacy-" + (++nextId),
  });
  const legacy = {
    requestedAt: "2026-08-25T09:00:00.000Z",
    waitingForRuns: true,
    chatId: 10,
    messageId: 20,
  };

  const migrated = store.migrateLegacyRestart(legacy, {
    streamId: "stream-exact",
    threadId: "thread-exact",
  });
  const repeated = store.migrateLegacyRestart(legacy, {
    streamId: "stream-other",
    threadId: "thread-other",
  });

  assert.equal(migrated.streamId, "stream-exact");
  assert.equal(migrated.threadId, "thread-exact");
  assert.equal(migrated.status, "blocked");
  assert.equal(repeated, null);
  assert.equal(nextId, 1);
});

test("restart recovery lookup never crosses Stream or Thread scope", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-maintenance-scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MaintenanceOperationStore({ dataDir: directory });
  store.create({
    operationId: "restart-scope-a",
    kind: "restart",
    streamId: "stream-a",
    threadId: "thread-a",
  });

  assert.equal(store.latestRestart({ streamId: "stream-b", threadId: "thread-a" }), null);
  assert.equal(store.latestRestart({ streamId: "stream-a", threadId: "thread-b" }), null);
  assert.equal(
    store.latestRestart({ streamId: "stream-a", threadId: "thread-a" })?.operationId,
    "restart-scope-a",
  );
});
