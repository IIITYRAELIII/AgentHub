import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createTestResourceMonitor, parsePosixProcessAccounting } from "../../../src/infrastructure/process/test-resource-monitor.mjs";

test("POSIX accounting selects only the runner's family and includes cumulative child CPU", () => {
  const value = parsePosixProcessAccounting("10 1 0:01.50 100\n11 10 0:02.20 200\n12 11 0:00.25 300\n99 1 10:00.00 10000", 10);
  assert.deepEqual(value, { cpuMs: 3950, rssBytes: 600 * 1024, processes: 3 });
  assert.throws(() => parsePosixProcessAccounting("99 1 0:00.01 100", 10), /root is absent/u);
});

test("native job caps CPU and retains exited grandchildren accounting without kill or memory limits", {
  skip: process.platform !== "win32",
}, async () => {
  const monitor = await createTestResourceMonitor();
  let worker;
  let exit;
  try {
    const before = await monitor.sample();
    assert.equal(before.limitFlags, 0);
    assert.equal(before.cpuControlFlags, 5);
    assert.equal(before.cpuRate, 4000);
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

test("CPU budget rejects disabling or increasing the established ceiling before setup", async () => {
  for (const cpuBudget of [0, -0.1, 0.5, NaN, Infinity]) {
    await assert.rejects(createTestResourceMonitor({ cpuBudget }), RangeError);
  }
});

test("Windows CPU quota applies to one owned low-load child and clears without killing it", {
  skip: process.platform !== "win32",
}, async (t) => {
  const monitor = await createTestResourceMonitor({ cpuBudget: 0.02 });
  let child;
  let closed;
  try {
    const settings = await monitor.sample();
    assert.equal(settings.cpuControlFlags, 5);
    assert.equal(settings.cpuRate, 200);
    assert.equal(settings.limitFlags, 0);
    child = spawn(process.execPath, ["-e", `
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => {
        const before=process.cpuUsage();
        while (true) {
          const used=process.cpuUsage(before);
          if (used.user+used.system>=100000) break;
        }
        process.stdout.write('done\\n');
        process.stdin.once('data', () => process.exit(0));
      });
    `], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
    closed = once(child, "close");
    await Promise.race([once(child.stdout, "data"), closed.then(() => { throw new Error("Quota fixture exited before ready"); })]);
    await monitor.sample();
    const done = once(child.stdout, "data");
    child.stdin.write("go\n");
    await Promise.race([done, closed.then(() => { throw new Error("Quota fixture exited during work"); })]);
    const measured = await monitor.sample();
    t.diagnostic(JSON.stringify({ settings, measured }));
    assert.ok(measured.totalProcesses >= settings.totalProcesses + 1, "owned child inherits the CPU-controlled Job");
    assert.ok(measured.cpuMs > settings.cpuMs);
    // CPU control is a cycle quota over Windows scheduling intervals. A short
    // elapsed-CPU sample (including the helper and accounting tick granularity)
    // is not an instantaneous percentage assertion. Verify actual Job state,
    // child membership, completed work and the owned close boundary instead.
    assert.equal(measured.cpuControlFlags, 5);
    assert.equal(measured.cpuRate, 200);
    await monitor.close();
    child.stdin.end("finish\n");
    assert.deepEqual(await closed, [0, null]);
  } finally {
    if (child && !child.stdin.destroyed) child.stdin.end("finish\n");
    if (closed) await closed;
    await monitor.close();
  }
});

for (const exitCode of [0, 1]) {
  test(`native CPU cleanup protocol preserves close outcome ${exitCode}`, {
    skip: process.platform !== "win32",
  }, async (t) => {
    const originalSpawn = childProcess.spawn;
    const commands = [];
    childProcess.spawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const sample = () => child.stdout.write(`${JSON.stringify({ cpuMs: 10,
        rssBytes: 1024, processes: 2, totalProcesses: 2, limitFlags: 0,
        cpuControlFlags: 5, cpuRate: 4000 })}\n`);
      child.stdin = new Writable({ write(data, encoding, callback) {
        const command = data.toString().trim();
        commands.push(command);
        queueMicrotask(() => {
          if (command === "sample") sample();
          else if (command === "close") {
            if (exitCode) child.stderr.write("CPU control clear/readback failed");
            child.stdout.end(); child.stderr.end(); child.emit("close", exitCode, null);
          }
        });
        callback();
      } });
      queueMicrotask(sample);
      return child;
    };
    syncBuiltinESMExports();
    t.after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
    const monitor = await createTestResourceMonitor();
    await monitor.sample();
    if (exitCode) {
      let original;
      await assert.rejects(monitor.close(), (error) => {
        original = error;
        assert.match(error.message, /CPU control clear\/readback failed/);
        return true;
      });
      await assert.rejects(monitor.close(), (error) => error === original);
    } else {
      await monitor.close();
      await monitor.close();
    }
    assert.equal(commands.filter(command => command === "close").length, 1);
  });
}
