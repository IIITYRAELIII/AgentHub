import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CommandTraceService } from "../../src/application/command-trace-service.mjs";
import { TurnEndNotificationRegistry } from "../../src/application/turn-end-notifications.mjs";
import { createRunCompletionComposition } from "../../src/composition/run-completion-composition.mjs";
import { TaskRunRegistry, createManagedTaskRun, serializableTaskRun, markProviderTurnRequested,
  markProviderTurnAccepted, localExecutionIdentity } from "../../src/domain/task-runs.mjs";
import { restorePersistedTaskRun } from "../../src/composition/runtime-state-restoration-composition.mjs";

test("real completion composition traces pending startup recovery through durable ACK", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-completion-trace-"));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const records = [];
  const events = [];
  const notifications = new TurnEndNotificationRegistry();
  const completion = notifications.recordCompletion({
    provider: "codex", projectRoot: dataDir, threadId: "thread-1", turnId: "turn-1",
    status: "completed", finalAnswer: "Retained final", clientUserMessageId: "command-1",
  });
  let entered;
  let release;
  const historyEntered = new Promise((resolve) => { entered = resolve; });
  const historyGate = new Promise((resolve) => { release = resolve; });
  let projected = false;
  const noop = () => {};
  const composition = createRunCompletionComposition({
    config: { dataDir }, taskRuns: { add: noop, remove: noop, forEvent: () => null },
    currentTarget: noop, findProject: noop, normalizeCodexModel: noop, codexModelLabel: noop,
    persistTaskDiff: noop, syncTaskRun: noop, invalidateTaskCatalog: noop,
    scheduleProgressStart: noop, clearSelectedDiff: noop, clearApprovals: noop,
    pauseObservation: noop, pauseClaude: noop, stopTyping: noop,
    beforeCompletion: noop, completionAborted: noop, afterCompletion: noop,
    prepareRunAdmission: noop, revokeRunAdmission: noop,
    turnEndNotifications: notifications, lastSeenTaskTurnIds: new Map(),
    persistManagedRunHistory: async () => { entered(); await historyGate; events.push("history"); },
    runJournal: {
      projectTurn: async () => { events.push("journal"); return { projectionDeferred: true }; },
      flushTurnProjections: async () => { projected = true; events.push("flush"); return { projected: true }; },
      ensureTurnUsageFact: async () => {},
      turnProjectionStatus: async (completion) => projected ? {
        current: true,
        record: { ...completion, body: completion.finalAnswer },
      } : null,
      rememberLastMessage: () => events.push("message"),
    },
    saveState: async () => events.push("save"),
    commandTrace: new CommandTraceService({ store: {
      appendBestEffort: (record) => { records.push(record); return true; },
    } }),
  });
  const recovery = composition.turnEndDelivery.retryPending();
  try {
    await historyEntered;
    const started = records.filter((record) => record.stage === "terminal-history-persist");
    assert.deepEqual(started.map((record) => record.outcome), ["started"]);
    assert.equal(started[0].commandId, "command-1");
    assert.equal(started[0].metadata.threadId, completion.threadId);
    assert.equal(started[0].metadata.turnId, completion.turnId);
    assert.equal(started[0].metadata.terminalRevision, 1);
    assert.equal((await composition.terminalStore.pending()).length, 1);
  } finally {
    release();
    await recovery;
  }
  assert.deepEqual(events, ["history", "message", "journal", "flush", "message", "save"]);
  assert.ok((await composition.terminalStore.pending())
    .every((item) => item.channels.projection.state === "delivered"));
  assert.equal(notifications.values().length, 0);
  for (const stage of [
    "terminal-outbox-recover", "terminal-outbox-list", "terminal-history-persist",
    "terminal-journal-project", "terminal-projection-batch-flush", "terminal-state-save",
    "terminal-outbox-ack",
  ]) {
    assert.deepEqual(records.filter((record) => record.stage === stage).map((record) => record.outcome),
      // Recovery lists once before the projection flush and once after it to
      // acknowledge newly delivered projection channels; neither pass replays.
      stage === "terminal-outbox-list"
        ? ["started", "succeeded", "started", "succeeded"]
        : ["started", "succeeded"], stage);
  }
});

test("real completion composition persists local retirement before waking normal admission without a terminal", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub392-composition-retirement-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dataDir), /^hub392-composition-retirement-/u);
    await rm(dataDir, { recursive: true, force: true });
  });
  const registry = new TaskRunRegistry();
  const noop = () => {};
  let wakes = 0;
  let postTurn = 0;
  const synced = [];
  const composition = createRunCompletionComposition({
    config: { dataDir }, taskRuns: registry,
    currentTarget: noop, findProject: noop, normalizeCodexModel: noop, codexModelLabel: noop,
    persistTaskDiff: noop, syncTaskRun: (value, options) => synced.push({ run: value, options }),
    invalidateTaskCatalog: noop, saveState: async () => {},
    scheduleProgressStart: noop, clearSelectedDiff: noop, clearApprovals: noop,
    pauseObservation: noop, pauseClaude: noop, stopTyping: noop,
    beforeCompletion: () => { postTurn += 1; }, completionAborted: noop,
    afterCompletion: () => { postTurn += 1; }, prepareRunAdmission: noop, revokeRunAdmission: noop,
    turnEndNotifications: new TurnEndNotificationRegistry(), runJournal: {}, lastSeenTaskTurnIds: new Map(),
    readSystemBootIdentity: async () => ({
      source: "Win32_OperatingSystem.LastBootUpTime", bootTime: "2021-01-01T00:00:00Z",
    }),
    wakeDeferredInputs: () => {
      assert.ok(composition.runLifecycleTerminals.getLocalExecutionRetirement(localExecutionIdentity(run)));
      assert.equal(registry.forTask(run), null);
      wakes += 1;
    },
  });
  const source = createManagedTaskRun({
    provider: "codex", executionOwner: "hub", projectRoot: dataDir, threadId: "original-thread",
    streamId: "original-stream", clientUserMessageId: "original-command", rawPrompt: "untouched input",
  });
  source.startedAt = "2020-01-01T00:00:00Z";
  markProviderTurnRequested(source, { requestedAt: "2020-01-01T00:00:01Z" });
  source.turnId = "original-turn";
  markProviderTurnAccepted(source, { turnId: source.turnId, acceptedAt: "2020-01-01T00:00:02Z" });
  source.activityUnknown = true;
  const saved = serializableTaskRun(source);
  const run = restorePersistedTaskRun(saved, 7, composition.runLifecycleTerminals);
  registry.addRestored(run, saved);
  assert.equal(await composition.managedRunLifecycle.retireLocalExecutionAfterReboot(run), true);
  assert.equal(wakes, 1);
  assert.equal(postTurn, 0);
  assert.equal(run.status, "running");
  assert.equal(run.activityUnknown, true);
  assert.deepEqual(run.providerStart, saved.providerStart);
  assert.equal(registry.forEvent({ turnId: source.turnId }), run);
  assert.equal(composition.runLifecycleTerminals.get(source), null);
  assert.equal((await composition.terminalStore.pending()).length, 0);
  await composition.managedRunLifecycle.complete(run);
  assert.equal(run.status, "running", "Generic completion cannot manufacture terminal from local retirement");
  assert.equal(run.activityUnknown, true);
  assert.equal(registry.forEvent({ turnId: source.turnId }), run);
  assert.equal(postTurn, 0);
  assert.deepEqual(synced, []);

  const newer = createManagedTaskRun({ ...saved, id: "newer-run", turnId: "newer-turn" });
  registry.add(newer);
  registry.reindex(run);
  assert.equal(registry.forTask(newer), newer, "Late old event cannot reacquire admission");
  await composition.terminalStore.commit({
    provider: "codex", threadId: run.threadId, turnId: run.turnId, status: "completed",
    finalAnswer: "Controlled exact late provider final", usageIdentity: "late-original-usage",
    payload: { completion: { runId: run.id, clientUserMessageId: run.clientUserMessageId } },
  });
  await composition.managedRunLifecycle.complete(run);
  assert.equal(run.status, "completed");
  assert.equal(registry.forTask(newer), newer);
  assert.equal(registry.forEvent({ turnId: source.turnId }), null);
  assert.equal(composition.runLifecycleTerminals.get(source).status, "completed");
  assert.equal(postTurn, 0, "Old completion never reserves maintenance over the current writer");
  assert.equal(wakes, 1, "Do not repeat local retirement wake");
  assert.deepEqual(synced, [{ run, options: { active: false } }]);
  await composition.managedRunLifecycle.complete(run);
  assert.equal(synced.length, 1);
});
