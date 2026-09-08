import assert from "node:assert/strict";
import test from "node:test";

import { StreamHandoffService } from "../../src/application/stream-handoff-service.mjs";

function fixture({ turns = [] } = {}) {
  const meta = new Map();
  const requestedThreads = [];
  const catalog = {
    meta: (key) => meta.get(key) ?? null,
    setMeta: (key, value) => meta.set(key, String(value)),
    deleteMeta: (key) => meta.delete(key),
    stream: (id) => (id === "stream-1"
      ? { id, workspaceId: "workspace-1", displayName: "Stream 43" }
      : null),
    workspace: (id) => (id === "workspace-1" ? { id, name: "AgentHub" } : null),
    threadsForStream: () => [
      { provider: "codex", threadId: "thread-1" },
      { provider: "claude", threadId: "thread-2" },
    ],
  };
  const service = new StreamHandoffService({
    workspaceCatalog: catalog,
    workLog: {
      threadTurns: async (identities) => {
        requestedThreads.push(identities);
        return turns;
      },
    },
    now: () => new Date("2026-08-19T17:40:00.000Z"),
    logger: { warn() {} },
  });
  return { service, meta, requestedThreads };
}

const turn = {
  provider: "codex",
  threadId: "thread-1",
  title: "Сделал реализацию",
  prompt: "давай сделаем",
  body: "Готово.",
  completedAt: "2026-08-19T15:17:35.140Z",
  status: "completed",
};

test("a requested handoff survives as a durable per-Stream record", async () => {
  const { service, meta } = fixture();
  const pending = await service.request({
    streamId: "stream-1",
    targetProvider: "Claude",
    sourceProvider: "Codex",
    sourceThreadId: "thread-1",
    reason: "manual",
  });

  assert.equal(pending.targetProvider, "claude");
  assert.equal(pending.sourceProvider, "codex");
  assert.equal(pending.requestedAt, "2026-08-19T17:40:00.000Z");
  assert.equal(JSON.parse(meta.get("stream-handoff:stream-1")).sourceThreadId, "thread-1");
  assert.deepEqual(service.pending("stream-1"), pending);
});

test("the first turn of the receiving Thread consumes the package exactly once", async () => {
  const { service, requestedThreads } = fixture({ turns: [turn] });
  await service.request({
    streamId: "stream-1",
    targetProvider: "claude",
    sourceProvider: "codex",
    sourceThreadId: "thread-1",
  });

  const first = await service.consume({
    streamId: "stream-1",
    provider: "claude",
    threadId: "thread-2",
  });
  assert.match(first, /Handed over: codex\/thread-1 -> claude/u);
  assert.match(first, /Сделал реализацию/u);
  // The receiving Thread's own turns are history for nobody but itself.
  assert.deepEqual(requestedThreads[0], [{ provider: "codex", threadId: "thread-1" }]);

  assert.equal(await service.consume({
    streamId: "stream-1",
    provider: "claude",
    threadId: "thread-2",
  }), "");
  assert.equal(service.pending("stream-1"), null);
});

test("a turn of the source Thread does not consume the pending handoff", async () => {
  const { service } = fixture({ turns: [turn] });
  await service.request({
    streamId: "stream-1",
    targetProvider: "claude",
    sourceProvider: "codex",
    sourceThreadId: "thread-1",
  });

  assert.equal(await service.consume({
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
  }), "");
  assert.equal(service.pending("stream-1").targetProvider, "claude");
});

test("a handoff for another provider is dropped instead of being delivered", async () => {
  const { service } = fixture({ turns: [turn] });
  await service.request({
    streamId: "stream-1",
    targetProvider: "claude",
    sourceProvider: "codex",
    sourceThreadId: "thread-1",
  });

  assert.equal(await service.consume({
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-3",
  }), "");
  assert.equal(service.pending("stream-1"), null);
});

test("a Stream without a pending handoff reads no journal history", async () => {
  const { service, requestedThreads } = fixture({ turns: [turn] });
  assert.equal(await service.consume({ streamId: "stream-1", provider: "claude" }), "");
  assert.equal(requestedThreads.length, 0);
});

test("a corrupted handoff record is discarded instead of blocking the Stream", () => {
  const { service, meta } = fixture();
  meta.set("stream-handoff:stream-1", "{not json");
  assert.equal(service.pending("stream-1"), null);
  assert.equal(meta.has("stream-handoff:stream-1"), false);
});
