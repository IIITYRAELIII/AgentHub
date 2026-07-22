import assert from "node:assert/strict";
import test from "node:test";
import { TaskViewController } from "./task-view-controller.mjs";

function controller(overrides = {}) {
  return new TaskViewController({
    findMessageBinding: async () => null,
    findCatalogEntry: async () => null,
    selectedTask: () => null,
    activeThreadTitle: () => "Current",
    ...overrides,
  });
}

test("task view binding resolves exact catalog identity", async () => {
  const entry = {
    provider: "codex",
    threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectRoot: "C:/repo",
    title: "Task",
  };
  const view = controller({ findCatalogEntry: async () => entry });
  const binding = await view.resolveBinding(entry, 9, 12);
  assert.equal(binding.taskTitle, "Task");
  assert.equal(binding.messageId, 12);
});

test("legacy task view uses its stored message binding", async () => {
  const stored = { provider: "claude", threadId: "session", taskTitle: "Saved" };
  const view = controller({ findMessageBinding: async () => stored });
  assert.equal(await view.resolveBinding(null, 9, 12), stored);
});
