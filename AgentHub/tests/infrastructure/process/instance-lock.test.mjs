import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  instanceLockEndpoint,
  readInstanceLockOwner,
  SingleInstanceGuard,
} from "../../../src/infrastructure/process/instance-lock.mjs";

test("single-instance guard rejects a concurrent owner and releases cleanly", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-lock-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = new SingleInstanceGuard({ dataDir, releaseId: "release-1" });
  const second = new SingleInstanceGuard({ dataDir });
  await first.acquire();
  await assert.rejects(() => second.acquire(), /already running/);
  const lock = JSON.parse(await readFile(path.join(dataDir, "bot.lock"), "utf8"));
  assert.equal(lock.pid, process.pid);
  assert.ok(lock.instanceToken);
  assert.equal(lock.releaseId, "release-1");
  assert.equal(lock.ready, false);
  assert.equal(await readInstanceLockOwner(dataDir), lock.instanceToken);
  await first.markReady();
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "bot.lock"), "utf8")).ready, true);
  await first.release();
  assert.equal(await readInstanceLockOwner(dataDir), null);
  await second.acquire();
  await second.release();
});

test("a reader that closes before the token write cannot stop the instance owner", { timeout: 5_000 }, async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-lock-early-close-"));
  const endpoint = instanceLockEndpoint(dataDir);
  const guard = new SingleInstanceGuard({ dataDir, releaseId: "release-owner" });
  context.after(async () => {
    await guard.release();
    await rm(dataDir, { recursive: true, force: true });
  });
  await guard.acquire();

  await new Promise((resolve) => {
    const reader = connect(endpoint);
    reader.once("connect", () => {
      try {
        if (typeof reader.resetAndDestroy === "function") reader.resetAndDestroy();
        else reader.destroy();
      } catch {
        reader.destroy();
      }
    });
    reader.once("error", resolve);
    reader.once("close", resolve);
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await readInstanceLockOwner(dataDir), guard.instanceToken);
  const duplicate = new SingleInstanceGuard({ dataDir });
  await assert.rejects(() => duplicate.acquire(), /already running/);
});

test("instance owner read has an absolute deadline when a channel stays silent", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-lock-silent-"));
  const endpoint = instanceLockEndpoint(dataDir);
  const server = createServer(() => {});
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    if (!endpoint.startsWith("\0") && !endpoint.startsWith("\\\\.\\pipe\\")) {
      await rm(endpoint, { force: true });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });

  await assert.rejects(
    readInstanceLockOwner(dataDir, { timeoutMs: 50 }),
    /Timed out reading Agent Hub instance identity/u,
  );
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
