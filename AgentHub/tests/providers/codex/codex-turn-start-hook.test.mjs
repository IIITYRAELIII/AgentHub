import assert from "node:assert/strict";
import test from "node:test";

import {
  handleCodexTurnStartHook,
  validateTurnStartHookInput,
} from "../../../src/providers/codex/codex-turn-start-hook.mjs";

const hookInput = {
  hook_event_name: "UserPromptSubmit",
  session_id: "thread-1",
  turn_id: "turn-1",
  cwd: process.cwd(),
  prompt: "Сделай работу\n<environment_context>служебное</environment_context>",
};

test("Codex turn-start hook registers the exact prompt without a Git snapshot", async () => {
  const received = [];
  const result = await handleCodexTurnStartHook(hookInput, {
    now: () => new Date("2026-07-27T00:00:00.000Z"),
    detectExecutionOwner: async () => "desktop",
    forward: async (command, args, options) => {
      received.push({ command, payload: JSON.parse(args[0]), options });
      return "accepted";
    },
  });

  assert.equal(result.queued, false);
  assert.equal(received.length, 1);
  assert.equal(received[0].command, "turn-start");
  assert.equal(received[0].payload.prompt, "Сделай работу");
  assert.equal(received[0].payload.gitBaseline, null);
  assert.equal(received[0].payload.executionOwner, "desktop");
  assert.equal(received[0].payload.startedAt, "2026-07-27T00:00:00.000Z");
  assert.equal(received[0].options.environment.CODEX_THREAD_ID, "thread-1");
});

test("Codex turn-start hook rejects unrelated events", () => {
  assert.throws(
    () => validateTurnStartHookInput({ ...hookInput, hook_event_name: "Stop" }),
    /UserPromptSubmit/,
  );
});
