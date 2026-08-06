import assert from "node:assert/strict";
import test from "node:test";

import { TaskNavigationService } from "../../src/application/task-navigation-service.mjs";

function fixture(overrides = {}) {
  const state = {
    provider: "codex",
    projectRoot: "D:/one",
    threadId: "one",
    title: "One",
    latestDiff: "old diff",
    events: [],
  };
  const selectionStore = {
    snapshot: () => ({ ...state }),
    restore: (value) => Object.assign(state, value),
    switchProject: (projectRoot) => { state.projectRoot = projectRoot; state.threadId = null; },
    switchProvider: (provider) => { state.provider = provider; state.threadId = null; },
    selectTask: (value) => {
      state.provider = value.activeProvider;
      state.projectRoot = value.activeProjectRoot;
      state.threadId = value.threadId;
      state.title = value.activeThreadTitle;
    },
    setTitle: (title) => { state.title = title; },
  };
  const value = new TaskNavigationService({
    projects: [{ name: "One", path: "D:/one" }, { name: "Two", path: "D:/two" }],
    samePath: (left, right) => left === right,
    findProject: (root) => [{ path: "D:/one" }, { path: "D:/two" }].find((item) => item.path === root),
    selectionStore,
    activeProjectRoot: () => state.projectRoot,
    activeProvider: () => state.provider,
    threadId: () => state.threadId,
    activeTaskTitle: () => state.title,
    isCodex: () => state.provider === "codex",
    rememberCodexSettings: () => state.events.push("remember"),
    captureCodexPreferences: () => ({ model: "old" }),
    restoreCodexPreferences: () => state.events.push("restore-preferences"),
    restoreCodexThreadSettings: () => state.events.push("restore-thread"),
    storedCodexThreadTitle: async () => "Stored title",
    selectedTask: () => ({ provider: state.provider, threadId: state.threadId }),
    taskRunKey: (task) => `${task.provider}:${task.threadId}`,
    storedTaskDiff: () => "new diff",
    latestDiff: () => state.latestDiff,
    setLatestDiff: (value) => { state.latestDiff = value; },
    createThread: async () => { state.threadId = "created"; },
    codexTransportRunning: () => false,
    startCodex: async () => state.events.push("start"),
    initializeCodex: async () => state.events.push("initialize"),
    attachCodexThread: async () => state.events.push("attach"),
    saveState: async () => state.events.push("save"),
    ...overrides,
  });
  return { value, state, selectionStore };
}

test("project switch restores selection and diff when task creation fails", async () => {
  const setup = fixture({ createThread: async () => { throw new Error("failed"); } });
  await assert.rejects(setup.value.switchProject(1), /failed/u);
  assert.equal(setup.state.projectRoot, "D:/one");
  assert.equal(setup.state.latestDiff, "old diff");
  assert.ok(setup.state.events.includes("save"));
});

test("provider switch starts Codex only when provider work requires it", async () => {
  const setup = fixture();
  setup.state.provider = "claude";
  await setup.value.switchProvider("codex");
  assert.deepEqual(setup.state.events.filter((value) => ["start", "initialize", "attach"].includes(value)), [
    "start",
    "initialize",
  ]);
  assert.equal(setup.state.latestDiff, "new diff");
});

test("task activation changes local selection without starting a provider", async () => {
  const setup = fixture();
  const result = await setup.value.activate({
    hubTaskId: "hub-1",
    provider: "codex",
    projectRoot: "D:/two",
    threadId: "thread-2",
    taskTitle: "Second",
  });
  assert.deepEqual(result, { changed: true, activeTitle: "Second" });
  assert.equal(setup.state.projectRoot, "D:/two");
  assert.equal(setup.state.threadId, "thread-2");
  assert.equal(setup.state.events.includes("start"), false);
});
