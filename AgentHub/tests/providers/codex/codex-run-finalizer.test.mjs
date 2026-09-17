import assert from "node:assert/strict";
import test from "node:test";

import { CodexRunFinalizer } from "../../../src/providers/codex/codex-run-finalizer.mjs";
import { turnEndKey } from "../../../src/application/turn-end-notifications.mjs";
import { ManagedRunLifecycleService } from "../../../src/application/managed-run-lifecycle-service.mjs";
import { StreamContextMaintenanceService } from "../../../src/application/stream-context-maintenance-service.mjs";
import { StreamMaintenanceRegistry } from "../../../src/application/stream-maintenance-registry.mjs";
import { DeferredInputStore } from "../../../src/application/deferred-input-store.mjs";

function fixture({
  existingCompletion = null,
  discard = false,
  rejectCompletion = false,
  completionPatch = null,
  formatUsage = () => "Usage",
} = {}) {
  const events = [];
  const turnStarts = new Map();
  const notifications = {
    get: () => existingCompletion,
    recordCompletion: (value) => {
      const completion = {
        ...value,
        ...completionPatch,
        usage: value.usage ?? {},
        usageReported: value.usageReported,
      };
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
    formatUsage,
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
    "record", "commit", "terminal", "complete", "outbox",
  ]);
  assert.ok(
    state.events.findIndex(([name]) => name === "commit")
      < state.events.findIndex(([name]) => name === "complete"),
  );
  const terminalIntent = state.events.find(([name]) => name === "commit")[2].channelIntents.telegram;
  assert.equal(terminalIntent.requested, true);
  assert.equal(terminalIntent.message, "Final\n\nUsage");
});

test("CodexRunFinalizer prices the live summary at the durable completion time", async () => {
  let formattedTracker = null;
  const state = fixture({
    completionPatch: { completedAt: "2026-09-08T00:00:00.000Z" },
    formatUsage: (tracker) => {
      formattedTracker = tracker;
      return "Usage";
    },
  });

  await state.finalizer.finalize(run(), {
    answer: "Final",
    tracker: { usage: { inputTokens: 1 }, reported: true, model: "gpt-5.6-sol" },
  });

  assert.equal(formattedTracker.completedAt, "2026-09-08T00:00:00.000Z");
});

test("CodexRunFinalizer preserves canonical message origin independently of provider users", async () => {
  const state = fixture();
  const value = run();
  value.clientUserMessageId = "mcp:finalizer-origin-1";
  value.messageOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-release-manager",
    streamName: "Release Manager",
    provider: "codex",
    sourceThreadId: "thread-release-manager",
    requestId: "finalizer-origin-1",
  };
  value.rawPrompt = "<agent-hub-stream-message>\nraw transport\n</agent-hub-stream-message>\nBody";
  value.userMessages = [{ role: "user", text: "Provider projection without origin" }];

  await state.finalizer.finalize(value, { answer: "Final" });

  const recorded = state.events.find(([name]) => name === "record")[1];
  assert.equal(recorded.clientUserMessageId, "mcp:finalizer-origin-1");
  assert.deepEqual(recorded.messageOrigin, value.messageOrigin);
  assert.equal(recorded.rawPrompt, value.rawPrompt);
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
  assert.equal(state.events.filter(([name]) => name === "complete").length, 1);
});

for (const rejectReleaseSave of [false, true]) test(
  `durable completion starts maintenance and wakes queued input with ${rejectReleaseSave ? "failed admission save" : "blocked outbox"}`,
  async () => {
  const state = fixture();
  const value = { ...run(), id: "run-1", status: "finishing" };
  state.turnStarts.set(turnEndKey(value), { startedAt: value.startedAt });
  const registry = new StreamMaintenanceRegistry();
  const deferredInputs = new DeferredInputStore();
  deferredInputs.put({ id: "queued-1", streamId: value.streamId,
    provider: value.provider, threadId: value.threadId, prompt: "next" }, "queued");
  const queued = structuredClone(deferredInputs.get("queued-1"));
  let releaseDelivery;
  let releaseSettlement;
  const delivery = new Promise((resolve) => { releaseDelivery = resolve; });
  const settlement = new Promise((resolve) => { releaseSettlement = resolve; });
  let maintenance;
  const service = new StreamContextMaintenanceService({
    registry, deferredInputs,
    provider: {
      start: async () => {
        assert.ok(value.terminalRevision);
        assert.equal(value.completionPrepared, true);
        assert.equal(registry.isActive(value), true);
        state.events.push(["compact"]);
        return { accepted: true, compactionId: "compact-1" };
      },
      probeContext() {}, rotate() {}, rotateCompacted() {}, discardCompactionTransfer() {},
      waitForTurnIdle: async () => true,
      compactions: { get: () => null, waitForSettlement: () => settlement, annotate() {} },
    },
    latestContextUsage: () => ({ usedTokens: 80, modelContextWindow: 100 }),
    waitForContextUpdate: async () => ({ usedTokens: 10, modelContextWindow: 100 }),
    autoCompactEnabled: () => true,
    scheduleDeferred: (item) => state.events.push(["wake", item.id]),
  });
  const noop = () => {};
  const saves = [];
  const lifecycle = new ManagedRunLifecycleService({
    currentTarget: noop, findProject: noop, codexSettings: noop, currentPreferences: noop,
    normalizeCodexModel: noop, modelLabel: noop, persistTaskDiff: noop, syncRun: noop,
    invalidateCatalog: noop, saveState: async () => {
      saves.push({ status: value.status, terminalRevision: value.terminalRevision,
        hasTurnStart: state.turnStarts.has(turnEndKey(value)) });
      if (rejectReleaseSave && saves.length === 2) throw new Error("admission state unavailable");
    }, scheduleProgressStart: noop,
    clearSelectedDiff: noop, clearApprovals: noop, pauseObservation: noop, pauseClaude: noop,
    stopTyping: noop, prepareAdmission: noop, revokeAdmission: noop,
    beforeCompletion: (target) => service.reserveAfterTurn(target),
    completionAborted: (target) => service.cancelAfterTurn(target),
    afterCompletion: (target) => { maintenance = service.maintainAfterTurn(target); },
    taskRuns: { add: noop, remove: () => state.events.push(["remove"]), size: 0 },
  });
  state.finalizer.markRunCompleted = lifecycle.markCompleted.bind(lifecycle);
  state.finalizer.completeRun = lifecycle.complete.bind(lifecycle);
  state.finalizer.deliverTerminal = () => { state.events.push(["outbox"]); return delivery; };
  const finalizing = state.finalizer.finalize(value, { answer: "Final" })
    .then((result) => ({ result }), (error) => ({ error }));
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(value.admissionReleased === true, !rejectReleaseSave);
    assert.deepEqual(saves, [
      { status: "completed", terminalRevision: 1, hasTurnStart: true },
      { status: "completed", terminalRevision: 1, hasTurnStart: false },
    ]);
    assert.equal(state.events.filter(([name]) => name === "compact").length, 1);
    assert.equal(state.events.filter(([name]) => name === "outbox").length, rejectReleaseSave ? 0 : 1);
    assert.equal(registry.entry(value).phase, "running");
    assert.equal(state.events.some(([name]) => name === "wake"), false);
    releaseSettlement({ status: "completed" });
    assert.equal((await maintenance).compacted, true);
    assert.equal(registry.isActive(value), false);
    assert.deepEqual(deferredInputs.get("queued-1"), queued);
    assert.deepEqual(state.events.filter(([name]) => name === "wake"), [["wake", "queued-1"]]);
  } finally {
    releaseSettlement({ status: "completed" });
    releaseDelivery({ telegram: "sent" });
    const outcome = await finalizing;
    if (rejectReleaseSave) assert.match(outcome.error?.message ?? "", /admission state unavailable/u);
    else assert.equal(outcome.result, "sent");
  }
});

test("CodexRunFinalizer keeps a failed terminal commit replayable and releases once after retry", async () => {
  const state = fixture();
  const value = { ...run(), status: "finishing" };
  let attempts = 0;
  state.finalizer.commitTerminal = async (completion) => {
    attempts += 1;
    state.events.push(["commit-attempt", attempts]);
    if (attempts === 1) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return {
      terminal: { ...completion, terminalRevision: 1 },
      outbox: { ...completion, terminalRevision: 1 },
    };
  };

  await assert.rejects(state.finalizer.finalize(value, { answer: "Final" }), /database is locked/u);
  assert.equal(value.status, "running");
  assert.equal(state.events.some(([name]) => name === "complete"), false);
  assert.equal(state.events.filter(([name]) => name === "save").length, 1);

  value.status = "finishing";
  await state.finalizer.finalize(value, { answer: "Final" });
  assert.equal(attempts, 2);
  assert.equal(state.events.filter(([name]) => name === "complete").length, 1);
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

test("CodexRunFinalizer delivers the canonical readable citation terminal revision", async () => {
  const state = fixture();
  state.finalizer.notifications.recordCompletion = (value) => ({
    ...value,
    finalAnswer: "Цитата 1\nСвязь сохранена",
    responseAnnotationReferences: [{ index: 1 }],
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
  assert.equal(committed.finalAnswer, "Цитата 1\nСвязь сохранена");
  assert.deepEqual(committed.responseAnnotationReferences, [{ index: 1 }]);
  assert.deepEqual(value.userMessages[0].responseAnnotations, [
    { text: "Фрагмент", annotation: "Почему?" },
  ]);
  assert.equal(options.channelIntents.telegram.answer, "Цитата 1\nСвязь сохранена");
  assert.equal(options.channelIntents.telegram.message, "Цитата 1\nСвязь сохранена\n\nUsage");
  assert.equal(value.responseText, "Цитата 1\nСвязь сохранена");
  assert.deepEqual(value.responseAnnotationReferences, [{ index: 1 }]);
});

test("CodexRunFinalizer keeps exact live citation refs when terminal tracking is empty", async () => {
  const state = fixture();
  const value = run();
  value.responseItemId = "provider-final-item";
  value.responseAnnotationReferences = [{ index: 1 }];

  await state.finalizer.finalize(value, {
    answer: "Цитата 1\nСвязь сохранена",
    tracker: {
      usage: {},
      reported: true,
      responseAnnotationReferences: [],
    },
  });

  const [, committed] = state.events.find(([name]) => name === "commit");
  assert.deepEqual(committed.responseAnnotationReferences, [{ index: 1 }]);
  assert.deepEqual(value.responseAnnotationReferences, [{ index: 1 }]);
});
