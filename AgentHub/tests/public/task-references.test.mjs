import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function referencesView() {
  const source = await readFile(new URL("../../assets/web-app/task-references.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubTaskReferences;
}

test("Task drag payload stays a reference and carries no Task body", async () => {
  const references = await referencesView();
  const payload = references.transferText({
    id: "board-1",
    taskNumber: "HUB-11",
    title: "Исправить Dashboard",
    description: "Секретное подробное описание",
    workflowStatus: "testing",
    workspaceId: "workspace-1",
  });
  const parsed = JSON.parse(payload);

  assert.equal(parsed.taskId, "board-1");
  assert.equal(parsed.taskNumber, "HUB-11");
  assert.equal(parsed.title, "Исправить Dashboard");
  assert.equal(parsed.intent, "context");
  assert.equal("description" in parsed, false);
});

test("Task references deduplicate in one composer draft", async () => {
  const references = await referencesView();
  const initial = references.merge([], { taskId: "board-1", title: "Первая" });
  const updated = references.merge(initial, { taskId: "board-1", title: "Обновлённая" });

  assert.equal(updated.length, 1);
  assert.equal(updated[0].title, "Обновлённая");
});

test("Task drag uses only its private MIME and survives an empty Edge transfer view", async () => {
  const references = await referencesView();
  const writes = [];
  const dataTransfer = {
    effectAllowed: "",
    types: [],
    getData: () => "",
    setData: (type, value) => writes.push({ type, value }),
  };

  references.beginDrag(dataTransfer, {
    id: "board-2",
    title: "Контекст для Stream",
    workspaceId: "workspace-2",
  });

  assert.deepEqual(writes.map(({ type }) => type), [references.MIME]);
  assert.equal(writes.some(({ type }) => type === "text/plain"), false);
  assert.equal(dataTransfer.effectAllowed, "copyMove");
  assert.equal(references.hasTransfer(dataTransfer), true);
  assert.equal(references.fromTransfer(dataTransfer)?.taskId, "board-2");

  references.endDrag();
  assert.equal(references.hasTransfer(dataTransfer), false);
  assert.equal(references.fromTransfer(dataTransfer), null);
});

test("Dashboard Task URI becomes an internal card link", async () => {
  const references = await referencesView();
  const taskId = "bdcaff6a-c7e9-488f-b772-647ee8359922";

  assert.equal(references.link("[invalid]"), null);
  assert.deepEqual(
    { ...references.link(`agent-hub://task/${taskId}`) },
    { href: `agent-hub://task/${taskId}`, taskId },
  );
  assert.equal(references.link("agent-hub://stream/not-a-task"), null);
});

test("Dashboard Task link dispatches the exact card-open identity", async () => {
  const references = await referencesView();
  const events = [];
  const taskId = "bdcaff6a-c7e9-488f-b772-647ee8359922";

  assert.equal(references.open(`agent-hub://task/${taskId}`, {
    dispatch: (type, detail) => events.push({ type, detail }),
  }), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "agenthub:task-reference-open");
  assert.equal(events[0].detail.taskId, taskId);
  assert.equal(references.open("agent-hub://task/%E0%A4%A", {
    dispatch: () => assert.fail("invalid URI must not dispatch"),
  }), false);
});
