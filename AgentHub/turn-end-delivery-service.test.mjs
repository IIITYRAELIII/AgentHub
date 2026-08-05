import assert from "node:assert/strict";
import test from "node:test";

import { TurnEndDeliveryService, fallbackTurnEndMessage } from "./src/application/turn-end-delivery-service.mjs";

function fixture({ completions = [], activeRun = null, projectResult = null } = {}) {
  const events = [];
  const delivered = new Set();
  const byKey = new Map(completions.map((value) => [value.turnId, value]));
  const notifications = {
    hasDelivered: (key) => delivered.has(key),
    markDelivered: (key) => { delivered.add(key); events.push(["delivered", key]); },
    values: () => completions,
    get: (identity) => byKey.get(identity.turnId) ?? null,
  };
  const service = new TurnEndDeliveryService({
    notifications,
    taskRuns: { forEvent: () => activeRun },
    projectTurn: async (...args) => { events.push(["project", ...args]); return projectResult; },
    rememberLastMessage: (...args) => events.push(["message", ...args]),
    rememberSeenTurn: (...args) => events.push(["seen", ...args]),
    saveState: async () => events.push(["save"]),
    logger: { error: (...args) => events.push(["error", ...args]) },
    now: () => 1_000,
    sleep: async () => {},
  });
  return { service, events, delivered };
}

test("fallbackTurnEndMessage uses canonical terminal wording", () => {
  assert.equal(fallbackTurnEndMessage("completed"), "Ход завершён.");
  assert.equal(fallbackTurnEndMessage("failed"), "Ход завершился с ошибкой.");
  assert.equal(fallbackTurnEndMessage("custom"), "Ход завершён со статусом custom.");
});

test("TurnEndDeliveryService projects and marks one exact completion", async () => {
  const completion = {
    hubTaskId: "hub-1",
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAnswer: "Final answer",
  };
  const state = fixture();
  assert.equal(await state.service.deliver(completion), true);
  assert.deepEqual(state.events.map(([name]) => name), ["project", "message", "seen", "delivered", "save"]);
  assert.equal(state.events[1][1].hubTaskId, "hub-1");
  assert.equal(await state.service.deliver(completion), false);
});

test("TurnEndDeliveryService does not project one completion concurrently twice", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const completion = {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
  };
  const state = fixture();
  state.service.projectTurn = () => gate;
  const first = state.service.deliver(completion);
  assert.equal(await state.service.deliver(completion), false);
  release(null);
  assert.equal(await first, true);
});

test("TurnEndDeliveryService keeps aggregate-only subagent turns out of task messages", async () => {
  const completion = {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "subagent",
    turnId: "turn-1",
    status: "completed",
    aggregateOnly: true,
  };
  const state = fixture();
  await state.service.deliver(completion);
  assert.equal(state.events.some(([name]) => name === "message"), false);
  assert.equal(state.events.some(([name]) => name === "seen"), false);
});

test("TurnEndDeliveryService retries only completions without an active run", async () => {
  const completion = {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
  };
  const blocked = fixture({ completions: [completion], activeRun: { status: "running" } });
  await blocked.service.retryPending();
  assert.equal(blocked.events.length, 0);

  const ready = fixture({ completions: [completion] });
  await ready.service.retryPending();
  assert.equal(ready.events.some(([name]) => name === "delivered"), true);
});

test("TurnEndDeliveryService returns an already accounted completion immediately", async () => {
  const completion = { turnId: "turn-1", usageReported: true };
  const state = fixture({ completions: [completion] });
  assert.equal(await state.service.waitForCompletion({ turnId: "turn-1" }), completion);
});
