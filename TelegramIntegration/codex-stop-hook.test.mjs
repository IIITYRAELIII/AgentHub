import assert from "node:assert/strict";
import test from "node:test";

import { handleCodexStopHook, validateStopHookInput } from "./codex-stop-hook.mjs";

const hookInput = {
  hook_event_name: "Stop",
  session_id: "thread-1",
  turn_id: "turn-1",
  cwd: process.cwd(),
  transcript_path: "rollout.jsonl",
};

test("Codex Stop hook forwards exact turn usage to the Integration Server", async () => {
  let received = null;
  const result = await handleCodexStopHook(hookInput, {
    readUsage: async () => ({
      reported: true,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 8,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        totalTokens: 12,
      },
    }),
    forward: async (command, args, options) => {
      received = { command, payload: JSON.parse(args[0]), options };
      return "accepted";
    },
  });
  assert.equal(result.queued, false);
  assert.equal(received.command, "turn-complete");
  assert.equal(received.payload.turnId, "turn-1");
  assert.equal(received.payload.usage.inputTokens, 10);
  assert.equal(received.options.environment.CODEX_THREAD_ID, "thread-1");
});

test("Codex Stop hook keeps completion delivery even when usage parsing fails", async () => {
  let received = null;
  await handleCodexStopHook(hookInput, {
    readUsage: async () => {
      throw new Error("rollout changed");
    },
    forward: async (_command, args) => {
      received = JSON.parse(args[0]);
      return "accepted";
    },
  });
  assert.equal(received.usageReported, false);
  assert.match(received.usageError, /rollout changed/);
});

test("Codex Stop hook rejects unrelated lifecycle events", () => {
  assert.throws(
    () => validateStopHookInput({ ...hookInput, hook_event_name: "PostToolUse" }),
    /Stop hook/,
  );
});
