import assert from "node:assert/strict";
import test from "node:test";

import { CodexRunFinalizer } from "../../../src/providers/codex/codex-run-finalizer.mjs";
import { turnEndKey } from "../../../src/application/turn-end-notifications.mjs";

function fixture({ existingCompletion = null, discard = false, rejectCompletion = false } = {}) {
  const events = [];
  const turnStarts = new Map();
  const notifications = {
    get: () => existingCompletion,
    recordCompletion: (value) => {
      const completion = { ...value, usage: value.usage ?? {}, usageReported: value.usageReported };
      events.push(["record", completion]);
      return rejectCompletion ? null : completion;
    },
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
    commitTerminal: async (completion, options) => {
      events.push(["commit", completion, options]);
      return {
        terminal: { ...completion, terminalRevision: 1 },
        outbox: { ...completion, terminalRevision: 1 },
      };
    },
    deliverTerminal: async (...args) => {
      events.push(["outbox", ...args]);
      return { telegram: "sent" };
    },
    markRunCompleted: async (run) => events.push(["terminal", {
      responseText: run.responseText,
      terminalRevision: run.terminalRevision,
    }]),
    completeRun: async (run) => events.push(["complete", run]),
    resolveTerminalAttachments: async () => [],
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
    rolloutChangedFiles: ["file.mjs"],
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
    "record", "commit", "terminal", "save", "outbox", "complete",
  ]);
  assert.ok(
    state.events.findIndex(([name]) => name === "commit")
      < state.events.findIndex(([name]) => name === "complete"),
  );
  const terminalIntent = state.events.find(([name]) => name === "commit")[2].channelIntents.telegram;
  assert.equal(terminalIntent.requested, true);
  assert.equal(terminalIntent.message, "Final\n\nUsage");
});

test("CodexRunFinalizer publishes the exact terminal answer before the completed snapshot", async () => {
  const state = fixture();
  const value = run();
  value.responseText = "First live prefix";

  await state.finalizer.finalize(value, { answer: "First live prefix\n\nComplete final answer" });

  const terminalSnapshot = state.events.find(([name]) => name === "terminal")[1];
  assert.deepEqual(terminalSnapshot, {
    responseText: "First live prefix\n\nComplete final answer",
    terminalRevision: 1,
  });
});

test("CodexRunFinalizer commits generated ideate images with the exact final answer", async () => {
  const state = fixture();
  state.finalizer.resolveTerminalAttachments = async () => [
    { id: "codex-generated-one.png", name: "Изображение", type: "image/png" },
    { id: "codex-generated-two.png", name: "Изображение", type: "image/png" },
    { id: "codex-generated-three.png", name: "Изображение", type: "image/png" },
  ];
  const value = run();

  await state.finalizer.finalize(value, { answer: "Три концепта Rain" });

  const committed = state.events.find(([name]) => name === "commit")[1];
  assert.equal(committed.finalAnswer, "Три концепта Rain");
  assert.deepEqual(committed.responseAttachments.map((attachment) => attachment.id), [
    "codex-generated-one.png",
    "codex-generated-two.png",
    "codex-generated-three.png",
  ]);
  assert.deepEqual(value.responseAttachments, committed.responseAttachments);
});

test("CodexRunFinalizer revises an already delivered empty terminal with generated images", async () => {
  const state = fixture({
    existingCompletion: {
      turnId: "turn-1",
      responseAttachments: [],
    },
    rejectCompletion: true,
  });
  state.finalizer.resolveTerminalAttachments = async () => [
    { id: "codex-generated-one.png", name: "Изображение", type: "image/png" },
  ];

  await state.finalizer.finalize(run(), { answer: "Готово" });

  const committed = state.events.find(([name]) => name === "commit")[1];
  assert.equal(committed.finalAnswer, "Готово");
  assert.deepEqual(committed.responseAttachments, [
    { id: "codex-generated-one.png", name: "Изображение", type: "image/png" },
  ]);
});

test("CodexRunFinalizer captures a Git diff when rollout tracking is unavailable", async () => {
  const state = fixture();
  const value = run();
  value.rolloutChangeTrackingKnown = false;

  await state.finalizer.finalize(value, { answer: "Final" });

  assert.ok(state.events.some(([name]) => name === "diff"));
  assert.ok(
    state.events.findIndex(([name]) => name === "diff")
      < state.events.findIndex(([name]) => name === "commit"),
  );
  const recorded = state.events.find(([name]) => name === "record")[1];
  assert.deepEqual(recorded.changedFiles, []);
  assert.equal(state.events.filter(([name]) => name === "commit").length, 1);
});

test("CodexRunFinalizer releases admission when durable channel materialization fails", async () => {
  const state = fixture();
  state.finalizer.deliverTerminal = async () => { throw new Error("delivery unavailable"); };

  assert.equal(await state.finalizer.finalize(run(), { answer: "Final" }), null);

  assert.ok(
    state.events.findIndex(([name]) => name === "commit")
      < state.events.findIndex(([name]) => name === "terminal"),
  );
  assert.equal(state.events.at(-1)[0], "complete");
});

test("CodexRunFinalizer does not treat an audited completion as a Telegram request", async () => {
  const state = fixture({ existingCompletion: { turnId: "turn-1" } });
  const value = run();
  value.telegramDeliveryRequested = false;
  await state.finalizer.finalize(value, { answer: "Final" });
  const terminalIntent = state.events.find(([name]) => name === "commit")[2].channelIntents.telegram;
  assert.equal(terminalIntent.requested, false);
});

test("CodexRunFinalizer exits before side effects for a manual compaction turn", async () => {
  const state = fixture({ discard: true });
  assert.equal(await state.finalizer.finalize(run(), { answer: "Ignored" }), null);
  assert.deepEqual(state.events, []);
});

test("CodexRunFinalizer delivers the canonical marker-free terminal revision", async () => {
  const state = fixture();
  state.finalizer.notifications.recordCompletion = (value) => ({
    ...value,
    finalAnswer: "Связь сохранена",
    usage: value.usage ?? {},
    usageReported: value.usageReported,
  });
  const value = run();
  value.userMessages = [{
    text: "Комментарий пользователя",
    responseAnnotations: [{ text: "Фрагмент", annotation: "Почему?" }],
  }];

  await state.finalizer.finalize(value, {
    answer: ':codex-annotation{index="1"} Связь сохранена',
  });

  const [, committed, options] = state.events.find(([name]) => name === "commit");
  assert.equal(committed.finalAnswer, "Связь сохранена");
  assert.deepEqual(value.userMessages[0].responseAnnotations, [
    { text: "Фрагмент", annotation: "Почему?" },
  ]);
  assert.equal(options.channelIntents.telegram.answer, "Связь сохранена");
  assert.equal(options.channelIntents.telegram.message, "Связь сохранена\n\nUsage");
  assert.equal(value.responseText, "Связь сохранена");
});
