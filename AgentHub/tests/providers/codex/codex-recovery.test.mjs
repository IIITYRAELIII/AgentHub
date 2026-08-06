import assert from "node:assert/strict";
import test from "node:test";

import {
  activeTurnMissing,
  interruptCodexTurnWithRecovery,
  needsInterruptedTurnRollback,
  needsThreadResume,
  startCodexTurnWithRecovery,
} from "../../../src/providers/codex/codex-recovery.mjs";

test("recognizes a turn broken while a custom tool call was pending", () => {
  assert.equal(needsInterruptedTurnRollback(
    new Error("Custom tool call output is missing for call id: call_123"),
  ), true);
  assert.equal(needsInterruptedTurnRollback(new Error("network unavailable")), false);
  assert.equal(needsThreadResume(new Error("thread not found: thread-1")), true);
  assert.equal(needsThreadResume(new Error("network unavailable")), false);
  assert.equal(activeTurnMissing(new Error("no active turn to interrupt")), true);
  assert.equal(activeTurnMissing(new Error("network unavailable")), false);
});

test("resumes an unloaded thread before retrying an interrupt", async () => {
  const events = [];
  let attempts = 0;
  const result = await interruptCodexTurnWithRecovery({
    threadId: "thread-1",
    turnId: "turn-1",
    interrupt: async ({ threadId, turnId }) => {
      attempts += 1;
      events.push(`interrupt-${threadId}-${turnId}`);
      if (attempts === 1) throw new Error("thread not found: thread-1");
      return { accepted: true };
    },
    resume: async ({ threadId }) => events.push(`resume-${threadId}`),
  });
  assert.deepEqual(events, [
    "interrupt-thread-1-turn-1",
    "resume-thread-1",
    "interrupt-thread-1-turn-1",
  ]);
  assert.equal(result.accepted, true);
});

test("rolls back only the broken tail turn and retries once", async () => {
  let attempts = 0;
  const rollbacks = [];
  const result = await startCodexTurnWithRecovery({
    threadId: "thread-1",
    startTurn: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Custom tool call output is missing for call id: call_123");
      }
      return { turn: { id: "turn-2" } };
    },
    resume: async () => {},
    rollback: async (params) => rollbacks.push(params),
  });

  assert.equal(attempts, 2);
  assert.deepEqual(rollbacks, [{ threadId: "thread-1", numTurns: 1 }]);
  assert.equal(result.turn.id, "turn-2");
});

test("does not alter history for unrelated start errors", async () => {
  let rolledBack = false;
  await assert.rejects(
    startCodexTurnWithRecovery({
      threadId: "thread-1",
      startTurn: async () => { throw new Error("network unavailable"); },
      resume: async () => {},
      rollback: async () => { rolledBack = true; },
    }),
    /network unavailable/,
  );
  assert.equal(rolledBack, false);
});

test("resumes an unloaded thread before recovering its interrupted tail", async () => {
  const events = [];
  let attempts = 0;
  const result = await startCodexTurnWithRecovery({
    threadId: "thread-1",
    startTurn: async () => {
      attempts += 1;
      events.push(`start-${attempts}`);
      if (attempts === 1) throw new Error("thread not found: thread-1");
      if (attempts === 2) {
        throw new Error("Custom tool call output is missing for call id: call_123");
      }
      return { turn: { id: "turn-3" } };
    },
    resume: async (params) => events.push(`resume-${params.threadId}`),
    rollback: async (params) => events.push(`rollback-${params.numTurns}`),
  });

  assert.deepEqual(events, [
    "start-1",
    "resume-thread-1",
    "start-2",
    "rollback-1",
    "start-3",
  ]);
  assert.equal(result.turn.id, "turn-3");
});
