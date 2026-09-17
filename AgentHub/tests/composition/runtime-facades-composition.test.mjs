import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeFacadesComposition } from "../../src/composition/runtime-facades-composition.mjs";

test("runtime facades preserve stable callbacks across late composition binding", async () => {
  const calls = [];
  const facades = createRuntimeFacadesComposition({
    sendTaskSelection: (value) => calls.push(["selection", value]),
    currentChatId: () => 42,
    runJournal: {
      rememberLastMessage: (...args) => calls.push(["remember", ...args]),
      lastMessage: (task) => `last:${task.threadId}`,
      lastMessageRecord: (task) => ({ threadId: task.threadId }),
    },
    deferredInputs: { latestActivityAt: () => 123 },
    codexUsageTracker: {
      latestContext: () => ({ percent: 7 }),
      track: (value) => value,
      consume: (value) => ({ turnId: value }),
    },
    codexRunFinalizer: {
      finalize: (run, options) => ({ run, options }),
    },
    turnEndDelivery: {
      deliver: (value) => value,
      retryPendingTelegram: () => "telegram-retried",
      retryPendingProjections: (options) => ({ projections: options }),
      waitForCompletion: (...args) => args,
    },
    agentPreferences: {
      rememberCodexTaskSettings: (...args) => args,
      restoreCodexTaskSettings: (...args) => args,
      applyCodexThreadSettings: (...args) => args,
    },
    journalBackfill: { backfill: (value) => value },
    claudeTranscriptAudit: { audit: (value) => value },
    taskCatalogFinalization: { finalize: (value) => value },
    taskCatalogService: { refresh: (value) => value },
  });

  facades.sendTaskAlreadySelectedNotification({ taskTitle: "Task" });
  assert.deepEqual(calls[0], ["selection", {
    targetChatId: 42,
    taskTitle: "Task",
    alreadySelected: true,
  }]);
  assert.equal(facades.savedLastTaskMessage({ threadId: "thread" }), "last:thread");
  assert.deepEqual(facades.latestThreadContextUsage("thread"), { percent: 7 });
  assert.equal(facades.retryPendingTurnEndNotifications(), "telegram-retried");
  assert.deepEqual(facades.retryPendingTurnEndProjections({ recoverProjecting: true }), {
    projections: { recoverProjecting: true },
  });
  assert.deepEqual(facades.refreshTaskCatalog({ force: true }), { force: true });

  const finalized = facades.finalizeCodexRunDelivery({ turnId: "turn" }, { answer: "done" });
  assert.equal(finalized.options.turnId, "turn");
  assert.equal(finalized.options.status, "completed");
  assert.equal(finalized.options.deliver, undefined);
  assert.deepEqual(finalized.options.tracker.usage, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  });

  const bounded = new Map([["old", 1]]);
  facades.setBoundedMapValue(bounded, "new", 2, 1);
  assert.deepEqual([...bounded], [["new", 2]]);
});
