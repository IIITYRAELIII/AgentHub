import assert from "node:assert/strict";
import test from "node:test";

import { ProviderTaskActivityService } from "../../src/application/provider-task-activity-service.mjs";

function fixture({
  rolloutPath = "C:/rollout.jsonl",
  running = true,
  claudeSnapshot = null,
  claudeRuntime = { known: false, hasLiveProcess: true },
} = {}) {
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
    claudeRuntimeState: async (snapshot, options) => {
      events.push(["claude-runtime", snapshot?.sessionId ?? null, options]);
      return claudeRuntime;
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

test("ProviderTaskActivityService resolves stale Claude transcript activity from external process evidence", async () => {
  const stale = { sessionId: "claude-stale", activityUnknown: true, active: false };
  const absent = fixture({
    claudeSnapshot: stale,
    claudeRuntime: {
      known: true,
      complete: true,
      hasLiveProcess: false,
      generation: 3,
      scannedAt: "2026-09-05T08:00:00.000Z",
      requestedAfterMs: 0,
    },
  });
  assert.deepEqual(await absent.service.readClaude({ threadId: "claude-stale" }), {
    state: "inactive",
    executionOwner: "external",
    processEvidence: {
      complete: true,
      generation: 3,
      scannedAt: "2026-09-05T08:00:00.000Z",
      requestedAfterMs: 0,
    },
  });

  const live = fixture({
    claudeSnapshot: stale,
    claudeRuntime: { known: true, hasLiveProcess: true },
  });
  assert.equal((await live.service.readClaude({ threadId: "claude-stale" })).state, "active");

  const unknown = fixture({ claudeSnapshot: stale });
  assert.deepEqual(await unknown.service.readClaude({ threadId: "claude-1" }), {
    state: "unknown",
    executionOwner: "external",
    processEvidence: {
      complete: false,
      generation: null,
      scannedAt: null,
      requestedAfterMs: 0,
    },
  });

  const inactive = fixture({ claudeSnapshot: null });
  assert.equal((await inactive.service.readClaude({ threadId: "claude-2" })).state, "inactive");
  assert.equal(inactive.events.some(([event]) => event === "claude-runtime"), false);
});

test("ProviderTaskActivityService force-fresh checks exact Claude identity despite cached transcript state", async () => {
  const state = fixture({
    claudeSnapshot: null,
    claudeRuntime: {
      known: false,
      complete: false,
      hasLiveProcess: true,
      generation: 9,
      scannedAt: "2026-09-05T08:00:01.000Z",
    },
  });
  const result = await state.service.readClaude({ threadId: "new-session" }, {
    forceFresh: true,
    notBeforeMs: 1_000,
  });
  assert.equal(result.state, "unknown");
  assert.deepEqual(state.events.at(-1), [
    "claude-runtime",
    "new-session",
    { forceFresh: true, notBeforeMs: 1_000 },
  ]);
});
