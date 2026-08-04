import assert from "node:assert/strict";
import test from "node:test";

import { CodexRunFinalizer } from "./codex-run-finalizer.mjs";
import { turnEndKey } from "./turn-end-notifications.mjs";

function fixture({ existingCompletion = null, discard = false } = {}) {
  const events = [];
  const turnStarts = new Map();
  const notifications = {
    get: () => existingCompletion,
    recordCompletion: (value) => {
      const completion = { ...value, usage: value.usage ?? {}, usageReported: value.usageReported };
      events.push(["record", completion]);
      return completion;
    },
    markDelivered: (value) => events.push(["delivered", value]),
  };
  const finalizer = new CodexRunFinalizer({
    turnStarts,
    notifications,
    discardManualCompaction: async () => discard,
    finalizeRunDelivery: async (...args) => { events.push(["final", ...args]); return "sent"; },
    refreshTaskDiff: async (run) => { run.latestDiff ||= "diff"; events.push(["diff"]); },
    runTitle: () => "Task",
    currentChatId: () => 7,
    defaultNotificationChatId: () => 8,
    changedFiles: () => ["file.mjs"],
    saveState: async () => events.push(["save"]),
    persistHistory: async (...args) => events.push(["history", ...args]),
    projectTurn: async (...args) => events.push(["project", ...args]),
    completeRun: async (run) => events.push(["complete", run]),
    routeFinalDelivery: async ({ deliverStandard }) => ({ result: await deliverStandard() }),
    formatUsage: () => "Usage",
    titleForAnswer: () => "Title",
    logger: { error: (...args) => events.push(["error", ...args]) },
  });
  return { finalizer, turnStarts, events };
}

function run() {
  return {
    hubTaskId: "hub-1",
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: null,
    startedAt: "later",
    promptPreview: "later prompt",
    latestDiff: "",
  };
}

test("CodexRunFinalizer falls back to ordinary delivery without an exact turn", async () => {
  const state = fixture();
  const result = await state.finalizer.finalize(null, { answer: "Final" });
  assert.equal(result, "sent");
  assert.deepEqual(state.events.map(([name]) => name), ["final"]);
});

test("CodexRunFinalizer adopts audited start data and completes one durable delivery", async () => {
  const state = fixture();
  const value = run();
  state.turnStarts.set(turnEndKey(value), {
    startedAt: "earlier",
    prompt: "original prompt",
    gitBaseline: { id: "baseline" },
  });
  const result = await state.finalizer.finalize(value, {
    answer: "Final",
    tracker: { usage: { inputTokens: 1 }, reported: true, model: "gpt" },
  });
  assert.equal(result, "sent");
  assert.equal(value.startedAt, "earlier");
  assert.equal(value.promptPreview, "original prompt");
  assert.equal(value.gitBaseline.id, "baseline");
  const recorded = state.events.find(([name]) => name === "record")[1];
  assert.equal(recorded.hubTaskId, "hub-1");
  assert.equal(recorded.chatId, 7);
  assert.deepEqual(recorded.changedFiles, ["file.mjs"]);
  assert.deepEqual(state.events.map(([name]) => name), [
    "diff", "record", "save", "history", "project", "final", "delivered", "save", "complete",
  ]);
});

test("CodexRunFinalizer preserves delivery requested by an earlier completion", async () => {
  const state = fixture({ existingCompletion: { turnId: "turn-1" } });
  await state.finalizer.finalize(run(), { answer: "Final", deliver: false });
  const final = state.events.find(([name]) => name === "final");
  assert.equal(final[2].deliver, true);
});

test("CodexRunFinalizer exits before side effects for a manual compaction turn", async () => {
  const state = fixture({ discard: true });
  assert.equal(await state.finalizer.finalize(run(), { answer: "Ignored" }), null);
  assert.deepEqual(state.events, []);
});
