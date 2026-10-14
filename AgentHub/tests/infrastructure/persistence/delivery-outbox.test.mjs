import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deliveryRetryDelay,
  PersistentDeliveryOutbox,
} from "../../../src/infrastructure/persistence/delivery-outbox.mjs";

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

test("terminal channel intent materializes idempotently and becomes uncertain before delivery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-intent-"));
  const states = [];
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: directory,
      onUncertain: async (item) => states.push(["uncertain", item.intent.id]),
      onDelivered: async (item) => states.push(["acked", item.intent.id]),
      deliver: async () => ({ message_id: 7 }),
    });
    const intent = { id: "terminal-1", terminalRevision: 1, final: true };
    const first = await outbox.enqueue({
      method: "sendMessage",
      body: { chat_id: 7, text: "Final" },
      intentKey: "terminal-1:0",
      intent,
    });
    const duplicate = await outbox.enqueue({
      method: "sendMessage",
      body: { chat_id: 7, text: "Final" },
      intentKey: "terminal-1:0",
      intent,
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(outbox.size, 1);

    await outbox.flush();
    assert.deepEqual(states, [["uncertain", "terminal-1"], ["acked", "terminal-1"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a newer terminal revision supersedes every queued chunk of the older revision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-revision-"));
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: directory,
      deliver: async () => ({ message_id: 7 }),
    });
    const supersedeKey = "codex\0thread-1\0turn-1\0telegram";
    for (const sequence of [0, 1]) {
      await outbox.enqueue({
        method: "sendMessage",
        body: { chat_id: 7, text: `old-${sequence}` },
        groupId: "terminal-revision-1",
        sequence,
        supersedeKey,
        intentKey: `terminal-revision-1:${sequence}`,
        intent: { terminalRevision: 1, sequence, final: sequence === 1 },
      });
    }
    assert.equal(outbox.size, 2);

    await outbox.enqueue({
      method: "sendMessage",
      body: { chat_id: 7, text: "new" },
      groupId: "terminal-revision-2",
      sequence: 0,
      supersedeKey,
      intentKey: "terminal-revision-2:0",
      intent: { terminalRevision: 2, sequence: 0, final: true },
    });
    assert.equal(outbox.size, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an uncertain superseded Telegram file is retained as evidence but never resent after reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-superseded-"));
  let sends = 0;
  try {
    const first = new PersistentDeliveryOutbox({
      directoryPath: directory,
      deliver: async () => {
        sends += 1;
        const error = new Error("unknown external outcome");
        error.retryable = true;
        error.uncertain = true;
        throw error;
      },
      retryDelay: () => 0,
    });
    await first.enqueue({ method: "sendMessage", body: { text: "wrong old answer" },
      supersedeKey: "turn-1:telegram", intent: { terminalRevision: 1 } });
    await first.flush();
    assert.equal(sends, 1);
    await first.discard({ supersedeKey: "turn-1:telegram" });
    const [name] = (await readdir(directory)).filter((entry) => entry.endsWith(".json"));
    assert.equal(JSON.parse(await readFile(path.join(directory, name), "utf8")).discardRequested, true);

    const reopened = new PersistentDeliveryOutbox({ directoryPath: directory,
      deliver: async () => { sends += 1; return {}; } });
    assert.deepEqual(await reopened.flush(), { delivered: 0, remaining: 0 });
    assert.equal(sends, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale terminal revision is denied by the delivery authorization before Telegram", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-stale-terminal-"));
  let sends = 0;
  try {
    const first = new PersistentDeliveryOutbox({ directoryPath: directory,
      deliver: async () => { sends += 1; return {}; },
      onUncertain: async (item) => item.intent.terminalRevision === 2 });
    await first.enqueue({ method: "sendMessage", body: { text: "wrong old answer" },
      intent: { terminalRevision: 1 } });
    assert.deepEqual(await first.flush(), { delivered: 0, remaining: 0 });
    assert.equal(sends, 0);
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

test("delivery outbox serializes concurrent supersede and capacity checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-race-"));
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: root,
      maxItems: 1,
      deliver: async () => ({}),
    });
    const results = await Promise.allSettled([
      outbox.enqueue({ method: "sendMessage", body: { text: "first" }, supersedeKey: "progress:race" }),
      outbox.enqueue({ method: "sendMessage", body: { text: "second" }, supersedeKey: "progress:race" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    assert.equal(outbox.size, 1);
    const [entry] = await readdir(root);
    assert.equal(JSON.parse(await readFile(path.join(root, entry), "utf8")).body.text, "second");

    const limited = new PersistentDeliveryOutbox({
      directoryPath: path.join(root, "limited"),
      maxItems: 1,
      deliver: async () => ({}),
    });
    const limitedResults = await Promise.allSettled([
      limited.enqueue({ method: "sendMessage", body: { text: "one" } }),
      limited.enqueue({ method: "sendMessage", body: { text: "two" } }),
    ]);
    assert.equal(limitedResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(limitedResults.filter((result) => result.status === "rejected").length, 1);
    assert.equal(limited.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery outbox accepts a new item while a network delivery is pending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-flush-network-"));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: root,
      deliver: async () => blocked,
    });
    await outbox.enqueue({ method: "sendMessage", body: { text: "first" } });
    const flushing = outbox.flush();
    await new Promise((resolve) => setImmediate(resolve));
    const enqueued = await Promise.race([
      outbox.enqueue({ method: "sendMessage", body: { text: "second" } }).then(() => true),
      // Full-suite CPU contention on Windows can delay an otherwise
      // non-blocking filesystem write well beyond one scheduler quantum.
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assert.equal(enqueued, true);
    release({});
    await flushing;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery outbox skips an entry superseded during an earlier network delivery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-supersede-flush-"));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const delivered = [];
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: root,
      deliver: async (_method, body) => {
        delivered.push(body.text);
        if (body.text === "first") await blocked;
        return {};
      },
    });
    await outbox.enqueue({ method: "sendMessage", body: { text: "first" } });
    await outbox.enqueue({
      method: "sendMessage",
      body: { text: "old progress" },
      supersedeKey: "progress:task",
    });
    const flushing = outbox.flush();
    await new Promise((resolve) => setImmediate(resolve));
    await outbox.enqueue({
      method: "sendMessage",
      body: { text: "new progress" },
      supersedeKey: "progress:task",
    });
    release();
    await flushing;
    assert.deepEqual(delivered, ["first"]);
    assert.equal(outbox.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery outbox waitForIdle waits for delivery and its acknowledgement callback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-idle-"));
  let releaseDelivery;
  let releaseAcknowledgement;
  let idleResolved = false;
  let markDeliveryStarted;
  const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve; });
  let markAcknowledgementStarted;
  const acknowledgementStarted = new Promise((resolve) => { markAcknowledgementStarted = resolve; });
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: root,
      deliver: () => {
        markDeliveryStarted();
        return new Promise((resolve) => { releaseDelivery = resolve; });
      },
      onDelivered: () => {
        markAcknowledgementStarted();
        return new Promise((resolve) => { releaseAcknowledgement = resolve; });
      },
    });
    await outbox.enqueue({ method: "sendMessage", body: { text: "pending" } });
    void outbox.flush();
    const idle = outbox.waitForIdle().then(() => { idleResolved = true; });
    await deliveryStarted;
    assert.equal(idleResolved, false);
    releaseDelivery({ message_id: 1 });
    await acknowledgementStarted;
    assert.equal(idleResolved, false);
    releaseAcknowledgement();
    await idle;
    assert.equal((await readdir(root)).filter((name) => name.endsWith(".json")).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery outbox resumes local acknowledgement without repeating confirmed delivery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-pending-ack-"));
  let deliveries = 0;
  try {
    const interrupted = new PersistentDeliveryOutbox({
      directoryPath: root,
      deliver: async () => {
        deliveries += 1;
        return { message_id: 41 };
      },
      onDelivered: async () => {
        throw new Error("simulated crash before local acknowledgement");
      },
    });
    await interrupted.enqueue({ method: "sendMessage", body: { text: "once" } });
    await assert.rejects(interrupted.flush(), /simulated crash/);
    const [pendingAckFile] = (await readdir(root)).filter((name) => name.endsWith(".json"));
    const pendingAck = JSON.parse(await readFile(path.join(root, pendingAckFile), "utf8"));
    assert.equal(pendingAck.state, "delivered-pending-ack");
    assert.deepEqual(pendingAck.deliveryResult, { message_id: 41 });

    const acknowledged = [];
    const resumed = new PersistentDeliveryOutbox({
      directoryPath: root,
      deliver: async () => {
        deliveries += 1;
        return { message_id: 42 };
      },
      onDelivered: async (item, result) => acknowledged.push([item.body.text, result.message_id]),
    });
    await resumed.load();
    assert.deepEqual(await resumed.flush(), { delivered: 0, remaining: 0 });
    assert.equal(deliveries, 1);
    assert.deepEqual(acknowledged, [["once", 41]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery outbox detects an interrupted uncertain delivery and retries at least once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-uncertain-"));
  let now = 10_000;
  try {
    const producer = new PersistentDeliveryOutbox({
      directoryPath: root,
      now: () => now,
      deliver: async () => ({}),
    });
    const queued = await producer.enqueue({ method: "sendMessage", body: { text: "uncertain" } });
    const [fileName] = (await readdir(root)).filter((name) => name.endsWith(".json"));
    const filePath = path.join(root, fileName);
    const interrupted = JSON.parse(await readFile(filePath, "utf8"));
    interrupted.state = "delivering";
    interrupted.deliveryAttemptId = "attempt-before-crash";
    interrupted.deliveryStartedAt = new Date(now).toISOString();
    await writeFile(filePath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    const attempts = [];
    const resumed = new PersistentDeliveryOutbox({
      directoryPath: root,
      now: () => now,
      retryDelay: () => 5_000,
      deliver: async (_method, body, context) => {
        attempts.push([body.text, context]);
        return { message_id: 51 };
      },
    });
    await resumed.load();
    assert.equal(resumed.uncertainSize, 1);
    const recovered = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(recovered.state, "pending");
    assert.equal(recovered.uncertain, true);
    assert.equal(recovered.uncertainAttempts, 1);
    assert.match(recovered.lastError, /outcome is uncertain/);
    assert.deepEqual(await resumed.flush(), { delivered: 0, remaining: 1 });

    now += 5_000;
    assert.deepEqual(await resumed.flush(), { delivered: 1, remaining: 0 });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0][0], "uncertain");
    assert.equal(attempts[0][1].deliveryId, queued.id);
    assert.equal(attempts[0][1].idempotencyKey, queued.id);
    assert.equal(attempts[0][1].uncertain, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery outbox keeps confirmed delivery when durable removal fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-remove-failure-"));
  let deliveries = 0;
  let acknowledgements = 0;
  let failRemoval = true;
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: root,
      deliver: async () => {
        deliveries += 1;
        return { message_id: 61 };
      },
      onDelivered: async () => {
        acknowledgements += 1;
      },
      removeFile: async (filePath) => {
        if (failRemoval) throw new Error("simulated unlink failure");
        await rm(filePath);
      },
    });
    await outbox.enqueue({ method: "sendMessage", body: { text: "retained" } });
    await assert.rejects(outbox.flush(), /simulated unlink failure/);
    const [retainedFile] = (await readdir(root)).filter((name) => name.endsWith(".json"));
    assert.equal(
      JSON.parse(await readFile(path.join(root, retainedFile), "utf8")).state,
      "delivered-pending-ack",
    );

    failRemoval = false;
    assert.deepEqual(await outbox.flush(), { delivered: 0, remaining: 0 });
    assert.equal(deliveries, 1);
    assert.equal(acknowledgements, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery outbox retains an in-flight superseded item until it is acknowledged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-inflight-supersede-"));
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const delivered = [];
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: root,
      deliver: async (_method, body) => {
        delivered.push(body.text);
        if (body.text === "old") {
          markFirstStarted();
          await firstPending;
        }
        return { message_id: delivered.length };
      },
    });
    await outbox.enqueue({
      method: "sendMessage",
      body: { text: "old" },
      supersedeKey: "progress:inflight",
    });
    const flushing = outbox.flush();
    await firstStarted;
    await outbox.enqueue({
      method: "sendMessage",
      body: { text: "new" },
      supersedeKey: "progress:inflight",
    });
    assert.equal(outbox.size, 2);
    releaseFirst();
    await flushing;
    assert.equal(outbox.size, 1);
    await outbox.flush();
    assert.deepEqual(delivered, ["old", "new"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery outbox waitForIdle can flush persisted ready deliveries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-drain-"));
  const delivered = [];
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: root,
      deliver: async (_method, body) => delivered.push(body.text),
    });
    await outbox.enqueue({ method: "sendMessage", body: { text: "drain" } });
    await outbox.waitForIdle({ flush: true });
    assert.deepEqual(delivered, ["drain"]);
    assert.equal(outbox.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery outbox drain does not wait for a delayed retry window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-outbox-delayed-drain-"));
  try {
    const outbox = new PersistentDeliveryOutbox({
      directoryPath: root,
      deliver: async () => {
        const error = new Error("retry later");
        error.retryable = true;
        throw error;
      },
    });
    await outbox.enqueue({ method: "sendMessage", body: { text: "later" } });
    await outbox.waitForIdle({ flush: true });
    assert.equal(outbox.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
