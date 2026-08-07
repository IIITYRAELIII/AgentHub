import assert from "node:assert/strict";
import test from "node:test";

import { DeferredInputStore } from "../../src/application/deferred-input-store.mjs";
import {
  contextUsagePercent,
  StreamContextMaintenanceService,
} from "../../src/application/stream-context-maintenance-service.mjs";
import { StreamMaintenanceRegistry } from "../../src/application/stream-maintenance-registry.mjs";

function fixture({ beforePercent = 80, afterPercent = 18, rotate = true } = {}) {
  const events = [];
  const registry = new StreamMaintenanceRegistry();
  const deferredInputs = new DeferredInputStore();
  const source = {
    provider: "codex",
    projectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "thread-old",
    taskTitle: "Workspace",
    status: "finishing",
  };
  const provider = {
    compactions: {
      waitForSettlement: async (...args) => {
        events.push(["settled", ...args, registry.isActive(source)]);
        return { status: "completed" };
      },
    },
    start: async (...args) => {
      events.push(["compact", ...args, registry.isActive(source)]);
      return { accepted: true, compactionId: "compact-1" };
    },
    startManual: async () => ({ accepted: true, compactionId: "manual-1" }),
    rotate: async () => ({ thread: { id: "thread-new" } }),
    rotateCompacted: async (...args) => {
      events.push(["rotate", ...args, registry.isActive(source)]);
      return {
        accepted: true,
        sourceThreadId: "thread-old",
        compactionId: "compact-1",
        thread: { id: "thread-new" },
      };
    },
    discardCompactionTransfer: (...args) => events.push(["discard", ...args]),
  };
  const selectionStore = {
    threadId: "thread-old",
    setThread: (...args) => events.push(["select", ...args]),
  };
  const workspaceCatalog = {
    thread: ({ threadId }) => threadId === "thread-old"
      ? { provider: "codex", threadId, streamId: "stream-1", projectRoot: "D:/Work" }
      : null,
    stream: (id) => id === "stream-1" ? { id, workspaceId: "workspace-1" } : null,
    workspace: (id) => id === "workspace-1" ? { id, name: "Workspace" } : null,
    bindThread: (value) => events.push(["bind", value]),
  };
  const service = new StreamContextMaintenanceService({
    registry,
    provider,
    latestContextUsage: () => ({
      usedTokens: beforePercent,
      modelContextWindow: 100,
      updatedAt: "2026-08-07T10:00:00.000Z",
    }),
    waitForContextUpdate: async () => ({
      usedTokens: afterPercent,
      modelContextWindow: 100,
      updatedAt: "2026-08-07T10:01:00.000Z",
    }),
    workspaceCatalog,
    selectionStore,
    deferredInputs,
    invalidateCatalog: () => events.push(["invalidate"]),
    saveState: async () => events.push(["save"]),
    scheduleDeferred: (item) => events.push(["wake", item.id]),
    autoCompactEnabled: () => true,
    autoCompactThreshold: () => 75,
    autoRotateEnabled: () => rotate,
    autoRotateThreshold: () => 20,
  });
  return { deferredInputs, events, registry, service, source };
}

test("context usage percentage uses the current model window", () => {
  assert.equal(contextUsagePercent({ usedTokens: 75, modelContextWindow: 100 }), 75);
  assert.equal(contextUsagePercent({ usedTokens: 1, modelContextWindow: 0 }), null);
});

test("post-turn automation ignores non-terminal observation cleanup", () => {
  const state = fixture();
  state.source.status = "running";
  assert.equal(state.service.reserveAfterTurn(state.source), false);
  assert.equal(state.registry.isActive(state.source), false);
});

test("post-turn automation does not compact at the exact threshold", async () => {
  const state = fixture({ beforePercent: 75 });
  assert.equal(state.service.reserveAfterTurn(state.source), true);
  const result = await state.service.maintainAfterTurn(state.source);
  assert.deepEqual(result, { compacted: false, beforePercent: 75 });
  assert.equal(state.events.some(([name]) => name === "compact"), false);
  assert.equal(state.registry.isActive(state.source), false);
});

test("post-turn automation compacts once and does not rotate below 20 percent", async () => {
  const state = fixture({ beforePercent: 80, afterPercent: 20 });
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);
  assert.equal(result.compacted, true);
  assert.equal(result.rotated, false);
  assert.equal(state.events.filter(([name]) => name === "compact").length, 1);
  assert.equal(state.events.some(([name]) => name === "rotate"), false);
  assert.equal(state.events.some(([name]) => name === "discard"), true);
});

test("rotation reuses the completed compaction and retargets the blocked queue", async () => {
  const state = fixture({ beforePercent: 80, afterPercent: 21 });
  state.deferredInputs.put({
    id: "queued-1",
    provider: "codex",
    streamId: "stream-1",
    threadId: "thread-old",
    projectRoot: "D:/Work",
    taskTitle: "Workspace",
  }, "queued");
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);

  assert.equal(result.rotated, true);
  assert.equal(state.events.filter(([name]) => name === "compact").length, 1);
  assert.equal(state.events.filter(([name]) => name === "rotate").length, 1);
  assert.equal(state.events.find(([name]) => name === "rotate").at(-1), true);
  assert.equal(state.deferredInputs.get("queued-1").threadId, "thread-new");
  assert.equal(state.events.some(([name, id]) => name === "wake" && id === "queued-1"), true);
  assert.equal(state.registry.isActive(state.source), false);
});
