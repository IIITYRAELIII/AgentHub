import assert from "node:assert/strict";
import test from "node:test";

import { TaskIdentityResolver } from "../../src/application/task-identity-resolver.mjs";
import { TaskMetadataStore } from "../../src/application/task-metadata-store.mjs";
import { TaskSelectionStore } from "../../src/application/task-selection-store.mjs";

function fixture() {
  const selectionStore = new TaskSelectionStore({
    activeProvider: "codex",
    activeProjectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "thread-1",
    activeThreadTitle: "Task one",
  });
  const run = { provider: "codex", projectRoot: "D:/Work", threadId: "thread-1" };
  const resolver = new TaskIdentityResolver({
    selectionStore,
    projects: [{ name: "Work", path: "D:/Work" }],
    findContainingProject: (projects, root) => projects.find((item) => item.path === root),
    catalogEntries: [{ provider: "codex", projectRoot: "D:/Work", threadId: "thread-1", sessionCwd: "D:/Work/sub" }],
    catalogEntryIsSelected: (entry, selected) => entry.provider === selected.provider
      && entry.projectRoot === selected.projectRoot
      && entry.threadId === selected.threadId,
    taskRuns: { forTask: (selected) => selected.threadId === run.threadId ? run : null },
    taskMetadata: new TaskMetadataStore({ validReasoningEfforts: ["high"] }),
    preferences: {
      current: () => ({ model: "sol", reasoningEffort: "high", collaborationMode: "default" }),
    },
    currentChatId: () => 42,
    contextualCallback: (action, token) => `${action}:${token}`,
    samePath: (left, right) => left.toLowerCase() === right.toLowerCase(),
    contextNonce: "stable-test",
  });
  return { resolver, run, selectionStore };
}

test("task identity resolves one selected target for every client", () => {
  const { resolver, run } = fixture();
  assert.deepEqual(resolver.selectedTurnTarget(), {
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "thread-1",
    sessionCwd: "D:/Work/sub",
    taskTitle: "Task one",
    chatId: 42,
    modelId: "sol",
    reasoningId: "high",
    collaborationMode: "default",
  });
  assert.equal(resolver.selectedRun(), run);
  assert.equal(resolver.isSelectedRun(run), true);
});

test("UI context changes with provider thread while title metadata stays explicit", () => {
  const { resolver, selectionStore } = fixture();
  const first = resolver.currentUiContextToken();
  resolver.pinTaskTitle("codex", "thread-1", "Pinned");
  assert.equal(resolver.pinnedTaskTitle("codex", "thread-1"), "Pinned");
  selectionStore.setThread("thread-2", { provider: "codex", title: "Task two" });
  assert.notEqual(resolver.currentUiContextToken(), first);
});
