import assert from "node:assert/strict";
import test from "node:test";

import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { taskReleasePlanRevision } from "../../src/domain/task-release-snapshot.mjs";
import { normalizedTaskSquashTransfer } from "../../src/domain/task-squash-transfer.mjs";

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

test("absorption validates under Await then Task and dev ownership and binds confirmation to composition", async () => {
  const { service, calls, task } = lifecycleFixture();
  Object.assign(task, { workflowStatus: "in_progress", status: "open" });
  const target = { ...task, id: "survivor", revision: 5, workflowStatus: "testing" };
  service.taskBoard.task = (id) => structuredClone(id === target.id ? target : task);
  const held = [];
  const taskLease = { async assertOwned() {} };
  const devLease = { ...taskLease, repositoryLockKeys: new Set(["repo"]) };
  const scope = async (name, operation) => {
    held.push(name);
    try { return await operation(); } finally { assert.equal(held.pop(), name); }
  };
  service.releasePreflight.withAwaitTransition = async (_id, operation, options) => {
    assert.equal(await options.changesAwait(), true);
    return scope("Await", operation);
  };
  service.taskGitWorkspaces.withTaskLocks = (_ids, operation) => {
    assert.deepEqual(held, ["Await"]);
    return scope("Tasks", () => operation(taskLease));
  };
  service.taskGitWorkspaces.withAbsorptionEvidenceOwned = (options, operation) => {
    if (held.at(-1) === "dev") {
      assert.equal(options.lease, devLease);
      return operation({ taskId: target.id, repositories: [] }, devLease);
    }
    assert.deepEqual(held, ["Await", "Tasks"]);
    return scope("dev", () => operation({ taskId: target.id, repositories: [] }, devLease));
  };
  let planRevision = "first-plan";
  service.releasePreflight.prepareAwaitSet = async (options) => {
    assert.deepEqual(held, ["Await", "Tasks", "dev"]);
    assert.equal(options.lease, devLease);
    assert.equal(options.validateOnly, true);
    assert.deepEqual(options.acceptingTask, { id: target.id, revision: target.revision });
    return { planRevision, taskIds: [target.id], releaseCandidates: [{ baseCommit: "base", tree: "tree" }] };
  };
  const request = { taskId: task.id, absorbedIntoTaskId: target.id, operationId: "absorb" };
  const preview = await service.complete(request);
  assert.equal(calls.begin, 0);
  assert.equal(target.workflowStatus, "testing");
  planRevision = "changed-selection";
  await assert.rejects(service.complete({ ...request, confirmCleanup: true,
    expectedCleanupToken: preview.cleanupToken }), /confirmation is stale/);
  assert.equal(calls.begin, 0);
  const currentPreview = await service.complete(request);
  await service.complete({ ...request, confirmCleanup: true, expectedCleanupToken: currentPreview.cleanupToken });
  assert.equal(calls.begin, 1);
  assert.equal(calls.complete, 1);
  assert.deepEqual(held, []);
  const uncertain = new Error("closure reply lost after admission");
  service.taskBoard.finalizeCleanupTransition = () => { throw uncertain; };
  await assert.rejects(service.complete({ ...request, operationId: "uncertain-closure", confirmCleanup: true,
    expectedCleanupToken: currentPreview.cleanupToken }), (error) => error === uncertain);
});

test("Await validates the exact Test result, commits acceptance and only invalidates the prior candidate", async () => {
  const previousReference = {
    projectRoot: "D:/project", branch: "HUB-159", resultCommit: "a".repeat(40),
  };
  const task = {
    id: "task-await", title: "Await rollback", taskNumber: "HUB-174", revision: 4,
    workspaceId: "workspace-1", streamId: "stream-1", workflowStatus: "testing",
    gitReferences: [previousReference],
  };
  const calls = [];
  const candidateBytes = { head: "old-candidate", tree: "old-tree" };
  const existingAwait = {
    id: "existing-await", revision: 3, releaseRevision: 3,
    gitReferences: [{ projectRoot: "D:/project", branch: "HUB-100", resultCommit: "b".repeat(40) }],
  };
  const oldCandidatePlanRevision = taskReleasePlanRevision("workspace-1", [existingAwait]);
  const taskBoard = {
    task: () => task,
    lifecycleTransition: () => null,
    beginLifecycleTransition: () => { calls.push("begin"); return { phase: "pending_git" }; },
    commitWorkflowTransition: () => {
      calls.push("commit");
      Object.assign(task, {
        revision: 5,
        releaseRevision: 5,
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
      withTaskRepositoryRecoveryLock: (_taskId, projectRoot, taskLease, operation) => {
        calls.push("repo");
        assert.equal(projectRoot, "D:/project");
        assert.equal(taskLease, lease);
        return operation(lease);
      },
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
      prepareAwaitSet: async () => { throw new Error("Await must not build or mutate PreRelease"); },
      validateAwaitAcceptance: async (options) => {
        calls.push("validate");
        assert.equal(task.workflowStatus, "testing");
        assert.deepEqual(options.acceptingTask, { id: task.id, revision: task.revision });
        assert.equal(options.projectRoot, "D:/project");
        if (calls.filter((name) => name === "validate").length === 2) throw new Error("exact dev integration changed");
        return {
          planRevision: "prospective-plan",
          task: { taskId: task.id, taskRevision: 5, resultCommit: previousReference.resultCommit },
        };
      },
    },
  });

  const result = await service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "await-transition",
    projectRoot: "D:/project",
  });
  task.workflowStatus = "testing";
  await assert.rejects(service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "same-await-transition",
    projectRoot: "D:/project",
  }), /exact dev integration changed/u);
  const retry = await service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "retry-await-transition",
    projectRoot: "D:/project",
  });

  assert.deepEqual(calls, [
    "lock:workspace-1", "begin", "repo", "validate", "commit",
    "lock:workspace-1", "begin", "repo", "validate", "fail",
    "lock:workspace-1", "begin", "repo", "validate", "commit",
  ]);
  assert.equal(task.workflowStatus, "awaiting_implementation");
  assert.equal(result.releaseCandidate.status, "invalidated");
  assert.equal(retry.releaseCandidate.status, "invalidated");
  assert.equal(result.releaseIntegration.resultCommit, previousReference.resultCommit);
  assert.deepEqual(candidateBytes, { head: "old-candidate", tree: "old-tree" });
  assert.notEqual(
    taskReleasePlanRevision("workspace-1", [existingAwait, task]),
    oldCandidatePlanRevision,
  );
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

+test("squash bootstrap rejects stale source, survivor, main, dev and proof before effects", async (t) => {
  const projectRoot = process.platform === "win32" ? "C:\\repo" : "/repo";
  const commits = Object.fromEntries("abcdefgh".split("").map((name, index) => [name, String(index + 1).repeat(40)]));
  const artifacts = {
    sourceZipSha256: "a".repeat(64), bundleSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64), filesSha256: "d".repeat(64),
  };
  const authority = {
    workspaceId: "workspace-1", streamId: "stream-1", provider: "codex",
    threadId: "thread-1", proofRequestId: "bootstrap-preview",
  };
  const transfer = normalizedTaskSquashTransfer({
    version: 1, kind: "task-squash-transfer-v1", projectRoot,
    previousResultCommit: commits.a, baselineResultCommit: commits.b,
    devBeforeCommit: commits.d, devAfterTree: commits.e,
    survivor: { taskId: "survivor", revision: 8, releaseRevision: 6,
      resultCommit: commits.c, baseCommit: commits.a, branch: "HUB-235" },
    source: { taskId: "source", revision: 4, releaseRevision: 4,
      resultCommit: commits.f, baseCommit: commits.a, branch: "HUB-224" },
    sourceWitnesses: [{ path: "source.txt", source: { mode: "100644", object: commits.g },
      survivor: { mode: "100644", object: commits.g } }],
    ownerWitnesses: [{ path: "owner.txt", baseline: null, beforeDev: null,
      newResult: { mode: "100644", object: commits.h },
      afterDev: { mode: "100644", object: commits.h } }],
    authority,
  });
  const baseTasks = {
    survivor: { id: "survivor", taskNumber: "HUB-235", revision: 8, releaseRevision: 6,
      workspaceId: "workspace-1", streamId: "stream-1", workflowStatus: "in_progress",
      gitReferences: [{ projectRoot, branch: "HUB-235", resultCommit: commits.a }] },
    source: { id: "source", taskNumber: "HUB-224", revision: 4, releaseRevision: 4,
      workspaceId: "workspace-1", streamId: "stream-1", workflowStatus: "testing",
      gitReferences: [{ projectRoot, branch: "HUB-224", resultCommit: commits.f }] },
  };
  const request = {
    taskId: "survivor", sourceTaskId: "source", operationId: "bootstrap-confirm",
    expectedTaskRevision: 8, expectedSourceTaskRevision: 4,
    baselineResultCommit: commits.b, newResultCommit: commits.c, devAfterTree: commits.e,
    authority, projectRoot, reviewedSourceTree: commits.h,
    expectedMainCommit: commits.b, expectedDevCommit: commits.d,
    expectedPreservedTree: commits.g, projectorSha256: "e".repeat(64), artifacts,
    verifySource: async () => ({ sourceRoot: projectRoot, headCommit: commits.c,
      headTree: commits.h, projectorSha256: "e".repeat(64), artifacts }),
  };
  const scenarios = [
    { name: "source", mutate: (tasks) => { tasks.source.revision += 1; }, error: /revisions or statuses/u },
    { name: "survivor", mutate: (tasks) => { tasks.survivor.revision += 1; }, error: /revisions or statuses/u },
    { name: "main", previewError: new Error("Squash cutover main identity changed"), error: /main identity changed/u },
    { name: "dev", preview: { ...transfer, transferHash: undefined,
      devBeforeCommit: commits.f }, error: /dev identity changed/u },
    { name: "proof", expectedHashes: true, error: /confirmation hash changed/u },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const tasks = structuredClone(baseTasks);
    scenario.mutate?.(tasks);
    let begin = 0;
    let apply = 0;
    const lease = { signal: null, async assertOwned() {} };
    const service = new TaskLifecycleService({
      taskBoard: {
        task: (id) => structuredClone(tasks[id]),
        beginLifecycleTransition: () => { begin += 1; },
        commitWorkflowTransition: () => { throw new Error("unexpected workflow commit"); },
        commitSquashTransferTransition: () => { throw new Error("unexpected commit"); },
        failLifecycleTransition: () => true,
        rollbackWorkflowOutcome: () => {},
        finalizeCleanupTransition: () => {},
      },
      taskGitWorkspaces: {
        withTaskLock: (_id, operation) => operation(lease),
        withTaskLocks: (_ids, operation) => operation(lease),
        prepareOwned: async () => { throw new Error("unexpected prepare"); },
        snapshotAndMergeOwned: async () => { throw new Error("unexpected snapshot"); },
        cleanupOwned: async () => {},
        cleanupPreview: async () => ({}),
        previewSquashCutoverOwned: async () => {
          if (scenario.previewError) throw scenario.previewError;
          return scenario.preview ? normalizedTaskSquashTransfer(scenario.preview) : transfer;
        },
        applySquashCutoverOwned: async () => { apply += 1; throw new Error("unexpected apply"); },
        readSquashCutoverOwned: async () => ({ status: "unknown" }),
      },
      workspaceCatalog: {
        workspace: () => ({ id: "workspace-1", settings: { workingDirectory: projectRoot,
          releaseWorkflowEnabled: true } }),
        stream: () => ({ id: "stream-1", workspaceId: "workspace-1", settings: {} }),
      },
      releasePreflight: { withAwaitTransition: (_id, operation) => operation() },
    });
    await assert.rejects(service.squashTransferCutover({ ...request,
      ...(scenario.expectedHashes ? { expectedTransferHash: "f".repeat(64),
        expectedCutoverHash: "0".repeat(64) } : {}) }), scenario.error);
    assert.equal(begin, 0);
    assert.equal(apply, 0);
  });
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
      if (ownedTaskLease.repositoryLockKeys) {
        assert.equal(ownedTaskLease, repositoryLease);
        assert.deepEqual([...ownedTaskLease.repositoryLockKeys], ["owned-repository"]);
        calls.push("repository-lock-reused");
      } else {
        assert.equal(ownedTaskLease, taskLease);
        calls.push("repository-lock");
      }
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
      validateAwaitAcceptance: async () => {
        calls.push("validate");
        return {
          planRevision: "recovered-plan",
          task: { taskId: task.id, resultCommit: task.gitReferences[0].resultCommit },
        };
      },
      prepareAwaitSet: async (options) => {
        calls.push("rebuild");
        const result = { headCommit: "c".repeat(40) };
        await options.commitPrepared(result);
        return result;
      },
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
  assert.deepEqual(calls, ["repository-lock", "recover", "begin", "repository-lock-reused", "validate", "commit"]);
});
