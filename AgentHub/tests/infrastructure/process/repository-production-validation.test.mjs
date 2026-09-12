import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createRepositoryProductionValidationAdapter,
} from "../../../src/infrastructure/process/repository-production-validation.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

async function commit(cwd, message) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function gitFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-validation-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "release");
  await git(root, "init", "--initial-branch=main", repo);
  await writeFile(path.join(repo, "app.txt"), "base\n", "utf8");
  const base = await commit(repo, "base");
  await writeFile(path.join(repo, "app.txt"), "candidate\n", "utf8");
  const candidate = await commit(repo, "candidate");
  return {
    root,
    repo,
    base,
    candidate,
    tree: await git(repo, "rev-parse", `${candidate}^{tree}`),
    dataDir: path.join(root, "validation-data"),
  };
}

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

function gitRepository(setup, overrides = {}) {
  return repository({
    projectRoot: setup.repo,
    headCommit: "dev-head",
    resultCommits: [setup.candidate],
    frozenTasks: [{ taskId: "task-1", taskRevision: 14, resultCommit: setup.candidate }],
    frozenCandidate: {
      repositoryRoot: setup.repo,
      releaseRoot: setup.repo,
      planRevision: "plan-1",
      baseCommit: setup.base,
      preReleaseHead: setup.candidate,
      tree: setup.tree,
      manifestHash: "manifest-1",
      manifest: {
        workspaceId: "workspace-1",
        planRevision: "plan-1",
        tasks: [{ taskId: "task-1", taskRevision: 14, resultCommit: setup.candidate }],
      },
    },
    ...overrides,
  });
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

test("repository production validation default runner uses an isolated exact checkout and persists readback evidence", async (t) => {
  const setup = await gitFixture(t);
  const validate = createRepositoryProductionValidationAdapter({
    dataDir: setup.dataDir,
    policies: [policy({
      projectRoot: setup.repo,
      check: {
        kind: "fixture-qa",
        id: "exact-candidate",
        commands: [{ command: "git", args: ["rev-parse", "HEAD"] }],
        artifacts: ["app.txt"],
      },
    })],
  });

  const result = await validate({
    workspaceId: "workspace-1",
    planRevision: "plan-1",
    repositories: [gitRepository(setup)],
  });

  assert.equal(result.status, "ready");
  assert.equal(result.repositories[0].candidateCommit, setup.candidate);
  assert.equal(result.repositories[0].candidateTree, setup.tree);
  assert.equal(await git(setup.repo, "rev-parse", "HEAD"), setup.candidate);
  const evidence = JSON.parse(await readFile(result.evidence[0].evidenceFile, "utf8"));
  assert.equal(evidence.candidateCommit, setup.candidate);
  assert.equal(evidence.tree, setup.tree);
  assert.equal(evidence.artifacts[0].path, "app.txt");
  assert.equal(typeof result.evidence[0].evidenceHash, "string");
});

test("repository production validation default runner rejects moved HEAD and dirty tracked state without changing release clone", async (t) => {
  const setup = await gitFixture(t);
  const moved = createRepositoryProductionValidationAdapter({
    dataDir: setup.dataDir,
    policies: [policy({
      projectRoot: setup.repo,
      check: {
        kind: "fixture-qa",
        id: "moves-head",
        commands: [{ command: "git", args: ["checkout", "--detach", setup.base] }],
      },
    })],
  });
  await assert.rejects(
    () => moved({ workspaceId: "workspace-1", planRevision: "plan-1", repositories: [gitRepository(setup)] }),
    /moved the frozen candidate HEAD/u,
  );
  assert.equal(await git(setup.repo, "rev-parse", "HEAD"), setup.candidate);

  const dirty = createRepositoryProductionValidationAdapter({
    dataDir: setup.dataDir,
    policies: [policy({
      projectRoot: setup.repo,
      check: {
        kind: "fixture-qa",
        id: "dirty-state",
        commands: [{ command: "node", args: ["-e", "require('fs').writeFileSync('app.txt', 'dirty\\n')"] }],
      },
    })],
  });
  await assert.rejects(
    () => dirty({ workspaceId: "workspace-1", planRevision: "plan-1", repositories: [gitRepository(setup)] }),
    /left tracked candidate changes/u,
  );
  assert.equal(await git(setup.repo, "rev-parse", "HEAD"), setup.candidate);
});
