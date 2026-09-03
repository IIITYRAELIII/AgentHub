import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRunLifecycleService } from "../../src/application/managed-run-lifecycle-service.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";

function harness({
  provider = "codex",
  currentTarget = null,
  codexSettings = null,
  currentPreferences = null,
  beforeCompletion = null,
  completionAborted = null,
  afterCompletion = null,
  saveState = null,
} = {}) {
  const events = [];
  const taskRuns = new TaskRunRegistry();
  const service = new ManagedRunLifecycleService({
    taskRuns,
    currentTarget: currentTarget ?? (() => ({
      provider, projectRoot: "D:/Work", streamId: "stream-1", threadId: "thread-1", taskTitle: "Task", chatId: 7,
    })),
    findProject: () => ({ name: "Work" }),
    codexSettings: codexSettings ?? (() => ({})),
    currentPreferences: currentPreferences ?? (() => ({
      model: "gpt", defaultModel: "gpt", reasoningEffort: "high", defaultReasoningEffort: "high", collaborationMode: "default",
    })),
    normalizeCodexModel: (value) => String(value).toLowerCase(),
    modelLabel: (value) => value.toUpperCase(),
    claudeModelLabels: {}, reasoningLabels: { high: "High" },
    persistTaskDiff: async () => events.push("diff"),
    syncRun: (_run, options) => events.push(options?.active === false ? "sync-complete" : "sync-start"),
    invalidateCatalog: () => events.push("catalog"),
    saveState: saveState ?? (async () => events.push("save")),
    scheduleProgressStart: () => events.push("progress"),
    clearSelectedDiff: () => events.push("clear-diff"),
    clearApprovals: () => events.push("approvals"),
    pauseObservation: () => events.push("observer"),
    pauseClaude: () => events.push("claude"),
    stopTyping: () => events.push("typing"),
    beforeCompletion: beforeCompletion ?? (async () => events.push("before")),
    completionAborted: completionAborted ?? (async () => events.push("aborted")),
    afterCompletion: afterCompletion ?? (async () => events.push("after")),
  });
  return { service, taskRuns, events };
}

test("managed run lifecycle creates and persists one owned run", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");

  assert.equal(taskRuns.forTask(run), run);
  assert.equal(run.promptPreview, "hello");
  assert.deepEqual(run.userMessages, [{
    role: "user",
    text: "hello",
    submittedAt: run.submittedAt,
    startedAt: run.startedAt,
    time: run.startedAt,
  }]);
  assert.equal(run.streamId, "stream-1");
  assert.equal(run.model, "GPT");
  assert.deepEqual(events, ["catalog", "diff", "clear-diff", "sync-start", "save", "progress"]);
});

test("managed run preserves durable submission time separately from provider start", async () => {
  const { service } = harness();
  const run = await service.begin("queued", {
    clientUserMessageId: "client-queued",
    deferredInput: { createdAt: "2026-09-01T21:25:00.000Z" },
  });

  assert.equal(run.submittedAt, "2026-09-01T21:25:00.000Z");
  assert.equal(run.userMessages[0].submittedAt, run.submittedAt);
  assert.equal(run.userMessages[0].startedAt, run.startedAt);
  assert.equal(run.userMessages[0].time, run.submittedAt);
});

test("managed run lifecycle does not capture Git baselines for provider turns", async () => {
  const { service } = harness({ provider: "claude" });
  const run = await service.begin("hello");

  assert.equal(run.gitBaseline, null);
});

test("managed run lifecycle canonicalizes a legacy Codex model label", async () => {
  const { service } = harness();
  const run = await service.begin("hello", { modelId: "GPT-5.6-Sol" });

  assert.equal(run.modelId, "gpt-5.6-sol");
  assert.equal(run.model, "GPT-5.6-SOL");
});

test("managed run lifecycle gives an explicit destination model precedence over saved and default models", async () => {
  const { service } = harness({
    currentTarget: () => ({
      provider: "codex", projectRoot: "D:/Work", streamId: "stream-b", threadId: "thread-b", taskTitle: "B", chatId: 7,
    }),
    codexSettings: () => ({ model: "saved-terra" }),
    currentPreferences: () => ({
      model: "selected-b", defaultModel: "fake-codex", reasoningEffort: "high", defaultReasoningEffort: "high", collaborationMode: "default",
    }),
  });

  const run = await service.begin("hello", {
    provider: "codex",
    projectRoot: "D:/Work",
    streamId: "stream-a",
    threadId: "thread-a",
    taskTitle: "A",
    modelId: "GPT-5.3-Codex-Spark",
  });

  assert.equal(run.modelId, "gpt-5.3-codex-spark");
});

test("managed run lifecycle preserves saved and selected-target model fallbacks", async () => {
  const currentTarget = () => ({
    provider: "codex", projectRoot: "D:/Work", streamId: "stream-b", threadId: "thread-b", taskTitle: "B", chatId: 7,
  });
  const preferences = () => ({
    model: "selected-b", defaultModel: "fake-codex", reasoningEffort: "high", defaultReasoningEffort: "high", collaborationMode: "default",
  });
  const saved = harness({
    currentTarget,
    codexSettings: () => ({ model: "saved-terra" }),
    currentPreferences: preferences,
  });
  const selected = harness({
    currentTarget,
    currentPreferences: preferences,
  });

  const savedRun = await saved.service.begin("saved", {
    provider: "codex", projectRoot: "D:/Work", streamId: "stream-a", threadId: "thread-a", taskTitle: "A",
  });
  const selectedRun = await selected.service.begin("selected", currentTarget());

  assert.equal(savedRun.modelId, "saved-terra");
  assert.equal(selectedRun.modelId, "selected-b");
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
  assert.equal(taskRuns.forTask(run), null);
  assert.equal(taskRuns.values().includes(run), true);
  assert.ok(events.includes("sync-complete"));
});

test("managed run lifecycle releases admission exactly once", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");
  events.length = 0;

  await Promise.all([service.releaseAdmission(run), service.releaseAdmission(run)]);
  await service.complete(run);

  assert.equal(taskRuns.size, 0);
  assert.equal(run.admissionReleased, true);
  assert.equal(events.filter((event) => event === "after").length, 1);
  assert.equal(events.filter((event) => event === "typing").length, 1);
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
  assert.deepEqual(events, ["aborted"]);

  await service.markCompleted(run);
  assert.equal(run.completionPrepared, true);
  assert.equal(run.status, "completed");
  assert.equal(attempts, 2);
  assert.deepEqual(events, ["aborted", "before", "approvals", "observer", "claude", "sync-complete", "catalog", "save"]);
});

test("managed run lifecycle rolls back post-turn ownership when terminal preparation fails", async () => {
  let saveCalls = 0;
  let reserved = false;
  const { service } = harness({
    beforeCompletion: async () => { reserved = true; },
    completionAborted: async () => { reserved = false; },
    saveState: async () => {
      saveCalls += 1;
      if (saveCalls === 2) throw new Error("terminal save failed");
    },
  });
  const run = await service.begin("hello");

  await assert.rejects(service.markCompleted(run), /terminal save failed/u);

  assert.equal(reserved, false);
  assert.equal(run.completionPrepared, undefined);
});

test("managed run lifecycle consumes post-turn ownership when admission persistence fails", async () => {
  let saveCalls = 0;
  const events = [];
  const state = harness({
    afterCompletion: async () => events.push("after"),
    saveState: async () => {
      saveCalls += 1;
      if (saveCalls === 3) throw new Error("admission save failed");
    },
  });
  const run = await state.service.begin("hello");

  await assert.rejects(state.service.complete(run), /admission save failed/u);
  assert.equal(run.admissionReleased, undefined);
  assert.deepEqual(events, ["after"]);

  await state.service.complete(run);
  assert.equal(run.admissionReleased, true);
  assert.deepEqual(events, ["after"]);
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

test("managed run lifecycle keeps interstream identity on the active user message", async () => {
  const { service } = harness();
  const messageOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "codex",
    model: "gpt-5.6-terra",
    sourceThreadId: "thread-themes",
    requestId: "request-run",
  };

  const run = await service.begin("проверь сообщение", { messageOrigin });

  assert.deepEqual(run.messageOrigin, messageOrigin);
  assert.deepEqual(run.userMessages[0], {
    role: "user",
    kind: "interstream",
    origin: messageOrigin,
    author: "Agent HUB - Themes (Terra)",
    text: "проверь сообщение",
    submittedAt: run.submittedAt,
    startedAt: run.startedAt,
    time: run.startedAt,
  });
});
