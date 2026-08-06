import assert from "node:assert/strict";
import test from "node:test";

import { TaskCommandService } from "../../src/application/task-command-service.mjs";

function fixture({ run = null } = {}) {
  const events = [];
  const target = { hubTaskId: "hub-1", provider: "codex", threadId: "thread-1" };
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
    catalogEntryIsSelected: (left, right) => left.hubTaskId === right.hubTaskId,
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
    createTask: async () => events.push(["create"]),
    activeProvider: () => "codex",
    switchProvider: async () => {},
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
