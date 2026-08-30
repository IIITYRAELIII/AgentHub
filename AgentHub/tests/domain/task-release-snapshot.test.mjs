import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedTaskChangedFiles,
  taskReleasePlanRevision,
} from "../../src/domain/task-release-snapshot.mjs";

test("REL-001 changedFiles reject observed migration candidates", () => {
  assert.throws(() => normalizedTaskChangedFiles([{
    projectRoot: "D:/repo", path: "src/app.mjs", operation: "observed",
  }]), /Invalid Task release operation: observed/u);
});

test("REL-001 release plan revision hashes current Task evidence", () => {
  const task = {
    id: "task-1",
    revision: 3,
    changedFiles: [{ projectRoot: "D:/repo", path: "src/app.mjs", operation: "modified" }],
    repositoryRevisions: [{
      projectRoot: "D:/repo", baselineRevision: "a".repeat(40), resultRevision: "b".repeat(40),
    }],
  };
  const first = taskReleasePlanRevision("workspace", [task]);
  const reordered = taskReleasePlanRevision("workspace", [task]);
  assert.equal(first, reordered);
  assert.notEqual(first, taskReleasePlanRevision("workspace", [{ ...task, revision: 4 }]));
});
