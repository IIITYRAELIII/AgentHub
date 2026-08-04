import assert from "node:assert/strict";
import test from "node:test";
import { TaskSelectionStore } from "./task-selection-store.mjs";

test("selection store switches providers while preserving each thread", () => {
  const store = new TaskSelectionStore({
    activeProvider: "codex",
    activeProjectRoot: "C:/work",
    threadIds: { codex: "codex-1", claude: "claude-1" },
    threadId: "codex-1",
  });
  store.switchProvider("claude");
  assert.equal(store.activeProvider, "claude");
  assert.equal(store.threadId, "claude-1");
  store.setThread("claude-2");
  store.switchProvider("codex");
  assert.equal(store.threadId, "codex-1");
  assert.deepEqual(store.serialize().threadIds, { codex: "codex-1", claude: "claude-2" });
});

test("selection store updates a complete task atomically with one revision", () => {
  const store = new TaskSelectionStore({ activeProvider: "codex", activeProjectRoot: "C:/one" });
  const changes = [];
  store.subscribe((current, previous) => changes.push({ current, previous }));
  store.selectTask({
    activeProvider: "claude",
    activeProjectRoot: "C:/two",
    threadId: "session",
    activeThreadTitle: "Work",
  });
  assert.equal(store.revision, 1);
  assert.equal(changes.length, 1);
  assert.deepEqual(store.serialize(), {
    activeProvider: "claude",
    activeProjectRoot: "C:/two",
    threadId: "session",
    activeThreadTitle: "Work",
    threadIds: { codex: null, claude: "session" },
  });
});

test("selection checkpoint restores project, provider, threads and title", () => {
  const store = new TaskSelectionStore({
    activeProvider: "codex",
    activeProjectRoot: "C:/one",
    threadId: "thread-1",
    activeThreadTitle: "One",
  });
  const checkpoint = store.snapshot();
  store.switchProject("C:/two");
  store.selectTask({
    activeProvider: "claude",
    activeProjectRoot: "C:/two",
    threadId: "session-2",
    activeThreadTitle: "Two",
  });
  store.restore(checkpoint);
  assert.deepEqual(store.serialize(), {
    activeProvider: "codex",
    activeProjectRoot: "C:/one",
    threadId: "thread-1",
    activeThreadTitle: "One",
    threadIds: { codex: "thread-1", claude: null },
  });
});

test("selection store rejects unknown providers and ignores no-op mutations", () => {
  const store = new TaskSelectionStore({ activeProvider: "codex" });
  assert.throws(() => store.switchProvider("other"), /unknown provider/u);
  assert.equal(store.setTitle(""), false);
  assert.equal(store.revision, 0);
});

test("selection fields and provider thread map cannot be mutated outside the store", () => {
  const store = new TaskSelectionStore({ activeProvider: "codex", threadId: "thread-1" });
  assert.throws(() => { store.threadId = "thread-2"; }, TypeError);
  const serialized = store.serialize();
  serialized.threadIds.codex = "thread-3";
  assert.equal(store.threadId, "thread-1");
  assert.equal(store.serialize().threadIds.codex, "thread-1");
});
