import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { taskReleasePlan } from "../../../src/domain/task-release-snapshot.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-release-identity-"));
  const databaseFile = path.join(root, "tasks.sqlite");
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const task = store.create({ text: "Accepted result", bucket: "workspace", workspaceId: "workspace" });
  store.recordTaskGitReference({ taskId: task.id, projectRoot: root, branch: "HUB-1",
    resultSnapshot: { repoRoot: root, tree: "a".repeat(40) } });
  store.setWorkflowStatus(task.id, "awaiting_implementation");
  const plan = () => taskReleasePlan("workspace", store.releaseTasks("workspace").map((value) => ({
    ...value, changedFiles: [{ projectRoot: root, path: "app.mjs", operation: "modified" }],
  })));
  const complete = (snapshot) => store.completeRelease("workspace", {
    expectedPlanRevision: snapshot.revision, plan: snapshot,
    verificationEvidence: { publishedRevision: "b".repeat(40) },
    awaitRebuild: { planRevision: snapshot.revision, fallbackProjectRoots: [root] },
  });
  return { root, databaseFile, store, task, plan, complete };
}

test("editorial changes retain the release identity while row CAS still rejects stale writes", async (t) => {
  const f = await fixture(t);
  const before = f.plan();
  const initial = f.store.task(f.task.id);
  f.store.updatePresentation(f.task.id, { title: "New title", description: "Clarified description" });
  assert.equal(f.plan().revision, before.revision);
  assert.ok(f.store.task(f.task.id).revision > initial.revision);
  assert.throws(() => f.store.updateChecklist({ id: f.task.id, operation: "add", text: "stale",
    expectedRevision: initial.revision, requestId: "stale-checklist" }), /revision|измен/iu);
  await f.store.updateChecklist({ id: f.task.id, operation: "add", text: "Review recorded",
    expectedRevision: f.store.task(f.task.id).revision, requestId: "add-checklist" });
  f.store.claim(f.task.id, { workspaceId: "workspace", streamId: "new-executor",
    provider: "codex", threadId: "thread", turnId: "turn", operationId: "reassign" });
  const edited = f.store.task(f.task.id);
  assert.equal(edited.releaseRevision, initial.releaseRevision);
  assert.equal(f.plan().revision, before.revision);
  const result = f.complete(before);
  assert.equal(result.released[0].revision, edited.revision);
  assert.equal(f.store.task(f.task.id).workflowStatus, "done");
  assert.equal(f.store.task(f.task.id).description, "Clarified description");
  assert.equal(f.store.task(f.task.id).checklist.length, 1);
});

for (const change of ["result", "withdraw", "reaccept", "membership", "workspace"]) {
  test(`release completion rejects changed ${change} with the original receipt`, async (t) => {
    const f = await fixture(t);
    const before = f.plan();
    if (change === "result") f.store.recordTaskGitReference({ taskId: f.task.id, projectRoot: f.root,
      branch: "HUB-1", resultSnapshot: { repoRoot: f.root, tree: "c".repeat(40) } });
    if (["withdraw", "reaccept"].includes(change)) f.store.setWorkflowStatus(f.task.id, "testing");
    if (change === "reaccept") f.store.setWorkflowStatus(f.task.id, "awaiting_implementation");
    if (change === "membership") {
      const extra = f.store.create({ text: "Another", bucket: "workspace", workspaceId: "workspace" });
      f.store.setWorkflowStatus(extra.id, "awaiting_implementation");
    }
    if (change === "workspace") f.store.move(f.task.id, { bucket: "workspace", workspaceId: "another" });
    assert.notEqual(f.plan().revision, before.revision);
    assert.throws(() => f.complete(before), /revision conflict/u);
    assert.notEqual(f.store.task(f.task.id).workflowStatus, "done");
  });
}

test("open Done audit changes never change the Await candidate identity", async (t) => {
  const f = await fixture(t);
  const before = f.plan();
  const audit = f.store.create({ text: "Already done", bucket: "workspace", workspaceId: "workspace" });
  f.store.setWorkflowStatus(audit.id, "done");
  f.store.updatePresentation(audit.id, { title: "Audit description corrected" });
  assert.equal(f.plan().doneAudit.length, 1);
  assert.equal(f.plan().revision, before.revision);
  f.complete(before);
  assert.equal(f.store.task(audit.id).status, "open");
});
