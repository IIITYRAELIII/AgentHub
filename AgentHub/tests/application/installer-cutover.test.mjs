import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { installerCutoverOperation, installerCutoverSnapshot } from "../../src/application/installer-cutover.mjs";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { DatabaseSync } from "node:sqlite";

function coordinatorPorts() {
  return { taskRuns: { forTask: () => null }, providers: { call: async () => {} },
    externalActivity: async () => ({ state: "inactive" }), repositoryConflict: async () => null,
    deferInput: async () => { throw Error("Unexpected deferred effect"); },
    beginRun: async () => { throw Error("Unexpected new run"); },
    rollbackAdmission: async () => {}, launchTurn: async () => { throw Error("Unexpected provider launch"); } };
}

test("installer original fences new inputs through the existing run owner while current completion remains available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-cutover-"));
  try {
    const dataDir = path.join(root, "data");
    await mkdir(dataDir);
    const store = new MaintenanceOperationStore({ dataDir });
    const threadId = process.platform === "win32" ? root.toLowerCase() : root;
    const current = { id: "old", status: "running", provider: "codex", threadId: "thread", turnId: "turn" };
    const queued = [];
    const coordinator = new RunCoordinator({
      ...coordinatorPorts(),
      taskRuns: { forTask: () => current.status === "running" ? current : null },
      providers: { call: async (provider, method, run) => {
        assert.equal(method, "completeManagedRun"); run.status = "completed";
      } },
      isRuntimeStopping: () => Boolean(installerCutoverOperation(store, dataDir)),
      deferInput: async (input, attachments, options) => {
        queued.push({ input, attachments, ...options });
        return { id: "queued-original", item: { id: "queued-original" } };
      },
      scheduleDeferred: () => {},
    });
    for (const mode of ["wait", "force"]) {
      current.status = "running";
      const original = store.create({ operationId: "installer-" + mode, kind: "restart",
        streamId: "agent-hub-installer", threadId, status: "running", phase: "installer-waiting",
        metadata: { autonomousInstaller: { runtimeRoot: root, mode } } });
      const result = await coordinator.submitClientInput({ input: "next", attachments: ["retained-image"],
        target: current, clientUserMessageId: "same-input-" + mode });
      assert.equal(result.reason, "runtime-restart");
      assert.equal(result.queued, true);
      assert.equal(queued.at(-1).clientUserMessageId, "same-input-" + mode);
      assert.deepEqual(queued.at(-1).attachments, ["retained-image"]);
      const snapshot = () => installerCutoverSnapshot({ operation: installerCutoverOperation(store, dataDir),
        runs: [current], pendingAdmission: coordinator.hasPendingAdmission(() => true) });
      assert.equal(snapshot().activeCount, 1);
      await coordinator.completeManaged(current, {});
      assert.equal(snapshot().activeCount, 0);
      assert.equal(snapshot().admissionClosed, true);
      store.transition(original.operationId, { status: "failed", phase: "installer-wait-refused", outcome: "wait-refused" },
        { expectedRevision: original.revision });
      assert.equal(coordinator.admissionBarrier(current), null);
    }
    assert.equal(queued.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("wait snapshot retains unknown execution and pending admission instead of declaring idle", async () => {
  const coordinator = new RunCoordinator(coordinatorPorts());
  let release;
  const pending = coordinator.withPendingAdmission({ threadId: "old" }, () => new Promise(resolve => { release = resolve; }));
  const snapshot = () => installerCutoverSnapshot({ operation: null,
    runs: [{ id: "unknown", status: "running", activityUnknown: true }, { status: "completed" }],
    maintenanceCount: 1, pendingAdmission: coordinator.hasPendingAdmission(() => true) });
  assert.deepEqual([snapshot().activeCount, snapshot().unknownCount, snapshot().pendingAdmission], [2, 1, true]);
  release(); await pending;
  assert.equal(snapshot().pendingAdmission, false);
});

test("fresh runtime SQLite without maintenance schema is readonly absence, malformed schema still refuses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-cutover-fresh-"));
  try {
    const dataDir = path.join(root, "data"); await mkdir(dataDir);
    const file = path.join(dataDir, "runtime.sqlite");
    const database = new DatabaseSync(file);
    try {
      database.exec("CREATE TABLE runtime_marker(value); INSERT INTO runtime_marker VALUES(71)");
      const store = new MaintenanceOperationStore({ dataDir });
      assert.equal(installerCutoverOperation(store, dataDir), null);
      assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='maintenance_operations'").get().count, 0);
      assert.equal(database.prepare("SELECT value FROM runtime_marker").get().value, 71);
      database.exec("CREATE TABLE maintenance_operations(broken)");
      assert.throws(() => installerCutoverOperation(store, dataDir));
      database.exec("DROP TABLE maintenance_operations; CREATE VIEW maintenance_operations AS SELECT 1 AS broken");
      assert.throws(() => installerCutoverOperation(store, dataDir), /schema type/);
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
