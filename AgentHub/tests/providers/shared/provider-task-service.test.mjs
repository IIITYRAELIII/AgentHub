import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeProviderTaskService, CodexProviderTaskService } from "../../../src/providers/provider-task-service.mjs";

test("Codex task service creates, names and discovers tasks through its port", async () => {
  const calls = [];
  const state = { running: false, streamId: "stream-1", threadId: null, title: "", diff: "old" };
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
      get streamId() { return state.streamId; },
      setThread: (id, options) => {
        state.threadId = id;
        state.streamId = options.streamId;
      },
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
  const created = await service.createTask();
  assert.equal(state.threadId, "thread-1");
  assert.equal(state.streamId, "stream-1");
  assert.match(state.title, /^Telegram · /u);
  assert.equal(state.diff, "");
  assert.equal(created.threadId, "thread-1");
  assert.deepEqual((await service.discoverTasks()).map((item) => item.id), ["one", "two"]);
  assert.ok(calls.includes("start"));
  assert.ok(calls.indexOf("save") < calls.findIndex((call) => Array.isArray(call) && call[0] === "thread/name/set"));
});

test("Codex task service persists the created Thread before post-create setup", async () => {
  const state = { streamId: "stream-1", threadId: null, savedThreadId: null };
  const service = new CodexProviderTaskService({
    transportRunning: () => true,
    startTransport: async () => {},
    initialize: async () => {},
    sendRpc: async (method) => {
      if (method === "thread/start") return { thread: { id: "thread-created" } };
      throw new Error("post-create failure");
    },
    selection: {
      get streamId() { return state.streamId; },
      setThread: (threadId, options) => {
        state.threadId = threadId;
        state.streamId = options.streamId;
      },
      setTitle() {},
    },
    activeProjectRoot: () => "D:/workspace",
    sandboxMode: () => "workspace-write",
    invalidateCatalog() {},
    restoreSettings() {},
    updateSettings: async () => {},
    clearLatestDiff() {},
    saveState: async () => { state.savedThreadId = state.threadId; },
  });
  await assert.rejects(service.createTask(), /post-create failure/);
  assert.equal(state.savedThreadId, "thread-created");
  assert.equal(state.streamId, "stream-1");
});

test("Claude task service creates an unbound logical task", async () => {
  const state = { args: null, diff: "old", saved: false };
  const service = new ClaudeProviderTaskService({
    selection: { setThread: (...args) => { state.args = args; } },
    activeProjectRoot: () => "D:/workspace",
    clearLatestDiff: () => { state.diff = ""; },
    saveState: async () => { state.saved = true; },
  });
  const created = await service.createTask();
  assert.deepEqual(state.args, [null, { provider: "claude", title: "Новая задача Claude" }]);
  assert.equal(state.diff, "");
  assert.equal(state.saved, true);
  assert.equal(created.threadId, null);
  assert.equal(created.projectRoot, "D:/workspace");
});
