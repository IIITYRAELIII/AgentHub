import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDesktopMessageController } from "../../../src/interfaces/desktop/desktop-message-controller.mjs";
import { MessageReceiptRegistry } from "../../../src/infrastructure/persistence/message-receipts.mjs";
import { RunCoordinator } from "../../../src/application/run-coordinator.mjs";

const EXISTING_IMAGE = fileURLToPath(
  new URL("../../../assets/web-app/themes/blackhole/blackhole-blue.jpg", import.meta.url),
);

function controller(overrides = {}) {
  const target = {
    provider: "codex",
    projectRoot: "C:\\Project",
    threadId: "thread-1",
    taskTitle: "Task",
    chatId: 84,
  };
  const taskRuns = overrides.taskRuns ?? { forTask: () => null };
  const readCodexThread = overrides.readCodexThread ?? (async () => ({ thread: { turns: [] } }));
  const sendRpc = overrides.sendRpc ?? (async () => ({}));
  const describeAttachments = overrides.describeAttachments
    ?? ((files) => files.map((file) => ({ id: String(file) })));
  const runCoordinator = overrides.runCoordinator ?? new RunCoordinator({
    taskRuns,
    providers: {
      call: async (provider, operation, { run, target: runTarget, input, clientUserMessageId }) => {
        if (operation !== "steerTurn") throw new Error(`unexpected provider operation: ${operation}`);
        if (provider !== "codex") throw new Error("Отправка в текущий ход недоступна для выбранного агента");
        let turnId = String(run?.turnId ?? "").trim();
        if (!turnId) {
          const result = await readCodexThread(runTarget.threadId, { fresh: true });
          const active = (result.thread?.turns ?? []).filter((turn) => (
            ["inProgress", "in_progress", "running"].includes(String(turn?.status ?? ""))
          ));
          if (active.length !== 1) throw new Error("Текущий ход уже нельзя изменить");
          turnId = String(active[0].id);
        }
        const result = await sendRpc("turn/steer", {
          threadId: runTarget.threadId,
          expectedTurnId: turnId,
          input: typeof input === "string" ? [{ type: "text", text: input }] : input,
          clientUserMessageId,
        });
        return { turnId: String(result?.turnId ?? turnId) };
      },
    },
    externalActivity: overrides.taskExternalActivity
      ?? (async () => ({ state: "inactive", executionOwner: null })),
    repositoryConflict: overrides.activeRepositoryConflict ?? (async () => null),
    deferInput: overrides.deferConflictingInput
      ?? (async () => ({ id: "deferred-1", item: { id: "deferred-1" } })),
    scheduleDeferred: overrides.scheduleQueuedInput ?? (() => {}),
    hasDeferredBacklog: overrides.hasDeferredBacklog ?? (() => false),
    setProgressStage: overrides.setProgressStage ?? (() => {}),
    noteRunActivity: overrides.noteRunActivity ?? (() => {}),
    scheduleProgressUpdate: overrides.scheduleProgressUpdate ?? (() => {}),
    describeAttachments,
    beginRun: overrides.beginRun ?? (async () => ({
      id: "run-1",
      threadId: target.threadId,
      turnId: "turn-1",
    })),
    rollbackAdmission: async () => {},
    launchTurn: overrides.launchTurn ?? (async () => {}),
  });
  return createDesktopMessageController({
    attachmentPaths: overrides.attachmentPaths ?? (async () => []),
    describeAttachments,
    resolveTaskReferences: overrides.resolveTaskReferences ?? (async () => []),
    resolveTarget: overrides.resolveTarget ?? (async () => target),
    receipts: overrides.receipts ?? new MessageReceiptRegistry(),
    persistReceipts: overrides.persistReceipts ?? (async () => {}),
    runCoordinator,
    durableIntake: overrides.durableIntake ?? false,
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
  assert.equal(persistCount, 2);

  const replay = await messages.sendMessage(params);
  assert.equal(replay.runId, "run-1");
  assert.equal(beginCount, 1);
  assert.equal(persistCount, 2);
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

test("desktop message acknowledgement does not hash attachment content", async () => {
  const missingFile = path.resolve("missing-upload.png");
  const messages = controller({
    attachmentPaths: async () => [missingFile],
    describeAttachments: () => [{ id: "upload-id--missing-upload.png", name: "missing-upload.png" }],
  });

  const result = await messages.sendMessage({
    text: "принять без чтения файла",
    attachments: [missingFile],
    clientUserMessageId: "message-no-content-hash",
  });

  assert.equal(result.accepted, true);
});

test("durable desktop intake reuses the queue persistence boundary", async () => {
  const receipts = new MessageReceiptRegistry();
  let controllerPersistenceCalls = 0;
  let receiptCapturedByQueue = null;
  const messages = controller({
    durableIntake: true,
    receipts,
    persistReceipts: async () => { controllerPersistenceCalls += 1; },
    runCoordinator: {
      submitClientInput: async () => assert.fail("durable intake must use acceptClientInput"),
      steer: async () => ({}),
      acceptClientInput: async () => {
        receiptCapturedByQueue = receipts.get({ clientUserMessageId: "message-one-boundary" });
        return {
          accepted: true,
          queued: true,
          threadId: "thread-1",
          clientUserMessageId: "message-one-boundary",
        };
      },
    },
  });

  const result = await messages.sendMessage({
    text: "не ждать три записи",
    clientUserMessageId: "message-one-boundary",
  });

  assert.equal(receiptCapturedByQueue.result.pending, true);
  assert.equal(controllerPersistenceCalls, 0);
  assert.equal(result.accepted, true);
  assert.equal(receipts.get({ clientUserMessageId: "message-one-boundary" }).result.pending, false);
});

test("desktop message receipt preserves the interstream source author", async () => {
  const receipts = new MessageReceiptRegistry();
  const messageOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "codex",
    model: "gpt-5.6-sol",
    sourceThreadId: "thread-themes",
    requestId: "request-receipt",
  };
  const messages = controller({
    receipts,
    resolveTarget: async () => ({
      provider: "codex",
      projectRoot: "C:\\Project",
      threadId: "thread-1",
      taskTitle: "Task",
      messageOrigin,
    }),
  });

  await messages.sendMessage({
    text: "проверить receipt",
    clientUserMessageId: "message-origin-receipt",
  });

  const receipt = receipts.get({ clientUserMessageId: "message-origin-receipt" });
  assert.equal(receipt.result.author, "Agent HUB - Themes (Sol)");
  assert.deepEqual(receipt.result.origin, messageOrigin);
});

test("desktop message keeps an active follow-up pending for a manual action", async () => {
  const scheduled = [];
  let deferredOptions = null;
  const messages = controller({
    durableIntake: true,
    taskRuns: { forTask: () => ({ id: "run-active", executionOwner: "hub" }) },
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return {
        id: "durable-pending",
        item: { id: "durable-pending", destination: options.destination },
      };
    },
    scheduleQueuedInput: (item, delayMs) => scheduled.push({ item, delayMs }),
  });

  const result = await messages.sendMessage({
    text: "сохранить для ручного действия",
    clientUserMessageId: "message-durable-intake",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.deferred, true);
  assert.equal(result.queued, undefined);
  assert.equal(result.reason, "task-running");
  assert.equal(deferredOptions.destination, undefined);
  assert.equal(deferredOptions.conflictKind, "task-running");
  assert.deepEqual(scheduled, []);
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

test("desktop message controller steers the exact Hub-owned Codex turn", async () => {
  const run = { id: "run-active", turnId: "turn-active", executionOwner: "hub" };
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
  assert.deepEqual(run.userMessages.map(({ time: _time, ...message }) => message), [{
    role: "user",
    clientUserMessageId: "message-steer",
    text: "уточнение",
  }]);
  assert.equal(Number.isFinite(Date.parse(run.userMessages[0].time)), true);
});

test("a queued image message steers with its stable client id", async () => {
  const run = { id: "run-active", turnId: "turn-active", executionOwner: "hub" };
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

test("desktop message controller sends documents as named file references", async () => {
  const file = path.resolve("README.md");
  let launched = null;
  const descriptors = [{
    id: "document-id.pdf",
    name: "Требования.pdf",
    type: "application/pdf",
    isImage: false,
  }];
  const messages = controller({
    attachmentPaths: async () => [file],
    describeAttachments: () => descriptors,
    launchTurn: async (run, input, cleanupFiles) => {
      launched = { run, input, cleanupFiles };
    },
  });

  const result = await messages.sendMessage({
    text: "проверь документ",
    attachments: [file],
    clientUserMessageId: "message-with-document",
  });

  assert.deepEqual(result.attachments, descriptors);
  assert.match(launched.input[0].text, /## Требования\.pdf:/u);
  assert.match(launched.input[0].text, /проверь документ/u);
  assert.deepEqual(launched.input[1], { type: "localFile", path: file });
});

test("desktop message controller resolves Dashboard Task references into links", async () => {
  let launchedInput = null;
  const reference = {
    kind: "task",
    taskId: "board-1",
    title: "Исправить Dashboard",
    workflowStatus: "testing",
    workspaceId: "workspace-1",
    intent: "context",
  };
  const messages = controller({
    resolveTaskReferences: async () => [reference],
    launchTurn: async (_run, input) => { launchedInput = input; },
  });

  const result = await messages.sendMessage({
    text: "Сравни с текущим решением",
    taskReferences: [{ taskId: "board-1", intent: "context" }],
    clientUserMessageId: "message-with-task",
  });

  assert.match(launchedInput, /\[Dashboard Task: Исправить Dashboard\]\(agent-hub:\/\/task\/board-1\)/u);
  assert.match(launchedInput, /intent: context/u);
  assert.match(launchedInput, /Сравни с текущим решением/u);
  assert.deepEqual(result.attachments, [reference]);
});

test("desktop message receipt preserves the visible message before provider launch", async () => {
  const receipts = new MessageReceiptRegistry();
  let observedReceipt = null;
  const messages = controller({
    receipts,
    persistReceipts: async () => {
      observedReceipt ??= receipts.get({ clientUserMessageId: "message-visible" });
    },
  });

  await messages.sendMessage({
    text: "служебный конверт",
    displayText: "Видимый вопрос",
    responseAnnotations: [{ text: "Цитата", annotation: "Комментарий" }],
    responseAnnotationRequest: "Что изменить?",
    clientUserMessageId: "message-visible",
  });

  assert.equal(observedReceipt.result.pending, true);
  assert.equal(observedReceipt.result.displayText, "Видимый вопрос");
  assert.deepEqual(observedReceipt.result.responseAnnotations, [{
    text: "Цитата",
    annotation: "Комментарий",
  }]);
  assert.equal(observedReceipt.result.responseAnnotationRequest, "Что изменить?");
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
