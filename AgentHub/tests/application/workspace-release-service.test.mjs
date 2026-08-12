import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceReleaseService } from "../../src/application/workspace-release-service.mjs";

function fixture(plan = { ready: [{ id: "change-1" }], draft: [], blocked: [], conflicts: [] }) {
  const calls = [];
  const service = new WorkspaceReleaseService({
    store: {
      releasePlan: () => plan,
      completeRelease: (workspaceId) => {
        calls.push(["complete", workspaceId]);
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
    () => service.completeRelease({ workspaceId: "workspace-1" }),
    /requires verified deployment evidence/u,
  );
  assert.deepEqual(calls, []);
});

test("release completion verifies repositories before atomically closing ready changes", async () => {
  const { calls, service } = fixture();
  const result = await service.completeRelease({
    workspaceId: "workspace-1",
    expectedRevision: "abc",
    deploymentVerified: true,
    verificationSummary: "Published and smoke-tested",
  });
  assert.equal(result.publication.verificationSummary, "Published and smoke-tested");
  assert.deepEqual(calls.map(([name]) => name), ["verify", "complete"]);
});
