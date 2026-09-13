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

test("Await accepts the Test-owned result without eager PreRelease composition", async () => {
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
        gitReferences: [previousReference],
      });
      return structuredClone(task);
    },
    rollbackWorkflowOutcome: () => { calls.push("rollback"); return structuredClone(task); },
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
      snapshotAndMergeOwned: async () => { throw new Error("Await must not ingest bytes after Test"); },
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
      prepareAwaitSet: async () => { throw new Error("eager Await composition must not run"); },
    },
  });

  const result = await service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "await-transition",
    projectRoot: "D:/project",
  });
  const sameAwaitResult = await service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "same-await-transition",
    projectRoot: "D:/project",
  });

  assert.deepEqual(calls, [
    "lock:workspace-1", "begin", "commit",
    "lock:workspace-1", "begin", "commit",
  ]);
  assert.equal(task.workflowStatus, "awaiting_implementation");
  assert.equal(result.releaseCandidate.status, "invalidated");
  assert.equal(sameAwaitResult.releaseCandidate.status, "invalidated");
  assert.deepEqual(task.gitReferences, [previousReference]);
});

test("Await rejects a Task that has not established a Test-owned result", async () => {
  const { service, task, calls } = lifecycleFixture();
  await assert.rejects(service.updateWorkflowStatus({
    taskId: task.id, status: "awaiting_implementation", operationId: "await-without-test",
  }), /must enter Test/u);
  assert.equal(calls.begin, 0);
  assert.equal(calls.commit, 0);
});

test("cross-Task cutover rejects missing, mismatched or ambiguous source authority before target mutation", async () => {
  const projectRoot = process.platform === "win32" ? "C:\\repo" : "/repo";
  const commit = "a".repeat(40);
  for (const gitReferences of [
    [],
    [{ projectRoot, branch: "HUB-216", resultCommit: "b".repeat(40) }],
    [
      { projectRoot, branch: "HUB-216", resultCommit: commit },
      { projectRoot, branch: "HUB-216-copy", resultCommit: commit },
    ],
  ]) {
    let begins = 0;
    const tasks = new Map([
      ["source", {
        id: "source", title: "Source", taskNumber: "HUB-216", revision: 9,
        workspaceId: "workspace-1", streamId: "stream-1", workflowStatus: "testing", gitReferences,
      }],
      ["target", {
        id: "target", title: "Target", taskNumber: "HUB-203", revision: 6,
        workspaceId: "workspace-1", streamId: "stream-1", workflowStatus: "testing",
        gitReferences: [{ projectRoot, branch: "HUB-203", resultCommit: "c".repeat(40) }],
      }],
    ]);
    const lease = { signal: null, async assertOwned() {} };
    const taskBoard = {
      task: (id) => tasks.get(id) ?? null,
      beginLifecycleTransition: () => { begins += 1; },
      commitWorkflowTransition: () => { throw new Error("unexpected commit"); },
      failLifecycleTransition: () => true,
      rollbackWorkflowOutcome: () => {},
      finalizeCleanupTransition: () => {},
    };
    const taskGitWorkspaces = {
      withTaskLock: async () => { throw new Error("unexpected single Task lock"); },
      withTaskLocks: async (_ids, operation) => operation(lease),
      prepareOwned: async () => { throw new Error("unexpected Git preparation"); },
      snapshotAndMergeOwned: async () => { throw new Error("unexpected Git snapshot"); },
      cleanupOwned: async () => {},
      cleanupPreview: async () => ({}),
    };
    const service = new TaskLifecycleService({
      taskBoard,
      taskGitWorkspaces,
      workspaceCatalog: {
        workspace: () => ({ id: "workspace-1", settings: { workingDirectory: projectRoot, releaseWorkflowEnabled: true } }),
        stream: () => ({ id: "stream-1", workspaceId: "workspace-1", settings: {} }),
      },
      releasePreflight: { withAwaitTransition: (_id, operation) => operation(), prepareAwaitSet: async () => ({}) },
    });
    await assert.rejects(service.updateWorkflowStatusFromSource({
      taskId: "target", status: "awaiting_implementation", operationId: `cutover-${gitReferences.length}`,
      projectRoot, expectedRevision: 6, expectedWorkflowStatus: "testing",
    }, {
      taskId: "source", expectedRevision: 9, expectedCommit: commit,
      expectedProjectorSha256: "d".repeat(64),
      verifySource: async () => ({ headCommit: commit, projectorSha256: "d".repeat(64) }),
    }), /unique authoritative Task result/u);
    assert.equal(begins, 0);
  }
});

test("unknown workflow recovery retains the repository lease through Git continuation", async () => {
  const projectRoot = "D:/project";
  const task = {
    id: "task-recovery", title: "Recovery", taskNumber: "HUB-216", revision: 15,
    status: "started", workspaceId: "workspace-1", streamId: "stream-1",
    workflowStatus: "testing", gitReferences: [{
      projectRoot, branch: "HUB-216", resultCommit: "a".repeat(40),
    }],
  };
  const transition = {
    operationId: "unknown-request", taskId: task.id, kind: "workflow", phase: "pending_git",
    targetWorkflowStatus: "awaiting_implementation", expectedRevision: 15,
  };
  const calls = [];
  const taskLease = { async assertOwned() {}, signal: null };
  const repositoryLease = { async assertOwned() {}, signal: null, repositoryLockKeys: new Set(["owned-repository"]) };
  const taskBoard = {
    task: () => task,
    lifecycleTransition: () => transition,
    beginLifecycleTransition: () => { calls.push("begin"); return { replayed: true }; },
    commitWorkflowTransition: () => {
      calls.push("commit");
      task.workflowStatus = "awaiting_implementation";
      task.revision = 16;
      return structuredClone(task);
    },
    rollbackWorkflowOutcome: () => task,
    failLifecycleTransition: () => true,
    finalizeCleanupTransition: () => ({ task }),
  };
  const taskGitWorkspaces = {
    withTaskLock: () => { throw new Error("recovery must not reacquire the Task lock"); },
    withTaskRecoveryLock: (_taskId, operation) => operation(taskLease),
    withTaskRepositoryRecoveryLock: (_taskId, root, ownedTaskLease, operation) => {
      assert.equal(root, projectRoot);
      assert.equal(ownedTaskLease, taskLease);
      calls.push("repository-lock");
      return operation(repositoryLease);
    },
    recoverProcessTreeGuard: async (_taskId, options) => {
      calls.push("recover");
      assert.equal(options.lease, repositoryLease);
      return { recovered: true, reused: false, proof: {} };
    },
    prepareOwned: async ({ lease }) => {
      calls.push("prepare");
      assert.equal(lease, repositoryLease);
      return { projectRoot: "D:/managed/task", branch: "HUB-216" };
    },
    snapshotAndMergeOwned: async ({ lease }) => {
      calls.push("snapshot");
      assert.equal(lease, repositoryLease);
      return {
        snapshot: {
          branch: "HUB-216", projectRoot: "D:/managed/task", repositoryRoot: projectRoot,
          baseCommit: "0".repeat(40), headCommit: "a".repeat(40),
        },
        integration: {
          outcome: "merged", integrated: true, resultProved: true,
          dev: { branch: "dev", headCommit: "b".repeat(40) },
        },
      };
    },
    cleanupOwned: async () => ({}),
    cleanupPreview: async () => ({ workspaces: [], gitReferences: [], dirty: false, unpublished: [], deleting: [] }),
  };
  const service = new TaskLifecycleService({
    taskBoard,
    taskGitWorkspaces,
    workspaceCatalog: {
      workspace: () => ({ id: "workspace-1", settings: { workingDirectory: projectRoot, releaseWorkflowEnabled: true } }),
      stream: () => ({ id: "stream-1", workspaceId: "workspace-1", settings: {} }),
    },
    releasePreflight: {
      withAwaitTransition: (_workspaceId, operation) => operation(),
      prepareAwaitSet: async () => { calls.push("rebuild"); return { headCommit: "c".repeat(40) }; },
    },
  });

  const result = await service.reconcileUnknownWorkflowStatus({
    taskId: task.id,
    operationId: transition.operationId,
    projectRoot,
    guardId: "guard-1",
    proof: { kind: "system-restart-after-guard", confirmed: true, summary: "boot proof" },
  });
  assert.equal(result.result.task.workflowStatus, "awaiting_implementation");
  assert.deepEqual(calls, ["repository-lock", "recover", "begin", "commit"]);
});
