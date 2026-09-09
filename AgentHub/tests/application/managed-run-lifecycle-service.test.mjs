import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRunLifecycleService } from "../../src/application/managed-run-lifecycle-service.mjs";
import { createInterstreamMessage } from "../../src/domain/interstream-message.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";

function harness({
  provider = "codex",
  currentTarget = null,
  codexSettings = null,
  currentPreferences = null,
  beforeCompletion = null,
  completionAborted = null,
  afterCompletion = null,
  prepareAdmission = null,
  revokeAdmission = null,
  saveState = null,
  commandTrace = null,
} = {}) {
  const events = [];
  const taskRuns = new TaskRunRegistry();
  const service = new ManagedRunLifecycleService({
    taskRuns,
    commandTrace,
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
    prepareAdmission: prepareAdmission ?? (async () => null),
    revokeAdmission: revokeAdmission ?? (() => {}),
    beforeCompletion: beforeCompletion ?? (async () => events.push("before")),
    completionAborted: completionAborted ?? (async () => events.push("aborted")),
    afterCompletion: afterCompletion ?? (async () => events.push("after")),
  });
  return { service, taskRuns, events };
}

test("managed run lifecycle commits the exact prepared launch capability", async () => {
  let authorizedTarget;
  let committedRun;
  const { service } = harness({
    provider: "claude",
    prepareAdmission: async (target) => {
      authorizedTarget = target;
      return { commit: (run) => { committedRun = run; } };
    },
  });

  const run = await service.begin("hello", {
    provider: "claude",
    projectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "thread-exact",
    taskTitle: "Claude",
  });

  assert.equal(authorizedTarget.threadId, "thread-exact");
  assert.equal(committedRun, run);
});

test("managed run lifecycle adoption cannot mint a launch capability", async () => {
  let preparations = 0;
  const { service } = harness({
    provider: "claude",
    prepareAdmission: async () => {
      preparations += 1;
      return null;
    },
  });

  await service.adopt("already accepted", {
    provider: "claude",
    projectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "thread-existing",
    taskTitle: "Claude",
  });

  assert.equal(preparations, 0);
});

test("managed run lifecycle revokes launch capability before asynchronous completion", async () => {
  let releaseCompletion;
  const completion = new Promise((resolve) => { releaseCompletion = resolve; });
  const events = [];
  const { service } = harness({
    revokeAdmission: () => events.push("revoked"),
    beforeCompletion: async () => completion,
  });
  const run = await service.begin("hello");

  const pending = service.complete(run);
  assert.deepEqual(events, ["revoked"]);
  releaseCompletion();
  await pending;
});

test("managed run lifecycle creates and persists one owned run", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");

  assert.equal(taskRuns.forTask(run), run);
  assert.equal(run.promptPreview, "hello");
  assert.equal(run.rawPrompt, "hello");
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

test("failed pre-turn admission cannot leave a recoverable active run", async () => {
  const failure = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  const traceResults = [];
  let saves = 0;
  let rejectedRun;
  const deferredInput = { clientUserMessageId: "queued-after-compaction" };
  const { service, taskRuns, events } = harness({
    commandTrace: { startBestEffortSpan: () => ({ finish: (result) => traceResults.push(result) }) },
    prepareAdmission: async () => ({ commit: (run) => { rejectedRun = run; } }),
    revokeAdmission: (run) => assert.equal(run, rejectedRun),
    saveState: async () => {
      saves += 1;
      if (saves === 1) throw failure;
      assert.equal(taskRuns.size, 0);
    },
  });

  await assert.rejects(service.begin("continue", {
    clientUserMessageId: deferredInput.clientUserMessageId,
    deferredInput,
  }), (error) => error === failure);

  assert.equal(taskRuns.forTask(rejectedRun), null);
  assert.equal(taskRuns.size, 0);
  assert.equal(rejectedRun.status, "failed");
  assert.equal(deferredInput.dispatchingRunId, undefined);
  assert.equal(events.includes("progress"), false);
  assert.equal(events.includes("before"), false);
  assert.equal(saves, 2);
  assert.deepEqual(traceResults, [{
    outcome: "failed",
    metadata: { operation: "save-state", errorCode: "ERR_SQLITE_ERROR", sqliteErrorCode: 5, runId: rejectedRun.id },
  }]);
});

test("failed admission rollback keeps the original error and removes only its own run", async () => {
  const failure = new Error("database is locked");
  const rollbackFailure = new Error("snapshot write failed");
  let saves = 0;
  const { service, taskRuns } = harness({
    saveState: async () => {
      saves += 1;
      if (saves === 2) throw failure;
      if (saves === 3) throw rollbackFailure;
    },
  });
  const otherRun = await service.begin("other", { threadId: "other-thread" });
  const deferredInput = { dispatchingRunId: "previous-attempt" };

  await assert.rejects(service.begin("continue", { deferredInput }), (error) => {
    assert.equal(error.cause, failure);
    assert.deepEqual(error.errors, [failure, rollbackFailure]);
    return true;
  });

  assert.deepEqual(taskRuns.values(), [otherRun]);
  assert.equal(otherRun.status, "running");
  assert.equal(deferredInput.dispatchingRunId, "previous-attempt");
});

test("admission persistence failure retains a provider turn accepted during the write", async () => {
  const failure = new Error("database is locked");
  let acceptedRun;
  const { service, taskRuns } = harness({
    prepareAdmission: async () => ({ commit: (run) => { acceptedRun = run; } }),
    revokeAdmission: () => assert.fail("accepted provider work must remain owned"),
    saveState: async () => {
      acceptedRun.turnId = "accepted-turn";
      throw failure;
    },
  });

  await assert.rejects(service.begin("continue"), (error) => error === failure);
  assert.equal(taskRuns.forTask(acceptedRun), acceptedRun);
  assert.equal(acceptedRun.status, "running");
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

test("managed run lifecycle omits an oversized provider client message id", async () => {
  const { service } = harness();
  const run = await service.begin("hello", {
    clientUserMessageId: `provider:${"x".repeat(201)}`,
  });

  assert.equal(run.clientUserMessageId, null);
  assert.equal(run.userMessages[0].clientUserMessageId, undefined);
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
  const input = createInterstreamMessage({ ...messageOrigin, text: "проверь сообщение" });

  const run = await service.begin(input, {
    clientUserMessageId: "mcp:request-run",
    messageOrigin,
  });

  assert.equal(run.promptPreview, input);
  assert.equal(run.rawPrompt, input);
  assert.deepEqual(run.messageOrigin, messageOrigin);
  assert.deepEqual(run.userMessages[0], {
    role: "user",
    kind: "interstream",
    clientUserMessageId: "mcp:request-run",
    origin: messageOrigin,
    author: "Agent HUB - Themes (Terra)",
    text: "проверь сообщение",
    submittedAt: run.submittedAt,
    startedAt: run.startedAt,
    time: run.startedAt,
  });
});
