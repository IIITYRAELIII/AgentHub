import assert from "node:assert/strict";
import test from "node:test";

import { TaskObservationService } from "../../src/application/task-observation-service.mjs";

function fixture({ snapshot = null, now = 1_000_000 } = {}) {
  const events = [];
  let currentRun = null;
  const providers = {
    call(provider, method, ...args) {
      events.push(["provider", provider, method]);
      if (method === "shouldObserveRun") return true;
      if (method === "readRunSnapshot") return snapshot;
      if (method === "applyObservedSnapshot" || method === "applyActiveSnapshot") return undefined;
      throw new Error(`Unexpected provider method: ${method}`);
    },
    get: () => ({ name: "Codex" }),
  };
  const taskRuns = {
    add(run) { currentRun = run; events.push(["add", run]); },
    forTask(run) { return currentRun === run ? run : null; },
    reindex(run, previous) { events.push(["reindex", run, previous]); },
  };
  const completed = [];
  const service = new TaskObservationService({
    providers,
    taskRuns,
    runCoordinator: {
      completeManaged: async (run, options) => completed.push(["managed", run, options]),
      completeObserved: async (run, options) => completed.push(["observed", run, options]),
    },
    dataDir: "data",
    findProject: () => ({ name: "Workspace" }),
    invalidateTaskCatalog: () => events.push(["invalidate"]),
    syncTaskRun: (run, state) => events.push(["sync", run, state]),
    modelLabel: (model) => `Model ${model}`,
    reasoningLabels: { high: "High" },
    noteRunActivity: (run, value) => events.push(["activity", run, value]),
    scheduleProgressUpdate: (run) => events.push(["progress", run]),
    setProgressStage: (run, stage) => { run.progressStage = stage; },
    markProgressHeartbeat: () => true,
    progressHeartbeatState: () => "active",
    finishProgress: async (run, stage) => events.push(["finish-progress", run, stage]),
    completeRun: async (run) => { events.push(["complete", run]); currentRun = null; },
    discardManualContextCompactionRun: async () => false,
    savedLastTaskMessage: () => "",
    savedLastTaskMessageRecord: () => null,
    externalPollIntervalMs: 10,
    managedPollIntervalMs: 20,
    captureGitBaseline: async (...args) => ({ args }),
    now: () => now,
    logger: {
      log: (...args) => events.push(["log", ...args]),
      error: (...args) => events.push(["error", ...args]),
    },
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  return { service, events, completed, taskRuns, currentRun: () => currentRun };
}

test("TaskObservationService creates an observed run without losing logical hubTaskId", async () => {
  const state = fixture();
  const run = await state.service.create({
    hubTaskId: "hub-task-42",
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, {
    model: "gpt",
    reasoningEffort: "high",
    prompt: "Prompt",
    stage: "Working",
    executionOwner: "vscode",
    activityAtMs: 123,
  }, "turn-1");

  assert.equal(run.hubTaskId, "hub-task-42");
  assert.equal(run.threadId, "thread-1");
  assert.equal(run.turnId, "turn-1");
  assert.equal(run.projectName, "Workspace");
  assert.equal(run.model, "Model gpt");
  assert.equal(run.reasoning, "High");
  assert.equal(state.currentRun(), run);
  assert.deepEqual(run.gitBaseline.args.slice(0, 2), ["C:/workspace", "data"]);
});

test("TaskObservationService applies live snapshots and keeps the earliest start", async () => {
  const state = fixture();
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, { startedAt: "2026-08-04T10:00:00.000Z" }, "turn-1");

  state.service.update(run, {
    answer: "Partial",
    reasoning: "Reasoning",
    stage: "Stage",
    startedAt: "2026-08-04T09:00:00.000Z",
    userMessages: [{ text: "Question", clientUserMessageId: "message-1" }],
    activityAtMs: 500,
  });

  assert.equal(run.responseText, "Partial");
  assert.equal(run.promptPreview, "Question");
  assert.equal(run.clientUserMessageId, "message-1");
  assert.equal(run.startedAt, "2026-08-04T09:00:00.000Z");
  assert.equal(run.progressStage, "Stage");
});

test("TaskObservationService completes an explicitly displayed observed run", async () => {
  const state = fixture();
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, {}, "turn-1");
  run.displayRequested = true;

  await state.service.finish(run, {
    turnId: "turn-1",
    completed: true,
    answer: "Final",
    stage: "Done",
  });

  assert.equal(state.completed.length, 1);
  assert.equal(state.completed[0][0], "observed");
  assert.equal(state.completed[0][2].answer, "Final");
  assert.equal(state.completed[0][2].deliver, true);
});

test("TaskObservationService closes stale activity without delivering a partial answer", async () => {
  const state = fixture({ now: 10 * 60_000 });
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, {}, "turn-1");

  await state.service.finishUnknown(run, { activityAtMs: 5 * 60_000, answer: "Partial" });

  assert.match(run.progressStage, /нет новых событий 5 мин/);
  assert.equal(state.completed.length, 0);
  assert.equal(state.currentRun(), null);
});
