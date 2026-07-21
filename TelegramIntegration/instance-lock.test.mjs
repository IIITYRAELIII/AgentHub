import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SingleInstanceGuard } from "./instance-lock.mjs";

test("single-instance guard rejects a concurrent owner and releases cleanly", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-lock-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = new SingleInstanceGuard({ dataDir });
  const second = new SingleInstanceGuard({ dataDir });
  await first.acquire();
  await assert.rejects(() => second.acquire(), /already running/);
  const lock = JSON.parse(await readFile(path.join(dataDir, "bot.lock"), "utf8"));
  assert.equal(lock.pid, process.pid);
  assert.ok(lock.instanceToken);
  await first.release();
  await second.acquire();
  await second.release();
});

test("legacy live PID is preserved during migration", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-legacy-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, "bot.lock"), "4242\n", "utf8");
  const guard = new SingleInstanceGuard({ dataDir, isAlive: (pid) => pid === 4242 });
  await assert.rejects(() => guard.acquire(), /PID 4242/);
  assert.equal(await readFile(path.join(dataDir, "bot.lock"), "utf8"), "4242\n");
});

test("new-format stale lock ignores a reused PID when the system channel is free", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-stale-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, "bot.lock"), JSON.stringify({
    pid: process.pid,
    instanceToken: "stale",
  }), "utf8");
  const guard = new SingleInstanceGuard({ dataDir, isAlive: () => true });
  await guard.acquire();
  const lock = JSON.parse(await readFile(path.join(dataDir, "bot.lock"), "utf8"));
  assert.notEqual(lock.instanceToken, "stale");
  await guard.release();
});
