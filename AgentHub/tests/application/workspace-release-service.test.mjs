import assert from "node:assert/strict";
import test from "node:test";

import { createTaskBoardMutationOwner } from "../../src/application/sqlite-mutation-owner.mjs";
import { WorkspaceReleaseService } from "../../src/application/workspace-release-service.mjs";

function fixture(plan = {
  revision: "plan-1", ready: [{ id: "change-1" }],
  candidates: [{ gitReferences: [{ projectRoot: "D:/repo", resultCommit: "task-result" }] }],
  draft: [], blocked: [], conflicts: [],
}, { primarySync = null } = {}) {
  const calls = [];
  const service = new WorkspaceReleaseService({
    store: createTaskBoardMutationOwner({
      runMutation: (operation) => Promise.resolve().then(operation),
      completeRelease: (workspaceId, options) => {
        calls.push(["complete", workspaceId, options]);
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
  return { calls, service };
}

test("release completion rejects a raw Task store dependency", () => {
  assert.throws(() => new WorkspaceReleaseService({
    store: { completeRelease() {} },
    releasePlanner: { plan() {} },
    releaseGitWorkspaces: { frozenCandidate() {}, synchronizePublishedPrimary() {} },
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
  assert.deepEqual(calls.map(([name]) => name), ["verify", "verify", "complete", "sync-primary"]);
  assert.deepEqual(calls[3][1], {
    projectRoot: "D:/repo",
    publishedRevision: "abc",
    planRevision: "plan-1",
  });
  const { plan: completedPlan, ...completionOptions } = calls[2][2];
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
        verificationSummary: "Published and smoke-tested",
        planRevision: "plan-1",
      },
      deployment: {
        verified: true,
        summary: "Published and smoke-tested",
      },
    },
  });
});

test("release completion requires and records explicit resolution of overlapping ready changes", async () => {
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
  await assert.rejects(() => service.completeRelease(request), /overlapping files/u);
  await service.completeRelease({ ...request, conflictsResolved: true });
  assert.equal(calls[0][1].conflictsResolved, true);
  assert.equal(calls[2][2].conflictsResolved, true);
  assert.equal(calls[2][2].verificationEvidence.conflictsResolved, true);
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
  assert.deepEqual(calls, []);
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
  assert.deepEqual(calls.map(([name]) => name), ["verify", "verify", "complete", "sync-primary"]);
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
});
