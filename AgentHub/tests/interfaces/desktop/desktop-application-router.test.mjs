import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopApplicationRouter } from "../../../src/interfaces/desktop/desktop-application-router.mjs";

function router(calls) {
  const handler = async (params) => ({ params });
  const handlers = Object.fromEntries([
    "snapshot", "taskHistory", "rateLimitHistory", "usageHistory", "search", "workspaceMessageSearch",
    "openTask", "openTurn", "workspaceMessageOpen", "sendMessage", "taskDiff", "deferredInput",
    "statusDetails", "speakLastAnswer", "restartServer", "setAutostart",
    "updateServerConfiguration", "readPreTurnInstructions", "updateGlobalPreTurnInstructions",
    "readRootAgents", "updateRootAgents", "compactContext", "openAttachment", "submitBugReport",
    "trustedDevices", "createDevicePairing", "revokeDevice",
    "renameWorkspace", "createWorkspaceFromStream", "mergeWorkspaces", "renameStream", "moveStream",
    "boardTaskCreate", "boardTaskIngest", "boardTaskUpdate", "boardTaskMove", "boardTaskComplete", "boardTaskRemove",
    "boardTaskRetryTriage", "boardTaskStart", "boardColumnMove", "boardColumnComment",
    "boardWorkspaceMove",
  ].map((name) => [name, handler]));
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

test("Desktop application router exposes pre-turn instructions read and Global update", async () => {
  const control = router([]);
  assert.equal((await control.handleDesktopControl({
    action: "read-pre-turn-instructions", params: {},
  })).params.constructor, Object);
  assert.equal((await control.handleDesktopControl({
    action: "update-global-pre-turn-instructions", params: { content: "Rules" },
  })).params.content, "Rules");
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

test("Desktop application router accepts a message beside a blocked mutation", async () => {
  let releaseBlocked;
  const blocked = new Promise((resolve) => { releaseBlocked = resolve; });
  const handlers = Object.fromEntries([
    "snapshot", "taskHistory", "rateLimitHistory", "usageHistory", "search", "workspaceMessageSearch",
    "openTask", "openTurn", "workspaceMessageOpen", "sendMessage", "taskDiff", "deferredInput",
    "statusDetails", "speakLastAnswer", "restartServer", "setAutostart",
    "updateServerConfiguration", "readPreTurnInstructions", "updateGlobalPreTurnInstructions",
    "readRootAgents", "updateRootAgents", "compactContext", "openAttachment", "submitBugReport",
    "trustedDevices", "createDevicePairing", "revokeDevice",
    "boardTaskCreate", "boardTaskIngest", "boardTaskUpdate", "boardTaskMove", "boardTaskComplete", "boardTaskRemove",
    "boardTaskRetryTriage", "boardTaskStart", "boardColumnMove", "boardColumnComment", "boardWorkspaceMove",
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
