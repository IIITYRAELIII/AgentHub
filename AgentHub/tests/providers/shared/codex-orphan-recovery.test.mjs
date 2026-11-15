import assert from "node:assert/strict";
import test from "node:test";
import { CodexRecoveryService } from "../../../src/providers/provider-recovery-services.mjs";
import { ProviderCancellationService } from "../../../src/providers/provider-turn-services.mjs";
import { CodexAppServerTransport } from "../../../src/providers/codex/codex-app-server-transport.mjs";
import { markProviderTurnRequested, markProviderTurnAccepted, markProviderFirstEvent } from "../../../src/domain/task-runs.mjs";

test("metadata recovery records a failed provider read without releasing the original", async () => {
  const spans = [];
  const f = metadataRecoveryFixture({ trace: { startBestEffortSpan(details) {
    const row = { ...details, outcomes: [] }; spans.push(row);
    return { finish(result) { row.outcomes.push(result.outcome); } };
  } } });
  f.transport.request = async () => { throw new Error("controlled metadata failure"); };
  await assert.rejects(f.recovery.recover(f.run, { reconcileOnly: true }), /controlled metadata failure/u);
  assert.equal(f.current(), f.run);
  assert.deepEqual(f.calls, []);
  assert.equal(f.transport.threadHydrations.size, 0);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].stage, "recovery-provider-read");
  assert.deepEqual(spans[0].outcomes, ["failed"]);
});

test("metadata recovery read spans survive the existing trace worker reopen", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { CommandTraceService } = await import("../../../src/application/command-trace-service.mjs");
  const { CommandTraceWorkerStore } = await import("../../../src/infrastructure/persistence/command-trace-worker-store.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "hub392-read-trace-"));
  const databaseFile = path.join(directory, "trace.sqlite");
  let store = new CommandTraceWorkerStore({ databaseFile });
  try {
    await store.initialize();
    const f = metadataRecoveryFixture({ trace: new CommandTraceService({ store }) });
    await f.recovery.recover(f.run, { reconcileOnly: true });
    assert.equal(f.current(), null);
    await store.close();
    store = new CommandTraceWorkerStore({ databaseFile });
    await store.initialize();
    const timeline = await store.readCommandTimeline(f.run.clientUserMessageId);
    const readSpans = timeline.filter(row => row.stage === "recovery-provider-read");
    assert.deepEqual(readSpans.map(row => row.outcome), ["started", "succeeded"]);
    assert.equal(readSpans.every(row => row.metadata.turnId === f.run.turnId && row.metadata.metadataOnly === true), true);
    assert.equal(readSpans[1].metadata.operationSpanId, readSpans[0].metadata.operationSpanId);
    assert.equal(JSON.stringify(timeline).includes("Retained partial answer"), false);
  } finally {
    await store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.match(path.basename(directory), /^hub392-read-trace-/u);
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained active rollout eligibility does not bypass current authority fences", async () => {
  for (const variant of [
    { threadState: "active" }, { activity: "active" }, { activity: "unknown" },
    { activity: "new-live-after" }, { acceptance: "external" }, { acceptance: "foreign" },
    { interrupt: "accepted" }, { interrupt: "unknown" },
  ]) {
    const f = metadataRecoveryFixture({ snapshotMode: "active", ...variant });
    await f.recovery.recover(f.run, { reconcileOnly: true }).catch(() => {});
    assert.equal(f.current(), f.run, JSON.stringify(variant));
    assert.equal(f.calls.some(x => Array.isArray(x) && x[0] === "commit"), false);
    assert.equal(f.transport.threadHydrations.size, 0);
    if (variant.threadState || ["active", "unknown"].includes(variant.activity) || variant.acceptance) {
      assert.equal(f.calls.includes("interrupt-original"), false);
    }
  }
});

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

function metadataRecoveryFixture({ threadState = "idle", activity = "inactive", snapshotMode = "exact",
  trace = null, acceptance = "accepted", interrupt = "rejected" } = {}) {
  const requests = [];
  const transport = new CodexAppServerTransport({ spawnProcess: () => assert.fail("No real provider process") });
  transport.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/read") return { thread: { id: "thread-original", path: "retained-rollout", status: { type: threadState } } };
    if (method === "thread/turns/list") throw new Error("Controlled full-history read timeout");
    assert.fail(`Unexpected provider RPC ${method}`);
  };
  let checks = 0;
  let f;
  f = fixture({
    taskExternalActivity: async (_run, options) => {
      assert.equal(options.forceFresh, true);
      assert.equal(transport.threadHydrations.size, 0, "Thread lane must be released before cancellation checks");
      f.calls.push("fresh-activity");
      return { state: activity === "new-live-after" && ++checks > 1 ? "active"
        : activity === "new-live-after" ? "inactive" : activity };
    },
    ...(interrupt === "rejected" ? {} : { interruptCodex: async () => {
      f.calls.push("interrupt-original");
      if (interrupt === "unknown") throw new Error("ambiguous transport");
    } }),
  }, {
    readThread: (...args) => transport.readThread(...args),
    readTaskSnapshot: async () => snapshotMode === "missing" ? null : {
      turnId: snapshotMode === "foreign" ? "newer-turn" : f.run.turnId,
      completed: false, active: snapshotMode === "active", activityUnknown: snapshotMode !== "active",
      status: snapshotMode === "active" ? "inProgress" : "unknown", answer: f.run.responseText,
    },
    commandTrace: trace,
  });
  f.run.executionOwner = "hub";
  markProviderTurnRequested(f.run);
  markProviderTurnAccepted(f.run, { turnId: f.run.turnId });
  if (acceptance === "observed") markProviderFirstEvent(f.run, { turnId: f.run.turnId, method: "turn/started" });
  if (acceptance === "foreign") f.run.providerStart.turnId = "foreign-turn";
  if (acceptance === "external") f.run.executionOwner = "desktop";
  return { ...f, requests, transport };
}

test("retained exact recovery does not require full Thread history before guarded settlement", async () => {
  for (const reconcileOnly of [false, true]) {
    const f = metadataRecoveryFixture({ acceptance: reconcileOnly ? "observed" : "accepted" });
    let readError = null;
    await f.recovery.recover(f.run, { reconcileOnly }).catch(error => { readError = error; });
    assert.equal(f.current(), null, readError?.message ?? "Exact original must reach canonical recovery");
    assert.equal(readError, null);
    assert.deepEqual(f.requests.map(x => x.method), ["thread/read"]);
    assert.deepEqual(f.calls, ["fresh-activity", "interrupt-original", "fresh-activity",
      ["commit", "interrupted", "Retained partial answer"]]);
    assert.equal(f.transport.threadHydrations.size, 0);
    assert.equal(f.run.clientUserMessageId, "message-original");
  }
});

test("metadata-only recovery keeps exact snapshot, live Thread and interrupt fences", async () => {
  for (const variant of [
    { threadState: "active" }, { activity: "active" }, { activity: "unknown" },
    { activity: "new-live-after" }, { snapshotMode: "missing" }, { snapshotMode: "foreign" },
    { acceptance: "foreign" }, { acceptance: "external" }, { interrupt: "accepted" }, { interrupt: "unknown" },
  ]) {
    const f = metadataRecoveryFixture(variant);
    await f.recovery.recover(f.run, { reconcileOnly: true }).catch(() => {});
    assert.equal(f.current(), f.run, JSON.stringify(variant));
    assert.equal(f.calls.some(x => Array.isArray(x) && x[0] === "commit"), false);
    assert.equal(f.transport.threadHydrations.size, 0);
    if (variant.threadState || ["active", "unknown"].includes(variant.activity)
      || variant.snapshotMode || variant.acceptance) assert.equal(f.calls.includes("interrupt-original"), false);
  }
});

test("metadata recovery traces the original read boundary without payload or trace authority", async () => {
  const spans = [];
  const trace = { startBestEffortSpan(details) {
    const entry = { ...details, finished: [] }; spans.push(entry);
    return { finish(result) { entry.finished.push(result); } };
  } };
  const f = metadataRecoveryFixture({ trace });
  await f.recovery.recover(f.run, { reconcileOnly: true });
  assert.equal(f.current(), null);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].stage, "recovery-provider-read");
  assert.equal(spans[0].commandId, f.run.clientUserMessageId);
  assert.equal(spans[0].recordStarted, true);
  assert.equal(spans[0].metadata.metadataOnly, true);
  assert.equal(spans[0].metadata.turnId, "turn-original");
  assert.equal(spans[0].finished[0].outcome, "succeeded");
  assert.equal(JSON.stringify(spans).includes("Retained partial answer"), false);
  const throwing = metadataRecoveryFixture({ trace: { startBestEffortSpan() { throw new Error("sink failed"); } } });
  await throwing.recovery.recover(throwing.run);
  assert.equal(throwing.current(), null);
});

test("reviewer metadata recovery retains guarded reconciliation for a dangling active rollout marker", async () => {
  const { CodexTaskSnapshotService, codexTurnSnapshot } = await import("../../../src/providers/codex/codex-task-snapshot-service.mjs");
  const { codexRolloutTurnState } = await import("../../../src/providers/codex/codex-rollout-activity.mjs");
  const transport = new CodexAppServerTransport({ spawnProcess: () => assert.fail("No real provider") });
  const requests = [];
  const thread = { id: "thread-original", path: "retained-rollout", status: { type: "idle" } };
  transport.request = async (method, params) => {
    requests.push(method);
    if (method === "thread/read") return { thread };
    if (method === "thread/turns/list") return { data: [{ id: "turn-original", status: "inProgress", items: [] }], nextCursor: null };
    assert.fail(`Unexpected RPC ${method}`);
  };
  const activity = { activeTurnIds: ["turn-original"], latestTurnId: "turn-original",
    terminalStatusesByTurnId: {}, latestMessages: {}, finalMessages: {}, userMessages: {},
    startedAtMsByTurnId: {}, completedAtMsByTurnId: {} };
  const snapshots = new CodexTaskSnapshotService({
    knownRolloutPath: async () => thread.path, readRolloutActivity: async () => activity,
    rolloutTurnState: codexRolloutTurnState, capturedOwner: () => null,
    runtimeActive: async () => false, resolveOwner: async () => "hub",
    readThread: (...args) => transport.readThread(...args),
    selectTurn: turns => turns.find(turn => turn.id === "turn-original"),
    turnSnapshot: codexTurnSnapshot, turnStartedAt: () => null, describeItem: () => "stage",
    hubOwner: () => "hub", agentHubPid: () => 1, modelLabel: value => value,
    runtimeLabel: value => value, delay: async () => {}, reindexRun: () => {},
  });
  let f;
  f = fixture({
    readCodexSnapshot: run => snapshots.read(run),
    taskExternalActivity: async (_run, options) => {
      assert.equal(options.forceFresh, true);
      assert.equal(transport.threadHydrations.size, 0);
      f.calls.push("fresh-activity");
      return { state: "inactive" };
    },
  }, {
    readThread: (...args) => transport.readThread(...args),
    readTaskSnapshot: (run, options) => snapshots.read(run, options),
  });
  f.run.executionOwner = "hub";
  markProviderTurnRequested(f.run);
  markProviderTurnAccepted(f.run, { turnId: f.run.turnId });
  const snapshot = await snapshots.read(f.run, { threadResult: { thread } });
  assert.equal(snapshot.turnId, f.run.turnId);
  assert.equal(snapshot.active, true, "A retained task_started marker is still active in the canonical exact rollout snapshot");
  assert.equal(snapshot.completed, false);
  await f.recovery.recover(f.run, { reconcileOnly: true });
  assert.equal(f.current(), null, "Fresh provider/native inactivity plus exact interrupt rejection must still reach the existing terminal owner");
  assert.deepEqual(f.calls.slice(0, 3), ["fresh-activity", "interrupt-original", "fresh-activity"]);
  assert.equal(f.calls.filter(value => value === "interrupt-original").length, 1);
});
