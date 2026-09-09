import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

import { ManagedRunHistoryService } from "../../src/application/managed-run-history-service.mjs";

const run = {
  id: "run-1", provider: "codex", threadId: "thread-1", turnId: "turn-1",
  clientUserMessageId: "original-command", responseText: "Final answer",
  providerStart: { turnId: "turn-1", phase: "completed", completedAtMs: 123 },
};

function fixture(upsert) {
  const saved = [];
  const errors = [];
  const history = [];
  const service = new ManagedRunHistoryService({
    taskSyncStore: {
      history: () => history,
      recordHistory: async (_run, value) => { saved.push(structuredClone(value)); },
      save: async () => {},
    },
    mergeActiveHistory: (target, input) => target.push({ id: input.turnId, messages: [] }),
    telemetryStore: { upsert },
    hubExecutionOwner: "hub",
    nowIso: () => "2026-09-10T00:00:00.000Z",
    nowMs: () => 123,
    logger: { error: (...args) => errors.push(args) },
  });
  return { service, saved, errors };
}

test("pending optional telemetry index cannot hold committed terminal history", { timeout: 1_000 }, async () => {
  let resolveIndex;
  const pending = new Promise((resolve) => { resolveIndex = resolve; });
  let observedTelemetry;
  const setup = fixture((telemetry) => {
    observedTelemetry = telemetry;
    assert.equal(setup.saved.length, 1, "canonical history precedes optional indexing");
    return pending;
  });
  try {
    const result = await setup.service.persist(run, { active: false, status: "completed", terminalRevision: 7 });
    assert.deepEqual(result, { absorbed: false, terminalRevision: 7 });
    assert.equal(setup.saved[0][0].completed, true);
    assert.equal(setup.saved[0][0].answer, "Final answer");
    assert.deepEqual(setup.saved[0][0].telemetry, observedTelemetry);
    assert.equal(observedTelemetry.turnId, "turn-1");
    assert.deepEqual(setup.errors, []);
  } finally {
    resolveIndex();
  }
});

test("busy optional telemetry index is logged separately without failing terminal history", async () => {
  const setup = fixture(() => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  });
  const result = await setup.service.persist(run, { active: false, status: "completed", terminalRevision: 7 });
  await nextTurn();
  assert.deepEqual(result, { absorbed: false, terminalRevision: 7 });
  assert.equal(setup.saved[0][0].telemetry.turnId, "turn-1");
  assert.equal(setup.saved[0][0].terminalRevision, 7);
  assert.deepEqual(setup.errors, [[
    "Cannot index provider turn telemetry thread-1/turn-1:", "database is locked",
  ]]);
});
