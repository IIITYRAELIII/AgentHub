import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRunLifecycleService } from "../../src/application/managed-run-lifecycle-service.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";

function harness() {
  const events = [];
  const taskRuns = new TaskRunRegistry();
  const service = new ManagedRunLifecycleService({
    taskRuns,
    currentTarget: () => ({
      provider: "codex", projectRoot: "D:/Work", streamId: "stream-1", threadId: "thread-1", taskTitle: "Task", chatId: 7,
    }),
    findProject: () => ({ name: "Work" }),
    codexSettings: () => ({}),
    currentPreferences: () => ({
      model: "gpt", defaultModel: "gpt", reasoningEffort: "high", defaultReasoningEffort: "high", collaborationMode: "default",
    }),
    modelLabel: (value) => value.toUpperCase(),
    claudeModelLabels: {}, reasoningLabels: { high: "High" },
    captureGitBaseline: async () => ({ repositories: [] }),
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
    afterCompletion: async () => events.push("after"),
  });
  return { service, taskRuns, events };
}

test("managed run lifecycle creates and persists one owned run", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");

  assert.equal(taskRuns.forTask(run), run);
  assert.equal(run.promptPreview, "hello");
  assert.equal(run.streamId, "stream-1");
  assert.equal(run.model, "GPT");
  assert.deepEqual(events, ["catalog", "diff", "clear-diff", "sync-start", "save", "progress"]);
});

test("managed run lifecycle completes and removes the same run", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");
  events.length = 0;
  await service.complete(run);

  assert.equal(taskRuns.size, 0);
  assert.equal(run.status, "completed");
  assert.deepEqual(events, ["approvals", "observer", "claude", "catalog", "sync-complete", "typing", "save", "after"]);
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
