import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
for (const mode of ["http-only", "explicit-wait"]) {
  test(`background source failure stays owned after HTTP202 (${mode})`, {  }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "transfer-lifetime-"));
    t.after(async () => {
      assert.equal(path.dirname(root), os.tmpdir());
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    const { stdout, stderr } = await execute(process.execPath,
      [fileURLToPath(new URL("../fixtures/file-transfer-prepare-worker.mjs", import.meta.url)), root, mode],
      { windowsHide: true, timeout: 20_000, env: { ...process.env, NODE_OPTIONS: "--no-warnings" } });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { accepted: "preparing", alive: true, durableState: "failed", shareStatus: 409,
      partials: 0, explicitWaitRejected: mode === "explicit-wait" });
  });
}
