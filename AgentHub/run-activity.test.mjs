import assert from "node:assert/strict";
import test from "node:test";
import { appendRunActivity, codexItemActivity } from "./run-activity.mjs";

test("run activities update by stable id and remain bounded", () => {
  const run = { activities: [] };
  for (let index = 0; index < 105; index += 1) {
    appendRunActivity(run, { id: `item:${index}`, label: `Item ${index}` });
  }
  appendRunActivity(run, { id: "item:104", label: "Updated", status: "completed" });
  assert.equal(run.activities.length, 100);
  assert.deepEqual(run.activities.at(-1), {
    id: "item:104",
    type: "stage",
    label: "Updated",
    detail: "",
    status: "completed",
    time: run.activities.at(-1).time,
  });
});

test("Codex item activity projects commands, tools and compaction", () => {
  assert.deepEqual(codexItemActivity({ id: "1", type: "commandExecution", command: "npm test" }, false), {
    id: "item:1", status: "running", type: "command", label: "Выполняется команда", detail: "npm test",
  });
  assert.equal(codexItemActivity({ id: "2", type: "mcpToolCall", server: "db", tool: "query" }, true).detail, "db/query");
  assert.equal(codexItemActivity({ id: "3", type: "contextCompaction" }, true).label, "Контекст свёрнут");
  assert.equal(codexItemActivity({ type: "unknown" }, false), null);
});

test("Codex item activity distinguishes real subagents from agent messages", () => {
  assert.equal(codexItemActivity({ id: "msg", type: "agentMessage", text: "Обычный ответ" }, true), null);
  assert.equal(codexItemActivity({ id: "other", type: "agenticReview" }, true), null);
  assert.deepEqual(codexItemActivity({
    id: "spawn",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "completed",
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    receiverThreadIds: ["child-thread"],
  }, true), {
    id: "item:spawn",
    status: "completed",
    type: "subagent",
    label: "Субагент запущен",
    detail: "gpt-5.6-terra · high · child-thread",
  });
  assert.equal(codexItemActivity({
    id: "started", type: "subAgentActivity", kind: "started", agentPath: "/root/check",
  }, true).label, "Субагент начал работу");
  assert.equal(codexItemActivity({
    id: "wait",
    type: "collabAgentToolCall",
    tool: "wait",
    status: "completed",
    agentsStates: { "child-thread": { status: "completed", message: "Готово" } },
  }, true).label, "Субагент завершил работу");
});
