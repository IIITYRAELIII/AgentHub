import assert from "node:assert/strict";
import test from "node:test";

import {
  StreamMaintenanceRegistry,
  streamMaintenanceKey,
} from "../../src/application/stream-maintenance-registry.mjs";

test("stream maintenance follows the Stream while its Thread rotates", () => {
  const registry = new StreamMaintenanceRegistry();
  const source = {
    id: "run-1",
    provider: "codex",
    streamId: "stream-1",
    threadId: "thread-old",
    turnId: "turn-1",
  };
  const target = { provider: "codex", streamId: "stream-1", threadId: "thread-new" };

  const entry = registry.begin(source, "automatic-compaction");
  assert.ok(entry);
  assert.equal(entry.ownerRunId, "run-1");
  assert.equal(entry.ownerTurnId, "turn-1");
  assert.equal(registry.activeCount(), 1);
  assert.equal(registry.isActive(target), true);
  assert.equal(registry.begin(target), null);
  assert.equal(registry.update(entry, { reason: "automatic-rotation" }).reason, "automatic-rotation");
  assert.equal(registry.entry(target).reason, "automatic-rotation");
  assert.equal(registry.end(entry), true);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.isActive(source), false);
});

test("unbound maintenance falls back to the provider Thread identity", () => {
  const target = { provider: "codex", projectRoot: "D:/Work", threadId: "thread-1" };
  assert.equal(streamMaintenanceKey(target), "provider:codex:d:/work:thread-1");
});

test("unbound automatic maintenance blocks the matching Stream target", () => {
  const registry = new StreamMaintenanceRegistry();
  const automaticRun = { provider: "codex", projectRoot: "D:/Work", threadId: "thread-1" };
  const clientTarget = {
    provider: "codex",
    projectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "thread-1",
  };

  const entry = registry.begin(automaticRun, "automatic-compaction");

  assert.ok(entry);
  assert.equal(registry.isActive(clientTarget), true);
  assert.equal(registry.begin(clientTarget), null);
  assert.equal(registry.entry(clientTarget), entry);
  assert.equal(registry.end(clientTarget), true);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.isActive(automaticRun), false);
});

test("Stream maintenance blocks a provider target that lacks Stream metadata", () => {
  const registry = new StreamMaintenanceRegistry();
  const streamRun = {
    provider: "codex",
    projectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "thread-1",
  };
  const providerTarget = { provider: "codex", projectRoot: "D:/Work", threadId: "thread-1" };

  const entry = registry.begin(streamRun, "context-measurement");

  assert.ok(entry);
  assert.equal(registry.isActive(providerTarget), true);
  assert.equal(registry.end(entry), true);
  assert.equal(registry.isActive(providerTarget), false);
});
