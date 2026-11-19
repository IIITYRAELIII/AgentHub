import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { HubRuntimeStateCoordinator } from "../../src/application/hub-runtime-state-coordinator.mjs";
import { ProviderRunTerminalStore } from "../../src/infrastructure/persistence/provider-run-terminal-store.mjs";
import { TaskRunRegistry, persistedLocalExecutionIdentity } from "../../src/domain/task-runs.mjs";
import { restorePersistedTaskRun } from "../../src/composition/runtime-state-restoration-composition.mjs";

const savedRun = (extra = {}) => ({ id: "saved-run", provider: "codex", threadId: "original-thread",
  turnId: "original-turn", streamId: "stream", clientUserMessageId: "original-client",
  projectRoot: "D:/owned", status: "running", activityUnknown: true, executionOwner: "hub",
  responseText: "Retained partial", startedAt: "2026-11-18T10:00:00.000Z", ...extra });
const proof = () => ({ kind: "previous-hub-local-execution", source: "canonical-runtime-snapshot", restoredAt: new Date().toISOString() });

for (const extra of [{}, { provider: "claude" }, { observer: true, executionOwner: "external" }, { turnId: null, clientUserMessageId: null }]) {
  test(`previous local snapshot is retained without provider completion or admission (${JSON.stringify(extra)})`, async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-local-custody-"));
    try {
      const saved = savedRun(extra);
      const identity = persistedLocalExecutionIdentity(saved);
      const store = new ProviderRunTerminalStore({ dataDir });
      const record = await store.recordLocalExecutionRetirement({ identity, proof: proof() });
      const reopened = new ProviderRunTerminalStore({ dataDir });
      assert.deepEqual(reopened.getLocalExecutionRetirement(identity), record);
      if (saved.turnId) assert.equal(reopened.get(saved), null, "local disposition cannot manufacture provider terminal");
      const registry = new TaskRunRegistry();
      const restored = restorePersistedTaskRun(saved, null, reopened);
      registry.addRestored(restored, saved);
      assert.equal(registry.size, 0);
      assert.equal(registry.forTask(saved), null);
      assert.equal(registry.retainedValues().length, 1);
      assert.equal(restored.responseText, saved.responseText);
      assert.equal(restored.providerTerminalStatus, saved.providerTerminalStatus);
      assert.equal(restored.turnId, saved.turnId);
      const current = savedRun({ provider: saved.provider, id: "fresh-run", turnId: "fresh-turn", clientUserMessageId: "fresh-client" });
      registry.add(current);
      assert.equal(registry.forTask(saved), current);
      assert.equal(registry.forEvent({ turnId: saved.turnId }), saved.turnId ? restored : null);
      assert.equal(registry.releaseLocalAdmission(current, { identity: persistedLocalExecutionIdentity(current), proof: proof() }), false);
      assert.equal(registry.forTask(current), current, "a current process run has no restored custody provenance");
      const again = await reopened.recordLocalExecutionRetirement({ identity, proof: proof() });
      assert.deepEqual(again, record, "cold replay retains exact original disposition");
      assert.throws(() => reopened.getLocalExecutionRetirement({ ...identity, threadId: "foreign" }), /identity changed/u);
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
}

test("failed local disposition persistence cannot manufacture provider terminal or a release proof", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-local-write-refusal-"));
  let blocker;
  try {
    const saved = savedRun();
    const store = new ProviderRunTerminalStore({ dataDir, mutationTimeoutMs: 100 });
    const identity = persistedLocalExecutionIdentity(saved);
    assert.equal(store.getLocalExecutionRetirement(identity), null);
    blocker = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
    blocker.exec("BEGIN IMMEDIATE");
    await assert.rejects(store.recordLocalExecutionRetirement({ identity, proof: proof() }), /locked|busy|timed out/iu);
    blocker.exec("ROLLBACK");
    assert.equal(store.getLocalExecutionRetirement(identity), null);
    assert.equal(store.get(saved), null);
    assert.equal(saved.responseText, "Retained partial");
  } finally { blocker?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("a failed required local disposition aborts restoration without writing empty state", async () => {
  const saved = { activeRuns: [savedRun()], queuedInputs: [{ id: "original-queue", temporaryFiles: ["retained.png"] }] };
  let writes = 0;
  const failure = Object.assign(new Error("local disposition write refused"), { code: "ERR_LOCAL_EXECUTION_RETIREMENT" });
  const owner = new HubRuntimeStateCoordinator({
    store: { load: async () => ({ value: saved }), save: async () => { writes++; } },
    canonicalize: value => value, restoreSnapshot: async () => { throw failure; }, createSnapshot: () => ({}),
  });
  await assert.rejects(owner.restore(), error => error === failure);
  assert.equal(writes, 0);
  assert.equal(saved.activeRuns[0].id, "saved-run");
  assert.deepEqual(saved.queuedInputs[0].temporaryFiles, ["retained.png"]);
});
