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
    frozenTasks: [{ taskId: "task-clean", resultCommit }],
  });

  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), before.branch);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), before.status);
  assert.equal(candidate.primaryPreserved, true);
  assert.equal(candidate.independentGitCommonDir, true);
  assert.notEqual(candidate.releaseGitCommonDir, candidate.primaryGitCommonDir);
  assert.equal(await git(candidate.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:feature.txt`), "feature");
  await assert.rejects(git(candidate.releaseRoot, "cat-file", "-e", `${candidate.preReleaseHead}:dev-only.txt`));
  assert.equal((await assertReleaseCloneForPublication({ repositoryRoot: candidate.releaseRoot })).kind,
    "agent-hub-owned-release-clone");
  await assert.rejects(
    assertReleaseCloneForPublication({ repositoryRoot: setup.primary }),
    /requires an Agent Hub-owned independent release clone/u,
  );
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
    frozenTasks: [{ taskId: "task-release-contour", resultCommit }],
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
    frozenTasks: [{ taskId: "task-release-contour-guard", resultCommit }],
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
      frozenTasks: [{ taskId: "task-unmarked", resultCommit }],
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
    frozenTasks: [{ taskId: "task-dirty", resultCommit }],
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
  assert.deepEqual(manifest.tasks, [{ taskId: "task-dirty", resultCommit }]);
});

test("post-release fast-forward preserves non-overlapping intentional local bytes", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-sync",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-sync", resultCommit }],
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
    frozenTasks: [{ taskId: "task-conflict", resultCommit }],
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
