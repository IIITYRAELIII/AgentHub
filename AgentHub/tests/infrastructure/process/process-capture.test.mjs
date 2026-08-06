import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { captureProcess } from "../../../src/infrastructure/process/process-capture.mjs";

test("captureProcess returns bounded stdout and stderr", async () => {
  const result = await captureProcess(process.execPath, [
    "-e",
    "process.stdout.write('абвгд'); process.stderr.write('error')",
  ], { maxOutputBytes: 6 });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "абв");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderr, "error");
  assert.equal(result.stderrTruncated, false);
});

test("captureProcess times out and stops the child", async () => {
  const result = await captureProcess(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ], { timeoutMs: 30 });

  assert.equal(result.code, null);
  assert.equal(result.error?.code, "ETIMEDOUT");
});
