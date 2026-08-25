import assert from "node:assert/strict";
import test from "node:test";

import { classifyLegacyReleaseChanges } from "../../src/application/legacy-release-change-classifier.mjs";

test("legacy classifier reports migration evidence without changing entries", async () => {
  const changes = [{
    id: "legacy-1", streamId: "stream-1", status: "ready", projectRoot: "D:/repo",
    summary: "First", diffHash: "", files: ["src/app.mjs", "WIP/probe.mjs"],
  }, {
    id: "legacy-2", streamId: "stream-1", status: "ready", projectRoot: "D:/repo",
    summary: "Second", diffHash: "hash", files: ["src/app.mjs"],
  }, {
    id: "legacy-3", streamId: "stream-2", status: "ready", projectRoot: "D:/repo",
    summary: "Third", diffHash: "hash", files: ["src/app.mjs"],
  }];
  const snapshot = structuredClone(changes);
  const report = await classifyLegacyReleaseChanges(changes, {
    coveredLegacyIds: new Set(["legacy-1"]),
    inspectFile: async ({ file }) => ({ state: file.startsWith("WIP/") ? "ignored" : "clean" }),
  });

  assert.deepEqual(changes, snapshot);
  assert.deepEqual(report.entries[0].categories, [
    "covered_by_changeset", "cross_stream_overlap", "empty_diff_hash", "ignored_paths", "same_stream_overlap",
  ]);
  assert.equal(report.counts.cross_stream_overlap, 3);
  assert.equal(report.entries[1].categories.includes("unobserved"), true);
});
