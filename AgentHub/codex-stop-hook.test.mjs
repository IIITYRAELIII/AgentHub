import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { handleCodexStopHook, validateStopHookInput } from "./codex-stop-hook.mjs";

const hookInput = {
  hook_event_name: "Stop",
  session_id: "thread-1",
  turn_id: "turn-1",
  cwd: process.cwd(),
  transcript_path: "rollout.jsonl",
};

test("Codex Stop hook forwards exact turn usage to the Agent Hub Server", async () => {
  let received = null;
  const result = await handleCodexStopHook(hookInput, {
    readUsage: async () => ({
      reported: true,
      status: "aborted",
      startedAt: "2026-07-26T19:03:03.527Z",
      completedAt: "2026-07-26T19:04:03.527Z",
      prompt: "Точный запрос",
      changedFiles: [
        path.join(process.cwd(), "AgentHub", "first.mjs"),
        path.resolve(process.cwd(), "..", "outside.mjs"),
      ],
      diff: "*** Begin Patch\n*** Update File: AgentHub/first.mjs\n+new\n*** End Patch",
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
  assert.equal(received.payload.status, "aborted");
  assert.equal(received.payload.prompt, "Точный запрос");
  assert.deepEqual(received.payload.changedFiles, ["AgentHub/first.mjs"]);
  assert.match(received.payload.diff, /Update File: AgentHub\/first\.mjs/u);
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
  assert.equal(received.status, "unknown");
  assert.match(received.usageError, /rollout changed/);
});

test("Codex Stop hook rejects unrelated lifecycle events", () => {
  assert.throws(
    () => validateStopHookInput({ ...hookInput, hook_event_name: "PostToolUse" }),
    /Stop hook/,
  );
});
