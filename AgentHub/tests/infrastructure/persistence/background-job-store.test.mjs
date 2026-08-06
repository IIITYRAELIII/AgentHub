import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersistentBackgroundJobStore } from "../../../src/infrastructure/persistence/background-job-store.mjs";

test("background jobs survive a new store instance and retain order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-background-jobs-"));
  try {
    let now = 1_000;
    const first = new PersistentBackgroundJobStore({ directoryPath: root, now: () => now++ });
    const image = await first.enqueue({ kind: "image", payload: { caption: "one" } });
    const voice = await first.enqueue({ kind: "voice", payload: { fileId: "two" } });

    const restored = new PersistentBackgroundJobStore({ directoryPath: root });
    assert.equal(await restored.load(), 2);
    assert.deepEqual(restored.values().map((item) => item.id), [image.id, voice.id]);
    assert.equal(restored.count("image"), 1);
    assert.equal(restored.count("speech"), 0);

    await restored.remove(image.id);
    const remaining = (await readdir(root)).filter((name) => name.endsWith(".json"));
    assert.equal(remaining.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(root, remaining[0]), "utf8")).id, voice.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("background job store enforces its limit and isolates corrupt records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-background-jobs-"));
  try {
    await writeFile(path.join(root, "broken.json"), "not-json", "utf8");
    const store = new PersistentBackgroundJobStore({ directoryPath: root, maxItems: 1, now: () => 2_000 });
    assert.equal(await store.load(), 0);
    assert.equal((await readdir(root)).some((name) => name.startsWith("broken.json.invalid-")), true);
    await store.enqueue({ kind: "speech", payload: { text: "hello" } });
    await assert.rejects(
      () => store.enqueue({ kind: "image", payload: {} }),
      (error) => error?.code === "QUEUE_FULL",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("background job store deduplicates a replayed Telegram update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-background-jobs-"));
  try {
    const first = new PersistentBackgroundJobStore({ directoryPath: root, now: () => 3_000 });
    const original = await first.enqueue({
      kind: "speech",
      payload: { text: "hello" },
      dedupeKey: "callback:42",
    });
    const restored = new PersistentBackgroundJobStore({ directoryPath: root, now: () => 4_000 });
    const replay = await restored.enqueue({
      kind: "speech",
      payload: { text: "hello" },
      dedupeKey: "callback:42",
    });
    assert.equal(replay.id, original.id);
    assert.equal(restored.size, 1);
    assert.equal((await readdir(root)).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("background job store serializes concurrent dedupe and capacity checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-background-jobs-race-"));
  try {
    const deduplicated = new PersistentBackgroundJobStore({ directoryPath: root, maxItems: 2 });
    const sameUpdate = await Promise.all(Array.from({ length: 8 }, () => deduplicated.enqueue({
      kind: "speech",
      payload: { text: "hello" },
      dedupeKey: "callback:race",
    })));
    assert.equal(new Set(sameUpdate.map((item) => item.id)).size, 1);
    assert.equal(deduplicated.size, 1);

    const limited = new PersistentBackgroundJobStore({
      directoryPath: path.join(root, "limited"),
      maxItems: 1,
    });
    const results = await Promise.allSettled([
      limited.enqueue({ kind: "image", payload: { fileId: "one" } }),
      limited.enqueue({ kind: "image", payload: { fileId: "two" } }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(results.find((result) => result.status === "rejected")?.reason.code, "QUEUE_FULL");
    assert.equal(limited.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
