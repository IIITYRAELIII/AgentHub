import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRunLifecycleService } from "../../src/application/managed-run-lifecycle-service.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";

function harness({ provider = "codex", beforeCompletion = null } = {}) {
  const events = [];
  let baselineCaptures = 0;
  const taskRuns = new TaskRunRegistry();
  const service = new ManagedRunLifecycleService({
    taskRuns,
    currentTarget: () => ({
      provider, projectRoot: "D:/Work", streamId: "stream-1", threadId: "thread-1", taskTitle: "Task", chatId: 7,
    }),
    findProject: () => ({ name: "Work" }),
    codexSettings: () => ({}),
    currentPreferences: () => ({
      model: "gpt", defaultModel: "gpt", reasoningEffort: "high", defaultReasoningEffort: "high", collaborationMode: "default",
    }),
    normalizeCodexModel: (value) => String(value).toLowerCase(),
    modelLabel: (value) => value.toUpperCase(),
    claudeModelLabels: {}, reasoningLabels: { high: "High" },
    captureGitBaseline: async () => {
      baselineCaptures += 1;
      return { repositories: [] };
    },
    persistTaskDiff: async () => events.push("diff"),
    syncRun: (_run, options) => events.push(options?.active === false ? "sync-complete" : "sync-start"),
    invalidateCatalog: () => events.push("catalog"),
    saveState: async () => events.push("save"),
    scheduleProgressStart: () => events.push("progress"),
    clearSelectedDiff: () => events.push("clear-diff"),
    clearApprovals: () => events.push("approvals"),
    pauseObservation: () => events.push("observer"),
    pauseClaude: () => events.push("claude"),
    stopTyping: () => events.push("typing"),
    beforeCompletion: beforeCompletion ?? (async () => events.push("before")),
    afterCompletion: async () => events.push("after"),
  });
  return { service, taskRuns, events, baselineCaptures: () => baselineCaptures };
}

test("managed run lifecycle creates and persists one owned run", async () => {
  const { service, taskRuns, events, baselineCaptures } = harness();
  const run = await service.begin("hello");

  assert.equal(taskRuns.forTask(run), run);
  assert.equal(run.promptPreview, "hello");
  assert.deepEqual(run.userMessages, [{
    role: "user",
    text: "hello",
    time: run.startedAt,
  }]);
  assert.equal(run.streamId, "stream-1");
  assert.equal(run.model, "GPT");
  assert.equal(baselineCaptures(), 0);
  assert.deepEqual(events, ["catalog", "diff", "clear-diff", "sync-start", "save", "progress"]);
});

test("managed run lifecycle keeps Git baseline fallback for non-Codex providers", async () => {
  const { service, baselineCaptures } = harness({ provider: "claude" });
  const run = await service.begin("hello");

  assert.equal(baselineCaptures(), 1);
  assert.deepEqual(run.gitBaseline, { repositories: [] });
});

test("managed run lifecycle canonicalizes a legacy Codex model label", async () => {
  const { service } = harness();
  const run = await service.begin("hello", { modelId: "GPT-5.6-Sol" });

  assert.equal(run.modelId, "gpt-5.6-sol");
  assert.equal(run.model, "GPT-5.6-SOL");
});

test("managed run lifecycle completes and removes the same run", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");
  events.length = 0;
  await service.complete(run);

  assert.equal(taskRuns.size, 0);
  assert.equal(run.status, "completed");
  assert.deepEqual(events, ["before", "approvals", "observer", "claude", "sync-complete", "catalog", "save", "typing", "save", "after"]);
});

test("managed run lifecycle exposes terminal state before removing the run", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");

  await service.markCompleted(run);

  assert.equal(run.status, "completed");
  assert.equal(taskRuns.forTask(run), run);
  assert.ok(events.includes("sync-complete"));
});

test("managed run lifecycle retries completion preparation after a failed hook", async () => {
  let attempts = 0;
  const { service, taskRuns, events } = harness({
    beforeCompletion: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("completion hook failed");
      events.push("before");
    },
  });
  const run = await service.begin("hello");
  events.length = 0;

  await assert.rejects(service.markCompleted(run), /completion hook failed/);
  assert.equal(run.completionPrepared, undefined);
  assert.equal(run.status, "running");
  assert.equal(taskRuns.forTask(run), run);

  await service.markCompleted(run);
  assert.equal(run.completionPrepared, true);
  assert.equal(run.status, "completed");
  assert.equal(attempts, 2);
  assert.deepEqual(events, ["before", "approvals", "observer", "claude", "sync-complete", "catalog", "save"]);
});

test("managed run lifecycle keeps a Desktop-started run out of Telegram", async () => {
  const { service, events } = harness();
  const run = await service.begin("hello", {
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "thread-1",
    taskTitle: "Task",
    chatId: 7,
    telegramDeliveryRequested: false,
    clientSource: "desktop",
  });

  assert.equal(run.telegramDeliveryRequested, false);
  assert.equal(run.displayRequested, false);
  assert.equal(run.clientSource, "desktop");
  assert.equal(events.includes("progress"), false);
});
