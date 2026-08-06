import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskViewCallbackData,
  taskViewCallbackData,
} from "../../../src/interfaces/telegram/task-view-callback.mjs";

const THREAD_ID = "019f70ed-d8e8-7b21-bcd1-b6f57bcdf013";

test("task view callback carries a task identity within Telegram's 64-byte limit", () => {
  const value = taskViewCallbackData({
    action: "show",
    provider: "codex",
    threadId: THREAD_ID,
  });
  assert.ok(Buffer.byteLength(value, "utf8") <= 64);
  assert.deepEqual(parseTaskViewCallbackData(value), {
    action: "show",
    provider: "codex",
    threadId: THREAD_ID,
    count: null,
  });
});

test("task history callback preserves mode and bounded count", () => {
  const value = taskViewCallbackData({
    action: "history-last",
    provider: "claude",
    threadId: THREAD_ID.toUpperCase(),
    count: 500,
  });
  assert.deepEqual(parseTaskViewCallbackData(value), {
    action: "history-last",
    provider: "claude",
    threadId: THREAD_ID,
    count: 50,
  });
});

test("task diff callback carries the exact task identity", () => {
  const value = taskViewCallbackData({
    action: "diff",
    provider: "codex",
    threadId: THREAD_ID,
  });
  assert.ok(Buffer.byteLength(value, "utf8") <= 64);
  assert.deepEqual(parseTaskViewCallbackData(value), {
    action: "diff",
    provider: "codex",
    threadId: THREAD_ID,
    count: null,
  });
});

test("task view callback rejects unsupported or non-UUID identities", () => {
  assert.equal(taskViewCallbackData({ action: "show", provider: "codex", threadId: "old-session" }), null);
  assert.equal(parseTaskViewCallbackData("task-view:s:x:019f70ed-d8e8-7b21-bcd1-b6f57bcdf013"), null);
  assert.equal(parseTaskViewCallbackData("task-view:s:c:019f70ed-d8e8-7b21-bcd1-b6f57bcdf013:2"), null);
  assert.equal(parseTaskViewCallbackData("task-view:d:c:019f70ed-d8e8-7b21-bcd1-b6f57bcdf013:2"), null);
});
