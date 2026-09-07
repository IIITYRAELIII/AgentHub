import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceReleaseService } from "../../src/application/workspace-release-service.mjs";

function fixture(plan = {
  revision: "plan-1", ready: [{ id: "change-1" }], draft: [], blocked: [], conflicts: [],
}, { primarySync = null, rebuildFailures = 0 } = {}) {
  const calls = [];
  let pending = null;
  let remainingRebuildFailures = rebuildFailures;
  const releasePreflight = {
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
  };
  const service = new WorkspaceReleaseService({
    store: {
      awaitRebuildPending: () => pending,
      clearAwaitRebuildPending: () => {
        pending = null;
        return true;
      },
      completeRelease: (workspaceId, options) => {
        calls.push(["complete", workspaceId, options]);
        pending = options.awaitRebuild;
        return { workspaceId, released: plan.ready };
      },
    },
    releasePlanner: { plan: async () => plan },
    releaseGitWorkspaces: {
      synchronizePublishedPrimary: async (value) => {
        calls.push(["sync-primary", value]);
        return primarySync ?? { status: "fast_forwarded", publishedRevision: value.publishedRevision };
      },
    },
    releasePreflight,
    verifyPublication: async (value) => {
      calls.push(["verify", value]);
      return { repositories: [{ root: "D:/repo", revision: "abc" }] };
    },
  });
  return { calls, service, state: { get pending() { return pending; } } };
}

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
    expectedRevision: "abc",
    expectedPlanRevision: "plan-1",
    deploymentVerified: true,
    verificationSummary: "Published and smoke-tested",
  });
  assert.equal(result.publication.verificationSummary, "Published and smoke-tested");
  assert.equal(result.publication.planRevision, "plan-1");
  assert.deepEqual(calls.map(([name]) => name), ["lock-await", "verify", "sync-primary", "complete", "rebuild-await"]);
  assert.deepEqual(calls[2][1], {
    projectRoot: "D:/repo",
    publishedRevision: "abc",
    planRevision: "plan-1",
  });
  const { plan: completedPlan, ...completionOptions } = calls[3][2];
  assert.equal(completedPlan.revision, "plan-1");
  assert.deepEqual(completionOptions, {
    expectedPlanRevision: "plan-1",
    conflictsResolved: false,
    verificationEvidence: {
      planRevision: "plan-1",
      expectedRevision: "abc",
      verificationSummary: "Published and smoke-tested",
      conflictsResolved: false,
      publication: {
        repositories: [{ root: "D:/repo", revision: "abc" }],
        primarySynchronization: [{ status: "fast_forwarded", publishedRevision: "abc" }],
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
    },
  });
  assert.deepEqual(calls[4][1], {
    workspaceId: "workspace-1",
    fallbackProjectRoots: ["D:/repo"],
  });
  assert.equal(result.preReleaseIntegration.rebuilt, true);
});

test("failed post-publication Await rebuild is durable and retryable without completing twice", async () => {
  const { calls, service, state } = fixture(undefined, { rebuildFailures: 1 });
  const request = {
    workspaceId: "workspace-1",
    expectedRevision: "abc",
    expectedPlanRevision: "plan-1",
    deploymentVerified: true,
    verificationSummary: "Published and verified",
  };

  const first = await service.completeRelease(request);
  assert.equal(first.preReleaseIntegration.status, "retry_required");
  assert.match(first.preReleaseIntegration.reason, /injected rebuild failure/u);
  assert.deepEqual(state.pending, {
    planRevision: "plan-1",
    fallbackProjectRoots: ["D:/repo"],
  });

  const second = await service.completeRelease(request);
  assert.equal(second.releaseAlreadyCompleted, true);
  assert.equal(second.recoveredPlanRevision, "plan-1");
  assert.equal(second.preReleaseIntegration.rebuilt, true);
  assert.equal(state.pending, null);
  assert.equal(calls.filter(([name]) => name === "complete").length, 1);
  assert.equal(calls.filter(([name]) => name === "rebuild-await").length, 2);
});

test("release completion treats file overlap as diagnostic after effective-delta integration", async () => {
  const plan = {
    revision: "plan-conflict", ready: [{ id: "change-1" }, { id: "change-2" }], draft: [], blocked: [],
    conflicts: [{ file: "AgentHub/app.js" }],
  };
  const { calls, service } = fixture(plan);
  const request = {
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-conflict",
    deploymentVerified: true,
    verificationSummary: "Integrated overlap verified",
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
    expectedRevision: "abc",
    expectedPlanRevision: "plan-1",
    deploymentVerified: true,
    verificationSummary: "Published and verified",
  });
  assert.equal(result.publication.primarySynchronization[0].status, "manual_required");
  assert.deepEqual(calls.map(([name]) => name), ["lock-await", "verify", "sync-primary", "complete", "rebuild-await"]);
});
