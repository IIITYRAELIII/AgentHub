import assert from "node:assert/strict";
import test from "node:test";

import { ProviderTaskActivityService } from "./provider-task-activity-service.mjs";

function fixture({ rolloutPath = "C:/rollout.jsonl", running = true, claudeSnapshot = null } = {}) {
  const events = [];
  const codexTransport = { running, pid: 77 };
  const service = new ProviderTaskActivityService({
    knownCodexRolloutPath: async (threadId) => {
      events.push(["known-path", threadId]);
      return rolloutPath;
    },
    codexRunning: () => codexTransport.running,
    codexPid: () => codexTransport.pid,
    ensureCodex: async () => {
      events.push(["ensure-codex"]);
      codexTransport.running = true;
    },
    readCodexThread: async (threadId, options) => {
      events.push(["read-thread", threadId, options]);
      return { thread: { path: "C:/discovered.jsonl", status: { type: "active" } } };
    },
    capturedCodexExecutionOwner: (threadId, turnId) => ({ threadId, turnId }),
    claudeTaskSnapshots: {
      read: async (threadId) => {
        events.push(["read-claude", threadId]);
        return claudeSnapshot;
      },
    },
    readRolloutActivity: async (path) => {
      events.push(["read-rollout", path]);
      return { turns: [{ turnId: "turn-1", active: true }] };
    },
    selectActiveTurnId: () => "turn-1",
    resolveActivity: (source, context) => ({ source, context }),
  });
  return { service, events };
}

test("ProviderTaskActivityService reads a known Codex rollout without starting another server", async () => {
  const state = fixture();
  const result = await state.service.readCodex({ threadId: "thread-1" });

  assert.deepEqual(state.events, [
    ["known-path", "thread-1"],
    ["read-rollout", "C:/rollout.jsonl"],
  ]);
  assert.equal(result.context.turnId, "turn-1");
  assert.equal(result.context.agentHubPid, 77);
  assert.deepEqual(result.context.capturedOwner, { threadId: "thread-1", turnId: "turn-1" });
});

test("ProviderTaskActivityService starts Codex only when discovery requires App Server", async () => {
  const state = fixture({ rolloutPath: "", running: false });
  const result = await state.service.readCodex({ threadId: "thread-2" });

  assert.deepEqual(state.events.slice(0, 3), [
    ["known-path", "thread-2"],
    ["ensure-codex"],
    ["read-thread", "thread-2", { fresh: true, includeTurns: false }],
  ]);
  assert.equal(result.source.threadStatus.type, "active");
  assert.equal(result.context.rolloutPath, "C:/discovered.jsonl");
});

test("ProviderTaskActivityService preserves unknown Claude activity", async () => {
  const unknown = fixture({ claudeSnapshot: { activityUnknown: true, active: true } });
  assert.deepEqual(await unknown.service.readClaude({ threadId: "claude-1" }), {
    state: "unknown",
    executionOwner: "external",
  });

  const inactive = fixture({ claudeSnapshot: null });
  assert.equal((await inactive.service.readClaude({ threadId: "claude-2" })).state, "inactive");
});
