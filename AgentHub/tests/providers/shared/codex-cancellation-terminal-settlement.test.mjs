import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexCompletionService } from "../../../src/providers/provider-completion-services.mjs";
import { ProviderCancellationService } from "../../../src/providers/provider-turn-services.mjs";
import { ManagedRunLifecycleService } from "../../../src/application/managed-run-lifecycle-service.mjs";
import { TerminalTurnCommitService } from "../../../src/application/terminal-turn-commit-service.mjs";
import { ProviderTurnTerminalStore } from "../../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { TaskRunRegistry } from "../../../src/domain/task-runs.mjs";

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t, beforeTerminalWrite = async () => {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-cancel-settlement-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const commits = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir }) });
  const taskRuns = new TaskRunRegistry();
  const events = [];
  const noop = () => {};
  const lifecycle = new ManagedRunLifecycleService({
    taskRuns, currentTarget: () => ({ provider: "codex", projectRoot: "D:/fixture",
      streamId: "stream-original", threadId: "thread-original", chatId: 1 }),
    findProject: () => ({ name: "fixture" }), codexSettings: () => ({}),
    currentPreferences: () => ({ model: "gpt", defaultModel: "gpt", collaborationMode: "default" }),
    normalizeCodexModel: String, modelLabel: String, claudeModelLabels: {}, reasoningLabels: {},
    persistTaskDiff: async () => {}, syncRun: noop, invalidateCatalog: noop,
    saveState: async () => {}, scheduleProgressStart: noop, clearSelectedDiff: noop,
    clearApprovals: noop, pauseObservation: noop, pauseClaude: noop, stopTyping: noop,
    prepareAdmission: async () => null, revokeAdmission: noop,
    beforeCompletion: async () => {}, completionAborted: async () => {},
    afterCompletion: async run => { events.push({ kind: "wake", terminal: await commits.get(run) }); },
  });
  const run = await lifecycle.adopt("original accepted input", {
    provider: "codex", threadId: "thread-original", clientUserMessageId: "message-original",
  });
  run.turnId = "turn-original";
  const current = () => taskRuns.forTask(run);
  let attempts = 0;
  let activity = async () => ({ state: "inactive" });
  const completion = new CodexCompletionService({
    runForTask: current, consumeTracker: () => null, waitForCompletion: async () => null,
    finalizeDelivery: async (value, result) => {
      attempts += 1;
      await beforeTerminalWrite();
      await commits.commit({ provider: "codex", threadId: value.threadId,
        turnId: result.turnId, status: result.status, finalAnswer: result.answer,
        clientUserMessageId: value.clientUserMessageId }, { run: value });
      await lifecycle.complete(value);
    },
    finishProgress: async () => {}, completedAnswer: async () => "provider final",
    rememberSeenTurn: async () => {}, rememberLastMessage: noop,
    temporaryFiles: new Map(), speechButtons: new Map(), removeFile: async () => {},
  });
  const cancellation = new ProviderCancellationService({
    interruptCodex: async () => { throw new Error("no active turn"); },
    runForTask: current, completeRun: value => lifecycle.complete(value),
    readCodexSnapshot: async () => ({ turnId: run.turnId, completed: false,
      active: false, status: "unknown", answer: "retained partial answer" }),
    finishObserved: async () => assert.fail("Managed original only"),
    completeManaged: (...args) => completion.completeManaged(...args),
    taskExternalActivity: (...args) => activity(...args),
    stopClaudeRun: async () => assert.fail("No foreign process stop"),
    processIsAlive: () => false, claudeCancellationKey: () => "", saveState: async () => {},
  });
  return { run, completion, cancellation, commits, current, events,
    attempts: () => attempts, setActivity: value => { activity = value; } };
}

test("Stop retry cannot release an actual finishing completion after its write failed", async t => {
  const f = await fixture(t, async () => { throw new Error("terminal write unavailable"); });
  assert.equal((await f.cancellation.cancelCodex(f.run)).accepted, false);
  assert.equal(f.run.status, "finishing");
  assert.equal(await f.commits.get(f.run), null);
  assert.equal((await f.cancellation.cancelCodex(f.run)).accepted, false);
  assert.equal(f.current(), f.run);
  assert.equal(f.run.admissionReleased === true, false);
  assert.equal(f.events.length, 0);
  assert.equal(f.attempts(), 1);
});

test("Stop during actual recovery persistence leaves the lane until the SQLite terminal commits", async t => {
  const entered = gate(), held = gate();
  const f = await fixture(t, async () => { entered.release(); await held.promise; });
  const recovering = f.cancellation.recoverCodex(f.run);
  await entered.promise;
  try {
    const result = await f.cancellation.cancelCodex(f.run);
    assert.equal(result.accepted, false);
    assert.equal(f.current(), f.run);
    assert.equal(await f.commits.get(f.run), null);
    assert.equal(f.events.length, 0);
  } finally { held.release(); await recovering; }
  assert.equal(await recovering, true);
  assert.equal(f.current(), null);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].terminal.status, "aborted");
  assert.equal(f.events[0].terminal.finalAnswer, "retained partial answer");
  assert.equal(f.attempts(), 1);
});

test("completion beginning in the second fresh recovery check cannot grant a no-op release", async t => {
  const entered = gate(), held = gate();
  const f = await fixture(t, async () => { entered.release(); await held.promise; });
  let checks = 0, competing;
  f.setActivity(async () => {
    if (++checks === 2) {
      competing = f.completion.completeManaged(f.run, { snapshot: {
        turnId: f.run.turnId, completed: true, status: "interrupted", answer: "provider terminal",
      } });
      await entered.promise;
    }
    return { state: "inactive" };
  });
  try {
    assert.equal(await f.cancellation.recoverCodex(f.run), false);
    assert.equal(f.current(), f.run);
    assert.equal(await f.commits.get(f.run), null);
    assert.equal(f.events.length, 0);
  } finally { held.release(); await competing; }
  assert.equal(f.current(), null);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].terminal.finalAnswer, "provider terminal");
  assert.equal(f.attempts(), 1);
});
