import assert from "node:assert/strict";
import test from "node:test";
import { activeTurnMissing, needsThreadResume, startCodexTurnWithRecovery,
  interruptCodexTurnWithRecovery, steerCodexTurnWithRecovery,
  updateCodexThreadSettingsWithRecovery } from "../../../src/providers/codex/codex-recovery.mjs";

test("definite missing identities are distinct from transport failures", () => {
  assert.equal(needsThreadResume(new Error("thread not found: thread-1")), true);
  assert.equal(needsThreadResume(new Error("network unavailable")), false);
  assert.equal(activeTurnMissing(new Error("no active turn to interrupt")), true);
  assert.equal(activeTurnMissing(new Error("network unavailable")), false);
});

for (const [name, operation, port] of [
  ["interrupt", interruptCodexTurnWithRecovery, "interrupt"],
  ["steer", steerCodexTurnWithRecovery, "steer"],
]) test(`${name} does not resume an unloaded old turn`, async () => {
  const calls = [];
  await assert.rejects(operation({ threadId: "thread-1", turnId: "turn-1",
    [port]: async () => { calls.push(name); throw new Error("thread not found: thread-1"); },
    resume: async () => calls.push("resume"),
  }), /thread not found/);
  assert.deepEqual(calls, [name]);
});

test("explicit settings failure does not load old execution", async () => {
  const calls = [];
  await assert.rejects(updateCodexThreadSettingsWithRecovery({ threadId: "thread-1",
    update: async () => { calls.push("update"); throw new Error("thread not found: thread-1"); },
    resume: async () => calls.push("resume"),
  }), /thread not found/);
  assert.deepEqual(calls, ["update"]);
});

test("only new explicit input can load saved context after definite not-found", async () => {
  const calls = [];
  const result = await startCodexTurnWithRecovery({ threadId: "thread-1",
    startTurn: async () => {
      calls.push("new-input");
      if (calls.length === 1) throw new Error("thread not found: thread-1");
      return { turn: { id: "new-turn" } };
    }, resume: async () => calls.push("load-context"),
    rollback: async () => assert.fail("No history deletion"),
  });
  assert.deepEqual(calls, ["new-input", "load-context", "new-input"]);
  assert.equal(result.turn.id, "new-turn");
});

for (const message of ["Custom tool call output is missing for call id: old", "network unavailable", "401 Unauthorized"])
  test(`new input failure preserves history: ${message}`, async () => {
    const calls = [];
    await assert.rejects(startCodexTurnWithRecovery({ threadId: "thread-1",
      startTurn: async () => { calls.push("new-input"); throw new Error(message); },
      resume: async () => calls.push("resume"), rollback: async () => calls.push("rollback"),
    }), { message });
    assert.deepEqual(calls, ["new-input"]);
  });
