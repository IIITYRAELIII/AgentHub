import assert from "node:assert/strict";
import test from "node:test";

import { TaskMetadataStore } from "../../src/application/task-metadata-store.mjs";

const reference = { provider: "codex", threadId: "thread-1" };

test("task metadata owns pinned and pending titles", () => {
  const store = new TaskMetadataStore({ validReasoningEfforts: ["high"] });
  assert.equal(store.pinTitle(reference, "  Название   задачи  "), "Название задачи");
  assert.equal(store.pinnedTitle(reference), "Название задачи");
  assert.equal(store.expectTitle(reference, "Новое имя"), "Новое имя");
  assert.equal(store.pendingTitle(reference), "Новое имя");
  store.clearExpectedTitle("codex\0thread-1");
  assert.equal(store.pendingTitle(reference), "");
  assert.deepEqual(store.reconcilePinnedTitle(reference, "Имя из провайдера"), {
    title: "Имя из провайдера",
    changed: true,
  });
});

test("pending provider confirmation rejects a stale catalog title", () => {
  const store = new TaskMetadataStore();
  store.pinTitle(reference, "Новое имя");
  store.expectTitle(reference, "Новое имя");

  assert.deepEqual(store.reconcilePinnedTitle(reference, "Старое имя"), {
    title: "Новое имя",
    changed: false,
  });
  assert.equal(store.pinnedTitle(reference), "Новое имя");
});

test("task metadata restores compatible state and validates Codex settings", () => {
  const store = new TaskMetadataStore({
    maximumEntries: 2,
    validReasoningEfforts: ["low", "high"],
  });
  store.restore({
    pinnedTaskTitles: {
      "codex\0old": "Старое",
      "codex\0thread-1": "Текущее",
    },
    pendingTaskTitleConfirmations: { "claude\0session-1": "Claude task" },
    codexTaskSettings: {
      invalid: { model: "gpt-invalid", reasoningEffort: "unknown" },
      "thread-1": { model: "gpt-5.6-sol", reasoningEffort: "high" },
    },
  });

  assert.equal(store.pinnedTitle(reference), "Текущее");
  assert.equal(store.pendingTitle({ provider: "claude", threadId: "session-1" }), "Claude task");
  assert.deepEqual(store.codexSettings("thread-1"), {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  assert.equal(store.codexSettings("invalid"), null);
});

test("streamId keeps metadata while provider threads rotate", () => {
  const store = new TaskMetadataStore({ validReasoningEfforts: ["high"] });
  store.pinTitle({ streamId: "stream-1", provider: "codex", threadId: "old" }, "Work");
  store.rememberCodexSettings(
    { streamId: "stream-1", threadId: "old" },
    { model: "gpt-5.6-sol", reasoningEffort: "high" },
  );

  assert.equal(
    store.pinnedTitle({ streamId: "stream-1", provider: "codex", threadId: "new" }),
    "Work",
  );
  assert.deepEqual(store.codexSettings({ streamId: "stream-1", threadId: "new" }), {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
});
