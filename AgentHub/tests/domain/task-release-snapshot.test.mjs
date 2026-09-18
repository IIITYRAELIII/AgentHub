import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedTaskChangedFiles,
  taskReleasePlanRevision,
  taskReleasePlan,
} from "../../src/domain/task-release-snapshot.mjs";

test("REL-001 changedFiles reject observed migration candidates", () => {
  assert.throws(() => normalizedTaskChangedFiles([{
    projectRoot: "D:/repo", path: "src/app.mjs", operation: "observed",
  }]), /Invalid Task release operation: observed/u);
});

test("release identity ignores editorial row revisions but binds acceptance and Git results", () => {
  const task = { id: "task", workspaceId: "workspace", status: "started", workflowStatus: "awaiting_implementation",
    revision: 20, releaseRevision: 4, gitReferences: [{ projectRoot: "D:/repo", branch: "HUB-1", resultCommit: "a".repeat(40) }],
    changedFiles: [{ projectRoot: "D:/repo", path: "app.mjs", operation: "modified" }] };
  const plan = taskReleasePlan("workspace", [task]);
  const edited = { ...task, revision: 30, title: "Edited", description: "Edited", streamId: "another",
    checklist: [{ completed: true }] };
  assert.equal(taskReleasePlan("workspace", [edited]).revision, plan.revision);
  assert.equal(taskReleasePlan("workspace", [edited]).ready[0].taskRevision, 4);
  const done = { ...task, id: "audit", workflowStatus: "done" };
  assert.equal(taskReleasePlan("workspace", [edited, done]).revision, plan.revision);
  assert.equal(taskReleasePlan("workspace", [edited, done]).doneAudit.length, 1);
  for (const changed of [
    { ...task, releaseRevision: 5 },
    { ...task, workflowStatus: "testing" },
    { ...task, gitReferences: [{ ...task.gitReferences[0], resultCommit: "b".repeat(40) }] },
  ]) assert.notEqual(taskReleasePlan("workspace", [changed]).revision, plan.revision);
});

test("REL-001 release plan revision hashes only Task revision and immutable Git reference", () => {
  const task = {
    id: "task-1",
    revision: 3,
    gitReferences: [{
      projectRoot: "D:/repo", branch: "agenthub/task/task-1/repository", resultCommit: "b".repeat(40),
    }],
  };
  const first = taskReleasePlanRevision("workspace", [task]);
  const reordered = taskReleasePlanRevision("workspace", [task]);
  assert.equal(first, reordered);
  assert.notEqual(first, taskReleasePlanRevision("workspace", [{ ...task, revision: 4 }]));
  assert.notEqual(first, taskReleasePlanRevision("workspace", [{
    ...task,
    gitReferences: [{ ...task.gitReferences[0], resultCommit: "c".repeat(40) }],
  }]));
});
