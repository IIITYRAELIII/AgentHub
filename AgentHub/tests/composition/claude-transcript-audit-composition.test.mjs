import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeTranscriptAuditComposition } from "../../src/composition/claude-transcript-audit-composition.mjs";

function snapshot(overrides = {}) {
  return {
    transcriptPath: "D:/Claude/session-1.jsonl",
    transcriptSizeBytes: 1_024,
    modifiedAtMs: 10,
    sessionId: "session-1",
    cwd: "D:/Work",
    title: "Task",
    active: false,
    ...overrides,
  };
}

function composition({ maximumTranscriptBytes = 16 * 1024 * 1024 } = {}) {
  const scans = [];
  const batches = [];
  const warnings = [];
  const instance = createClaudeTranscriptAuditComposition({
    projectRoot: "D:/Work",
    projectionProjectRoots: ["D:/Work"],
    findProject: () => ({ path: "D:/Work" }),
    workLogUsageStore: {
      recordAutomaticBatchAndProject: async (options) => {
        batches.push(options);
        return { recorded: options.records.length, updated: 0 };
      },
    },
    scanTranscript: async (transcriptPath) => {
      scans.push(transcriptPath);
      return {
        session: { title: "Task" },
        turns: [{
          turnId: "turn-1",
          title: "Completed",
          body: "Result",
          status: "completed",
          completedAt: "2026-08-27T10:00:00.000Z",
        }],
      };
    },
    maximumTranscriptBytes,
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });
  return { instance, scans, batches, warnings };
}

test("Claude transcript audit skips active append-only sessions", async () => {
  const { instance, scans, batches } = composition();

  await instance.audit([snapshot({ active: true })]);
  await instance.audit([snapshot({ active: false })]);

  assert.deepEqual(scans, ["D:/Claude/session-1.jsonl"]);
  assert.equal(batches.length, 1);
});

test("Claude transcript audit rejects oversized historical full scans", async () => {
  const { instance, scans, batches, warnings } = composition({ maximumTranscriptBytes: 1_000 });

  await instance.audit([snapshot({ transcriptSizeBytes: 293_000_000 })]);
  await instance.audit([snapshot({ transcriptSizeBytes: 293_000_000 })]);

  assert.deepEqual(scans, []);
  assert.deepEqual(batches, []);
  assert.equal(warnings.length, 1);
});

test("Claude transcript audit reserves a version before scanning", async () => {
  let releaseScan;
  const scanPending = new Promise((resolve) => {
    releaseScan = () => resolve({ session: {}, turns: [] });
  });
  let scans = 0;
  const instance = createClaudeTranscriptAuditComposition({
    projectRoot: "D:/Work",
    findProject: () => ({ path: "D:/Work" }),
    workLogUsageStore: { recordAutomaticBatchAndProject: async () => ({}) },
    scanTranscript: () => {
      scans += 1;
      return scanPending;
    },
  });

  const first = instance.audit([snapshot()]);
  const duplicate = instance.audit([snapshot()]);
  releaseScan();
  await Promise.all([first, duplicate]);

  assert.equal(scans, 1);
});
