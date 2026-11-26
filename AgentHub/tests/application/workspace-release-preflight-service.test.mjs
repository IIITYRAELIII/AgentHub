import assert from "node:assert/strict";

import { execFile } from "node:child_process";


import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { TaskIntegrationService } from "../../src/application/task-integration-service.mjs";
















const execFileAsync = promisify(execFile);





for (const localSource of [false, true])





















test("PUBLIC ordinary Await without a private carry keeps agreed main separate from published composition", async () => {
  const f = fixture({ publishedRevision: "f".repeat(40) });
  const agreedMain = "a".repeat(40), published = "f".repeat(40);
  f.service.taskGitWorkspaces.releaseBaseEvidence = async () => ({ baseCommit: agreedMain, publishedBaseCommit: published });
  f.service.releaseGitWorkspaces.prepareCandidate = async request => {
    assert.equal(request.approvedBaseCommit, published);
    assert.equal(request.baseProvenance.agreedMainCommit, agreedMain);
    assert.equal(request.baseProvenance.compositionBaseCommit, published);
    await request.validateBeforeCommit();
    await request.commitPrepared({ repositoryRoot: request.projectRoot, frozenTasks: request.frozenTasks,
      planRevision: f.plan.revision, baseCommit: published,
      manifest: { tasks: request.frozenTasks, baseProvenance: request.baseProvenance } });
  };
  assert.equal(await f.service.prepareAwaitAcceptance({ workspaceId: "workspace-1", acceptingTask: { id: "task-1" },
    projectRoot: f.projectRoot, operationId: "published-only-await", commitPrepared: async () => "accepted" }), "accepted");
});



async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

async function commit(cwd, message) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}







function fixture({
  planRevision = "plan-1", contourHead = "dev-head", rejectDev = null, rejectPrimary = null,
  publishedRevision = "published-head",
} = {}) {
  const calls = [];
  const locks = [];
  const projectRoot = path.resolve("D:/repo");
  const plan = {
    revision: planRevision,
    ready: [{ taskId: "task-1", taskRevision: 7, projectRoot, resultCommit: "task-result" }],
    blocked: [],
    conflicts: [],
  };
  const service = new TaskIntegrationService({
    releasePlanner: {
      async planAcceptance(workspaceId, { acceptingTask, checkBaseline, ...options }) {
        const baseline = await this.plan(workspaceId, options);
        checkBaseline?.(baseline);
        return { baseline, prospective: await this.plan(workspaceId, { ...options, acceptingTask }) };
      },
      plan: async (workspaceId) => {
        calls.push(["plan", workspaceId]);
        return plan;
      },
    },
    taskGitWorkspaces: {
      releaseBaseEvidence: async ({ publishedBaseCommit }) => ({ publishedBaseCommit, baseCommit: "main-head" }),
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
      deriveInstalledLocalSourceBaselineForSelection: async () => null,
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
          publishedRevision,
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
      repositories: [{ root: projectRoot, revision: publishedRevision }],
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

for (const approvedMain of [false, true])

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

test("explicit reviewed-main preparation requires pinned authority and rechecks it before promotion", async () => {
  const { projectRoot, service } = fixture();
  const approval = {
    approvedLocalMainCommit: "main-head",
    approvedOriginMainCommit: "main-head",
  };
  service.releaseGitWorkspaces.inspectMainChanges = async (request) => ({
    projectRoot,
    publishedRevision: request.publishedRevision,
    localMain: "main-head",
    originMain: "main-head",
    commits: [{ commit: "reviewed-change" }],
    changed: true,
    diverged: false,
    approved: request.approvedLocalMainCommit === "main-head"
      && request.approvedOriginMainCommit === "main-head",
    approvalRequired: request.approvedLocalMainCommit !== "main-head"
      || request.approvedOriginMainCommit !== "main-head",
  });
  let promoted = false;
  service.releaseGitWorkspaces.prepareCandidate = async (request) => {
    assert.equal(request.approvedBaseCommit, "main-head");
    assert.deepEqual(request.baseProvenance, {
      schemaVersion: 1,
      kind: "agreed-main-native-git-v1",
      publishedBaseCommit: "published-head",
      agreedMainCommit: "main-head",
      ...approval,
    });
    service.readPublicationState = async () => ({
      repositories: [{ root: projectRoot, revision: "changed-publication" }],
    });
    await request.validateBeforeCommit();
    promoted = true;
  };

  await assert.rejects(
    () => service.prepareReviewedAwaitSet({ workspaceId: "workspace-1", ...approval }),
    /published release base changed|accepted release base changed/u,
  );
  assert.equal(promoted, false);
});

test("explicit reviewed-main preparation rejects missing approval before candidate effects", async () => {
  const { projectRoot, service } = fixture();
  service.releaseGitWorkspaces.prepareCandidate = () => assert.fail("candidate effects must not start");
  const cases = [
    [{ workspaceId: "workspace-1" }, /missing approval/u],
    [{ workspaceId: "workspace-1", approvedLocalMainCommit: "main-head" }, /require both/u],
    [{
      workspaceId: "workspace-1",
      approvedRepositories: [
        { projectRoot, approvedLocalMainCommit: "main-head", approvedOriginMainCommit: "main-head" },
        { projectRoot, approvedLocalMainCommit: "main-head", approvedOriginMainCommit: "main-head" },
      ],
    }, /duplicated or ambiguous/u],
    [{
      workspaceId: "workspace-1",
      approvedRepositories: [{
        projectRoot: path.resolve("D:/unrelated"),
        approvedLocalMainCommit: "main-head",
        approvedOriginMainCommit: "main-head",
      }],
    }, /unrelated repository/u],
  ];
  for (const [request, expected] of cases) {
    await assert.rejects(() => service.prepareReviewedAwaitSet(request), expected);
  }
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
    service.releaseGitWorkspaces.prepareCandidate = async ({ projectRoot: root, frozenTasks, commitPrepared, validateBeforeCommit }) => {
      const prior = heads.get(root);
      active.add(root);
      try {
        if (root === roots[1] && refusal === "second-repository") throw new Error("second repository conflict");
        await validateBeforeCommit();
        heads.set(root, "new");
        const prepared = { repositoryRoot: root, preReleaseHead: "new", frozenTasks };
        await commitPrepared(prepared);
        return prepared;
      } catch (error) {
        heads.set(root, prior);
        throw error;
      } finally { active.delete(root); }
    };
    const operation = service.prepareAwaitAcceptance({
      workspaceId: "workspace-1", acceptingTask: { id: "task-2", revision: 7 },
      projectRoot: roots[1], operationId: "serial-multi-repository",
      commitPrepared: async (prepared) => {
        assert.equal(active.size, 2);
        assert.equal(prepared.releaseCandidates.length, 2);
        assert.deepEqual([...heads.values()], ["new", "new"]);
        if (refusal === "status-cas") throw new Error("status CAS rejected");
        commits += 1;
        return prepared;
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













test("ordinary native Await persists agreed main independently of historical adoption metadata", async () => {
  const PUBLISHED = "1".repeat(40);
  const ADOPTED = "2".repeat(40);
  const RESULT = "3".repeat(40);
  const { calls, projectRoot, service, plan } = fixture({ publishedRevision: PUBLISHED });
  plan.ready[0].resultCommit = RESULT;
  const integrationEvidence = service.taskGitWorkspaces.releaseIntegrationEvidence;
  service.taskGitWorkspaces.releaseIntegrationEvidence = async request => {
    const evidence = await integrationEvidence(request);
    return { ...evidence, tasks: evidence.tasks.map(item => ({ ...item, resultCommit: RESULT })) };
  };
  const adoption = {
    taskId: "task-1", resultCommit: RESULT,
    recordRef: `refs/agent-hub/upstream-adoptions/task-1/repo-key/${RESULT}/${ADOPTED}`,
    recordHash: "4".repeat(40), adoptedCommit: ADOPTED, acceptedLocalMainCommit: PUBLISHED,
  };
  service.taskGitWorkspaces.releaseBaseEvidence = async ({ publishedBaseCommit }) => ({
    publishedBaseCommit, baseCommit: ADOPTED, adoptions: [adoption],
  });
  let derivations = 0;
  service.releaseGitWorkspaces.deriveInstalledLocalSourceBaselineForSelection = async request => {
    assert.equal(request.projectRoot, projectRoot);
    assert.equal(request.planRevision, plan.revision);
    assert.equal(request.publishedRevision, PUBLISHED);
    assert.equal(request.tasks[0].resultCommit, RESULT);
    assert.deepEqual(request.adoptions, [adoption]);
    derivations++;
    return null; // This fixture has no installed local-source migration.
  };
  const envelope = {
    schemaVersion: 1, kind: "agreed-main-native-git-v1",
    publishedBaseCommit: PUBLISHED, agreedMainCommit: ADOPTED, compositionBaseCommit: PUBLISHED,
  };
  await service.prepareAwaitSet({ workspaceId: "workspace-1" });
  const prepared = calls.find(([name]) => name === "prepare-candidate")[1];
  assert.equal(prepared.approvedBaseCommit, PUBLISHED);
  assert.deepEqual(prepared.baseProvenance, envelope);

  let validated = null;
  service.releaseGitWorkspaces.validateCandidate = async (options) => {
    validated = options;
    return { status: "validated", tree: "tree", baseCommit: options.approvedBaseCommit };
  };
  await service.prepareAwaitSet({ workspaceId: "workspace-1", validateOnly: true });
  assert.equal(validated.approvedBaseCommit, PUBLISHED);
  assert.deepEqual(validated.baseProvenance, envelope);
  assert.equal(derivations, 2);

  // Equality with published main still keeps explicit native provenance.
  service.taskGitWorkspaces.releaseBaseEvidence = async ({ publishedBaseCommit }) => ({
    publishedBaseCommit, baseCommit: publishedBaseCommit, adoptions: [],
  });
  calls.length = 0;
  await service.prepareAwaitSet({ workspaceId: "workspace-1" });
  assert.deepEqual(calls.find(([name]) => name === "prepare-candidate")[1].baseProvenance,
    { schemaVersion: 1, kind: "agreed-main-native-git-v1", publishedBaseCommit: PUBLISHED,
      agreedMainCommit: PUBLISHED, compositionBaseCommit: PUBLISHED });
  assert.equal(derivations, 2);
  assert.equal(projectRoot, path.resolve("D:/repo"));
});
