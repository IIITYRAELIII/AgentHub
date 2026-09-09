import assert from "node:assert/strict";
import test from "node:test";
import { CodexEventService } from "../../../src/providers/codex/codex-event-service.mjs";
import { ContextCompactionTracker, isContextCompactionItem } from "../../../src/providers/codex/context-compaction-tracker.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../../src/domain/codex-context-probe.mjs";

function createService(run, overrides = {}) {
  const noop = () => {};
  return new CodexEventService({
    invalidateThreadRead: noop, forEvent: () => run, reindexRun: noop,
    applyThreadSettings: noop, saveState: async () => {}, trackTokenUsage: noop,
    completeTurn: noop,
    taskKey: () => "task", isSelectedRun: () => false, setSelectedDiff: noop,
    appendActivity: noop, noteActivity: noop, scheduleProgress: noop, appendReasoning: noop,
    upsertReasoningBlock: noop, replaceActivityGroups: noop, turnActivityGroups: () => [],
    isCompactionItem: () => false, contextUsage: () => null,
    beginCompaction: noop, getCompaction: () => null, settleCompactionTurn: noop,
    rememberRawCompactionItem: noop,
    beginCompactionCleanup: noop, setStage: noop, describeItem: () => "stage",
    itemActivity: () => null, requestApproval: async () => {}, formatCommandApproval: () => "",
    formatFileApproval: () => "", formatPermissionsApproval: () => "", requestMcpElicitation: async () => {},
    observeMcpProgress: () => {},
    observeHubMcpBridge: async () => {},
    requestUserInput: async () => {}, reduceLiveItemEvent: () => null,
    startLiveItem: () => null, completeLiveItem: () => null,
    discardContextCompaction: async () => false, consumeTracker: () => null,
    finishObserved: async () => {}, turnSnapshot: () => ({}), completeManaged: async () => {},
    turnTokenUsage: new Map(), speechButtons: new Map(), temporaryFiles: new Map(),
    taskDiffs: { remember: noop }, ...overrides,
  });
}

test("terminal turn recovers its exact compaction item when the separate completion event was lost", async () => {
  const tracker = new ContextCompactionTracker();
  tracker.begin("thread-recover", { turnId: "turn-recover", itemId: "compaction-recover" });
  const service = createService(null, {
    isCompactionItem: isContextCompactionItem,
    getCompaction: (id) => tracker.get(id),
    beginCompactionCleanup: (id, details) => tracker.mutate(id, () => tracker.complete(id, details)),
    settleCompactionTurn: (id, details) => tracker.mutate(id, () => tracker.settleProviderTurn(id, details)),
  });
  try {
    await service.handle({ method: "turn/completed", params: {
      threadId: "thread-recover", turn: { id: "turn-recover", status: "completed",
        items: [{ id: "compaction-recover", type: "contextCompaction" }] },
    } });
    assert.equal(tracker.get("thread-recover").status, "completed");
    assert.equal(tracker.get("thread-recover").itemId, "compaction-recover");
    tracker.begin("thread-recover", { turnId: "new-turn", itemId: "new-item" });
    await service.handle({ method: "turn/completed", params: {
      threadId: "thread-recover", turn: { id: "turn-recover", status: "completed",
        items: [{ id: "compaction-recover", type: "contextCompaction" }] },
    } });
    assert.equal(tracker.get("thread-recover").status, "running");
    assert.equal(tracker.get("thread-recover").turnId, "new-turn");
  } finally { tracker.dispose(); }
});

test("Codex event service reduces answer deltas into the exact item", async () => {
  const run = { responseText: "", status: "running" };
  let scheduled = false;
  const service = createService(run, { scheduleProgress: () => { scheduled = true; } });
  await service.handle({
    method: "item/agentMessage/delta",
    params: { turnId: "t1", itemId: "answer-1", delta: "Ответ" },
  });
  assert.equal(run.responseText, "Ответ");
  assert.equal(run.responseItemId, "answer-1");
  assert.equal(run.responseItems[0].text, "Ответ");
  assert.equal(scheduled, true);
});

test("Codex event service forwards structured user input requests", async () => {
  const run = { status: "running" };
  const requests = [];
  const activities = [];
  const service = createService(run, {
    requestUserInput: (...args) => requests.push(args),
    appendActivity: (_run, activity) => activities.push(activity),
  });
  const params = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "input-1",
    questions: [{ id: "choice", question: "Как продолжить?" }],
    isBlocking: true,
  };
  await service.handle({ id: 17, method: "item/tool/requestUserInput", params });
  assert.deepEqual(requests, [[17, params, run]]);
  assert.equal(activities.at(-1).status, "waiting");
});

test("Codex event service settles MCP admission only on later exact-turn progress", async () => {
  const run = { id: "run-1", status: "running", threadId: "thread-1", turnId: "turn-1" };
  const requests = [];
  const progress = [];
  const service = createService(run, {
    requestMcpElicitation: (...args) => requests.push(args),
    observeMcpProgress: (event) => progress.push(event),
  });
  const params = {
    serverName: "agent_hub",
    threadId: "thread-1",
    turnId: "turn-1",
    mode: "form",
  };

  await service.handle({ id: 21, method: "mcpServer/elicitation/request", params });
  assert.deepEqual(requests, [[21, params, run]]);
  assert.deepEqual(progress, []);

  await service.handle({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "tool-1", type: "mcpToolCall", status: "completed" },
    },
  });
  assert.deepEqual(progress, [{
    threadId: "thread-1",
    turnId: "turn-1",
    method: "item/completed",
  }]);
});

test("Codex event service hands a failed dynamic Hub call to bridge recovery", async () => {
  const run = { id: "run-1", status: "running", threadId: "thread-1", turnId: "turn-1" };
  const recovered = [];
  const service = createService(run, {
    observeHubMcpBridge: async (event) => recovered.push(event),
  });
  const item = {
    id: "call-1",
    type: "dynamicToolCall",
    tool: "exec",
    arguments: "await tools.mcp__agent_hub__hub_task_get({ task_id: 'task-1' })",
    status: "failed",
    success: false,
  };

  await service.handle({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item },
  });

  assert.deepEqual(recovered, [{ method: "item/completed", item, run }]);
});

test("Codex event service applies canonical completed agent messages", async () => {
  const run = { responseText: "Черновик", status: "running" };
  const service = createService(run);
  await service.handle({
    method: "item/completed",
    params: {
      turnId: "t1",
      item: { id: "answer-1", type: "agentMessage", phase: "final_answer", text: "Готово" },
    },
  });
  assert.equal(run.responseText, "Готово");
  assert.equal(run.responseItems[0].status, "completed");
});

test("Codex event service exposes commentary as a live reasoning block", async () => {
  const run = {
    provider: "codex",
    responseText: "",
    responseItems: [],
    status: "running",
    providerStart: {
      state: "accepted-awaiting-first-event",
      turnId: "t1",
      acceptedAt: "2026-08-15T00:00:00.000Z",
    },
  };
  const blocks = [];
  const service = createService(run, {
    upsertReasoningBlock: (_run, block) => blocks.push(block),
  });
  await service.handle({
    method: "item/started",
    params: { turnId: "t1", item: { id: "comment-1", type: "agentMessage", phase: "commentary" } },
  });
  assert.equal(run.providerStart.state, "observed");
  assert.equal(run.providerStart.firstEventMethod, "item/started");
  assert.equal(run.providerStart.phase, "reasoning");
  assert.equal(run.providerStart.lastEventMethod, "item/started");
  await service.handle({
    method: "item/agentMessage/delta",
    params: { turnId: "t1", itemId: "comment-1", delta: "Проверяю." },
  });
  assert.deepEqual(blocks.at(-1), { id: "comment-1", text: "Проверяю." });
  assert.equal(run.providerStart.phase, "reasoning");
  assert.equal(Number.isFinite(run.providerStart.firstContentAtMs), true);
});

test("Codex event service completes a managed run through the coordinator", async () => {
  const run = { responseText: "", status: "running", observer: false };
  const completed = [];
  const service = createService(run, { completeManaged: async (...args) => completed.push(args) });
  await service.handle({ method: "turn/completed", params: { turn: { id: "turn-1" } } });
  assert.equal(completed.length, 1);
  assert.equal(completed[0][1].completedTurnId, "turn-1");
});

test("Codex event service settles an interrupted compaction provider turn", async () => {
  const settled = [];
  const service = createService(null, {
    settleCompactionTurn: (...args) => settled.push(args),
  });

  await service.handle({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "compaction-turn", status: "interrupted", items: [] },
    },
  });

  assert.deepEqual(settled, [["thread-1", {
    turnId: "compaction-turn",
    status: "interrupted",
  }]]);
});

test("Codex event service binds a promptless provider turn before its compaction item starts", async () => {
  const started = [];
  const service = createService(null, {
    getCompaction: () => ({
      id: "compaction-1",
      origin: "automatic",
      status: "running",
      turnId: null,
      beforePercent: 86,
    }),
    beginCompaction: (...args) => started.push(args),
  });

  await service.handle({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      startedAtMs: 123,
      turn: { id: "compaction-turn", status: "inProgress", items: [] },
    },
  });

  assert.deepEqual(started, [["thread-1", {
    origin: "automatic",
    turnId: "compaction-turn",
    startedAt: 123,
    beforePercent: 86,
  }]]);
});

test("Codex event service never rebinds an existing run to a context probe", async () => {
  const run = {
    threadId: "thread-1",
    turnId: "user-turn",
    responseText: "",
    status: "running",
    observer: false,
  };
  const reindexed = [];
  const completed = [];
  const contextCompletions = [];
  const warnings = [];
  const probeTurn = {
    id: "probe-turn",
    status: "inProgress",
    items: [{
      type: "userMessage",
      clientId: "agent-hub-context-probe:probe-1",
      content: [{ type: "text", text: CODEX_CONTEXT_PROBE_PROMPT }],
    }],
  };
  const service = createService(run, {
    forEvent: ({ turnId, threadId, allowThreadFallback }) => (
      turnId === run.turnId || (allowThreadFallback && threadId === run.threadId) ? run : null
    ),
    reindexRun: (...args) => reindexed.push(args),
    completeManaged: async (...args) => completed.push(args),
    completeTurn: (...args) => contextCompletions.push(args),
    logWarn: (...args) => warnings.push(args),
  });

  await service.handle({
    method: "turn/started",
    params: { threadId: "thread-1", turn: probeTurn },
  });
  await service.handle({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        ...probeTurn,
        status: "completed",
        items: [
          ...probeTurn.items,
          { type: "agentMessage", text: CODEX_CONTEXT_PROBE_RESPONSE },
        ],
      },
    },
  });

  assert.equal(run.turnId, "user-turn");
  assert.deepEqual(reindexed, []);
  assert.deepEqual(completed, []);
  assert.deepEqual(contextCompletions, [["probe-turn", "completed"]]);
  assert.deepEqual(warnings, []);
});

test("Codex event service completes a real user turn equal to probe text", async () => {
  const run = { responseText: "", status: "running", observer: false };
  const completed = [];
  const service = createService(run, {
    completeManaged: async (...args) => completed.push(args),
  });
  await service.handle({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "user-turn",
        status: "completed",
        items: [{
          type: "userMessage",
          content: [{ type: "text", text: CODEX_CONTEXT_PROBE_PROMPT }],
        }, {
          type: "agentMessage",
          text: CODEX_CONTEXT_PROBE_RESPONSE,
        }],
      },
    },
  });

  assert.equal(completed.length, 1);
  assert.equal(completed[0][1].completedTurnId, "user-turn");
});

test("Codex event service preserves the raw compaction item for rotation", async () => {
  const captured = [];
  const service = createService(null, {
    rememberRawCompactionItem: (...args) => captured.push(args),
  });
  const item = { type: "compaction", encrypted_content: "opaque" };
  await service.handle({
    method: "rawResponseItem/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item },
  });
  assert.deepEqual(captured, [["thread-1", { turnId: "turn-1", item }]]);
});

test("Codex event service captures context usage when compaction starts", async () => {
  const captured = [];
  const service = createService(null, {
    isCompactionItem: (item) => item?.type === "contextCompaction",
    contextUsage: () => ({ usedTokens: 800, modelContextWindow: 1_000 }),
    beginCompaction: (...args) => captured.push(args),
  });
  await service.handle({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "compact-1", type: "contextCompaction" },
    },
  });
  assert.equal(captured[0][1].beforePercent, 80);
});

test("Codex event service does not treat compaction-only usage as prompt context", async () => {
  const captured = [];
  const service = createService(null, {
    getCompaction: () => ({ turnId: "compact-1", status: "completed" }),
    trackTokenUsage: (...args) => captured.push(args),
  });
  const params = {
    threadId: "thread-1",
    turnId: "compact-1",
    tokenUsage: {
      modelContextWindow: 258_400,
      last: {
        totalTokens: 158_033,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
    },
  };

  await service.handle({ method: "thread/tokenUsage/updated", params });

  assert.deepEqual(captured, [[params, { provisionalContext: true }]]);
});

test("Codex event service accepts the first real post-compaction context measurement", async () => {
  const captured = [];
  const service = createService(null, {
    getCompaction: () => ({ turnId: "compact-1", status: "completed" }),
    trackTokenUsage: (...args) => captured.push(args),
  });
  const params = {
    threadId: "thread-1",
    turnId: "turn-2",
    tokenUsage: {
      modelContextWindow: 258_400,
      last: { totalTokens: 81_978, inputTokens: 81_000, outputTokens: 978 },
    },
  };

  await service.handle({ method: "thread/tokenUsage/updated", params });

  assert.deepEqual(captured, [[params, { provisionalContext: false }]]);
});

test("Codex event service contains background state persistence failures", async () => {
  const errors = [];
  const service = createService({ status: "running" }, {
    saveState: async () => { throw new Error("state unavailable"); },
    logError: (...args) => errors.push(args),
  });

  await service.handle({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { activeFlags: [] } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, [["Cannot persist Codex event state:", "state unavailable"]]);
});
