import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t, settings, withGit = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-ordinary-task-"));
  const raw = new TaskBoardStore({ databaseFile: path.join(root, "journal.sqlite") });
  t.after(async () => { raw.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = { id: "ordinary", name: "Ordinary", settings, streams: [] };
  const workspaceCatalog = {
    hierarchy: () => [workspace], workspace: () => workspace,
    stream: () => { throw new Error("Stream context must not be required"); },
  };
  const events = [];
  const taskBoard = new TaskBoardService({ store: raw, workspaceCatalog,
    recordEvent: (...args) => events.push(args) });
  const task = raw.create({ text: "Database-only task", bucket: "workspace", workspaceId: workspace.id });
  const forbidden = () => { throw new Error("Git/release machinery must not run"); };
  const service = new TaskLifecycleService({ taskBoard, workspaceCatalog,
    taskGitWorkspaces: withGit ? {
      withTaskLock: forbidden, prepareOwned: forbidden, snapshotAndMergeOwned: forbidden,
      cleanupOwned: forbidden, cleanupPreview: forbidden,
    } : null,
    releasePreflight: { withAwaitTransition: forbidden, prepareAwaitSet: forbidden },
  });
  return { service, taskBoard, task, events };
}

for (const settings of [{ releaseWorkflowEnabled: false }, { releaseWorkflowEnabled: false, autoReviewEnabled: true }, {}, undefined]) {
  for (const withGit of [true, false]) test(`ordinary Task statuses need only SQLite (${JSON.stringify(settings)}, Git service ${withGit})`, async (t) => {
    const { service, taskBoard, task, events } = await fixture(t, settings, withGit);
    assert.equal(task.streamId, null);
    for (const status of ["testing", "awaiting_implementation", "done"]) {
      const before = taskBoard.task(task.id);
      const operationId = `ordinary-${status}`;
      const updated = await service.updateWorkflowStatus({ taskId: task.id, status, operationId });
      assert.equal(updated.workflowStatus, status);
      assert.equal(updated.revision, before.revision + 1);
      assert.deepEqual(updated.gitReferences, before.gitReferences);
      assert.equal(taskBoard.task(task.id).workflowStatus, status);
      assert.equal(taskBoard.lifecycleOutcome(operationId).result.task.workflowStatus, status);
    }
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(([event]) => event.type), Array(3).fill("task.workflow-status.updated"));
  });
}

test("release-enabled Task still requires release preflight before changing status", async (t) => {
  const { service, taskBoard, task } = await fixture(t, { releaseWorkflowEnabled: true });
  await assert.rejects(service.updateWorkflowStatus({ taskId: task.id, status: "testing", operationId: "release" }),
    /Git\/release machinery must not run/u);
  assert.equal(taskBoard.task(task.id).workflowStatus, task.workflowStatus);
  assert.equal(taskBoard.lifecycleOutcome("release"), null);
});

test("workflow cutover CAS rejects a stale revision or status before lifecycle effects", async (t) => {
  const { service, taskBoard, task } = await fixture(t, { releaseWorkflowEnabled: false }, false);
  await assert.rejects(service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "stale-revision",
    expectedRevision: task.revision + 1,
    expectedWorkflowStatus: task.workflowStatus,
  }), /revision changed/u);
  await assert.rejects(service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "stale-status",
    expectedRevision: task.revision,
    expectedWorkflowStatus: "testing",
  }), /status changed/u);
  assert.equal(taskBoard.task(task.id).revision, task.revision);
  assert.equal(taskBoard.lifecycleOutcome("stale-revision"), null);
  assert.equal(taskBoard.lifecycleOutcome("stale-status"), null);
});
