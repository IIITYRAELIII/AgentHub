import assert from "node:assert/strict";
import test from "node:test";
import { CodexRecoveryService } from "../../../src/providers/provider-recovery-services.mjs";
import { ProviderCancellationService } from "../../../src/providers/provider-turn-services.mjs";

function fixture(overrides = {}, recoveryOverrides = {}) {
  const calls = [];
  const run = { provider: "codex", id: "run-original", threadId: "thread-original",
    turnId: "turn-original", clientUserMessageId: "message-original", status: "running",
    responseText: "Retained partial answer" };
  let current = run;
  let insideThreadRead = false;
  const snapshot = { turnId: run.turnId, completed: false, active: false,
    activityUnknown: true, status: "unknown", answer: run.responseText };
  const cancellation = new ProviderCancellationService({
    interruptCodex: async (value) => {
      assert.equal(value, run); calls.push("interrupt-original");
      throw new Error("no active turn");
    },
    runForTask: () => current,
    completeRun: async () => { calls.push("release"); current = null; },
    readCodexSnapshot: async () => snapshot,
    finishObserved: async () => assert.fail("Managed original only"),
    completeManaged: async (value, { snapshot: terminal }) => {
      assert.equal(value, run);
      assert.equal(terminal.turnId, run.turnId);
      calls.push(["commit", terminal.status, terminal.answer]);
      current = null;
    },
    taskExternalActivity: async (_value, options) => {
      assert.equal(insideThreadRead, false, "Fresh read cannot reenter the held Thread lane");
      assert.equal(options.forceFresh, true);
      calls.push("fresh-activity"); return { state: "inactive" };
    },
    stopClaudeRun: async () => assert.fail("No foreign process stop"),
    processIsAlive: () => false, claudeCancellationKey: () => "",
    saveState: async () => {}, ...overrides,
  });
  const recovery = new CodexRecoveryService({
    transportRunning: () => true, readTaskSnapshot: async () => snapshot,
    startTransport: async () => {}, initialize: async () => {}, isCodex: () => true,
    finishInterrupted: async () => assert.fail("Use canonical cancellation owner"),
    readThread: async (_id, { applySnapshot }) => {
      insideThreadRead = true;
      try {
        return await applySnapshot({ thread: { status: { type: "idle" },
          turns: [{ id: run.turnId, status: "interrupted", items: [] }] } });
      } finally { insideThreadRead = false; }
    },
    recoverInactiveRun: (...args) => cancellation.recoverCodex(...args),
    autoApprove: () => false, restartRequested: () => false,
    finishProgress: async () => {}, completeRun: async () => assert.fail("No direct release"),
    recoveredAnswer: () => "", setProgressStage: () => {},
    launchTurn: async () => assert.fail("Original prompt cannot be replayed"),
    reindexRun: () => {}, scheduleObservedRun: () => calls.push("observe"),
    startTyping: () => {}, saveState: async () => {}, telegram: async () => {},
    consumeTracker: () => null, finalizeDelivery: async () => assert.fail("No fabricated success"),
    turnTokenUsage: new Map(),
    ...recoveryOverrides,
  });
  return { run, calls, recovery, cancellation, current: () => current,
    replace: () => { current = { ...run, id: "replacement", turnId: "turn-new" }; } };
}

test("startup reconciles a provider-rejected inactive original through the cancellation owner", async () => {
  const f = fixture();
  await f.recovery.recover(f.run);
  assert.deepEqual(f.calls, ["fresh-activity", "interrupt-original", "fresh-activity",
    ["commit", "interrupted", "Retained partial answer"]]);
  assert.equal(f.current(), null);
});

test("active or unknown process authority never sends an automatic interrupt", async () => {
  for (const state of ["active", "unknown"]) {
    const f = fixture({ taskExternalActivity: async () => ({ state }) });
    await f.recovery.recover(f.run);
    assert.deepEqual(f.calls, ["observe"]);
    assert.equal(f.current(), f.run);
  }
});

test("a transport failure never becomes an automatic recovery terminal", async () => {
  const f = fixture({ interruptCodex: async () => { throw new Error("transport lost"); } });
  await f.recovery.recover(f.run);
  assert.deepEqual(f.calls, ["fresh-activity", "observe"]);
  assert.equal(f.current(), f.run);
});

test("missing or failed snapshot and terminal persistence preserve admission", async () => {
  for (const overrides of [
    { readCodexSnapshot: async () => null },
    { readCodexSnapshot: async () => { throw new Error("read unavailable"); } },
    { readCodexSnapshot: async () => ({ turnId: "foreign", completed: false }) },
    { completeManaged: async () => { throw new Error("durable commit unavailable"); } },
  ]) {
    const f = fixture(overrides);
    await f.recovery.recover(f.run);
    assert.equal(f.current(), f.run);
    assert.equal(f.calls.includes("release"), false);
    assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === "commit"), false);
  }
});

test("replacement during the provider check cannot be completed or interrupted", async () => {
  let f;
  f = fixture({ taskExternalActivity: async () => { f.replace(); return { state: "inactive" }; } });
  await f.recovery.recover(f.run);
  assert.equal(f.current().id, "replacement");
  assert.deepEqual(f.calls, ["observe"]);
});

test("concurrent recovery shares one exact interrupt and one terminal commit", async () => {
  const f = fixture();
  await Promise.all([f.recovery.recover(f.run), f.recovery.recover(f.run)]);
  assert.equal(f.calls.filter(x => x === "interrupt-original").length, 1);
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === "commit").length, 1);
});

test("an accepted interrupt waits for its real terminal event", async () => {
  const f = fixture({ interruptCodex: async () => {} });
  await f.recovery.recover(f.run);
  assert.deepEqual(f.calls, ["fresh-activity", "observe"]);
  assert.equal(f.current(), f.run);
});

test("activity starting again after the exact snapshot preserves admission", async () => {
  let checks = 0;
  const f = fixture({ taskExternalActivity: async () => ({ state: ++checks === 1 ? "inactive" : "active" }) });
  await f.recovery.recover(f.run);
  assert.deepEqual(f.calls, ["interrupt-original", "observe"]);
  assert.equal(f.current(), f.run);
});

test("observer, missing original command and active Thread do not enter recovery cancellation", async () => {
  for (const mode of ["observer", "missing-command", "unconfirmed-start", "active-thread"]) {
    const f = fixture({}, mode === "active-thread" ? { readThread: async (_id, { applySnapshot }) =>
      applySnapshot({ thread: { status: { type: "active" }, turns: [
        { id: "turn-original", status: "interrupted", items: [] },
      ] } }) } : {});
    if (mode === "observer") f.run.observer = true;
    if (mode === "missing-command") delete f.run.clientUserMessageId;
    if (mode === "unconfirmed-start") f.run.providerStart = { state: "unconfirmed" };
    await f.recovery.recover(f.run);
    assert.deepEqual(f.calls, ["observe"]);
    assert.equal(f.current(), f.run);
  }
});

test("ordinary Stop cannot release an original whose snapshot or terminal write failed", async () => {
  for (const override of [
    { readCodexSnapshot: async () => null },
    { readCodexSnapshot: async () => ({ turnId: "foreign", completed: true }) },
    { readCodexSnapshot: async () => { throw new Error("read failed"); } },
    { completeManaged: async () => { throw new Error("commit failed"); } },
  ]) {
    const f = fixture({ taskExternalActivity: async () => ({ state: "inactive" }), ...override });
    const result = await f.cancellation.cancelCodex(f.run);
    assert.equal(result.accepted, false);
    assert.equal(f.current(), f.run);
    assert.equal(f.calls.includes("release"), false);
  }
});

function retainedInProgressThread(run) {
  return { thread: { status: { type: "idle" }, turns: [
    { id: run.turnId, status: "inProgress", items: [] },
  ] } };
}

test("reconnect reconciles the accepted inProgress original only after fresh inactivity and exact interrupt rejection", async () => {
  let f;
  f = fixture({}, { readThread: async (_id, { applySnapshot }) => applySnapshot(retainedInProgressThread(f.run)) });
  f.run.executionOwner = "hub";
  f.run.providerStart = { state: "observed", turnId: f.run.turnId };
  const originalId = f.run.clientUserMessageId;
  await f.recovery.recover(f.run);
  assert.deepEqual(f.calls, ["fresh-activity", "interrupt-original", "fresh-activity",
    ["commit", "interrupted", "Retained partial answer"]]);
  assert.equal(f.current(), null);
  assert.equal(f.run.clientUserMessageId, originalId);
});

test("an inconclusive recovery read does not permanently suppress later authoritative recovery", async () => {
  let known = false;
  const f = fixture({ taskExternalActivity: async () => ({ state: known ? "inactive" : "unknown" }) });
  await f.recovery.recover(f.run);
  assert.equal(f.current(), f.run);
  known = true;
  await f.recovery.recover(f.run);
  assert.equal(f.current(), null);
  assert.equal(f.calls.filter(x => x === "interrupt-original").length, 1);
});

test("retained inProgress recovery preserves live, external, unknown and mismatched acceptance owners", async () => {
  for (const variant of ["active", "unknown", "external", "missing-acceptance", "foreign-turn"]) {
    let f;
    f = fixture({ taskExternalActivity: async () => ({ state: variant === "active" ? "active" : variant === "unknown" ? "unknown" : "inactive" }) },
      { readThread: async (_id, { applySnapshot }) => applySnapshot(retainedInProgressThread(f.run)) });
    f.run.executionOwner = variant === "external" ? "desktop" : "hub";
    if (variant !== "missing-acceptance") f.run.providerStart = { state: "observed",
      turnId: variant === "foreign-turn" ? "foreign" : f.run.turnId };
    await f.recovery.recover(f.run);
    assert.equal(f.current(), f.run, variant);
    assert.equal(f.calls.includes("interrupt-original"), false, variant);
  }
});

test("repeated observation cannot repeat an accepted or ambiguous recovery interrupt", async () => {
  for (const accepted of [true, false]) {
    let attempts = 0;
    const f = fixture({ interruptCodex: async () => {
      attempts += 1;
      if (!accepted) throw new Error("private transport detail");
    } });
    await f.recovery.recover(f.run);
    await f.recovery.recover(f.run);
    assert.equal(attempts, 1);
    assert.equal(f.current(), f.run);
    assert.equal(f.calls.some(x => Array.isArray(x) && x[0] === "commit"), false);
  }
});

test("a newer live provider turn blocks the retained original and throwing diagnostics do not change the decision", async () => {
  let f;
  f = fixture({ commandTrace: { startBestEffortSpan() { throw new Error("sink unavailable"); } },
    taskExternalActivity: async () => ({ state: "active", executionOwner: "desktop" }) },
    { readThread: async (_id, { applySnapshot }) => applySnapshot({ thread: { status: { type: "active" },
      turns: [{ id: "turn-new", status: "inProgress", items: [] },
        { id: f.run.turnId, status: "inProgress", items: [] }] } }) });
  f.run.executionOwner = "hub";
  f.run.providerStart = { state: "observed", turnId: f.run.turnId };
  await f.recovery.recover(f.run);
  assert.equal(f.current(), f.run);
  assert.equal(f.calls.includes("interrupt-original"), false);
  const positive = fixture({ commandTrace: { startBestEffortSpan() { return { finish() { throw new Error("sink"); } }; } } });
  await positive.recovery.recover(positive.run);
  assert.equal(positive.current(), null);
});

test("ordinary UNKNOWN reconciliation cannot replay an approval-lost prompt or interrupt an active Thread", async () => {
  const f = fixture({}, {
    autoApprove: () => true,
    readThread: async (_id, { applySnapshot }) => applySnapshot({ thread: {
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      turns: [{ id: "turn-original", status: "inProgress", items: [] }],
    } }),
  });
  await f.recovery.recover(f.run, { reconcileOnly: true });
  assert.equal(f.current(), f.run);
  assert.deepEqual(f.calls, ["observe"]);
});


test("reviewer canonical accepted-before-first-event original is eligible without inventing a provider-start state", async () => {
  const { markProviderTurnRequested, markProviderTurnAccepted, providerTurnAcceptance } =
    await import("../../../src/domain/task-runs.mjs");
  let f;
  f = fixture({}, { readThread: async (_id, { applySnapshot }) => applySnapshot(retainedInProgressThread(f.run)) });
  f.run.executionOwner = "hub";
  markProviderTurnRequested(f.run);
  markProviderTurnAccepted(f.run, { turnId: f.run.turnId });
  assert.equal(f.run.providerStart.state, "accepted-awaiting-first-event");
  assert.equal(providerTurnAcceptance(f.run).accepted, true);
  await f.recovery.recover(f.run, { reconcileOnly: true });
  assert.equal(f.current(), null, "A real accepted original must reach the existing guarded interruption owner");
  assert.equal(f.calls.filter(value => value === "interrupt-original").length, 1);
});

test("reviewer same canonical first event gives the existing observed positive control", async () => {
  const { markProviderTurnRequested, markProviderTurnAccepted, markProviderFirstEvent, providerTurnAcceptance } =
    await import("../../../src/domain/task-runs.mjs");
  let f;
  f = fixture({}, { readThread: async (_id, { applySnapshot }) => applySnapshot(retainedInProgressThread(f.run)) });
  f.run.executionOwner = "hub";
  markProviderTurnRequested(f.run);
  markProviderTurnAccepted(f.run, { turnId: f.run.turnId });
  markProviderFirstEvent(f.run, { turnId: f.run.turnId, method: "turn/started" });
  assert.equal(f.run.providerStart.state, "observed");
  assert.equal(providerTurnAcceptance(f.run).accepted, true);
  await f.recovery.recover(f.run, { reconcileOnly: true });
  assert.equal(f.current(), null);
  assert.equal(f.calls.filter(value => value === "interrupt-original").length, 1);
});

test("canonical accepted-before-first-event recovery retains original guards", async () => {
  const { markProviderTurnRequested, markProviderTurnAccepted } = await import("../../../src/domain/task-runs.mjs");
  for (const variant of ["requesting", "unconfirmed", "missing", "foreign-turn", "active", "unknown", "external"]) {
    let f;
    f = fixture({ taskExternalActivity: async () => ({ state: ["active", "unknown"].includes(variant) ? variant : "inactive" }) },
      { readThread: async (_id, { applySnapshot }) => applySnapshot(retainedInProgressThread(f.run)) });
    f.run.executionOwner = variant === "external" ? "desktop" : "hub";
    markProviderTurnRequested(f.run);
    if (variant !== "requesting") markProviderTurnAccepted(f.run, { turnId: f.run.turnId });
    if (variant === "unconfirmed") f.run.providerStart.state = "unconfirmed";
    if (variant === "missing") delete f.run.providerStart;
    if (variant === "foreign-turn") f.run.providerStart.turnId = "foreign-turn";
    await f.recovery.recover(f.run, { reconcileOnly: true });
    assert.equal(f.current(), f.run, variant);
    assert.equal(f.calls.includes("interrupt-original"), false, variant);
    assert.equal(f.calls.some(x => Array.isArray(x) && x[0] === "commit"), false, variant);
  }
});
