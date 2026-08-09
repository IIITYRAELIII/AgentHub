import assert from "node:assert/strict";
import test from "node:test";

import {
  completeCodexLiveItem,
  reduceCodexLiveItemEvent,
  startCodexLiveItem,
} from "../../../src/providers/codex/codex-live-item-reducer.mjs";

test("Codex live reducer accumulates command output and terminal interaction", () => {
  const run = {};
  startCodexLiveItem(run, { id: "command-1", type: "commandExecution", command: "npm test" });
  const output = reduceCodexLiveItemEvent(run, "item/commandExecution/outputDelta", {
    itemId: "command-1",
    delta: "first\n",
  });
  assert.match(output.detail, /first/);
  const waiting = reduceCodexLiveItemEvent(run, "item/commandExecution/terminalInteraction", {
    itemId: "command-1",
    processId: "pty-1",
    stdin: "y\n",
  });
  assert.equal(waiting.status, "waiting");
  assert.match(waiting.detail, /Ввод: y/);
  const completed = completeCodexLiveItem(run, {
    id: "command-1",
    type: "commandExecution",
    command: "npm test",
    aggregatedOutput: "ok",
    exitCode: 0,
  });
  assert.equal(completed.status, "completed");
});

test("Codex live reducer updates file patches and MCP progress in place", () => {
  const run = {};
  const patch = reduceCodexLiveItemEvent(run, "item/fileChange/patchUpdated", {
    itemId: "patch-1",
    changes: [{ path: "src/app.js" }, { path: "src/style.css" }],
  });
  assert.match(patch.detail, /src\/app\.js/);
  reduceCodexLiveItemEvent(run, "item/mcpToolCall/progress", { itemId: "mcp-1", message: "Шаг 1" });
  const progress = reduceCodexLiveItemEvent(run, "item/mcpToolCall/progress", {
    itemId: "mcp-1",
    message: "Шаг 2",
  });
  assert.match(progress.detail, /Шаг 1\nШаг 2/);
  assert.equal(run.liveItems.length, 2);
});
