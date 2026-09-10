import assert from "node:assert/strict";
import test from "node:test";

import { createTaskBoardMutationOwner } from "../../src/application/sqlite-mutation-owner.mjs";
import { WorkspaceReleaseService } from "../../src/application/workspace-release-service.mjs";

function fixture(plan = {
  revision: "plan-1", ready: [{ id: "change-1" }],
  candidates: [{ gitReferences: [{ projectRoot: "D:/repo", resultCommit: "task-result" }] }],
  draft: [], blocked: [], conflicts: [],
}, { primarySync = null, devSync = null, rebuildFailures = 0 } = {}) {
  const calls = [];
  let pending = null;
  let remainingRebuildFailures = rebuildFailures;
  const service = new WorkspaceReleaseService({
    store: createTaskBoardMutationOwner({
      runMutation: (operation) => Promise.resolve().then(operation),
      awaitRebuildPending: () => structuredClone(pending),
      releaseFinalizationOutcome: () => null,
      recordReleaseFinalizationStage: (_workspaceId, { stage, projectRoot, receipt }) => {
        if (stage === "await") pending.awaitResult = structuredClone(receipt);
        else pending.repositories.find((item) => item.projectRoot === projectRoot)[stage] = structuredClone(receipt);
      },
      clearAwaitRebuildPending: () => {
        calls.push(["clear-pending"]);
        pending = null;
        return true;
      },
      completeRelease: (workspaceId, options) => {
        calls.push(["complete", workspaceId, options]);
        pending = structuredClone(options.awaitRebuild);
        return { workspaceId, released: plan.ready };
      },
    }),
    releasePlanner: { plan: async () => plan },
    releaseGitWorkspaces: {
      frozenCandidate: async (repositoryRoot) => ({
        repositoryRoot, planRevision: plan.revision, manifestHash: "manifest",
        baseCommit: "base", preReleaseHead: "abc",
      }),
      synchronizePublishedPrimary: async (value) => {
        calls.push(["sync-primary", value]);
        return primarySync ?? { status: "fast_forwarded", publishedRevision: value.publishedRevision };
      },
    },
    taskGitWorkspaces: {
      synchronizeMainIntoDev: async (value) => {
        calls.push(["sync-dev", value]);
        return devSync ?? { status: "merged", integrated: true, mainCommit: value.publishedRevision };
      },
    },
    releasePreflight: {
      withAwaitTransition: async (workspaceId, operation) => {
        calls.push(["lock-await", workspaceId]);
        return operation();
      },
      prepareAwaitSet: async (options) => {
        calls.push(["rebuild-await", options]);
        if (remainingRebuildFailures > 0) {
          remainingRebuildFailures -= 1;
          throw new Error("injected rebuild failure");
        }
        return { rebuilt: true, ...options };
      },
    },
    verifyPublication: async (value) => {
      calls.push(["verify", value]);
      return {
        repositories: [{
          root: "D:/repo", revision: "abc", planRevision: plan.revision,
          manifestHash: "manifest", baseCommit: "base", preReleaseHead: "abc",
        }],
        agentHubPublication: { generation: "generation-1" },
      };
    },
  });
  return { calls, service, state: { get pending() { return pending; } } };
}

test("release completion rejects a raw Task store dependency", () => {
  assert.throws(() => new WorkspaceReleaseService({
    store: { completeRelease() {}, awaitRebuildPending() {}, clearAwaitRebuildPending() {}, recordReleaseFinalizationStage() {}, releaseFinalizationOutcome() {} },
    releasePlanner: { plan() {} },
    releaseGitWorkspaces: { frozenCandidate() {}, synchronizePublishedPrimary() {} },
    taskGitWorkspaces: { synchronizeMainIntoDev() {} },
    releasePreflight: { prepareAwaitSet() {}, withAwaitTransition() {} },
    verifyPublication() {},
  }), /Task mutation owner facade/u);
});

test("release completion requires explicit deployment evidence before changing the registry", async () => {
  const { calls, service } = fixture();
  await assert.rejects(
    () => service.completeRelease({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
    /requires verified deployment evidence/u,
  );
  assert.deepEqual(calls, []);
});

test("release completion verifies repositories before atomically closing ready changes", async () => {
  const { calls, service } = fixture();
  const result = await service.completeRelease({
    workspaceId: "workspace-1",
    expectedRepositories: [{ projectRoot: "D:/repo", revision: "abc" }],
    expectedPlanRevision: "plan-1",
    deploymentVerified: true,
    verificationSummary: "Published and smoke-tested",
  });
  assert.equal(result.publication.verificationSummary, "Published and smoke-tested");
  assert.equal(result.publication.planRevision, "plan-1");
  assert.deepEqual(
    calls.map(([name]) => name),
    ["lock-await", "verify", "verify", "complete", "sync-primary", "sync-dev", "rebuild-await", "clear-pending"],
  );
  assert.deepEqual(calls[4][1], {
    projectRoot: "D:/repo",
    publishedRevision: "abc",
    planRevision: "plan-1",
  });
  assert.deepEqual(calls[5][1], {
    projectRoot: "D:/repo",
    publishedRevision: "abc",
  });
  const { plan: completedPlan, ...completionOptions } = calls[3][2];
  assert.equal(completedPlan.revision, "plan-1");
  assert.deepEqual(completionOptions, {
    expectedPlanRevision: "plan-1",
    conflictsResolved: false,
    verificationEvidence: {
      planRevision: "plan-1",
      expectedRepositories: [{ projectRoot: "D:/repo", revision: "abc" }],
      verificationSummary: "Published and smoke-tested",
      conflictsResolved: false,
      publication: {
        repositories: [{
          root: "D:/repo", revision: "abc", planRevision: "plan-1",
          manifestHash: "manifest", baseCommit: "base", preReleaseHead: "abc",
        }],
        agentHubPublication: { generation: "generation-1" },
        primarySynchronization: [{ status: "fast_forwarded", publishedRevision: "abc" }],
        devSynchronization: [{ status: "merged", integrated: true, mainCommit: "abc" }],
        verificationSummary: "Published and smoke-tested",
        planRevision: "plan-1",
      },
      deployment: {
        verified: true,
        summary: "Published and smoke-tested",
      },
    },
    awaitRebuild: {
      planRevision: "plan-1",
      fallbackProjectRoots: ["D:/repo"],
      version: 2,
      repositories: [{ projectRoot: "D:/repo", publishedRevision: "abc", primary: null, dev: null }],
      awaitResult: null,
    },
  });
  assert.deepEqual(calls[6][1], {
    workspaceId: "workspace-1",
    fallbackProjectRoots: ["D:/repo"],
  });
  assert.equal(result.preReleaseIntegration.rebuilt, true);
});

test("failed post-publication Await rebuild is durable and retryable without completing twice", async () => {
  const { calls, service, state } = fixture(undefined, { rebuildFailures: 1 });
  const request = {
    workspaceId: "workspace-1",
    expectedRepositories: [{ projectRoot: "D:/repo", revision: "abc" }],
    expectedPlanRevision: "plan-1",
    deploymentVerified: true,
    verificationSummary: "Published and verified",
  };

  const first = await service.completeRelease(request);
  assert.equal(first.preReleaseIntegration.status, "retry_required");
  assert.match(first.preReleaseIntegration.reason, /injected rebuild failure/u);
  assert.equal(state.pending.planRevision, "plan-1");
  assert.equal(state.pending.version, 2);
  assert.equal(state.pending.repositories[0].primary.completed, true);
  assert.equal(state.pending.repositories[0].dev.completed, true);
  assert.equal(state.pending.awaitResult.completed, false);

  const second = await service.completeRelease(request);
  assert.equal(second.releaseAlreadyCompleted, true);
  assert.equal(second.recoveredPlanRevision, "plan-1");
  assert.equal(second.preReleaseIntegration.rebuilt, true);
  assert.equal(state.pending, null);
  assert.equal(calls.filter(([name]) => name === "complete").length, 1);
  assert.equal(calls.filter(([name]) => name === "verify").length, 2);
  assert.equal(calls.filter(([name]) => name === "rebuild-await").length, 2);
});

test("release completion treats overlapping ready paths as diagnostic evidence", async () => {
  const plan = {
    revision: "plan-conflict", ready: [{ id: "change-1" }, { id: "change-2" }],
    candidates: [{ gitReferences: [{ projectRoot: "D:/repo", resultCommit: "task-result" }] }], draft: [], blocked: [],
    conflicts: [{ file: "AgentHub/app.js" }],
  };
  const { calls, service } = fixture(plan);
  const request = {
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-conflict",
    deploymentVerified: true,
    verificationSummary: "Integrated overlap verified",
    expectedRepositories: [{ projectRoot: "D:/repo", revision: "abc" }],
  };
  await service.completeRelease(request);
  assert.equal(calls[1][1].conflictsResolved, false);
  assert.equal(calls[3][2].conflictsResolved, false);
  assert.equal(calls[3][2].verificationEvidence.conflictsResolved, false);
});

test("release completion binds publication evidence to the exact observed plan revision", async () => {
  const { calls, service } = fixture();
  await assert.rejects(
    () => service.completeRelease({
      workspaceId: "workspace-1",
      expectedPlanRevision: "another-plan",
      deploymentVerified: true,
      verificationSummary: "Published and smoke-tested",
    }),
    /revision changed/u,
  );
  assert.deepEqual(calls, [["lock-await", "workspace-1"]]);
});

test("manual primary synchronization does not undo verified release completion", async () => {
  const { calls, service } = fixture(undefined, {
    primarySync: { status: "manual_required", reason: "intentional local overlap" },
  });
  const result = await service.completeRelease({
    workspaceId: "workspace-1",
    expectedRepositories: [{ projectRoot: "D:/repo", revision: "abc" }],
    expectedPlanRevision: "plan-1",
    deploymentVerified: true,
    verificationSummary: "Published and verified",
  });
  assert.equal(result.publication.primarySynchronization[0].status, "manual_required");
  assert.equal(result.finalization.status, "retry_required");
  assert.deepEqual(
    calls.map(([name]) => name),
    ["lock-await", "verify", "verify", "complete", "sync-primary", "sync-dev", "rebuild-await"],
  );
});

test("release completion records a dev conflict without hiding publication success", async () => {
  const { calls, service } = fixture(undefined, {
    devSync: {
      status: "conflict",
      integrated: false,
      mainCommit: "abc",
      devHeadBefore: "dev-before",
      headCommit: "dev-before",
      conflicts: ["AgentHub/app.js"],
      reason: "merge conflict",
    },
  });
  const result = await service.completeRelease({
    workspaceId: "workspace-1",
    expectedRepositories: [{ projectRoot: "D:/repo", revision: "abc" }],
    expectedPlanRevision: "plan-1",
    deploymentVerified: true,
    verificationSummary: "Published and verified",
  });
  assert.equal(result.publication.devSynchronization[0].status, "conflict");
  assert.equal(result.publication.devSynchronization[0].integrated, false);
  assert.deepEqual(result.publication.devSynchronization[0].conflicts, ["AgentHub/app.js"]);
  assert.equal(result.finalization.status, "retry_required");
  assert.deepEqual(
    calls.map(([name]) => name),
    ["lock-await", "verify", "verify", "complete", "sync-primary", "sync-dev", "rebuild-await"],
  );
});

test("publication generation change between verify and closure blocks Task completion", async () => {
  const { calls, service } = fixture();
  let read = 0;
  service.verifyPublication = async () => ({
    repositories: [{
      root: "D:/repo", revision: "abc", planRevision: "plan-1",
      manifestHash: "manifest", baseCommit: "base", preReleaseHead: "abc",
    }],
    agentHubPublication: { generation: `generation-${++read}` },
  });

  await assert.rejects(() => service.completeRelease({
    workspaceId: "workspace-1",
    expectedRepositories: [{ projectRoot: "D:/repo", revision: "abc" }],
    expectedPlanRevision: "plan-1",
    deploymentVerified: true,
    verificationSummary: "Published and verified",
  }), /generation or exact repository revision changed/u);
  assert.equal(calls.some(([name]) => name === "complete"), false);
  assert.equal(calls.some(([name]) => name === "sync-primary"), false);
  assert.equal(calls.some(([name]) => name === "sync-dev"), false);
});


test("pending finalization rejects another plan without reusing its publication authority", async () => {
  const { service, calls } = fixture(undefined, { rebuildFailures: 1 });
  const request = { workspaceId: "workspace-1", expectedPlanRevision: "plan-1", deploymentVerified: true,
    verificationSummary: "verified", expectedRepositories: [{ projectRoot: "D:/repo", revision: "abc" }] };
  await service.completeRelease(request);
  const before = calls.length;
  await assert.rejects(service.completeRelease({ ...request, expectedPlanRevision: "plan-2" }), /another plan/u);
  assert.deepEqual(calls.slice(before), [["lock-await", "workspace-1"]]);
});

test("retry preserves completed stages and reconciles failed dev with the original exact revision", async () => {
  const { service, calls, state } = fixture(undefined, { devSync: { status: "conflict", integrated: false } });
  const request = { workspaceId: "workspace-1", expectedPlanRevision: "plan-1", deploymentVerified: true,
    verificationSummary: "verified", expectedRepositories: [{ projectRoot: "D:/repo", revision: "abc" }] };
  await service.completeRelease(request);
  assert.equal(state.pending.repositories[0].dev.completed, false);
  service.taskGitWorkspaces.synchronizeMainIntoDev = async (value) => {
    calls.push(["sync-dev", value]);
    return { status: "merged", integrated: true };
  };
  const result = await service.completeRelease(request);
  assert.equal(result.finalization.status, "completed");
  assert.equal(state.pending, null);
  assert.equal(calls.filter(([name]) => name === "sync-primary").length, 1);
  assert.equal(calls.filter(([name]) => name === "rebuild-await").length, 1);
  assert.equal(calls.filter(([name]) => name === "complete").length, 1);
  assert.deepEqual(calls.filter(([name]) => name === "sync-dev").map(([, args]) => args), [
    { projectRoot: "D:/repo", publishedRevision: "abc" },
    { projectRoot: "D:/repo", publishedRevision: "abc" },
  ]);
});
