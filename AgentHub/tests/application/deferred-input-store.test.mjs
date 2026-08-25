import assert from "node:assert/strict";
import test from "node:test";

import {
  DeferredInputStore,
  deferredInputTaskKey,
} from "../../src/application/deferred-input-store.mjs";
import { taskOccupancyIdentity } from "../../src/domain/task-runs.mjs";

test("deferred input store scopes backlog to the exact Thread lane", () => {
  const store = new DeferredInputStore();
  const first = {
    id: "one", streamId: "stream-1", provider: "codex", threadId: "old", createdAt: "2026-08-05T08:00:00.000Z",
  };
  const second = {
    id: "two", streamId: "stream-1", provider: "codex", threadId: "new", createdAt: "2026-08-05T09:00:00.000Z",
  };
  store.put(first, "pending");
  store.put(second, "queued");

  assert.equal(store.size, 2);
  assert.equal(store.hasBacklog({
    streamId: "stream-1", provider: "codex", threadId: "another",
  }), false);
  assert.equal(store.hasBacklog(first), true);
  assert.equal(store.latestActivityAt(second), Date.parse(second.createdAt));
  assert.deepEqual(store.snapshot(), { pending: [first], queued: [second] });
});

test("moving an item keeps exactly one deferred-input owner", () => {
  const store = new DeferredInputStore();
  const item = { id: "same", provider: "claude", projectRoot: "D:/Work", threadId: "session" };
  store.put(item, "pending");
  store.put(item, "queued");

  assert.equal(store.pending.size, 0);
  assert.equal(store.queued.size, 1);
  assert.equal(deferredInputTaskKey(item), taskOccupancyIdentity(item).key);
});

test("unbound queued commands share one provisional Stream lane", () => {
  const store = new DeferredInputStore();
  const item = { id: "provisional", streamId: "stream-1", provider: "claude", threadId: null };
  store.put(item, "queued");

  assert.equal(store.hasBacklog({ streamId: "stream-1", provider: "codex", threadId: null }), true);
  assert.equal(store.hasBacklog({
    streamId: "stream-1", provider: "codex", threadId: "thread-1",
  }), false);
});
