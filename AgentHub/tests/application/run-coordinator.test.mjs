import assert from "node:assert/strict";
import test from "node:test";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const run = { id: "run-1", provider: "codex", threadId: "thread-1" };
  const target = {
    provider: "codex",
    projectRoot: "C:\\Project",
    threadId: "thread-1",
    taskTitle: "Task",
    chatId: 84,
  };
  const values = {
    calls,
    run,
    target,
    taskRuns: { forTask: () => null },
    providers: {
      call: async (...args) => {
        calls.push(["provider", ...args]);
        return { providerResult: true };
      },
    },
    externalActivity: async () => ({ state: "inactive", executionOwner: null }),
    repositoryConflict: async () => null,
    deferInput: async (...args) => {
      calls.push(["defer", ...args]);
      return { deferred: true, id: "deferred-1" };
    },
    beginRun: async (...args) => {
      calls.push(["begin", ...args]);
      return run;
    },
    launchTurn: async (...args) => { calls.push(["launch", ...args]); },
    describeAttachments: (files) => files.map((file) => ({ id: file })),
    notifyInputStart: (value) => calls.push(["notify", value]),
    ...overrides,
  };
  values.coordinator = new RunCoordinator(values);
  return values;
}

test("RunCoordinator launches one idle task and preserves durable attachments", async () => {
  const f = fixture();
  const result = await f.coordinator.start("message", ["image.png"], {
    target: f.target,
    persistentFiles: true,
    forceSpeechButton: true,
  });
  assert.equal(result.started, true);
  assert.equal(result.run, f.run);
  assert.deepEqual(f.run.messageAttachments, [{ id: "image.png" }]);
  assert.deepEqual(f.calls.map(([name]) => name), ["notify", "begin", "launch"]);
  assert.deepEqual(f.calls.at(-1).slice(1), [f.run, "message", [], { forceSpeechButton: true }]);
});

test("RunCoordinator defers an active task without creating a second run", async () => {
  const active = { id: "active", executionOwner: "vscode" };
  const f = fixture({ taskRuns: { forTask: () => active } });
  const result = await f.coordinator.start("message", [], { target: f.target });
  assert.equal(result.deferred, true);
  assert.deepEqual(f.calls.map(([name]) => name), ["notify", "defer"]);
  assert.equal(f.calls[1][3].executionOwner, "vscode");
  assert.equal(f.calls[1][3].conflictKind, "task-running");
});

test("RunCoordinator queues directly into a Stream under context maintenance", async () => {
  const f = fixture({ isMaintenanceActive: () => true });
  const result = await f.coordinator.submitClientInput({
    input: "next",
    target: { ...f.target, streamId: "stream-1" },
    clientUserMessageId: "message-next",
  });
  assert.equal(result.deferred, true);
  assert.equal(result.queued, true);
  assert.equal(result.reason, "context-maintenance");
  assert.equal(f.calls.some(([name]) => name === "begin"), false);
});

test("RunCoordinator keeps ordinary active intake pending for a manual action", async () => {
  const active = { id: "active", executionOwner: "hub" };
  const f = fixture({ taskRuns: { forTask: () => active } });
  const result = await f.coordinator.acceptClientInput({
    input: "next",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-next",
  });
  assert.equal(result.deferred, true);
  assert.equal(result.queued, undefined);
  assert.equal(result.reason, "task-running");
  assert.equal(f.calls.find(([name]) => name === "defer")[3].conflictKind, "task-running");
  assert.equal(f.calls.some(([name]) => name === "provider"), false);
});

test("RunCoordinator preserves an explicit queue request behind the active turn", async () => {
  const active = { id: "active", executionOwner: "hub" };
  const f = fixture({
    taskRuns: { forTask: () => active },
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "queued-1", item: { id: "queued-1" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });
  await f.coordinator.acceptClientInput({
    input: "later",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-later",
    followUpMode: "queue",
  });
  assert.equal(f.calls.find(([name]) => name === "defer")[3].conflictKind, "task-running");
  assert.deepEqual(f.calls.find(([name]) => name === "schedule").slice(1), [
    { id: "queued-1" }, 500,
  ]);
});

test("RunCoordinator immediately queues steering for a turn owned by Codex Desktop", async () => {
  const external = { id: "external", executionOwner: "desktop" };
  const f = fixture({
    taskRuns: { forTask: () => external },
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "queued-external", item: { id: "queued-external" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });

  const result = await f.coordinator.submitClientInput({
    input: "после внешнего хода",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-external",
    followUpMode: "steer",
  });

  assert.equal(result.queued, true);
  assert.equal(result.reason, "provider-thread-active");
  assert.equal(f.calls.some(([name]) => name === "provider"), false);
  assert.equal(f.calls.find(([name]) => name === "defer")[3].executionOwner, "desktop");
  assert.deepEqual(f.calls.find(([name]) => name === "schedule").slice(1), [
    { id: "queued-external" }, 500,
  ]);
});

test("RunCoordinator preserves steering when provider ownership changes during admission", async () => {
  const active = { id: "active", executionOwner: "hub" };
  const f = fixture({
    taskRuns: { forTask: () => active },
    providers: {
      call: async () => {
        throw new Error("thread thread-1 already has an active writer");
      },
    },
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "queued-race", item: { id: "queued-race" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });

  const result = await f.coordinator.submitClientInput({
    input: "не потерять при смене writer",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-race",
    followUpMode: "steer",
  });

  assert.equal(result.queued, true);
  assert.equal(result.reason, "steer-unavailable");
  assert.deepEqual(f.calls.find(([name]) => name === "schedule").slice(1), [
    { id: "queued-race" }, 500,
  ]);
});

test("RunCoordinator preserves input when Codex reports an orphaned active writer", async () => {
  const f = fixture({
    launchTurn: async () => {
      throw new Error("thread thread-1 already has an active writer");
    },
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "queued-provider", item: { id: "queued-provider" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });
  const result = await f.coordinator.submitClientInput({
    input: "keep me",
    attachments: ["image.png"],
    target: f.target,
    clientUserMessageId: "message-provider-busy",
  });
  assert.equal(result.queued, true);
  assert.equal(result.reason, "provider-thread-active");
  assert.match(result.message, /сохранено в очереди/u);
  assert.equal(f.calls.find(([name]) => name === "defer")[3].persistentFiles, true);
  assert.deepEqual(f.calls.find(([name]) => name === "schedule").slice(1), [
    { id: "queued-provider" }, 500,
  ]);
});

test("RunCoordinator preserves unknown external activity for explicit action", async () => {
  const f = fixture({
    externalActivity: async () => ({ state: "unknown", executionOwner: "external" }),
  });
  await f.coordinator.start("message", [], { target: f.target });
  assert.equal(f.calls[1][3].allowForce, true);
  assert.equal(f.calls[1][3].conflictKind, "activity-unknown");
});

test("RunCoordinator detects a registration race and defers the input", async () => {
  const concurrent = { id: "concurrent", executionOwner: "hub" };
  let reads = 0;
  const f = fixture({
    taskRuns: {
      forTask: () => (++reads === 1 ? null : concurrent),
    },
    beginRun: async () => { throw new Error("this task is already running"); },
  });
  const result = await f.coordinator.start("message", [], { target: f.target });
  assert.equal(result.deferred, true);
  assert.equal(f.calls.at(-1)[3].executionOwner, "hub");
});

test("RunCoordinator serializes competing clients in one logical task lane", async () => {
  let active = null;
  let beginCount = 0;
  const f = fixture({
    taskRuns: { forTask: () => active },
    beginRun: async () => {
      beginCount += 1;
      active = { ...f.run, executionOwner: "hub" };
      return active;
    },
  });
  const [first, second] = await Promise.all([
    f.coordinator.start("first", [], { target: { ...f.target, streamId: "stream-1" } }),
    f.coordinator.start("second", [], { target: { ...f.target, streamId: "stream-1" } }),
  ]);
  assert.equal(first.started, true);
  assert.equal(second.deferred, true);
  assert.equal(beginCount, 1);
});

test("RunCoordinator starts a durable queued item exactly once", async () => {
  const f = fixture();
  const item = {
    ...f.target,
    input: "queued",
    temporaryFiles: ["queued.png"],
    persistentFiles: true,
    forceSpeechButton: true,
    clientUserMessageId: "message-1",
    telegramDeliveryRequested: false,
    clientSource: "desktop",
  };
  const result = await f.coordinator.startDeferred(item);
  assert.equal(result, f.run);
  assert.deepEqual(f.run.messageAttachments, [{ id: "queued.png" }]);
  const beginTarget = f.calls.find(([name]) => name === "begin")[2];
  assert.equal(beginTarget.telegramDeliveryRequested, false);
  assert.equal(beginTarget.clientSource, "desktop");
  assert.deepEqual(f.calls.at(-1).slice(1), [f.run, "queued", [], { forceSpeechButton: true }]);
});

test("RunCoordinator starts a provider session before its external thread id exists", async () => {
  const f = fixture();
  const target = { ...f.target, threadId: null, taskTitle: "Новая задача Claude" };
  const result = await f.coordinator.start("new session", [], { target });
  assert.equal(result.started, true);
  assert.equal(f.calls.find(([name]) => name === "begin")[2].threadId, null);
});

test("RunCoordinator owns provider completion and recovery dispatch", async () => {
  const f = fixture();
  await f.coordinator.completeManaged(f.run, { answer: "done" });
  await f.coordinator.completeObserved(f.run, { completed: true });
  await f.coordinator.recoverProviderRun(f.run, { snapshot: true });
  assert.deepEqual(f.calls.filter(([name]) => name === "provider").map((call) => call[2]), [
    "completeManagedRun",
    "completeObservedRun",
    "recoverRun",
  ]);
});
