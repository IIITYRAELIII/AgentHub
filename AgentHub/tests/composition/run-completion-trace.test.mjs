import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CommandTraceService } from "../../src/application/command-trace-service.mjs";
import { TurnEndNotificationRegistry } from "../../src/application/turn-end-notifications.mjs";
import { createRunCompletionComposition } from "../../src/composition/run-completion-composition.mjs";

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
  assert.deepEqual(events, ["history", "journal", "flush", "message", "save"]);
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
