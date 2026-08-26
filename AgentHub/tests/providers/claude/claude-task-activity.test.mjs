import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeSnapshotActivityAtMs,
  claudeSnapshotActivityState,
} from "../../../src/providers/claude/claude-task-activity.mjs";

test("Claude activity uses meaningful transcript time instead of synthetic file writes", () => {
  const meaningfulAtMs = Date.parse("2026-08-26T20:01:00.000Z");
  const syntheticWriteAtMs = Date.parse("2026-08-26T21:00:00.000Z");
  const snapshot = {
    active: true,
    updatedAt: "2026-08-26T20:01:00.000Z",
    transcriptActivityAtMs: meaningfulAtMs,
    modifiedAtMs: syntheticWriteAtMs,
  };

  assert.equal(claudeSnapshotActivityAtMs(snapshot), meaningfulAtMs);
  assert.equal(claudeSnapshotActivityState(snapshot, {
    nowMs: Date.parse("2026-08-26T21:01:00.000Z"),
  }), "unknown");
});

test("legacy Claude snapshots retain the file timestamp fallback", () => {
  const modifiedAtMs = Date.parse("2026-08-26T21:00:00.000Z");
  assert.equal(claudeSnapshotActivityAtMs({ modifiedAtMs }), modifiedAtMs);
});
