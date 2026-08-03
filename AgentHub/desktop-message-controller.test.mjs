import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDesktopMessageController } from "./desktop-message-controller.mjs";
import { MessageReceiptRegistry } from "./message-receipts.mjs";

const EXISTING_IMAGE = fileURLToPath(
  new URL("./assets/mini-app/themes/blackhole/blackhole-blue.png", import.meta.url),
);

function controller(overrides = {}) {
  const target = {
    provider: "codex",
    projectRoot: "C:\\Project",
    threadId: "thread-1",
    taskTitle: "Task",
    chatId: 84,
  };
  return createDesktopMessageController({
    attachmentPaths: async () => [],
    resolveTarget: async () => target,
    receipts: new MessageReceiptRegistry(),
    persistReceipts: async () => {},
    snapshot: async () => ({ ok: true }),
    taskRuns: { forTask: () => null },
    taskExternalActivity: async () => ({ state: "inactive", executionOwner: null }),
    readCodexThread: async () => ({ thread: { turns: [] } }),
    deferConflictingInput: async () => ({ id: "deferred-1", item: { id: "deferred-1" } }),
    scheduleQueuedInput: () => {},
    sendRpc: async () => ({}),
    setProgressStage: () => {},
    noteRunActivity: () => {},
    scheduleProgressUpdate: () => {},
    activeRepositoryConflict: async () => null,
    beginRun: async () => ({
      id: "run-1",
      threadId: target.threadId,
      turnId: "turn-1",
    }),
    launchTurn: async () => {},
    ...overrides,
  });
}

test("desktop message controller deduplicates an in-flight and persisted client message", async () => {
  const receipts = new MessageReceiptRegistry();
  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  let beginCount = 0;
  let persistCount = 0;
  const messages = controller({
    receipts,
    beginRun: async () => {
      beginCount += 1;
      return { id: "run-1", threadId: "thread-1", turnId: "turn-1" };
    },
    launchTurn: async () => launchGate,
    persistReceipts: async () => { persistCount += 1; },
  });

  const params = { text: "один запрос", clientUserMessageId: "message-1" };
  const first = messages.sendMessage(params);
  const duplicate = messages.sendMessage(params);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(beginCount, 1);

  releaseLaunch();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(firstResult.runId, "run-1");
  assert.equal(duplicateResult.runId, "run-1");
  assert.equal(persistCount, 1);

  const replay = await messages.sendMessage(params);
  assert.equal(replay.runId, "run-1");
  assert.equal(beginCount, 1);
  assert.equal(persistCount, 1);
});

test("desktop message acknowledgement does not wait for a full snapshot", async () => {
  let snapshotCalls = 0;
  const messages = controller({
    snapshot: async () => {
      snapshotCalls += 1;
      throw new Error("slow snapshot must not delay acknowledgement");
    },
  });

  const result = await messages.sendMessage({
    text: "быстро подтвердить",
    clientUserMessageId: "message-fast-ack",
  });

  assert.equal(result.accepted, true);
  assert.equal(snapshotCalls, 0);
  assert.equal("snapshot" in result, false);
});

test("desktop message controller forwards the complete long user message", async () => {
  const text = "длинное сообщение ".repeat(2_000);
  let launchedInput;
  const messages = controller({
    launchTurn: async (_run, input) => { launchedInput = input; },
  });

  await messages.sendMessage({ text, clientUserMessageId: "message-long" });

  assert.equal(launchedInput, text.trim());
  assert.equal(launchedInput.length, text.trim().length);
});

test("desktop message controller queues a follow-up for an active task", async () => {
  const scheduled = [];
  let deferredOptions = null;
  const messages = controller({
    taskRuns: {
      forTask: () => ({ id: "run-active", executionOwner: "vscode" }),
    },
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return { id: "queued-1", item: { id: "queued-1" } };
    },
    scheduleQueuedInput: (item, delayMs) => scheduled.push({ item, delayMs }),
  });

  const result = await messages.sendMessage({
    text: "после текущего хода",
    clientUserMessageId: "message-queue",
    followUpMode: "queue",
  });

  assert.equal(result.queued, true);
  assert.equal(deferredOptions.destination, "queued");
  assert.equal(deferredOptions.notify, false);
  assert.deepEqual(scheduled, [{ item: { id: "queued-1" }, delayMs: 500 }]);
});

test("desktop message controller cannot jump ahead of an older deferred input", async () => {
  let deferredOptions = null;
  let beginCount = 0;
  const messages = controller({
    hasDeferredBacklog: () => true,
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return { id: "queued-behind-old", item: { id: "queued-behind-old" } };
    },
    beginRun: async () => {
      beginCount += 1;
      return { id: "should-not-start" };
    },
  });

  const result = await messages.sendMessage({
    text: "более новое сообщение",
    clientUserMessageId: "message-behind-old",
  });

  assert.equal(result.queued, true);
  assert.equal(result.reason, "queue-backlog");
  assert.equal(deferredOptions.destination, "queued");
  assert.equal(beginCount, 0);
});

test("desktop message controller steers the exact active Codex turn", async () => {
  const run = { id: "run-active", turnId: "turn-active", executionOwner: "vscode" };
  const stages = [];
  const rpc = [];
  const messages = controller({
    taskRuns: { forTask: () => run },
    sendRpc: async (method, params) => {
      rpc.push({ method, params });
      return { turnId: "turn-active" };
    },
    setProgressStage: (_run, stage) => stages.push(stage),
  });

  const result = await messages.sendMessage({
    text: "уточнение",
    clientUserMessageId: "message-steer",
    followUpMode: "steer",
  });

  assert.equal(result.steered, true);
  assert.equal(rpc[0].method, "turn/steer");
  assert.equal(rpc[0].params.expectedTurnId, "turn-active");
  assert.deepEqual(stages, ["Уточнение принято."]);
  assert.deepEqual(run.userMessages, [{
    role: "user",
    clientUserMessageId: "message-steer",
    text: "уточнение",
  }]);
});

test("a queued image message steers with its stable client id", async () => {
  const run = { id: "run-active", turnId: "turn-active", executionOwner: "vscode" };
  const rpc = [];
  const messages = controller({
    taskRuns: { forTask: () => run },
    sendRpc: async (method, params) => {
      rpc.push({ method, params });
      return { turnId: "turn-active" };
    },
  });
  const input = [
    { type: "text", text: "сохранённое сообщение" },
    { type: "localImage", path: EXISTING_IMAGE },
  ];

  const result = await messages.steerActiveInput({
    input,
    target: {
      provider: "codex",
      projectRoot: "C:\\Project",
      threadId: "thread-1",
      taskTitle: "Task",
    },
    clientUserMessageId: "queued-message-id",
  });

  assert.equal(result.steered, true);
  assert.equal(rpc[0].params.clientUserMessageId, "queued-message-id");
  assert.deepEqual(rpc[0].params.input, input);
});

test("desktop message controller preserves an uncertain external activity for explicit action", async () => {
  let deferredOptions = null;
  const messages = controller({
    taskExternalActivity: async () => ({ state: "unknown", executionOwner: "external" }),
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return { id: "pending-1", item: { id: "pending-1" } };
    },
  });

  const result = await messages.sendMessage({
    text: "не потерять",
    clientUserMessageId: "message-unknown",
  });

  assert.equal(result.reason, "activity-unknown");
  assert.equal(deferredOptions.allowForce, true);
  assert.equal(deferredOptions.conflictKind, "activity-unknown");
});

test("desktop message controller keeps image originals as message data", async () => {
  const file = EXISTING_IMAGE;
  let launched = null;
  const messages = controller({
    attachmentPaths: async () => [file],
    describeAttachments: () => [{
      id: "message-1.png",
      name: "message-1.png",
      type: "image/png",
    }],
    launchTurn: async (run, input, cleanupFiles) => {
      launched = { run, input, cleanupFiles };
    },
  });

  const result = await messages.sendMessage({
    text: "проверь скрин",
    attachments: [file],
    clientUserMessageId: "message-with-image",
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.attachments, [{
    id: "message-1.png",
    name: "message-1.png",
    type: "image/png",
  }]);
  assert.deepEqual(launched.cleanupFiles, []);
  assert.deepEqual(launched.run.messageAttachments, result.attachments);
  assert.deepEqual(launched.input, [
    { type: "text", text: "проверь скрин" },
    { type: "localImage", path: file },
  ]);
});

test("deferred Desktop images remain persistent and visible in the queue", async () => {
  const file = EXISTING_IMAGE;
  let deferredOptions = null;
  const messages = controller({
    attachmentPaths: async () => [file],
    taskRuns: { forTask: () => ({ id: "run-active", executionOwner: "vscode" }) },
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return { id: "queued-image", item: { id: "queued-image" } };
    },
  });

  const result = await messages.sendMessage({
    text: "после хода",
    attachments: [file],
    clientUserMessageId: "queued-with-image",
    followUpMode: "queue",
  });

  assert.equal(result.queued, true);
  assert.equal(deferredOptions.persistentFiles, true);
});
