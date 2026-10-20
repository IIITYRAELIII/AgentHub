import assert from "node:assert/strict";
import test from "node:test";

import { TaskCommandService } from "../../src/application/task-command-service.mjs";

function fixture({ run = null, createTask = null, provider: fixtureProvider = "codex" } = {}) {
  const events = [];
  const target = { streamId: "stream-1", provider: fixtureProvider, threadId: "thread-1" };
  const current = { ...target };
  const selected = {
    activeProvider: fixtureProvider,
    activeProjectRoot: "D:/work",
    streamId: "stream-1",
    threadId: "thread-1",
    activeThreadTitle: "Existing",
  };
  const service = new TaskCommandService({
    resolveTarget: async () => target,
    pinTitle: (_provider, _thread, title) => title.trim(),
    renameCodexTask: async (...args) => events.push(["rename", ...args]),
    expectTitleConfirmation: (...args) => events.push(["expect-title", ...args]),
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
          provider: fixtureProvider, threadId: "thread-new", projectRoot: "D:/work", title: "New",
        }),
    rotateStream: async (...args) => {
      events.push(["rotate", ...args]);
      return { thread: { id: "thread-rotated" } };
    },
    activeProvider: () => fixtureProvider,
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
          provider: fixtureProvider,
          model: "gpt-5",
          reasoning: "high",
          project: "D:/later",
          autoApprove: false,
        },
      } : null,
      createWorkspace: ({ name }) => ({ id: "workspace-new", name }),
      createStream: ({ workspaceId, name, settings }) => {
        events.push(["create-stream", { workspaceId, name, settings }]);
        return { id: "stream-new", workspaceId, name, settings };
      },
      renameWorkspace: (id, name) => ({ id, name }),
      bindThread: (value) => events.push(["bind", value]),
      activeThread: (id) => id === "stream-1"
        ? { provider: fixtureProvider, threadId: "thread-1", streamId: "stream-1", projectRoot: "D:/work" }
        : null,
      thread: (value) => value?.provider === fixtureProvider && value?.threadId === "thread-1"
        ? { provider: fixtureProvider, threadId: "thread-1", streamId: "stream-1", projectRoot: "D:/work" }
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

test("stop without a user run delegates exact maintenance cancellation without killing the provider", async () => {
  const { service } = fixture();
  let target;
  service.cancelContextMaintenance = (value) => {
    target = value;
    return { accepted: true, message: "Preparation cancelled" };
  };
  service.providerCancel = () => { throw new Error("Provider must not be killed"); };
  assert.deepEqual(await service.cancel({}), { accepted: true, message: "Preparation cancelled" });
  assert.equal(target.threadId, "thread-1");
  service.cancelContextMaintenance = () => null;
  assert.equal((await service.cancel({})).accepted, false);
});

test("task command service protects the title before awaiting the provider rename", async () => {
  const { service, events } = fixture();
  let releaseRename;
  const renameBlocked = new Promise((resolve) => { releaseRename = resolve; });
  service.renameCodexTask = async () => {
    events.push(["rename-start"]);
    await renameBlocked;
  };

  const operation = service.rename({ title: "New" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 2), [
    ["expect-title", "codex", "thread-1", "New"],
    ["rename-start"],
  ]);

  releaseRename();
  await operation;
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
    { provider: "codex", streamId: "stream-new", title: "New" },
  ]);
  assert.equal(result.createdTask.threadId, "thread-new");
  assert.equal(result.createdTask.streamId, "stream-new");
  assert.equal(result.clientId, "telegram:7");
  assert.equal(events.find(([name]) => name === "prepare")[1].streamId, "stream-new");
});

test("task command service creates a sibling Stream in the source Workspace", async () => {
  const { service, events } = fixture();
  const result = await service.create({ provider: "codex", sourceStreamId: "  stream-1  " });

  assert.equal(result.createdTask.streamId, "stream-new");
  assert.deepEqual(events.find(([name]) => name === "create-stream")[1].settings, {
    provider: "codex",
    model: "gpt-5",
    reasoning: "high",
    project: "D:/later",
    autoApprove: false,
  });
  assert.deepEqual(events.find(([name]) => name === "bind")[1], {
    provider: "codex",
    threadId: "thread-new",
    streamId: "stream-new",
    projectRoot: "D:/work",
    source: "created",
  });
  assert.deepEqual(events.find(([name]) => name === "prepare")[1], {
    provider: "codex",
    model: "gpt-5",
    reasoning: "high",
    project: "D:/later",
    workingDirectory: "D:/work/AgentHub",
    autoApprove: false,
    streamId: "stream-new",
    title: "Existing",
  });
  assert.equal(events.some(([name]) => name === "handoff"), false);
});

test("new default Workspace keeps its name instead of adopting the generated provider title", async () => {
  const { service, events } = fixture({
    createTask: async () => ({ provider: "codex", threadId: "thread-new", title: "New Workspace - Поток 1 1" }),
  });
  service.workspaceCatalog.renameWorkspace = () => { throw new Error("Thread title must not rename its Workspace"); };
  const result = await service.create({ provider: "codex" });
  assert.equal(result.createdTask.taskTitle, "New Workspace - Поток 1 1");
  assert.equal(events.find(([name]) => name === "set-thread")[2].title, "New Workspace - Поток 1 1");
});

test("task command service rejects a source Stream without its Workspace", async () => {
  const { service, events } = fixture();
  service.workspaceCatalog.workspace = () => null;
  service.workspaceCatalog.createWorkspace = (...args) => {
    events.push(["create-workspace", ...args]);
    return { id: "workspace-new" };
  };

  await assert.rejects(
    service.create({ provider: "codex", sourceStreamId: "stream-1" }),
    { message: "Workspace исходного Stream не найден" },
  );
  assert.equal(events.some(([name]) => name === "create-workspace"), false);
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

test("task command service preserves the exact created Thread but does not mask post-create failure", async () => {
  const { service, events } = fixture({
    createTask: async (selected) => {
      selected.threadId = "thread-recovered";
      selected.activeThreadTitle = "Recovered";
      throw new Error("naming failed");
    },
  });
  await assert.rejects(service.create({ provider: "codex", workspaceName: "Architecture" }), /naming failed/);
  assert.equal(service.selectionStore.threadId, "thread-recovered");
  assert.equal(events.some(([name]) => name === "bind"), false);
  assert.equal(events.some(([name]) => name === "set-thread"), false);
});

test("task command service continues an existing Stream in a new Codex Thread", async () => {
  const { service, events } = fixture();
  await service.create({
    provider: "codex",
    streamId: "stream-1",
    taskId: "board-1",
    taskNumber: "AH-42",
  });
  assert.deepEqual(events.find(([name]) => name === "bind")[1], {
    provider: "codex",
    threadId: "thread-new",
    streamId: "stream-1",
    projectRoot: "D:/work",
    source: "rebirth",
  });
  assert.deepEqual(events.find(([name]) => name === "set-thread").slice(1), [
    "thread-new",
    { provider: "codex", streamId: "stream-1", title: "New" },
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
    taskId: "board-1",
    taskNumber: "AH-42",
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

test("task command service rotates a Claude Stream by creating a Thread", async () => {
  const { service, events } = fixture({ provider: "claude" });
  const result = await service.rotate({ streamId: "stream-1" });

  assert.equal(events.some(([name]) => name === "rotate"), false);
  assert.equal(result.rotation.sourceThreadId, "thread-1");
  assert.equal(result.rotation.threadId, "thread-new");
  assert.equal(result.rotation.streamId, "stream-1");

  const bound = events.find(([name]) => name === "bind")[1];
  assert.equal(bound.provider, "claude");
  assert.equal(bound.threadId, "thread-new");
  assert.equal(bound.streamId, "stream-1");
  assert.equal(bound.source, "rebirth");

  const handoff = events.find(([name]) => name === "handoff")[1];
  assert.equal(handoff.streamId, "stream-1");
  assert.equal(handoff.targetProvider, "claude");
  assert.equal(handoff.sourceThreadId, "thread-1");
  assert.equal(handoff.reason, "manual-rotation");
});

test("task command service refuses rotation while a run is active", async () => {
  const { service } = fixture({ provider: "claude", run: { id: "run-1" } });
  await assert.rejects(
    () => service.rotate({ streamId: "stream-1" }),
    /Сначала завершите или остановите текущий ход/u,
  );
});
