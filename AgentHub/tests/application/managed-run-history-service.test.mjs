import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRunHistoryService } from "../../src/application/managed-run-history-service.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../src/domain/codex-context-probe.mjs";

function fixture() {
  const history = [];
  const snapshots = [];
  const service = new ManagedRunHistoryService({
    taskSyncStore: {
      history: () => history,
      recordHistory: (_run, value, snapshot) => snapshots.push({ value, snapshot }),
      save: async () => {},
    },
    mergeActiveHistory: (target, input) => target.push({
      id: input.turnId,
      active: true,
      completed: false,
      messages: [],
    }),
    hubExecutionOwner: "telegram",
    nowIso: () => "2026-08-05T12:00:00.000Z",
    nowMs: () => 123,
    logger: { error() {} },
  });
  return { service, history, snapshots };
}

test("managed run history persists one active turn with HUB ownership", async () => {
  const setup = fixture();
  await setup.service.persist({
    threadId: "thread-1",
    turnId: "turn-1",
    responseText: "working",
    activities: [{ id: "a" }],
    activityGroups: [{ id: "commentary-1", reasoning: "Проверяю.", activities: [{ id: "a" }] }],
  });
  assert.equal(setup.history.length, 1);
  assert.equal(setup.history[0].activityGroups[0].reasoning, "Проверяю.");
  assert.deepEqual(setup.snapshots[0].snapshot, {
    active: true,
    turnId: "turn-1",
    activityAtMs: 123,
    stage: undefined,
    answer: "working",
    executionOwner: "telegram",
  });
});

test("terminal history replaces the matching agent item without duplicating it", async () => {
  const setup = fixture();
  setup.history.push({
    id: "turn-1",
    messages: [{ itemId: "answer-1", role: "agent", text: "partial" }],
  });
  // The real merger updates the existing turn; model that contract here.
  setup.service.mergeActiveHistory = () => {};
  await setup.service.persist({
    threadId: "thread-1",
    turnId: "turn-1",
    responseItemId: "answer-1",
    responseText: "partial",
    activities: [],
  }, { active: false, status: "completed", answer: "final" });
  assert.equal(setup.history[0].messages.length, 1);
  assert.equal(setup.history[0].messages[0].text, "final");
  assert.equal(setup.history[0].completedAt, "2026-08-05T12:00:00.000Z");
  assert.equal(setup.snapshots[0].snapshot.executionOwner, null);
});

test("managed run history never persists an internal context probe", async () => {
  const setup = fixture();
  await setup.service.persist({
    provider: "codex",
    threadId: "thread-1",
    turnId: "probe-turn",
    promptPreview: CODEX_CONTEXT_PROBE_PROMPT,
    responseText: "stale previous answer",
    clientUserMessageId: "agent-hub-context-probe:test",
    userMessages: [{
      clientUserMessageId: "agent-hub-context-probe:test",
      text: CODEX_CONTEXT_PROBE_PROMPT,
    }],
  });

  assert.deepEqual(setup.history, []);
  assert.deepEqual(setup.snapshots, []);
});

test("managed run history preserves a real user message equal to probe text", async () => {
  const setup = fixture();
  await setup.service.persist({
    provider: "codex",
    threadId: "thread-1",
    turnId: "user-turn",
    promptPreview: CODEX_CONTEXT_PROBE_PROMPT,
    responseText: CODEX_CONTEXT_PROBE_RESPONSE,
    userMessages: [{ text: CODEX_CONTEXT_PROBE_PROMPT }],
  }, { active: false, status: "completed", answer: CODEX_CONTEXT_PROBE_RESPONSE });

  assert.equal(setup.history.length, 1);
  assert.equal(setup.snapshots.length, 1);
});
