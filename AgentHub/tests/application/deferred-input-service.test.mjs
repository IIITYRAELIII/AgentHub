import assert from "node:assert/strict";
import test from "node:test";

import { DeferredInputService } from "../../src/application/deferred-input-service.mjs";
import { DeferredInputStore } from "../../src/application/deferred-input-store.mjs";

test("deferred input service persists one addressed logical-task message", async () => {
  const store = new DeferredInputStore();
  const events = [];
  const service = new DeferredInputService({
    store,
    maxItems: 2,
    createId: () => "deferred-1",
    now: () => Date.parse("2026-08-05T10:00:00.000Z"),
    persist: async () => events.push("persist"),
    removeFiles: async () => events.push("remove"),
    notify: async (item) => {
      events.push(`notify:${item.streamId}`);
      return { message_id: 77 };
    },
  });
  const result = await service.defer("message", ["image.png"], {
    target: { streamId: "stream-1", provider: "codex", threadId: "thread-1", taskTitle: "Task" },
    persistentFiles: true,
  });

  assert.equal(result.item.id, "deferred-1");
  assert.equal(result.item.messageId, 77);
  assert.equal(store.pending.get("deferred-1"), result.item);
  assert.deepEqual(events, ["persist", "notify:stream-1", "persist"]);
});

test("deferred input service removes rejected attachments at its bounded capacity", async () => {
  const store = new DeferredInputStore();
  store.put({ id: "existing" });
  let removed = null;
  const service = new DeferredInputService({
    store,
    maxItems: 1,
    persist: async () => {},
    removeFiles: async (files) => { removed = files; },
    notify: async () => null,
  });

  await assert.rejects(
    service.defer("message", ["temporary.png"], { target: { provider: "claude" } }),
    /переполнена/u,
  );
  assert.deepEqual(removed, ["temporary.png"]);
});

test("deferred Desktop input is persisted without a Telegram prompt", async () => {
  const store = new DeferredInputStore();
  let notifications = 0;
  const service = new DeferredInputService({
    store,
    createId: () => "desktop-deferred",
    persist: async () => {},
    removeFiles: async () => {},
    notify: async () => { notifications += 1; },
  });

  const result = await service.defer("message", [], {
    target: {
      provider: "codex",
      threadId: "thread-1",
      telegramDeliveryRequested: false,
      clientSource: "desktop",
    },
  });

  assert.equal(result.item.telegramDeliveryRequested, false);
  assert.equal(result.item.clientSource, "desktop");
  assert.equal(result.item.messageId, undefined);
  assert.equal(notifications, 0);
});
