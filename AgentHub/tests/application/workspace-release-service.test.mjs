import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceReleaseService } from "../../src/application/workspace-release-service.mjs";

function fixture(plan = {
  revision: "plan-1", ready: [{ id: "change-1" }], draft: [], blocked: [], conflicts: [],
}) {
  const calls = [];
  const service = new WorkspaceReleaseService({
    store: {
      releasePlan: () => plan,
      completeRelease: (workspaceId, options) => {
        calls.push(["complete", workspaceId, options]);
        return { workspaceId, released: plan.ready };
      },
    },
    verifyPublication: async (value) => {
      calls.push(["verify", value]);
      return { repositories: [{ root: "D:/repo", revision: "abc" }] };
    },
  });
  return { calls, service };
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
  assert.deepEqual(calls.map(([name]) => name), ["verify", "complete"]);
  assert.deepEqual(calls[1][2], {
    expectedPlanRevision: "plan-1",
    conflictsResolved: false,
    verificationEvidence: {
      planRevision: "plan-1",
      expectedRevision: "abc",
      verificationSummary: "Published and smoke-tested",
      conflictsResolved: false,
    },
  });
});

test("release completion requires and records explicit resolution of overlapping ready changes", async () => {
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
  await assert.rejects(() => service.completeRelease(request), /overlapping files/u);
  await service.completeRelease({ ...request, conflictsResolved: true });
  assert.equal(calls[1][2].conflictsResolved, true);
  assert.equal(calls[1][2].verificationEvidence.conflictsResolved, true);
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
