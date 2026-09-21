import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFatalProcessHandler } from "../../src/runtime/fatal-process-handler.mjs";

test("fatal process handler sets a failing exit code and shuts down once", async () => {
  const calls = [];
  const processRef = { exitCode: 0 };
  const handler = createFatalProcessHandler({
    processRef,
    logger: { error: (...args) => calls.push(["error", ...args]) },
    captureException: (error, context) => calls.push(["capture", error.message, context.kind]),
    flushDiagnostics: async (timeoutMs) => calls.push(["flush", timeoutMs]),
    shutdown: async (reason) => calls.push(["shutdown", reason]),
  });

  await Promise.all([
    handler("unhandled rejection", new Error("first")),
    handler("uncaught exception", new Error("second")),
  ]);

  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(calls.map((entry) => entry[0]), ["error", "capture", "flush", "shutdown"]);
  assert.deepEqual(calls[1], ["capture", "first", "fatal"]);
  assert.deepEqual(calls[3], ["shutdown", "unhandled rejection"]);
});

test("fatal process handler reports shutdown failure", async () => {
  const errors = [];
  const exits = [];
  const handler = createFatalProcessHandler({
    processRef: { exitCode: 0, exit: (code) => exits.push(code) },
    logger: { error: (...args) => errors.push(args) },
    shutdown: async () => { throw new Error("shutdown failed"); },
  });

  await handler("uncaught exception", new Error("boom"));

  assert.equal(errors.length, 2);
  assert.equal(errors[1][0], "Agent Hub fatal shutdown failed:");
  assert.deepEqual(exits, [1]);
});

test("fatal startup handler exits after shutdown when requested", async () => {
  const exits = [];
  const handler = createFatalProcessHandler({
    processRef: { exitCode: 0, exit: (code) => exits.push(code) },
    logger: { error() {} },
    captureException: () => {},
    flushDiagnostics: async () => {},
    shutdown: async () => {},
    exitAfterShutdown: true,
  });

  await handler("startup failed", new Error("boom"));

  assert.deepEqual(exits, [1]);
});

test("a failed startup exits even while an open handle would keep Node alive", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-fatal-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handlerUrl = new URL("../../src/runtime/fatal-process-handler.mjs", import.meta.url).href;

  async function run(exitAfterShutdown) {
    const script = path.join(directory, `startup-${exitAfterShutdown}.mjs`);
    await writeFile(script, [
      'import { createServer } from "node:net";',
      `import { createFatalProcessHandler } from ${JSON.stringify(handlerUrl)};`,
      "const server = createServer();",
      'await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
      "const handler = createFatalProcessHandler({",
      "  shutdown: async () => {},",
      "  captureException: () => {},",
      "  flushDiagnostics: async () => {},",
      "  logger: { error() {} },",
      `  exitAfterShutdown: ${exitAfterShutdown},`,
      "});",
      'await handler("startup failed", new Error("boom"));',
    ].join("\n"));
    const child = spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve({ timedOut: true, code: null });
      }, 3_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ timedOut: false, code });
      });
    });
  }

  assert.deepEqual(await run(true), { timedOut: false, code: 1 });
  const lingering = await run(false);
  assert.equal(lingering.timedOut, true, "without the explicit exit the open handle keeps the process alive");
});
