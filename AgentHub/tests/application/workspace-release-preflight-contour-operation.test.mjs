import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";

test("release preflight rejects a superseded exact contour operation", async () => {
  const projectRoot = path.resolve("D:/repo");
  const devRoot = path.resolve("D:/dev-worktree");
  let statusRequest = null;
  const service = new WorkspaceReleasePreflightService({
    releasePlanner: {
      plan: async () => ({
        revision: "plan-1",
        ready: [{ taskId: "task-1", projectRoot, resultCommit: "task-result" }],
        blocked: [],
        conflicts: [],
      }),
    },
    taskGitWorkspaces: {
      prepareDev: async () => ({
        repositoryRoot: projectRoot,
        projectRoot: devRoot,
        branch: "dev",
        headCommit: "dev-head",
      }),
      verifyReleaseResultsInDev: async () => {
        throw new Error("superseded refresh must stop before result verification");
      },
    },
    releaseGitWorkspaces: {
      assertPrimaryInvariant: async () => ({
        projectRoot,
        branch: "refs/heads/main",
        headCommit: "main-head",
      }),
      prepareCandidate: async () => {
        throw new Error("superseded refresh must stop before candidate preparation");
      },
    },
    resolveTestContourSource: async () => ({
      projectRoot,
      sourceRoot: path.join(devRoot, "AgentHub"),
      branch: "dev",
      headCommit: "dev-head",
    }),
    refreshTestContour: async () => ({
      operationId: "refresh-operation-1",
      source: { branch: "dev", headCommit: "dev-head" },
    }),
    readTestContourStatus: async (request) => {
      statusRequest = request;
      return {
        running: true,
        source: { branch: "dev", headCommit: "newer-dev-head" },
        readback: { outcome: "superseded" },
      };
    },
  });

  await assert.rejects(
    () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
    /was superseded; retry preflight/u,
  );
  assert.deepEqual(statusRequest, {
    expectedOperationId: "refresh-operation-1",
    expectedHeadCommit: "dev-head",
  });
});
