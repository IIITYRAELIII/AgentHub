import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createRepositoryProductionValidationAdapter,
} from "../../../src/infrastructure/process/repository-production-validation.mjs";

function repository(overrides = {}) {
  const projectRoot = path.resolve("D:/bookworm");
  return {
    projectRoot,
    headCommit: "dev-head",
    resultCommits: ["result-1"],
    taskIds: ["task-1"],
    frozenTasks: [{ taskId: "task-1", taskRevision: 14, resultCommit: "result-1" }],
    frozenCandidate: {
      repositoryRoot: projectRoot,
      releaseRoot: path.resolve("D:/release-bookworm"),
      planRevision: "plan-1",
      baseCommit: "base-1",
      preReleaseHead: "candidate-1",
      tree: "tree-1",
      manifestHash: "manifest-1",
      manifest: {
        workspaceId: "workspace-1",
        tasks: [{ taskId: "task-1", taskRevision: 14, resultCommit: "result-1" }],
      },
    },
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    enabled: true,
    projectRoot: path.resolve("D:/bookworm"),
    check: {
      kind: "bookworm-android-qa",
      id: "bookworm-frozen-candidate",
      commands: [{ command: ".\\gradlew.bat", args: ["qualityCheck", "--console=plain"] }],
      artifacts: ["app/build/outputs/androidTest-results/connected/debug/TEST.xml"],
    },
    ...overrides,
  };
}

test("repository production validation adapter binds runner evidence to exact frozen candidate", async () => {
  const calls = [];
  const validate = createRepositoryProductionValidationAdapter({
    policies: [policy()],
    runCheck: async (request) => {
      calls.push(request);
      return {
        status: "passed",
        candidateCommit: request.repository.frozenCandidate.preReleaseHead,
        tree: request.repository.frozenCandidate.tree,
        commands: [{ command: ".\\gradlew.bat", args: ["qualityCheck", "--console=plain"], exitCode: 0 }],
        artifacts: [{ path: "TEST.xml", sha256: "0".repeat(64), size: 100 }],
        buildInputs: { manifestHash: request.repository.frozenCandidate.manifestHash },
      };
    },
  });

  const result = await validate({
    workspaceId: "workspace-1",
    planRevision: "plan-1",
    source: { kind: "external-validation-required" },
    repositories: [repository()],
  });

  assert.equal(result.status, "ready");
  assert.equal(result.repositories[0].candidateCommit, "candidate-1");
  assert.equal(result.repositories[0].candidateTree, "tree-1");
  assert.deepEqual(result.repositories[0].frozenTasks, [{ taskId: "task-1", taskRevision: 14, resultCommit: "result-1" }]);
  assert.equal(result.evidence[0].candidateTree, "tree-1");
  assert.equal(result.evidence[0].checkKind, "bookworm-android-qa");
  assert.equal(calls[0].repository.frozenCandidate.preReleaseHead, "candidate-1");
});

test("repository production validation adapter fails closed when unconfigured", async () => {
  const validate = createRepositoryProductionValidationAdapter({ policies: [] });
  await assert.rejects(
    () => validate({ workspaceId: "workspace-1", planRevision: "plan-1", repositories: [repository()] }),
    /enable an explicit releaseValidation repository policy/u,
  );
});

test("repository production validation adapter rejects stale or foreign candidate evidence", async () => {
  const validate = createRepositoryProductionValidationAdapter({
    policies: [policy()],
    runCheck: async ({ repository: checked }) => ({
      status: "passed",
      candidateCommit: checked.frozenCandidate.preReleaseHead,
    }),
  });

  await assert.rejects(
    () => validate({
      workspaceId: "workspace-1",
      planRevision: "plan-1",
      repositories: [repository({ frozenCandidate: { ...repository().frozenCandidate, planRevision: "plan-old" } })],
    }),
    /candidate plan is stale/u,
  );
  await assert.rejects(
    () => validate({
      workspaceId: "workspace-1",
      planRevision: "plan-1",
      repositories: [repository({
        frozenCandidate: {
          ...repository().frozenCandidate,
          manifest: { workspaceId: "workspace-2", tasks: repository().frozenCandidate.manifest.tasks },
        },
      })],
    }),
    /another Workspace/u,
  );
  await assert.rejects(
    () => validate({
      workspaceId: "workspace-1",
      planRevision: "plan-1",
      repositories: [repository({
        frozenCandidate: {
          ...repository().frozenCandidate,
          manifest: { workspaceId: "workspace-1", tasks: [{ taskId: "task-1", taskRevision: 13, resultCommit: "other" }] },
        },
      })],
    }),
    /Task evidence is stale/u,
  );
  await assert.rejects(
    () => validate({
      workspaceId: "workspace-1",
      planRevision: "plan-1",
      repositories: [repository({
        frozenCandidate: {
          ...repository().frozenCandidate,
          manifest: { workspaceId: "workspace-1", tasks: [{ taskId: "task-1", taskRevision: 13, resultCommit: "result-1" }] },
        },
      })],
    }),
    /Task evidence is stale/u,
  );
});

test("repository production validation adapter rejects failed or stale runner results", async () => {
  const stale = createRepositoryProductionValidationAdapter({
    policies: [policy()],
    runCheck: async () => ({ status: "passed", candidateCommit: "candidate-old" }),
  });
  await assert.rejects(
    () => stale({ workspaceId: "workspace-1", planRevision: "plan-1", repositories: [repository()] }),
    /evidence is stale/u,
  );

  const failed = createRepositoryProductionValidationAdapter({
    policies: [policy()],
    runCheck: async () => ({ status: "failed", candidateCommit: "candidate-1" }),
  });
  await assert.rejects(
    () => failed({ workspaceId: "workspace-1", planRevision: "plan-1", repositories: [repository()] }),
    /validation failed/u,
  );

  const staleTree = createRepositoryProductionValidationAdapter({
    policies: [policy()],
    runCheck: async () => ({ status: "passed", candidateCommit: "candidate-1", tree: "tree-old" }),
  });
  await assert.rejects(
    () => staleTree({ workspaceId: "workspace-1", planRevision: "plan-1", repositories: [repository()] }),
    /tree evidence is stale/u,
  );
});
