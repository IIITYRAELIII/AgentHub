import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createTestResourceMonitor, parsePosixProcessAccounting } from "../../../src/infrastructure/process/test-resource-monitor.mjs";

test("POSIX accounting selects only the runner's family and includes cumulative child CPU", () => {
  const value = parsePosixProcessAccounting("10 1 0:01.50 100\n11 10 0:02.20 200\n12 11 0:00.25 300\n99 1 10:00.00 10000", 10);
  assert.deepEqual(value, { cpuMs: 3950, rssBytes: 600 * 1024, processes: 3 });
  assert.throws(() => parsePosixProcessAccounting("99 1 0:00.01 100", 10), /root is absent/u);
});

test("native accounting includes exited grandchildren CPU and live child resident memory, without kill/CPU/memory limits", {
  skip: process.platform !== "win32",
}, async () => {
  const monitor = await createTestResourceMonitor();
  let worker;
  let exit;
  try {
    const before = await monitor.sample();
    assert.equal(before.limitFlags, 0);
    worker = spawn(process.execPath, ["--input-type=module", "-e", `
      import {spawnSync} from 'node:child_process';
      spawnSync(process.execPath, ['-e', 'const end=performance.now()+180; while(performance.now()<end) Math.sqrt(Math.random())']);
      const bytes=Buffer.alloc(48*1024*1024,1);
      process.stdout.write('ready\\n');
      process.stdin.once('data',()=>{ process.stdout.write(String(bytes.length)); process.exit(0); });
    `], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    exit = once(worker, "close");
    await Promise.race([once(worker.stdout, "data"), exit.then(() => { throw new Error("Native accounting fixture exited before ready"); })]);
    const during = await monitor.sample();
    assert.ok(during.totalProcesses >= before.totalProcesses + 2, "grandchild remains in cumulative accounting after exit");
    assert.ok(during.cpuMs >= before.cpuMs + 100, "CPU survived grandchild exit between samples");
    assert.ok(during.rssBytes >= before.rssBytes + 32 * 1024 ** 2, "physical resident bytes, not just runner heap");
    await monitor.close();
    worker.stdin.end("finish\n");
    assert.deepEqual(await exit, [0, null], "closing accounting must not terminate active tests");
  } finally {
    if (worker && !worker.stdin.destroyed) worker.stdin.end("finish\n");
    if (exit) await exit;
    await monitor.close();
  }
});
