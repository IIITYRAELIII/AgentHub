import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { DesktopTaskBoardController } from "../../../src/interfaces/desktop/desktop-task-board-controller.mjs";

test("board move and status acknowledge committed state without unrelated snapshot reads", async () => {
  let releaseMove;
  let committed = false;
  let fullReads = 0;
  const gate = new Promise((resolve) => { releaseMove = resolve; });
  const boardTasks = [{ id: "task-1", revision: 2, bucket: "notes" }];
  const controller = new DesktopTaskBoardController({
    taskLauncher: {},
    taskBoard: {
      move: async () => { await gate; committed = true; },
      snapshot: () => { assert.equal(committed, true); return boardTasks; },
      workspaces: () => [],
      layout: () => ({ columnOrder: ["notes"] }),
    },
    taskLifecycle: { updateWorkflowStatus: async () => ({ status: "done" }) },
    snapshot: () => { fullReads += 1; return new Promise(() => {}); },
  });
  let acknowledged = false;
  const pending = controller.move({ id: "task-1", responseView: "task-board" })
    .then((value) => { acknowledged = true; return value; });
  await Promise.resolve();
  assert.equal(acknowledged, false, "no ACK before the durable mutation");
  releaseMove();
  const result = await pending;
  assert.equal(result.view, "task-board");
  assert.deepEqual(result.boardTasks, boardTasks);
  const status = await controller.status({ id: "task-1", status: "done", responseView: "task-board" });
  assert.deepEqual(status.lifecycleResult, { status: "done" });
  assert.equal(fullReads, 0);
  controller.taskBoard.move = async () => { throw new Error("definite refusal"); };
  await assert.rejects(controller.move({ responseView: "task-board" }), /definite refusal/);
});

function fixture({ activeThread = null, sourceDetails = undefined, voiceTranscriber = null, attachmentDirectory = null } = {}) {
  const calls = [];
  const task = {
    id: "board-1",
    rawText: "Исправить Task dashboard",
    correctedText: "",
    status: "open",
    workspaceId: "workspace-1",
    streamId: null,
    sourceDetails,
    revision: 1,
    startEffectState: null,
    startEffectOwnerId: null,
  };
  const controller = new DesktopTaskBoardController({
    taskBoard: {
      task: () => task,
      create: (value) => { calls.push(["create", value]); return { id: "board-created", rawText: value.text }; },
      attachToSourceMessage: (value) => {
        calls.push(["attach", value]);
        return { id: "board-1", rawText: task.rawText };
      },
      appendSourceMessage: (value) => {
        calls.push(["append", value]);
        return { id: "board-1", rawText: `${task.rawText}\n${value.text}` };
      },
      mergeSourceMessage: (value) => {
        calls.push(["merge", value]);
        return { id: "board-1", rawText: value.text };
      },
      update: (value) => calls.push(["update", value]),
      updateChecklist: async (value) => calls.push(["checklist", value]),
      applyChecklistLinkedTaskAction: async (value) => calls.push(["checklist-linked-action", value]),
      addAttachment: (value) => calls.push(["add-attachment", value]),
      setWorkflowStatus: (value) => calls.push(["status", value]),
      move: (value) => calls.push(["move", value]),
      moveColumn: (value) => calls.push(["move-column", value]),
      setNotesComment: (value) => calls.push(["notes-comment", value]),
      prepareStart: ({ workspaceId, streamId, streamName, requestId, expectedRevision }) => {
        assert.equal(expectedRevision, task.revision);
        return Object.assign(task, {
          status: "starting",
          workspaceId,
          streamId,
          startStreamName: streamName,
          startRequestId: requestId,
          startDestinationStreamId: streamId,
          startEffectState: "prepared",
          startEffectOwnerId: null,
          revision: task.revision + 1,
        });
      },
      admitPreparedStart: ({ id, requestId, attemptId, expectedRevision }) => {
        assert.equal(id, task.id);
        assert.equal(requestId, task.startRequestId);
        assert.equal(expectedRevision, task.revision);
        assert.equal(task.startEffectState, "prepared");
        return Object.assign(task, {
          startEffectState: "admitted",
          startEffectOwnerId: attemptId,
          revision: task.revision + 1,
        });
      },
      cancelPreparedStart: ({ requestId, attemptId, expectedRevision }) => {
        assert.equal(requestId, task.startRequestId);
        assert.equal(attemptId, task.startEffectOwnerId);
        assert.equal(expectedRevision, task.revision);
        return Object.assign(task, {
          status: "open",
          streamId: null,
          startStreamName: null,
          startRequestId: null,
          startDestinationStreamId: null,
          startEffectState: null,
          startEffectOwnerId: null,
          revision: task.revision + 1,
        });
      },
      markStarted: (value) => {
        assert.equal(value.requestId, task.startRequestId);
        assert.equal(value.attemptId, task.startEffectOwnerId);
        assert.equal(value.expectedRevision, task.revision);
        calls.push(["started", value]);
        return Object.assign(task, {
          status: "started",
          streamId: value.streamId,
          startEffectState: "completed",
          startEffectOwnerId: null,
          revision: task.revision + 1,
        });
      },
    },
    taskLifecycle: {
      updateWorkflowStatus: async (value) => { calls.push(["lifecycle-status", value]); return task; },
      complete: async (value) => { calls.push(["lifecycle-complete", value]); return task; },
      delete: async (value) => { calls.push(["lifecycle-delete", value]); return { deleted: true, task }; },
    },
    workspaceCatalog: {
      workspace: (id) => id === "workspace-1" ? { id, name: "Agent Hub" } : null,
      stream: (id) => id === "stream-1" ? { id, workspaceId: "workspace-1" } : null,
      createStream: ({ id, workspaceId, name, settings }) => ({ id, workspaceId, name, settings }),
      activeThread: () => activeThread,
      updateWorkspaceComment: (...value) => calls.push(["workspace-comment", ...value]),
    },
    dispatchCommand: async (...args) => {
      calls.push(["command", ...args]);
      return {
        createdTask: {
          streamId: "stream-new",
          provider: "codex",
          threadId: "thread-new",
          projectRoot: "D:/work",
        },
      };
    },
    sendMessage: async (params) => calls.push(["message", params]),
    voiceTranscriber,
    attachmentDirectory,
    snapshot: async (value) => { calls.push(["snapshot", value]); return { boardTasks: [] }; },
  });
  return { controller, calls };
}

test("Dashboard diff resolves only the requested persisted Task identity", async () => {
  const calls = [];
  const controller = new DesktopTaskBoardController({
    taskBoard: { task(id) {
      if (id !== "exact-task") throw new Error("Task не найден");
      return { id, taskNumber: "HUB-235" };
    } },
    taskLauncher: {},
    taskGitWorkspaces: { async reviewDiff(input) {
      calls.push(input);
      return { repositories: [], truncated: false };
    } },
  });
  assert.deepEqual(await controller.diff({ id: "exact-task", projectRoot: "untrusted-path" }),
    { taskId: "exact-task", repositories: [], truncated: false });
  assert.deepEqual(calls, [{ taskId: "exact-task", taskNumber: "HUB-235" }]);
  await assert.rejects(controller.diff({ id: "missing-task" }), /Task не найден/u);
  assert.equal(calls.length, 1);
});

test("dashboard attachment mutation accepts only files from the runtime attachment directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-attachments-"));
  const attachmentDirectory = path.join(root, "attachments");
  const outside = path.join(root, "outside.txt");
  await mkdir(attachmentDirectory);
  const first = path.join(attachmentDirectory, "first.bin");
  const second = path.join(attachmentDirectory, "second.txt");
  await Promise.all([
    writeFile(first, Buffer.from([1, 2, 3])),
    writeFile(second, "text"),
    writeFile(outside, "outside"),
  ]);
  try {
    const [expectedFirst, expectedSecond] = await Promise.all([realpath(first), realpath(second)]);
    const { controller, calls } = fixture({ attachmentDirectory });
    await controller.addAttachments({ id: "board-1", attachments: [first, second] });
    assert.deepEqual(calls.slice(0, 2), [
      ["add-attachment", { id: "board-1", attachment: expectedFirst }],
      ["add-attachment", { id: "board-1", attachment: expectedSecond }],
    ]);
    assert.deepEqual(calls[2], ["snapshot", { refresh: true }]);
    await assert.rejects(
      controller.addAttachments({ id: "board-1", attachments: [outside] }),
      /Вложение недоступно/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard creation adds a manual task directly to its Workspace", async () => {
  const { controller, calls } = fixture();
  await controller.create({ text: "Новая задача", workspaceId: "workspace-1" });
  assert.deepEqual(calls[0], ["create", {
    text: "Новая задача", source: "hub", bucket: "workspace", workspaceId: "workspace-1",
  }]);
  assert.equal(calls.some(([name]) => name === "move"), false);
});

test("shared Telegram bot ingestion preserves its source and refreshes the dashboard", async () => {
  const { controller, calls } = fixture();
  assert.deepEqual(await controller.ingest({
    text: "Проверить общий бот",
    sourceKey: "shared-dashboard:123",
    sourceDetails: { chatId: "42", messageId: "7" },
  }), {
    taskId: "board-created",
    rawText: "Проверить общий бот",
  });
  assert.deepEqual(calls[0], ["create", {
    text: "Проверить общий бот",
    source: "telegram",
    sourceKey: "shared-dashboard:123",
    sourceDetails: { chatId: "42", messageId: "7" },
  }]);
  assert.deepEqual(calls[1], ["snapshot", { refresh: true }]);
});

test("shared Telegram bot persists downloaded images with the dashboard Task", async () => {
  const { controller, calls } = fixture();
  await controller.ingest({
    text: "Проверить скриншот",
    sourceKey: "shared-dashboard:bundle",
    sourceDetails: { imageCount: 1 },
    attachments: ["D:/runtime/attachments/screenshot.jpg"],
  });
  assert.deepEqual(calls[0][1].sourceDetails, {
    imageCount: 1,
    attachments: ["D:/runtime/attachments/screenshot.jpg"],
  });
});

test("a screenshot reply augments the existing dashboard Task", async () => {
  const { controller, calls } = fixture();
  await controller.ingest({
    replyMessageId: 7,
    sourceDetails: { chatId: 42, userId: 42, messageId: 8 },
    attachments: ["D:/runtime/attachments/screenshot.jpg"],
  });
  assert.deepEqual(calls[0], ["attach", {
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 7,
    attachments: ["D:/runtime/attachments/screenshot.jpg"],
  }]);
  assert.equal(calls.some(([name]) => name === "create"), false);
});

test("shared Telegram bot adds a Terra-refined voice transcript and keeps the audio attachment", async () => {
  const transcribed = [];
  const transcript = "Нужно исправить фильтр до пятницы. ".repeat(1_000).trim();
  const { controller, calls } = fixture({
    voiceTranscriber: {
      transcribe: async (file) => {
        transcribed.push(file);
        return transcript;
      },
    },
  });
  await controller.ingest({
    text: "--- Сообщение 1 · Переслано · Иван ---\n[Голосовое сообщение 1 приложено следом за этим сообщением]",
    sourceKey: "shared-dashboard:voice",
    sourceDetails: { attachmentKinds: ["voice"] },
    attachments: ["D:/runtime/attachments/voice.ogg"],
  });
  assert.deepEqual(transcribed, ["D:/runtime/attachments/voice.ogg"]);
  assert.match(calls[0][1].text, /Расшифровка голосового сообщения 1[\s\S]*исправить фильтр/u);
  assert.ok(calls[0][1].text.endsWith(transcript));
  assert.deepEqual(calls[0][1].sourceDetails.attachments, ["D:/runtime/attachments/voice.ogg"]);
});

test("a text reply to an own Telegram message clarifies the existing dashboard Task", async () => {
  const { controller, calls } = fixture();
  await controller.ingest({
    replyMessageId: 7,
    text: "надо сдать..",
    sourceDetails: { chatId: 42, userId: 42, messageId: 8, replyToMessageId: 7 },
  });
  assert.deepEqual(calls[0], ["append", {
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 7,
    text: "надо сдать..",
    sourceDetails: { chatId: 42, userId: 42, messageId: 8, replyToMessageId: 7 },
    attachments: [],
  }]);
  assert.equal(calls.some(([name]) => name === "create"), false);
});

test("a forward following a short comment expands the existing dashboard Task", async () => {
  const { controller, calls } = fixture();
  await controller.ingest({
    mergeMessageId: 18,
    text: "--- Сообщение 1 · Вы ---\nКЭМЗ\n\n--- Сообщение 2 · Переслано · Иван ---\nКонтекст",
    sourceDetails: { chatId: 42, userId: 42, bundleId: "bundle-1" },
  });
  assert.deepEqual(calls[0], ["merge", {
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 18,
    text: "--- Сообщение 1 · Вы ---\nКЭМЗ\n\n--- Сообщение 2 · Переслано · Иван ---\nКонтекст",
    sourceDetails: { chatId: 42, userId: 42, bundleId: "bundle-1" },
  }]);
  assert.equal(calls.some(([name]) => name === "create"), false);
});

test("dashboard persists column reordering", async () => {
  const { controller, calls } = fixture();
  await controller.moveColumn({ columnId: "notes", beforeColumnId: "workspace:workspace-1" });
  assert.deepEqual(calls[0], ["move-column", {
    columnId: "notes", beforeColumnId: "workspace:workspace-1",
  }]);
});

test("dashboard saves edited Task fields", async () => {
  const { controller, calls } = fixture();
  await controller.update({ id: "board-1", title: "Новый заголовок", description: "Описание" });
  assert.deepEqual(calls[0], ["update", {
    id: "board-1", title: "Новый заголовок", description: "Описание",
  }]);
  assert.deepEqual(calls[1], ["snapshot", { refresh: true }]);
});

test("dashboard checklist mutation waits for durable completion before snapshot", async () => {
  const { controller, calls } = fixture();
  const result = await controller.checklist({
    id: "board-1", operation: "add", text: "Проверить", expectedRevision: 1, requestId: "check-1",
  });
  assert.deepEqual(calls, [
    ["checklist", {
      id: "board-1", operation: "add", text: "Проверить", expectedRevision: 1, requestId: "check-1",
    }],
    ["snapshot", { refresh: true }],
  ]);
  assert.deepEqual(result, { boardTasks: [] });
});

test("dashboard linked Task action waits for durable completion before snapshot", async () => {
  const { controller, calls } = fixture();
  const params = {
    id: "board-1", itemId: "item-1", linkedTaskId: "board-2", action: "done",
    expectedTaskRevision: 4, expectedLinkedTaskRevision: 2, requestId: "linked-action-1",
  };
  const result = await controller.checklistLinkedTaskAction(params);
  assert.deepEqual(calls, [
    ["checklist-linked-action", params],
    ["snapshot", { refresh: true }],
  ]);
  assert.deepEqual(result, { boardTasks: [] });
});

test("dashboard changes a Task workflow status manually", async () => {
  const { controller, calls } = fixture();
  await controller.status({ id: "board-1", status: "testing" });
  assert.deepEqual(calls[0], ["lifecycle-status", {
    taskId: "board-1", status: "testing", operationId: "",
  }]);
  assert.deepEqual(calls[1], ["snapshot", { refresh: true }]);
});

test("dashboard Complete and Delete use the shared lifecycle owner", async () => {
  const { controller, calls } = fixture();
  await controller.complete({
    id: "board-1", confirmCleanup: true, expectedCleanupToken: "complete-token",
  }, { commandId: "desktop-complete" });
  await controller.remove({
    id: "board-1", confirmCleanup: true, expectedCleanupToken: "delete-token",
  }, { commandId: "desktop-delete" });
  assert.deepEqual(calls.filter(([kind]) => kind.startsWith("lifecycle-")), [
    ["lifecycle-complete", {
      taskId: "board-1", operationId: "desktop-complete",
      confirmCleanup: true, expectedCleanupToken: "complete-token",
    }],
    ["lifecycle-delete", {
      taskId: "board-1", operationId: "desktop-delete",
      confirmCleanup: true, expectedCleanupToken: "delete-token",
    }],
  ]);
});

test("legacy Workspace move adapts to the shared column contract", async () => {
  const { controller, calls } = fixture();
  await controller.moveWorkspace({ workspaceId: "workspace-2", beforeWorkspaceId: "workspace-1" });
  assert.deepEqual(calls[0], ["move-column", {
    columnId: "workspace:workspace-2", beforeColumnId: "workspace:workspace-1",
  }]);
});

test("dashboard updates Notes and Workspace comments", async () => {
  const { controller, calls } = fixture();
  await controller.updateColumnComment({ columnId: "notes", comment: "Фильмы" });
  await controller.updateColumnComment({ columnId: "workspace:workspace-1", comment: "Разработка" });
  assert.deepEqual(calls.filter(([name]) => name !== "snapshot"), [
    ["notes-comment", { columnId: "notes", comment: "Фильмы" }],
    ["workspace-comment", "workspace-1", "Разработка"],
  ]);
});

test("starting a Task in an existing Stream sends a uniquely identified reference instead of its raw text", async () => {
  const { controller, calls } = fixture({
    activeThread: { provider: "codex", threadId: "thread-1", projectRoot: "D:/work" },
    sourceDetails: { attachments: ["D:/runtime/attachments/screenshot.jpg"] },
  });
  await controller.start({
    id: "board-1",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    clientUserMessageId: "board-task:board-1:launch-2",
  });
  assert.equal(calls[0][1], "task.select");
  assert.equal(calls[1][0], "message");
  assert.equal(calls[1][1].text, "");
  assert.equal(calls[1][1].clientUserMessageId, "board-task:board-1:launch-2");
  assert.deepEqual(calls[1][1].taskReferences, [{ taskId: "board-1", intent: "start" }]);
  assert.equal("attachments" in calls[1][1], false);
  assert.equal(calls[2][0], "started");
  assert.deepEqual({
    id: calls[2][1].id,
    workspaceId: calls[2][1].workspaceId,
    streamId: calls[2][1].streamId,
    requestId: calls[2][1].requestId,
    expectedRevision: calls[2][1].expectedRevision,
  }, {
    id: "board-1", workspaceId: "workspace-1", streamId: "stream-1",
    requestId: "board-task:board-1:launch-2", expectedRevision: 3,
  });
  assert.match(calls[2][1].attemptId, /^[0-9a-f-]{36}$/u);
});

test("starting a Task accepts the former context namespace as an ordinary identity", async () => {
  let launchCalls = 0;
  const controller = new DesktopTaskBoardController({
    taskLauncher: {
      start: async () => { launchCalls += 1; return {}; },
    },
    snapshot: async () => ({}),
  });

  await controller.start({
    id: "board-1",
    clientUserMessageId: "agent-hub-context-probe:7583805f-6338-47f0-bc45-539530666ca3",
  });
  assert.equal(launchCalls, 1);
});

test("starting a Task can create a new Stream before sending", async () => {
  const { controller, calls } = fixture();
  await controller.start({
    id: "board-1", workspaceId: "workspace-1", streamName: "Dashboard", provider: "codex",
  });
  assert.equal(calls[0][1], "task.create");
  assert.match(calls[0][2].streamId, /^task-launch-/u);
  assert.equal(calls[1][1].streamId, "stream-new");
});

test("default Desktop launcher admits real TaskBoardService starts for existing and new Streams", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-task-launch-"));
  const databaseFile = path.join(root, "hub.sqlite");
  const workspaceCatalog = new WorkspaceCatalogStore({ databaseFile });
  await workspaceCatalog.load();
  const taskStore = new TaskBoardStore({ databaseFile });
  const taskBoard = new TaskBoardService({ store: taskStore, workspaceCatalog });
  context.after(async () => {
    taskStore.close();
    workspaceCatalog.close();
    await rm(root, { recursive: true, force: true });
  });

  const workspace = await workspaceCatalog.createWorkspace({
    id: "workspace-desktop-launch", name: "Desktop launch",
  });
  const existingStream = await workspaceCatalog.createStream({
    id: "stream-desktop-existing", workspaceId: workspace.id, name: "Existing",
  });
  await workspaceCatalog.bindThread({
    streamId: existingStream.id,
    provider: "codex",
    threadId: "thread-desktop-existing",
    projectRoot: root,
  });
  const effects = [];
  const controller = new DesktopTaskBoardController({
    taskBoard,
    workspaceCatalog,
    dispatchCommand: async (type, payload) => {
      effects.push([type, payload.streamId]);
      if (type === "task.select") return {};
      assert.equal(type, "task.create");
      const threadId = `thread-${payload.streamId}`;
      await workspaceCatalog.bindThread({
        streamId: payload.streamId, provider: "codex", threadId, projectRoot: root,
      });
      return { createdTask: {
        streamId: payload.streamId, provider: "codex", threadId, projectRoot: root,
      } };
    },
    sendMessage: async (params) => {
      effects.push(["delivery", params.streamId]);
      return { accepted: true, id: `delivery-${params.streamId}` };
    },
    snapshot: async () => ({ boardTasks: await taskBoard.snapshot() }),
  });

  const existingTask = await taskBoard.create({
    text: "Existing Stream start", bucket: "workspace", workspaceId: workspace.id,
  });
  await controller.start({
    id: existingTask.id,
    workspaceId: workspace.id,
    streamId: existingStream.id,
    launchRequestId: "desktop-existing-launch",
  });
  const existingStarted = await taskBoard.task(existingTask.id);
  assert.equal(existingStarted.status, "started");
  assert.equal(existingStarted.startEffectState, "completed");
  assert.equal(existingStarted.startEffectOwnerId, null);

  const newTask = await taskBoard.create({
    text: "New Stream start", bucket: "workspace", workspaceId: workspace.id,
  });
  await controller.start({
    id: newTask.id,
    workspaceId: workspace.id,
    streamName: "Created by Desktop",
    provider: "codex",
    launchRequestId: "desktop-new-launch",
  });
  const newStarted = await taskBoard.task(newTask.id);
  assert.equal(newStarted.status, "started");
  assert.equal(newStarted.startEffectState, "completed");
  assert.equal(newStarted.startEffectOwnerId, null);
  assert.ok(workspaceCatalog.stream(newStarted.streamId));
  assert.deepEqual(effects.map(([type]) => type), [
    "task.select", "delivery", "task.create", "delivery",
  ]);
});
