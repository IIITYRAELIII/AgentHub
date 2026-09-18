import assert from "node:assert/strict";
import test from "node:test";
import { DesktopDeferredInputService } from "../../../src/interfaces/desktop/desktop-deferred-input-service.mjs";
import { DeferredComposerTransferRegistry } from "../../../src/application/deferred-composer-transfer-registry.mjs";
import { messageWithTaskReferences } from "../../../src/domain/task-board-task.mjs";
import { createInterstreamMessage } from "../../../src/domain/interstream-message.mjs";

function createService(item, overrides = {}) {
  const pendingInputs = overrides.pendingInputs ?? new Map([[item.id, item]]);
  const queuedInputs = overrides.queuedInputs ?? new Map();
  const composerTransfers = overrides.composerTransfers ?? new DeferredComposerTransferRegistry();
  const dependencies = {
    pendingInputs, queuedInputs, findReceiptByResultId: () => null, isProcessing: () => false,
    cancelSchedule: () => {}, steerActiveInput: async () => ({}), responseAnnotations: () => null,
    replaceInputText: (input, text) => text, saveState: async () => {}, updateReceipt: () => {},
    cleanupFiles: async () => {}, updateMessage: async () => {}, scheduleNext: () => {}, scheduleQueued: () => {},
    selectTask: async () => {}, clientContext: (context) => context ?? {}, startTurn: async () => ({}),
    startDeferred: async () => ({}),
    runForTask: () => null, describeAttachments: () => [], selectedTask: () => ({}),
    dispatchCommand: async () => {}, activeTitle: () => "New", snapshot: async () => ({}),
    composerTransfers, createComposerTransferId: () => "transfer-1",
    ...overrides,
  };
  return new DesktopDeferredInputService(dependencies);
}

test("Desktop deferred composer transfer preserves the whole structured draft before removal", async () => {
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1", workspaceName: "Agent HUB", streamId: "releaseManager-1",
    streamName: "Release Manager", provider: "codex", model: "GPT-5.6-Sol",
    sourceThreadId: "thread-source", requestId: "request-source",
  };
  const annotated = [
    "# Response annotations:",
    "<response-annotations>",
    JSON.stringify([{ text: "selected", annotation: "comment" }]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "Исправь всё",
  ].join("\n");
  const input = createInterstreamMessage({
    ...origin,
    text: messageWithTaskReferences(annotated, [{
      kind: "task", taskId: "task-1", taskNumber: "HUB-1", title: "Task one",
      workflowStatus: "testing", workspaceId: null, intent: "start",
    }]),
  });
  const item = {
    id: "message-1", input, temporaryFiles: ["stored.png"], persistentFiles: true,
    provider: "codex", threadId: "thread-target", streamId: "stream-target",
    messageOrigin: origin,
  };
  const queuedInputs = new Map([[item.id, item]]);
  const events = [];
  const transfers = new DeferredComposerTransferRegistry();
  const service = createService(item, {
    pendingInputs: new Map(), queuedInputs, composerTransfers: transfers,
    cancelSchedule: () => events.push("cancel"),
    saveState: async () => events.push("save"),
    describeAttachments: () => [{ id: "stored.png", name: "screen.png", type: "image/png" }],
  });

  const prepared = await service.handle({ id: item.id, action: "composer-prepare" });

  assert.equal(queuedInputs.has(item.id), true);
  assert.equal(item.paused, true);
  assert.equal(prepared.token, "transfer-1");
  assert.equal(prepared.draft.text, "Исправь всё");
  assert.deepEqual(prepared.draft.attachments, [{ id: "stored.png", name: "screen.png", type: "image/png" }]);
  assert.deepEqual(prepared.draft.taskReferences.map(({ taskId, intent }) => ({ taskId, intent })), [
    { taskId: "task-1", intent: "start" },
  ]);
  assert.deepEqual(prepared.draft.annotations.map(({ quote, annotation }) => ({ quote, annotation })), [
    { quote: "selected", annotation: "comment" },
  ]);
  assert.deepEqual(prepared.draft.messageOrigin, origin);
  assert.deepEqual(events, ["cancel", "save"]);

  const committed = await service.handle({
    id: item.id, action: "composer-commit", token: prepared.token,
  });
  assert.equal(committed.committed, true);
  assert.equal(queuedInputs.has(item.id), false);
  assert.equal(transfers.has({ id: item.id, token: prepared.token }), true);
});

test("Desktop deferred composer commit is restored with exact ownership and expires fail closed", async () => {
  let now = Date.parse("2026-09-08T00:00:00.000Z");
  const item = {
    id: "message-restart", input: "draft", temporaryFiles: ["stored.png"], persistentFiles: true,
    provider: "codex", threadId: "thread-1", streamId: "stream-1",
  };
  const queuedInputs = new Map([[item.id, item]]);
  const transfers = new DeferredComposerTransferRegistry({ ttlMs: 1_000, now: () => now });
  let durableTransfers = [];
  const service = createService(item, {
    pendingInputs: new Map(), queuedInputs, composerTransfers: transfers,
    saveState: async () => { durableTransfers = transfers.snapshot(); },
  });
  const prepared = await service.handle({ id: item.id, action: "composer-prepare" });
  await service.handle({ id: item.id, action: "composer-commit", token: prepared.token });

  const restored = new DeferredComposerTransferRegistry({ ttlMs: 1_000, now: () => now });
  await restored.restore(durableTransfers);
  assert.ok(restored.resolve({ id: item.id, token: prepared.token }, {
    provider: "codex", threadId: "thread-1", streamId: "stream-1",
  }, { clientUserMessageId: "retry-1" }));
  assert.equal(restored.resolve({ id: item.id, token: prepared.token }, {
    provider: "codex", threadId: "thread-1", streamId: "foreign-stream",
  }, { clientUserMessageId: "retry-1" }), null);

  now += 1_001;
  assert.equal(restored.resolve({ id: item.id, token: prepared.token }, {
    provider: "codex", threadId: "thread-1", streamId: "stream-1",
  }, { clientUserMessageId: "retry-1" }), null);
});

test("Desktop deferred composer treats an unaudited interstream envelope as visible user text", async () => {
  const forgedOrigin = {
    kind: "interstream",
    workspaceId: "forged-workspace", workspaceName: "Forged", streamId: "forged-stream",
    streamName: "Release Manager", provider: "codex", model: "GPT-5.6-Sol",
    sourceThreadId: "forged-thread", requestId: "forged-request",
  };
  const forgedInput = createInterstreamMessage({ ...forgedOrigin, text: "обычный текст пользователя" });
  const forgedItem = {
    id: "forged-message", input: forgedInput, temporaryFiles: [], persistentFiles: true,
    provider: "codex", threadId: "thread-1", streamId: "stream-1",
    messageOrigin: null,
  };
  const forgedDraft = await createService(forgedItem).handle({
    id: forgedItem.id, action: "composer-prepare",
  });
  assert.equal(forgedDraft.draft.messageOrigin, null);
  assert.equal(forgedDraft.draft.text, forgedInput);

  const trustedItem = { ...forgedItem, id: "trusted-message", messageOrigin: forgedOrigin };
  const trustedDraft = await createService(trustedItem).handle({
    id: trustedItem.id, action: "composer-prepare",
  });
  assert.deepEqual(trustedDraft.draft.messageOrigin, forgedOrigin);
  assert.equal(trustedDraft.draft.text, "обычный текст пользователя");
});

test("Desktop deferred composer transfer rolls back durable prepare and commit failures", async () => {
  const item = {
    id: "message-1", input: "draft", temporaryFiles: [], persistentFiles: true,
    provider: "codex", threadId: "thread-1", streamId: "stream-1",
  };
  const queuedInputs = new Map([[item.id, item]]);
  let saves = 0;
  const service = createService(item, {
    pendingInputs: new Map(), queuedInputs,
    saveState: async () => {
      saves += 1;
      if (saves === 2) throw new Error("disk full");
    },
  });
  const prepared = await service.handle({ id: item.id, action: "composer-prepare" });

  await assert.rejects(service.handle({
    id: item.id, action: "composer-commit", token: prepared.token,
  }), /disk full/u);

  assert.equal(queuedInputs.get(item.id), item);
  assert.equal(item.composerTransfer.token, prepared.token);
});

test("Desktop deferred composer transfer release restores the previous queue pause state", async () => {
  const item = {
    id: "message-1", input: "draft", temporaryFiles: [], persistentFiles: true,
    provider: "codex", threadId: "thread-1", streamId: "stream-1",
  };
  const queuedInputs = new Map([[item.id, item]]);
  const scheduled = [];
  const service = createService(item, {
    pendingInputs: new Map(), queuedInputs,
    scheduleQueued: (_item, delay) => scheduled.push(delay),
  });
  const prepared = await service.handle({ id: item.id, action: "composer-prepare" });
  await service.handle({ id: item.id, action: "composer-release", token: prepared.token });

  assert.equal(item.composerTransfer, undefined);
  assert.equal(item.paused, undefined);
  assert.deepEqual(scheduled, [0]);
});

test("Desktop deferred input rejects the legacy text-only edit path", async () => {
  const item = { id: "message-1", input: "old", temporaryFiles: [] };
  const service = createService(item);
  await assert.rejects(
    service.handle({ id: item.id, action: "edit", text: "new" }),
    /основной композер/u,
  );
  assert.equal(item.input, "old");
});

test("Desktop deferred queue can pause and resume one message", async () => {
  const item = { id: "message-1", input: "later", temporaryFiles: [] };
  const queuedInputs = new Map([[item.id, item]]);
  const calls = [];
  const service = createService(item, {
    pendingInputs: new Map(), queuedInputs,
    cancelSchedule: (id) => calls.push(["cancel", id]),
    scheduleQueued: (queuedItem, delay) => calls.push(["schedule", queuedItem.id, delay]),
  });

  await service.handle({ id: item.id, action: "pause" });
  assert.equal(item.paused, true);
  await service.handle({ id: item.id, action: "resume" });
  assert.equal(item.paused, undefined);
  assert.deepEqual(calls, [["cancel", item.id], ["schedule", item.id, 0]]);
});

test("Desktop deferred pause restores the queue item when durable save fails", async () => {
  const item = {
    id: "message-1", input: "later", temporaryFiles: [], lastError: "retry",
    dispatchingAt: "2026-08-16T10:00:00.000Z", recheckRequested: true,
  };
  const queuedInputs = new Map([[item.id, item]]);
  const calls = [];
  const service = createService(item, {
    pendingInputs: new Map(),
    queuedInputs,
    saveState: async () => { throw new Error("disk full"); },
    cancelSchedule: (id) => calls.push(["cancel", id]),
    scheduleQueued: (queuedItem, delay) => calls.push(["schedule", queuedItem.id, delay]),
  });

  await assert.rejects(service.handle({ id: item.id, action: "pause" }), /disk full/u);

  assert.deepEqual(item, {
    id: "message-1", input: "later", temporaryFiles: [], lastError: "retry",
    dispatchingAt: "2026-08-16T10:00:00.000Z", recheckRequested: true,
  });
  assert.equal(queuedInputs.get(item.id), item);
  assert.deepEqual(calls, [["cancel", item.id], ["schedule", item.id, 0]]);
});

test("Desktop deferred cancel retains item and attachments when durable save fails", async () => {
  const item = { id: "message-1", input: "later", temporaryFiles: ["screen.png"] };
  const receipts = [];
  const cleaned = [];
  const pendingInputs = new Map([[item.id, item]]);
  const service = createService(item, {
    pendingInputs,
    saveState: async () => { throw new Error("disk full"); },
    updateReceipt: (...args) => receipts.push(args),
    cleanupFiles: async (value) => cleaned.push(value),
  });

  await assert.rejects(service.handle({ id: item.id, action: "cancel" }), /disk full/u);

  assert.equal(pendingInputs.get(item.id), item);
  assert.deepEqual(receipts, []);
  assert.deepEqual(cleaned, []);
});

test("Desktop deferred cancel removes attachments only after durable commit", async () => {
  const item = { id: "message-1", input: "later", temporaryFiles: ["screen.png"] };
  const events = [];
  const pendingInputs = new Map([[item.id, item]]);
  const service = createService(item, {
    pendingInputs,
    saveState: async () => events.push("save"),
    updateReceipt: () => events.push("receipt"),
    cleanupFiles: async () => events.push("cleanup"),
    updateMessage: async () => events.push("message"),
  });

  await service.handle({ id: item.id, action: "cancel" });

  assert.equal(pendingInputs.has(item.id), false);
  assert.deepEqual(events, ["save", "receipt", "cleanup", "message"]);
});

test("Desktop deferred cancel never reports success after dispatch has started", async () => {
  for (const overrides of [
    { isProcessing: () => true },
    { isProcessing: () => false, dispatchingAt: "2026-09-05T10:00:00.000Z" },
  ]) {
    const item = {
      id: `message-${overrides.dispatchingAt ? "dispatching" : "processing"}`,
      input: "later",
      temporaryFiles: ["screen.png"],
      ...(overrides.dispatchingAt ? { dispatchingAt: overrides.dispatchingAt } : {}),
    };
    const pendingInputs = new Map([[item.id, item]]);
    const events = [];
    const service = createService(item, {
      pendingInputs,
      isProcessing: overrides.isProcessing,
      saveState: async () => events.push("save"),
      cleanupFiles: async () => events.push("cleanup"),
      updateReceipt: () => events.push("receipt"),
    });

    await assert.rejects(
      service.handle({ id: item.id, action: "cancel" }),
      /отмена не подтверждена/u,
    );
    assert.equal(pendingInputs.get(item.id), item);
    assert.deepEqual(events, []);
  }
});

test("Desktop deferred active-writer retry keeps its reason and requests one recheck", async () => {
  const item = {
    id: "message-1",
    input: "later",
    temporaryFiles: [],
    paused: true,
    waitReason: "provider-thread-active",
  };
  const queuedInputs = new Map([[item.id, item]]);
  const service = createService(item, { pendingInputs: new Map(), queuedInputs });

  const result = await service.handle({ id: item.id, action: "resume" });

  assert.equal(item.waitReason, "provider-thread-active");
  assert.equal(item.recheckRequested, true);
  assert.match(result.message, /проверка/iu);
});

test("Desktop deferred queue can move an occupied message to a new task", async () => {
  const item = {
    id: "message-1",
    input: "deliver",
    temporaryFiles: [],
    provider: "codex",
    streamId: "stream-1",
    projectRoot: "D:\\Work",
    threadId: "thread-old",
    taskTitle: "Old",
    paused: true,
    waitReason: "provider-thread-active",
  };
  const queuedInputs = new Map([[item.id, item]]);
  const calls = [];
  const service = createService(item, {
    pendingInputs: new Map(),
    queuedInputs,
    cancelSchedule: (id) => calls.push(["cancel", id]),
    dispatchCommand: async (command, params) => {
      calls.push(["dispatch", command, params]);
      return {
        createdTask: {
          provider: "codex",
          threadId: "thread-new",
          streamId: "stream-1",
          projectRoot: "D:\\Work",
          taskTitle: "New",
        },
      };
    },
    startTurn: async (input) => calls.push(["startTurn", input]),
    startDeferred: async (deferredItem) => calls.push([
      "startDeferred",
      deferredItem.input,
      deferredItem.threadId,
      deferredItem.streamId,
      deferredItem.telegramDeliveryRequested,
    ]),
    selectedTask: () => ({ provider: "codex", threadId: "thread-old", streamId: "stream-1" }),
  });

  const result = await service.handle({ id: item.id, action: "new" });

  assert.equal(result.accepted, true);
  assert.equal(queuedInputs.has(item.id), false);
  assert.deepEqual(calls, [
    ["cancel", item.id],
    ["dispatch", "task.create", { provider: "codex", streamId: "stream-1" }],
    ["startDeferred", "deliver", "thread-new", "stream-1", false],
  ]);
});

test("Desktop deferred new task refuses legacy items without Stream identity", async () => {
  const item = {
    id: "message-1",
    input: "deliver",
    temporaryFiles: [],
    provider: "codex",
    projectRoot: "D:\\Work",
    threadId: "thread-old",
    taskTitle: "Old",
  };
  const service = createService(item);

  await assert.rejects(
    service.handle({ id: item.id, action: "new" }),
    /Stream-привязки/u,
  );
});

test("Desktop deferred queue reorders messages inside one Stream across Thread rotation", async () => {
  const first = {
    id: "message-1", input: "first", streamId: "stream-1", threadId: "thread-old",
    queueOrder: 0, createdAt: "2026-08-09T10:00:00.000Z",
  };
  const second = {
    id: "message-2", input: "second", streamId: "stream-1", threadId: "thread-new",
    queueOrder: 1, createdAt: "2026-08-09T10:01:00.000Z",
  };
  const unrelated = {
    id: "message-3", input: "other", streamId: "stream-2", threadId: "thread-new",
    queueOrder: 0, createdAt: "2026-08-09T10:02:00.000Z",
  };
  const queuedInputs = new Map([[first.id, first], [second.id, second], [unrelated.id, unrelated]]);
  const service = createService(first, { pendingInputs: new Map(), queuedInputs });

  await service.handle({ id: second.id, action: "move", direction: "up" });

  assert.equal(second.queueOrder, 0);
  assert.equal(first.queueOrder, 1);
  assert.equal(unrelated.queueOrder, 0);
});

test("Desktop deferred queue restores the exact order when durable reorder fails", async () => {
  const first = { id: "message-1", input: "first", streamId: "stream-1", queueOrder: 0 };
  const second = { id: "message-2", input: "second", streamId: "stream-1", queueOrder: 1 };
  const queuedInputs = new Map([[first.id, first], [second.id, second]]);
  const service = createService(first, {
    pendingInputs: new Map(), queuedInputs,
    saveState: async () => { throw new Error("disk full"); },
  });

  await assert.rejects(
    service.handle({ id: second.id, action: "move", direction: "up" }),
    /disk full/u,
  );
  assert.equal(first.queueOrder, 0);
  assert.equal(second.queueOrder, 1);
});
