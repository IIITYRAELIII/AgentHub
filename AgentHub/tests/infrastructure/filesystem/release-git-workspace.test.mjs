import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertReleaseCandidateContourSource,
  assertReleaseCloneForPublication,
  ReleaseGitWorkspaceService,
} from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { canonicalPath } from "../../../src/infrastructure/filesystem/config.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import {
  resolveTestContourSource,
  TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE,
} from "../../../src/runtime/test-contour-manager.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

async function commit(cwd, message) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-git-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  const dataDir = path.join(root, "data");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await git(primary, "config", "core.autocrlf", "false");
  // core.autocrlf наследуется из системной конфигурации Windows; нормализация
  // делает рабочее дерево клона релиза детерминированным на всех платформах.
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n", "utf8");
  await mkdir(path.join(primary, ".team"));
  await mkdir(path.join(primary, "1C_ACCESS"));
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, "app.txt"), "main\n", "utf8");
  await writeFile(path.join(primary, ".team", "participant.json"), "team-main\n", "utf8");
  await writeFile(path.join(primary, "1C_ACCESS", "access.json"), "access-main\n", "utf8");
  await writeFile(path.join(primary, "AgentHub", "package.json"), "{}\n", "utf8");
  const baseCommit = await commit(primary, "main");
  await git(primary, "push", "-u", "origin", "main");
  const canonicalRoot = canonicalPath(root);
  const canonicalOrigin = canonicalPath(origin);
  const canonicalPrimary = canonicalPath(primary);
  const canonicalDataDir = canonicalPath(dataDir);
  return {
    root: canonicalRoot,
    origin: canonicalOrigin,
    primary: canonicalPrimary,
    dataDir: canonicalDataDir,
    baseCommit,
    service: new ReleaseGitWorkspaceService({ dataDir: canonicalDataDir }),
  };
}

async function taskResult({ root, primary }, context, {
  branch = "HUB-126-fixture", file = "feature.txt", content = "feature\n",
} = {}) {
  const taskRoot = path.join(root, `task-${branch.replaceAll(/[^a-z0-9]+/giu, "-")}`);
  await git(primary, "worktree", "add", "-b", branch, taskRoot, "main");
  context.after(() => git(primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  await mkdir(path.dirname(path.join(taskRoot, file)), { recursive: true });
  await writeFile(path.join(taskRoot, file), content, "utf8");
  return commit(taskRoot, branch);
}

async function publishCandidate(candidate) {
  await git(candidate.releaseRoot, "checkout", "main");
  await git(candidate.releaseRoot, "merge", "--ff-only", candidate.preReleaseHead);
  await git(candidate.releaseRoot, "push", "origin", "main");
  return git(candidate.releaseRoot, "rev-parse", "HEAD");
}

for (const binaryOnly of [false, true]) test(`PreRelease preserves ${binaryOnly ? "terminal binary patch delimiters" : "binary patch bytes and a trailing blank context line"}`, { timeout: 20000 }, async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "z-final.txt"), "before\nunchanged\n\n", "utf8");
  await writeFile(path.join(setup.primary, "binary.bin"), Buffer.from([0, 255, 1, 2, 3]));
  await commit(setup.primary, "base with trailing blank line and binary");
  await git(setup.primary, "push", "origin", "main");
  const taskRoot = path.join(setup.root, "task-HUB-patch-bytes");
  await git(setup.primary, "worktree", "add", "-b", "HUB-patch-bytes", taskRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  if (!binaryOnly) await writeFile(path.join(taskRoot, "z-final.txt"), "after\nunchanged\n\n", "utf8");
  const binary = Buffer.from([0, 254, 128, 7, 9, 0]);
  await writeFile(path.join(taskRoot, "binary.bin"), binary);
  const resultCommit = await commit(taskRoot, "binary result");
  const request = { planRevision: "plan-raw-patch", projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-patch-bytes", taskRevision: 2, resultCommit }] };
  const candidate = await setup.service.prepareCandidate(request);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", `${candidate.preReleaseHead}^{tree}`),
    await git(taskRoot, "rev-parse", `${resultCommit}^{tree}`));
  const releasedText = await execFileAsync("git", ["show", `${candidate.preReleaseHead}:z-final.txt`], {
    cwd: candidate.releaseRoot, windowsHide: true,
  });
  assert.equal(releasedText.stdout, `${binaryOnly ? "before" : "after"}\nunchanged\n\n`);
  assert.deepEqual(await readFile(path.join(candidate.releaseRoot, "binary.bin")), binary);
  const retry = await setup.service.prepareCandidate(request);
  assert.equal(retry.reused, true);
  assert.equal(retry.preReleaseHead, candidate.preReleaseHead);
});

test("release candidate uses an independent clone and leaves a clean primary attached to main", async (context) => {
  const setup = await fixture(context);
  await taskResult(setup, context, { branch: "dev", file: "dev-only.txt", content: "must-not-release\n" });
  const resultCommit = await taskResult(setup, context);
  const before = {
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    head: await git(setup.primary, "rev-parse", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
  };

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-clean",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-clean", taskRevision: 3, resultCommit }],
  });

  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), before.branch);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), before.status);
  assert.equal(candidate.primaryPreserved, true);
  assert.equal(candidate.independentGitCommonDir, true);
  assert.notEqual(candidate.releaseGitCommonDir, candidate.primaryGitCommonDir);
  assert.equal(await git(candidate.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:feature.txt`), "feature");
  assert.equal(JSON.parse(await readFile(candidate.manifestFile, "utf8")).tasks[0].taskRevision, 3);
  await assert.rejects(git(candidate.releaseRoot, "cat-file", "-e", `${candidate.preReleaseHead}:dev-only.txt`));
  assert.equal((await assertReleaseCloneForPublication({ repositoryRoot: candidate.releaseRoot })).kind,
    "agent-hub-owned-release-clone");
  await assert.rejects(
    assertReleaseCloneForPublication({ repositoryRoot: setup.primary }),
    /requires an Agent Hub-owned independent release clone/u,
  );
});

test("main review discloses every commit since the last successful publication", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "AgentHub", "external.mjs"), "export const external = true;\n", "utf8");
  await git(setup.primary, "add", "AgentHub/external.mjs");
  await git(setup.primary,
    "-c", "user.name=External Author",
    "-c", "user.email=12345+external-user@users.noreply.github.com",
    "commit", "-m", "external runtime change");
  const externalCommit = await git(setup.primary, "rev-parse", "HEAD");
  await git(setup.primary, "push", "origin", "main");

  const pending = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
  });

  assert.equal(pending.localMain, externalCommit);
  assert.equal(pending.originMain, externalCommit);
  assert.equal(pending.approvalRequired, true);
  assert.equal(pending.commits.length, 1);
  assert.equal(pending.commits[0].commit, externalCommit);
  assert.equal(pending.commits[0].author.githubLogin, "external-user");
  assert.equal(pending.commits[0].committer.githubLogin, "external-user");
  assert.deepEqual(pending.commits[0].files, ["AgentHub/external.mjs"]);
  assert.deepEqual(pending.commits[0].impact, ["runtime"]);

  const approved = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
    approvedLocalMainCommit: externalCommit,
    approvedOriginMainCommit: externalCommit,
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.approvalRequired, false);
});

test("release candidate aggregates effective dev deltas instead of replaying conflicting Task snapshots", async (context) => {
  const setup = await fixture(context);
  const firstResult = await taskResult(setup, context, {
    branch: "HUB-effective-1", file: "app.txt", content: "first\n",
  });
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-effective-2", file: "app.txt", content: "second\n",
  });
  const devRoot = path.join(setup.root, "dev-effective");
  await git(setup.primary, "worktree", "add", "-b", "dev-effective", devRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", firstResult);
  const firstIntegration = await git(devRoot, "rev-parse", "HEAD");
  await assert.rejects(
    git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", secondResult),
  );
  await writeFile(path.join(devRoot, "app.txt"), "first + second\n", "utf8");
  await git(devRoot, "add", "app.txt");
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-edit");
  const secondIntegration = await git(devRoot, "rev-parse", "HEAD");

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-effective-deltas",
    projectRoot: setup.primary,
    frozenTasks: [{
      taskId: "task-effective-1",
      taskRevision: 4,
      resultCommit: firstResult,
      integrations: [{ commit: firstIntegration, parent: setup.baseCommit, order: 1 }],
    }, {
      taskId: "task-effective-2",
      taskRevision: 6,
      resultCommit: secondResult,
      integrations: [{ commit: secondIntegration, parent: firstIntegration, order: 2 }],
    }],
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:app.txt`), "first + second");
  assert.equal((await git(candidate.releaseRoot, "show", "-s", "--format=%P", candidate.preReleaseHead)).split(" ").length, 3);
});

test("release candidate three-way applies an Await delta over a later non-overlapping main change", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "app.txt"), "task-base\nstable\nmain-base\n", "utf8");
  const taskBase = await commit(setup.primary, "task base");
  await git(setup.primary, "push", "origin", "main");
  const taskRoot = path.join(setup.root, "task-three-way");
  const devRoot = path.join(setup.root, "dev-three-way");
  await git(setup.primary, "worktree", "add", "-b", "HUB-three-way", taskRoot, taskBase);
  await git(setup.primary, "worktree", "add", "-b", "dev-three-way", devRoot, taskBase);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  context.after(() => git(setup.primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
  await writeFile(path.join(taskRoot, "app.txt"), "task-change\nstable\nmain-base\n", "utf8");
  const resultCommit = await commit(taskRoot, "task change");
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", resultCommit);
  const integrationCommit = await git(devRoot, "rev-parse", "HEAD");
  await writeFile(path.join(setup.primary, "app.txt"), "task-base\nstable\nmain-change\n", "utf8");
  await commit(setup.primary, "main advances independently");
  await git(setup.primary, "push", "origin", "main");

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-three-way",
    projectRoot: setup.primary,
    frozenTasks: [{
      taskId: "task-three-way",
      taskRevision: 8,
      resultCommit,
      integrations: [{ commit: integrationCommit, parent: taskBase, order: 1 }],
    }],
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:app.txt`),
    "task-change\nstable\nmain-change");
});

test("failed PreRelease rebuild preserves the last good branch and checkpoint", async (context) => {
  const setup = await fixture(context);
  const firstResult = await taskResult(setup, context, {
    branch: "HUB-atomic-first", file: "app.txt", content: "first\n",
  });
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-atomic-second", file: "app.txt", content: "second\n",
  });
  const first = await setup.service.prepareCandidate({
    planRevision: "plan-atomic-first",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-first", taskRevision: 2, resultCommit: firstResult }],
  });
  const checkpointFile = path.join(setup.dataDir, "release-repositories", path.basename(path.dirname(first.releaseRoot)), "checkpoint.json");
  const checkpointBefore = JSON.parse(await readFile(checkpointFile, "utf8"));

  await assert.rejects(
    () => setup.service.prepareCandidate({
      planRevision: "plan-atomic-conflict",
      projectRoot: setup.primary,
      frozenTasks: [
        { taskId: "task-first", taskRevision: 2, resultCommit: firstResult },
        { taskId: "task-second", taskRevision: 3, resultCommit: secondResult },
      ],
    }),
    /PreRelease delta/u,
  );

  assert.equal(await git(first.releaseRoot, "rev-parse", "refs/heads/PreRelease"), first.preReleaseHead);
  assert.equal(await git(first.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(first.releaseRoot, "status", "--porcelain=v1"), "");
  assert.deepEqual(JSON.parse(await readFile(checkpointFile, "utf8")), checkpointBefore);
});

test("candidate validation failure cannot replace the last good PreRelease", async (context) => {
  const setup = await fixture(context);
  const firstResult = await taskResult(setup, context, { branch: "HUB-cas-first" });
  const first = await setup.service.prepareCandidate({
    planRevision: "plan-cas-first",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-first", taskRevision: 2, resultCommit: firstResult }],
  });
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-cas-second", file: "second.txt", content: "second\n",
  });

  await assert.rejects(
    () => setup.service.prepareCandidate({
      planRevision: "plan-cas-stale",
      projectRoot: setup.primary,
      frozenTasks: [{ taskId: "task-second", taskRevision: 4, resultCommit: secondResult }],
      validateBeforeCommit: async () => { throw new Error("release plan revision changed"); },
    }),
    /release plan revision changed/u,
  );

  assert.equal(await git(first.releaseRoot, "rev-parse", "refs/heads/PreRelease"), first.preReleaseHead);
  assert.equal(await git(first.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(first.releaseRoot, "status", "--porcelain=v1"), "");
});

test("release contour resolves the exact clean main from a real managed clone without a dev checkout", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context, {
    file: "AgentHub/release-only.mjs",
    content: "export const releaseOnly = true;\n",
  });
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-release-contour",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-release-contour", taskRevision: 2, resultCommit }],
  });
  const releaseHead = await publishCandidate(candidate);
  const sourceRoot = path.join(candidate.releaseRoot, "AgentHub");
  const contourRoot = path.join(setup.root, "release-contour");

  const asserted = await assertReleaseCandidateContourSource({ sourceRoot });
  const resolved = await resolveTestContourSource({
    root: contourRoot,
    sourceRoot,
    sourceKind: TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE,
    prepareSource: async () => assert.fail("release contour must not prepare a dev checkout"),
  });

  assert.equal(asserted.branch, "main");
  assert.equal(asserted.headCommit, releaseHead);
  assert.equal(resolved.kind, TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE);
  assert.equal(resolved.branch, "main");
  assert.equal(resolved.headCommit, releaseHead);
  assert.equal(path.resolve(resolved.sourceRoot), path.resolve(sourceRoot));
  await assert.rejects(stat(path.join(contourRoot, "task-git")), { code: "ENOENT" });
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), "");
});

test("release contour fails closed for dirty or non-main managed clone state", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-release-contour-guard",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-release-contour-guard", taskRevision: 2, resultCommit }],
  });
  const sourceRoot = path.join(candidate.releaseRoot, "AgentHub");
  await assert.rejects(
    assertReleaseCandidateContourSource({ sourceRoot }),
    /must be attached to main/u,
  );
  await publishCandidate(candidate);
  await writeFile(path.join(sourceRoot, "dirty.mjs"), "export {};\n", "utf8");
  await assert.rejects(
    assertReleaseCandidateContourSource({ sourceRoot }),
    /must be clean/u,
  );
});

test("an unmarked repository at the managed clone path is never adopted", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const releaseRoot = path.join(
    setup.dataDir,
    "release-repositories",
    taskRepositoryKey(setup.primary),
    "repository",
  );
  await mkdir(path.dirname(releaseRoot), { recursive: true });
  await git(path.dirname(releaseRoot), "clone", "--no-checkout", setup.primary, releaseRoot);

  await assert.rejects(
    setup.service.prepareCandidate({
      planRevision: "plan-unmarked",
      projectRoot: setup.primary,
      frozenTasks: [{ taskId: "task-unmarked", taskRevision: 2, resultCommit }],
    }),
    /unmarked release repository requires explicit migration/u,
  );
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), setup.baseCommit);
});

test("startup audits a detached registered primary and linked holder with an empty data directory", async (context) => {
  const setup = await fixture(context);
  const legacyRoot = path.join(setup.root, "legacy-prerelease-holder");
  await git(setup.primary, "worktree", "add", "-b", "PreRelease", legacyRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", legacyRoot).catch(() => {}));
  await git(setup.primary, "checkout", "--detach", setup.baseCommit);
  const beforeHead = await git(setup.primary, "rev-parse", "HEAD");
  const beforeStatus = await git(setup.primary, "status", "--porcelain=v1");

  const reconciliation = await setup.service.reconcile({
    projectRoots: [{
      workspaceId: "workspace-1",
      registrationSource: "runtime_default",
      projectRoot: setup.primary,
    }],
  });

  assert.equal(reconciliation.checked, 1);
  assert.equal(reconciliation.registeredWorkspaceRoots, 1);
  assert.equal(reconciliation.checkpointCount, 0);
  assert.equal(reconciliation.repositories[0].source, "registered_workspace");
  assert.equal(reconciliation.repositories[0].workspaceId, "workspace-1");
  assert.equal(reconciliation.repositories[0].registrationSource, "runtime_default");
  assert.equal(reconciliation.repositories[0].status, "manual_required");
  assert.match(reconciliation.repositories[0].reason, /attached to refs\/heads\/main/u);
  assert.equal(reconciliation.repositories[0].primary.branch, null);
  assert.ok(reconciliation.repositories[0].primary.legacyLinkedHolders.some(
    (item) => path.resolve(item.path) === path.resolve(legacyRoot),
  ));
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), beforeStatus);
  assert.match(await git(setup.primary, "worktree", "list", "--porcelain"), /legacy-prerelease-holder/u);
  await assert.rejects(stat(path.join(setup.dataDir, "release-repositories")), { code: "ENOENT" });
});

test("startup counts a registered runtime root even when it is not a Git repository", async (context) => {
  const setup = await fixture(context);
  const runtimeRoot = path.join(setup.root, "runtime-default-project");
  await mkdir(runtimeRoot, { recursive: true });

  const reconciliation = await setup.service.reconcile({
    projectRoots: [{
      workspaceId: "workspace-runtime-default",
      registrationSource: "runtime_default",
      projectRoot: runtimeRoot,
    }],
  });

  assert.equal(reconciliation.checked, 1);
  assert.equal(reconciliation.registeredWorkspaceRoots, 1);
  assert.equal(reconciliation.checkpointCount, 0);
  assert.equal(reconciliation.repositories[0].source, "registered_workspace");
  assert.equal(reconciliation.repositories[0].registrationSource, "runtime_default");
  assert.equal(reconciliation.repositories[0].projectRoot, runtimeRoot);
  assert.equal(reconciliation.repositories[0].status, "manual_required");
  assert.match(reconciliation.repositories[0].reason, /not a git repository/u);
});

test("startup rejects an orphan unmarked clone at the exact managed release path", async (context) => {
  const setup = await fixture(context);
  const releaseRoot = path.join(
    setup.dataDir,
    "release-repositories",
    taskRepositoryKey(setup.primary),
    "repository",
  );
  await mkdir(path.dirname(releaseRoot), { recursive: true });
  await git(path.dirname(releaseRoot), "clone", "--no-checkout", setup.primary, releaseRoot);
  const primaryBefore = {
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    head: await git(setup.primary, "rev-parse", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
    team: await readFile(path.join(setup.primary, ".team", "participant.json")),
    access: await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")),
  };
  const orphanBefore = {
    head: await git(releaseRoot, "rev-parse", "HEAD"),
    status: await git(releaseRoot, "status", "--porcelain=v1"),
  };

  const reconciliation = await setup.service.reconcile({
    projectRoots: [{
      workspaceId: "workspace-orphan-clone",
      registrationSource: "workspace_setting",
      projectRoot: setup.primary,
    }],
  });

  assert.equal(reconciliation.checked, 1);
  assert.equal(reconciliation.registeredWorkspaceRoots, 1);
  assert.equal(reconciliation.checkpointCount, 0);
  assert.equal(reconciliation.repositories[0].status, "manual_required");
  assert.equal(reconciliation.repositories[0].releaseRoot, releaseRoot);
  assert.equal(reconciliation.repositories[0].checkpointPresent, false);
  assert.match(reconciliation.repositories[0].reason, /orphan managed release repository/u);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), primaryBefore.branch);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), primaryBefore.head);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), primaryBefore.status);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), primaryBefore.team);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), primaryBefore.access);
  assert.equal(await git(releaseRoot, "rev-parse", "HEAD"), orphanBefore.head);
  assert.equal(await git(releaseRoot, "status", "--porcelain=v1"), orphanBefore.status);
  await assert.rejects(stat(path.join(path.dirname(releaseRoot), "checkpoint.json")), { code: "ENOENT" });
});

test("dirty primary bytes, retry checkpoint and legacy linked holder remain untouched", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const legacyRoot = path.join(setup.root, "legacy-prerelease-holder");
  await git(setup.primary, "worktree", "add", "-b", "PreRelease", legacyRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", legacyRoot).catch(() => {}));
  const teamBytes = Buffer.from("team-intentional-local\r\n", "utf8");
  const accessBytes = Buffer.from("access-intentional-local\r\n", "utf8");
  await writeFile(path.join(setup.primary, ".team", "participant.json"), teamBytes);
  await writeFile(path.join(setup.primary, "1C_ACCESS", "access.json"), accessBytes);
  const beforeHead = await git(setup.primary, "rev-parse", "HEAD");
  const beforeStatus = await git(setup.primary, "status", "--porcelain=v1");
  const request = {
    planRevision: "plan-dirty-retry",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-dirty", taskRevision: 2, resultCommit }],
  };

  const first = await setup.service.prepareCandidate(request);
  const retry = await setup.service.prepareCandidate(request);

  assert.equal(retry.reused, true);
  assert.equal(retry.preReleaseHead, first.preReleaseHead);
  assert.equal(retry.manifestHash, first.manifestHash);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), beforeStatus);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), teamBytes);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), accessBytes);
  assert.ok(first.legacyLinkedHolders.some((item) => path.resolve(item.path) === path.resolve(legacyRoot)));
  assert.match(await git(setup.primary, "worktree", "list", "--porcelain"), /legacy-prerelease-holder/u);
  const manifest = JSON.parse(await readFile(first.manifestFile, "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.tasks[0].taskId, "task-dirty");
  assert.equal(manifest.tasks[0].resultCommit, resultCommit);
  assert.equal(manifest.tasks[0].integrations.length, 1);
});

test("post-release fast-forward preserves non-overlapping intentional local bytes", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-sync",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-sync", taskRevision: 2, resultCommit }],
  });
  const teamBytes = Buffer.from("team-still-local\r\n", "utf8");
  const accessBytes = Buffer.from("access-still-local\r\n", "utf8");
  await writeFile(path.join(setup.primary, ".team", "participant.json"), teamBytes);
  await writeFile(path.join(setup.primary, "1C_ACCESS", "access.json"), accessBytes);
  const publishedRevision = await publishCandidate(candidate);

  const synchronized = await setup.service.synchronizePublishedPrimary({
    projectRoot: setup.primary,
    publishedRevision,
    planRevision: "plan-sync",
  });

  assert.equal(synchronized.status, "fast_forwarded");
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), publishedRevision);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), teamBytes);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), accessBytes);
  assert.deepEqual(synchronized.dirtyPathsPreserved, [".team/participant.json", "1C_ACCESS/access.json"]);
});

test("post-release overlap is diagnostic and leaves primary HEAD and bytes unchanged", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context, {
    branch: "HUB-126-conflict",
    file: ".team/participant.json",
    content: "published-team\n",
  });
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-conflict",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-conflict", taskRevision: 2, resultCommit }],
  });
  const localBytes = Buffer.from("local-team-must-win\r\n", "utf8");
  await writeFile(path.join(setup.primary, ".team", "participant.json"), localBytes);
  const beforeHead = await git(setup.primary, "rev-parse", "HEAD");
  const beforeStatus = await git(setup.primary, "status", "--porcelain=v1");
  const publishedRevision = await publishCandidate(candidate);

  const synchronized = await setup.service.synchronizePublishedPrimary({
    projectRoot: setup.primary,
    publishedRevision,
    planRevision: "plan-conflict",
  });

  assert.equal(synchronized.status, "manual_required");
  assert.deepEqual(synchronized.conflicts, [".team/participant.json"]);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), beforeStatus);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), localBytes);
});

// HUB-204: выбранная зависимость входит ровно один раз, невыбранная не входит.
async function dependencyFixture(setup, context, { selectDependency }) {
  const depRoot = path.join(setup.root, "task-dependency");
  await git(setup.primary, "worktree", "add", "-b", "HUB-dependency", depRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", depRoot).catch(() => {}));
  await writeFile(path.join(depRoot, "dependency.txt"), "dependency\n", "utf8");
  const dependencyResult = await commit(depRoot, "dependency");

  // Задача Б ветвится от результата А, поэтому содержит её коммит в своей истории.
  const dependentRoot = path.join(setup.root, "task-dependent");
  await git(setup.primary, "worktree", "add", "-b", "HUB-dependent", dependentRoot, dependencyResult);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", dependentRoot).catch(() => {}));
  await writeFile(path.join(dependentRoot, "dependent.txt"), "dependent\n", "utf8");
  const dependentResult = await commit(dependentRoot, "dependent");

  const devRoot = path.join(setup.root, "dev-dependency");
  await git(setup.primary, "worktree", "add", "-b", "dev-dependency", devRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependencyResult);
  const dependencyIntegration = await git(devRoot, "rev-parse", "HEAD");
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependentResult);
  const dependentIntegration = await git(devRoot, "rev-parse", "HEAD");

  const dependencyTask = {
    taskId: "task-dependency",
    taskRevision: 2,
    resultCommit: dependencyResult,
    integrations: [{ commit: dependencyIntegration, parent: setup.baseCommit, order: 1 }],
  };
  const dependentTask = {
    taskId: "task-dependent",
    taskRevision: 3,
    resultCommit: dependentResult,
    integrations: [{ commit: dependentIntegration, parent: dependencyIntegration, order: 2 }],
  };
  return { frozenTasks: selectDependency ? [dependencyTask, dependentTask] : [dependentTask] };
}

test("selected dependency and its dependent Task are each included exactly once", async (context) => {
  const setup = await fixture(context);
  const scenario = await dependencyFixture(setup, context, { selectDependency: true });

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-dependency-selected",
    projectRoot: setup.primary,
    frozenTasks: scenario.frozenTasks,
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependency.txt`), "dependency");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependent.txt`), "dependent");
  const names = (await git(candidate.releaseRoot, "diff", "--name-only",
    setup.baseCommit, candidate.preReleaseHead)).split("\n").filter(Boolean).sort();
  assert.deepEqual(names, ["dependency.txt", "dependent.txt"]);
});

test("an unselected dependency never reaches the release through its dependent Task", async (context) => {
  const setup = await fixture(context);
  const scenario = await dependencyFixture(setup, context, { selectDependency: false });

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-dependency-excluded",
    projectRoot: setup.primary,
    frozenTasks: scenario.frozenTasks,
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependent.txt`), "dependent");
  await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependency.txt`));
  const names = (await git(candidate.releaseRoot, "diff", "--name-only",
    setup.baseCommit, candidate.preReleaseHead)).split("\n").filter(Boolean);
  assert.deepEqual(names, ["dependent.txt"]);
});

test("repeated publication freeze reuses the accepted PreRelease without rebuilding or losing composition", async (context) => {
  const setup = await fixture(context);
  const scenario = await dependencyFixture(setup, context, { selectDependency: true });

  const accepted = await setup.service.prepareCandidate({
    planRevision: "plan-reuse",
    projectRoot: setup.primary,
    workspaceId: "workspace",
    frozenTasks: scenario.frozenTasks,
  });
  const changelogContent = Buffer.from("consolidated\n");
  await writeFile(path.join(accepted.releaseRoot, "CHANGELOG.md"), changelogContent);
  const freeze = (options = {}) => setup.service.freezePublicationCandidate({
    projectRoot: setup.primary,
    workspaceId: "workspace",
    expectedPlanRevision: "plan-reuse",
    expectedPreparedHead: accepted.preReleaseHead,
    changelogContent,
    ...options,
  });

  const frozen = await freeze();
  const refrozen = await freeze({
    validateBeforeCommit: () => assert.fail("a repeated freeze must not revalidate or rebuild the accepted release"),
  });

  assert.equal(frozen.phase, "frozen");
  assert.equal(frozen.reused, false);
  assert.equal(refrozen.reused, true);
  assert.equal(refrozen.preReleaseHead, frozen.preReleaseHead);
  assert.equal(refrozen.manifestHash, frozen.manifestHash);
  assert.equal(await git(accepted.releaseRoot, "rev-parse", "PreRelease"), frozen.preReleaseHead);
  assert.equal(await git(accepted.releaseRoot, "rev-parse", "main"), frozen.preReleaseHead);
  assert.equal(await git(accepted.releaseRoot, "show", `${refrozen.preReleaseHead}:dependency.txt`), "dependency");
  assert.equal(await git(accepted.releaseRoot, "show", `${refrozen.preReleaseHead}:dependent.txt`), "dependent");
  const names = (await git(accepted.releaseRoot, "diff", "--name-only",
    setup.baseCommit, refrozen.preReleaseHead)).split("\n").filter(Boolean).sort();
  assert.deepEqual(names, ["CHANGELOG.md", "dependency.txt", "dependent.txt"]);
});
