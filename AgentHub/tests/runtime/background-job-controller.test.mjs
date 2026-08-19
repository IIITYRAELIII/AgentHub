import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersistentBackgroundJobStore } from "../../src/infrastructure/persistence/background-job-store.mjs";
import { PersistentBackgroundJobController } from "../../src/runtime/background-job-controller.mjs";

class MemoryStore {
  constructor(items = []) {
    this.items = new Map(items.map((item) => [item.id, item]));
    this.sequence = items.length;
  }
  async load() { return this.size; }
  count(kind) { return this.values().filter((item) => item.kind === kind).length; }
  findByDedupeKey(key) { return key ? this.values().find((item) => item.dedupeKey === key) ?? null : null; }
  async enqueue({ kind, payload, dedupeKey }) {
    const item = { id: `job-${++this.sequence}`, kind, payload, dedupeKey, createdAt: new Date().toISOString() };
    this.items.set(item.id, item);
    return item;
  }
  async remove(id) { this.items.delete(id); }
  async recordFailure(id, update) {
    const current = this.items.get(id);
    if (!current) return null;
    const item = { ...current, ...update };
    this.items.set(id, item);
    return item;
  }
  values() { return [...this.items.values()]; }
  get size() { return this.items.size; }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function controller(overrides = {}) {
  return new PersistentBackgroundJobController({
    store: new MemoryStore(),
    maxMediaJobs: 2,
    maxSpeechJobs: 2,
    sendMessage: async () => {},
    media: {},
    forwardBundles: {},
    logger: { log() {}, warn() {}, error() {} },
    ...overrides,
  });
}

test("persistent background controller dispatches and acknowledges a speech job", async () => {
  const store = new MemoryStore();
  const calls = [];
  const jobs = controller({ store, media: { processSpeechRequest: async (...args) => calls.push(args) } });
  await jobs.enqueue("speech", { chatId: 7, text: "hello" }, 7);
  await waitFor(() => store.size === 0);
  assert.deepEqual(calls, [[7, "hello"]]);
  assert.equal(jobs.size, 0);
});

test("persistent background controller preserves interrupted work during shutdown", async () => {
  const store = new MemoryStore();
  const jobs = controller({ store, isStopping: () => true });
  const item = await jobs.enqueue("image", { message: {}, target: {} }, 7);
  await waitFor(() => jobs.mediaQueue.size === 0);
  assert.equal(store.items.has(item.id), true);
});

test("persistent background controller retries with bounded exponential backoff", async () => {
  const store = new MemoryStore();
  const timers = [];
  let now = 1_000;
  let attempts = 0;
  const jobs = controller({
    store,
    now: () => now,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 500,
    scheduleTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancelTimer: () => {},
    media: {
      processSpeechRequest: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`temporary-${attempts}`);
      },
    },
  });

  await jobs.enqueue("speech", { chatId: 7, text: "hello" }, 7);
  await waitFor(() => timers.length === 1);
  const firstRetry = timers.shift();
  assert.equal(firstRetry.delayMs, 100);
  assert.equal(store.values()[0].attempts, 1);

  now += firstRetry.delayMs;
  firstRetry.callback();
  await waitFor(() => timers.length === 1);
  const secondRetry = timers.shift();
  assert.equal(secondRetry.delayMs, 200);
  assert.equal(store.values()[0].attempts, 2);

  now += secondRetry.delayMs;
  secondRetry.callback();
  await waitFor(() => store.size === 0);
  assert.equal(attempts, 3);
  assert.equal(jobs.size, 0);
});

test("persistent background controller restores a failed retry after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-background-retry-"));
  try {
    let now = 10_000;
    let retryPersisted;
    const persisted = new Promise((resolve) => { retryPersisted = resolve; });
    const firstStore = new PersistentBackgroundJobStore({ directoryPath: root, now: () => now });
    const first = controller({
      store: firstStore,
      now: () => now,
      retryBaseDelayMs: 250,
      retryMaxDelayMs: 250,
      scheduleTimer: () => ({ unref() {} }),
      cancelTimer: () => {},
      logger: { log() {}, warn: retryPersisted, error() {} },
      media: { processSpeechRequest: async () => { throw new Error("temporary"); } },
    });
    await first.enqueue("speech", { chatId: 7, text: "hello" }, 7);
    await persisted;
    assert.equal(firstStore.values()[0]?.attempts, 1);

    now += 250;
    const restoredStore = new PersistentBackgroundJobStore({ directoryPath: root, now: () => now });
    const calls = [];
    const restored = controller({
      store: restoredStore,
      now: () => now,
      retryBaseDelayMs: 250,
      retryMaxDelayMs: 250,
      media: { processSpeechRequest: async (...args) => calls.push(args) },
    });
    assert.deepEqual(await restored.restore(), { restored: 1, total: 1 });
    await waitFor(() => restoredStore.size === 0);
    assert.deepEqual(calls, [[7, "hello"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent background controller reports only a terminal job failure", async () => {
  const store = new MemoryStore();
  const captured = [];
  const jobs = controller({
    store,
    maxAttempts: 1,
    media: { processSpeechRequest: async () => { throw new Error("speech failed"); } },
    captureException: (error, context) => captured.push([error.message, context.action]),
  });
  await jobs.enqueue("speech", { chatId: 7, text: "hello" }, 7);
  await waitFor(() => store.size === 0);
  assert.deepEqual(captured, [["speech failed", "terminal:speech"]]);
});

test("persistent background controller dispatches restored overflow once a queue slot opens", async () => {
  const store = new MemoryStore([
    { id: "first", kind: "speech", payload: { chatId: 7, text: "first" }, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "second", kind: "speech", payload: { chatId: 7, text: "second" }, createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "third", kind: "speech", payload: { chatId: 7, text: "third" }, createdAt: "2026-01-01T00:00:02.000Z" },
  ]);
  const first = deferred();
  const calls = [];
  const jobs = controller({
    store,
    media: {
      processSpeechRequest: async (_chatId, text) => {
        calls.push(text);
        if (text === "first") await first.promise;
      },
    },
  });

  assert.deepEqual(await jobs.restore(), { restored: 2, total: 3 });
  await waitFor(() => calls.length === 1);
  assert.equal(jobs.size, 3);

  first.resolve();
  await waitFor(() => store.size === 0);
  assert.deepEqual(calls, ["first", "second", "third"]);
});

test("persistent background controller enforces separate durable limits", async () => {
  const existing = [
    { id: "a", kind: "image", payload: {}, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "b", kind: "voice", payload: {}, createdAt: "2026-01-01T00:00:01.000Z" },
  ];
  const notices = [];
  const jobs = controller({ store: new MemoryStore(existing), sendMessage: async (...args) => notices.push(args) });
  assert.equal(await jobs.enqueue("image", {}, 9), null);
  assert.deepEqual(notices, [[9, "Очередь медиа переполнена (2). Отправьте файл позже."]]);
});

test("persistent background controller restores forwarded images once", async () => {
  const store = new MemoryStore();
  const completed = [];
  const jobs = controller({
    store,
    media: { captureImage: async () => "C:/image.jpg" },
    forwardBundles: {
      pendingImageJobs: () => [{ bundleId: "bundle", chatId: 5, messageId: 6, dedupeKey: "image:6" }],
      imageDescriptor: () => ({ fileId: "telegram-file" }),
      completeImage: async (...args) => completed.push(args),
      failImage: async () => assert.fail("image should not fail"),
    },
  });
  await jobs.restore();
  await waitFor(() => store.size === 0);
  assert.deepEqual(completed, [["bundle", 6, "C:/image.jpg"]]);
});
