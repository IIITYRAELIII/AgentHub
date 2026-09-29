import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskDiffStore } from "../../../src/infrastructure/persistence/task-diff-store.mjs";

test("task diffs survive restart and evict the oldest entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-task-diff-store-"));
  const filePath = path.join(root, "task-diffs.json");
  try {
    const first = new TaskDiffStore({ filePath, limit: 2 });
    await first.load();
    await first.set("one", "diff 1");
    await first.set("two", "diff 2");
    await first.set("three", "diff 3");

    const restored = new TaskDiffStore({ filePath, limit: 2 });
    await restored.load();
    assert.equal(restored.get("one"), undefined);
    assert.equal(restored.get("two"), "diff 2");
    assert.equal(restored.get("three"), "diff 3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt optional diff cache does not prevent startup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-task-diff-store-corrupt-"));
  const filePath = path.join(root, "task-diffs.json");
  try {
    await writeFile(filePath, "{broken", "utf8");
    const store = new TaskDiffStore({ filePath });
    await store.load();
    assert.equal(store.get("missing"), undefined);
    store.remember("live", "temporary");
    assert.equal(store.get("live"), "temporary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged recent task diff shares its existing durable write", async () => {
  const writes = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = new TaskDiffStore({
    filePath: "task-diffs.json",
    write: async (_filePath, content) => {
      writes.push(content);
      await gate;
    },
  });

  const first = store.set("thread", "");
  const repeated = store.set("thread", "");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  release();
  await Promise.all([first, repeated]);
  assert.equal(writes.length, 1);
});

test("failed task diff write remains retryable with the same content", async () => {
  let attempts = 0;
  const store = new TaskDiffStore({
    filePath: "task-diffs.json",
    write: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk unavailable");
    },
  });

  await assert.rejects(store.set("thread", "diff"), /disk unavailable/u);
  await store.set("thread", "diff");
  assert.equal(attempts, 2);
});

test("unchanged older task diff still persists its refreshed eviction order", async () => {
  const writes = [];
  const store = new TaskDiffStore({
    filePath: "task-diffs.json",
    limit: 2,
    write: async (_filePath, content) => writes.push(JSON.parse(content)),
  });
  await store.set("one", "diff 1");
  await store.set("two", "diff 2");
  writes.length = 0;

  await store.set("one", "diff 1");

  assert.deepEqual(writes, [[["two", "diff 2"], ["one", "diff 1"]]]);
});

test("an in-memory task diff update is persisted by the later durable set", async () => {
  const writes = [];
  const store = new TaskDiffStore({
    filePath: "task-diffs.json",
    write: async (_filePath, content) => writes.push(JSON.parse(content)),
  });

  store.remember("thread", "live diff");
  await store.set("thread", "live diff");

  assert.deepEqual(writes, [[["thread", "live diff"]]]);
});

test("different task diff values resolve only after their own durable write", async () => {
  const writes = [];
  const releases = [];
  const store = new TaskDiffStore({
    filePath: "task-diffs.json",
    write: (_filePath, content) => {
      writes.push(JSON.parse(content));
      return new Promise((resolve) => releases.push(resolve));
    },
  });

  let firstResolved = false;
  let secondResolved = false;
  const first = store.set("thread", "diff 1").then(() => { firstResolved = true; });
  const second = store.set("thread", "diff 2").then(() => { secondResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [[["thread", "diff 1"]]]);
  assert.equal(firstResolved, false);
  assert.equal(secondResolved, false);

  releases.shift()();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstResolved, true);
  assert.equal(secondResolved, false);
  assert.deepEqual(writes, [
    [["thread", "diff 1"]],
    [["thread", "diff 2"]],
  ]);

  releases.shift()();
  await second;
  assert.equal(secondResolved, true);
});

test("a later task diff value persists after an earlier queued write fails", async () => {
  const writes = [];
  let rejectFirst;
  const firstGate = new Promise((_resolve, reject) => { rejectFirst = reject; });
  const store = new TaskDiffStore({
    filePath: "task-diffs.json",
    write: async (_filePath, content) => {
      writes.push(JSON.parse(content));
      if (writes.length === 1) await firstGate;
    },
  });

  const first = store.set("thread", "diff 1").then(
    () => ({ status: "fulfilled" }),
    (error) => ({ status: "rejected", error }),
  );
  const second = store.set("thread", "diff 2");
  await new Promise((resolve) => setImmediate(resolve));
  rejectFirst(new Error("disk unavailable"));

  const firstResult = await first;
  await second;
  assert.equal(firstResult.status, "rejected");
  assert.match(firstResult.error.message, /disk unavailable/u);
  assert.deepEqual(writes, [
    [["thread", "diff 1"]],
    [["thread", "diff 2"]],
  ]);
});
