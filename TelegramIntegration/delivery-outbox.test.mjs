import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
