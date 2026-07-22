import assert from "node:assert/strict";
import test from "node:test";
import { restorePreviousBotAfterFailedReplacement } from "./restart-recovery.mjs";

test("failed replacement restores the previous bot before marking it ready", async () => {
  const events = [];
  await restorePreviousBotAfterFailedReplacement({
    replacementError: new Error("launcher failed"),
    acquireLock: async () => events.push("lock"),
    startCommandServer: async () => events.push("command"),
    setStopping: (value) => events.push(`stopping:${value}`),
    restoreProvider: async () => events.push("provider"),
    recoverRuns: async () => events.push("runs"),
    updateMessage: async (message) => events.push(message.includes("launcher failed") ? "message" : "bad-message"),
    clearRestartRequest: () => events.push("clear"),
    saveState: async () => events.push("state"),
    startTimers: () => events.push("timers"),
    markReady: async () => events.push("ready"),
  });
  assert.deepEqual(events, [
    "lock", "command", "stopping:false", "provider", "runs", "message", "clear", "state", "timers", "ready",
  ]);
});

test("failed restoration never starts timers or marks a broken bot ready", async () => {
  const events = [];
  await assert.rejects(restorePreviousBotAfterFailedReplacement({
    replacementError: new Error("launcher failed"),
    acquireLock: async () => events.push("lock"),
    startCommandServer: async () => { throw new Error("pipe busy"); },
    setStopping: () => events.push("stopping"),
    restoreProvider: async () => events.push("provider"),
    recoverRuns: async () => events.push("runs"),
    updateMessage: async () => events.push("message"),
    clearRestartRequest: () => events.push("clear"),
    saveState: async () => events.push("state"),
    startTimers: () => events.push("timers"),
    markReady: async () => events.push("ready"),
  }), /pipe busy/);
  assert.deepEqual(events, ["lock"]);
});
