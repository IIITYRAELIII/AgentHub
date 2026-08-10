import assert from "node:assert/strict";
import test from "node:test";

import { DesktopSystemService } from "../../../src/interfaces/desktop/desktop-system-service.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const service = new DesktopSystemService({
    activeProvider: () => "codex",
    isCodex: () => true,
    preferences: () => ({ model: "sol", reasoningEffort: "high", collaborationMode: "work" }),
    codexModelLabel: (value) => `Model ${value}`,
    claudeModelLabels: { opus: "Opus" },
    reasoningLabels: { high: "High" },
    collaborationModeLabels: { work: "Work" },
    formattedRateLimits: async () => "limits",
    activeRunCount: () => 2,
    backgroundJobCount: () => 3,
    readRateLimitHistory: async (params) => ({ params }),
    readUsageHistory: async (params) => ({ params }),
    refreshCatalog: async () => [{
      streamId: "stream-1", provider: "codex", threadId: "thread-1", projectRoot: "C:\\repo", title: "Task",
    }],
    searchTurns: async () => [{
      provider: "codex", threadId: "thread-1", projectRoot: "C:\\repo", taskTitle: "Old", matches: [],
    }],
    workspaceHierarchy: () => [{
      id: "workspace-1",
      streams: [{
        id: "stream-1", displayName: "API", ordinal: 1,
        threads: [{ provider: "codex", threadId: "thread-1" }],
      }],
    }],
    searchMessages: () => ({
      total: 1,
      results: [{
        id: "message-1", provider: "codex", threadId: "thread-1",
        turnThreadId: "thread-1", turnId: "turn-1", itemId: "user-1",
        role: "user", matchedField: "text", snippet: "точное сообщение", occurredAt: null,
      }],
    }),
    projectRoots: () => ["C:\\repo"],
    samePath: (left, right) => left.toLowerCase() === right.toLowerCase(),
    trustedDeviceManager: () => ({
      list: async () => ["device"],
      createPairing: async () => ({ code: "123" }),
      revoke: async (id) => calls.push(id),
    }),
    resolveTask: async () => ({ provider: "codex", threadId: "thread-1" }),
    lastTaskMessage: () => ({ text: "answer" }),
    enqueueSpeech: async (...args) => {
      calls.push(["speech", ...args]);
      return { id: "job-1" };
    },
    maxSpeechJobs: 10,
    ...overrides,
  });
  return { service, calls };
}

test("Desktop system status composes provider settings and live counters", async () => {
  const { service } = fixture();
  assert.deepEqual(await service.statusDetails(), {
    provider: "codex",
    model: "Model sol",
    reasoning: "High",
    mode: "Work",
    limits: "limits",
    activeCount: 2,
    backgroundJobs: 3,
  });
});

test("Desktop usage history forwards provider and turn-time filters", async () => {
  const { service } = fixture();
  const result = await service.usageHistory({
    range: "30d", maxPoints: 600, provider: "codex", turnTimeMode: "middle",
  });
  assert.deepEqual(result.params, {
    range: "30d", maxPoints: 600, provider: "codex", turnTimeMode: "middle",
  });
});

test("Desktop search returns the stable Hub task identity", async () => {
  const { service } = fixture();
  const result = await service.search({ query: "task" });
  assert.equal(result.results[0].id, "stream-1");
  assert.equal(result.results[0].streamId, "stream-1");
});

test("Desktop workspace message search maps every historical Thread to its Stream", async () => {
  const { service } = fixture();
  const result = await service.workspaceMessageSearch({
    workspaceId: "workspace-1", query: "точное", limit: 40,
  });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].streamId, "stream-1");
  assert.equal(result.results[0].streamName, "API");
  assert.equal(result.results[0].itemId, "user-1");
});

test("Desktop workspace search backfills pending provider histories in the background", async () => {
  const indexed = [];
  const { service } = fixture({
    messageSearchStatus: (references) => ({
      totalThreads: references.length,
      completedThreads: 0,
      failedThreads: 0,
      threads: references.map((reference) => ({ ...reference, state: "pending" })),
    }),
    refreshHistory: async (reference) => indexed.push(["refresh", reference.threadId]),
    markMessageSearchThread: (reference) => indexed.push(["ready", reference.threadId]),
  });
  const result = await service.workspaceMessageSearch({
    workspaceId: "workspace-1", query: "точное", limit: 40,
  });
  assert.equal(result.indexing.state, "indexing");
  await service.messageSearchIndexTail;
  assert.deepEqual(indexed, [["refresh", "thread-1"], ["ready", "thread-1"]]);
});

test("Desktop trusted-device mutations validate and delegate", async () => {
  const { service, calls } = fixture();
  await service.revokeDevice({ deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, {});
  assert.equal(calls.length, 1);
  assert.throws(() => service.revokeDevice({ deviceId: "bad" }, {}), /Некорректный/u);
});

test("Desktop speech addresses the selected task and enqueues one job", async () => {
  const { service, calls } = fixture();
  const result = await service.speakLastAnswer({ streamId: "stream-1" });
  assert.equal(result.accepted, true);
  assert.equal(calls.some((value) => Array.isArray(value) && value[0] === "speech"), true);
});
