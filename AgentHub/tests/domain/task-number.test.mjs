import assert from "node:assert/strict";
import test from "node:test";

import {
  messageWithTaskReferences,
  taskReferenceDescriptor,
  taskReferencePromptDetails,
} from "../../src/domain/task-board-task.mjs";
import {
  normalizedTaskNumber,
  normalizedWorkspaceTaskPrefix,
  taskNumberParts,
} from "../../src/domain/task-number.mjs";

test("Task numbers use a branch-safe prefix and positive ordinal", () => {
  assert.equal(normalizedWorkspaceTaskPrefix(" HUB "), "HUB");
  assert.equal(normalizedWorkspaceTaskPrefix("ПРОЕКТ.API"), "ПРОЕКТ.API");
  assert.equal(normalizedTaskNumber(" HUB-11 "), "HUB-11");
  assert.deepEqual(taskNumberParts("HUB-11"), { prefix: "HUB", ordinal: 11 });
  assert.throws(() => normalizedWorkspaceTaskPrefix("-HUB"), /Префикс Workspace/u);
  assert.throws(() => normalizedTaskNumber("HUB"), /ПРЕФИКС-N/u);
  assert.throws(() => normalizedTaskNumber("HUB-0"), /ПРЕФИКС-N/u);
});

test("Task references render the number and preserve the title as a tooltip", () => {
  const reference = taskReferenceDescriptor({
    id: "task-11",
    taskNumber: "HUB-11",
    title: "Исправить Dashboard",
    workflowStatus: "testing",
    workspaceId: "workspace-1",
  });
  const prompt = messageWithTaskReferences("Проверь", [reference]);

  assert.match(prompt, /\[HUB-11\]\(agent-hub:\/\/task\/task-11 "Исправить Dashboard"\)/u);
  assert.deepEqual(taskReferencePromptDetails(prompt)?.references, [{
    ...reference,
    workspaceId: null,
  }]);
});
