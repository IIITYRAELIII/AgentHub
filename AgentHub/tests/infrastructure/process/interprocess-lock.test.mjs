import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withInterprocessLocks } from "../../../src/infrastructure/process/interprocess-lock.mjs";

test("interprocess lock recovers a stale dead owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-stale-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await mkdir(lock);
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({
      token: "dead-owner",
      pid: 999_999,
      createdAt: Date.now(),
    }));
    let entered = false;
    await withInterprocessLocks([target], async () => { entered = true; }, {
      isProcessAlive: () => false,
      staleMs: 60_000,
    });
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent acquisitions do not enter the same lock together", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-concurrent-"));
  const target = path.join(root, "ledger.json");
  let active = 0;
  let maximum = 0;
  try {
    await Promise.all(Array.from({ length: 10 }, () => withInterprocessLocks([target], async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    }, { retryDelayMs: 1 })));
    assert.equal(maximum, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interprocess lock does not steal a live owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-live-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await mkdir(lock);
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({
      token: "live-owner",
      pid: 42,
      createdAt: 0,
    }));
    await assert.rejects(
      withInterprocessLocks([target], async () => {}, {
        isProcessAlive: () => true,
        timeoutMs: 25,
        retryDelayMs: 1,
        staleMs: 0,
      }),
      /Timed out waiting/u,
    );
    assert.equal(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).token, "live-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interprocess lock recovers a fresh ownerless directory before the main stale timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-ownerless-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await mkdir(lock);
    let entered = false;
    await withInterprocessLocks([target], async () => { entered = true; }, {
      timeoutMs: 250,
      retryDelayMs: 2,
      staleMs: 60_000,
      ownerlessStaleMs: 20,
    });
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old owner cannot remove a replacement lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-replacement-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    let releaseFirst;
    const first = withInterprocessLocks([target], () => new Promise((resolve) => { releaseFirst = resolve; }), {
      tokenFactory: () => "first-owner",
    });
    while (!releaseFirst) await new Promise((resolve) => setTimeout(resolve, 1));
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({
      token: "replacement-owner",
      pid: process.pid,
      createdAt: Date.now(),
    }));
    releaseFirst();
    await first;
    assert.equal(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).token, "replacement-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
