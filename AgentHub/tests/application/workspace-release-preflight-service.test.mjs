import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";

function fixture({ planRevision = "plan-1", contourHead = "dev-head", rejectDev = null } = {}) {
  const calls = [];
  const projectRoot = path.resolve("D:/repo");
  const plan = {
    revision: planRevision,
    ready: [{ taskId: "task-1", projectRoot, resultCommit: "task-result" }],
    blocked: [],
    conflicts: [],
  };
  const service = new WorkspaceReleasePreflightService({
    releasePlanner: {
      plan: async (workspaceId) => {
        calls.push(["plan", workspaceId]);
        return plan;
      },
    },
    taskGitWorkspaces: {
      prepareDev: async (requestedProjectRoot) => {
        calls.push(["prepare-dev", requestedProjectRoot]);
        return {
          repositoryRoot: projectRoot,
          projectRoot: path.resolve("D:/dev-worktree"),
          branch: "dev",
          headCommit: "dev-head",
        };
      },
      verifyReleaseResultsInDev: async (request) => {
        calls.push(["verify-dev", request]);
        if (rejectDev) throw rejectDev;
        return {
          repositoryRoot: projectRoot,
          projectRoot: path.resolve("D:/dev-worktree"),
          branch: "dev",
          headCommit: "dev-head",
          resultCommits: ["task-result"],
        };
      },
    },
    resolveTestContourSource: async (repositories) => {
      calls.push(["resolve-contour", repositories]);
      return { ...repositories[0], sourceRoot: path.resolve("D:/dev-worktree/AgentHub") };
    },
    refreshTestContour: async (request) => {
      calls.push(["refresh-contour", request]);
    },
    readTestContourStatus: async () => {
      calls.push(["read-contour"]);
      return {
        running: true,
        root: "D:/test-contour",
        source: { branch: "dev", headCommit: contourHead },
      };
    },
  });
  return { calls, projectRoot, service };
}

test("release preflight verifies selected results in dev and always refreshes Test Contour", async () => {
  const { calls, projectRoot, service } = fixture();
  const result = await service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" });
  assert.deepEqual(calls.map(([name]) => name), [
    "plan", "prepare-dev", "resolve-contour", "refresh-contour", "read-contour", "verify-dev",
  ]);
  assert.deepEqual(calls[5][1], {
    projectRoot,
    resultCommits: ["task-result"],
    taskIds: ["task-1"],
  });
  assert.deepEqual(calls[3][1], { sourceRoot: path.resolve("D:/dev-worktree/AgentHub") });
  assert.equal(result.planRevision, "plan-1");
  assert.equal(result.testContour.headCommit, "dev-head");
});

test("release preflight rejects a refreshed contour that does not display dev HEAD", async () => {
  const { service } = fixture({ contourHead: "stale-head" });
  await assert.rejects(
    () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
    /does not match dev HEAD/u,
  );
});

test("release preflight refreshes the contour before rejecting Task results absent from dev", async () => {
  const { calls, service } = fixture({ rejectDev: new Error("Task result is not integrated into dev") });
  await assert.rejects(
    () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
    /not integrated into dev/u,
  );
  assert.deepEqual(calls.map(([name]) => name), [
    "plan", "prepare-dev", "resolve-contour", "refresh-contour", "read-contour", "verify-dev",
  ]);
});

test("release preflight binds all side effects to the exact plan revision", async () => {
  const { calls, service } = fixture();
  await assert.rejects(
    () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "older-plan" }),
    /revision changed/u,
  );
  assert.deepEqual(calls.map(([name]) => name), ["plan"]);
});
