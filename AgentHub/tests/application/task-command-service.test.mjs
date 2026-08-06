import assert from "node:assert/strict";
import test from "node:test";

import { TaskCommandService } from "../../src/application/task-command-service.mjs";

function fixture({ run = null } = {}) {
  const events = [];
  const target = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  const current = { ...target };
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
    createTask: async () => ({
      provider: "codex", threadId: "thread-new", projectRoot: "D:/work", title: "New",
    }),
    rotateCodexThread: async () => ({ thread: { id: "thread-rotated" } }),
    activeProvider: () => "codex",
    switchProvider: async () => {},
    workspaceCatalog: {
      workspace: (id) => id === "workspace-1" ? { id, name: "Existing" } : null,
      stream: (id) => id === "stream-1" ? { id, workspaceId: "workspace-1" } : null,
      createWorkspace: ({ name }) => ({ id: "workspace-new", name }),
      createStream: ({ workspaceId, name }) => ({ id: "stream-new", workspaceId, name }),
      bindThread: (value) => events.push(["bind", value]),
      thread: (value) => value?.provider === "codex" && value?.threadId === "thread-1"
        ? { provider: "codex", threadId: "thread-1", streamId: "stream-1", projectRoot: "D:/work" }
        : null,
    },
    selectionStore: {
      setThread: (...args) => events.push(["set-thread", ...args]),
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
  await service.create({ provider: "codex", workspaceName: "Architecture" });
  const binding = events.find(([name]) => name === "bind")[1];
  assert.equal(binding.streamId, "stream-new");
  assert.equal(binding.threadId, "thread-new");
  assert.deepEqual(events.find(([name]) => name === "set-thread").slice(1), [
    "thread-new",
    { provider: "codex", streamId: "stream-new", title: "Architecture" },
  ]);
});

test("task command service continues an existing Stream in a new provider Thread", async () => {
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
});

test("task command service rotates inside the same Stream after context transfer", async () => {
  const { service, events } = fixture();
  const result = await service.rotate({ streamId: "stream-1" });
  assert.deepEqual(events.find(([name]) => name === "bind")[1], {
    provider: "codex",
    threadId: "thread-rotated",
    streamId: "stream-1",
    projectRoot: "D:/work",
    source: "rebirth",
  });
  assert.deepEqual(events.find(([name]) => name === "set-thread").slice(1), [
    "thread-rotated",
    { provider: "codex", streamId: "stream-1", title: "Existing" },
  ]);
  assert.equal(result.rotation.sourceThreadId, "thread-1");
  assert.equal(result.rotation.threadId, "thread-rotated");
});
