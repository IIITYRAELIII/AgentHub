import assert from "node:assert/strict";
import test from "node:test";

import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";

function lifecycleFixture({ synchronousFence = false } = {}) {
  const task = {
    id: "task-fenced", title: "Fenced", taskNumber: "HUB-159", revision: 1,
    workspaceId: "workspace-1", streamId: "stream-1", workflowStatus: "done",
    gitReferences: [],
  };
  const calls = { assertions: 0, begin: 0, fail: 0, commit: 0, rollback: 0, cleanup: 0, complete: 0, delete: 0 };
  const asyncAssertOwned = async () => {
    calls.assertions += 1;
    await Promise.resolve();
    if (calls.assertions > 1) throw new Error("lease ownership was lost asynchronously");
  };
  const lease = {
    signal: new AbortController().signal,
    assertOwned: synchronousFence ? () => { calls.assertions += 1; } : asyncAssertOwned,
  };
  const taskBoard = {
    task: () => task,
    lifecycleTransition: () => null,
    beginLifecycleTransition: () => { calls.begin += 1; return { phase: "pending_git" }; },
    commitWorkflowTransition: () => { calls.commit += 1; return task; },
    rollbackWorkflowOutcome: () => { calls.rollback += 1; return task; },
    failLifecycleTransition: () => { calls.fail += 1; return true; },
    finalizeCleanupTransition: (operationId, options = {}) => {
      if (options.deleteTask) calls.delete += 1;
      else calls.complete += 1;
      return { task };
    },
  };
  const taskGitWorkspaces = {
    withTaskLock: (_taskId, operation) => operation(lease),
    prepareOwned: async () => ({ projectRoot: "D:/managed/task", branch: "HUB-159" }),
    snapshotAndMergeOwned: async () => ({
      snapshot: {
        branch: "HUB-159", projectRoot: "D:/managed/task", repositoryRoot: "D:/project",
        baseCommit: "a".repeat(40), headCommit: "b".repeat(40),
      },
      integration: {
        outcome: "merged", integrated: true, resultProved: true,
        dev: { branch: "dev", headCommit: "c".repeat(40) },
      },
    }),
    cleanupOwned: async () => { calls.cleanup += 1; return { removed: 0 }; },
    cleanupPreview: async () => ({
      workspaces: [], gitReferences: [], dirty: false, unpublished: [], deleting: [],
    }),
  };
  const service = new TaskLifecycleService({
    taskBoard,
    taskGitWorkspaces,
    workspaceCatalog: {
      workspace: () => ({ id: "workspace-1", settings: { workingDirectory: "D:/project", releaseWorkflowEnabled: true } }),
      stream: () => ({ id: "stream-1", workspaceId: "workspace-1", settings: {} }),
    },
    releasePreflight: { withAwaitTransition: (_id, operation) => operation(), prepareAwaitSet: async () => ({}) },
  });
  return { service, calls, task };
}

test("async lifecycle fencing blocks every workflow/cleanup commit without an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const scenarios = [
      ["non-Git workflow", ({ service, task }) => service.updateWorkflowStatus({
        taskId: task.id, status: "in_progress", operationId: "workflow-no-git",
      })],
      ["Git workflow", ({ service, task }) => service.updateWorkflowStatus({
        taskId: task.id, status: "testing", operationId: "workflow-git", projectRoot: "D:/project",
      })],
      ["Complete", async ({ service, task }) => {
        const preview = await service.complete({ taskId: task.id, operationId: "complete" });
        return service.complete({
          taskId: task.id, operationId: "complete", confirmCleanup: true,
          expectedCleanupToken: preview.cleanupToken,
        });
      }],
      ["Delete", async ({ service, task }) => {
        const preview = await service.delete({ taskId: task.id, operationId: "delete" });
        return service.delete({
          taskId: task.id, operationId: "delete", confirmCleanup: true,
          expectedCleanupToken: preview.cleanupToken,
        });
      }],
    ];
    for (const [name, run] of scenarios) {
      const state = lifecycleFixture();
      await assert.rejects(run(state), /lease ownership was lost asynchronously/u, name);
      assert.equal(state.calls.begin, 1, `${name}: transition begins while owned`);
      assert.equal(state.calls.commit, 0, `${name}: workflow commit fenced`);
      assert.equal(state.calls.fail, 0, `${name}: failure write fenced`);
      assert.equal(state.calls.cleanup, 0, `${name}: cleanup fenced`);
      assert.equal(state.calls.complete, 0, `${name}: Complete final mutation fenced`);
      assert.equal(state.calls.delete, 0, `${name}: Delete final mutation fenced`);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("Task lifecycle rejects a synchronous assertOwned contract before mutation", async () => {
  const state = lifecycleFixture({ synchronousFence: true });
  await assert.rejects(state.service.updateWorkflowStatus({
    taskId: state.task.id,
    status: "in_progress",
    operationId: "sync-fence",
  }), /assertOwned must be asynchronous/u);
  assert.deepEqual(state.calls, {
    assertions: 1, begin: 0, fail: 0, commit: 0, rollback: 0, cleanup: 0, complete: 0, delete: 0,
  });
});

test("failed Await rebuild rolls back the committed Task status and exact Git references", async () => {
  const previousReference = {
    projectRoot: "D:/project", branch: "HUB-159", resultCommit: "a".repeat(40),
  };
  const task = {
    id: "task-await", title: "Await rollback", taskNumber: "HUB-174", revision: 4,
    workspaceId: "workspace-1", streamId: "stream-1", workflowStatus: "testing",
    gitReferences: [previousReference],
  };
  const calls = [];
  const taskBoard = {
    task: () => task,
    lifecycleTransition: () => null,
    beginLifecycleTransition: () => { calls.push("begin"); return { phase: "pending_git" }; },
    commitWorkflowTransition: () => {
      calls.push("commit");
      Object.assign(task, {
        revision: 5,
        workflowStatus: "awaiting_implementation",
        gitReferences: [{
          projectRoot: "D:/project", branch: "HUB-174", resultCommit: "b".repeat(40),
        }],
      });
      return structuredClone(task);
    },
    rollbackWorkflowOutcome: () => {
      calls.push("rollback");
      Object.assign(task, {
        revision: 6,
        workflowStatus: "testing",
        gitReferences: [previousReference],
      });
      return structuredClone(task);
    },
    failLifecycleTransition: () => { calls.push("fail"); return true; },
    finalizeCleanupTransition: () => ({ task }),
  };
  const lease = { signal: null, async assertOwned() {} };
  const service = new TaskLifecycleService({
    taskBoard,
    workspaceCatalog: {
      workspace: () => ({
        id: "workspace-1",
        settings: { workingDirectory: "D:/project", releaseWorkflowEnabled: true },
      }),
      stream: () => ({ id: "stream-1", workspaceId: "workspace-1", settings: {} }),
    },
    taskGitWorkspaces: {
      withTaskLock: (_taskId, operation) => operation(lease),
      prepareOwned: async () => ({ projectRoot: "D:/managed/task", branch: "HUB-174" }),
      snapshotAndMergeOwned: async () => ({
        snapshot: {
          branch: "HUB-174", projectRoot: "D:/managed/task", repositoryRoot: "D:/project",
          baseCommit: "0".repeat(40), headCommit: "b".repeat(40),
        },
        integration: {
          outcome: "merged", integrated: true, resultProved: true,
          dev: { branch: "dev", headCommit: "c".repeat(40) },
        },
      }),
      cleanupOwned: async () => ({ removed: 0 }),
      cleanupPreview: async () => ({
        workspaces: [], gitReferences: [], dirty: false, unpublished: [], deleting: [],
      }),
    },
    releasePreflight: {
      withAwaitTransition: async (workspaceId, operation) => {
        calls.push(`lock:${workspaceId}`);
        return operation();
      },
      prepareAwaitSet: async () => {
        calls.push("rebuild");
        throw new Error("injected Await rebuild failure");
      },
    },
  });

  await assert.rejects(() => service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "await-transition",
    projectRoot: "D:/project",
  }), /injected Await rebuild failure/u);

  assert.deepEqual(calls, ["lock:workspace-1", "begin", "commit", "rebuild", "rollback"]);
  assert.equal(task.workflowStatus, "testing");
  assert.deepEqual(task.gitReferences, [previousReference]);
});
