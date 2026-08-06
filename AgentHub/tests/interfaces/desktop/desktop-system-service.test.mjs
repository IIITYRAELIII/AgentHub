import assert from "node:assert/strict";
import test from "node:test";

import { DesktopSystemService } from "../../../src/interfaces/desktop/desktop-system-service.mjs";

function fixture() {
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

test("Desktop search returns the stable Hub task identity", async () => {
  const { service } = fixture();
  const result = await service.search({ query: "task" });
  assert.equal(result.results[0].id, "stream-1");
  assert.equal(result.results[0].streamId, "stream-1");
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
