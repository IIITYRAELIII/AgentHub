import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { MessageCommandLedgerStore } from "../../src/infrastructure/persistence/message-command-ledger-store.mjs";
import { CodexEventService } from "../../src/providers/codex/codex-event-service.mjs";

function eventService(run) {
  const noop = () => {};
  return new CodexEventService({
    invalidateThreadRead: noop,
    forEvent: ({ turnId }) => turnId === run.turnId ? run : null,
    reindexRun: noop,
    applyThreadSettings: noop,
    saveState: async () => {},
    trackTokenUsage: noop,
    completeTurn: noop,
    taskKey: () => "task",
    isSelectedRun: () => false,
    setSelectedDiff: noop,
    appendActivity: noop,
    noteActivity: noop,
    scheduleProgress: noop,
    appendReasoning: noop,
    upsertReasoningBlock: noop,
    replaceActivityGroups: noop,
    turnActivityGroups: () => [],
    isCompactionItem: () => false,
    contextUsage: () => null,
    beginCompaction: noop,
    getCompaction: () => null,
    settleCompactionTurn: noop,
    rememberRawCompactionItem: noop,
    beginCompactionCleanup: noop,
    setStage: noop,
    describeItem: () => "stage",
    itemActivity: () => null,
    requestApproval: async () => {},
    formatCommandApproval: () => "",
    formatFileApproval: () => "",
    formatPermissionsApproval: () => "",
    requestMcpElicitation: async () => {},
    observeMcpProgress: noop,
    observeHubMcpBridge: noop,
    requestUserInput: async () => {},
    reduceLiveItemEvent: () => null,
    startLiveItem: noop,
    completeLiveItem: noop,
    discardContextCompaction: async () => false,
    consumeTracker: () => null,
    finishObserved: async () => {},
    turnSnapshot: () => ({}),
    completeManaged: async () => {},
    turnTokenUsage: new Map(),
    speechButtons: new Map(),
    temporaryFiles: new Map(),
    taskDiffs: { remember: noop },
  });
}

test("final-answer protocol events durably queue exact FIFO commands across reload", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-final-answer-guard-"));
  let now = Date.parse("2026-09-02T12:00:00.000Z");
  let ledger = new MessageCommandLedgerStore({ dataDir, now: () => ++now });
  context.after(async () => {
    ledger.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const run = {
    id: "run-1",
    provider: "codex",
    streamId: "stream-1",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "running",
    executionOwner: "hub",
    responseItems: [],
  };
  const providerCalls = [];
  const coordinator = new RunCoordinator({
    taskRuns: { forTask: () => run },
    providers: { call: async (...args) => { providerCalls.push(args); return {}; } },
    externalActivity: async () => ({ state: "inactive", executionOwner: null }),
    repositoryConflict: async () => null,
    deferInput: async (input, attachments, options) => {
      const createdAt = new Date(now).toISOString();
      const item = {
        id: `queued-${options.clientUserMessageId}`,
        ...options.target,
        input,
        temporaryFiles: attachments,
        conflictKind: options.conflictKind,
        clientUserMessageId: options.clientUserMessageId,
        createdAt,
      };
      const accepted = ledger.accept({
        item,
        destination: "queued",
        receipt: {
          provider: item.provider,
          threadId: item.threadId,
          clientUserMessageId: item.clientUserMessageId,
          fingerprint: options.messageFingerprint,
          createdAt,
          result: { accepted: true, deferred: true, queued: true },
        },
      });
      return {
        id: accepted.record.item?.id ?? item.id,
        item: accepted.record.item,
        duplicate: accepted.duplicate,
        durableResult: accepted.retryResult,
      };
    },
    beginRun: async () => run,
    rollbackAdmission: async () => {},
    launchTurn: async () => {},
    scheduleDeferred: () => {},
  });
  const events = eventService(run);

  await events.handle({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "answer-1", type: "agentMessage", phase: "final_answer" },
    },
  });
  await events.handle({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      delta: "Начат финальный ответ.",
    },
  });
  assert.deepEqual(run.responseItems.map(({ id, turnId, phase }) => ({ id, turnId, phase })), [{
    id: "answer-1",
    turnId: "turn-1",
    phase: "final_answer",
  }]);

  const target = {
    provider: "codex",
    streamId: "stream-1",
    threadId: "thread-1",
  };
  const first = await coordinator.acceptClientInput({
    input: "первое следующее сообщение",
    target,
    clientUserMessageId: "client-next-1",
    messageFingerprint: "fingerprint-next-1",
    followUpMode: "steer",
  });
  const second = await coordinator.acceptClientInput({
    input: "второе следующее сообщение",
    target,
    clientUserMessageId: "client-next-2",
    messageFingerprint: "fingerprint-next-2",
    followUpMode: "steer",
  });

  assert.deepEqual([first.reason, second.reason], ["final-answer-active", "final-answer-active"]);
  assert.equal(providerCalls.length, 0);
  assert.deepEqual(ledger.activeRecords().map((record) => record.clientUserMessageId), [
    "client-next-1",
    "client-next-2",
  ]);

  ledger.close();
  ledger = new MessageCommandLedgerStore({ dataDir, now: () => ++now });
  const restored = ledger.overlay({ queuedInputs: [], desktopMessageReceipts: [] });
  assert.deepEqual(restored.queuedInputs.map((item) => item.clientUserMessageId), [
    "client-next-1",
    "client-next-2",
  ]);
  assert.equal(restored.queuedInputs.every((item) => item.conflictKind === "message-intake"), true);

  run.status = "completed";
  const duplicate = await coordinator.acceptClientInput({
    input: "первое следующее сообщение",
    target,
    clientUserMessageId: "client-next-1",
    messageFingerprint: "fingerprint-next-1",
    followUpMode: "steer",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(ledger.activeRecords().length, 2);
});
