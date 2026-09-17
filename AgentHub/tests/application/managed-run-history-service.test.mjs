import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRunHistoryService } from "../../src/application/managed-run-history-service.mjs";

function fixture({ terminalCommits = null } = {}) {
  const history = [];
  const snapshots = [];
  const telemetry = [];
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
    telemetryStore: { upsert: async (value) => telemetry.push(value) },
    terminalCommits,
    logger: { error() {} },
  });
  return { service, history, snapshots, telemetry };
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
    responseAnnotationReferences: [{ index: 1 }],
    activities: [],
  }, { active: false, status: "completed", answer: "final" });
  assert.equal(setup.history[0].messages.length, 1);
  assert.equal(setup.history[0].messages[0].text, "final");
  assert.deepEqual(setup.history[0].messages[0].responseAnnotationReferences, [{ index: 1 }]);
  assert.equal(setup.history[0].completedAt, "2026-08-05T12:00:00.000Z");
  assert.equal(setup.snapshots[0].snapshot.executionOwner, null);
  assert.equal(setup.telemetry.length, 0);
});

test("terminal history projects generated ideate images on the final agent message", async () => {
  const setup = fixture();
  setup.service.mergeActiveHistory = (target, input) => target.push({
    id: input.turnId,
    messages: [{ itemId: `${input.turnId}:user`, role: "user", text: "Три концепта" }],
  });
  await setup.service.persist({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-ideate",
    responseText: "",
    responseAttachments: [
      { id: "codex-generated-one.png", type: "image/png" },
      { id: "codex-generated-two.png", type: "image/png" },
      { id: "codex-generated-three.png", type: "image/png" },
    ],
  }, { active: false, status: "completed", answer: "Три концепта Rain" });

  const agent = setup.history[0].messages.find((message) => message.role === "agent");
  assert.equal(agent.text, "Три концепта Rain");
  assert.deepEqual(agent.attachments.map((attachment) => attachment.id), [
    "codex-generated-one.png",
    "codex-generated-two.png",
    "codex-generated-three.png",
  ]);
});

test("late active history is absorbed by the committed terminal revision", async () => {
  const setup = fixture({
    terminalCommits: {
      get: async () => ({ terminalRevision: 4, status: "completed" }),
    },
  });

  const result = await setup.service.persist({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    responseText: "late progress",
  });

  assert.deepEqual(result, { absorbed: true, terminalRevision: 4 });
  assert.deepEqual(setup.history, []);
  assert.deepEqual(setup.snapshots, []);
});

test("terminal history writes one provider telemetry snapshot", async () => {
  const setup = fixture();
  await setup.service.persist({
    id: "run-1",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "running",
    providerStart: {
      turnId: "turn-1",
      acceptedAt: "2026-08-05T11:59:50.000Z",
      firstEventAt: "2026-08-05T11:59:52.000Z",
      completedAtMs: 123,
      phase: "completed",
    },
  }, { active: false, status: "completed" });

  assert.equal(setup.telemetry.length, 1);
  assert.equal(setup.telemetry[0].turnId, "turn-1");
  assert.equal(setup.history[0].telemetry.turnId, "turn-1");
});


test("managed run history preserves a real user message equal to probe text", async () => {
  const setup = fixture();
  await setup.service.persist({
    provider: "codex",
    threadId: "thread-1",
    turnId: "user-turn",
    promptPreview: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1",
    responseText: "AGENT_HUB_CONTEXT_PROBE_OK_V1",
    userMessages: [{ text: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1" }],
  }, { active: false, status: "completed", answer: "AGENT_HUB_CONTEXT_PROBE_OK_V1" });

  assert.equal(setup.history.length, 1);
  assert.equal(setup.snapshots.length, 1);
});

test("managed run history preserves an ordinary Claude turn containing automatic compaction", async () => {
  const setup = fixture();
  await setup.service.persist({
    provider: "claude",
    threadId: "claude-thread",
    turnId: "claude-user-turn",
    promptPreview: "Продолжай работу",
    responseText: "Готово",
    userMessages: [{ clientUserMessageId: "client-claude-1", text: "Продолжай работу" }],
    claudeCompactionBoundary: {
      origin: "automatic",
      preTokens: 180_000,
      postTokens: 42_000,
    },
  }, { active: false, status: "completed", answer: "Готово" });

  assert.equal(setup.history.length, 1);
  assert.equal(setup.history[0].id, "claude-user-turn");
  assert.equal(setup.snapshots.length, 1);
});
