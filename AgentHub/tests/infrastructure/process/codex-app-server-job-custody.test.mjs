import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexAppServerJobCustody } from "../../../src/infrastructure/process/codex-app-server-job-custody.mjs";
import { processIsAlive } from "../../../src/infrastructure/process/process-liveness.mjs";

async function waitFor(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

test("Windows Codex job custody retires a reparented Java-like grandchild but preserves a foreign shared runtime", {
  skip: process.platform !== "win32" && "Windows Job Object behavior",
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub128-job-custody-"));
  const release = path.join(root, "release");
  const grandchildPath = path.join(root, "grandchild.json");
  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const wrapperScript = [
    "const { existsSync, writeFileSync } = require('node:fs')",
    "const { spawn } = require('node:child_process')",
    `const release = ${JSON.stringify(release)}`,
    `const target = ${JSON.stringify(grandchildPath)}`,
    "const timer = setInterval(() => {",
    "  if (!existsSync(release)) return",
    "  clearInterval(timer)",
    "  const javaLike = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true })",
    "  writeFileSync(target, JSON.stringify({ pid: javaLike.pid }))",
    "  javaLike.unref()",
    "  setTimeout(() => process.exit(0), 50)",
    "}, 10)",
  ].join(";\n");
  const wrapper = spawn(process.execPath, ["-e", wrapperScript], {
    stdio: "ignore",
    windowsHide: true,
  });
  let grandchildPid = null;
  let custody = null;
  context.after(async () => {
    try { await custody?.close(); } catch {}
    if (processIsAlive(wrapper.pid)) wrapper.kill();
    if (grandchildPid && processIsAlive(grandchildPid)) process.kill(grandchildPid);
    if (processIsAlive(foreign.pid)) foreign.kill();
    await rm(root, { recursive: true, force: true });
  });

  custody = createCodexAppServerJobCustody(wrapper.pid);
  assert.equal(await custody.start(), true);
  await writeFile(release, "go", "utf8");
  grandchildPid = await waitFor(async () => {
    try { return Number(JSON.parse(await readFile(grandchildPath, "utf8")).pid) || null; }
    catch { return null; }
  }, "Java-like grandchild PID");
  await waitFor(() => !processIsAlive(wrapper.pid), "wrapper exit");
  assert.equal(processIsAlive(grandchildPid), true, "grandchild outlived its intermediate wrapper");
  assert.equal(processIsAlive(foreign.pid), true, "foreign shared runtime baseline");

  assert.equal(await custody.close(), true);
  await waitFor(() => !processIsAlive(grandchildPid), "owned grandchild retirement");
  assert.equal(processIsAlive(foreign.pid), true, "foreign shared runtime was not a job member");
  assert.deepEqual(custody.diagnostics(), {
    rootPid: wrapper.pid,
    helperPid: custody.diagnostics().helperPid,
    state: "closed",
    active: 0,
    error: null,
  });
});
