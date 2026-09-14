import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopApplicationRouter } from "../../../src/interfaces/desktop/desktop-application-router.mjs";

function router(calls, { omit = [] } = {}) {
  const handler = async (params) => ({ params });
  const handlers = Object.fromEntries([
    "snapshot", "runtimeHealth", "retryStartup", "taskHistory", "rateLimitHistory", "usageHistory", "search", "workspaceMessageSearch", "markTaskRead",
    "openTask", "openTurn", "workspaceMessageOpen", "sendMessage", "taskDiff", "deferredInput",
    "statusDetails", "speakLastAnswer", "restartServer", "setAutostart",
    "updateServerConfiguration", "readPreTurnInstructions", "updateGlobalPreTurnInstructions",
    "readRootAgents", "updateRootAgents", "compactContext", "openAttachment", "browseDirectory", "submitBugReport", "reportDiagnostic",
    "trustedDevices", "createDevicePairing", "revokeDevice",
    "messagePinSet", "messagePinsClear",
    "renameWorkspace", "createWorkspaceFromStream", "mergeWorkspaces", "renameStream", "moveStream",
    "boardTaskCreate", "boardTaskIngest", "boardTaskUpdate", "boardTaskChecklist", "boardTaskChecklistLinkedAction", "boardTaskAttachmentAdd", "boardTaskStatus", "boardTaskMove", "boardTaskComplete", "boardTaskRemove",
    "boardTaskRetryTriage", "boardTaskStart", "boardColumnMove", "boardColumnComment",
    "boardWorkspaceMove", "usageSync", "usageSyncInvite", "usageSyncEnroll", "usageSyncDeviceLabel",
  ].map((name) => [name, handler]));
  for (const name of omit) delete handlers[name];
  return createDesktopApplicationRouter({
    handlers,
    commands: {
      dispatch: async (...args) => { calls.push(args); return { accepted: true }; },
      settingTarget: (params) => ({
        streamId: params.streamId,
        provider: params.provider,
        threadId: params.threadId,
      }),
    },
  });
}

test("Desktop application router requires the Task workflow status handler", () => {
  assert.throws(
    () => router([], { omit: ["boardTaskStatus"] }),
    /boardTaskStatus is required/u,
  );
});

test("Desktop application router forwards the exact startup generation for recovery", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({
    action: "retry-startup", params: { startedAtMs: 1234 },
    context: { source: "desktop-control", userId: "7" },
  });
  assert.equal(result.params.startedAtMs, 1234);
});

test("Desktop application router addresses mutations explicitly", async () => {
  const calls = [];
  const control = router(calls);
  await control.handleDesktopControl({
    action: "select-task",
    params: { streamId: "stream-1", provider: "codex", threadId: "thread-1" },
    context: { source: "desktop", userId: "7" },
  });
  assert.equal(calls[0][0], "task.select");
  assert.equal(calls[0][2].clientId, "desktop:7");
  assert.equal(calls[0][3].target.streamId, "stream-1");
});

test("Desktop application router exposes durable message pin mutations", async () => {
  const control = router([]);
  const pinned = await control.handleDesktopControl({
    action: "message-pin-set",
    params: { streamId: "stream-1", messageKey: "message:v1:answer", pinned: true },
    context: { source: "trusted-device", userId: "7" },
  });
  const cleared = await control.handleDesktopControl({
    action: "message-pins-clear",
    params: { streamId: "stream-1" },
    context: { source: "trusted-device", userId: "7" },
  });
  assert.equal(pinned.params.pinned, true);
  assert.equal(cleared.params.streamId, "stream-1");
});

test("Desktop application router creates a Workspace from an existing Stream", async () => {
  const calls = [];
  const control = router(calls);
  await control.handleDesktopControl({
    action: "create-workspace-from-stream",
    params: { streamId: "stream-1", name: "New Workspace" },
    context: { source: "desktop", userId: "7" },
  });
  assert.equal(calls[0][0], "workspace.create-from-stream");
  assert.equal(calls[0][1].streamId, "stream-1");
  assert.equal(calls[0][1].name, "New Workspace");
});

test("Desktop application router creates a Workspace before any provider Thread", async () => {
  const calls = [];
  const control = router(calls);
  await control.handleDesktopControl({
    action: "create-workspace",
    params: { name: "New Workspace", comment: "Описание" },
    context: { source: "desktop", userId: "7" },
  });
  assert.equal(calls[0][0], "workspace.create");
  assert.deepEqual(calls[0][1], {
    name: "New Workspace", comment: "Описание", maxResponseBytes: 3_500_000,
  });
});

test("Desktop application router dispatches Stream rotation to the exact Thread", async () => {
  const calls = [];
  const control = router(calls);
  await control.handleDesktopControl({
    action: "rotate-stream",
    params: { streamId: "stream-1", provider: "codex", threadId: "thread-1" },
    context: { source: "desktop", userId: "7" },
  });
  assert.equal(calls[0][0], "stream.rotate");
  assert.deepEqual(calls[0][3].target, {
    streamId: "stream-1", provider: "codex", projectRoot: null, threadId: "thread-1",
  });
});

test("Desktop application router creates a provider Thread inside an existing Stream", async () => {
  const calls = [];
  const control = router(calls);
  await control.handleDesktopControl({
    action: "new-task",
    params: { streamId: "stream-1", provider: "claude" },
    context: { source: "desktop", userId: "7" },
  });
  assert.equal(calls[0][0], "task.create");
  assert.deepEqual(calls[0][1], {
    streamId: "stream-1",
    provider: "claude",
    maxResponseBytes: 3_500_000,
  });
});

test("Desktop application router dispatches settings to the client task identity", async () => {
  const calls = [];
  const control = router(calls);
  await control.handleDesktopControl({
    action: "update-setting",
    params: {
      name: "reasoning",
      value: "high",
      streamId: "stream-client",
      provider: "claude",
      threadId: "thread-client",
    },
    context: { source: "vscode", userId: "7" },
  });
  assert.equal(calls[0][0], "settings.update");
  assert.equal(calls[0][2].clientId, "vscode:7");
  assert.deepEqual(calls[0][3].target, {
    streamId: "stream-client",
    provider: "claude",
    threadId: "thread-client",
  });
});

test("Desktop application router enforces Mini App history limits", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({
    action: "task-history",
    params: { limit: 99, maxAnswerChars: 999_999 },
    context: { source: "telegram-mini-app" },
  });
  assert.equal(result.params.limit, 10);
  assert.equal(result.params.maxAnswerChars, 75_000);
});

test("Desktop application router exposes root AGENTS read and serialized update", async () => {
  const control = router([]);
  assert.equal((await control.handleDesktopControl({
    action: "read-root-agents", params: { path: "C:/ignored" },
  })).params.path, "C:/ignored");
  assert.equal((await control.handleDesktopControl({
    action: "update-root-agents", params: { content: "# Rules" },
  })).params.content, "# Rules");
});

test("Desktop application router exposes the local directory picker", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({
    action: "browse-directory",
    params: { initialPath: "D:\\projects" },
    context: { source: "local-mini-app" },
  });
  assert.equal(result.params.initialPath, "D:\\projects");
});

test("Desktop application router exposes pre-turn instructions read and Global update", async () => {
  const control = router([]);
  assert.equal((await control.handleDesktopControl({
    action: "read-pre-turn-instructions", params: {},
  })).params.constructor, Object);
  assert.equal((await control.handleDesktopControl({
    action: "update-global-pre-turn-instructions", params: { content: "Rules" },
  })).params.content, "Rules");
});

test("Desktop application router exposes runtime health without a Web server", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({ action: "runtime-health", params: {} });
  assert.deepEqual(result.params, { maxResponseBytes: 3_500_000 });
});

test("Desktop application router archives, restores, and exactly deletes a Workspace", async () => {
  const calls = [];
  const control = router(calls);
  for (const action of ["archive-workspace", "restore-workspace"]) {
    await control.handleDesktopControl({
      action,
      params: { workspaceId: "workspace-1" },
      context: { source: "desktop", userId: "7" },
    });
  }
  await control.handleDesktopControl({
    action: "delete-archived-workspace",
    params: { workspaceId: "workspace-1", confirmationName: "Exact name" },
    context: { source: "desktop", userId: "7" },
  });
  assert.deepEqual(calls.map(([type, payload]) => [type, payload.workspaceId]), [
    ["workspace.archive", "workspace-1"],
    ["workspace.restore", "workspace-1"],
    ["workspace.delete-archived", "workspace-1"],
  ]);
  assert.equal(calls[2][1].confirmationName, "Exact name");
});

test("Desktop application router renames a Workspace folder atomically", async () => {
  const calls = [];
  const control = router(calls);
  await control.handleDesktopControl({
    action: "rename-workspace-folder",
    params: { fromFolderName: "Клиенты", toFolderName: "Заказчики" },
    context: { source: "desktop", userId: "7" },
  });
  assert.deepEqual(calls.map(([type, payload]) => [type, payload]), [[
    "workspace.folder.rename",
    { fromFolderName: "Клиенты", toFolderName: "Заказчики", maxResponseBytes: 3_500_000 },
  ]]);
});

test("Desktop application router moves a Workspace with a narrow folder command", async () => {
  const calls = [];
  const control = router(calls);
  await control.handleDesktopControl({
    action: "move-workspace-to-folder",
    params: { workspaceId: "workspace-1", folderName: "Клиенты" },
    context: { source: "desktop", userId: "7" },
  });
  assert.deepEqual(calls.map(([type, payload]) => [type, payload]), [[
    "workspace.folder.move",
    { workspaceId: "workspace-1", folderName: "Клиенты", maxResponseBytes: 3_500_000 },
  ]]);
});

test("Desktop application router forwards diagnostic events", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({
    action: "report-diagnostic",
    params: { name: "TypeError", message: "render failed" },
    context: { source: "vscode", userId: "7" },
  });
  assert.equal(result.params.message, "render failed");
});

test("Desktop application router keeps the legacy Workspace move alias", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({
    action: "board-workspace-move",
    params: { workspaceId: "workspace-2", beforeWorkspaceId: "workspace-1" },
  });
  assert.equal(result.params.workspaceId, "workspace-2");
  assert.equal(result.params.beforeWorkspaceId, "workspace-1");
});

test("Desktop application router saves Task presentation fields", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({
    action: "board-task-update",
    params: { id: "board-1", title: "Новый заголовок", description: "Описание" },
  });
  assert.deepEqual(result.params, {
    id: "board-1", title: "Новый заголовок", description: "Описание", maxResponseBytes: 3_500_000,
  });
});

test("Desktop application router exposes the checklist mutation boundary", async () => {
  const control = router([]);
  const params = {
    id: "board-1", operation: "add", text: "Проверить", expectedRevision: 1, requestId: "check-1",
  };
  const result = await control.handleDesktopControl({ action: "board-task-checklist", params });
  assert.deepEqual(result.params, { ...params, maxResponseBytes: 3_500_000 });
});

test("Desktop application router exposes the exact linked Task action boundary", async () => {
  const control = router([]);
  const params = {
    id: "parent", itemId: "item-1", linkedTaskId: "child", action: "done_and_close",
    expectedTaskRevision: 7, expectedLinkedTaskRevision: 3, requestId: "linked-action-1",
  };
  const result = await control.handleDesktopControl({
    action: "board-task-checklist-linked-action",
    params,
  });
  assert.deepEqual(result.params, { ...params, maxResponseBytes: 3_500_000 });
});

test("Desktop application router marks read outside the command ledger", async () => {
  const calls = [];
  const control = router(calls);
  const result = await control.handleDesktopControl({
    action: "mark-task-read",
    params: { final: { provider: "codex", threadId: "thread-1", turnId: "turn-1", revision: 2 } },
  });
  assert.equal(result.params.final.revision, 2);
  assert.deepEqual(calls, []);
});

test("Desktop application router changes a Task workflow status", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({
    action: "board-task-status",
    params: { id: "board-1", status: "awaiting_implementation" },
  });
  assert.equal(result.params.id, "board-1");
  assert.equal(result.params.status, "awaiting_implementation");
});

test("Desktop application router adds files to a Dashboard Task", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({
    action: "board-task-attachment-add",
    params: { id: "board-1", attachments: ["D:/runtime/attachments/file.bin"] },
  });
  assert.deepEqual(result.params, {
    id: "board-1",
    attachments: ["D:/runtime/attachments/file.bin"],
    maxResponseBytes: 3_500_000,
  });
});

test("Desktop application router accepts a message beside a blocked mutation", async () => {
  let releaseBlocked;
  const blocked = new Promise((resolve) => { releaseBlocked = resolve; });
  const handlers = Object.fromEntries([
    "snapshot", "runtimeHealth", "taskHistory", "rateLimitHistory", "usageHistory", "search", "workspaceMessageSearch", "markTaskRead",
    "openTask", "openTurn", "workspaceMessageOpen", "sendMessage", "taskDiff", "deferredInput",
    "statusDetails", "speakLastAnswer", "restartServer", "setAutostart",
    "updateServerConfiguration", "readPreTurnInstructions", "updateGlobalPreTurnInstructions",
    "readRootAgents", "updateRootAgents", "compactContext", "openAttachment", "browseDirectory", "submitBugReport", "reportDiagnostic",
    "trustedDevices", "createDevicePairing", "revokeDevice",
    "messagePinSet", "messagePinsClear",
    "boardTaskCreate", "boardTaskIngest", "boardTaskUpdate", "boardTaskChecklist", "boardTaskChecklistLinkedAction", "boardTaskAttachmentAdd", "boardTaskStatus", "boardTaskMove", "boardTaskComplete", "boardTaskRemove",
    "boardTaskRetryTriage", "boardTaskStart", "boardColumnMove", "boardColumnComment",
    "boardWorkspaceMove", "usageSync", "usageSyncInvite", "usageSyncEnroll", "usageSyncDeviceLabel",
  ].map((name) => [name, async () => ({ accepted: true, name })]));
  handlers.restartServer = async () => blocked;
  const control = createDesktopApplicationRouter({
    handlers,
    commands: {
      dispatch: async () => ({ accepted: true }),
      settingTarget: () => ({}),
    },
  });

  const restart = control.handleDesktopControl({ action: "restart-server", params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const message = await control.handleDesktopControl({ action: "send-message", params: { text: "сейчас" } });
  assert.deepEqual(message, { accepted: true, name: "sendMessage" });
  releaseBlocked();
  await restart;
});

test("Desktop application router accepts a restart beside a blocked mutation", async () => {
  let releaseBlocked;
  const blocked = new Promise((resolve) => { releaseBlocked = resolve; });
  const handlers = Object.fromEntries([
    "snapshot", "runtimeHealth", "taskHistory", "rateLimitHistory", "usageHistory", "search", "workspaceMessageSearch", "markTaskRead",
    "openTask", "openTurn", "workspaceMessageOpen", "sendMessage", "taskDiff", "deferredInput",
    "statusDetails", "speakLastAnswer", "restartServer", "setAutostart",
    "updateServerConfiguration", "readPreTurnInstructions", "updateGlobalPreTurnInstructions",
    "readRootAgents", "updateRootAgents", "compactContext", "openAttachment", "browseDirectory", "submitBugReport", "reportDiagnostic",
    "trustedDevices", "createDevicePairing", "revokeDevice",
    "messagePinSet", "messagePinsClear",
    "boardTaskCreate", "boardTaskIngest", "boardTaskUpdate", "boardTaskChecklist", "boardTaskChecklistLinkedAction", "boardTaskAttachmentAdd", "boardTaskStatus", "boardTaskMove", "boardTaskComplete", "boardTaskRemove",
    "boardTaskRetryTriage", "boardTaskStart", "boardColumnMove", "boardColumnComment",
    "boardWorkspaceMove", "usageSync", "usageSyncInvite", "usageSyncEnroll", "usageSyncDeviceLabel",
  ].map((name) => [name, async () => ({ accepted: true, name })]));
  const control = createDesktopApplicationRouter({
    handlers,
    commands: {
      dispatch: async (type) => (type === "settings.update" ? blocked : { accepted: true }),
      settingTarget: () => ({}),
    },
  });

  const setting = control.handleDesktopControl({ action: "update-setting", params: { name: "model", value: "sol" } });
  await new Promise((resolve) => setImmediate(resolve));
  const restart = await control.handleDesktopControl({ action: "restart-server", params: {} });
  assert.deepEqual(restart, { accepted: true, name: "restartServer" });
  releaseBlocked();
  await setting;
});

test("trusted devices may delegate enrollment while server configuration stays local", async () => {
  const control = router([]);
  for (const source of ["telegram-mini-app", "shared-dashboard-bot", ""]) {
    await assert.rejects(
      () => control.handleDesktopControl({ action: "create-device-pairing", params: {}, context: { source, userId: "7" } }),
      /локальному Hub или доверенному устройству/u,
      `device enrollment must be refused for ${source || "an unnamed source"}`,
    );
  }
  for (const source of ["desktop-control", "local-mini-app", "trusted-device"]) {
    assert.ok(await control.handleDesktopControl({
      action: "create-device-pairing",
      params: {},
      context: { source, userId: "7" },
    }));
  }
  for (const source of ["trusted-device", "telegram-mini-app", "shared-dashboard-bot", ""]) {
    await assert.rejects(
      () => control.handleDesktopControl({ action: "update-server-configuration", params: {}, context: { source, userId: "7" } }),
      /только локальному Agent Hub/u,
    );
  }
  for (const source of ["desktop-control", "local-mini-app"]) {
    assert.ok(await control.handleDesktopControl({
      action: "update-server-configuration",
      params: {},
      context: { source, userId: "7" },
    }));
  }
});

test("remote sources keep listing and revoking trusted devices", async () => {
  const control = router([]);
  for (const action of ["trusted-devices", "revoke-device"]) {
    assert.ok(await control.handleDesktopControl({
      action,
      params: { deviceId: "018f6c86-3f34-7a31-8f27-16f5b96cce10" },
      context: { source: "trusted-device", userId: "7" },
    }));
  }
});
