import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeProviderTaskService, CodexProviderTaskService } from "./src/providers/provider-task-service.mjs";

test("Codex task service creates, names and discovers tasks through its port", async () => {
  const calls = [];
  const state = { running: false, threadId: null, title: "", diff: "old" };
  const pages = [
    { data: [{ id: "one" }], nextCursor: "next" },
    { data: [{ id: "two" }], nextCursor: null },
  ];
  const service = new CodexProviderTaskService({
    transportRunning: () => state.running,
    startTransport: async () => { state.running = true; calls.push("start"); },
    initialize: async (options) => calls.push(["initialize", options]),
    sendRpc: async (method, params) => {
      calls.push([method, params]);
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "thread/list") return pages.shift();
      return {};
    },
    selection: {
      setThread: (id) => { state.threadId = id; },
      setTitle: (title) => { state.title = title; },
    },
    activeProjectRoot: () => "D:/workspace",
    sandboxMode: () => "workspace-write",
    invalidateCatalog: () => calls.push("invalidate"),
    restoreSettings: (...args) => calls.push(["restore", ...args]),
    updateSettings: async () => calls.push("settings"),
    clearLatestDiff: () => { state.diff = ""; },
    saveState: async () => calls.push("save"),
    clock: () => new Date("2026-08-04T15:00:00Z"),
  });
  await service.createTask();
  assert.equal(state.threadId, "thread-1");
  assert.match(state.title, /^Telegram · /u);
  assert.equal(state.diff, "");
  assert.deepEqual((await service.discoverTasks()).map((item) => item.id), ["one", "two"]);
  assert.ok(calls.includes("start"));
});

test("Claude task service creates an unbound logical task", async () => {
  const state = { args: null, diff: "old", saved: false };
  const service = new ClaudeProviderTaskService({
    selection: { setThread: (...args) => { state.args = args; } },
    clearLatestDiff: () => { state.diff = ""; },
    saveState: async () => { state.saved = true; },
  });
  await service.createTask();
  assert.deepEqual(state.args, [null, { provider: "claude", title: "Новая задача Claude" }]);
  assert.equal(state.diff, "");
  assert.equal(state.saved, true);
});
