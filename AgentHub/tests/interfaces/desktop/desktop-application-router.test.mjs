import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopApplicationRouter } from "../../../src/interfaces/desktop/desktop-application-router.mjs";

function router(calls) {
  const handler = async (params) => ({ params });
  const handlers = Object.fromEntries([
    "snapshot", "taskHistory", "rateLimitHistory", "usageHistory", "search",
    "openTask", "openTurn", "sendMessage", "taskDiff", "deferredInput",
    "statusDetails", "speakLastAnswer", "restartServer", "setAutostart",
    "updateServerConfiguration", "compactContext", "openAttachment", "submitBugReport",
    "trustedDevices", "createDevicePairing", "revokeDevice",
    "renameWorkspace", "createWorkspaceFromStream", "mergeWorkspaces", "renameStream", "moveStream",
    "boardTaskCreate", "boardTaskMove", "boardTaskComplete", "boardTaskRemove",
    "boardTaskRetryTriage", "boardTaskStart", "boardColumnMove", "boardColumnComment",
    "boardWorkspaceMove",
  ].map((name) => [name, handler]));
  return createDesktopApplicationRouter({
    handlers,
    commands: {
      dispatch: async (...args) => { calls.push(args); return { accepted: true }; },
      settingTarget: () => ({ streamId: "stream-1" }),
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

test("Desktop application router keeps the legacy Workspace move alias", async () => {
  const control = router([]);
  const result = await control.handleDesktopControl({
    action: "board-workspace-move",
    params: { workspaceId: "workspace-2", beforeWorkspaceId: "workspace-1" },
  });
  assert.equal(result.params.workspaceId, "workspace-2");
  assert.equal(result.params.beforeWorkspaceId, "workspace-1");
});
