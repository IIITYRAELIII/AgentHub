import assert from "node:assert/strict";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { enqueueLifecycleRequest, lifecycleRequest, main } from "../../../codex-stop-hook-launcher.mjs";

test("sandbox launcher builds a narrow turn-start relay request", () => {
  const { request } = lifecycleRequest({
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-1",
    turn_id: "turn-1",
    cwd: ".",
    prompt: "Проверка связи",
  }, {
    CODEX_HOME: "C:\\Codex",
    TELEGRAM_BOT_TOKEN: "must-not-pass",
  });
  assert.equal(request.command, "turn-start");
  assert.equal(request.environment.CODEX_THREAD_ID, "thread-1");
  assert.equal(request.environment.CODEX_HOME, "C:\\Codex");
  assert.equal(request.environment.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(JSON.parse(request.args[0]).prompt, "Проверка связи");
});

test("sandbox launcher builds a minimal turn-complete relay request", () => {
  const { request } = lifecycleRequest({
    hook_event_name: "Stop",
    session_id: "thread-1",
    turn_id: "turn-1",
    cwd: ".",
  });
  assert.equal(request.command, "turn-complete");
  assert.equal(JSON.parse(request.args[0]).status, "unknown");
});

test("sandbox launcher rejects incomplete lifecycle identity", () => {
  assert.throws(
    () => lifecycleRequest({ hook_event_name: "Stop", session_id: "thread-1", cwd: "." }),
    /missing session_id, turn_id or cwd/,
  );
});

test("sandbox launcher enqueues lifecycle input once without waiting for rollout state", async () => {
  const request = { id: "first", command: "turn-complete" };
  const calls = [];
  await enqueueLifecycleRequest(request, "runtime", {
    enqueueRequest: async (...args) => calls.push(args),
    temporaryRoot: "workspace-runtime",
  });
  assert.deepEqual(calls, [[request, "runtime", "workspace-runtime"]]);
});

test("sandbox launcher returns valid empty JSON after a successful Stop hook", async () => {
  const writes = [];
  const requests = [];
  await main({
    environment: { LOCALAPPDATA: "C:\\AgentHubTest" },
    input: Readable.from([JSON.stringify({
      hook_event_name: "Stop",
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: ".",
    })]),
    output: { write: (value) => writes.push(value) },
    enqueueRequest: async (request, runtimeRoot, options) => requests.push({ request, runtimeRoot, options }),
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.command, "turn-complete");
  assert.equal(requests[0].options.temporaryRoot, `${path.resolve(".")}\\.agent-hub\\runtime`);
  assert.equal(writes.join(""), "{}\n");
});
