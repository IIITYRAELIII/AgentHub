import assert from "node:assert/strict";
import test from "node:test";

import {
  StreamMaintenanceRegistry,
  streamMaintenanceKey,
} from "../../src/application/stream-maintenance-registry.mjs";

test("stream maintenance follows the Stream while its Thread rotates", () => {
  const registry = new StreamMaintenanceRegistry();
  const source = { provider: "codex", streamId: "stream-1", threadId: "thread-old" };
  const target = { provider: "codex", streamId: "stream-1", threadId: "thread-new" };

  const entry = registry.begin(source, "automatic-compaction");
  assert.ok(entry);
  assert.equal(registry.isActive(target), true);
  assert.equal(registry.begin(target), null);
  assert.equal(registry.end(entry), true);
  assert.equal(registry.isActive(source), false);
});

test("unbound maintenance falls back to the provider Thread identity", () => {
  const target = { provider: "codex", projectRoot: "D:/Work", threadId: "thread-1" };
  assert.equal(streamMaintenanceKey(target), "provider:codex:d:/work:thread-1");
});
