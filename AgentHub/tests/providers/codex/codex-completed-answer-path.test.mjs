import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { CodexCompletionService } from "../../../src/providers/provider-completion-services.mjs";
import { TerminalTurnCommitService } from "../../../src/application/terminal-turn-commit-service.mjs";
import { ProviderTurnTerminalStore } from "../../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { CodexRunFinalizer } from "../../../src/providers/codex/codex-run-finalizer.mjs";
import { CodexTaskSnapshotService } from "../../../src/providers/codex/codex-task-snapshot-service.mjs";
import { readCodexCompletedTurnAnswer } from "../../../src/providers/codex/codex-rollout-activity.mjs";

const threadId = "thread-exact";
const turnId = "turn-exact";
const record = (type, payload) => JSON.stringify({ type, payload }) + "\n";

test("exact completed rollout final reaches durable managed terminal without a full metadata scan", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-completed-answer-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  const fullAnswer = "Передал S2 на ревью; затем полный результат и вывод.";
  let releaseOutbox;
  let releaseFullScan;
  try {
    await writeFile(rolloutPath, [
      record("session_meta", { id: threadId }),
      record("event_msg", { type: "task_complete", turn_id: "other-turn", last_agent_message: "Other" }),
      record("event_msg", { type: "item_completed", turn_id: turnId, item: {
        type: "AgentMessage", phase: "final_answer", content: [{ type: "text", text: "Передал S2 на рев" }],
      } }),
      record("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: fullAnswer }),
      record("event_msg", { type: "task_complete", turn_id: "later-turn", last_agent_message: "Later" }),
    ].join(""), "utf8");

    const events = [];
    const terminal = new TerminalTurnCommitService({
      store: new ProviderTurnTerminalStore({ dataDir: directory }),
    });
    let notifyOutbox;
    const outboxGate = new Promise((resolve) => { releaseOutbox = resolve; });
    const outboxStarted = new Promise((resolve) => { notifyOutbox = resolve; });
    const fullScanGate = new Promise((resolve) => { releaseFullScan = resolve; });
    const run = {
      id: "run-exact", provider: "codex", streamId: "stream-exact", threadId, turnId,
      status: "running", responseText: "Передал S2 на рев", projectRoot: directory,
      startedAt: "2026-09-29T07:00:00.000Z", userMessages: [], promptPreview: "Prompt",
      rolloutChangeTrackingKnown: true, telegramDeliveryRequested: false,
    };
    const snapshot = new CodexTaskSnapshotService({
      knownRolloutPath: async () => rolloutPath,
      readCompletedTurnAnswer: readCodexCompletedTurnAnswer,
      readRolloutActivity: async () => {
        events.push("full-scan");
        await fullScanGate;
        throw new Error("full rollout scan entered");
      },
      rolloutTurnState: () => ({}), capturedOwner: () => null,
      runtimeActive: async () => true, resolveOwner: async () => "agent-hub",
      readThread: async () => { throw new Error("provider read entered"); },
      selectTurn: () => null, turnSnapshot: () => ({}), turnStartedAt: () => null,
      describeItem: () => "", hubOwner: () => "agent-hub", agentHubPid: () => 1,
      modelLabel: (value) => value, reasoningLabels: {}, runtimeLabel: (value) => value,
      delay: async () => {}, reindexRun: () => {}, logger: { warn: (message) => events.push(message) },
    });
    const finalizer = new CodexRunFinalizer({
      turnStarts: new Map(),
      notifications: {
        get: () => null,
        recordCompletion: (completion) => completion,
      },
      discardContextCompaction: async () => false,
      finalizeRunDelivery: async () => {}, refreshTaskDiff: async () => {},
      runTitle: () => "Task", currentChatId: () => null, defaultNotificationChatId: () => null,
      saveState: async () => {},
      commitTerminal: async (completion, options) => {
        events.push("commit");
        assert.equal(completion.finalAnswer, fullAnswer);
        return terminal.commit(completion, options);
      },
      deliverTerminal: async () => {
        events.push("outbox");
        notifyOutbox();
        await outboxGate;
        return null;
      },
      markRunCompleted: async (value) => { value.status = "completed"; events.push("completed"); },
      completeRun: async () => { events.push("released"); },
      resolveTerminalAttachments: async () => [],
      formatUsage: () => "", logger: { error: (message) => events.push(message) },
    });
    const completion = new CodexCompletionService({
      runForTask: () => run, consumeTracker: () => ({ usage: {}, reported: false }),
      waitForCompletion: async () => null,
      finalizeDelivery: (value, result) => finalizer.finalize(value, result),
      finishProgress: async () => { events.push("progress"); },
      completedAnswer: (...args) => snapshot.completedAnswer(...args),
      rememberSeenTurn: async () => {}, rememberLastMessage: (_value, answer) => {
        assert.equal(answer, fullAnswer);
      },
      temporaryFiles: new Map(), speechButtons: new Map(),
    });
    const delivery = completion.completeManaged(run, { eventTurn: {
      id: turnId, status: "completed",
      items: [{ type: "agentMessage", phase: "final_answer", text: "Передал S2 на рев" }],
    } });
    const timeout = new AbortController();
    try {
      await Promise.race([
        outboxStarted,
        delay(2_000, null, { signal: timeout.signal }).then(() => {
          throw new Error("durable terminal waited for rollout scan");
        }),
      ]);
    } finally {
      timeout.abort();
    }
    const persisted = await terminal.get({ provider: "codex", threadId, turnId });
    assert.equal(persisted.finalAnswer, fullAnswer);
    assert.equal(persisted.payload.completion.finalAnswer, fullAnswer);
    assert.equal(run.status, "completed");
    assert.equal(run.responseText, fullAnswer);
    assert.deepEqual(events, ["progress", "commit", "completed", "released", "outbox"]);
    releaseOutbox();
    releaseFullScan();
    await delivery;
  } finally {
    releaseFullScan?.();
    releaseOutbox?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded final reader fails closed for a different source or incomplete record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-completed-answer-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  try {
    await writeFile(rolloutPath, [
      record("session_meta", { id: threadId }),
      record("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "Полный ответ" }),
      '{"type":"event_msg","payload":{"type":"task_complete",',
    ].join(""), "utf8");
    assert.equal(await readCodexCompletedTurnAnswer(rolloutPath, threadId, turnId), "Полный ответ");
    assert.equal(await readCodexCompletedTurnAnswer(rolloutPath, "other-thread", turnId), "");
    assert.equal(await readCodexCompletedTurnAnswer(rolloutPath, threadId, "missing-turn"), "");
    assert.equal(await readCodexCompletedTurnAnswer(rolloutPath, threadId, turnId, { tailBytes: 70 }), "");
    const completeRecord = record("event_msg", {
      type: "task_complete", turn_id: turnId, last_agent_message: "Граничный ответ",
    });
    await writeFile(rolloutPath, record("session_meta", { id: threadId }) + completeRecord, "utf8");
    assert.equal(await readCodexCompletedTurnAnswer(rolloutPath, threadId, turnId, {
      tailBytes: Buffer.byteLength(completeRecord),
    }), "Граничный ответ");
    await writeFile(rolloutPath, [
      record("session_meta", { id: threadId }),
      record("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "Старый ответ" }),
      record("event_msg", {
        type: "task_complete", turn_id: turnId, last_agent_message: "Неуспешный ход", error: "failed",
      }),
    ].join(""), "utf8");
    assert.equal(await readCodexCompletedTurnAnswer(rolloutPath, threadId, turnId), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
