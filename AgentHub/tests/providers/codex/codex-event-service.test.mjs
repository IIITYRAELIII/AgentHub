import assert from "node:assert/strict";
import test from "node:test";
import { CodexEventService } from "../../../src/providers/codex/codex-event-service.mjs";
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
    isCompactionItem: () => false, contextUsage: () => null,
    beginCompaction: noop, getCompaction: () => null,
    rememberRawCompactionItem: noop,
    beginCompactionCleanup: noop, setStage: noop, describeItem: () => "stage",
    itemActivity: () => null, requestApproval: async () => {}, formatCommandApproval: () => "",
    formatFileApproval: () => "", formatPermissionsApproval: () => "", requestMcpElicitation: async () => {},
    requestUserInput: async () => {}, reduceLiveItemEvent: () => null,
    startLiveItem: () => null, completeLiveItem: () => null,
    discardContextCompaction: async () => false, consumeTracker: () => null,
    finishObserved: async () => {}, turnSnapshot: () => ({}), completeManaged: async () => {},
    turnTokenUsage: new Map(), speechButtons: new Map(), temporaryFiles: new Map(),
    taskDiffs: { remember: noop }, ...overrides,
  });
}

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

test("Codex event service completes a managed run through the coordinator", async () => {
  const run = { responseText: "", status: "running", observer: false };
  const completed = [];
  const service = createService(run, { completeManaged: async (...args) => completed.push(args) });
  await service.handle({ method: "turn/completed", params: { turn: { id: "turn-1" } } });
  assert.equal(completed.length, 1);
  assert.equal(completed[0][1].completedTurnId, "turn-1");
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
