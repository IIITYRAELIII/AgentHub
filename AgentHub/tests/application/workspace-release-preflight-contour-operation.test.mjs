import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";

function fixture({ outcome = "exact", mutateStatus = (value) => value } = {}) {
  const projectRoot = path.resolve("D:/repo");
  const devRoot = path.resolve("D:/dev-worktree");
  const contourRoot = path.resolve("D:/test-contour");
  const target = { root: contourRoot, contourId: "contour-1", port: 8877, model: "fake-codex" };
  const operation = {
    operationId: "refresh-operation-1",
    status: "ready",
    phase: "ready",
    source: { branch: "dev", headCommit: "dev-head", sourceRoot: path.join(devRoot, "AgentHub") },
    target,
    releaseId: "release-1",
  };
  let refreshRequest = null;
  let statusRequest = null;
  let verified = false;
  const status = mutateStatus({
    running: true,
    root: contourRoot,
    source: { branch: "dev", headCommit: "dev-head" },
    status: "ready",
    planned: false,
    operation,
    state: {
      contourId: target.contourId,
      operationId: operation.operationId,
      releaseId: operation.releaseId,
      port: target.port,
      model: target.model,
    },
    readback: { outcome, operation, current: operation },
  });
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
        verified = true;
        return {
          repositoryRoot: projectRoot,
          projectRoot: devRoot,
          branch: "dev",
          headCommit: "dev-head",
          resultCommits: ["task-result"],
        };
      },
    },
    resolveTestContourSource: async () => ({
      projectRoot,
      sourceRoot: path.join(devRoot, "AgentHub"),
      branch: "dev",
      headCommit: "dev-head",
    }),
    refreshTestContour: async (request) => {
      refreshRequest = request;
      return {
        operationId: operation.operationId,
        operation,
        source: operation.source,
        refreshOutcome: "refreshed",
      };
    },
    readTestContourStatus: async (request) => {
      statusRequest = request;
      return status;
    },
  });
  return {
    service,
    operation,
    get refreshRequest() { return refreshRequest; },
    get statusRequest() { return statusRequest; },
    get verified() { return verified; },
  };
}

test("release preflight requires a fresh candidate and an exact-ready operation readback", async () => {
  const context = fixture();
  const result = await context.service.preflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
  });
  assert.equal(result.testContour.headCommit, "dev-head");
  assert.deepEqual(context.refreshRequest, {
    sourceRoot: path.resolve("D:/dev-worktree/AgentHub"),
    forceFreshCandidate: true,
  });
  assert.deepEqual(context.statusRequest, {
    expectedOperationId: context.operation.operationId,
    expectedHeadCommit: "dev-head",
  });
  assert.equal(context.verified, true);
});

for (const outcome of ["superseded", "not_found", "failed", "refreshing"]) {
  test(`release preflight fails closed for ${outcome} operation readback`, async () => {
    const context = fixture({ outcome });
    await assert.rejects(
      () => context.service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
      new RegExp(`not exact-ready: ${outcome}`, "u"),
    );
    assert.equal(context.verified, false);
  });
}

test("release preflight rejects exact outcome carrying a different target identity", async () => {
  const context = fixture({
    mutateStatus: (status) => ({
      ...status,
      readback: {
        ...status.readback,
        operation: {
          ...status.readback.operation,
          target: { ...status.readback.operation.target, port: 8878 },
        },
      },
    }),
  });
  await assert.rejects(
    () => context.service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
    /not exact-ready: exact/u,
  );
  assert.equal(context.verified, false);
});
