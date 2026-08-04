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

