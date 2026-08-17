import assert from "node:assert/strict";
import test from "node:test";

import { CodexRunFinalizer } from "../../../src/providers/codex/codex-run-finalizer.mjs";
import { turnEndKey } from "../../../src/application/turn-end-notifications.mjs";

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
    discardContextCompaction: async () => discard,
    finalizeRunDelivery: async (...args) => { events.push(["final", ...args]); return "sent"; },
    refreshTaskDiff: async (run) => { run.latestDiff ||= "diff"; events.push(["diff"]); },
    runTitle: () => "Task",
    currentChatId: () => 7,
    defaultNotificationChatId: () => 8,
    changedFiles: () => ["file.mjs"],
    saveState: async () => events.push(["save"]),
    persistHistory: async (...args) => events.push(["history", ...args]),
    projectTurn: async (...args) => events.push(["project", ...args]),
    rememberCompletion: (...args) => events.push(["remember", ...args]),
    markRunCompleted: async (run) => events.push(["terminal", run]),
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
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: null,
    startedAt: "later",
    promptPreview: "later prompt",
    userMessages: [{ text: "later prompt" }, { text: "follow-up" }],
    latestDiff: "",
    rolloutChangeTrackingKnown: true,
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
  assert.equal(recorded.streamId, "stream-1");
  assert.equal(recorded.chatId, 7);
  assert.deepEqual(recorded.changedFiles, ["file.mjs"]);
  assert.deepEqual(recorded.userMessages, [{ text: "later prompt" }, { text: "follow-up" }]);
  assert.deepEqual(state.events.map(([name]) => name), [
    "history", "terminal", "record", "remember", "save", "project", "final", "delivered", "save", "complete",
  ]);
  const remembered = state.events.find(([name]) => name === "remember");
  assert.equal(remembered[1].turnId, "turn-1");
  assert.equal(remembered[2], "Final");
  assert.ok(
    state.events.findIndex(([name]) => name === "remember")
      < state.events.findIndex(([name]) => name === "complete"),
  );
  const final = state.events.find(([name]) => name === "final");
  assert.equal(final[2].refreshDiff, false);
});

test("CodexRunFinalizer captures a Git diff when rollout tracking is unavailable", async () => {
  const state = fixture();
  const value = run();
  value.rolloutChangeTrackingKnown = false;

  await state.finalizer.finalize(value, { answer: "Final" });

  assert.ok(state.events.some(([name]) => name === "diff"));
  assert.ok(
    state.events.findIndex(([name]) => name === "terminal")
      < state.events.findIndex(([name]) => name === "diff"),
  );
});

test("CodexRunFinalizer does not treat an audited completion as a Telegram request", async () => {
  const state = fixture({ existingCompletion: { turnId: "turn-1" } });
  const value = run();
  value.telegramDeliveryRequested = false;
  await state.finalizer.finalize(value, { answer: "Final" });
  const final = state.events.find(([name]) => name === "final");
  assert.equal(final[2].deliver, false);
});

test("CodexRunFinalizer exits before side effects for a manual compaction turn", async () => {
  const state = fixture({ discard: true });
  assert.equal(await state.finalizer.finalize(run(), { answer: "Ignored" }), null);
  assert.deepEqual(state.events, []);
});
