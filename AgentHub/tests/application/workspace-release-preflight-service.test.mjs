import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";
import { normalizedTaskSquashTransfer } from "../../src/domain/task-squash-transfer.mjs";
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

async function treeEntry(cwd, treeish, file) {
  const value = await git(cwd, "ls-tree", treeish, "--", file);
  if (!value) return null;
  const match = /^(\d{6}) blob ([0-9a-f]{40})\t/u.exec(value);
  assert.ok(match, `expected blob entry for ${treeish}:${file}`);
  return { mode: match[1], object: match[2] };
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
    requestId: "releaseManager-bwm12-release-preflight-20260912-v1",
    workspaceId: "workspace-1",
    streamId: "releaseManager",
    provider: "codex",
    threadId: "thread-release-manager",
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
      releaseBaseEvidence: async ({ publishedBaseCommit }) => ({ baseCommit: publishedBaseCommit }),
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
    resolveReleaseValidationSource: async (repositories) => {
      calls.push(["resolve-contour", repositories]);
      return { kind: "workspace-release-pipeline", ...repositories[0], sourceRoot: path.resolve("D:/dev-worktree/AgentHub") };
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
  service.releaseGitWorkspaces.frozenCandidate = async (root) => {
    calls.push(["read-candidate", root]);
    return {
      repositoryRoot: projectRoot, releaseRoot: path.resolve("D:/release-clone"),
      checkpointPhase: "prepared", planRevision, baseCommit: "main-head",
      preReleaseHead: "prerelease-head", tree: "candidate-tree", manifestHash: "manifest-hash",
      manifest: { workspaceId: "workspace-1", planRevision, baseCommit: "main-head", tasks: plan.ready },
    };
  };
  return { calls, locks, plan, projectRoot, service };
}

test("release preflight preserves the Test-owned squash result revision for integration evidence", async () => {
  const { plan, projectRoot, service } = fixture();
  plan.ready[0].resultReleaseRevision = 6;
  plan.ready[0].squashTransfer = { proofHash: "proof-1" };
  service.taskGitWorkspaces.releaseIntegrationEvidence = async ({ tasks }) => {
    assert.equal(tasks[0].taskRevision, 7);
    assert.equal(tasks[0].resultReleaseRevision, 6);
    assert.deepEqual(tasks[0].squashTransfer, { proofHash: "proof-1" });
    return { tasks };
  };
  service.releaseGitWorkspaces.prepareCandidate = () => assert.fail("Await acceptance must not build PreRelease");

  const result = await service.validateAwaitAcceptance({
    workspaceId: "workspace-1",
    acceptingTask: { id: "task-1", revision: 6 },
    projectRoot,
  });
  assert.equal(result.planRevision, "plan-1");
  assert.equal(result.task.resultReleaseRevision, 6);
});

test("release preflight reuses prepared PreRelease without dev preparation or contour refresh", async () => {
  const { calls, locks, service } = fixture();
  const result = await service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" });
  assert.deepEqual(calls.map(([name]) => name), [
    "plan", "inspect-main", "verify-upstream-adoption", "guard-primary", "read-candidate",
    "resolve-contour", "guard-primary", "read-candidate", "plan",
  ]);
  assert.deepEqual(locks, ["workspace-1"]);
  assert.equal(result.planRevision, "plan-1");
  assert.equal(result.testContour, undefined);
  assert.equal(result.repositories[0].headCommit, "prerelease-head");
  assert.equal(result.releaseCandidates[0].manifestHash, "manifest-hash");
  assert.equal(result.releaseCandidates[0].reused, true);
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

test("release preflight reads a repository baseline appended from a local publisher receipt", async () => {
  const { calls, projectRoot, service } = fixture();
  service.readPublicationState = async () => ({
    revision: "legacy-unscoped-head",
    repositories: [{
      root: projectRoot,
      revision: "published-head",
      adoptedFrom: "local-publisher-receipt",
      publisher: { kind: "agent-hub-publication-receipt", runId: "publisher-run-1" },
    }],
  });

  const result = await service.preflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
  });

  assert.equal(result.status, "ready");
  assert.equal(calls.find(([name]) => name === "inspect-main")[1].publishedRevision, "published-head");
});

test("release preflight binds approved main commits to the selected repository", async () => {
  const { calls, projectRoot, service } = fixture();
  service.releaseGitWorkspaces.assertPrimaryInvariant = async () => ({ projectRoot, headCommit: "local-main" });
  const readCandidate = service.releaseGitWorkspaces.frozenCandidate;
  service.releaseGitWorkspaces.frozenCandidate = async (root) => {
    const candidate = await readCandidate(root);
    return { ...candidate, baseCommit: "origin-main", manifest: { ...candidate.manifest, baseCommit: "origin-main" } };
  };
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
      assertPrimaryInvariant: async (projectRoot) => ({ projectRoot, branch: "refs/heads/main", headCommit: `local-${path.basename(projectRoot)}` }),
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
    resolveReleaseValidationSource: async () => ({
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
    resolveReleaseValidationSource: async () => ({ kind: "external-validation-required", repositories: [{ projectRoot: repo }] }),
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

async function realExternalValidationFixture(t, { afterValidation = null, squash = false } = {}) {
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
  let sourceResult = null;
  if (squash) {
    const sourceRoot = path.join(root, "source");
    await git(primary, "worktree", "add", "-b", "HUB-real-source", sourceRoot, "main");
    t.after(() => git(primary, "worktree", "remove", "--force", sourceRoot).catch(() => {}));
    await writeFile(path.join(sourceRoot, "source.txt"), "source\n", "utf8");
    sourceResult = await commit(sourceRoot, "source result");
  }
  const taskRoot = path.join(root, "task");
  await git(primary, "worktree", "add", "-b", "HUB-real-adapter", taskRoot, "main");
  t.after(() => git(primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  await writeFile(path.join(taskRoot, "app.txt"), "candidate\n", "utf8");
  if (squash) await writeFile(path.join(taskRoot, "source.txt"), "source\n", "utf8");
  const resultCommit = await commit(taskRoot, "task result");
  let integration = null;
  let squashTransfer = null;
  if (squash) {
    const devRoot = path.join(root, "dev");
    await git(primary, "worktree", "add", "-b", "dev-fixture", devRoot, "main");
    t.after(() => git(primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
    await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "merge", "--no-ff", "--no-edit", resultCommit);
    const integrationCommit = await git(devRoot, "rev-parse", "HEAD");
    const devAfterTree = await git(devRoot, "rev-parse", "HEAD^{tree}");
    integration = { commit: integrationCommit, parent: base, order: 1 };
    const appBaseline = await treeEntry(primary, base, "app.txt");
    const appResult = await treeEntry(primary, resultCommit, "app.txt");
    const sourceEntry = await treeEntry(primary, sourceResult, "source.txt");
    const survivorSourceEntry = await treeEntry(primary, resultCommit, "source.txt");
    squashTransfer = normalizedTaskSquashTransfer({
      version: 1,
      kind: "task-squash-transfer-v1",
      survivor: {
        taskId: "task-real", revision: 5, releaseRevision: 4,
        resultCommit, baseCommit: base, branch: "HUB-real-adapter",
      },
      source: {
        taskId: "task-source", revision: 3, releaseRevision: 3,
        resultCommit: sourceResult, baseCommit: base, branch: "HUB-real-source",
      },
      projectRoot: primary,
      previousResultCommit: base,
      baselineResultCommit: base,
      devBeforeCommit: base,
      devAfterTree,
      sourceWitnesses: [{
        path: "source.txt", source: sourceEntry, survivor: survivorSourceEntry,
        disposition: "preserved",
      }],
      ownerWitnesses: [{
        path: "app.txt", baseline: appBaseline, beforeDev: appBaseline,
        newResult: appResult, afterDev: appResult, disposition: "applied",
      }, {
        path: "source.txt", baseline: null, beforeDev: null,
        newResult: survivorSourceEntry, afterDev: survivorSourceEntry, disposition: "applied",
      }],
      authority: {
        workspaceId: "workspace-1", streamId: "release", provider: "codex",
        threadId: "thread", proofRequestId: "real-preflight-squash-proof",
      },
      integrationCommit,
    });
  }
  const releaseGitWorkspaces = new ReleaseGitWorkspaceService({ dataDir });
  let validationCalls = 0;
  let integrationEvidence = null;
  const plan = {
    revision: "plan-real-adapter",
    ready: [{
      taskId: "task-real", taskRevision: squash ? 6 : 2, projectRoot: primary, resultCommit,
      ...(squash ? { resultReleaseRevision: 5, squashTransfer } : {}),
    }],
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
      releaseIntegrationEvidence: async ({ projectRoot, tasks }) => {
        integrationEvidence = {
          repositoryRoot: projectRoot,
          projectRoot,
          branch: "dev",
          headCommit: resultCommit,
          tasks: tasks.map((task) => ({
            ...task,
            baseCommit: base,
            integrations: integration ? [integration] : [],
          })),
        };
        return integrationEvidence;
      },
      releaseBaseEvidence: async ({ publishedBaseCommit }) => ({ baseCommit: publishedBaseCommit }),
    },
    releaseGitWorkspaces,
    readPublicationState: async () => ({ repositories: [{ root: primary, revision: base }] }),
    resolveReleaseValidationSource: async () => ({ kind: "external-validation-required", reason: "fixture external QA" }),
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
  await service.prepareAwaitSet({ workspaceId: "workspace-1" });
  return {
    root, primary, dataDir, base, resultCommit, squashTransfer,
    integrationEvidence, releaseGitWorkspaces, service,
  };
}

test("release preflight reuses real prepared candidate readback with the repository validation adapter", async (t) => {
  const { primary, service, releaseGitWorkspaces } = await realExternalValidationFixture(t);
  const before = await releaseGitWorkspaces.frozenCandidate(primary);
  const checkpointBefore = await readFile(before.checkpointFile);
  service.releaseGitWorkspaces.prepareCandidate = () => assert.fail("preflight must not rebuild the prepared candidate");

  const result = await service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-real-adapter" });

  assert.equal(result.status, "ready");
  assert.equal(result.productionValidation.repositories[0].candidateCommit, result.releaseCandidates[0].preReleaseHead);
  assert.equal(result.productionValidation.evidence[0].manifestHash, result.releaseCandidates[0].manifestHash);
  assert.equal(typeof result.productionValidation.evidence[0].evidenceHash, "string");
  assert.equal(await git(primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(primary, "status", "--porcelain=v1"), "");
  assert.deepEqual(await releaseGitWorkspaces.frozenCandidate(primary), before);
  assert.deepEqual(await readFile(before.checkpointFile), checkpointBefore);
});

test("real plan through prepare and preflight preserves exact squash result release identity", async (t) => {
  const {
    primary, service, releaseGitWorkspaces, squashTransfer, integrationEvidence,
  } = await realExternalValidationFixture(t, {
    squash: true,
  });
  assert.equal(integrationEvidence.tasks[0].resultReleaseRevision, 5);
  assert.deepEqual(integrationEvidence.tasks[0].squashTransfer, squashTransfer);
  const candidate = await releaseGitWorkspaces.frozenCandidate(primary);
  const serializedManifest = JSON.parse(await readFile(candidate.manifestFile, "utf8"));
  assert.equal(serializedManifest.tasks[0].resultReleaseRevision, 5);
  assert.deepEqual(serializedManifest.tasks[0].squashTransfer, squashTransfer);
  assert.equal(candidate.manifest.tasks[0].resultReleaseRevision, 5);
  assert.deepEqual(candidate.manifest.tasks[0].squashTransfer, squashTransfer);

  const result = await service.preflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-real-adapter",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.productionValidation.repositories[0].frozenTasks[0].resultReleaseRevision, 5);
  assert.deepEqual(result.productionValidation.repositories[0].frozenTasks[0].squashTransfer,
    squashTransfer);

  const readCandidate = service.releaseGitWorkspaces.frozenCandidate.bind(service.releaseGitWorkspaces);
  for (const mutate of [
    (task) => { delete task.resultReleaseRevision; },
    (task) => { task.resultReleaseRevision += 1; },
    (task) => { delete task.squashTransfer; },
  ]) {
    service.releaseGitWorkspaces.frozenCandidate = async (projectRoot) => {
      const current = structuredClone(await readCandidate(projectRoot));
      mutate(current.manifest.tasks[0]);
      return current;
    };
    await assert.rejects(
      () => service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-real-adapter" }),
      /prepared PreRelease does not match the accepted release plan/u,
    );
  }
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
    resolveReleaseValidationSource: async (prepared) => ({ kind: "workspace-release-pipeline", ...prepared[0], sourceRoot: path.join(prepared[0].worktreeRoot, "AgentHub") }),
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
  assert.equal(result.testContour, undefined);
  assert.equal(result.productionValidation.repositories[0].projectRoot, repoAndroid);
});

test("unrelated dev or contour state does not gate the prepared release", async () => {
  const { calls, service } = fixture({ contourHead: "stale-head", rejectDev: new Error("unrelated dev work") });
  service.taskGitWorkspaces.prepareDev = () => assert.fail("must not prepare dev");
  service.refreshTestContour = () => assert.fail("must not refresh contour");
  assert.equal((await service.preflight({ workspaceId: "workspace-1", expectedPlanRevision: "plan-1" })).status, "ready");
  assert.equal(calls.some(([name]) => name === "verify-dev" || name === "release-integrations"), false);
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

test("Await refuses missing publication authority and changed base before committing acceptance", async () => {
  const { service } = fixture();
  const publication = service.readPublicationState;
  let committed = false;
  service.releaseGitWorkspaces.prepareCandidate = async (request) => {
    service.readPublicationState = async () => ({ repositories: [{ root: request.projectRoot, revision: "new-publication" }] });
    await request.validateBeforeCommit();
    committed = true;
  };
  service.readPublicationState = async () => null;
  await assert.rejects(service.prepareAwaitSet({ workspaceId: "workspace-1" }), /repository-scoped publication evidence/u);
  service.readPublicationState = publication;
  await assert.rejects(service.prepareAwaitSet({ workspaceId: "workspace-1" }), /accepted release base changed/u);
  assert.equal(committed, false);
});

test("automatic Await preparation composes accepted code without running release preflight", async () => {
  const { calls, service } = fixture();
  const result = await service.prepareAwaitSet({ workspaceId: "workspace-1", preserveFrozen: true });
  assert.equal(result.releaseCandidates[0].preReleaseHead, "prerelease-head");
  assert.deepEqual(calls.map(([name]) => name), [
    "plan", "guard-primary", "release-integrations", "prepare-candidate", "plan",
  ]);
  assert.equal(calls.find(([name]) => name === "prepare-candidate")[1].preserveFrozen, true);
  assert.equal(calls.find(([name]) => name === "prepare-candidate")[1].approvedBaseCommit, "published-head");
});

test("prospective composition validation does not promote candidates or commit acceptance", async () => {
  const { service, projectRoot } = fixture();
  const before = { revision: "before", blocked: [], conflicts: [], ready: [] };
  const after = { ...before, revision: "prospective", ready: [
    { taskId: "task-1", taskRevision: 8, projectRoot, resultCommit: "result" },
  ] };
  const projection = { id: "task-1", revision: 7 };
  service.releasePlanner.plan = async (_id, options) => {
    if (options?.acceptingTask) {
      assert.deepEqual(options.acceptingTask, projection);
      return after;
    }
    return before;
  };
  service.releaseGitWorkspaces.prepareCandidate = () => assert.fail("must not promote PreRelease");
  const lease = { async assertOwned() {} };
  service.taskGitWorkspaces.releaseIntegrationEvidence = async (options) => {
    assert.equal(options.lease, lease);
    return { tasks: options.tasks };
  };
  let validations = 0;
  service.releaseGitWorkspaces.validateCandidate = async (options) => {
    validations += 1;
    assert.equal(options.planRevision, "prospective");
    assert.equal(options.approvedBaseCommit, "published-head");
    assert.equal(options.commitPrepared, undefined);
    await options.validateBeforeCommit();
    return { status: "validated", tree: "selected-tree", baseCommit: options.approvedBaseCommit };
  };
  const result = await service.prepareAwaitSet({ workspaceId: "workspace-1",
    acceptingTask: projection, validateOnly: true, lease });
  assert.equal(validations, 1);
  assert.equal(result.planRevision, "prospective");
  assert.deepEqual(result.taskIds, ["task-1"]);
  assert.equal(result.releaseCandidates[0].tree, "selected-tree");
  await assert.rejects(service.prepareAwaitSet({ workspaceId: "workspace-1", validateOnly: true,
    commitPrepared: () => assert.fail("must not commit") }), /cannot commit/);
});

for (const changed of ["plan", "base"]) test(`composition validation rejects ${changed} drift without acceptance`, async () => {
  const { service } = fixture();
  service.releaseGitWorkspaces.prepareCandidate = () => assert.fail("must not promote PreRelease");
  service.releaseGitWorkspaces.validateCandidate = async (options) => {
    if (changed === "plan") service.releasePlanner.plan = async () => ({ revision: "different" });
    else service.readPublicationState = async () => ({ repositories: [{ root: options.projectRoot, revision: "changed" }] });
    await options.validateBeforeCommit();
    assert.fail("drift must fail");
  };
  await assert.rejects(service.prepareAwaitSet({ workspaceId: "workspace-1", validateOnly: true }), /changed/);
});

for (const refusal of [null, "second-repository", "status-cas"]) {
  test(`prospective Await holds all candidate boundaries until status CAS (${refusal ?? "success"})`, async () => {
    const { service, projectRoot } = fixture();
    const roots = [projectRoot, path.resolve("D:/second-repository")];
    service.readPublicationState = async () => ({ repositories: roots.map((root) => ({ root, revision: "published" })) });
    const plan = {
      revision: "after-acceptance", blocked: [], conflicts: [],
      ready: roots.map((root, i) => ({ taskId: `task-${i + 1}`, taskRevision: 8,
        projectRoot: root, resultCommit: "a".repeat(40) })),
    };
    service.releasePlanner.plan = async (_workspaceId, options) => options?.acceptingTask
      ? plan : { ...plan, revision: "before-acceptance" };
    service.taskGitWorkspaces.releaseIntegrationEvidence = async ({ tasks }) => ({ tasks });
    const heads = new Map(roots.map((root) => [root, "old"]));
    const active = new Set();
    let commits = 0;
    service.releaseGitWorkspaces.prepareCandidate = async ({ projectRoot: root, commitPrepared, validateBeforeCommit }) => {
      const prior = heads.get(root);
      active.add(root);
      try {
        if (root === roots[1] && refusal === "second-repository") throw new Error("second repository conflict");
        await validateBeforeCommit();
        heads.set(root, "new");
        const prepared = { repositoryRoot: root, preReleaseHead: "new" };
        await commitPrepared(prepared);
        return prepared;
      } catch (error) {
        heads.set(root, prior);
        throw error;
      } finally { active.delete(root); }
    };
    const operation = service.prepareAwaitSet({
      workspaceId: "workspace-1", acceptingTask: { id: "task-2", revision: 7 }, preserveFrozen: true,
      commitPrepared: async (prepared) => {
        assert.equal(active.size, 2);
        assert.equal(prepared.releaseCandidates.length, 2);
        assert.deepEqual([...heads.values()], ["new", "new"]);
        if (refusal === "status-cas") throw new Error("status CAS rejected");
        commits += 1;
      },
    });
    if (refusal) await assert.rejects(operation, /conflict|CAS rejected/u);
    else assert.equal((await operation).planRevision, "after-acceptance");
    assert.equal(commits, refusal ? 0 : 1);
    assert.deepEqual([...heads.values()], refusal ? ["old", "old"] : ["new", "new"]);
    assert.equal(active.size, 0);
  });
}

test("removing the last Await Task prepares an empty candidate for its repository", async () => {
  const { calls, projectRoot, service } = fixture();
  service.releasePlanner.plan = async () => ({ revision: "empty-plan", ready: [], blocked: [], conflicts: [] });
  service.taskGitWorkspaces.releaseIntegrationEvidence = async (request) => {
    assert.deepEqual(request.tasks, []);
    return { tasks: [] };
  };
  const result = await service.prepareAwaitSet({
    workspaceId: "workspace-1", fallbackProjectRoots: [projectRoot], preserveFrozen: true,
  });
  assert.deepEqual(result.taskIds, []);
  assert.deepEqual(calls.find(([name]) => name === "prepare-candidate")[1].frozenTasks, []);
  assert.equal(result.releaseCandidates.length, 1);
});

test("a selected project subdirectory does not overwrite the accepted repository with an empty candidate", async () => {
  const { calls, projectRoot, service } = fixture();
  service.releaseGitWorkspaces.assertPrimaryInvariant = async () => ({ projectRoot });
  const result = await service.prepareAwaitSet({
    workspaceId: "workspace-1", fallbackProjectRoots: [path.join(projectRoot, "AgentHub")], preserveFrozen: true,
  });
  assert.equal(result.releaseCandidates.length, 1);
  const candidates = calls.filter(([name]) => name === "prepare-candidate");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0][1].frozenTasks[0].taskId, "task-1");
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

test("release preflight holds the Await lock and rejects a plan changed during readback", async () => {
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
    /revision changed during release preflight/u,
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
    preflightRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
    baseCommit: "main-head",
    preReleaseHead: "prerelease-head",
  });

  const result = await service.reconcilePreflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    expectedRepositories: [{ projectRoot, revision: "prerelease-head" }],
    originalRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
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
      originalRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
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
    preflightRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
    baseCommit: "main-head",
    preReleaseHead: "prerelease-head",
  });
  const request = {
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    expectedRepositories: [{ projectRoot, revision: "prerelease-head" }],
    originalRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
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
    originalRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
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
    preflightRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
    baseCommit: "main-head",
    preReleaseHead: "prerelease-head",
  });

  await assert.rejects(() => service.reconcilePreflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    expectedRepositories: [{ projectRoot, revision: "prerelease-head" }],
    originalRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
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
    preflightRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
    baseCommit: "main-head",
    preReleaseHead: "prerelease-head",
  });

  await assert.rejects(() => service.reconcilePreflight({
    workspaceId: "workspace-1",
    expectedPlanRevision: "plan-1",
    expectedRepositories: [{ projectRoot, revision: "prerelease-head" }],
    originalRequestId: "releaseManager-bwm12-release-preflight-20260912-v1",
    originalReceipt: originalReceipt(),
  }), /plan revision changed during preflight readback/u);
});
