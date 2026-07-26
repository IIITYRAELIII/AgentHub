import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deliveryRetryDelay,
  PersistentDeliveryOutbox,
} from "./delivery-outbox.mjs";

test("deliveryRetryDelay uses bounded exponential backoff and Retry-After", () => {
  assert.equal(deliveryRetryDelay(1), 5_000);
  assert.equal(deliveryRetryDelay(3), 20_000);
  assert.equal(deliveryRetryDelay(1, 30_000), 30_000);
  assert.equal(deliveryRetryDelay(20), 300_000);
});

test("PersistentDeliveryOutbox persists and delivers queued messages in order", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-"));
  const outboxDirectory = path.join(directory, "outbox");
  const delivered = [];
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: outboxDirectory,
      deliver: async (method, body) => {
        delivered.push([method, body.text]);
        return { message_id: delivered.length };
      },
    });
    await outbox.load();
    await outbox.enqueue({ method: "sendMessage", body: { chat_id: 1, text: "one" } });
    await outbox.enqueue({ method: "sendMessage", body: { chat_id: 1, text: "two" } });
    const queuedFiles = await readdir(outboxDirectory);
    assert.equal(queuedFiles.length, 2);
    assert.equal(
      JSON.parse(await readFile(path.join(outboxDirectory, queuedFiles[0]), "utf8")).body.text,
      "one",
    );
    assert.deepEqual(await outbox.flush(), { delivered: 2, remaining: 0 });
    assert.deepEqual(delivered, [["sendMessage", "one"], ["sendMessage", "two"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PersistentDeliveryOutbox retains a temporary failure for a later retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-retry-"));
  const outboxDirectory = path.join(directory, "outbox");
  let now = 1_000;
  let attempts = 0;
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: outboxDirectory,
      now: () => now,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("temporary");
          error.retryable = true;
          error.retryAfterMs = 10_000;
          throw error;
        }
        return { message_id: 7 };
      },
    });
    await outbox.load();
    await outbox.enqueue({ method: "sendMessage", body: { chat_id: 1, text: "retry" } });
    assert.deepEqual(await outbox.flush(), { delivered: 0, remaining: 1 });
    now += 9_999;
    assert.deepEqual(await outbox.flush(), { delivered: 0, remaining: 1 });
    now += 1;
    assert.deepEqual(await outbox.flush(), { delivered: 1, remaining: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PersistentDeliveryOutbox discovers a message enqueued by another process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-shared-"));
  const outboxDirectory = path.join(directory, "outbox");
  const delivered = [];
  try {
    const producer = new PersistentDeliveryOutbox({
      directoryPath: outboxDirectory,
      deliver: async () => {},
    });
    const consumer = new PersistentDeliveryOutbox({
      directoryPath: outboxDirectory,
      deliver: async (_method, body) => {
        delivered.push(body.text);
        return { message_id: 1 };
      },
    });
    await consumer.load();
    await producer.enqueue({ method: "sendMessage", body: { chat_id: 1, text: "shared" } });
    assert.deepEqual(await consumer.flush(), { delivered: 1, remaining: 0 });
    assert.deepEqual(delivered, ["shared"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PersistentDeliveryOutbox keeps group sequence and supersedes stale progress", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-groups-"));
  const outboxDirectory = path.join(directory, "outbox");
  const delivered = [];
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: outboxDirectory,
      now: () => 1_000,
      deliver: async (_method, body) => {
        delivered.push(body.text);
        return { message_id: delivered.length };
      },
    });
    await outbox.enqueue({
      method: "sendMessage",
      body: { chat_id: 1, text: "old progress" },
      supersedeKey: "progress:task",
    });
    await outbox.enqueue({
      method: "sendMessage",
      body: { chat_id: 1, text: "new progress" },
      supersedeKey: "progress:task",
    });
    await outbox.enqueue({ method: "sendMessage", body: { chat_id: 1, text: "part 2" }, groupId: "final", sequence: 2 });
    await outbox.enqueue({ method: "sendMessage", body: { chat_id: 1, text: "part 1" }, groupId: "final", sequence: 1 });
    assert.equal(await outbox.discard({ supersedeKey: "progress:task" }), 1);
    await outbox.flush();
    assert.deepEqual(delivered, ["part 1", "part 2"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a delayed delivery does not block an unrelated ready message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-hol-"));
  let now = 1_000;
  let failFirst = true;
  const delivered = [];
  const outbox = new PersistentDeliveryOutbox({
    directoryPath: root,
    now: () => now,
    deliver: async (_method, body) => {
      if (body.text === "first" && failFirst) {
        failFirst = false;
        const error = new Error("retry later");
        error.retryable = true;
        throw error;
      }
      delivered.push(body.text);
      return {};
    },
  });
  await outbox.enqueue({ method: "sendMessage", body: { text: "first" } });
  await outbox.flush();
  await outbox.enqueue({ method: "sendMessage", body: { text: "second" } });
  await outbox.flush();
  assert.deepEqual(delivered, ["second"]);
  assert.equal(outbox.size, 1);
});

test("a delayed group preserves its own order without blocking another group", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-group-hol-"));
  let now = 1_000;
  const delivered = [];
  const outbox = new PersistentDeliveryOutbox({
    directoryPath: root,
    now: () => now,
    deliver: async (_method, body) => {
      if (body.text === "a1") {
        const error = new Error("retry later");
        error.retryable = true;
        throw error;
      }
      delivered.push(body.text);
      return {};
    },
  });
  await outbox.enqueue({ method: "sendMessage", body: { text: "a1" }, groupId: "a", sequence: 0 });
  await outbox.enqueue({ method: "sendMessage", body: { text: "a2" }, groupId: "a", sequence: 1 });
  await outbox.enqueue({ method: "sendMessage", body: { text: "b1" }, groupId: "b", sequence: 0 });
  await outbox.flush();
  assert.deepEqual(delivered, ["b1"]);
  assert.equal(outbox.size, 2);
});

test("a corrupt outbox record is quarantined without blocking valid delivery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-corrupt-"));
  await writeFile(path.join(root, "0000000000000-bad.json"), "{broken", "utf8");
  const delivered = [];
  const outbox = new PersistentDeliveryOutbox({
    directoryPath: root,
    deliver: async (_method, body) => {
      delivered.push(body.text);
      return {};
    },
  });
  await outbox.enqueue({ method: "sendMessage", body: { text: "valid" } });
  await outbox.flush();
  assert.deepEqual(delivered, ["valid"]);
  assert.equal((await readdir(root)).some((name) => name.includes(".invalid-")), true);
});

test("a permanently rejected delivery is retained for diagnosis", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-permanent-"));
  const outbox = new PersistentDeliveryOutbox({
    directoryPath: root,
    now: () => 3_000,
    deliver: async () => { throw new Error("bad request"); },
  });
  await outbox.enqueue({ method: "sendMessage", body: { text: "final answer" } });
  assert.deepEqual(await outbox.flush(), { delivered: 0, remaining: 0 });
  const names = await readdir(root);
  assert.equal(names.some((name) => name.includes(".json.failed-3000")), true);
  assert.match(await readFile(path.join(root, names[0]), "utf8"), /final answer/);
});
