import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  handleCodexTurnStartHook,
  validateTurnStartHookInput,
} from "./codex-turn-start-hook.mjs";

const hookInput = {
  hook_event_name: "UserPromptSubmit",
  session_id: "thread-1",
  turn_id: "turn-1",
  cwd: process.cwd(),
  prompt: "Сделай работу\n<environment_context>служебное</environment_context>",
};

test("Codex turn-start hook captures a pre-turn Git baseline and exact prompt", async () => {
  let captured = null;
  let received = null;
  const baseline = {
    repoRoot: path.resolve(process.cwd()),
    tree: "tree-before",
    capturedAt: "2026-07-27T00:00:00.000Z",
  };
  const result = await handleCodexTurnStartHook(hookInput, {
    dataDir: path.join(process.cwd(), "data"),
    now: () => new Date("2026-07-27T00:00:00.000Z"),
    captureBaseline: async (...args) => {
      captured = args;
      return baseline;
    },
    forward: async (command, args, options) => {
      received = { command, payload: JSON.parse(args[0]), options };
      return "accepted";
    },
  });

  assert.equal(result.queued, false);
  assert.equal(received.command, "turn-start");
  assert.equal(received.payload.prompt, "Сделай работу");
  assert.deepEqual(received.payload.gitBaseline, baseline);
  assert.equal(received.payload.startedAt, "2026-07-27T00:00:00.000Z");
  assert.equal(received.options.environment.CODEX_THREAD_ID, "thread-1");
  assert.equal(captured[0], path.resolve(process.cwd()));
  assert.match(captured[2], /turn-1/);
});

test("Codex turn-start hook rejects unrelated events", () => {
  assert.throws(
    () => validateTurnStartHookInput({ ...hookInput, hook_event_name: "Stop" }),
    /UserPromptSubmit/,
  );
});
