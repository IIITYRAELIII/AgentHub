import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { canonicalPath } from "./config.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import {
  normalizedTaskId,
  TASK_BRANCH_PREFIX,
  taskBranchName,
  taskRepositoryKey,
} from "../../domain/task-git-reference.mjs";

export const TASK_DEV_BRANCH = "dev";
const TASK_BASE_REF_PREFIX = "refs/agent-hub/task-bases/";

function runGit(args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(output);
      else reject(new Error(errorText || `git ${args[0]} exited with ${code}`));
    });
  });
}

async function gitMaybe(args, options) {
  try {
    return await runGit(args, options);
  } catch {
    return null;
  }
}

function taskBaseRef(taskId, repoKey) {
  return `${TASK_BASE_REF_PREFIX}${normalizedTaskId(taskId)}/${repoKey}`;
}

function parseWorktrees(value) {
  const records = [];
  let current = null;
  for (const line of String(value ?? "").split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branchRef: null };
      records.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branchRef = line.slice(7);
    }
  }
  return records;
}

function pathInside(root, candidate) {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const first = canonicalPath(left);
  const second = canonicalPath(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function isTaskNumberBranch(value) {
  return /^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,68}[\p{L}\p{N}])?-\d{1,9}$/u.test(String(value ?? ""));
}

function changedFilesFromNameStatus(value, projectRoot) {
  return String(value ?? "").split(/\r?\n/u).flatMap((line) => {
    const fields = line.split("\t");
    const status = String(fields[0] ?? "").trim().toUpperCase();
    if (!status || !fields[1]) return [];
    if (status.startsWith("R") && fields[2]) {
      return [
        { projectRoot, path: fields[1], operation: "deleted" },
        { projectRoot, path: fields[2], operation: "added" },
      ];
    }
    const operation = status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified";
    return [{ projectRoot, path: fields.at(-1), operation }];
  });
}

async function repositoryRoot(projectRoot) {
  const commonDir = path.resolve(await runGit([
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ], { cwd: path.resolve(projectRoot) }));
  return canonicalPath(path.basename(commonDir).toLowerCase() === ".git"
    ? path.dirname(commonDir)
    : commonDir);
}

async function worktreeRoot(projectRoot) {
  return canonicalPath(await runGit([
    "rev-parse", "--path-format=absolute", "--show-toplevel",
  ], { cwd: path.resolve(projectRoot) }));
}

async function branchExists(repositoryRootValue, branch) {
  return await gitMaybe(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repositoryRootValue,
  }) !== null;
}

async function preferredMainCommit(repositoryRootValue) {
  for (const ref of ["refs/remotes/origin/main", "refs/heads/main", "HEAD"]) {
    const commit = await gitMaybe(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repositoryRootValue });
    if (commit) return commit;
  }
  throw new Error(`Cannot resolve main in ${repositoryRootValue}`);
}

async function worktreeForBranch(repositoryRootValue, branch) {
  const branchRef = `refs/heads/${branch}`;
  return parseWorktrees(await runGit(["worktree", "list", "--porcelain"], { cwd: repositoryRootValue }))
    .find((item) => item.branchRef === branchRef)?.path ?? null;
}

async function commitDirtyWorktree(worktreeRoot, message) {
  const dirty = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktreeRoot });
  if (!dirty) return false;
  await runGit(["add", "-A", "--", "."], { cwd: worktreeRoot });
  if (await gitMaybe(["diff", "--cached", "--quiet"], { cwd: worktreeRoot }) !== null) return false;
  await runGit([
    "-c", "user.name=Agent Hub",
    "-c", "user.email=agent-hub@local.invalid",
    "commit", "--no-gpg-sign", "-m", message,
  ], { cwd: worktreeRoot, timeoutMs: 120_000 });
  return true;
}

export class TaskGitWorkspaceService {
  constructor({ dataDir, devBranch = TASK_DEV_BRANCH } = {}) {
    this.dataDir = canonicalPath(String(dataDir ?? ""));
    this.taskWorktreesRoot = path.join(this.dataDir, "task-worktrees");
    this.devWorktreesRoot = path.join(this.dataDir, "dev-worktrees");
    this.devBranch = String(devBranch ?? TASK_DEV_BRANCH).trim() || TASK_DEV_BRANCH;
  }

  async #ensureBranchWorktree({ repositoryRoot: repoRoot, branch, worktreeRoot, startCommit, managedRoot }) {
    const existing = await worktreeForBranch(repoRoot, branch);
    if (existing) {
      if (!pathInside(managedRoot, existing)) {
        throw new Error(`Agent Hub branch ${branch} is checked out outside its managed worktree: ${existing}`);
      }
      return canonicalPath(existing);
    }
    await mkdir(path.dirname(worktreeRoot), { recursive: true });
    const exists = await branchExists(repoRoot, branch);
    await runGit([
      "worktree", "add",
      ...(exists ? [] : ["-b", branch]),
      worktreeRoot,
      ...(exists ? [branch] : [startCommit]),
    ], { cwd: repoRoot, timeoutMs: 120_000 });
    return canonicalPath(worktreeRoot);
  }

  async #alignExistingTaskBranch({ repositoryRoot: repoRoot, worktreeRoot: root, branch }) {
    const registered = parseWorktrees(await runGit(["worktree", "list", "--porcelain"], { cwd: repoRoot }))
      .find((item) => samePath(item.path, root));
    if (!registered) return;
    const currentBranch = await runGit(["branch", "--show-current"], { cwd: root });
    if (currentBranch === branch) return;
    if (await branchExists(repoRoot, branch)) throw new Error(`Task branch already exists: ${branch}`);
    await runGit(["branch", "-m", branch], { cwd: root });
  }

  async prepareDev(projectRoot) {
    const repoRoot = await repositoryRoot(projectRoot);
    const repoKey = taskRepositoryKey(repoRoot);
    const devLock = path.join(this.dataDir, "locks", `task-git-dev-${repoKey}`);
    return withInterprocessLocks([devLock], async () => {
      const mainCommit = await preferredMainCommit(repoRoot);
      const devRoot = await this.#ensureBranchWorktree({
        repositoryRoot: repoRoot,
        branch: this.devBranch,
        worktreeRoot: path.join(this.devWorktreesRoot, repoKey),
        managedRoot: this.devWorktreesRoot,
        startCommit: mainCommit,
      });
      return {
        repositoryRoot: repoRoot,
        projectRoot: devRoot,
        branch: this.devBranch,
        headCommit: await runGit(["rev-parse", "HEAD^{commit}"], { cwd: devRoot }),
      };
    });
  }

  async prepare({ taskId, taskNumber = null, projectRoot } = {}) {
    const id = normalizedTaskId(taskId);
    const dev = await this.prepareDev(projectRoot);
    const repoKey = taskRepositoryKey(dev.repositoryRoot);
    const branch = taskBranchName(id, dev.repositoryRoot, taskNumber);
    const baseRef = taskBaseRef(id, repoKey);
    let baseCommit = await gitMaybe(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: dev.repositoryRoot });
    if (!baseCommit) {
      baseCommit = await preferredMainCommit(dev.repositoryRoot);
      await runGit(["update-ref", baseRef, baseCommit], { cwd: dev.repositoryRoot });
    }
    const taskRootPath = path.join(this.taskWorktreesRoot, id, repoKey);
    await this.#alignExistingTaskBranch({
      repositoryRoot: dev.repositoryRoot,
      worktreeRoot: taskRootPath,
      branch,
    });
    const taskRoot = await this.#ensureBranchWorktree({
      repositoryRoot: dev.repositoryRoot,
      branch,
      worktreeRoot: taskRootPath,
      managedRoot: path.join(this.taskWorktreesRoot, id),
      startCommit: baseCommit,
    });
    const headCommit = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: taskRoot });
    return {
      taskId: id,
      repositoryRoot: dev.repositoryRoot,
      projectRoot: taskRoot,
      branch,
      baseRef,
      baseCommit,
      headCommit,
      gitBaseline: { repoRoot: dev.repositoryRoot, tree: baseCommit },
    };
  }

  async managedRepositoryRoot(projectRoot, { taskId, taskNumber = null } = {}) {
    const expectedTaskId = String(taskId ?? "").trim();
    if (!expectedTaskId) return null;
    const id = normalizedTaskId(expectedTaskId);
    const candidate = canonicalPath(projectRoot);
    if (!pathInside(this.taskWorktreesRoot, candidate)) return null;
    try {
      const taskRoot = await worktreeRoot(candidate);
      if (!samePath(taskRoot, candidate) || !pathInside(this.taskWorktreesRoot, taskRoot)) return null;
      const ownerTaskId = path.relative(this.taskWorktreesRoot, taskRoot).split(path.sep)[0];
      if (normalizedTaskId(ownerTaskId) !== id) return null;
      const repoRoot = await repositoryRoot(taskRoot);
      const branch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: taskRoot });
      if (branch === taskBranchName(id, repoRoot)) return repoRoot;
      const numberedBranch = String(taskNumber ?? "").trim();
      return isTaskNumberBranch(numberedBranch) && branch === numberedBranch ? repoRoot : null;
    } catch {
      return null;
    }
  }

  async snapshot({ taskId, taskNumber = null, projectRoot, turnId = null, summary = "" } = {}) {
    const workspace = await this.prepare({ taskId, taskNumber, projectRoot });
    const suffix = String(turnId ?? "").trim() || randomUUID();
    await commitDirtyWorktree(
      workspace.projectRoot,
      `task(${workspace.taskId.slice(0, 8)}): ${String(summary ?? "").trim() || `snapshot ${suffix}`}`,
    );
    const headCommit = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: workspace.projectRoot });
    const diff = await runGit([
      "-c", "core.quotePath=false",
      "diff", "--name-status", "--find-renames", workspace.baseCommit, headCommit, "--",
    ], { cwd: workspace.projectRoot });
    return {
      ...workspace,
      headCommit,
      changedFiles: changedFilesFromNameStatus(diff, workspace.repositoryRoot),
      resultSnapshot: { repoRoot: workspace.repositoryRoot, tree: headCommit },
    };
  }

  async mergeIntoDev(snapshot) {
    const dev = await this.prepareDev(snapshot.repositoryRoot);
    const devLock = path.join(this.dataDir, "locks", `task-git-dev-${taskRepositoryKey(dev.repositoryRoot)}`);
    return withInterprocessLocks([devLock], async () => {
      const isMerged = await gitMaybe(["merge-base", "--is-ancestor", snapshot.headCommit, "HEAD"], {
        cwd: dev.projectRoot,
      }) !== null;
      if (isMerged) return { integrated: true, alreadyIntegrated: true, dev };
      try {
        await runGit([
          "-c", "user.name=Agent Hub",
          "-c", "user.email=agent-hub@local.invalid",
          "merge", "--no-ff", "--no-edit", snapshot.headCommit,
        ], { cwd: dev.projectRoot, timeoutMs: 120_000 });
        return {
          integrated: true,
          alreadyIntegrated: false,
          dev: { ...dev, headCommit: await runGit(["rev-parse", "HEAD^{commit}"], { cwd: dev.projectRoot }) },
        };
      } catch (error) {
        const conflicts = String(await gitMaybe(["diff", "--name-only", "--diff-filter=U"], {
          cwd: dev.projectRoot,
        }) ?? "").split(/\r?\n/u).filter(Boolean);
        await gitMaybe(["merge", "--abort"], { cwd: dev.projectRoot });
        return { integrated: false, conflicts, error: error.message, dev };
      }
    });
  }

  async snapshotAndMerge(params = {}) {
    const snapshot = await this.snapshot(params);
    const integration = snapshot.changedFiles.length
      ? await this.mergeIntoDev(snapshot)
      : { integrated: true, alreadyIntegrated: true, dev: await this.prepareDev(snapshot.repositoryRoot) };
    return { snapshot, integration };
  }

  async releaseEvidence({ taskId, taskNumber = null, projectRoot, branch, resultCommit } = {}) {
    const id = normalizedTaskId(taskId);
    const repoRoot = await repositoryRoot(projectRoot);
    const expectedBranch = taskBranchName(id, repoRoot, taskNumber);
    const legacyBranch = taskBranchName(id, repoRoot);
    const storedBranch = String(branch ?? "").trim();
    if (storedBranch !== expectedBranch && storedBranch !== legacyBranch) {
      throw new Error(`Task branch does not match its repository: ${branch}`);
    }
    const repoKey = taskRepositoryKey(repoRoot);
    const baseRef = taskBaseRef(id, repoKey);
    const baseCommit = await runGit(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: repoRoot });
    const acceptedCommit = await runGit(["rev-parse", "--verify", `${String(resultCommit)}^{commit}`], { cwd: repoRoot });
    const branchCommit = await runGit(["rev-parse", "--verify", `refs/heads/${storedBranch}^{commit}`], { cwd: repoRoot });
    await runGit(["merge-base", "--is-ancestor", acceptedCommit, branchCommit], { cwd: repoRoot });
    const diff = await runGit([
      "-c", "core.quotePath=false",
      "diff", "--name-status", "--find-renames", baseCommit, acceptedCommit, "--",
    ], { cwd: repoRoot });
    return {
      projectRoot: repoRoot,
      branch: storedBranch,
      resultCommit: acceptedCommit,
      changedFiles: changedFilesFromNameStatus(diff, repoRoot),
    };
  }

  async verifyReleaseResultsInDev({ projectRoot, resultCommits = [] } = {}) {
    const dev = await this.prepareDev(projectRoot);
    const commits = [...new Set(resultCommits.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
    if (!commits.length) throw new Error("release preflight requires Task result commits");
    const verified = [];
    for (const resultCommit of commits) {
      const acceptedCommit = await runGit(["rev-parse", "--verify", `${resultCommit}^{commit}`], {
        cwd: dev.projectRoot,
      });
      const integrated = await gitMaybe(["merge-base", "--is-ancestor", acceptedCommit, dev.headCommit], {
        cwd: dev.projectRoot,
      }) !== null;
      if (!integrated) {
        throw new Error(`Task result commit ${acceptedCommit} is not integrated into dev ${dev.headCommit}`);
      }
      verified.push(acceptedCommit);
    }
    return { ...dev, resultCommits: verified };
  }

  async describe(taskId) {
    const id = normalizedTaskId(taskId);
    const root = path.join(this.taskWorktreesRoot, id);
    const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const workspaces = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const projectRoot = path.join(root, entry.name);
      const branch = await gitMaybe(["branch", "--show-current"], { cwd: projectRoot });
      if (!branch) continue;
      workspaces.push({
        taskId: id,
        repositoryKey: entry.name,
        projectRoot,
        branch,
        headCommit: await runGit(["rev-parse", "HEAD^{commit}"], { cwd: projectRoot }),
      });
    }
    return workspaces;
  }

  async cleanup(taskId) {
    const id = normalizedTaskId(taskId);
    const root = path.join(this.taskWorktreesRoot, id);
    if (!pathInside(this.taskWorktreesRoot, root)) throw new Error("Task worktree cleanup escaped its managed root");
    const workspaces = await this.describe(id);
    for (const workspace of workspaces) {
      if (!pathInside(root, workspace.projectRoot)) throw new Error("Task worktree is outside its managed Task root");
      const repoRoot = await repositoryRoot(workspace.projectRoot);
      await runGit(["worktree", "remove", "--force", workspace.projectRoot], { cwd: repoRoot, timeoutMs: 120_000 });
      await gitMaybe(["branch", "-D", workspace.branch], { cwd: repoRoot });
      await gitMaybe(["update-ref", "-d", taskBaseRef(id, workspace.repositoryKey)], { cwd: repoRoot });
    }
    await rm(root, { recursive: true, force: true });
    return { taskId: id, removed: workspaces.length };
  }
}

export async function prepareTaskContourSource({ sourceRoot, integrationRoot } = {}) {
  const resolvedSourceRoot = canonicalPath(sourceRoot);
  const repoRoot = await repositoryRoot(resolvedSourceRoot).catch(() => null);
  if (!repoRoot) throw new Error("Test Contour source must belong to a Git repository with branch dev");
  if (!await branchExists(repoRoot, TASK_DEV_BRANCH)) {
    throw new Error("Test Contour requires branch dev");
  }
  const sourceWorktreeRoot = await worktreeRoot(resolvedSourceRoot);
  const sourceRelativePath = path.relative(sourceWorktreeRoot, resolvedSourceRoot);
  if (path.isAbsolute(sourceRelativePath) || sourceRelativePath === ".." || sourceRelativePath.startsWith(`..${path.sep}`)) {
    throw new Error("Test Contour source is outside its Git repository");
  }
  const sourceFromWorktree = (worktreeRoot) => canonicalPath(path.resolve(worktreeRoot, sourceRelativePath));
  const headCommit = await runGit(["rev-parse", `${TASK_DEV_BRANCH}^{commit}`], { cwd: repoRoot });
  const checkedOut = await worktreeForBranch(repoRoot, TASK_DEV_BRANCH);
  if (checkedOut) {
    return { sourceRoot: sourceFromWorktree(checkedOut), branch: TASK_DEV_BRANCH, headCommit };
  }
  const managedRoot = canonicalPath(integrationRoot);
  const detachedRoot = path.join(managedRoot, "dev-source", taskRepositoryKey(repoRoot));
  if (!pathInside(managedRoot, detachedRoot)) throw new Error("Test Contour dev source escaped its managed root");
  const registered = parseWorktrees(await runGit(["worktree", "list", "--porcelain"], { cwd: repoRoot }))
    .some((item) => samePath(item.path, detachedRoot));
  if (registered) {
    await runGit(["reset", "--hard", headCommit], { cwd: detachedRoot, timeoutMs: 120_000 });
  } else {
    await rm(detachedRoot, { recursive: true, force: true });
    await mkdir(path.dirname(detachedRoot), { recursive: true });
    await runGit(["worktree", "add", "--detach", detachedRoot, headCommit], { cwd: repoRoot, timeoutMs: 120_000 });
  }
  return { sourceRoot: sourceFromWorktree(detachedRoot), branch: TASK_DEV_BRANCH, headCommit };
}
