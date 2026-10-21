import assert from "node:assert/strict";
import test from "node:test";
import { activeTurnNotSteerable, RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { createInterstreamMessage, trustedInterstreamMessageDetails } from "../../src/domain/interstream-message.mjs";
import {
  completeCodexAgentMessage,
  hydrateCodexAgentMessages,
  startCodexAgentMessage,
} from "../../src/providers/codex/codex-agent-message-reducer.mjs";

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
    externalActivity: async () => ({
      state: "inactive",
      executionOwner: null,
      processEvidence: { complete: true, generation: 1, scannedAt: "2026-09-05T08:00:00.000Z" },
    }),
    repositoryConflict: async () => null,
    deferInput: async (...args) => {
      calls.push(["defer", ...args]);
      return { deferred: true, id: "deferred-1" };
    },
    beginRun: async (...args) => {
      calls.push(["begin", ...args]);
      return run;
    },
    rollbackAdmission: async (value) => { calls.push(["rollback", value]); },
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

test("RunCoordinator preserves exact durable steer during provider-internal compaction", async () => {
  const active = {
    id: "run-active", provider: "codex", threadId: "thread-1", turnId: "turn-active",
    status: "running", executionOwner: "hub",
  };
  const f = fixture({
    taskRuns: { forTask: () => active },
    isMaintenanceActive: () => true,
    isManagedMaintenanceActive: () => false,
  });

  const result = await f.coordinator.acceptClientInput({
    input: "уточнение во время внутренней свёртки",
    target: f.target,
    clientUserMessageId: "message-compaction-steer",
    followUpMode: "steer",
  });

  assert.equal(result.steerPending, true);
  assert.equal(result.turnId, "turn-active");
  const deferred = f.calls.find(([name]) => name === "defer")[3];
  assert.equal(deferred.conflictKind, "message-steer");
  assert.equal(deferred.steerTargetRunId, "run-active");
  assert.equal(deferred.steerTargetTurnId, "turn-active");
});

test("RunCoordinator preserves exact steer behind managed maintenance", async () => {
  for (const [label, overrides] of [
    ["maintenance", { isMaintenanceActive: () => true, isManagedMaintenanceActive: () => true }],
  ]) {
    const active = {
      id: `run-${label}`, provider: "codex", threadId: "thread-1", turnId: `turn-${label}`,
      status: "running", executionOwner: "hub",
    };
    const f = fixture({ taskRuns: { forTask: () => active }, ...overrides });

    const result = await f.coordinator.acceptClientInput({
      input: `не терять steer за барьером ${label}`,
      target: f.target,
      clientUserMessageId: `message-${label}`,
      followUpMode: "steer",
    });

    assert.equal(result.steerPending, true);
    assert.equal(result.queued, false);
    assert.equal(result.runId, `run-${label}`);
    assert.equal(result.turnId, `turn-${label}`);
    const deferred = f.calls.find(([name]) => name === "defer")[3];
    assert.equal(deferred.conflictKind, "message-steer");
    assert.equal(deferred.steerTargetRunId, `run-${label}`);
    assert.equal(deferred.steerTargetTurnId, `turn-${label}`);
    assert.equal(f.calls.some(([name]) => name === "begin" || name === "launch" || name === "provider"), false);
  }
});

test("RunCoordinator keeps ordinary input behind provider-internal compaction", async () => {
  const active = {
    id: "run-active", provider: "codex", threadId: "thread-1", turnId: "turn-active",
    status: "running", executionOwner: "hub",
  };
  const f = fixture({
    taskRuns: { forTask: () => active },
    isMaintenanceActive: () => true,
    isManagedMaintenanceActive: () => false,
  });

  const result = await f.coordinator.acceptClientInput({
    input: "следующим ходом",
    target: f.target,
    clientUserMessageId: "message-after-compaction",
    followUpMode: "queue",
  });

  assert.equal(result.reason, "context-maintenance");
  assert.equal(f.calls.find(([name]) => name === "defer")[3].conflictKind, "context-maintenance");
});

test("RunCoordinator holds durable intake only during actual runtime stopping", async () => {
  let restartPending = true;
  const f = fixture({ isRuntimeStopping: () => restartPending });
  const target = { ...f.target, streamId: "stream-1" };
  const result = await f.coordinator.acceptClientInput({
    input: "continue after cutover",
    target,
    clientUserMessageId: "message-after-restart",
  });
  assert.equal(result.deferred, true);
  assert.equal(result.queued, true);
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "runtime-restart");
  assert.equal(f.calls.some(([name]) => name === "begin"), false);

  const item = {
    ...target,
    input: "continue after cutover",
    clientUserMessageId: "message-after-restart",
  };
  await assert.rejects(
    f.coordinator.startDeferred(item),
    (error) => error?.code === "ERR_RUNTIME_RESTART_PENDING",
  );
  restartPending = false;
  await f.coordinator.startDeferred(item);
  assert.equal(f.calls.filter(([name]) => name === "begin").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "launch").length, 1);
});

test("RunCoordinator keeps ordinary active intake pending for a manual action", async () => {
  const active = { id: "active", executionOwner: "hub" };
  const f = fixture({ taskRuns: { forTask: () => active } });
  const result = await f.coordinator.acceptClientInput({
    input: "next",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-next",
    clientProjectionIntent: "conversation",
  });
  assert.equal(result.deferred, true);
  assert.equal(result.queued, undefined);
  assert.equal(result.reason, "task-running");
  assert.equal(result.clientProjectionIntent, "conversation");
  const deferredOptions = f.calls.find(([name]) => name === "defer")[3];
  assert.equal(deferredOptions.conflictKind, "task-running");
  assert.equal(deferredOptions.clientProjectionIntent, "conversation");
  assert.equal(f.calls.some(([name]) => name === "provider"), false);
});

test("RunCoordinator durably accepts idle intake before external activity checks", async () => {
  let externalChecks = 0;
  const f = fixture({
    externalActivity: async () => {
      externalChecks += 1;
      return new Promise(() => {});
    },
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "intake-1", item: { id: "intake-1" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });

  const result = await f.coordinator.acceptClientInput({
    input: "fast durable intake",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-intake",
    clientProjectionIntent: "conversation",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.providerAccepted, false);
  assert.equal(result.queued, true);
  assert.equal(result.reason, "message-intake");
  assert.match(result.message, /ход провайдера ещё не запущен/u);
  assert.equal(result.clientProjectionIntent, "conversation");
  assert.equal(externalChecks, 0);
  assert.equal(f.calls.find(([name]) => name === "defer")[3].conflictKind, "message-intake");
  assert.equal(f.calls.find(([name]) => name === "defer")[3].clientProjectionIntent, "conversation");
  assert.deepEqual(f.calls.find(([name]) => name === "schedule").slice(1), [
    { id: "intake-1" }, 0,
  ]);
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
    clientProjectionIntent: "queue",
    followUpMode: "queue",
  });
  assert.equal(f.calls.find(([name]) => name === "defer")[3].conflictKind, "task-running");
  assert.equal(f.calls.find(([name]) => name === "defer")[3].clientProjectionIntent, "queue");
  assert.deepEqual(f.calls.find(([name]) => name === "schedule").slice(1), [
    { id: "queued-1" }, 500,
  ]);
});

test("RunCoordinator keeps durable intake automatic while terminal delivery is finishing", async () => {
  const active = {
    id: "run-finishing",
    provider: "codex",
    streamId: "stream-1",
    threadId: "thread-1",
    status: "finishing",
    executionOwner: "hub",
  };
  const f = fixture({
    taskRuns: { forTask: () => active },
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "queued-finishing", item: { id: "queued-finishing" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });

  const result = await f.coordinator.acceptClientInput({
    input: "next message",
    target: { provider: "codex", streamId: "stream-1", threadId: "thread-1" },
    clientUserMessageId: "client-next",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.queued, true);
  assert.equal(result.reason, "message-intake");
  assert.equal(f.calls.find(([name]) => name === "defer")[3].destination, "queued");
  assert.equal(f.calls.find(([name]) => name === "defer")[3].conflictKind, "message-intake");
  assert.deepEqual(f.calls.find(([name]) => name === "schedule").slice(1), [
    { id: "queued-finishing" }, 0,
  ]);
});

test("RunCoordinator preserves exact steer intent while terminal delivery is finishing", async () => {
  const active = {
    id: "run-finishing",
    provider: "codex",
    streamId: "stream-1",
    threadId: "thread-1",
    turnId: "turn-finishing",
    status: "finishing",
    executionOwner: "hub",
  };
  const f = fixture({
    taskRuns: { forTask: () => active },
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "steer-finishing", item: { id: "steer-finishing" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });

  const result = await f.coordinator.acceptClientInput({
    input: "exact finishing steer",
    target: { provider: "codex", streamId: "stream-1", threadId: "thread-1" },
    clientUserMessageId: "client-finishing-steer",
    followUpMode: "steer",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.steerPending, true);
  assert.equal(result.queued, false);
  assert.equal(result.runId, "run-finishing");
  assert.equal(result.turnId, "turn-finishing");
  const deferred = f.calls.find(([name]) => name === "defer")[3];
  assert.equal(deferred.conflictKind, "message-steer");
  assert.equal(deferred.steerTargetRunId, "run-finishing");
  assert.equal(deferred.steerTargetTurnId, "turn-finishing");
  assert.equal(f.calls.some(([name]) => name === "begin" || name === "launch" || name === "provider"), false);
});

test("RunCoordinator returns a durable same-id result without scheduling another effect", async () => {
  const f = fixture({
    deferInput: async () => ({
      duplicate: true,
      item: null,
      durableResult: {
        accepted: true,
        completed: true,
        turnId: "turn-existing",
      },
    }),
    scheduleDeferred: () => assert.fail("durable retry must not schedule a second effect"),
  });

  const result = await f.coordinator.acceptClientInput({
    input: "lost ACK retry",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-existing",
  });

  assert.equal(result.duplicate, true);
  assert.equal(result.completed, true);
  assert.equal(result.turnId, "turn-existing");
});

test("RunCoordinator acknowledges queued intake while turn launch is still pending", async () => {
  let active = null;
  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  const f = fixture({
    taskRuns: { forTask: () => active },
    beginRun: async () => {
      active = { ...f.run, executionOwner: "hub" };
      return active;
    },
    launchTurn: async () => launchGate,
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "queued-during-launch", item: { id: "queued-during-launch" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });

  const launch = f.coordinator.start("current", [], { target: f.target });
  await new Promise((resolve) => setImmediate(resolve));
  const intake = f.coordinator.acceptClientInput({
    input: "next",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-during-launch",
    followUpMode: "queue",
  });
  const state = await Promise.race([
    intake.then((result) => ({ status: "accepted", result })),
    new Promise((resolve) => setImmediate(() => resolve({ status: "blocked" }))),
  ]);

  assert.equal(state.status, "accepted");
  assert.equal(state.result.queued, true);
  assert.equal(state.result.id, "queued-during-launch");
  releaseLaunch();
  await launch;
});

test("RunCoordinator preserves FIFO queue for burst intake before running snapshot", async () => {
  let active = null;
  let sequence = 0;
  const scheduled = [];
  const f = fixture({
    taskRuns: { forTask: () => active },
    deferInput: async (input, _attachments, options) => {
      const item = { id: `burst-${++sequence}`, input, conflictKind: options.conflictKind };
      f.calls.push(["defer", input, [], options]);
      return { id: item.id, item };
    },
    scheduleDeferred: (item, delay) => {
      scheduled.push({ item, delay });
      if (scheduled.length === 1) active = { ...f.run, executionOwner: "hub" };
    },
  });

  const results = await Promise.all(["first", "second", "third"].map((input, index) => (
    f.coordinator.acceptClientInput({
      input,
      target: f.target,
      clientUserMessageId: `burst-client-${index + 1}`,
      followUpMode: "queue",
    })
  )));

  assert.deepEqual(scheduled.map(({ item }) => item.input), ["first", "second", "third"]);
  assert.deepEqual(scheduled.map(({ delay }) => delay), [0, 500, 500]);
  assert.equal(results.every((result) => result.deferred && result.queued), true);
  assert.equal(results.some((result) => result.reason === "task-running" && !result.queued), false);
  assert.deepEqual(
    f.calls.filter(([name]) => name === "defer").map((call) => call[3].conflictKind),
    ["message-intake", "task-running", "task-running"],
  );
  assert.equal(
    f.calls.filter(([name]) => name === "defer").every((call) => call[3].destination === "queued"),
    true,
  );
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

test("RunCoordinator recognizes an App Server active-turn identity conflict", () => {
  assert.equal(activeTurnNotSteerable(
    new Error("expected active turn id 'turn-old' but found 'turn-new'"),
  ), true);
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

test("RunCoordinator rolls back admission before queueing an active writer", async () => {
  const activeRuns = new Map();
  const f = fixture({
    taskRuns: { forTask: (target) => activeRuns.get(target.threadId) ?? null },
    beginRun: async (...args) => {
      f.calls.push(["begin", ...args]);
      activeRuns.set(f.target.threadId, f.run);
      return f.run;
    },
    launchTurn: async () => {
      throw new Error("thread thread-1 already has an active writer");
    },
    rollbackAdmission: async (run) => {
      f.calls.push(["rollback", run]);
      activeRuns.delete(run.threadId);
    },
    deferInput: async (...args) => {
      assert.equal(activeRuns.get(f.target.threadId), undefined);
      f.calls.push(["defer", ...args]);
      return { id: "queued-after-rollback", item: { id: "queued-after-rollback" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });

  const result = await f.coordinator.submitClientInput({
    input: "queue after rollback",
    target: f.target,
    clientUserMessageId: "message-rollback",
  });

  assert.equal(result.queued, true);
  assert.deepEqual(f.calls.map(([name]) => name), ["begin", "rollback", "defer", "schedule"]);
});

test("RunCoordinator preserves unknown external activity for explicit action", async () => {
  const f = fixture({
    externalActivity: async () => ({ state: "unknown", executionOwner: "external" }),
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "activity-unknown", item: { id: "activity-unknown" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });
  await f.coordinator.start("message", [], { target: f.target });
  assert.equal(f.calls[1][3].allowForce, true);
  assert.equal(f.calls[1][3].conflictKind, "activity-unknown");
  assert.deepEqual(f.calls[2], ["schedule", { id: "activity-unknown" }, undefined]);
});

test("RunCoordinator defers when the common Claude lifecycle admission rejects a live owner", async () => {
  const f = fixture({
    beginRun: async () => {
      const error = new Error("Claude external owner is active.");
      error.code = "ERR_CLAUDE_EXTERNAL_OWNER_ACTIVE";
      throw error;
    },
    deferInput: async (...args) => ({ deferred: true, item: { id: "deferred-live" }, args }),
  });
  const result = await f.coordinator.start("queued", [], { target: {
    ...f.target,
    provider: "claude",
    streamId: "stream-1",
  } });
  assert.equal(result.deferred, true);
  assert.equal(result.args[2].conflictKind, "task-running");
  assert.equal(f.calls.some(([name]) => name === "launch"), false);
});

test("RunCoordinator preserves the lifecycle-bound Claude proof through launch", async () => {
  const proof = Object.freeze({
    sessionId: "thread-1",
    generation: 12,
    scannedAt: "2026-09-05T08:00:02.000Z",
    requestedAfterMs: 12_345,
  });
  let launchedRun;
  const f = fixture({
    beginRun: async (_input, target) => ({ ...f.run, ...target, externalOwnerProof: proof }),
    launchTurn: async (run) => { launchedRun = run; },
  });
  await f.coordinator.startDeferred({
    ...f.target,
    provider: "claude",
    streamId: "stream-1",
    input: "queued",
    clientUserMessageId: "message-proof",
  });
  assert.equal(launchedRun.externalOwnerProof, proof);
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

test("RunCoordinator acknowledges durable steer within 250ms without awaiting the provider", async () => {
  const active = { id: "active", turnId: "turn-1", executionOwner: "hub" };
  const f = fixture({
    taskRuns: { forTask: () => active },
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return {
        id: "durable-steer",
        item: { id: "durable-steer", clientUserMessageId: "message-steer" },
      };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });

  const startedAt = performance.now();
  const result = await f.coordinator.acceptClientInput({
    input: "уточнение",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-steer",
    followUpMode: "steer",
  });
  const acknowledgementMs = performance.now() - startedAt;

  assert.ok(acknowledgementMs < 250, `durable steer ACK took ${acknowledgementMs}ms`);
  assert.equal(result.accepted, true);
  assert.equal(result.steerPending, true);
  assert.equal(result.turnId, "turn-1");
  assert.equal(f.calls.some(([name]) => name === "provider"), false);
  assert.equal(f.calls.find(([name]) => name === "defer")[3].conflictKind, "message-steer");
  assert.equal(f.calls.find(([name]) => name === "defer")[3].steerTargetRunId, "active");
  assert.equal(f.calls.find(([name]) => name === "defer")[3].steerTargetTurnId, "turn-1");
  assert.deepEqual(f.calls.find(([name]) => name === "schedule").slice(1), [
    { id: "durable-steer", clientUserMessageId: "message-steer" }, 0,
  ]);
});

test("RunCoordinator keeps provider-authoritative steer admission after a Codex final marker", async () => {
  const active = {
    id: "active",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "running",
    executionOwner: "hub",
    responseItems: [{
      id: "answer-1",
      type: "agentMessage",
      phase: "final_answer",
      turnId: "turn-1",
      status: "inProgress",
    }],
  };
  const f = fixture({
    taskRuns: { forTask: () => active },
    deferInput: async (...args) => {
      f.calls.push(["defer", ...args]);
      return { id: "queued-after-final", item: { id: "queued-after-final" } };
    },
    scheduleDeferred: (item, delay) => f.calls.push(["schedule", item, delay]),
  });

  const result = await f.coordinator.acceptClientInput({
    input: "следующий вопрос",
    attachments: [],
    target: f.target,
    clientUserMessageId: "message-after-final",
    messageFingerprint: "fingerprint-after-final",
    followUpMode: "steer",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.queued, false);
  assert.equal(result.steerPending, true);
  assert.equal(f.calls.some(([name]) => name === "provider"), false);
  assert.equal(f.calls.find(([name]) => name === "defer")[3].conflictKind, "message-steer");
  assert.equal(f.calls.find(([name]) => name === "defer")[3].clientUserMessageId, "message-after-final");
  assert.deepEqual(f.calls.find(([name]) => name === "schedule").slice(1), [
    { id: "queued-after-final" }, 0,
  ]);
  const steered = await f.coordinator.steer({
    input: "следующий вопрос",
    target: { ...f.target, steerTargetRunId: "active", steerTargetTurnId: "turn-1" },
    clientUserMessageId: "message-after-final",
  });
  assert.equal(steered.steered, true);
  assert.equal(f.calls.filter(([name]) => name === "provider").length, 1);
});

for (const observation of ["started", "completed", "hydrated", "late-question-metadata"]) {
  test(`RunCoordinator keeps async questions steerable after ${observation}`, async () => {
    const active = {
      id: "active", provider: "codex", threadId: "thread-1", turnId: "turn-1",
      status: "running", executionOwner: "hub",
    };
    const item = {
      id: "question-1", type: "agentMessage", phase: "final_answer", text: "Choose",
      questions: [{ title: "Which option?", options: ["A", "B"] }],
    };
    if (observation === "started") startCodexAgentMessage(active, { turnId: active.turnId, item });
    else if (observation === "completed") completeCodexAgentMessage(active, { turnId: active.turnId, item });
    else if (observation === "hydrated") hydrateCodexAgentMessages(active, [item], { turnId: active.turnId });
    else {
      startCodexAgentMessage(active, { turnId: active.turnId, item: { ...item, questions: undefined } });
      completeCodexAgentMessage(active, { turnId: active.turnId, item });
    }
    const f = fixture({ taskRuns: { forTask: () => active } });
    const admission = await f.coordinator.acceptClientInput({
      input: "B", target: f.target, clientUserMessageId: "answer-command", followUpMode: "steer",
    });
    assert.equal(admission.steerPending, true);
    assert.equal(admission.queued, false);
    const deferred = f.calls.find(([name]) => name === "defer")[3];
    assert.equal(deferred.conflictKind, "message-steer");
    assert.equal(deferred.steerTargetRunId, active.id);
    assert.equal(deferred.steerTargetTurnId, active.turnId);
    const result = await f.coordinator.steer({
      input: "B", clientUserMessageId: "answer-command",
      target: { ...f.target, steerTargetRunId: deferred.steerTargetRunId, steerTargetTurnId: deferred.steerTargetTurnId },
    });
    assert.equal(result.steered, true);
    const calls = f.calls.filter(([name]) => name === "provider");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], "steerTurn");
    assert.equal(calls[0][3].clientUserMessageId, "answer-command");
    assert.equal(calls[0][3].run.turnId, "turn-1");
  });
}

test("RunCoordinator leaves exact provider steer authoritative after genuine final-answer observations", async () => {
  for (const questions of [undefined, [], null]) {
    const active = {
      id: "active", provider: "codex", threadId: "thread-1", turnId: "turn-1",
      status: "running", executionOwner: "hub",
    };
    startCodexAgentMessage(active, { turnId: active.turnId, item: {
      id: "final-1", type: "agentMessage", phase: "final_answer", text: "Actual final", questions,
    } });
    completeCodexAgentMessage(active, { turnId: active.turnId, item: {
      id: "question-1", type: "agentMessage", phase: "final_answer", text: "Choose",
      questions: [{ title: "Which option?", options: ["A", "B"] }],
    } });
    const f = fixture({ taskRuns: { forTask: () => active } });
    const admission = await f.coordinator.acceptClientInput({
      input: "B", target: f.target, clientUserMessageId: "answer-command", followUpMode: "steer",
    });
    assert.equal(admission.steerPending, true);
    assert.equal(admission.queued, false);
    const result = await f.coordinator.steer({
      input: "B", clientUserMessageId: "answer-command",
      target: { ...f.target, steerTargetRunId: active.id, steerTargetTurnId: active.turnId },
    });
    assert.equal(result.steered, true);
    assert.equal(f.calls.filter(([name]) => name === "provider").length, 1);
  }
});

test("RunCoordinator dispatches to the provider when final starts after steer admission", async () => {
  const active = {
    id: "active", provider: "codex", threadId: "thread-1", turnId: "turn-1",
    status: "running", executionOwner: "hub",
  };
  completeCodexAgentMessage(active, { turnId: active.turnId, item: {
    id: "question-1", type: "agentMessage", phase: "final_answer", text: "Choose",
    questions: [{ title: "Which option?", options: ["A", "B"] }],
  } });
  const f = fixture({ taskRuns: { forTask: () => active } });
  const admission = await f.coordinator.acceptClientInput({
    input: "B", target: f.target, clientUserMessageId: "answer-command", followUpMode: "steer",
  });
  assert.equal(admission.steerPending, true);
  startCodexAgentMessage(active, { turnId: active.turnId, item: {
    id: "final-after-question", type: "agentMessage", phase: "final_answer", text: "",
  } });
  const result = await f.coordinator.steer({
    input: "B", clientUserMessageId: "answer-command",
    target: { ...f.target, steerTargetRunId: active.id, steerTargetTurnId: active.turnId },
  });
  assert.equal(result.steered, true);
  assert.equal(f.calls.filter(([name]) => name === "provider").length, 1);
});

test("RunCoordinator keeps exact Codex commentary steering available", async () => {
  const active = {
    id: "active",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "running",
    executionOwner: "hub",
    responseItems: [{
      id: "commentary-1",
      type: "agentMessage",
      phase: "commentary",
      turnId: "turn-1",
      status: "inProgress",
    }],
  };
  const f = fixture({ taskRuns: { forTask: () => active } });

  const result = await f.coordinator.steer({
    input: "уточнение",
    target: {
      ...f.target,
      steerTargetRunId: "active",
      steerTargetTurnId: "turn-1",
    },
    clientUserMessageId: "message-commentary",
  });

  assert.equal(result.steered, true);
  assert.equal(f.calls.filter(([name]) => name === "provider").length, 1);
});

test("RunCoordinator keeps the provider envelope out of a live interstream steer card", async () => {
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-release-manager",
    streamName: "Release Manager",
    provider: "codex",
    sourceThreadId: "thread-release-manager",
    requestId: "steer-1",
  };
  const input = createInterstreamMessage({ ...origin, text: "Проверь текущий ход." });
  const active = {
    id: "active",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "running",
    executionOwner: "hub",
    userMessages: [],
  };
  const f = fixture({ taskRuns: { forTask: () => active } });

  await f.coordinator.steer({
    input,
    target: {
      ...f.target,
      messageOrigin: origin,
      steerTargetRunId: "active",
      steerTargetTurnId: "turn-1",
    },
    clientUserMessageId: "mcp:steer-1",
  });

  assert.equal(f.calls.find(([name]) => name === "provider")[3].input, input);
  assert.equal(active.userMessages[0].text, "Проверь текущий ход.");
  assert.deepEqual(active.userMessages[0].origin, origin);
});

test("RunCoordinator preserves interstream metadata when the provider user event wins the steer race", async () => {
  const origin = { kind: "interstream", workspaceId: "workspace-1", workspaceName: "Hub", streamId: "source-stream",
    streamName: "S3", provider: "claude", sourceThreadId: "source-thread", requestId: "race-1" };
  const input = createInterstreamMessage({ ...origin, text: "Патч готов." });
  for (const scenario of ["event-first", "other-client", "conflicting-origin", "duplicate-client"]) {
    const active = { id: "active", provider: "codex", threadId: "thread-1", turnId: "turn-1",
      status: "running", executionOwner: "hub", userMessages: [] };
    const clientUserMessageId = "mcp:race-1";
    const f = fixture({ taskRuns: { forTask: () => active }, providers: { call: async () => {
      active.userMessages.push({ role: "user", itemId: "provider-user-1", text: input,
        clientUserMessageId: scenario === "other-client" ? "another-client" : clientUserMessageId,
        ...(scenario === "conflicting-origin" ? { origin: { ...origin, requestId: "conflict" } } : {}) });
      if (scenario === "duplicate-client") active.userMessages.push({ ...active.userMessages[0], itemId: "provider-user-2" });
      return {};
    } } });
    await f.coordinator.steer({ input, target: { ...f.target, messageOrigin: origin, steerTargetRunId: active.id,
      steerTargetTurnId: active.turnId }, clientUserMessageId });
    const first = active.userMessages[0];
    assert.equal(first.text, input);
    if (scenario === "event-first") {
      assert.equal(active.userMessages.length, 1);
      assert.deepEqual(first.origin, origin);
      assert.equal(trustedInterstreamMessageDetails(first.text, { origin: first.origin, clientUserMessageId }).text, "Патч готов.");
    } else if (scenario === "conflicting-origin") assert.equal(first.origin.requestId, "conflict");
    else assert.equal(first.origin, undefined);
  }
});

test("RunCoordinator ignores final-answer markers outside the exact Codex run identity", async () => {
  for (const active of [{
    id: "active-codex",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "running",
    executionOwner: "hub",
    responseItems: [{
      id: "answer-other",
      type: "agentMessage",
      phase: "final_answer",
      turnId: "turn-other",
      status: "inProgress",
    }],
  }, {
    id: "active-claude",
    provider: "claude",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "running",
    executionOwner: "hub",
    responseItems: [{
      id: "answer-claude",
      type: "agentMessage",
      phase: "final_answer",
      turnId: "turn-1",
      status: "inProgress",
    }],
  }]) {
    const f = fixture({ taskRuns: { forTask: () => active } });
    const result = await f.coordinator.steer({
      input: "уточнение",
      target: {
        ...f.target,
        provider: active.provider,
        steerTargetRunId: active.id,
        steerTargetTurnId: active.turnId,
      },
      clientUserMessageId: `message-${active.provider}`,
    });
    assert.equal(result.steered, true);
    assert.equal(f.calls.filter(([name]) => name === "provider").length, 1);
  }
});

test("RunCoordinator asks the provider when the exact final starts before dispatch", async () => {
  const active = {
    id: "active",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "running",
    executionOwner: "hub",
    responseItems: [{
      id: "commentary-1",
      type: "agentMessage",
      phase: "commentary",
      turnId: "turn-1",
      status: "inProgress",
    }],
  };
  const f = fixture({ taskRuns: { forTask: () => active } });
  active.responseItems.push({
    id: "answer-1",
    type: "agentMessage",
    phase: "final_answer",
    turnId: "turn-1",
    status: "inProgress",
  });

  const result = await f.coordinator.steer({
    input: "не прерывать финал",
    target: {
      ...f.target,
      steerTargetRunId: "active",
      steerTargetTurnId: "turn-1",
    },
    clientUserMessageId: "message-final-race",
  });
  assert.equal(result.steered, true);
  assert.equal(f.calls.filter(([name]) => name === "provider").length, 1);
});

test("RunCoordinator rejects a durable steer after its exact managed turn changes", async () => {
  const active = { id: "run-new", turnId: "turn-new", executionOwner: "hub" };
  const f = fixture({ taskRuns: { forTask: () => active } });

  await assert.rejects(f.coordinator.steer({
    input: "late steer",
    target: {
      ...f.target,
      steerTargetRunId: "run-old",
      steerTargetTurnId: "turn-old",
    },
    clientUserMessageId: "message-late-steer",
  }), /targeted managed turn is no longer active/u);
  assert.equal(f.calls.some(([name]) => name === "provider"), false);
});

test("RunCoordinator admits two exact Threads in one Stream independently", async () => {
  const releases = new Map();
  let beginCount = 0;
  const f = fixture({
    beginRun: async (_input, target) => {
      beginCount += 1;
      return { id: `run-${target.threadId}`, ...target };
    },
    launchTurn: async (run) => new Promise((resolve) => releases.set(run.threadId, resolve)),
  });
  const first = f.coordinator.start("first", [], {
    target: { ...f.target, streamId: "stream-1", threadId: "thread-1" },
  });
  const second = f.coordinator.start("second", [], {
    target: { ...f.target, streamId: "stream-1", threadId: "thread-2" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(beginCount, 2);
  releases.get("thread-1")();
  releases.get("thread-2")();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.started), [true, true]);
});

test("RunCoordinator ignores a completed run still indexed for delivery repair", async () => {
  const completed = { id: "completed", status: "completed", executionOwner: "hub" };
  const f = fixture({ taskRuns: { forTask: () => completed } });

  const result = await f.coordinator.start("next", [], { target: f.target });

  assert.equal(result.started, true);
  assert.deepEqual(f.calls.map(([name]) => name), ["notify", "begin", "launch"]);
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

test("RunCoordinator durably binds a provisional command before admission", async () => {
  const bindings = [];
  const f = fixture({
    rekeyDeferredOccupancy: async (binding) => {
      bindings.push(binding);
      return {
        changed: true,
        record: {
          item: {
            ...binding.target,
            occupancyKey: "stream\0stream-1\0codex\0thread-1",
            occupancyBinding: "exact",
          },
        },
      };
    },
  });
  const item = {
    ...f.target,
    streamId: "stream-1",
    clientUserMessageId: "message-rekey",
    occupancyKey: "stream\0stream-1",
    occupancyBinding: "provisional",
    input: "bind me",
  };

  await f.coordinator.startDeferred(item);

  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].expectedOccupancyKey, "stream\0stream-1");
  assert.equal(item.occupancyBinding, "exact");
  assert.equal(f.calls.findIndex(([name]) => name === "begin") > -1, true);
});

test("RunCoordinator rolls back a queued launch when context maintenance wins admission", async () => {
  let maintenanceChecks = 0;
  const f = fixture({
    isMaintenanceActive: () => {
      maintenanceChecks += 1;
      return maintenanceChecks > 1;
    },
  });
  const item = {
    ...f.target,
    streamId: "stream-1",
    input: "must wait for measurement",
    clientUserMessageId: "message-maintenance-race",
  };

  await assert.rejects(
    f.coordinator.startDeferred(item),
    (error) => error?.code === "ERR_CONTEXT_MAINTENANCE_ACTIVE",
  );

  assert.deepEqual(f.calls.map(([name]) => name), ["begin", "rollback"]);
});

test("RunCoordinator restores interstream identity from a durable queued item", async () => {
  const f = fixture();
  const messageOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "codex",
    model: "Sol",
  };
  await f.coordinator.startDeferred({
    ...f.target,
    input: "queued interstream",
    messageOrigin,
  });

  const beginTarget = f.calls.find(([name]) => name === "begin")[2];
  assert.deepEqual(beginTarget.messageOrigin, messageOrigin);
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
