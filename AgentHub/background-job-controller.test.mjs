import assert from "node:assert/strict";
import test from "node:test";
import { PersistentBackgroundJobController } from "./background-job-controller.mjs";

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
  values() { return [...this.items.values()]; }
  get size() { return this.items.size; }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
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
  await waitFor(() => jobs.size === 0);
  assert.equal(store.items.has(item.id), true);
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
