import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  forwardRuntimeCommand,
  RuntimeCommandServer,
  runtimeCommandEnvironment,
  validateRuntimeCommand,
} from "./runtime-command.mjs";

test("runtime command forwarding exposes only the narrow notification interface", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-"));
  let received = null;
  const server = new RuntimeCommandServer({
    runtimeRoot,
    handler: async (request) => {
      received = request;
      return "sent";
    },
  });
  await server.start();
  try {
    assert.equal(await forwardRuntimeCommand("send-message", ["Готово"], {
      runtimeRoot,
      cwd: runtimeRoot,
      environment: { CODEX_THREAD_ID: "thread-1", TELEGRAM_BOT_TOKEN: "must-not-pass" },
    }), "sent");
    assert.equal(received.command, "send-message");
    assert.equal(received.environment.CODEX_THREAD_ID, "thread-1");
    assert.equal(received.environment.TELEGRAM_BOT_TOKEN, undefined);
  } finally {
    await server.close();
  }
});

test("runtime command validation rejects arbitrary processes and environment secrets", () => {
  assert.throws(
    () => validateRuntimeCommand({ command: "shell", args: ["whoami"], cwd: "C:\\" }),
    /Unsupported/,
  );
  assert.deepEqual(runtimeCommandEnvironment({
    CLAUDE_CODE_SESSION_ID: "session-1",
    TELEGRAM_BOT_TOKEN: "secret",
  }), { CLAUDE_CODE_SESSION_ID: "session-1" });
});
