import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { createRepositoryProductionValidationAdapter } from "../../src/infrastructure/process/repository-production-validation.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

async function commit(cwd, message) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function exactProductionValidation({ workspaceId = "workspace-1", planRevision = "plan-1", repositories }) {
  return {
    status: "ready",
    workspaceId,
    planRevision,
    repositories: repositories.map((repository) => ({
      projectRoot: repository.projectRoot,
      headCommit: repository.headCommit,
      resultCommits: [...repository.resultCommits],
      taskIds: [...repository.taskIds],
      frozenTasks: [...repository.frozenTasks],
      candidateCommit: repository.frozenCandidate?.preReleaseHead ?? null,
      candidateTree: repository.frozenCandidate?.tree ?? null,
    })),
    check: { kind: "repository-owned-qa", id: "qa-check-1" },
  };
}

function originalReceipt(overrides = {}) {
  return {
    requestId: "architect-bwm12-release-preflight-20260912-v1",
    workspaceId: "workspace-1",
    streamId: "architect",
    provider: "codex",
    threadId: "thread-architect",
    toolName: "hub_release_preflight",
    argumentsHash: "preflight-args",
    expectedArgumentsHash: "preflight-args",
    status: "unknown",
    ...overrides,
  };
}

function fixture({ planRevision = "plan-1", contourHead = "dev-head", rejectDev = null, rejectPrimary = null } = {}) {
  const calls = [];
  const locks = [];
  const projectRoot = path.resolve("D:/repo");
  const plan = {
    revision: planRevision,
    ready: [{ taskId: "task-1", taskRevision: 7, projectRoot, resultCommit: "task-result" }],
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
      assertExplicitUpstreamAdoption: async (request) => {
        calls.push(["verify-upstream-adoption", request]);
        return { adoptedByResultCommit: null };
      },
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
      releaseIntegrationEvidence: async (request) => {
        calls.push(["release-integrations", request]);
        return {
          repositoryRoot: projectRoot,
          projectRoot: path.resolve("D:/dev-worktree"),
          branch: "dev",
          headCommit: "dev-head",
          tasks: [{
            taskId: "task-1",
            taskRevision: 7,
            resultCommit: "task-result",
            integrations: [{ commit: "integration-1", parent: "integration-parent", order: 1 }],
          }],
        };
      },
    },
    releaseGitWorkspaces: {
      withAwaitTransition: async (workspaceId, operation) => {
        locks.push(workspaceId);
        return operation();
      },
      assertPrimaryInvariant: async (requestedProjectRoot, options) => {
        calls.push(["guard-primary", requestedProjectRoot, options]);
        if (rejectPrimary) throw rejectPrimary;
        return { projectRoot: requestedProjectRoot, branch: "refs/heads/main", headCommit: "main-head" };
      },
      inspectMainChanges: async (request) => {
        calls.push(["inspect-main", request]);
        return {
          projectRoot,
          publishedRevision: "published-head",
          localMain: "main-head",
          originMain: "main-head",
          commits: [],
          changed: false,
          diverged: false,
          approved: false,
          approvalRequired: false,
        };
      },
      prepareCandidate: async (request) => {
        calls.push(["prepare-candidate", request]);
        return {
          repositoryRoot: request.projectRoot,
          releaseRoot: path.resolve("D:/release-clone"),
          preReleaseHead: "prerelease-head",
          manifestHash: "manifest-hash",
          primaryPreserved: true,
        };
      },
    },
    readPublicationState: async () => ({
      repositories: [{ root: projectRoot, revision: "published-head" }],
    }),
    resolveTestContourSource: async (repositories) => {
      calls.push(["resolve-contour", repositories]);
      return { kind: "agent-hub-test-contour", ...repositories[0], sourceRoot: path.resolve("D:/dev-worktree/AgentHub") };
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
  const contourTarget = {
    root: path.resolve("D:/test-contour"),
    contourId: "contour-1",
    port: 8877,
    model: "fake-codex",
  };
  const contourOperation = {
    operationId: "operation-1",
    status: "ready",
    phase: "ready",
    source: {
      branch: "dev",
      headCommit: "dev-head",
      sourceRoot: path.resolve("D:/dev-worktree/AgentHub"),
    },
    target: contourTarget,
    releaseId: "release-1",
  };
  // Keep this compatibility fixture additive so concurrent release-candidate
  // coverage can retain its own service dependencies and call ordering.
  service.refreshTestContour = async (request) => {
    calls.push(["refresh-contour", { sourceRoot: request.sourceRoot }]);
    return {
      operationId: contourOperation.operationId,
      operation: contourOperation,
      source: contourOperation.source,
      refreshOutcome: "refreshed",
    };
  };
  service.readTestContourStatus = async () => {
    calls.push(["read-contour"]);
    return {
      running: true,
      root: contourTarget.root,
      source: { branch: "dev", headCommit: contourHead },
      status: "ready",
      planned: false,
      operation: contourOperation,
      state: {
        contourId: contourTarget.contourId,
        operationId: contourOperation.operationId,
        releaseId: contourOperation.releaseId,
        port: contourTarget.port,
        model: contourTarget.model,
      },
      readback: { outcome: "exact", operation: contourOperation, current: contourOperation },
    };
  };
  return { calls, locks, projectRoot, service };
}

test("release preflight verifies selected results in dev and always refreshes Test Contour", async () => {
  const { calls, locks, projectRoot, service } = fixture();
  const result = await service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" });
  assert.deepEqual(calls.map(([name]) => name), [
    "plan", "inspect-main", "verify-upstream-adoption", "guard-primary", "prepare-dev", "resolve-contour", "refresh-contour", "read-contour",
    "verify-dev", "release-integrations", "prepare-candidate", "plan",
  ]);
  assert.deepEqual(locks, ["workspace-1"]);
  assert.deepEqual(calls[8][1], {
    projectRoot,
    resultCommits: ["task-result"],
    taskIds: ["task-1"],
  });
  assert.deepEqual(calls[6][1], { sourceRoot: path.resolve("D:/dev-worktree/AgentHub") });
  assert.deepEqual(calls[10][1].frozenTasks, [{
    taskId: "task-1",
    taskRevision: 7,
    resultCommit: "task-result",
    integrations: [{ commit: "integration-1", parent: "integration-parent", order: 1 }],
  }]);
  assert.equal(calls[10][1].approvedBaseCommit, "main-head");
  assert.equal(result.planRevision, "plan-1");
  assert.equal(result.testContour.headCommit, "dev-head");
  assert.equal(result.releaseCandidates[0].manifestHash, "manifest-hash");
  assert.equal(result.status, "ready");
});

test("release preflight returns every post-publication main commit before side effects", async () => {
  const { calls, service } = fixture();
  service.releaseGitWorkspaces.inspectMainChanges = async (request) => {
    calls.push(["inspect-main", request]);
    return {
      projectRoot: request.projectRoot,
      publishedRevision: request.publishedRevision,
      localMain: "local-main",
      originMain: "origin-main",
      commits: [{ commit: "external-commit", subject: "external" }],
      changed: true,
      diverged: true,
      approved: false,
      approvalRequired: true,
    };
  };

  const result = await service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" });

  assert.equal(result.status, "main_review_required");
  assert.equal(result.mainAudits[0].commits[0].commit, "external-commit");
  assert.deepEqual(calls.map(([name]) => name), ["plan", "inspect-main"]);
});

test("approved upstream still requires adoption by a selected Task before preflight side effects", async () => {
  const { calls, projectRoot, service } = fixture();
  service.releaseGitWorkspaces.inspectMainChanges = async (request) => {
    calls.push(["inspect-main", request]);
    return {
      projectRoot,
      publishedRevision: "published-head",
      localMain: "local-main",
      originMain: "approved-origin-main",
      commits: [{ commit: "approved-origin-main" }],
      changed: true,
      diverged: true,
      approved: true,
      approvalRequired: false,
    };
  };
  service.taskGitWorkspaces.assertExplicitUpstreamAdoption = async (request) => {
    calls.push(["verify-upstream-adoption", request]);
    throw new Error("approved upstream requires explicit adoption by a selected Task result and managed dev");
  };

  await assert.rejects(service.preflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    approvedRepositories: [{
      projectRoot,
      approvedLocalMainCommit: "local-main",
      approvedOriginMainCommit: "approved-origin-main",
    }],
  }), /requires explicit adoption by a selected Task/u);
  assert.deepEqual(calls.map(([name]) => name), ["plan", "inspect-main", "verify-upstream-adoption"]);
  const request = calls.find(([name]) => name === "verify-upstream-adoption")[1];
  assert.deepEqual(request.frozenTasks, [{
    taskId: "task-1",
    taskRevision: 7,
    taskNumber: null,
    projectRoot,
    branch: undefined,
    resultCommit: "task-result",
  }]);
  assert.equal("resultCommits" in request, false);
});

test("release preflight rejects an unscoped global publication baseline", async () => {
  const { calls, service } = fixture();
  service.readPublicationState = async () => ({ revision: "foreign-agent-hub-sha" });

  await assert.rejects(
    () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
    /repository-scoped publication evidence/u,
  );
  assert.deepEqual(calls.map(([name]) => name), ["plan"]);
});

test("release preflight binds approved main commits to the selected repository", async () => {
  const { calls, projectRoot, service } = fixture();
  service.releaseGitWorkspaces.inspectMainChanges = async (request) => {
    calls.push(["inspect-main", request]);
    return {
      projectRoot: request.projectRoot,
      publishedRevision: request.publishedRevision,
      localMain: "local-main",
      originMain: "origin-main",
      commits: [{ commit: "external-commit", subject: "external" }],
      changed: true,
      diverged: true,
      approved: request.approvedLocalMainCommit === "local-main"
        && request.approvedOriginMainCommit === "origin-main",
      approvalRequired: request.approvedLocalMainCommit !== "local-main"
        || request.approvedOriginMainCommit !== "origin-main",
    };
  };

  const stale = await service.preflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    approvedRepositories: [{
      projectRoot,
      approvedLocalMainCommit: "old-local",
      approvedOriginMainCommit: "origin-main",
    }],
  });
  assert.equal(stale.status, "main_review_required");
  assert.equal(stale.mainAudits[0].approvalRequired, true);

  await assert.rejects(
    () => service.preflight({
      workspaceId: "workspace-1",
      expectedPlanRevision: "plan-1",
      approvedRepositories: [{
        projectRoot: path.resolve("D:/other-repo"),
        approvedLocalMainCommit: "local-main",
        approvedOriginMainCommit: "origin-main",
      }],
    }),
    /unrelated repository/u,
  );

  const approved = await service.preflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    approvedRepositories: [{
      projectRoot,
      approvedLocalMainCommit: "local-main",
      approvedOriginMainCommit: "origin-main",
    }],
  });
  assert.equal(approved.status, "ready");
  assert.equal(approved.mainAudits[0].approved, true);
});

test("release preflight requires repository-scoped top-level approvals for multi-repository plans", async () => {
  const repoA = path.resolve("D:/repo-a");
  const repoB = path.resolve("D:/repo-b");
  const plan = {
    revision: "plan-1",
    ready: [
      { taskId: "task-a", taskRevision: 2, projectRoot: repoA, resultCommit: "result-a" },
      { taskId: "task-b", taskRevision: 3, projectRoot: repoB, resultCommit: "result-b" },
    ],
    blocked: [],
    conflicts: [],
  };
  const service = new WorkspaceReleasePreflightService({
    releasePlanner: { plan: async () => plan },
    taskGitWorkspaces: {
      assertExplicitUpstreamAdoption: async () => ({}),
      prepareDev: async (projectRoot) => ({ repositoryRoot: projectRoot, projectRoot, branch: "dev", headCommit: `dev-${path.basename(projectRoot)}` }),
      verifyReleaseResultsInDev: async ({ projectRoot, resultCommits }) => ({
        repositoryRoot: projectRoot, projectRoot, branch: "dev", headCommit: `dev-${path.basename(projectRoot)}`,
        resultCommits,
      }),
      releaseIntegrationEvidence: async ({ projectRoot, tasks }) => ({
        repositoryRoot: projectRoot,
        projectRoot,
        branch: "dev",
        headCommit: `dev-${path.basename(projectRoot)}`,
        tasks: tasks.map((task, order) => ({
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          resultCommit: task.resultCommit,
          integrations: [{ commit: `integration-${task.taskId}`, parent: "parent", order }],
        })),
      }),
    },
    releaseGitWorkspaces: {
      withAwaitTransition: async (_workspaceId, operation) => operation(),
      assertPrimaryInvariant: async (projectRoot) => ({ projectRoot, branch: "refs/heads/main", headCommit: `main-${path.basename(projectRoot)}` }),
      inspectMainChanges: async (request) => ({
        projectRoot: request.projectRoot,
        publishedRevision: request.publishedRevision,
        localMain: `local-${path.basename(request.projectRoot)}`,
        originMain: `origin-${path.basename(request.projectRoot)}`,
        commits: [{ commit: `commit-${path.basename(request.projectRoot)}` }],
        approvalRequired: false,
      }),
      prepareCandidate: async (request) => ({
        repositoryRoot: request.projectRoot,
        preReleaseHead: `pre-${path.basename(request.projectRoot)}`,
        manifestHash: `manifest-${path.basename(request.projectRoot)}`,
      }),
      frozenCandidate: async (projectRoot) => ({
        repositoryRoot: projectRoot,
        releaseRoot: path.join(projectRoot, "release"),
        checkpointPhase: "prepared",
        planRevision: "plan-1",
        baseCommit: `origin-${path.basename(projectRoot)}`,
        preReleaseHead: `pre-${path.basename(projectRoot)}`,
        tree: `tree-${path.basename(projectRoot)}`,
        manifestHash: `manifest-${path.basename(projectRoot)}`,
        manifest: {
          workspaceId: "workspace-1",
          planRevision: "plan-1",
          baseCommit: `origin-${path.basename(projectRoot)}`,
          tasks: plan.ready
            .filter((task) => path.resolve(task.projectRoot) === path.resolve(projectRoot))
            .map((task) => ({
              taskId: task.taskId,
              taskRevision: task.taskRevision,
              resultCommit: task.resultCommit,
            })),
        },
      }),
    },
    readPublicationState: async () => ({
      repositories: [
        { root: repoA, revision: "published-a" },
        { root: repoB, revision: "published-b" },
      ],
    }),
    resolveTestContourSource: async () => ({
      kind: "external-validation-required",
      reason: "non-AgentHub validation required",
    }),
    refreshTestContour: async () => assert.fail("multi-repository non-AgentHub preflight must not run AgentHub Test Contour"),
    readTestContourStatus: async () => assert.fail("multi-repository non-AgentHub preflight must not read AgentHub Test Contour"),
    validateProductionCandidate: async ({ workspaceId, planRevision, repositories }) => ({
      ...exactProductionValidation({ workspaceId, planRevision, repositories }),
      kind: "external",
    }),
  });

  await assert.rejects(
    () => service.preflight({
      workspaceId: "workspace-1",
      expectedPlanRevision: "plan-1",
      approvedLocalMainCommit: "local-repo-a",
      approvedOriginMainCommit: "origin-repo-a",
    }),
    /top-level approved release main commits/u,
  );

  const result = await service.preflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    approvedRepositories: [
      { projectRoot: repoA, approvedLocalMainCommit: "local-repo-a", approvedOriginMainCommit: "origin-repo-a" },
      { projectRoot: repoB, approvedLocalMainCommit: "local-repo-b", approvedOriginMainCommit: "origin-repo-b" },
    ],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.productionValidation.kind, "external");
  assert.deepEqual(result.mainAudits.map((audit) => audit.publishedRevision), ["published-a", "published-b"]);
  assert.equal(result.releaseCandidates.length, 2);
});

test("release preflight rejects stale external production validation evidence", async () => {
  const repo = path.resolve("D:/android-repo");
  const plan = {
    revision: "plan-android",
    ready: [{ taskId: "task-android", taskRevision: 2, projectRoot: repo, resultCommit: "result-android" }],
    blocked: [],
    conflicts: [],
  };
  const service = new WorkspaceReleasePreflightService({
    releasePlanner: { plan: async () => plan },
    taskGitWorkspaces: {
      assertExplicitUpstreamAdoption: async () => ({}),
      prepareDev: async (projectRoot) => ({
        repositoryRoot: projectRoot, projectRoot, branch: "dev", headCommit: "dev-current",
      }),
      verifyReleaseResultsInDev: async ({ projectRoot, resultCommits }) => ({
        repositoryRoot: projectRoot, projectRoot, branch: "dev", headCommit: "dev-current", resultCommits,
      }),
      releaseIntegrationEvidence: async ({ projectRoot, tasks }) => ({
        repositoryRoot: projectRoot, projectRoot, branch: "dev", headCommit: "dev-current", tasks,
      }),
    },
    releaseGitWorkspaces: {
      withAwaitTransition: async (_workspaceId, operation) => operation(),
      assertPrimaryInvariant: async (projectRoot) => ({ projectRoot, branch: "refs/heads/main", headCommit: "main" }),
      inspectMainChanges: async (request) => ({ projectRoot: request.projectRoot, publishedRevision: request.publishedRevision, localMain: "main", originMain: "main", commits: [], approvalRequired: false }),
      prepareCandidate: async (request) => ({ repositoryRoot: request.projectRoot, preReleaseHead: "candidate", manifestHash: "manifest-android" }),
      frozenCandidate: async (projectRoot) => ({
        repositoryRoot: projectRoot,
        releaseRoot: path.join(projectRoot, "release"),
        checkpointPhase: "prepared",
        planRevision: "plan-android",
        baseCommit: "main",
        preReleaseHead: "candidate",
        tree: "tree-android",
        manifestHash: "manifest-android",
        manifest: {
          workspaceId: "workspace-1",
          planRevision: "plan-android",
          baseCommit: "main",
          tasks: [{ taskId: "task-android", taskRevision: 2, resultCommit: "result-android" }],
        },
      }),
    },
    readPublicationState: async () => ({ repositories: [{ root: repo, revision: "published" }] }),
    resolveTestContourSource: async () => ({ kind: "external-validation-required", repositories: [{ projectRoot: repo }] }),
    refreshTestContour: async () => assert.fail("external validation must not refresh AgentHub contour"),
    readTestContourStatus: async () => assert.fail("external validation must not read AgentHub contour"),
    validateProductionCandidate: async ({ workspaceId, planRevision, repositories }) => ({
      ...exactProductionValidation({ workspaceId, planRevision, repositories }),
      repositories: [{ ...repositories[0], headCommit: "dev-stale" }],
    }),
  });

  await assert.rejects(
    () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-android" }),
    /stale/u,
  );

  service.validateProductionCandidate = async ({ workspaceId, planRevision, repositories }) => ({
    ...exactProductionValidation({ workspaceId, planRevision, repositories }),
    repositories: [{ ...exactProductionValidation({ workspaceId, planRevision, repositories }).repositories[0], candidateCommit: "candidate-old" }],
  });
  await assert.rejects(
    () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-android" }),
    /stale/u,
  );
});

async function realExternalValidationFixture(t, { afterValidation = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-preflight-real-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  const dataDir = path.join(root, "data");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await git(primary, "config", "core.autocrlf", "false");
  await mkdir(path.join(primary, "AgentHub"), { recursive: true });
  await writeFile(path.join(primary, "AgentHub", "package.json"), "{}\n", "utf8");
  await writeFile(path.join(primary, "app.txt"), "base\n", "utf8");
  const base = await commit(primary, "base");
  await git(primary, "push", "-u", "origin", "main");
  const taskRoot = path.join(root, "task");
  await git(primary, "worktree", "add", "-b", "HUB-real-adapter", taskRoot, "main");
  t.after(() => git(primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  await writeFile(path.join(taskRoot, "app.txt"), "candidate\n", "utf8");
  const resultCommit = await commit(taskRoot, "task result");
  const releaseGitWorkspaces = new ReleaseGitWorkspaceService({ dataDir });
  let validationCalls = 0;
  const plan = {
    revision: "plan-real-adapter",
    ready: [{ taskId: "task-real", taskRevision: 2, projectRoot: primary, resultCommit }],
    blocked: [],
    conflicts: [],
  };
  const service = new WorkspaceReleasePreflightService({
    releasePlanner: { plan: async () => plan },
    taskGitWorkspaces: {
      assertExplicitUpstreamAdoption: async () => ({}),
      prepareDev: async (projectRoot) => ({
        repositoryRoot: projectRoot,
        projectRoot,
        branch: "dev",
        headCommit: resultCommit,
      }),
      verifyReleaseResultsInDev: async ({ projectRoot, resultCommits }) => ({
        repositoryRoot: projectRoot,
        projectRoot,
        branch: "dev",
        headCommit: resultCommit,
        resultCommits,
      }),
      releaseIntegrationEvidence: async ({ projectRoot, tasks }) => ({
        repositoryRoot: projectRoot,
        projectRoot,
        branch: "dev",
        headCommit: resultCommit,
        tasks: tasks.map((task) => ({ ...task, integrations: [] })),
      }),
    },
    releaseGitWorkspaces,
    readPublicationState: async () => ({ repositories: [{ root: primary, revision: base }] }),
    resolveTestContourSource: async () => ({ kind: "external-validation-required", reason: "fixture external QA" }),
    refreshTestContour: async () => assert.fail("external fixture must not refresh AgentHub contour"),
    readTestContourStatus: async () => assert.fail("external fixture must not read AgentHub contour"),
    validateProductionCandidate: async (request) => {
      const result = await createRepositoryProductionValidationAdapter({
        dataDir: path.join(dataDir, "validation"),
        policies: [{
          enabled: true,
          projectRoot: primary,
          check: {
            kind: "fixture-qa",
            id: "real-frozen-candidate",
            commands: [{ command: "git", args: ["rev-parse", "HEAD"] }],
            artifacts: ["app.txt"],
          },
        }],
      })(request);
      validationCalls += 1;
      await afterValidation?.({ root, primary, dataDir, releaseGitWorkspaces, result, validationCalls, base, resultCommit });
      return result;
    },
  });
  return { root, primary, dataDir, base, resultCommit, releaseGitWorkspaces, service };
}

test("release preflight composes real frozen candidate readback with the repository validation adapter", async (t) => {
  const { primary, service } = await realExternalValidationFixture(t);

  const result = await service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-real-adapter" });

  assert.equal(result.status, "ready");
  assert.equal(result.productionValidation.repositories[0].candidateCommit, result.releaseCandidates[0].preReleaseHead);
  assert.equal(result.productionValidation.evidence[0].manifestHash, result.releaseCandidates[0].manifestHash);
  assert.equal(typeof result.productionValidation.evidence[0].evidenceHash, "string");
  assert.equal(await git(primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(primary, "status", "--porcelain=v1"), "");
});

test("release preflight rejects source candidate movement after external validation", async (t) => {
  const context = await realExternalValidationFixture(t, {
    afterValidation: async ({ releaseGitWorkspaces, primary, base }) => {
      const candidate = await releaseGitWorkspaces.frozenCandidate(primary);
      await git(candidate.releaseRoot, "checkout", "--detach", base);
    },
  });

  await assert.rejects(
    () => context.service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-real-adapter" }),
    /frozen candidate|release checkpoint clone/u,
  );
  assert.equal(await git(context.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
});

test("release preflight rejects primary movement after external validation", async (t) => {
  const context = await realExternalValidationFixture(t, {
    afterValidation: async ({ primary }) => {
      await git(primary, "checkout", "--detach", "HEAD");
    },
  });

  await assert.rejects(
    () => context.service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-real-adapter" }),
    /primary Workspace invariant/u,
  );
});

test("release preflight requires external validation for repositories not covered by AgentHub contour", async () => {
  const repoHub = path.resolve("D:/agent-hub");
  const repoAndroid = path.resolve("D:/android");
  const plan = {
    revision: "plan-mixed",
    ready: [
      { taskId: "task-hub", taskRevision: 2, projectRoot: repoHub, resultCommit: "result-hub" },
      { taskId: "task-android", taskRevision: 3, projectRoot: repoAndroid, resultCommit: "result-android" },
    ],
    blocked: [],
    conflicts: [],
  };
  const repositories = new Map();
  const calls = [];
  const service = new WorkspaceReleasePreflightService({
    releasePlanner: { plan: async () => plan },
    taskGitWorkspaces: {
      assertExplicitUpstreamAdoption: async () => ({}),
      prepareDev: async (projectRoot) => {
        const prepared = {
          repositoryRoot: projectRoot,
          projectRoot: path.join(projectRoot, "dev"),
          branch: "dev",
          headCommit: projectRoot === repoHub ? "dev-hub" : "dev-android",
        };
        repositories.set(projectRoot, prepared);
        return prepared;
      },
      verifyReleaseResultsInDev: async ({ projectRoot, resultCommits }) => ({
        ...repositories.get(projectRoot), resultCommits,
      }),
      releaseIntegrationEvidence: async ({ projectRoot, tasks }) => ({
        ...repositories.get(projectRoot),
        tasks: tasks.map((task) => ({ ...task, integrations: [{ commit: `integration-${task.taskId}`, parent: "parent", order: 1 }] })),
      }),
    },
    releaseGitWorkspaces: {
      withAwaitTransition: async (_workspaceId, operation) => operation(),
      assertPrimaryInvariant: async (projectRoot) => ({ projectRoot, branch: "refs/heads/main", headCommit: "main" }),
      inspectMainChanges: async (request) => ({ projectRoot: request.projectRoot, publishedRevision: request.publishedRevision, localMain: "main", originMain: "main", commits: [], approvalRequired: false }),
      prepareCandidate: async (request) => ({
        repositoryRoot: request.projectRoot,
        preReleaseHead: `candidate-${path.basename(request.projectRoot)}`,
        manifestHash: `manifest-${path.basename(request.projectRoot)}`,
      }),
      frozenCandidate: async (projectRoot) => ({
        repositoryRoot: projectRoot,
        releaseRoot: path.join(projectRoot, "release"),
        checkpointPhase: "prepared",
        planRevision: "plan-mixed",
        baseCommit: "main",
        preReleaseHead: `candidate-${path.basename(projectRoot)}`,
        tree: `tree-${path.basename(projectRoot)}`,
        manifestHash: `manifest-${path.basename(projectRoot)}`,
        manifest: {
          workspaceId: "workspace-1",
          planRevision: "plan-mixed",
          baseCommit: "main",
          tasks: plan.ready
            .filter((task) => path.resolve(task.projectRoot) === path.resolve(projectRoot))
            .map((task) => ({
              taskId: task.taskId,
              taskRevision: task.taskRevision,
              resultCommit: task.resultCommit,
            })),
        },
      }),
    },
    readPublicationState: async () => ({
      repositories: [{ root: repoHub, revision: "published-hub" }, { root: repoAndroid, revision: "published-android" }],
    }),
    resolveTestContourSource: async (prepared) => ({ kind: "agent-hub-test-contour", ...prepared[0], sourceRoot: path.join(prepared[0].worktreeRoot, "AgentHub") }),
    refreshTestContour: async () => ({
      operationId: "mixed-contour",
      refreshOutcome: "refreshed",
      operation: {
        operationId: "mixed-contour",
        status: "ready",
        phase: "ready",
        releaseId: "release-mixed",
        source: { headCommit: "dev-hub" },
        target: { root: "D:/contour", contourId: "contour", port: 88, model: "codex" },
      },
    }),
    readTestContourStatus: async () => ({
      running: true,
      status: "ready",
      planned: false,
      root: "D:/contour",
      source: { headCommit: "dev-hub" },
      operation: {
        operationId: "mixed-contour", status: "ready", phase: "ready", releaseId: "release-mixed",
        source: { headCommit: "dev-hub" }, target: { root: "D:/contour", contourId: "contour", port: 88, model: "codex" },
      },
      state: { operationId: "mixed-contour", releaseId: "release-mixed", contourId: "contour", port: 88, model: "codex" },
      readback: { outcome: "exact", operation: {
        operationId: "mixed-contour", status: "ready", phase: "ready", releaseId: "release-mixed",
        source: { headCommit: "dev-hub" }, target: { root: "D:/contour", contourId: "contour", port: 88, model: "codex" },
      } },
    }),
    validateProductionCandidate: async ({ workspaceId, planRevision, repositories: requested }) => {
      calls.push(requested.map((repository) => ({
        projectRoot: repository.projectRoot,
        candidate: repository.frozenCandidate?.preReleaseHead,
      })));
      return exactProductionValidation({ workspaceId, planRevision, repositories: requested });
    },
  });

  const result = await service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-mixed" });

  assert.deepEqual(calls, [[{ projectRoot: repoAndroid, candidate: "candidate-android" }]]);
  assert.equal(result.status, "ready");
  assert.equal(result.testContour.headCommit, "dev-hub");
  assert.equal(result.productionValidation.repositories[0].projectRoot, repoAndroid);
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
    "plan", "inspect-main", "verify-upstream-adoption", "guard-primary", "prepare-dev", "resolve-contour", "refresh-contour", "read-contour", "verify-dev",
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

test("release preflight stops before side effects when the registered primary is detached", async () => {
  const { calls, service } = fixture({ rejectPrimary: new Error("primary must remain attached to main") });
  await assert.rejects(
    () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
    /attached to main/u,
  );
  assert.deepEqual(calls.map(([name]) => name), ["plan", "inspect-main", "verify-upstream-adoption", "guard-primary"]);
});

test("Await rebuild rejects a stale plan before publishing its candidate", async () => {
  const { projectRoot, service } = fixture();
  let reads = 0;
  service.releasePlanner.plan = async () => ({
    revision: reads++ === 0 ? "plan-1" : "plan-2",
    ready: [{ taskId: "task-1", taskRevision: 7, projectRoot, resultCommit: "task-result" }],
    blocked: [],
    conflicts: [],
  });
  service.releaseGitWorkspaces.prepareCandidate = async (request) => {
    await request.validateBeforeCommit();
    return { preReleaseHead: "must-not-publish" };
  };

  await assert.rejects(
    () => service.prepareAwaitSet({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
    /revision changed during PreRelease rebuild/u,
  );
});

test("release preflight holds the Await lock and rejects a stale plan before publishing its candidate", async () => {
  const { locks, projectRoot, service } = fixture();
  let reads = 0;
  service.releasePlanner.plan = async () => ({
    revision: reads++ === 0 ? "plan-1" : "plan-2",
    ready: [{ taskId: "task-1", taskRevision: 7, projectRoot, resultCommit: "task-result" }],
    blocked: [],
    conflicts: [],
  });
  service.releaseGitWorkspaces.prepareCandidate = async (request) => {
    await request.validateBeforeCommit();
    return { preReleaseHead: "must-not-publish" };
  };

  await assert.rejects(
    () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" }),
    /revision changed during release candidate preparation/u,
  );
  assert.deepEqual(locks, ["workspace-1"]);
});

test("release preflight reconciliation reads exact frozen checkpoint without replay", async () => {
  const { projectRoot, service } = fixture();
  service.releaseGitWorkspaces.frozenCandidate = async (requestedProjectRoot) => ({
    repositoryRoot: requestedProjectRoot,
    releaseRoot: path.resolve("D:/release-clone"),
    checkpointFile: path.resolve("D:/release-clone/checkpoint.json"),
    checkpointPhase: "prepared",
    planRevision: "plan-1",
    manifestHash: "manifest-hash",
    manifest: {
      manifestHash: "manifest-hash",
      workspaceId: "workspace-1",
      planRevision: "plan-1",
      baseCommit: "main-head",
      taskIds: ["task-1"],
      tasks: [{ taskId: "task-1", taskRevision: 7, resultCommit: "task-result" }],
    },
    preflightRequestId: "architect-bwm12-release-preflight-20260912-v1",
    baseCommit: "main-head",
    preReleaseHead: "prerelease-head",
  });

  const result = await service.reconcilePreflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    expectedRepositories: [{ projectRoot, revision: "prerelease-head" }],
    originalRequestId: "architect-bwm12-release-preflight-20260912-v1",
    errorClass: "serialization_error",
    originalReceipt: originalReceipt(),
  });

  assert.equal(result.status, "candidate_snapshot_only");
  assert.equal(result.originalOutcome, "unknown");
  assert.equal(result.reason, "prepared checkpoint is not final preflight outcome evidence");
  assert.equal(result.replayed, false);
  assert.equal(result.releaseCandidates[0].preReleaseHead, "prerelease-head");

  await assert.rejects(
    () => service.reconcilePreflight({
      workspaceId: "workspace-1",
      expectedPlanRevision: "plan-1",
      expectedRepositories: [{ projectRoot, revision: "stale-head" }],
      originalRequestId: "architect-bwm12-release-preflight-20260912-v1",
      originalReceipt: originalReceipt(),
    }),
    /stale/u,
  );
});

test("release preflight reconciliation rejects missing or foreign original MCP receipts", async () => {
  const { projectRoot, service } = fixture();
  service.releaseGitWorkspaces.frozenCandidate = async () => ({
    checkpointPhase: "prepared",
    planRevision: "plan-1",
    manifestHash: "manifest-hash",
    manifest: {
      manifestHash: "manifest-hash",
      workspaceId: "workspace-1",
      planRevision: "plan-1",
      baseCommit: "main-head",
      tasks: [{ taskId: "task-1", taskRevision: 7, resultCommit: "task-result" }],
    },
    preflightRequestId: "architect-bwm12-release-preflight-20260912-v1",
    baseCommit: "main-head",
    preReleaseHead: "prerelease-head",
  });
  const request = {
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    expectedRepositories: [{ projectRoot, revision: "prerelease-head" }],
    originalRequestId: "architect-bwm12-release-preflight-20260912-v1",
  };

  await assert.rejects(() => service.reconcilePreflight(request), /receipt was not found/u);
  await assert.rejects(
    () => service.reconcilePreflight({ ...request, originalReceipt: originalReceipt({ toolName: "hub_task_claim" }) }),
    /not a release preflight/u,
  );
  await assert.rejects(
    () => service.reconcilePreflight({ ...request, originalReceipt: originalReceipt({ workspaceId: "workspace-2" }) }),
    /another Workspace/u,
  );
  await assert.rejects(
    () => service.reconcilePreflight({ ...request, originalReceipt: originalReceipt({ expectedArgumentsHash: "other" }) }),
    /arguments do not match/u,
  );
});

test("release preflight reconciliation keeps old unbound checkpoints as snapshot-only", async () => {
  const { projectRoot, service } = fixture();
  service.releaseGitWorkspaces.frozenCandidate = async () => ({
    checkpointPhase: "prepared",
    planRevision: "plan-1",
    manifestHash: "manifest-hash",
    manifest: {
      manifestHash: "manifest-hash",
      workspaceId: "workspace-1",
      planRevision: "plan-1",
      baseCommit: "main-head",
      tasks: [{ taskId: "task-1", taskRevision: 7, resultCommit: "task-result" }],
    },
    preflightRequestId: "",
    baseCommit: "main-head",
    preReleaseHead: "prerelease-head",
  });

  const result = await service.reconcilePreflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    expectedRepositories: [{ projectRoot, revision: "prerelease-head" }],
    originalRequestId: "architect-bwm12-release-preflight-20260912-v1",
    originalReceipt: originalReceipt(),
  });

  assert.equal(result.status, "candidate_snapshot_only");
  assert.equal(result.originalOutcome, "unknown");
  assert.equal(result.replayed, false);
});

test("release preflight reconciliation rejects stale manifest Task evidence", async () => {
  const { projectRoot, service } = fixture();
  service.releaseGitWorkspaces.frozenCandidate = async () => ({
    checkpointPhase: "prepared",
    planRevision: "plan-1",
    manifestHash: "manifest-hash",
    manifest: {
      manifestHash: "manifest-hash",
      workspaceId: "workspace-1",
      planRevision: "plan-1",
      baseCommit: "main-head",
      tasks: [{ taskId: "task-1", taskRevision: 6, resultCommit: "task-result" }],
    },
    preflightRequestId: "architect-bwm12-release-preflight-20260912-v1",
    baseCommit: "main-head",
    preReleaseHead: "prerelease-head",
  });

  await assert.rejects(() => service.reconcilePreflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    expectedRepositories: [{ projectRoot, revision: "prerelease-head" }],
    originalRequestId: "architect-bwm12-release-preflight-20260912-v1",
    originalReceipt: originalReceipt(),
  }), /Task evidence is stale/u);
});

test("release preflight reconciliation rejects plan movement during readback", async () => {
  const { projectRoot, service } = fixture();
  let reads = 0;
  service.releasePlanner.plan = async () => ({
    revision: reads++ === 0 ? "plan-1" : "plan-2",
    ready: [{ taskId: "task-1", taskRevision: 7, projectRoot, resultCommit: "task-result" }],
    blocked: [],
    conflicts: [],
  });
  service.releaseGitWorkspaces.frozenCandidate = async () => ({
    checkpointPhase: "prepared",
    planRevision: "plan-1",
    manifestHash: "manifest-hash",
    manifest: {
      manifestHash: "manifest-hash",
      workspaceId: "workspace-1",
      planRevision: "plan-1",
      baseCommit: "main-head",
      tasks: [{ taskId: "task-1", taskRevision: 7, resultCommit: "task-result" }],
    },
    preflightRequestId: "architect-bwm12-release-preflight-20260912-v1",
    baseCommit: "main-head",
    preReleaseHead: "prerelease-head",
  });

  await assert.rejects(() => service.reconcilePreflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    expectedRepositories: [{ projectRoot, revision: "prerelease-head" }],
    originalRequestId: "architect-bwm12-release-preflight-20260912-v1",
    originalReceipt: originalReceipt(),
  }), /plan revision changed during preflight readback/u);
});
