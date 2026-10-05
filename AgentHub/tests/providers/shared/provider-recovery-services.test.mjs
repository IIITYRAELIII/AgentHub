import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeRecoveryService, CodexRecoveryService } from "../../../src/providers/provider-recovery-services.mjs";

test("Claude recovery reattaches only a live detached worker", async () => {
  const calls = [];
  const service = new ClaudeRecoveryService({
    attach: async () => calls.push("attach"),
    finishInterrupted: async () => calls.push("finish"),
  });
  await service.recover({ claudeOutputPath: "run.jsonl", observer: false, provider: "claude" });
  assert.deepEqual(calls, ["attach"]);
});

test("Codex recovery prepares its transport once for a provider batch", async () => {
  const calls = [];
  const noop = async () => {};
  const service = new CodexRecoveryService({
    transportRunning: () => false,
    readTaskSnapshot: noop,
    startTransport: async () => calls.push("start"),
    initialize: async (value) => calls.push(["initialize", value]),
    isCodex: () => true,
    finishInterrupted: noop,
    readThread: noop,
    autoApprove: () => true,
    restartRequested: () => false,
    finishProgress: noop,
    completeRun: noop,
    recoveredAnswer: () => "",
    setProgressStage: () => {},
    launchTurn: noop,
    reindexRun: () => {},
    scheduleObservedRun: () => {},
    startTyping: () => {},
    saveState: noop,
    telegram: noop,
    consumeTracker: () => null,
    finalizeDelivery: noop,
    turnTokenUsage: new Map(),
  });
  await service.prepare([{}]);
  assert.deepEqual(calls, ["start", ["initialize", { attachSelectedThread: true }]]);
});

test("Codex restart with unavailable transport retains the original run without a false interrupted final", async () => {
  const calls = [];
  const service = new CodexRecoveryService({
    transportRunning: () => false, readTaskSnapshot: async () => null,
    startTransport: async () => {}, initialize: async () => {}, isCodex: () => true,
    finishInterrupted: async () => calls.push("interrupted"),
    readThread: async () => calls.push("rpc"), autoApprove: () => false,
    restartRequested: () => false, finishProgress: async () => {},
    completeRun: async () => calls.push("complete"), recoveredAnswer: () => "",
    setProgressStage: () => calls.push("unknown"), launchTurn: async () => {},
    reindexRun: () => {}, scheduleObservedRun: () => calls.push("observe"),
    startTyping: () => {}, saveState: async () => calls.push("save"),
    telegram: async () => {}, consumeTracker: () => null,
    finalizeDelivery: async () => calls.push("deliver"), turnTokenUsage: new Map(),
  });
  await service.recover({ provider: "codex", threadId: "thread-1", turnId: "turn-1" });
  assert.deepEqual(calls, ["unknown", "observe", "save"]);
});

test("Codex recovery never substitutes another turn for an exact saved receipt", async () => {
  const calls = [];
  const noop = async () => {};
  const service = new CodexRecoveryService({
    transportRunning: () => true,
    readTaskSnapshot: noop,
    startTransport: noop,
    initialize: noop,
    isCodex: () => true,
    finishInterrupted: noop,
    readThread: async (_threadId, { applySnapshot }) => applySnapshot({
      thread: {
        status: { type: "idle" },
        turns: [{ id: "old-turn", status: "completed", items: [] }],
      },
    }),
    autoApprove: () => true,
    restartRequested: () => false,
    finishProgress: async (_run, stage) => calls.push(["finish", stage]),
    completeRun: async () => calls.push(["complete"]),
    recoveredAnswer: (turn) => {
      calls.push(["answer", turn?.id]);
      return "old answer";
    },
    setProgressStage: () => {},
    launchTurn: noop,
    reindexRun: () => calls.push(["reindex"]),
    scheduleObservedRun: () => calls.push(["schedule"]),
    startTyping: () => {},
    saveState: noop,
    telegram: noop,
    consumeTracker: () => null,
    finalizeDelivery: async () => calls.push(["deliver"]),
    turnTokenUsage: new Map(),
  });

  await service.recover({
    provider: "codex",
    threadId: "thread-1",
    turnId: "new-turn",
    status: "running",
    responseText: "",
  });

  assert.deepEqual(calls, [["schedule"]]);
});

test("Codex restart recovery commits an interrupted terminal before removing progress", async () => {
  const calls = [];
  const noop = async () => {};
  const run = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "running",
    responseText: "Промежуточный ответ",
    progressMessageIds: [41, 42],
    progressReasoning: "Анализ",
    lastProgressText: "Выполняется",
    chatId: 100,
  };
  const tracker = { usage: {}, reported: false };
  const service = new CodexRecoveryService({
    transportRunning: () => true,
    readTaskSnapshot: async () => ({ turnId: "turn-1", completed: true, status: "aborted" }),
    startTransport: noop,
    initialize: noop,
    isCodex: () => true,
    finishInterrupted: noop,
    readThread: async (_threadId, { applySnapshot }) => applySnapshot({
      thread: {
        status: { type: "idle" },
        turns: [{ id: "turn-1", status: "interrupted", items: [] }],
      },
    }),
    autoApprove: () => true,
    restartRequested: () => true,
    finishProgress: noop,
    completeRun: async () => calls.push(["complete"]),
    recoveredAnswer: () => "Промежуточный ответ",
    setProgressStage: () => {},
    launchTurn: noop,
    reindexRun: () => {},
    scheduleObservedRun: () => {},
    startTyping: () => {},
    saveState: noop,
    telegram: async (_method, params) => calls.push(["delete", params.message_id]),
    consumeTracker: (turnId) => {
      assert.equal(turnId, "turn-1");
      return tracker;
    },
    finalizeDelivery: async (_run, options) => {
      calls.push(["terminal", options]);
      assert.deepEqual(run.progressMessageIds, []);
      assert.equal(run.progressReasoning, "");
      assert.equal(run.lastProgressText, "");
    },
    turnTokenUsage: new Map(),
  });

  await service.recover(run);

  assert.deepEqual(calls, [
    ["terminal", {
      answer: "Промежуточный ответ",
      turnId: "turn-1",
      status: "aborted",
      tracker,
      deliver: false,
      silent: true,
      description: "прерванный при перезапуске ход",
    }],
    ["delete", 41],
    ["delete", 42],
  ]);
});

test("restart cannot settle a promptless turn from App Server status; exact terminal settles once", async () => {
  const calls = [];
  let terminal = false;
  const run = { provider: "codex", threadId: "thread-1", turnId: "turn-1",
    status: "running", responseText: "", progressMessageIds: [] };
  const service = new CodexRecoveryService({
    transportRunning: () => true,
    readTaskSnapshot: async () => terminal
      ? { turnId: "turn-1", completed: true, status: "completed", answer: "Точный финал" }
      : { turnId: "turn-1", active: false, activityUnknown: true, completed: false },
    startTransport: async () => {}, initialize: async () => {}, isCodex: () => true,
    finishInterrupted: async () => assert.fail("No interrupted final without exact terminal"),
    readThread: async (_id, { applySnapshot }) => applySnapshot({
      thread: { status: { type: "idle" },
        turns: terminal ? [] : [{ id: "turn-1", status: "interrupted", items: [] }] },
    }),
    autoApprove: () => false, restartRequested: () => false,
    finishProgress: async () => calls.push("finish"),
    completeRun: async () => calls.push("complete"),
    recoveredAnswer: () => "", setProgressStage: () => calls.push("unknown"),
    launchTurn: async () => assert.fail("No replay"), reindexRun: () => {},
    scheduleObservedRun: () => calls.push("observe"), startTyping: () => {},
    saveState: async () => calls.push("save"), telegram: async () => {},
    consumeTracker: () => null,
    finalizeDelivery: async (_run, options) => calls.push(["terminal", options.status, options.answer]),
    turnTokenUsage: new Map(),
  });
  await service.recover(run);
  assert.deepEqual(calls, ["unknown", "observe", "save"]);
  terminal = true;
  await service.recover(run);
  assert.deepEqual(calls.slice(3), ["finish", ["terminal", "completed", "Точный финал"]]);
});
