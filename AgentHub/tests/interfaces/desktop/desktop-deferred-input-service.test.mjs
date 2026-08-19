import assert from "node:assert/strict";
import test from "node:test";
import { DesktopDeferredInputService } from "../../../src/interfaces/desktop/desktop-deferred-input-service.mjs";

function createService(item, overrides = {}) {
  const pendingInputs = overrides.pendingInputs ?? new Map([[item.id, item]]);
  const queuedInputs = overrides.queuedInputs ?? new Map();
  const dependencies = {
    pendingInputs, queuedInputs, findReceiptByResultId: () => null, isProcessing: () => false,
    cancelSchedule: () => {}, steerActiveInput: async () => ({}), responseAnnotations: () => null,
    replaceInputText: (input, text) => text, saveState: async () => {}, updateReceipt: () => {},
    cleanupFiles: async () => {}, updateMessage: async () => {}, scheduleNext: () => {}, scheduleQueued: () => {},
    selectTask: async () => {}, clientContext: (context) => context ?? {}, startTurn: async () => ({}),
    runForTask: () => null, describeAttachments: () => [], selectedTask: () => ({}),
    dispatchCommand: async () => {}, activeTitle: () => "New", snapshot: async () => ({}),
    ...overrides,
  };
  return new DesktopDeferredInputService(dependencies);
}

test("Desktop deferred input edit preserves its stable message id", async () => {
  const item = { id: "message-1", input: "old", temporaryFiles: [] };
  const service = createService(item);
  const result = await service.handle({ id: item.id, action: "edit", text: "new" });
  assert.equal(result.id, "message-1");
  assert.equal(item.input, "new");
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
    dispatchCommand: async (command, params) => calls.push(["dispatch", command, params]),
    startTurn: async (input) => calls.push(["start", input]),
    selectedTask: () => ({ provider: "codex", threadId: "thread-new" }),
  });

  const result = await service.handle({ id: item.id, action: "new" });

  assert.equal(result.accepted, true);
  assert.equal(queuedInputs.has(item.id), false);
  assert.deepEqual(calls, [
    ["cancel", item.id],
    ["dispatch", "task.create", { provider: "codex", streamId: "stream-1" }],
    ["start", "deliver"],
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
