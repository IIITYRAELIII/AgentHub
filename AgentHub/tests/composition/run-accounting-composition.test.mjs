import assert from "node:assert/strict";
import test from "node:test";

import { createRunAccountingComposition } from "../../src/composition/run-accounting-composition.mjs";

test("accounting forwards deferred projection options and its durable result intact", async () => {
  const calls = [];
  const result = { recorded: true, projected: false, projectionDeferred: true };
  const accounting = createRunAccountingComposition({
    runJournal: { projectTurn: async (...args) => { calls.push(args); return result; } },
  });
  const completion = { provider: "codex", threadId: "thread", turnId: "turn" };
  const options = { title: "Corrected", body: "Full answer", deferProjection: true };
  assert.equal(await accounting.projectTurnUsageToWorkLog(completion, options), result);
  assert.deepEqual(calls, [[completion, options]]);
  await accounting.projectTurnUsageToWorkLog(completion);
  assert.deepEqual(calls[1], [completion, {}]);
});

test("Claude accounting resolves transcript path without loading history", async () => {
  let readOptions = null;
  const accounting = createRunAccountingComposition({
    runJournal: {
      projectTurn: async (completion) => completion,
    },
    refreshTaskDiff: async () => {},
    runTaskTitle: () => "Task",
    readClaudeSession: async (_threadId, options) => {
      readOptions = options;
      return { transcriptPath: "claude-session.jsonl" };
    },
    scanClaudeTranscriptFile: async () => ({ turns: [] }),
  });

  await accounting.projectClaudeRunToWorkLog({
    threadId: "claude-thread",
    turnId: "claude-turn",
    projectRoot: "C:\\Project",
    startedAt: "2026-08-27T10:00:00.000Z",
  }, { answer: "Готово" });

  assert.deepEqual(readOptions, { includeHistory: false });
});

test("Claude accounting preserves Hub run identity beside transcript identity", async () => {
  let projected = null;
  const accounting = createRunAccountingComposition({
    runJournal: {
      projectTurn: async (completion) => {
        projected = completion;
        return completion;
      },
    },
    refreshTaskDiff: async () => {},
    runTaskTitle: () => "Task",
    readClaudeSession: async () => ({ transcriptPath: "claude-session.jsonl" }),
    scanClaudeTranscriptFile: async () => ({
      turns: [{
        turnId: "transcript-turn",
        completedAt: "2026-08-30T00:00:00.000Z",
        usage: {},
        usageReported: false,
      }],
    }),
  });

  await accounting.projectClaudeRunToWorkLog({
    threadId: "claude-thread",
    turnId: "hub-run-turn",
    projectRoot: "C:\\Project",
    startedAt: "2026-08-30T00:00:00.000Z",
  }, { answer: "Готово" });

  assert.equal(projected.turnId, "transcript-turn");
  assert.equal(projected.runTurnId, "hub-run-turn");
});
