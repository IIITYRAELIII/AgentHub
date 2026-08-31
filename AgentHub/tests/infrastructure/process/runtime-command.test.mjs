import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  enqueueRuntimeCommandThroughSpool,
  forwardRuntimeCommand,
  forwardRuntimeCommandThroughSpool,
  RuntimeCommandServer,
  runtimeCommandEndpoint,
  runtimeCommandEnvironment,
  runtimeCommandSpoolDirectory,
  validateRuntimeCommand,
} from "../../../src/infrastructure/process/runtime-command.mjs";
import { DurableCommandRetryableError } from "../../../src/infrastructure/persistence/durable-command-receipts.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function leaveStaleUnixSocket(endpoint) {
  const child = spawn(process.execPath, [
    "-e",
    `const { createServer } = require("node:net");
const server = createServer();
server.listen(process.argv[1], () => process.stdout.write("ready\\n"));
setInterval(() => {}, 1_000);`,
    endpoint,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out creating stale socket: ${stderr}`)), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Socket fixture exited with code ${code}: ${stderr}`));
    });
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("runtime command server recovers an abandoned Unix socket", {
  skip: process.platform === "win32",
}, async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-command-stale-"));
  const endpoint = runtimeCommandEndpoint(runtimeRoot);
  const server = new RuntimeCommandServer({ runtimeRoot, handler: async () => "recovered" });
  try {
    await leaveStaleUnixSocket(endpoint);
    assert.equal((await stat(endpoint)).isSocket(), true);
    await server.start();
    assert.equal(await forwardRuntimeCommand("send-message", ["test"], {
      runtimeRoot,
      cwd: runtimeRoot,
    }), "recovered");
  } finally {
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("runtime command server preserves a live Unix socket", {
  skip: process.platform === "win32",
}, async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-command-live-"));
  const first = new RuntimeCommandServer({ runtimeRoot, handler: async () => "first" });
  const second = new RuntimeCommandServer({ runtimeRoot, handler: async () => "second" });
  await first.start();
  try {
    await assert.rejects(second.start(), (error) => error?.code === "EADDRINUSE");
    assert.equal(await forwardRuntimeCommand("send-message", ["test"], {
      runtimeRoot,
      cwd: runtimeRoot,
    }), "first");
  } finally {
    await second.close();
    await first.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("runtime command server recreates a removed spool directory", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-spool-recreate-runtime-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-spool-recreate-temp-"));
  const server = new RuntimeCommandServer({ runtimeRoot, temporaryRoot, handler: async () => "ok" });
  await server.start();
  try {
    const spool = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
    await rm(spool, { recursive: true, force: true });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !(await stat(spool).then(() => true, () => false))) await delay(20);
    assert.equal(await stat(spool).then(() => true, () => false), true);
  } finally {
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

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

test("runtime command reports an unexpected handler failure", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-command-diagnostics-"));
  const captured = [];
  const server = new RuntimeCommandServer({
    runtimeRoot,
    handler: async () => { throw new TypeError("broken handler invariant"); },
    captureUnexpectedException: (error, context) => captured.push([error.message, context.action]),
  });
  await server.start();
  try {
    await assert.rejects(forwardRuntimeCommand("send-message", ["test"], {
      runtimeRoot,
      cwd: runtimeRoot,
    }), /broken handler invariant/u);
    assert.deepEqual(captured, [["broken handler invariant", "request-handler"]]);
  } finally {
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
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
  assert.equal(validateRuntimeCommand({
    command: "turn-start",
    args: ["{\"turnId\":\"turn-1\"}"],
    cwd: process.cwd(),
  }).command, "turn-start");
});

test("runtime command authorization rejects fabricated lifecycle input before the handler", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-authority-"));
  const handled = [];
  const captured = [];
  const server = new RuntimeCommandServer({
    runtimeRoot,
    authorize: async (request) => {
      const payload = JSON.parse(request.args[0]);
      if (payload.turnId !== "turn-from-rollout") throw new Error("Lifecycle turn is not present in the rollout");
      return request;
    },
    handler: async (request) => {
      handled.push(request);
      return "accepted";
    },
    captureUnexpectedException: (error, context) => captured.push([error.message, context.action]),
  });
  await server.start();
  try {
    await assert.rejects(
      forwardRuntimeCommand("turn-complete", [JSON.stringify({ turnId: "forged-turn" })], {
        runtimeRoot,
        cwd: runtimeRoot,
      }),
      /not present in the rollout/,
    );
    assert.equal(await forwardRuntimeCommand("turn-complete", [JSON.stringify({ turnId: "turn-from-rollout" })], {
      runtimeRoot,
      cwd: runtimeRoot,
    }), "accepted");
    assert.equal(handled.length, 1);
    assert.deepEqual(captured, []);
  } finally {
    await server.close();
  }
});

for (const [name, write] of [
  ["idle client", () => {}],
  ["partial client", (socket) => socket.write("{")],
]) {
  test(`runtime command shutdown does not wait forever for a ${name}`, async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-close-"));
    const server = new RuntimeCommandServer({ runtimeRoot, handler: async () => "unused" });
    await server.start();
    const socket = createConnection(runtimeCommandEndpoint(runtimeRoot));
    const connected = new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    let closing;
    try {
      await connected;
      write(socket);
      closing = server.close();
      assert.equal(await Promise.race([closing.then(() => true), delay(500).then(() => false)]), true);
    } finally {
      socket.destroy();
      await closing;
    }
  });
}

test("runtime command shutdown does not wait for a stalled handler", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-stalled-close-"));
  let handlerStarted;
  const started = new Promise((resolve) => { handlerStarted = resolve; });
  const server = new RuntimeCommandServer({
    runtimeRoot,
    handler: async () => {
      handlerStarted();
      await new Promise(() => {});
    },
  });
  await server.start();
  const socket = createConnection(runtimeCommandEndpoint(runtimeRoot));
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ command: "send-message", args: ["test"], cwd: runtimeRoot })}\n`);
    await started;
    assert.equal(await Promise.race([server.close().then(() => true), delay(500).then(() => false)]), true);
  } finally {
    socket.destroy();
  }
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

test("runtime command spool retries authorization before creating a receipt", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-command-retry-runtime-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-command-retry-temp-"));
  let authorizationAttempts = 0;
  let handled = 0;
  await enqueueRuntimeCommandThroughSpool("turn-complete", ["{\"turnId\":\"turn-1\"}"], {
    runtimeRoot,
    temporaryRoot,
    cwd: runtimeRoot,
  });
  const server = new RuntimeCommandServer({
    runtimeRoot,
    temporaryRoot,
    authorize: async (request) => {
      authorizationAttempts += 1;
      if (authorizationAttempts === 1) {
        throw new DurableCommandRetryableError("rollout has not reached terminal state");
      }
      return request;
    },
    handler: async () => { handled += 1; },
  });
  await server.start();
  try {
    const deadline = Date.now() + 5_000;
    while (handled === 0 && Date.now() < deadline) await delay(20);
    assert.equal(handled, 1);
    assert.ok(authorizationAttempts >= 2);
    const spool = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
    while ((await readdir(spool)).some((name) => name.endsWith(".request.json"))
      && Date.now() < deadline) await delay(20);
  } finally {
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime command spool reconciles a crash after a side effect without replaying it", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-receipt-runtime-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-receipt-temp-"));
  const id = "request-crash";
  const spool = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
  await mkdir(spool, { recursive: true });
  await writeFile(path.join(spool, `${id}.request.json`), JSON.stringify({
    id,
    command: "send-message",
    args: ["one"],
    cwd: runtimeRoot,
  }));
  let effects = 0;
  let effectStarted;
  const started = new Promise((resolve) => { effectStarted = resolve; });
  const first = new RuntimeCommandServer({
    runtimeRoot,
    temporaryRoot,
    handler: async () => {
      effects += 1;
      effectStarted();
      await new Promise(() => {});
    },
  });
  await first.start();
  await started;
  await first.close();
  // The hanging handler above models an interrupted process inside this test;
  // make the persisted owner match an actual crashed process before restart.
  const receiptFile = path.join(spool, "receipts.json");
  const receipts = JSON.parse(await readFile(receiptFile, "utf8"));
  receipts.records[0].effectOwner.pid = 999_999;
  await writeFile(receiptFile, `${JSON.stringify(receipts)}\n`);
  const restarted = new RuntimeCommandServer({
    runtimeRoot,
    temporaryRoot,
    handler: async () => { effects += 1; },
    reconcile: async () => ({ resolved: true, result: "already sent" }),
  });
  await restarted.start();
  try {
    const responseFile = path.join(spool, `${id}.response.json`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        assert.deepEqual(JSON.parse(await readFile(responseFile, "utf8")), { ok: true, result: "already sent" });
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await delay(20);
      }
    }
    assert.ok(Date.now() < deadline, "spool response was not recovered");
    assert.equal(effects, 1);
  } finally {
    await restarted.close();
  }
});

test("runtime command rejects when the server closes without a response", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-empty-"));
  const server = createServer((socket) => socket.destroy());
  const endpoint = (await import("../../../src/infrastructure/process/runtime-command.mjs")).runtimeCommandEndpoint(runtimeRoot);
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

test("spool acknowledgement retires a delivered receipt", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-ack-runtime-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-ack-temp-"));
  const server = new RuntimeCommandServer({
    runtimeRoot,
    temporaryRoot,
    handler: async () => "acknowledged",
  });
  await server.start();
  try {
    assert.equal(await forwardRuntimeCommandThroughSpool("send-message", ["one"], {
      runtimeRoot,
      temporaryRoot,
      cwd: runtimeRoot,
      timeoutMs: 5_000,
    }), "acknowledged");
    const spool = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
    const deadline = Date.now() + 5_000;
    while ((await readdir(spool)).some((name) => name.endsWith(".ack")) && Date.now() < deadline) {
      await delay(20);
    }
    const journal = JSON.parse(await readFile(path.join(spool, "receipts.json"), "utf8"));
    assert.deepEqual(journal.records, []);
  } finally {
    await server.close();
  }
});

test("spool acknowledgement skips a request still present in the same directory snapshot", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-ack-race-runtime-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-command-ack-race-temp-"));
  let effects = 0;
  const server = new RuntimeCommandServer({
    runtimeRoot,
    temporaryRoot,
    handler: async () => { effects += 1; return "must not run"; },
  });
  const id = "already-acknowledged";
  const spool = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
  try {
    await mkdir(spool, { recursive: true });
    await writeFile(path.join(spool, `${id}.request.json`), JSON.stringify({
      id,
      command: "send-message",
      args: ["one"],
      cwd: runtimeRoot,
    }));
    await writeFile(path.join(spool, `${id}.ack`), "\n");
    await server.start();
    await delay(250);
    assert.equal(effects, 0);
    assert.equal((await readdir(spool)).some((name) => name.endsWith(".ack")), false);
  } finally {
    await server.close();
  }
});
