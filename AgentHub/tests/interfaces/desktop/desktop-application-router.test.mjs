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
  ].map((name) => [name, handler]));
  return createDesktopApplicationRouter({
    handlers,
    commands: {
      dispatch: async (...args) => { calls.push(args); return { accepted: true }; },
      settingTarget: () => ({ hubTaskId: "hub-1" }),
    },
  });
}

test("Desktop application router addresses mutations explicitly", async () => {
  const calls = [];
  const control = router(calls);
  await control.handleDesktopControl({
    action: "select-task",
    params: { hubTaskId: "hub-1", provider: "codex", threadId: "thread-1" },
    context: { source: "desktop", userId: "7" },
  });
  assert.equal(calls[0][0], "task.select");
  assert.equal(calls[0][2].clientId, "desktop:7");
  assert.equal(calls[0][3].target.hubTaskId, "hub-1");
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
