import assert from "node:assert/strict";
import test from "node:test";

import {
  DeferredInputStore,
  deferredInputTaskKey,
} from "./src/application/deferred-input-store.mjs";

test("deferred input store owns pending and queued state by logical task", () => {
  const store = new DeferredInputStore();
  const first = {
    id: "one", hubTaskId: "hub-1", provider: "codex", threadId: "old", createdAt: "2026-08-05T08:00:00.000Z",
  };
  const second = {
    id: "two", hubTaskId: "hub-1", provider: "codex", threadId: "new", createdAt: "2026-08-05T09:00:00.000Z",
  };
  store.put(first, "pending");
  store.put(second, "queued");

  assert.equal(store.size, 2);
  assert.equal(store.hasBacklog({ hubTaskId: "hub-1", threadId: "another" }), true);
  assert.equal(store.latestActivityAt({ hubTaskId: "hub-1" }), Date.parse(second.createdAt));
  assert.deepEqual(store.snapshot(), { pending: [first], queued: [second] });
});

test("moving an item keeps exactly one deferred-input owner", () => {
  const store = new DeferredInputStore();
  const item = { id: "same", provider: "claude", projectRoot: "D:/Work", threadId: "session" };
  store.put(item, "pending");
  store.put(item, "queued");

  assert.equal(store.pending.size, 0);
  assert.equal(store.queued.size, 1);
  assert.equal(deferredInputTaskKey(item), "provider:claude:d:/work:session");
});
