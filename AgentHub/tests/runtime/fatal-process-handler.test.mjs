import assert from "node:assert/strict";
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
  const handler = createFatalProcessHandler({
    processRef: { exitCode: 0 },
    logger: { error: (...args) => errors.push(args) },
    shutdown: async () => { throw new Error("shutdown failed"); },
  });

  await handler("uncaught exception", new Error("boom"));

  assert.equal(errors.length, 2);
  assert.equal(errors[1][0], "Agent Hub fatal shutdown failed:");
});
