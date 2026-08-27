import assert from "node:assert/strict";
import test from "node:test";

import { createRunAccountingComposition } from "../../src/composition/run-accounting-composition.mjs";

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
