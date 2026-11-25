import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withInterprocessLocks } from "../../../src/infrastructure/process/interprocess-lock.mjs";
import { withTaskOperationTiming } from "../../../src/infrastructure/process/task-operation-timing.mjs";

test("native lock diagnostics observe the exact live process birth and refuse invalid process IDs", {
  skip: process.platform !== "win32", timeout: 15_000,
}, async t => {
  const api = await import("../../../src/infrastructure/process/windows-lock-directory-publication.mjs?holder-diagnostic");
  const publisher = await api.prepareWindowsLockDirectoryPublisher();
  t.after(() => publisher.shutdown());
  const first = await publisher.inspectProcess(process.pid);
  const second = await publisher.inspectProcess(process.pid);
  assert.equal(first.processId, process.pid);
  assert.equal(first.alive, true);
  assert.ok(BigInt(first.birthFileTime) > 0n);
  assert.deepEqual(second, first);
  assert.equal(await publisher.inspectProcess(-1), null);
  assert.equal(await publisher.inspectProcess(2147483647), null);
});

test("cross-process contention records native birth and a stable lock owner hash without changing admission", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-holder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resource = path.join(root, "resource");
  const moduleUrl = new URL("../../../src/infrastructure/process/interprocess-lock.mjs", import.meta.url).href;
  const code = `import { withInterprocessLocks } from ${JSON.stringify(moduleUrl)};
    await withInterprocessLocks([process.argv[1]], async () => {
      process.stdout.write('ready\\n'); process.stdin.resume();
      await new Promise(resolve => process.stdin.once('end', resolve));
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, resource], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  t.after(async () => { child.stdin.end(); await closed; });
  await once(child.stdout, "data");
  const events = [];
  const result = await withTaskOperationTiming({ operationId: "native-waiter", taskId: "task",
    record: event => {
      events.push(event);
      if (event.stage === "lock-native-holder") child.stdin.end();
    } }, () => withInterprocessLocks([resource], async () => "admitted"));
  const [exitCode] = await closed;
  assert.equal(result, "admitted");
  assert.equal(exitCode, 0, stderr);
  const observed = events.find(event => event.stage === "lock-native-holder");
  assert.equal(observed.stable, true);
  assert.equal(observed.processId, child.pid);
  assert.equal(observed.native.processId, child.pid);
  assert.equal(observed.native.alive, true);
  assert.ok(BigInt(observed.native.birthFileTime) > 0n);
  assert.ok(/^[a-f0-9]{64}$/u.test(observed.ownerIdHash));
  assert.ok(!JSON.stringify(events).includes(resource));
});
