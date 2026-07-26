import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  enqueueRuntimeCommandThroughSpool,
  forwardRuntimeCommand,
  forwardRuntimeCommandThroughSpool,
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
  assert.equal(validateRuntimeCommand({
    command: "turn-complete",
    args: ["{}"],
    cwd: "C:\\",
  }).command, "turn-complete");
});

test("runtime command can queue a durable fire-and-forget request", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-queued-runtime-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-queued-temp-"));
  let received = null;
  await enqueueRuntimeCommandThroughSpool("turn-complete", ["{\"turnId\":\"turn-1\"}"], {
    runtimeRoot,
    temporaryRoot,
    cwd: runtimeRoot,
    environment: { CODEX_THREAD_ID: "thread-1" },
  });
  const server = new RuntimeCommandServer({
    runtimeRoot,
    temporaryRoot,
    handler: async (request) => {
      received = request;
      return "accepted";
    },
  });
  await server.start();
  try {
    const deadline = Date.now() + 5_000;
    while (!received && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(received.command, "turn-complete");
    assert.equal(received.environment.CODEX_THREAD_ID, "thread-1");
  } finally {
    await server.close();
  }
});

test("runtime command rejects when the server closes without a response", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-empty-"));
  const server = createServer((socket) => socket.destroy());
  const endpoint = (await import("./runtime-command.mjs")).runtimeCommandEndpoint(runtimeRoot);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    await assert.rejects(
      forwardRuntimeCommand("send-message", ["Готово"], {
        runtimeRoot,
        cwd: runtimeRoot,
        timeoutMs: 5_000,
      }),
      /closed without a response/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runtime command spool provides the same narrow interface without a named pipe", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-spool-runtime-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-spool-temp-"));
  let received = null;
  const server = new RuntimeCommandServer({
    runtimeRoot,
    temporaryRoot,
    handler: async (request) => {
      received = request;
      return "spooled";
    },
  });
  await server.start();
  try {
    assert.equal(await forwardRuntimeCommandThroughSpool("send-message", ["Готово"], {
      runtimeRoot,
      temporaryRoot,
      cwd: runtimeRoot,
      environment: { CLAUDE_CODE_SESSION_ID: "session-1", TELEGRAM_BOT_TOKEN: "must-not-pass" },
      timeoutMs: 5_000,
    }), "spooled");
    assert.equal(received.environment.CLAUDE_CODE_SESSION_ID, "session-1");
    assert.equal(received.environment.TELEGRAM_BOT_TOKEN, undefined);
  } finally {
    await server.close();
  }
});
