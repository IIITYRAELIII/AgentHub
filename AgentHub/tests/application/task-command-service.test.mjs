import assert from "node:assert/strict";
import test from "node:test";

import { TaskCommandService } from "../../src/application/task-command-service.mjs";

function fixture({ run = null, createTask = null } = {}) {
  const events = [];
  const target = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  const current = { ...target };
  const selected = {
    activeProvider: "codex",
    activeProjectRoot: "D:/work",
    streamId: "stream-1",
    threadId: "thread-1",
    activeThreadTitle: "Existing",
  };
  const service = new TaskCommandService({
    resolveTarget: async () => target,
    pinTitle: (_provider, _thread, title) => title.trim(),
    renameCodexTask: async (...args) => events.push(["rename", ...args]),
    expectTitleConfirmation: () => {},
    invalidateCatalog: () => events.push(["invalidate"]),
    runForTask: () => run,
    updateRunTitle: () => events.push(["run-title"]),
    catalogEntries: () => [{ ...target, title: "Old" }],
    catalogEntryIsSelected: (left, right) => left.streamId === right.streamId,
    selection: {
      current: () => current,
      setTitle: (title) => events.push(["selection-title", title]),
      clearCodex: () => events.push(["clear"]),
      selectCodex: (...args) => events.push(["select", ...args]),
    },
    saveTitles: async () => {},
    saveState: async () => {},
    snapshot: async () => ({ snapshot: true }),
    readCodexTask: async () => ({ id: "thread-1" }),
    archiveCodexTask: async () => events.push(["archive"]),
    deleteCodexSettings: () => {},
    listCodexTasks: async () => [],
    codexTaskTitle: (thread) => thread.name,
    restoreCodexSettings: () => {},
    diffs: {
      setLatest: () => {},
      forTask: () => "diff",
      refresh: async () => "fresh",
    },
    providerCancel: async () => ({ accepted: true }),
    progress: { setStage() {}, async finish() {} },
    dismissedExternalTasks: { add() {} },
    completeRun: async () => {},
    createTask: createTask
      ? () => createTask(selected)
      : async () => ({
          provider: "codex", threadId: "thread-new", projectRoot: "D:/work", title: "New",
        }),
    rotateStream: async (...args) => {
      events.push(["rotate", ...args]);
      return { thread: { id: "thread-rotated" } };
    },
    activeProvider: () => "codex",
    switchProvider: async () => {},
    prepareTaskCreation: async (value) => {
      selected.activeProvider = value.provider;
      selected.activeProjectRoot = value.workingDirectory ?? value.project ?? selected.activeProjectRoot;
      selected.streamId = value.streamId;
      selected.threadId = null;
      selected.activeThreadTitle = value.title;
      events.push(["prepare", value]);
    },
    workspaceCatalog: {
      workspace: (id) => id === "workspace-1" ? {
        id, name: "Existing", settings: { workingDirectory: "D:/work/AgentHub" },
      } : null,
      stream: (id) => id === "stream-1" ? {
        id,
        workspaceId: "workspace-1",
        settings: {
          provider: "codex",
          model: "gpt-5",
          reasoning: "high",
          project: "D:/later",
          autoApprove: false,
        },
      } : null,
      createWorkspace: ({ name }) => ({ id: "workspace-new", name }),
      createStream: ({ workspaceId, name }) => ({ id: "stream-new", workspaceId, name }),
      renameWorkspace: (id, name) => ({ id, name }),
      bindThread: (value) => events.push(["bind", value]),
      activeThread: (id) => id === "stream-1"
        ? { provider: "codex", threadId: "thread-1", streamId: "stream-1", projectRoot: "D:/work" }
        : null,
      thread: (value) => value?.provider === "codex" && value?.threadId === "thread-1"
        ? { provider: "codex", threadId: "thread-1", streamId: "stream-1", projectRoot: "D:/work" }
        : null,
    },
    streamHandoff: {
      request: (value) => {
        events.push(["handoff", value]);
        return value;
      },
    },
    selectionStore: {
      get activeProvider() { return selected.activeProvider; },
      get activeProjectRoot() { return selected.activeProjectRoot; },
      get streamId() { return selected.streamId; },
      get threadId() { return selected.threadId; },
      get activeThreadTitle() { return selected.activeThreadTitle; },
      setThread: (threadId, options) => {
        selected.activeProvider = options.provider;
        selected.streamId = options.streamId;
        selected.threadId = threadId;
        selected.activeThreadTitle = options.title;
        events.push(["set-thread", threadId, options]);
      },
    },
  });
  return { service, events };
}

test("task command service renames one exact logical task", async () => {
  const { service, events } = fixture();
  const result = await service.rename({ title: "New" });
  assert.equal(result.renamedTitle, "New");
  assert.equal(events.some(([name]) => name === "rename"), true);
  assert.equal(events.some(([name]) => name === "selection-title"), true);
});

test("task command service archives only an idle Codex task", async () => {
  const { service, events } = fixture();
  const result = await service.archive({});
  assert.equal(result.archivedThread.id, "thread-1");
  assert.equal(events.some(([name]) => name === "archive"), true);
  assert.equal(events.some(([name]) => name === "clear"), true);
});

test("task command service does not launch a parallel cancel path without a run", async () => {
  const { service } = fixture();
  assert.equal((await service.cancel({})).accepted, false);
});

test("task command service creates a Workspace and binds the provider Thread to its first Stream", async () => {
  const { service, events } = fixture();
  const result = await service.create(
    { provider: "codex", workspaceName: "Architecture" },
    { clientId: "telegram:7" },
  );
  const binding = events.find(([name]) => name === "bind")[1];
  assert.equal(binding.streamId, "stream-new");
  assert.equal(binding.threadId, "thread-new");
  assert.deepEqual(events.find(([name]) => name === "set-thread").slice(1), [
    "thread-new",
    { provider: "codex", streamId: "stream-new", title: "Architecture" },
  ]);
  assert.equal(result.createdTask.threadId, "thread-new");
  assert.equal(result.createdTask.streamId, "stream-new");
  assert.equal(result.clientId, "telegram:7");
  assert.equal(events.find(([name]) => name === "prepare")[1].streamId, "stream-new");
});

test("task command service binds a reserved Claude Thread before its first transcript exists", async () => {
  const { service, events } = fixture({
    createTask: async () => ({
      provider: "claude",
      threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      projectRoot: "D:/work",
      title: "Новая задача Claude",
    }),
  });

  const result = await service.create({ provider: "claude", workspaceName: "Claude Workspace" });

  assert.deepEqual(events.find(([name]) => name === "bind")[1], {
    provider: "claude",
    threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    streamId: "stream-new",
    projectRoot: "D:/work",
    source: "created",
  });
  assert.equal(result.createdTask.threadId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
});

test("task command service recovers a persisted provider Thread after post-create failure", async () => {
  const { service, events } = fixture({
    createTask: async (selected) => {
      selected.threadId = "thread-recovered";
      selected.activeThreadTitle = "Recovered";
      throw new Error("naming failed");
    },
  });
  const result = await service.create({ provider: "codex", workspaceName: "Architecture" });
  assert.equal(result.createdTask.threadId, "thread-recovered");
  assert.equal(events.find(([name]) => name === "bind")[1].threadId, "thread-recovered");
});

test("task command service continues an existing Stream in a new Codex Thread", async () => {
  const { service, events } = fixture();
  await service.create({ provider: "codex", streamId: "stream-1" });
  assert.deepEqual(events.find(([name]) => name === "bind")[1], {
    provider: "codex",
    threadId: "thread-new",
    streamId: "stream-1",
    projectRoot: "D:/work",
    source: "rebirth",
  });
  assert.deepEqual(events.find(([name]) => name === "set-thread").slice(1), [
    "thread-new",
    { provider: "codex", streamId: "stream-1", title: "Existing" },
  ]);
  assert.deepEqual(events.find(([name]) => name === "prepare")[1], {
    provider: "codex",
    model: "gpt-5",
    reasoning: "high",
    project: "D:/later",
    workingDirectory: "D:/work/AgentHub",
    autoApprove: false,
    streamId: "stream-1",
    title: "Existing",
  });
});

test("task command service can manually continue an existing Stream in Claude", async () => {
  const { service, events } = fixture({
    createTask: async () => ({
      provider: "claude",
      threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      projectRoot: "D:/work",
      title: "Новая задача Claude",
    }),
  });
  const result = await service.create({ provider: "claude", streamId: "stream-1" });

  assert.equal(result.createdTask.streamId, "stream-1");
  assert.deepEqual(events.find(([name]) => name === "bind")[1], {
    provider: "claude",
    threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    streamId: "stream-1",
    projectRoot: "D:/work",
    source: "rebirth",
  });
  assert.deepEqual(events.find(([name]) => name === "prepare")[1], {
    provider: "claude",
    model: "gpt-5",
    reasoning: "high",
    project: "D:/later",
    workingDirectory: "D:/work/AgentHub",
    autoApprove: false,
    streamId: "stream-1",
    title: "Existing",
  });
});

test("task command service requests a handoff package for a cross-provider continuation", async () => {
  const { service, events } = fixture({
    createTask: async () => ({
      provider: "claude",
      threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      projectRoot: "D:/work",
      title: "Новая задача Claude",
    }),
  });

  await service.create({ provider: "claude", streamId: "stream-1" });

  assert.deepEqual(events.find(([name]) => name === "handoff")[1], {
    streamId: "stream-1",
    targetProvider: "claude",
    sourceProvider: "codex",
    sourceThreadId: "thread-1",
    reason: undefined,
  });
});

test("task command service does not request a handoff for a brand new Workspace", async () => {
  const { service, events } = fixture();
  await service.create({ provider: "codex", workspaceName: "Architecture" });
  assert.equal(events.some(([name]) => name === "handoff"), false);
});

test("task command service rotates inside the same Stream after context transfer", async () => {
  const { service, events } = fixture();
  const result = await service.rotate({ streamId: "stream-1" });
  const target = events.find(([name]) => name === "rotate")[1];
  assert.equal(target.streamId, "stream-1");
  assert.equal(target.workingDirectory, "D:/work/AgentHub");
  assert.equal(result.rotation.sourceThreadId, "thread-1");
  assert.equal(result.rotation.threadId, "thread-rotated");
});
