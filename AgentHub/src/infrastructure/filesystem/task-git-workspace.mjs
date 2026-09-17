import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertContourExternalEffects, assertContourGitAvailable } from "../../ports/contour-external-effects.mjs";
import process from "node:process";

import { canonicalPath } from "./config.mjs";
import { taskWorkingTreeDiff } from "./task-git-diff.mjs";
import { TaskDependencyPendingError } from "../../domain/task-board-task.mjs";
import { prepareTaskWorktreeDependencies } from "./task-worktree-dependencies.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import {
  isTrustedWindowsPowerShellPath,
  readTrustedSystemBootIdentity,
} from "../process/system-boot-identity.mjs";
import { publicationStateRepositories, readPublicationState } from "../persistence/publication-state.mjs";
import {
  normalizedTaskId,
  TASK_BRANCH_PREFIX,
  taskBranchName,
  taskRepositoryKey,
} from "../../domain/task-git-reference.mjs";
import { normalizedTaskSquashTransfer } from "../../domain/task-squash-transfer.mjs";

export const TASK_DEV_BRANCH = "dev";
const TASK_BASE_REF_PREFIX = "refs/agent-hub/task-bases/";
const TASK_LEGACY_ADOPTION_REF_PREFIX = "refs/agent-hub/legacy-adoptions/";
const TASK_RESULT_REF_PREFIX = "refs/agent-hub/task-results/";
const TASK_UPSTREAM_ADOPTION_REF_PREFIX = "refs/agent-hub/upstream-adoptions/";
const MAX_UPSTREAM_ADOPTION_PROOFS = 512;
const LEGACY_CLAIM_REPOSITORY_GUARD_NO_EFFECT_VERSION = "task-git-repository-guard-before-dev-lock-v1";
const CLAIM_REPOSITORY_GUARD_NO_EFFECT_VERSION = "task-git-repository-guard-under-dev-lock-v2";
const CLAIM_REPOSITORY_GUARD_ERROR_PREFIX = "Task Git repository blocked: unresolved process-tree guard requires operator proof";

export function stopTaskProcessTree(child, { spawnProcess = spawn, timeoutMs = 5_000 } = {}) {
  if (!child?.pid || process.platform !== "win32") {
    child?.kill?.("SIGKILL");
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!value) child.kill?.("SIGKILL");
      resolve(value);
    };
    let killer;
    try {
      killer = spawnProcess("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      killer.kill?.("SIGKILL");
      finish(false);
    }, timeoutMs);
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

function taskGitTerminationError(args, timeoutMs, processTreeStopped, cause = "timed out", commandLabel = "git") {
  const command = commandLabel === "git" ? `git ${args[0]}` : commandLabel;
  const error = new Error(processTreeStopped
    ? `${command} ${cause} after ${timeoutMs} ms; process tree stopped`
    : `${command} ${cause} after ${timeoutMs} ms; process tree stop is unproven`);
  error.processTreeStopped = processTreeStopped;
  const codePrefix = commandLabel === "git" ? "TASK_GIT" : "TASK_EXTERNAL_PROCESS";
  error.code = processTreeStopped ? `${codePrefix}_TERMINATED` : `${codePrefix}_TREE_UNPROVEN`;
  return error;
}

export function runTaskGitCommand(args, {
  cwd, timeoutMs = 60_000, executable = "git", spawnProcess = spawn, signal = null, input = null,
  commandLabel = "git", env = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Task Git lease ownership was lost"));
      return;
    }
    const child = spawnProcess(executable, args, {
      cwd,
      windowsHide: true,
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const stdout = [];
    const stderr = [];
    let termination = null;
    let terminationOutcome = null;
    let childClosed = false;
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", abort);
      callback();
    };
    let stopTimer = null;
    const terminate = (cause) => {
      if (termination) return;
      termination = cause;
      void stopTaskProcessTree(child, { spawnProcess }).then((stopped) => {
        terminationOutcome = stopped;
        if (!stopped) {
          settle(() => reject(taskGitTerminationError(args, timeoutMs, false, cause, commandLabel)));
          return;
        }
        if (settled) return;
        if (childClosed) {
          settle(() => reject(taskGitTerminationError(args, timeoutMs, true, cause, commandLabel)));
          return;
        }
        stopTimer = setTimeout(() => settle(() => reject(
          taskGitTerminationError(args, timeoutMs, true, cause, commandLabel),
        )), 5_000);
        stopTimer.unref?.();
      });
    };
    const abort = () => terminate("was fenced");
    signal?.addEventListener?.("abort", abort, { once: true });
    const timer = setTimeout(() => terminate("timed out"), timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      settle(() => reject(error));
    });
    child.on("close", (code) => {
      childClosed = true;
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (termination && terminationOutcome == null) return;
      if (termination) settle(() => reject(
        taskGitTerminationError(args, timeoutMs, terminationOutcome, termination, commandLabel),
      ));
      else if (code === 0) settle(() => resolve(output));
      else {
        const command = commandLabel === "git" ? `git ${args[0]}` : commandLabel;
        settle(() => reject(new Error(errorText || `${command} exited with ${code}`)));
      }
    });
    if (input != null) child.stdin.end(input);
  });
}

const runGit = runTaskGitCommand;

function runGitWithInput(args, input, options = {}) {
  return runGit(args, { ...options, input });
}

function requiredGuardLease(lease) {
  if (typeof lease?.assertOwned !== "function" || typeof lease?.beginProcessTreeGuard !== "function") {
    throw new Error("Task Git mutation requires an owned process-tree guard lease");
  }
  return lease;
}

function combinedLease(primary, secondary, { repositoryKey = null } = {}) {
  requiredGuardLease(primary);
  if (typeof secondary?.assertOwned !== "function") throw new Error("Task Git dev lock lease is required");
  const signals = [primary.signal, secondary.signal].filter(Boolean);
  const repositoryLockKeys = new Set(primary.repositoryLockKeys ?? []);
  if (repositoryKey) repositoryLockKeys.add(repositoryKey);
  return {
    ...primary,
    ownerId: `${primary.ownerId}|${secondary.ownerId}`,
    repositoryLockKeys,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] ?? null,
    async assertOwned() {
      await primary.assertOwned();
      await secondary.assertOwned();
    },
  };
}

export async function runOwnedGit(args, { lease = null, ...options } = {}) {
  const owner = requiredGuardLease(lease);
  await owner.assertOwned();
  const guard = await owner.beginProcessTreeGuard({ args, cwd: options.cwd });
  try {
    const result = await runGit(args, { ...options, signal: owner.signal ?? null });
    await guard.clear({ proof: "natural-process-tree-completion" });
    await owner.assertOwned();
    return result;
  } catch (error) {
    if (error?.processTreeStopped !== false) {
      await guard.clear({ proof: error?.processTreeStopped === true
        ? "bounded-process-tree-stop"
        : "process-never-started-or-natural-exit" });
    } else {
      guard.markUnresolved(error);
    }
    throw error;
  }
}

async function repositoryIdentityFromPath(value) {
  let current = canonicalPath(value);
  for (;;) {
    const marker = path.join(current, ".git");
    const markerStat = await stat(marker).catch(() => null);
    if (markerStat?.isDirectory()) return current;
    if (markerStat?.isFile()) {
      const text = await readFile(marker, "utf8");
      const match = /^gitdir:\s*(.+)$/imu.exec(text);
      if (!match) return current;
      const gitDir = path.resolve(current, match[1].trim());
      const common = await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "");
      const commonDir = common.trim() ? path.resolve(gitDir, common.trim()) : gitDir;
      return canonicalPath(path.basename(commonDir).toLowerCase() === ".git"
        ? path.dirname(commonDir)
        : commonDir);
    }
    const parent = path.dirname(current);
    if (parent === current) return canonicalPath(value);
    current = parent;
  }
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

function taskLegacyAdoptionRef(taskId, repoKey) {
  return `${TASK_LEGACY_ADOPTION_REF_PREFIX}${normalizedTaskId(taskId)}/${repoKey}`;
}

function exactCommitId(value, label) {
  const commit = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`${label} must be a full Git commit id`);
  return commit;
}

function exactTreeEntry(value, label) {
  const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40})\t([\s\S]+)$/u.exec(String(value ?? ""));
  if (!match) throw new Error(`${label} must be one exact Git tree entry`);
  return { mode: match[1], type: match[2], object: match[3], path: match[4] };
}

function sameTreeEntry(left, right) {
  return left?.mode === right?.mode && left?.type === right?.type && left?.object === right?.object;
}

function isChangelogPath(value) {
  return String(value ?? "").replaceAll("\\", "/").split("/").at(-1) === "CHANGELOG.md";
}

function taskResultRef(taskId, repoKey) {
  return `${TASK_RESULT_REF_PREFIX}${normalizedTaskId(taskId)}/${repoKey}`;
}

function taskUpstreamAdoptionPrefix(taskId, repoKey) {
  return `${TASK_UPSTREAM_ADOPTION_REF_PREFIX}${normalizedTaskId(taskId)}/${repoKey}/`;
}

function taskUpstreamAdoptionRef(taskId, repoKey, snapshotCommit, adoptedCommit) {
  return `${taskUpstreamAdoptionPrefix(taskId, repoKey)}${snapshotCommit}/${adoptedCommit}`;
}

async function taskUpstreamAdoptionRefs(repoRoot, taskId, repoKey) {
  return String(await runGit([
    "for-each-ref", "--format=%(refname)", taskUpstreamAdoptionPrefix(taskId, repoKey),
  ], { cwd: repoRoot })).split(/\r?\n/u).filter(Boolean);
}

function exactRequestId(value) {
  const requestId = String(value ?? "").trim();
  if (!requestId || requestId.length > 128 || /[\r\n\0]/u.test(requestId)) {
    throw new Error("explicit upstream adoption request id is invalid");
  }
  return requestId;
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

export function taskSparseCheckoutSelection(repositoryWorktreeRoot, projectRoot) {
  const root = canonicalPath(repositoryWorktreeRoot);
  const candidate = canonicalPath(projectRoot);
  if (!pathInside(root, candidate)) {
    throw new Error(`Task project root is outside its Git worktree: ${candidate}`);
  }
  const relativePath = path.relative(root, candidate);
  const components = relativePath ? relativePath.split(path.sep) : [];
  const patterns = ["/*"];
  let parent = "";
  for (const component of components) {
    patterns.push(`!${parent}/*/`);
    parent += `/${component.replaceAll(/([\\*?\[\]])/gu, "\\$1")}`;
    patterns.push(`${parent}/`);
  }
  patterns.push("!CHANGELOG.md");
  return {
    relativePath,
    cone: false,
    scope: relativePath ? relativePath.split(path.sep).join("/") : "/*",
    patterns,
  };
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

async function trackedNpmLockfiles(repositoryWorktreeRoot, projectRoot) {
  const output = await runGit([
    "ls-files", "-z", "--", "package-lock.json", ":(glob)**/package-lock.json",
  ], { cwd: repositoryWorktreeRoot });
  return [...new Set(output.split("\0")
    .filter(Boolean)
    .map((lockfile) => canonicalPath(path.resolve(repositoryWorktreeRoot, lockfile)))
    .filter((lockfile) => pathInside(projectRoot, lockfile)))].sort();
}

async function branchExists(repositoryRootValue, branch) {
  return await gitMaybe(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repositoryRootValue,
  }) !== null;
}

async function localMainCommit(repositoryRootValue) {
  try {
    return await runGit(["rev-parse", "--verify", "refs/heads/main^{commit}"], { cwd: repositoryRootValue });
  } catch {
    throw new Error(`accepted local refs/heads/main is missing in ${repositoryRootValue}`);
  }
}

async function singleParentCommit(repositoryRootValue, commit) {
  const line = await runGit(["rev-list", "--parents", "-n", "1", commit], { cwd: repositoryRootValue });
  const parts = line.split(/\s+/u).filter(Boolean);
  if (parts.length !== 2) throw new Error(`Legacy result ${commit} must be a single-parent commit`);
  return parts[1];
}

async function commitPatchEvidence(repositoryRootValue, parentCommit, commit) {
  const pathspecs = ["--", ".", ":(exclude,glob)**/CHANGELOG.md"];
  const nameStatus = await runGit([
    "-c", "core.quotePath=false", "diff", "--name-status", "--find-renames",
    parentCommit, commit, ...pathspecs,
  ], { cwd: repositoryRootValue });
  if (!nameStatus) throw new Error(`Legacy result ${commit} has no non-changelog changes`);
  const patch = await runGit([
    "diff", "--binary", "--full-index", parentCommit, commit, ...pathspecs,
  ], { cwd: repositoryRootValue });
  const patchIdOutput = await runGitWithInput(["patch-id", "--stable"], `${patch}\n`, {
    cwd: repositoryRootValue,
  });
  const patchId = patchIdOutput.split(/\s+/u)[0] ?? "";
  if (!/^[0-9a-f]{40}$/u.test(patchId)) throw new Error(`Cannot derive patch id for ${commit}`);
  return { nameStatus, patchId };
}

async function worktreeForBranch(repositoryRootValue, branch) {
  const branchRef = `refs/heads/${branch}`;
  return parseWorktrees(await runGit(["worktree", "list", "--porcelain"], { cwd: repositoryRootValue }))
    .find((item) => item.branchRef === branchRef)?.path ?? null;
}

async function commitDirtyWorktree(worktreeRoot, message, { lease = null } = {}) {
  const dirty = await runOwnedGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktreeRoot, lease });
  if (!dirty) return false;
  await assertNoTaskChangelogChanges(worktreeRoot);
  await runOwnedGit(["add", "--sparse", "-A", "--", "."], { cwd: worktreeRoot, lease });
  if (await gitMaybe(["diff", "--cached", "--quiet"], { cwd: worktreeRoot }) !== null) return false;
  await runOwnedGit([
    "-c", "user.name=Agent Hub",
    "-c", "user.email=agent-hub@local.invalid",
    "commit", "--no-gpg-sign", "-m", message,
  ], { cwd: worktreeRoot, timeoutMs: 120_000, lease });
  return true;
}

async function assertNoTaskChangelogChanges(root) {
  const dirty = await runGit([
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ":(glob)**/CHANGELOG.md",
  ], { cwd: root });
  if (dirty) throw new Error("Task worktrees exclude CHANGELOG.md; preserve these local changes outside the Task before continuing");
}

export class TaskGitWorkspaceService {
  #contourExternalEffects;

  constructor({
    dataDir,
    devBranch = TASK_DEV_BRANCH,
    prepareDependencies = prepareTaskWorktreeDependencies,
    readPublication = readPublicationState,
    runCommand = runTaskGitCommand,
    readSystemBootIdentity = readTrustedSystemBootIdentity,
    removeProcessGuard = unlink,
    contourExternalEffects = null,
  } = {}) {
    this.#contourExternalEffects = assertContourExternalEffects(contourExternalEffects);
    this.dataDir = canonicalPath(String(dataDir ?? ""));
    this.taskWorktreesRoot = path.join(this.dataDir, "task-worktrees");
    this.devWorktreesRoot = path.join(this.dataDir, "dev-worktrees");
    this.devBranch = String(devBranch ?? TASK_DEV_BRANCH).trim() || TASK_DEV_BRANCH;
    this.prepareDependencies = prepareDependencies;
    this.readPublication = readPublication;
    this.runCommand = runCommand;
    this.readSystemBootIdentity = readSystemBootIdentity;
    this.removeProcessGuard = removeProcessGuard;
  }

  #assertAvailable(operation) {
    assertContourGitAvailable(this.#contourExternalEffects, "task-git", operation);
  }

  async #runOwned(args, { lease = null, guardCommand = null, guardScope = "repository", ...options } = {}) {
    const owner = requiredGuardLease(lease);
    await owner.assertOwned();
    const guard = await owner.beginProcessTreeGuard({ args: guardCommand ?? args, cwd: options.cwd, scope: guardScope });
    try {
      const result = await this.runCommand(args, { ...options, signal: owner.signal ?? null });
      await guard.clear({ proof: "natural-process-tree-completion" });
      await owner.assertOwned();
      return result;
    } catch (error) {
      if (error?.processTreeStopped !== false) {
        await guard.clear({ proof: error?.processTreeStopped === true
          ? "bounded-process-tree-stop"
          : "process-never-started-or-natural-exit" });
      } else {
        guard.markUnresolved(error);
      }
      throw error;
    }
  }

  async #runOwnedNpm(args, { cwd, lease = null, timeoutMs = 10 * 60_000 } = {}) {
    const windows = process.platform === "win32";
    const executable = windows ? process.env.ComSpec || "cmd.exe" : "npm";
    const commandArgs = windows ? ["/d", "/s", "/c", "npm.cmd", ...args] : args;
    return this.#runOwned(commandArgs, {
      cwd,
      lease,
      timeoutMs,
      executable,
      commandLabel: "npm",
      guardCommand: ["npm", ...args],
      guardScope: "task",
    });
  }

  #taskLock(taskId) {
    return path.join(this.dataDir, "locks", `task-lifecycle-${normalizedTaskId(taskId)}`);
  }

  #processGuardDirectory(taskId) {
    return path.join(this.dataDir, "task-process-tree-guards", normalizedTaskId(taskId));
  }

  #processRecoveryFile(taskId, guardId) {
    const key = createHash("sha256").update(String(guardId ?? ""), "utf8").digest("hex");
    return path.join(this.dataDir, "task-process-tree-recoveries", normalizedTaskId(taskId), `${key}.json`);
  }

  #devBootstrapRecoveryFile(repositoryRootValue) {
    return path.join(
      this.dataDir,
      "task-dev-bootstrap-recoveries",
      `${taskRepositoryKey(repositoryRootValue)}.json`,
    );
  }

  async #treeEntryAt(repoRoot, commit, relativePath, lease) {
    const output = await this.#runOwned([
      "ls-tree", "-z", exactCommitId(commit, "tree entry commit"), "--", relativePath,
    ], { cwd: repoRoot, lease });
    if (!output) return null;
    return exactTreeEntry(output.replace(/\0$/u, ""), `tree entry for ${relativePath}`);
  }

  async #unmergedEntries(devRoot, relativePath, lease) {
    const output = await this.#runOwned(["ls-files", "-u", "-z", "--", relativePath], {
      cwd: devRoot, lease,
    });
    const entries = new Map();
    for (const record of output.split("\0").filter(Boolean)) {
      const match = /^(\d{6})\s+([0-9a-f]{40})\s+([123])\t([\s\S]+)$/u.exec(record);
      if (!match || match[4] !== relativePath) {
        throw new Error(`Task dev bootstrap has invalid conflict identity for ${relativePath}`);
      }
      const type = await this.#runOwned(["cat-file", "-t", match[2]], { cwd: devRoot, lease });
      entries.set(Number(match[3]), { mode: match[1], type, object: match[2], path: match[4] });
    }
    return entries;
  }

  async #resolveSnapshotBootstrapConflicts({ repoRoot, devRoot, snapshot, mainCommit, conflicts, lease }) {
    const baseCommit = exactCommitId(snapshot.baseCommit, "Task snapshot base");
    const snapshotCommit = exactCommitId(snapshot.headCommit, "Task snapshot result");
    const candidates = String(await this.#runOwned([
      "rev-list", "--first-parent", "--merges", "--max-count=513", snapshotCommit, `^${baseCommit}`,
    ], { cwd: repoRoot, lease })).split(/\r?\n/u).filter(Boolean);
    if (candidates.length > 512) {
      throw new Error("Task dev bootstrap proof exceeds the bounded first-parent history");
    }
    const conflictEntries = new Map();
    for (const relativePath of conflicts) {
      const stages = await this.#unmergedEntries(devRoot, relativePath, lease);
      if (!stages.get(2) || !stages.get(3)) {
        throw new Error(`Task dev bootstrap requires exact two-sided conflict entries for ${relativePath}`);
      }
      conflictEntries.set(relativePath, stages);
    }
    const proofs = [];
    for (const candidate of candidates) {
      const parts = String(await this.#runOwned([
        "rev-list", "--parents", "-n", "1", candidate,
      ], { cwd: repoRoot, lease })).split(/\s+/u).filter(Boolean);
      if (parts.length !== 3 || parts[2] !== mainCommit) continue;
      let exact = true;
      for (const relativePath of conflicts) {
        const stages = conflictEntries.get(relativePath);
        const firstParentEntry = await this.#treeEntryAt(repoRoot, parts[1], relativePath, lease);
        const mainEntry = await this.#treeEntryAt(repoRoot, mainCommit, relativePath, lease);
        const proofEntry = await this.#treeEntryAt(repoRoot, candidate, relativePath, lease);
        const snapshotEntry = await this.#treeEntryAt(repoRoot, snapshotCommit, relativePath, lease);
        const changelog = isChangelogPath(relativePath);
        const acceptedEntry = changelog || (
          proofEntry?.type === "blob" && sameTreeEntry(proofEntry, snapshotEntry)
        );
        const parentsProved = changelog || (
          sameTreeEntry(stages.get(2), firstParentEntry)
          && sameTreeEntry(stages.get(3), mainEntry)
        );
        if (!acceptedEntry || !parentsProved) {
          exact = false;
          break;
        }
      }
      if (exact) proofs.push({ commit: candidate, firstParent: parts[1] });
    }
    if (proofs.length !== 1) {
      throw new Error(`Task dev bootstrap requires one exact first-parent main proof; found ${proofs.length}`);
    }
    const proof = proofs[0];
    for (const relativePath of conflicts) {
      const source = isChangelogPath(relativePath) ? snapshotCommit : proof.commit;
      await this.#runOwned(["checkout", source, "--", relativePath], { cwd: devRoot, lease });
      await this.#runOwned(["add", "--", relativePath], { cwd: devRoot, lease });
    }
    const unresolved = String(await this.#runOwned([
      "diff", "--name-only", "--diff-filter=U",
    ], { cwd: devRoot, lease })).split(/\r?\n/u).filter(Boolean);
    if (unresolved.length) {
      throw new Error(`Task dev bootstrap left unresolved conflicts: ${unresolved.join(", ")}`);
    }
    return proof;
  }

  async #recoverDevBootstrapTransaction(repoRoot, devRoot, lease) {
    const file = this.#devBootstrapRecoveryFile(repoRoot);
    const record = await readFile(file, "utf8").then(JSON.parse, (error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!record) return null;
    const exact = record.version === 1
      && samePath(record.repositoryRoot, repoRoot)
      && samePath(record.devRoot, devRoot)
      && record.devBranch === this.devBranch
      && [record.oldDevCommit, record.mainCommit, record.snapshotCommit,
        record.bootstrapProofCommit, record.bootstrapCommit, record.bootstrapTree,
        record.integrationCommit, record.resultTree]
        .every((value) => /^[0-9a-f]{40}$/u.test(String(value ?? "")));
    if (!exact) throw new Error("Task dev bootstrap recovery identity is invalid");
    const [bootstrapLine, integrationLine, bootstrapTree, integrationTree, snapshotTree, proofLine] = [
      await this.#runOwned(["rev-list", "--parents", "-n", "1", record.bootstrapCommit], {
        cwd: repoRoot, lease,
      }),
      await this.#runOwned(["rev-list", "--parents", "-n", "1", record.integrationCommit], {
        cwd: repoRoot, lease,
      }),
      await this.#runOwned(["rev-parse", `${record.bootstrapCommit}^{tree}`], { cwd: repoRoot, lease }),
      await this.#runOwned(["rev-parse", `${record.integrationCommit}^{tree}`], { cwd: repoRoot, lease }),
      await this.#runOwned(["rev-parse", `${record.snapshotCommit}^{tree}`], { cwd: repoRoot, lease }),
      await this.#runOwned(["rev-list", "--parents", "-n", "1", record.bootstrapProofCommit], {
        cwd: repoRoot, lease,
      }),
    ];
    const bootstrapParents = bootstrapLine.split(/\s+/u).filter(Boolean);
    const integrationParents = integrationLine.split(/\s+/u).filter(Boolean);
    const proofParents = proofLine.split(/\s+/u).filter(Boolean);
    const proofFirstParentLine = String(await this.#runOwned([
      "rev-list", "--first-parent", record.snapshotCommit,
    ], { cwd: repoRoot, lease })).split(/\r?\n/u).filter(Boolean);
    if (bootstrapParents.length !== 3
      || bootstrapParents[1] !== record.oldDevCommit
      || bootstrapParents[2] !== record.mainCommit
      || integrationParents.length !== 3
      || integrationParents[1] !== record.bootstrapCommit
      || integrationParents[2] !== record.snapshotCommit
      || proofParents.length !== 3
      || proofParents[2] !== record.mainCommit
      || !proofFirstParentLine.includes(record.bootstrapProofCommit)
      || bootstrapTree !== record.bootstrapTree
      || integrationTree !== record.resultTree
      || snapshotTree !== record.resultTree) {
      throw new Error("Task dev bootstrap recovery commit identity changed");
    }
    const current = await this.#runOwned([
      "rev-parse", `refs/heads/${this.devBranch}^{commit}`,
    ], { cwd: repoRoot, lease });
    if (current === record.oldDevCommit) {
      await unlink(file);
      return { recovered: false, record };
    }
    if (current !== record.integrationCommit) {
      throw new Error(`Task dev bootstrap recovery found unexpected dev ${current}`);
    }
    await this.#runOwned(["reset", "--hard", record.integrationCommit], { cwd: devRoot, lease });
    const status = await this.#runOwned([
      "status", "--porcelain=v1", "-z", "--untracked-files=all",
    ], { cwd: devRoot, lease });
    if (status) throw new Error("Task dev bootstrap recovery did not restore a clean worktree");
    await unlink(file);
    return { recovered: true, record };
  }

  async #bootstrapSnapshotIntoDevOwned({
    repoRoot, devRoot, devHeadBefore, mainCommit, snapshot, statusBefore,
    adoptionReceipt = null, lease,
  }) {
    let mergeActive = false;
    let conflicts = [];
    const restore = async () => {
      if (mergeActive) {
        await this.#runOwned(["merge", "--abort"], { cwd: devRoot, lease });
        mergeActive = false;
      }
      await this.#recoverDevBootstrapTransaction(repoRoot, devRoot, lease);
      const [headCommit, status] = await Promise.all([
        runGit(["rev-parse", "HEAD^{commit}"], { cwd: devRoot }),
        runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: devRoot }),
      ]);
      if (headCommit !== devHeadBefore || status !== statusBefore) {
        throw new Error(`Task dev bootstrap could not restore managed dev ${devHeadBefore}`);
      }
    };
    try {
      try {
        await this.#runOwned([
          "-c", "user.name=Agent Hub",
          "-c", "user.email=agent-hub@local.invalid",
          "merge", "--no-ff", "--no-commit", mainCommit,
        ], { cwd: devRoot, timeoutMs: 300_000, lease });
        mergeActive = true;
      } catch (error) {
        if (error?.processTreeStopped === false) throw error;
        const mergeHead = path.resolve(await runGit(["rev-parse", "--git-path", "MERGE_HEAD"], { cwd: devRoot }));
        mergeActive = await access(mergeHead).then(() => true, () => false);
        if (!mergeActive) throw error;
        conflicts = String(await this.#runOwned([
          "diff", "--name-only", "--diff-filter=U", "-z",
        ], { cwd: devRoot, lease })).split("\0").filter(Boolean);
        if (!conflicts.length) throw error;
      }
      const proof = await this.#resolveSnapshotBootstrapConflicts({
        repoRoot, devRoot, snapshot, mainCommit, conflicts, lease,
      });
      const bootstrapTree = await this.#runOwned(["write-tree"], { cwd: devRoot, lease });
      const bootstrapCommit = await this.#runOwned([
        "-c", "user.name=Agent Hub",
        "-c", "user.email=agent-hub@local.invalid",
        "commit-tree", bootstrapTree, "-p", devHeadBefore, "-p", mainCommit,
      ], {
        cwd: devRoot,
        lease,
        input: "merge(agent-hub): incorporate reviewed main ancestry\n",
      });
      await this.#runOwned(["merge", "--abort"], { cwd: devRoot, lease });
      mergeActive = false;
      const mergeTreeOutput = await this.#runOwned([
        "merge-tree", "--write-tree", bootstrapCommit, snapshot.headCommit,
      ], { cwd: repoRoot, timeoutMs: 300_000, lease });
      const resultTree = exactCommitId(mergeTreeOutput.split(/\s+/u)[0], "Task integration tree");
      const snapshotTree = await this.#runOwned(["rev-parse", `${snapshot.headCommit}^{tree}`], {
        cwd: repoRoot, lease,
      });
      if (resultTree !== snapshotTree) {
        throw new Error("Task dev bootstrap result does not match the accepted Task snapshot tree");
      }
      const integrationCommit = await this.#runOwned([
        "-c", "user.name=Agent Hub",
        "-c", "user.email=agent-hub@local.invalid",
        "commit-tree", resultTree, "-p", bootstrapCommit, "-p", snapshot.headCommit,
      ], {
        cwd: repoRoot,
        lease,
        input: "merge(agent-hub): integrate reviewed Task snapshot\n",
      });
      const currentDevCommit = await this.#runOwned(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], {
        cwd: repoRoot, lease,
      });
      if (currentDevCommit !== devHeadBefore) {
        throw new Error(`Task dev bootstrap dev changed from ${devHeadBefore} to ${currentDevCommit}`);
      }
      await this.#revalidateExplicitUpstreamAdoption(adoptionReceipt, lease);
      const recoveryFile = this.#devBootstrapRecoveryFile(repoRoot);
      const recovery = {
        version: 1,
        repositoryRoot: repoRoot,
        devRoot,
        devBranch: this.devBranch,
        oldDevCommit: devHeadBefore,
        mainCommit,
        snapshotCommit: snapshot.headCommit,
        bootstrapProofCommit: proof.commit,
        bootstrapCommit,
        bootstrapTree,
        integrationCommit,
        resultTree,
        createdAt: new Date().toISOString(),
      };
      await mkdir(path.dirname(recoveryFile), { recursive: true });
      await writeFile(recoveryFile, `${JSON.stringify(recovery, null, 2)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      await this.#runOwned([
        "update-ref", `refs/heads/${this.devBranch}`, integrationCommit, devHeadBefore,
      ], { cwd: repoRoot, lease });
      await this.#runOwned(["reset", "--hard", integrationCommit], { cwd: devRoot, lease });
      const finalStatus = await this.#runOwned([
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
      ], { cwd: devRoot, lease });
      if (finalStatus) throw new Error("Task dev bootstrap published a dirty managed dev worktree");
      await unlink(recoveryFile);
      return {
        status: "bootstrap_merged",
        integrated: true,
        snapshotIntegrated: true,
        repositoryRoot: repoRoot,
        projectRoot: devRoot,
        branch: this.devBranch,
        mainCommit,
        devHeadBefore,
        bootstrapCommit,
        headCommit: integrationCommit,
        conflicts,
      };
    } catch (error) {
      if (error?.processTreeStopped === false) throw error;
      if (mergeActive) {
        await this.#runOwned(["merge", "--abort"], { cwd: devRoot, lease });
        mergeActive = false;
      }
      const recovered = await this.#recoverDevBootstrapTransaction(repoRoot, devRoot, lease);
      if (recovered?.recovered) {
        return {
          status: "bootstrap_merged",
          integrated: true,
          snapshotIntegrated: true,
          recovered: true,
          repositoryRoot: repoRoot,
          projectRoot: devRoot,
          branch: this.devBranch,
          mainCommit,
          devHeadBefore,
          bootstrapCommit: recovered.record.bootstrapCommit,
          headCommit: recovered.record.integrationCommit,
          conflicts,
        };
      }
      await restore();
      return {
        status: conflicts.length ? "conflict" : "manual_required",
        integrated: false,
        repositoryRoot: repoRoot,
        projectRoot: devRoot,
        branch: this.devBranch,
        mainCommit,
        devHeadBefore,
        headCommit: devHeadBefore,
        conflicts,
        reason: error.message,
      };
    }
  }

  async #processGuards(taskId) {
    const directory = this.#processGuardDirectory(taskId);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(directory, entry.name));
  }

  async #assertNoProcessTreeGuard(taskId) {
    const guards = await this.#processGuards(taskId);
    if (guards.length) {
      throw new Error(`Task Git admission blocked: unresolved process-tree guard requires operator proof (${guards[0]})`);
    }
  }

  async #assertRepositoryProcessTreeClear(repositoryRootValue) {
    const root = path.join(this.dataDir, "task-process-tree-guards");
    const taskDirectories = await readdir(root, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const taskDirectory of taskDirectories.filter((entry) => entry.isDirectory())) {
      for (const file of await this.#processGuards(taskDirectory.name)) {
        const guard = await readFile(file, "utf8").then(JSON.parse, () => null);
        if (guard?.scope !== "task" && guard?.repositoryRoot && samePath(guard.repositoryRoot, repositoryRootValue)) {
          const error = new Error(`${CLAIM_REPOSITORY_GUARD_ERROR_PREFIX} (${file})`);
          error.code = "TASK_GIT_REPOSITORY_GUARD_ADMISSION_NO_EFFECT";
          error.taskGitAdmission = {
            version: CLAIM_REPOSITORY_GUARD_NO_EFFECT_VERSION,
            repositoryRoot: canonicalPath(repositoryRootValue),
            guardPath: canonicalPath(file),
          };
          throw error;
        }
      }
    }
  }

  async #beginProcessTreeGuard(taskId, lease, { args, cwd, scope = "repository" } = {}, state) {
    if (typeof lease?.assertOwned !== "function") throw new Error("Task Git guard owner lease is required");
    await lease.assertOwned();
    if (state.unresolved) throw state.unresolved;
    const repositoryRoot = await repositoryIdentityFromPath(cwd);
    const guardId = randomUUID();
    const file = path.join(
      this.#processGuardDirectory(taskId),
      `${taskRepositoryKey(repositoryRoot)}.json`,
    );
    await mkdir(path.dirname(file), { recursive: true });
    const record = {
      version: 1,
      taskId: normalizedTaskId(taskId),
      guardId,
      ownerId: String(lease.ownerId ?? "unknown"),
      command: Array.isArray(args) ? args.map(String) : [],
      scope,
      cwd: canonicalPath(cwd),
      repositoryRoot,
      createdAt: new Date().toISOString(),
    };
    try {
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(`Task Git admission blocked: unresolved process-tree guard requires operator proof (${file})`);
      }
      throw error;
    }
    let cleared = false;
    return {
      clear: async ({ proof } = {}) => {
        if (cleared) return;
        const current = await readFile(file, "utf8").then(JSON.parse, () => null);
        if (current?.guardId !== guardId) {
          state.unresolved = new Error(`Task Git process-tree guard ownership changed (${file})`);
          throw state.unresolved;
        }
        await unlink(file);
        cleared = true;
        state.active = null;
        state.lastProof = String(proof ?? "");
      },
      markUnresolved: (error) => {
        state.unresolved = new Error(
          `Task Git process-tree completion is unproven; operator proof required: ${error?.message ?? error}`,
        );
      },
    };
  }

  async withTaskLock(taskId, operation, options = {}) {
    this.#assertAvailable("withTaskLock");
    return withInterprocessLocks([this.#taskLock(taskId)], async (lease) => {
      await this.#assertNoProcessTreeGuard(taskId);
      return operation(this.#guardedLease(taskId, lease));
    }, options);
  }

  async withTaskLocks(taskIds, operation, { guardTaskId = null, ...options } = {}) {
    this.#assertAvailable("withTaskLocks");
    const ids = [...new Set((taskIds ?? []).map(normalizedTaskId))].sort();
    if (!ids.length) throw new Error("Task Git lock set is required");
    const guardedTaskId = normalizedTaskId(guardTaskId ?? ids[0]);
    if (!ids.includes(guardedTaskId)) throw new Error("Task Git guard owner must be in the lock set");
    return withInterprocessLocks(ids.map((taskId) => this.#taskLock(taskId)), async (lease) => {
      for (const taskId of ids) await this.#assertNoProcessTreeGuard(taskId);
      return operation(this.#guardedLease(guardedTaskId, lease));
    }, options);
  }

  async withTaskRecoveryLock(taskId, operation, options = {}) {
    this.#assertAvailable("withTaskRecoveryLock");
    return withInterprocessLocks(
      [this.#taskLock(taskId)],
      (lease) => operation(this.#guardedLease(taskId, lease)),
      options,
    );
  }

  async withTaskRepositoryRecoveryLock(taskId, repositoryRoot, taskLease, operation) {
    this.#assertAvailable("withTaskRepositoryRecoveryLock");
    await requiredGuardLease(taskLease).assertOwned();
    return this.#withDevLock(canonicalPath(repositoryRoot), taskLease, operation);
  }

  #guardedLease(scopeId, lease) {
    const id = normalizedTaskId(scopeId);
    const state = { unresolved: null, active: null, lastProof: null };
    return {
      ...lease,
      taskId: id,
      assertOwned: async () => {
        await lease.assertOwned();
        if (state.unresolved) throw state.unresolved;
      },
      beginProcessTreeGuard: (context) => this.#beginProcessTreeGuard(id, lease, context, state),
    };
  }

  async #withDevLock(repoRoot, outerLease, operation) {
    const repoKey = taskRepositoryKey(repoRoot);
    if (outerLease?.repositoryLockKeys?.has?.(repoKey)) {
      await outerLease.assertOwned();
      return operation(outerLease);
    }
    const devLock = path.join(this.dataDir, "locks", `task-git-dev-${repoKey}`);
    return withInterprocessLocks([devLock], async (devLease) => {
      const lease = outerLease
        ? combinedLease(outerLease, devLease, { repositoryKey: repoKey })
        : this.#guardedLease(`repository-${repoKey}`, devLease);
      if (!outerLease) lease.repositoryLockKeys = new Set([repoKey]);
      return operation(lease);
    });
  }

  async assertNoProcessTreeGuardOwned(taskId, { lease } = {}) {
    this.#assertAvailable("assertNoProcessTreeGuardOwned");
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(taskId);
  }

  async withTaskRecoveryLocks(taskIds, operation, { guardTaskId = null, ...options } = {}) {
    this.#assertAvailable("withTaskRecoveryLocks");
    const ids = [...new Set((taskIds ?? []).map(normalizedTaskId))].sort();
    if (!ids.length) throw new Error("Task Git recovery lock set is required");
    const guardedTaskId = normalizedTaskId(guardTaskId ?? ids[0]);
    if (!ids.includes(guardedTaskId)) throw new Error("Task Git recovery guard owner must be in the lock set");
    return withInterprocessLocks(
      ids.map((taskId) => this.#taskLock(taskId)),
      (lease) => operation(this.#guardedLease(guardedTaskId, lease)),
      options,
    );
  }

  async #withClearDevLock(repoRoot, outerLease, operation) {
    const repositoryRootValue = canonicalPath(repoRoot);
    return this.#withDevLock(repositoryRootValue, outerLease, async (lease) => {
      await this.#assertRepositoryProcessTreeClear(repositoryRootValue);
      return operation(lease);
    });
  }

  async claimAdmissionNoEffectEvidence({ taskId, projectRoot, error } = {}) {
    const id = normalizedTaskId(taskId);
    const repositoryRootValue = await repositoryIdentityFromPath(projectRoot);
    const message = String(error?.message ?? error ?? "");
    const currentPrefix = `${CLAIM_REPOSITORY_GUARD_ERROR_PREFIX} (`;
    const legacyPrefix = `mutation effect is not authoritatively disproved: ${currentPrefix}`;
    const prefix = message.startsWith(legacyPrefix) ? legacyPrefix : currentPrefix;
    if (!message.startsWith(prefix) || !message.endsWith(")")) return null;
    const guardPath = canonicalPath(message.slice(prefix.length, -1));
    const guardsRoot = canonicalPath(path.join(this.dataDir, "task-process-tree-guards"));
    if (!pathInside(guardsRoot, guardPath)) return null;
    const relative = path.relative(guardsRoot, guardPath);
    const segments = relative.split(path.sep);
    const repositoryKey = taskRepositoryKey(repositoryRootValue);
    if (segments.length !== 2
      || normalizedTaskId(segments[0]) === id
      || segments[1] !== `${repositoryKey}.json`) return null;
    if (error instanceof Error) {
      if (error.code !== "TASK_GIT_REPOSITORY_GUARD_ADMISSION_NO_EFFECT") return null;
      const admission = error.taskGitAdmission;
      if (admission?.version !== CLAIM_REPOSITORY_GUARD_NO_EFFECT_VERSION
        || !samePath(admission.repositoryRoot, repositoryRootValue)
        || !samePath(admission.guardPath, guardPath)) return null;
    } else if (prefix !== legacyPrefix) {
      return null;
    }
    return {
      version: prefix === legacyPrefix
        ? LEGACY_CLAIM_REPOSITORY_GUARD_NO_EFFECT_VERSION
        : CLAIM_REPOSITORY_GUARD_NO_EFFECT_VERSION,
      taskId: id,
      repositoryRoot: repositoryRootValue,
      repositoryKey,
      guardTaskId: normalizedTaskId(segments[0]),
      guardPath,
    };
  }

  async recoverProcessTreeGuard(taskId, {
    repositoryRoot: root, guardId, proof, lease = null,
  } = {}) {
    this.#assertAvailable("recoverProcessTreeGuard");
    const repositoryRoot = canonicalPath(root);
    const recover = async (ownedLease) => this.#withDevLock(repositoryRoot, ownedLease, async (combined) => {
      await combined.assertOwned();
      const file = path.join(
        this.#processGuardDirectory(taskId),
        `${taskRepositoryKey(repositoryRoot)}.json`,
      );
      const recoveryFile = this.#processRecoveryFile(taskId, guardId);
      const guard = await readFile(file, "utf8").then(JSON.parse, (error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      const priorRecovery = await readFile(recoveryFile, "utf8").then(JSON.parse, (error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      const exactPriorRecovery = () => {
        const guardCreatedAtMs = Date.parse(String(priorRecovery?.proof?.guardCreatedAt ?? ""));
        const storedGuardCreatedAtMs = Date.parse(String(priorRecovery?.guard?.createdAt ?? ""));
        const bootTimeMs = Date.parse(String(priorRecovery?.proof?.systemBootTime ?? ""));
        const verifiedAtMs = Date.parse(String(priorRecovery?.proof?.verifiedAt ?? ""));
        const executablePath = String(priorRecovery?.proof?.executablePath ?? "").trim();
        const summary = String(priorRecovery?.proof?.summary ?? "").trim();
        const exactGuard = priorRecovery?.guard && (
          !guard || JSON.stringify(priorRecovery.guard) === JSON.stringify(guard)
        );
        return priorRecovery?.version === 1
          && priorRecovery.guardId === String(guardId ?? "").trim()
          && priorRecovery.taskId === normalizedTaskId(taskId)
          && samePath(priorRecovery.repositoryRoot, repositoryRoot)
          && exactGuard
          && priorRecovery.proof?.kind === "system-restart-after-guard"
          && priorRecovery.proof?.source === "Win32_OperatingSystem.LastBootUpTime"
          && Number.isFinite(guardCreatedAtMs)
          && Number.isFinite(storedGuardCreatedAtMs)
          && guardCreatedAtMs === storedGuardCreatedAtMs
          && Number.isFinite(bootTimeMs)
          && bootTimeMs > guardCreatedAtMs
          && Number.isFinite(verifiedAtMs)
          && summary.length > 0
          && summary.length <= 1_000
          && !summary.includes("\0")
          && isTrustedWindowsPowerShellPath(executablePath);
      };
      const finish = (recovery, reused) => ({
          recovered: true,
          reused,
          guard: recovery.guard,
          proof: recovery.proof,
      });
      if (!guard) {
        if (!exactPriorRecovery()) {
          throw new Error("Task Git process-tree recovery evidence does not match the recovery request");
        }
        return finish(priorRecovery, true);
      }
      if (
        !guard?.guardId
        || guard.guardId !== String(guardId ?? "").trim()
        || guard.taskId !== normalizedTaskId(taskId)
        || !samePath(guard.repositoryRoot, repositoryRoot)
      ) {
        throw new Error("Task Git process-tree guard identity does not match the recovery request");
      }
      if (priorRecovery) {
        if (!exactPriorRecovery()) {
          throw new Error("Task Git process-tree recovery evidence identity changed");
        }
        await combined.assertOwned();
        await this.removeProcessGuard(file);
        return finish(priorRecovery, true);
      }
      if (proof?.kind !== "system-restart-after-guard" || proof?.confirmed !== true) {
        throw new Error("Task Git guard recovery requires a trusted system restart after guard creation");
      }
      const summary = String(proof?.summary ?? "").trim();
      if (!summary || summary.length > 1_000 || summary.includes("\0")) {
        throw new Error("Task Git guard recovery requires bounded operator evidence");
      }
      const guardCreatedAtMs = Date.parse(String(guard.createdAt ?? ""));
      const bootIdentity = await this.readSystemBootIdentity();
      const bootTimeMs = Date.parse(String(bootIdentity?.bootTime ?? ""));
      if (!Number.isFinite(guardCreatedAtMs) || !Number.isFinite(bootTimeMs) || bootTimeMs <= guardCreatedAtMs) {
        throw new Error("Task Git guard recovery rejected: system boot does not postdate the guarded process tree");
      }
      if (bootIdentity?.source !== "Win32_OperatingSystem.LastBootUpTime") {
        throw new Error("Task Git guard recovery rejected: trusted Windows boot identity is unavailable");
      }
      const executablePath = String(bootIdentity?.executablePath ?? "").trim();
      if (!isTrustedWindowsPowerShellPath(executablePath)) {
        throw new Error("Task Git guard recovery rejected: trusted Windows boot executable identity is unavailable");
      }
      await combined.assertOwned();
      const recovery = {
        version: 1,
        taskId: normalizedTaskId(taskId),
        guardId: guard.guardId,
        repositoryRoot,
        guard,
        proof: {
          kind: proof.kind,
          source: bootIdentity.source,
          executablePath,
          summary,
          guardCreatedAt: new Date(guardCreatedAtMs).toISOString(),
          systemBootTime: new Date(bootTimeMs).toISOString(),
          verifiedAt: new Date().toISOString(),
        },
      };
      await mkdir(path.dirname(recoveryFile), { recursive: true });
      try {
        await writeFile(recoveryFile, `${JSON.stringify(recovery, null, 2)}\n`, {
          encoding: "utf8", flag: "wx", mode: 0o600,
        });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (!exactPriorRecovery()) {
          throw new Error("Task Git process-tree recovery evidence identity changed");
        }
        await combined.assertOwned();
        await this.removeProcessGuard(file);
        return finish(priorRecovery, true);
      }
      await combined.assertOwned();
      await this.removeProcessGuard(file);
      return finish(recovery, false);
    });
    return lease
      ? recover(lease)
      : this.withTaskRecoveryLock(taskId, recover);
  }

  async #integrationBlockFile(repoRoot) {
    return path.join(this.dataDir, "integration-blocks", `${taskRepositoryKey(repoRoot)}.json`);
  }

  async #assertRecoverableDev(repoRoot, devRoot, { lease = null } = {}) {
    await requiredGuardLease(lease).assertOwned();
    const withdrawal = await readFile(this.#withdrawalFile(repoRoot), "utf8").then(JSON.parse, (error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (withdrawal) throw new Error(`dev withdrawal ${withdrawal.operationId} requires exact lifecycle reconciliation`);
    await this.#recoverDevBootstrapTransaction(repoRoot, devRoot, lease);
    const blockFile = await this.#integrationBlockFile(repoRoot);
    const priorBlock = await readFile(blockFile, "utf8").then(JSON.parse, () => null);
    if (priorBlock?.processTreeStopUnproven === true) {
      throw new Error(`dev integration is blocked: process-tree termination requires operator proof (${devRoot})`);
    }
    const gitPath = async (name) => path.resolve(await runGit(["rev-parse", "--git-path", name], { cwd: devRoot }));
    const mergeHead = await gitPath("MERGE_HEAD");
    const indexLock = await gitPath("index.lock");
    const hasMerge = await access(mergeHead).then(() => true, () => false);
    const hasIndexLock = await access(indexLock).then(() => true, () => false);
    if (hasMerge) {
      await lease.assertOwned();
      const aborted = await this.#runOwned(["merge", "--abort"], { cwd: devRoot, lease }).then(
        () => true,
        () => false,
      );
      await lease.assertOwned();
      if (!aborted) {
        await mkdir(path.dirname(blockFile), { recursive: true });
        await writeFile(blockFile, `${JSON.stringify({
          repositoryRoot: repoRoot, devRoot, reason: "merge --abort failed", observedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
        throw new Error(`dev integration is blocked: merge --abort failed (${devRoot})`);
      }
    }
    if (hasIndexLock) {
      await mkdir(path.dirname(blockFile), { recursive: true });
      await writeFile(blockFile, `${JSON.stringify({
        repositoryRoot: repoRoot, devRoot, reason: "index.lock exists", observedAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      throw new Error(`dev integration is blocked: stale index.lock requires operator recovery (${indexLock})`);
    }
    const dirty = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: devRoot });
    if (dirty) {
      await mkdir(path.dirname(blockFile), { recursive: true });
      await writeFile(blockFile, `${JSON.stringify({
        repositoryRoot: repoRoot, devRoot, reason: "dirty dev integration worktree", observedAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      throw new Error(`dev integration is blocked: dirty index/worktree (${devRoot})`);
    }
    await unlink(blockFile).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }

  async #ensureBranchWorktree({
    repositoryRoot: repoRoot,
    branch,
    worktreeRoot,
    startCommit,
    managedRoot,
    noCheckout = false, lease = null,
  }) {
    const existing = await worktreeForBranch(repoRoot, branch);
    if (existing) {
      if (!pathInside(managedRoot, existing)) {
        throw new Error(`Agent Hub branch ${branch} is checked out outside its managed worktree: ${existing}`);
      }
      return { root: canonicalPath(existing), created: false };
    }
    await mkdir(path.dirname(worktreeRoot), { recursive: true });
    const exists = await branchExists(repoRoot, branch);
    await this.#runOwned([
      "worktree", "add",
      ...(noCheckout ? ["--no-checkout"] : []),
      ...(exists ? [] : ["-b", branch]),
      worktreeRoot,
      ...(exists ? [branch] : [startCommit]),
    ], { cwd: repoRoot, timeoutMs: 120_000, lease });
    return { root: canonicalPath(worktreeRoot), created: true };
  }

  async #ensureSparseTaskWorktree({ taskId, worktreeRoot: root, selection, created, lease = null }) {
    const expectedPatterns = selection.patterns.join("\n");
    if (!created) {
      await assertNoTaskChangelogChanges(root);
      const changelogPaths = (await runGit(["ls-files", "-z", "--", ":(glob)**/CHANGELOG.md"], {
        cwd: root,
      })).split("\0").filter(Boolean);
      const materializedChangelog = (await Promise.all(changelogPaths.map((name) => (
        access(path.resolve(root, name)).then(() => true, () => false)
      )))).some(Boolean);
      const configured = await gitMaybe(["sparse-checkout", "list"], { cwd: root });
      const cone = await gitMaybe(["config", "--bool", "core.sparseCheckoutCone"], { cwd: root });
      if (!materializedChangelog && configured === expectedPatterns && cone === String(selection.cone)) {
        const mergePath = path.resolve(await runGit(["rev-parse", "--git-path", "MERGE_HEAD"], { cwd: root }));
        const mergeHead = await readFile(mergePath, "utf8").then((value) => value.trim(), () => null);
        if (mergeHead && !await this.#isTaskMergeParent(taskId, root, mergeHead)) {
          throw new Error("Task snapshot has a merge parent other than the exact managed dev head");
        }
        return;
      }
    }
    const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
    const [branchBefore, headBefore, statusBefore] = await Promise.all([
      runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }),
      runGit(["rev-parse", "HEAD^{commit}"], { cwd: root }),
      runGit(statusArgs, { cwd: root }),
    ]);
    const mergeHeadPath = path.resolve(await runGit(["rev-parse", "--git-path", "MERGE_HEAD"], { cwd: root }));
    const mergeHead = await readFile(mergeHeadPath, "utf8").then((value) => value.trim(), () => null);
    if (!created && mergeHead) {
      if (!await this.#isTaskMergeParent(taskId, root, mergeHead)) {
        throw new Error("Task snapshot has a merge parent other than the exact managed dev head");
      }
      const configured = await runGit(["sparse-checkout", "list"], { cwd: root });
      const cone = await gitMaybe(["config", "--bool", "core.sparseCheckoutCone"], { cwd: root });
      const legacyScope = cone === "true" && configured === selection.scope;
      if (configured !== expectedPatterns && !legacyScope) {
        throw new Error(`Task sparse-checkout scope mismatch: expected ${selection.scope}, got ${configured || "<empty>"}`);
      }
      return;
    }
    await this.#runOwned([
      "sparse-checkout", "set", "--no-cone", "--stdin",
    ], {
      cwd: root,
      input: `${expectedPatterns}\n`,
      timeoutMs: 120_000, lease,
    });
    if (created) await this.#runOwned(["checkout"], { cwd: root, timeoutMs: 120_000, lease });
    const [branchAfter, headAfter, statusAfter, configured] = await Promise.all([
      runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }),
      runGit(["rev-parse", "HEAD^{commit}"], { cwd: root }),
      runGit(statusArgs, { cwd: root }),
      runGit(["sparse-checkout", "list"], { cwd: root }),
    ]);
    if (branchAfter !== branchBefore || headAfter !== headBefore) {
      throw new Error("Task sparse-checkout changed its branch or HEAD");
    }
    if (!created && statusAfter !== statusBefore) {
      throw new Error("Task sparse-checkout changed existing dirty worktree state");
    }
    if (created && statusAfter) {
      throw new Error("New Task sparse worktree is not clean");
    }
    if (configured !== expectedPatterns) {
      throw new Error(`Task sparse-checkout scope mismatch: expected ${selection.scope}, got ${configured || "<empty>"}`);
    }
  }

  async #alignExistingTaskBranch({ repositoryRoot: repoRoot, worktreeRoot: root, branch, lease = null }) {
    const registered = parseWorktrees(await runGit(["worktree", "list", "--porcelain"], { cwd: repoRoot }))
      .find((item) => samePath(item.path, root));
    if (!registered) return;
    const currentBranch = await runGit(["branch", "--show-current"], { cwd: root });
    if (currentBranch === branch) return;
    if (await branchExists(repoRoot, branch)) throw new Error(`Task branch already exists: ${branch}`);
    await this.#runOwned(["branch", "-m", branch], { cwd: root, lease });
  }

  async #prepareDevOwned(projectRoot, repoRoot, lease, { allowUnadoptedLocalMain = false } = {}) {
    await requiredGuardLease(lease).assertOwned();
    const mainCommit = await localMainCommit(repoRoot);
    const repoKey = taskRepositoryKey(repoRoot);
    const { root: devRoot } = await this.#ensureBranchWorktree({
      repositoryRoot: repoRoot,
      branch: this.devBranch,
      worktreeRoot: path.join(this.devWorktreesRoot, repoKey),
      managedRoot: this.devWorktreesRoot,
      startCommit: mainCommit,
      lease,
    });
    await this.#assertRecoverableDev(repoRoot, devRoot, { lease });
    await lease.assertOwned();
    const headCommit = await this.#runOwned(["rev-parse", "HEAD^{commit}"], { cwd: devRoot, lease });
    const containsAcceptedMain = await gitMaybe([
      "merge-base", "--is-ancestor", mainCommit, headCommit,
    ], { cwd: devRoot }) !== null;
    if (!containsAcceptedMain && !allowUnadoptedLocalMain) {
      throw new Error(
        `managed dev ${headCommit} does not contain accepted local main ${mainCommit}; explicit adoption required`,
      );
    }
    return {
      repositoryRoot: repoRoot,
      projectRoot: devRoot,
      branch: this.devBranch,
      mainCommit,
      acceptedMainIntegrated: containsAcceptedMain,
      headCommit,
    };
  }

  async #isOtherTaskHead(taskId, repoRoot, commit, localMain, lease, visiting = new Set()) {
    if (visiting.has(commit)) return false;
    visiting = new Set([...visiting, commit]);
    const listing = await runGit(["worktree", "list", "--porcelain"], { cwd: repoRoot });
    for (const record of listing.split("\n\n")) {
      const root = /^worktree (.+)$/mu.exec(record)?.[1];
      const head = /^HEAD ([a-f0-9]{40})$/mu.exec(record)?.[1];
      if (!root || head !== commit || !pathInside(this.taskWorktreesRoot, root)) continue;
      const relative = path.relative(this.taskWorktreesRoot, root).split(path.sep);
      if (relative.length !== 2 || relative[0] === taskId || relative[1] !== taskRepositoryKey(repoRoot)) continue;
      const owner = normalizedTaskId(relative[0]);
      const base = await gitMaybe(["rev-parse", "--verify", `${taskBaseRef(owner, relative[1])}^{commit}`], { cwd: repoRoot });
      if (!base || !await this.managedRepositoryRoot(root, {
        taskId: owner, taskNumber: /^branch refs\/heads\/(.+)$/mu.exec(record)?.[1],
      })) continue;
      const merges = String(await runGit([
        "log", "--first-parent", "--merges", "--format=%H %P",
        `--max-count=${MAX_UPSTREAM_ADOPTION_PROOFS + 1}`, commit, `^${base}`, `^${localMain}`,
      ], { cwd: repoRoot })).split(/\r?\n/u).filter(Boolean);
      if (merges.length > MAX_UPSTREAM_ADOPTION_PROOFS) throw new Error("Sibling Task merge history exceeds the bounded proof");
      for (const merge of merges) {
        const [, , ...sides] = merge.split(" ");
        for (const side of sides) {
          if (await gitMaybe(["merge-base", "--is-ancestor", side, localMain], { cwd: repoRoot }) !== null) continue;
          if (await this.#isOtherTaskHead(owner, repoRoot, side, localMain, lease, visiting)) continue;
          const adoption = await this.#recordedUpstreamAdoptionForSnapshot({
            taskId: owner, repoRoot, snapshotCommit: commit, localMain, lease,
          });
          if (adoption?.record?.adoptedCommit !== side) {
            throw new Error("Sibling Task contains an unapproved upstream or dev merge");
          }
        }
      }
      return true;
    }
    return false;
  }

  async #snapshotUpstreamAdoptionProof({
    taskId, taskNumber = null, repoRoot, branch = null, baseCommit, snapshotCommit,
    localMain, adoptedCommit = null, devCommit = null, lease,
  }) {
    const id = normalizedTaskId(taskId);
    const repoKey = taskRepositoryKey(repoRoot);
    const exactBase = exactCommitId(baseCommit, "Task base commit");
    const exactSnapshot = exactCommitId(snapshotCommit, "Task snapshot commit");
    const acceptedLocalMain = exactCommitId(localMain, "accepted local main");
    const expectedAdopted = adoptedCommit == null
      ? null
      : exactCommitId(adoptedCommit, "adopted upstream commit");
    const expectedBranch = String(branch ?? "").trim() || taskBranchName(id, repoRoot, taskNumber);
    const branchRef = `refs/heads/${expectedBranch}`;
    const observedMain = await this.#runOwned([
      "rev-parse", "--verify", "refs/heads/main^{commit}",
    ], { cwd: repoRoot, lease });
    const observedBase = await this.#runOwned([
      "rev-parse", "--verify", `${taskBaseRef(id, repoKey)}^{commit}`,
    ], { cwd: repoRoot, lease });
    const observedSnapshot = await this.#runOwned([
      "rev-parse", "--verify", `${branchRef}^{commit}`,
    ], { cwd: repoRoot, lease });
    if (observedMain !== acceptedLocalMain) {
      throw new Error(`accepted local main changed from ${acceptedLocalMain} to ${observedMain}`);
    }
    if (observedBase !== exactBase) throw new Error("explicit upstream adoption Task base changed");
    if (observedSnapshot !== exactSnapshot) throw new Error("explicit upstream adoption Task snapshot changed");
    const history = String(await this.#runOwned([
      "rev-list", "--first-parent", "--merges",
      `--max-count=${MAX_UPSTREAM_ADOPTION_PROOFS + 1}`, exactSnapshot, `^${exactBase}`,
    ], { cwd: repoRoot, lease })).split(/\r?\n/u).filter(Boolean);
    if (history.length > MAX_UPSTREAM_ADOPTION_PROOFS) {
      throw new Error("explicit upstream adoption proof exceeds the bounded first-parent history");
    }
    const proofs = [];
    for (const commit of history) {
      const parents = String(await this.#runOwned([
        "rev-list", "--parents", "-n", "1", commit,
      ], { cwd: repoRoot, lease })).split(/\s+/u).filter(Boolean);
      if (parents.length < 3) continue;
      for (let index = 2; index < parents.length; index += 1) {
        const candidate = parents[index];
        if (candidate === acceptedLocalMain) continue;
        const extendsAcceptedMain = await gitMaybe([
          "merge-base", "--is-ancestor", acceptedLocalMain, candidate,
        ], { cwd: repoRoot }) !== null;
        if (!extendsAcceptedMain) continue;
        if (expectedAdopted && candidate !== expectedAdopted) continue;
        if (!expectedAdopted && await this.#isOtherTaskHead(id, repoRoot, candidate, acceptedLocalMain, lease)) continue;
        if (!expectedAdopted && devCommit && await gitMaybe([
          "merge-base", "--is-ancestor", candidate, devCommit,
        ], { cwd: repoRoot }) !== null) continue;
        if (parents.length !== 3 || index !== 2) {
          throw new Error(`Task snapshot has invalid explicit upstream adoption at ${commit}`);
        }
        proofs.push({ commit, firstParent: parents[1], candidate });
      }
    }
    if (proofs.length !== 1) {
      throw new Error(proofs.length
        ? `Task snapshot has ambiguous explicit upstream adoption: ${proofs
          .map(({ commit, candidate }) => `${commit}:${candidate}`).join(", ")}`
        : "Task snapshot has no explicit upstream adoption proof");
    }
    const proof = proofs[0];
    if (expectedAdopted && proof.candidate !== expectedAdopted) {
      throw new Error(`Task snapshot adoption ${proof.candidate} does not match approved upstream ${expectedAdopted}`);
    }
    const snapshotTree = await this.#runOwned([
      "rev-parse", `${exactSnapshot}^{tree}`,
    ], { cwd: repoRoot, lease });
    const proofTree = await this.#runOwned([
      "rev-parse", `${proof.commit}^{tree}`,
    ], { cwd: repoRoot, lease });
    return {
      taskId: id,
      repositoryRoot: repoRoot,
      repositoryKey: repoKey,
      branch: expectedBranch,
      branchRef,
      taskBaseCommit: exactBase,
      acceptedLocalMainCommit: acceptedLocalMain,
      adoptedCommit: proof.candidate,
      snapshotCommit: exactSnapshot,
      snapshotTree,
      proofCommit: proof.commit,
      proofParents: [proof.firstParent, proof.candidate],
      proofTree,
    };
  }

  #upstreamAdoptionRecord(proof, requestId) {
    return {
      version: 1,
      kind: "task-upstream-adoption",
      requestId: exactRequestId(requestId),
      taskId: proof.taskId,
      repositoryRoot: proof.repositoryRoot,
      repositoryKey: proof.repositoryKey,
      branch: proof.branch,
      taskBaseCommit: proof.taskBaseCommit,
      acceptedLocalMainCommit: proof.acceptedLocalMainCommit,
      adoptedCommit: proof.adoptedCommit,
      snapshotCommit: proof.snapshotCommit,
      snapshotTree: proof.snapshotTree,
      proofCommit: proof.proofCommit,
      proofParents: proof.proofParents,
      proofTree: proof.proofTree,
    };
  }

  async #previewExplicitUpstreamAdoptionOwned(input, { lease, write = false } = {}) {
    const repoRoot = await repositoryRoot(input.projectRoot);
    const proof = await this.#snapshotUpstreamAdoptionProof({
      taskId: input.taskId,
      taskNumber: input.taskNumber,
      repoRoot,
      branch: input.branch,
      baseCommit: input.taskBaseCommit,
      snapshotCommit: input.snapshotCommit,
      localMain: input.acceptedLocalMainCommit,
      adoptedCommit: input.adoptedCommit,
      lease,
    });
    const record = this.#upstreamAdoptionRecord(proof, input.requestId);
    const content = `${JSON.stringify(record)}\n`;
    const recordHash = await this.#runOwned([
      "hash-object", ...(write ? ["-w"] : []), "--stdin",
    ], { cwd: repoRoot, input: content, lease });
    const recordRef = taskUpstreamAdoptionRef(
      proof.taskId, proof.repositoryKey, proof.snapshotCommit, proof.adoptedCommit,
    );
    if (write) {
      const existing = await gitMaybe(["rev-parse", "--verify", recordRef], { cwd: repoRoot });
      if (existing && existing !== recordHash) {
        throw new Error(`explicit upstream adoption receipt ${recordRef} already has different content`);
      }
      if (!existing) {
        await this.#runOwned(["update-ref", "--stdin"], {
          cwd: repoRoot,
          input: `start\nverify refs/heads/main ${proof.acceptedLocalMainCommit}\nverify ${taskBaseRef(proof.taskId, proof.repositoryKey)} ${proof.taskBaseCommit}\nverify ${proof.branchRef} ${proof.snapshotCommit}\ncreate ${recordRef} ${recordHash}\nprepare\ncommit\n`,
          lease,
        });
      }
    }
    return { status: write ? "adopted" : "preview", recordRef, recordHash, record };
  }

  async previewExplicitUpstreamAdoption(input = {}) {
    this.#assertAvailable("previewExplicitUpstreamAdoption");
    return this.withTaskLock(input.taskId, async (lease) => {
      const repoRoot = await repositoryRoot(input.projectRoot);
      return this.#withClearDevLock(repoRoot, lease, (ownedLease) => (
        this.#previewExplicitUpstreamAdoptionOwned(input, { lease: ownedLease })
      ));
    });
  }

  async recordExplicitUpstreamAdoption(input = {}) {
    this.#assertAvailable("recordExplicitUpstreamAdoption");
    return this.withTaskLock(input.taskId, async (lease) => {
      const repoRoot = await repositoryRoot(input.projectRoot);
      return this.#withClearDevLock(repoRoot, lease, (ownedLease) => (
        this.#previewExplicitUpstreamAdoptionOwned(input, { lease: ownedLease, write: true })
      ));
    });
  }

  async #requireExplicitUpstreamAdoption({
    taskId, taskNumber = null, repoRoot, branch = null, baseCommit, snapshotCommit,
    localMain, adoptedCommit, lease,
  }) {
    const proof = await this.#snapshotUpstreamAdoptionProof({
      taskId, taskNumber, repoRoot, branch, baseCommit, snapshotCommit,
      localMain, adoptedCommit, lease,
    });
    const recordRef = taskUpstreamAdoptionRef(
      proof.taskId, proof.repositoryKey, proof.snapshotCommit, proof.adoptedCommit,
    );
    const recordHash = await this.#runOwned(["rev-parse", "--verify", recordRef], {
      cwd: repoRoot, lease,
    }).catch(() => {
      throw new Error(`approved upstream ${proof.adoptedCommit} requires a durable explicit adoption receipt`);
    });
    const type = await this.#runOwned(["cat-file", "-t", recordHash], { cwd: repoRoot, lease });
    if (type !== "blob") throw new Error("explicit upstream adoption receipt is not a Git blob");
    const content = await this.#runOwned(["cat-file", "-p", recordHash], { cwd: repoRoot, lease });
    let record;
    try {
      record = JSON.parse(content);
    } catch {
      throw new Error("explicit upstream adoption receipt is invalid JSON");
    }
    const expected = this.#upstreamAdoptionRecord(proof, record?.requestId);
    if (JSON.stringify(record) !== JSON.stringify(expected)) {
      throw new Error("explicit upstream adoption receipt identity changed");
    }
    const verifiedHash = await this.#runOwned(["hash-object", "--stdin"], {
      cwd: repoRoot, input: `${JSON.stringify(record)}\n`, lease,
    });
    if (verifiedHash !== recordHash) throw new Error("explicit upstream adoption receipt hash changed");
    return { recordRef, recordHash, record };
  }

  async #revalidateExplicitUpstreamAdoption(receipt, lease) {
    if (!receipt) return null;
    const record = receipt.record;
    const verified = await this.#requireExplicitUpstreamAdoption({
      taskId: record.taskId,
      repoRoot: record.repositoryRoot,
      branch: record.branch,
      baseCommit: record.taskBaseCommit,
      snapshotCommit: record.snapshotCommit,
      localMain: record.acceptedLocalMainCommit,
      adoptedCommit: record.adoptedCommit,
      lease,
    });
    if (verified.recordRef !== receipt.recordRef || verified.recordHash !== receipt.recordHash) {
      throw new Error("explicit upstream adoption receipt changed before dev publication");
    }
    return verified;
  }

  async #recordedUpstreamAdoptionForSnapshot({ taskId, repoRoot, snapshotCommit, localMain, lease, publishedBaseCommit = null }) {
    const id = normalizedTaskId(taskId);
    const repoKey = taskRepositoryKey(repoRoot);
    const exactSnapshot = exactCommitId(snapshotCommit, "Task snapshot commit");
    const prefix = `${taskUpstreamAdoptionPrefix(id, repoKey)}${exactSnapshot}/`;
    const records = String(await this.#runOwned([
      "for-each-ref", "--format=%(refname)%00%(objectname)", prefix,
    ], { cwd: repoRoot, lease })).split(/\r?\n/u).filter(Boolean);
    if (!records.length) return null;
    if (records.length !== 1) throw new Error("Task snapshot has ambiguous durable upstream adoption receipts");
    const [recordRef, recordHash] = records[0].split("\0");
    let record;
    try {
      record = JSON.parse(await this.#runOwned(["cat-file", "-p", recordHash], { cwd: repoRoot, lease }));
    } catch {
      throw new Error("explicit upstream adoption receipt is invalid");
    }
    if (record?.taskId !== id || record.repositoryKey !== repoKey || record.snapshotCommit !== exactSnapshot) {
      throw new Error("explicit upstream adoption receipt snapshot identity changed");
    }
    // Published history needs no new adoption authority. An old receipt cannot
    // block a remaining Task merely because publication advanced local main.
    if (publishedBaseCommit && await gitMaybe([
      "merge-base", "--is-ancestor", exactCommitId(record.adoptedCommit, "adopted upstream commit"), publishedBaseCommit,
    ], { cwd: repoRoot }) !== null) return null;
    const currentLocalMain = exactCommitId(localMain, "accepted local main");
    if (record.acceptedLocalMainCommit !== currentLocalMain) {
      throw new Error(
        `accepted local main changed from ${record.acceptedLocalMainCommit} to ${currentLocalMain}`,
      );
    }
    const verified = await this.#requireExplicitUpstreamAdoption({
      taskId: id,
      repoRoot,
      branch: record.branch,
      baseCommit: record.taskBaseCommit,
      snapshotCommit: exactSnapshot,
      localMain: record.acceptedLocalMainCommit,
      adoptedCommit: record.adoptedCommit,
      lease,
    });
    if (verified.recordRef !== recordRef || verified.recordHash !== recordHash) {
      throw new Error("explicit upstream adoption receipt ref identity changed");
    }
    return verified;
  }

  async #snapshotAdoptedMainCommit({ snapshot, repoRoot, localMain, devCommit, lease }) {
    try {
      const proof = await this.#snapshotUpstreamAdoptionProof({
        taskId: snapshot.taskId,
        taskNumber: snapshot.taskNumber,
        repoRoot,
        branch: snapshot.branch,
        baseCommit: snapshot.baseCommit,
        snapshotCommit: snapshot.headCommit,
        localMain,
        devCommit,
        lease,
      });
      return { mainCommit: proof.adoptedCommit, proof };
    } catch (error) {
      if (/has no explicit upstream adoption proof/u.test(error.message)) {
        return { mainCommit: localMain, proof: null };
      }
      throw error;
    }
  }

  async #synchronizeMainIntoDevOwned({
    repoRoot, expectedMainCommit = null, observedMainCommit = null, snapshotResolution = null,
    adoptionReceipt = null, lease,
  }) {
    await requiredGuardLease(lease).assertOwned();
    const repoKey = taskRepositoryKey(repoRoot);
    const requestedMain = String(observedMainCommit ?? expectedMainCommit ?? "").trim();
    if (!requestedMain) throw new Error("explicit main to dev synchronization requires an exact accepted revision");
    const mainCommit = await this.#runOwned([
      "rev-parse", "--verify", `${exactCommitId(requestedMain, "accepted main revision")}^{commit}`,
    ], { cwd: repoRoot, lease });
    const expected = String(expectedMainCommit ?? "").trim().toLowerCase();
    if (expected && mainCommit !== expected) {
      return {
        status: "manual_required",
        integrated: false,
        repositoryRoot: repoRoot,
        mainCommit,
        expectedMainCommit: expected,
        reason: `current main ${mainCommit} does not match published revision ${expected}`,
      };
    }
    const { root: devRoot } = await this.#ensureBranchWorktree({
      repositoryRoot: repoRoot,
      branch: this.devBranch,
      worktreeRoot: path.join(this.devWorktreesRoot, repoKey),
      managedRoot: this.devWorktreesRoot,
      startCommit: mainCommit,
      lease,
    });
    await this.#assertRecoverableDev(repoRoot, devRoot, { lease });
    const devHeadBefore = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: devRoot });
    const statusBefore = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: devRoot,
    });
    if (statusBefore) {
      return {
        status: "manual_required",
        integrated: false,
        repositoryRoot: repoRoot,
        projectRoot: devRoot,
        branch: this.devBranch,
        mainCommit,
        devHeadBefore,
        headCommit: devHeadBefore,
        reason: "managed dev worktree has uncommitted changes",
      };
    }
    const mainAlreadyIntegrated = await gitMaybe(["merge-base", "--is-ancestor", mainCommit, devHeadBefore], {
      cwd: devRoot,
    }) !== null;
    if (mainAlreadyIntegrated) {
      return {
        status: "already_current",
        integrated: true,
        repositoryRoot: repoRoot,
        projectRoot: devRoot,
        branch: this.devBranch,
        mainCommit,
        devHeadBefore,
        headCommit: devHeadBefore,
      };
    }
    const fastForward = await gitMaybe(["merge-base", "--is-ancestor", devHeadBefore, mainCommit], {
      cwd: devRoot,
    }) !== null;
    if (snapshotResolution && !fastForward) {
      return this.#bootstrapSnapshotIntoDevOwned({
        repoRoot,
        devRoot,
        devHeadBefore,
        mainCommit,
        snapshot: snapshotResolution,
        statusBefore,
        adoptionReceipt,
        lease,
      });
    }
    try {
      await lease.assertOwned();
      await this.#revalidateExplicitUpstreamAdoption(adoptionReceipt, lease);
      await this.#runOwned([
        "-c", "user.name=Agent Hub",
        "-c", "user.email=agent-hub@local.invalid",
        "merge", ...(fastForward ? ["--ff-only"] : ["--no-ff", "--no-edit"]), mainCommit,
      ], { cwd: devRoot, timeoutMs: 300_000, lease });
      await lease.assertOwned();
      const headCommit = await this.#runOwned(["rev-parse", "HEAD^{commit}"], { cwd: devRoot, lease });
      await this.#runOwned(["merge-base", "--is-ancestor", mainCommit, headCommit], { cwd: devRoot, lease });
      await this.#runOwned(["merge-base", "--is-ancestor", devHeadBefore, headCommit], { cwd: devRoot, lease });
      return {
        status: fastForward ? "fast_forwarded" : "merged",
        integrated: true,
        repositoryRoot: repoRoot,
        projectRoot: devRoot,
        branch: this.devBranch,
        mainCommit,
        devHeadBefore,
        headCommit,
      };
    } catch (error) {
      if (error?.processTreeStopped === false) {
        const blockFile = await this.#integrationBlockFile(repoRoot);
        await mkdir(path.dirname(blockFile), { recursive: true });
        await writeFile(blockFile, `${JSON.stringify({
          repositoryRoot: repoRoot,
          devRoot,
          reason: error.message,
          processTreeStopUnproven: true,
          observedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
        throw error;
      }
      const conflicts = String(await gitMaybe(["diff", "--name-only", "--diff-filter=U"], {
        cwd: devRoot,
      }) ?? "").split(/\r?\n/u).filter(Boolean);
      const aborted = await this.#runOwned(["merge", "--abort"], {
        cwd: devRoot, lease,
      }).then(() => true, () => false);
      await lease.assertOwned();
      const headCommit = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: devRoot });
      const statusAfter = await runGit([
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
      ], { cwd: devRoot });
      const mergeHead = path.resolve(await runGit(["rev-parse", "--git-path", "MERGE_HEAD"], { cwd: devRoot }));
      const mergeStillActive = await access(mergeHead).then(() => true, () => false);
      if (!aborted || mergeStillActive || headCommit !== devHeadBefore || statusAfter !== statusBefore) {
        throw new Error(`main to dev synchronization failed and could not restore dev ${devHeadBefore}: ${error.message}`);
      }
      return {
        status: conflicts.length ? "conflict" : "manual_required",
        integrated: false,
        repositoryRoot: repoRoot,
        projectRoot: devRoot,
        branch: this.devBranch,
        mainCommit,
        devHeadBefore,
        headCommit,
        conflicts,
        reason: error.message,
      };
    }
  }

  async prepareDev(projectRoot, { lease = null } = {}) {
    this.#assertAvailable("prepareDev");
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, lease, (owned) => this.#prepareDevOwned(projectRoot, repoRoot, owned));
  }

  async synchronizeMainIntoDev({ projectRoot, publishedRevision = null } = {}) {
    this.#assertAvailable("synchronizeMainIntoDev");
    const expectedMainCommit = exactCommitId(publishedRevision, "published revision");
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, null, async (lease) => {
      const currentLocalMain = await localMainCommit(repoRoot);
      if (currentLocalMain !== expectedMainCommit) {
        throw new Error(
          `published revision ${expectedMainCommit} is not the accepted local main ${currentLocalMain}`,
        );
      }
      return this.#synchronizeMainIntoDevOwned({
        repoRoot,
        expectedMainCommit,
        observedMainCommit: expectedMainCommit,
        lease,
      });
    });
  }

  async prepare(params = {}) {
    this.#assertAvailable("prepare");
    return this.withTaskLock(params.taskId, (lease) => this.prepareOwned({ ...params, lease }));
  }

  async prepareOwned({ taskId, taskNumber = null, projectRoot, lease = null, dependencyMode = "skip", dependencyOverrideReason = null } = {}) {
    this.#assertAvailable("prepareOwned");
    if (!["skip", "ensure", "verify"].includes(dependencyMode)) throw new Error("Invalid Task dependency mode");
    const id = normalizedTaskId(taskId);
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(id);
    const selectedRoot = canonicalPath(projectRoot);
    const selectedWorktreeRoot = await worktreeRoot(selectedRoot);
    const selection = taskSparseCheckoutSelection(selectedWorktreeRoot, selectedRoot);
    const repoRoot = await repositoryRoot(projectRoot);
    const workspace = await this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      if (dependencyOverrideReason != null) {
        const reason = String(dependencyOverrideReason).trim();
        if (!reason || reason.length > 2000) throw new Error("Dependency override requires a concise explicit user instruction");
        if (await access(this.#withdrawalFile(repoRoot)).then(() => true, () => false)) {
          throw new Error("Resolve the pending Task withdrawal before overriding a release wait");
        }
        const ref = this.#releaseWaitRef(id, repoRoot);
        const object = await gitMaybe(["rev-parse", "--verify", ref], { cwd: repoRoot });
        if (object) await this.#runOwned(["update-ref", "-d", ref, object], { cwd: repoRoot, lease: ownedLease });
      } else {
        await this.#assertTaskReleaseWait(id, repoRoot);
      }
      const repoKey = taskRepositoryKey(repoRoot);
      const branch = taskBranchName(id, repoRoot, taskNumber);
      const baseRef = taskBaseRef(id, repoKey);
      let baseCommit = await gitMaybe(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: repoRoot });
      if (!baseCommit) {
        baseCommit = await localMainCommit(repoRoot);
        await this.#runOwned(["update-ref", "--stdin"], {
          cwd: repoRoot,
          input: `start\nverify refs/heads/main ${baseCommit}\ncreate ${baseRef} ${baseCommit}\nprepare\ncommit\n`,
          lease: ownedLease,
        });
        const pinned = await this.#runOwned(["rev-parse", "--verify", `${baseRef}^{commit}`], {
          cwd: repoRoot, lease: ownedLease,
        });
        if (pinned !== baseCommit) {
          throw new Error("Task base ref did not preserve the accepted local main identity");
        }
      }
      const taskRootPath = path.join(this.taskWorktreesRoot, id, repoKey);
      await this.#alignExistingTaskBranch({
        repositoryRoot: repoRoot,
        worktreeRoot: taskRootPath,
        branch,
        lease: ownedLease,
      });
      const taskWorktree = await this.#ensureBranchWorktree({
        repositoryRoot: repoRoot,
        branch,
        worktreeRoot: taskRootPath,
        managedRoot: path.join(this.taskWorktreesRoot, id),
        startCommit: baseCommit,
        noCheckout: true,
        lease: ownedLease,
      });
      const taskRoot = taskWorktree.root;
      await this.#ensureSparseTaskWorktree({
        taskId: id,
        worktreeRoot: taskRoot,
        selection,
        created: taskWorktree.created,
        lease: ownedLease,
      });
      const scopedProjectRoot = canonicalPath(path.resolve(taskRoot, selection.relativePath));
      if (!pathInside(taskRoot, scopedProjectRoot)) {
        throw new Error("Task project root escaped its managed worktree");
      }
      const headCommit = await this.#runOwned(["rev-parse", "HEAD^{commit}"], {
        cwd: taskRoot, lease: ownedLease,
      });
      return {
        taskId: id,
        repositoryRoot: repoRoot,
        projectRoot: scopedProjectRoot,
        branch,
        baseRef,
        baseCommit,
        headCommit,
        gitBaseline: { repoRoot, tree: baseCommit },
      };
    });
    if (dependencyMode !== "skip") {
      const taskRoot = await worktreeRoot(workspace.projectRoot);
      const lockfiles = await trackedNpmLockfiles(taskRoot, workspace.projectRoot);
      const dependencyLock = path.join(this.dataDir, "locks", `task-dependencies-${id}-${taskRepositoryKey(repoRoot)}`);
      if (lockfiles.length > 0) {
        await withInterprocessLocks([dependencyLock], async (dependencyLease) => {
          const taskDependencyLease = combinedLease(lease, dependencyLease);
          await taskDependencyLease.assertOwned();
          await this.prepareDependencies({
            projectRoot: workspace.projectRoot,
            lockfiles,
            verify: dependencyMode === "verify",
            lease: taskDependencyLease,
            runNpm: (args, options) => this.#runOwnedNpm(args, { ...options, lease: taskDependencyLease }),
          });
          await taskDependencyLease.assertOwned();
        });
      }
    }
    await lease.assertOwned();
    return workspace;
  }

  async managedRepositoryRoot(projectRoot, { taskId, taskNumber = null } = {}) {
    this.#assertAvailable("managedRepositoryRoot");
    const expectedTaskId = String(taskId ?? "").trim();
    if (!expectedTaskId) return null;
    const id = normalizedTaskId(expectedTaskId);
    const candidate = canonicalPath(projectRoot);
    if (!pathInside(this.taskWorktreesRoot, candidate)) return null;
    try {
      const taskRoot = await worktreeRoot(candidate);
      if (!pathInside(taskRoot, candidate) || !pathInside(this.taskWorktreesRoot, taskRoot)) return null;
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

  async snapshot(params = {}) {
    this.#assertAvailable("snapshot");
    return this.withTaskLock(params.taskId, (lease) => this.snapshotOwned({ ...params, lease }));
  }

  async snapshotOwned({ taskId, taskNumber = null, projectRoot, turnId = null, summary = "", lease = null } = {}) {
    this.#assertAvailable("snapshotOwned");
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(taskId);
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      const workspace = await this.prepareOwned({ taskId, taskNumber, projectRoot, lease: ownedLease });
      const taskRoot = await worktreeRoot(workspace.projectRoot);
      const suffix = String(turnId ?? "").trim() || randomUUID();
      await commitDirtyWorktree(
        taskRoot,
        `task(${workspace.taskId.slice(0, 8)}): ${String(summary ?? "").trim() || `snapshot ${suffix}`}`,
        { lease: ownedLease },
      );
      const headCommit = await this.#runOwned(["rev-parse", "HEAD^{commit}"], {
        cwd: taskRoot, lease: ownedLease,
      });
      const diff = await this.#runOwned([
        "-c", "core.quotePath=false",
        "diff", "--name-status", "--find-renames", workspace.baseCommit, headCommit, "--",
      ], { cwd: taskRoot, lease: ownedLease });
      return {
        ...workspace,
        headCommit,
        changedFiles: changedFilesFromNameStatus(diff, workspace.repositoryRoot),
        resultSnapshot: { repoRoot: workspace.repositoryRoot, tree: headCommit },
      };
    });
  }

  async mergeIntoDev(snapshot) {
    this.#assertAvailable("mergeIntoDev");
    return this.withTaskLock(snapshot.taskId, (lease) => this.mergeIntoDevOwned(snapshot, { lease }));
  }

  async mergeIntoDevOwned(snapshot, { lease = null } = {}) {
    this.#assertAvailable("mergeIntoDevOwned");
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(snapshot.taskId);
    return this.#withClearDevLock(snapshot.repositoryRoot, lease, async (ownedLease) => {
      let dev = await this.#prepareDevOwned(
        snapshot.repositoryRoot,
        snapshot.repositoryRoot,
        ownedLease,
        { allowUnadoptedLocalMain: true },
      );
      let devHeadBefore = dev.headCommit;
      let statusBefore = await runGit([
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
      ], { cwd: dev.projectRoot });
      const localMain = dev.mainCommit;
      let adoptionReceipt = await this.#recordedUpstreamAdoptionForSnapshot({
        taskId: snapshot.taskId,
        repoRoot: snapshot.repositoryRoot,
        snapshotCommit: snapshot.headCommit,
        localMain,
        lease: ownedLease,
      });
      let mainCommit = adoptionReceipt?.record.adoptedCommit ?? null;
      if (!mainCommit) {
        const adoptedMain = await this.#snapshotAdoptedMainCommit({
          snapshot,
          repoRoot: snapshot.repositoryRoot,
          localMain,
          devCommit: devHeadBefore,
          lease: ownedLease,
        });
        mainCommit = adoptedMain.mainCommit;
        adoptionReceipt = mainCommit === localMain ? null : await this.#requireExplicitUpstreamAdoption({
          taskId: snapshot.taskId,
          taskNumber: snapshot.taskNumber,
          repoRoot: snapshot.repositoryRoot,
          branch: snapshot.branch,
          baseCommit: snapshot.baseCommit,
          snapshotCommit: snapshot.headCommit,
          localMain,
          adoptedCommit: mainCommit,
          lease: ownedLease,
        });
      }
      const snapshotContainsMain = await gitMaybe([
        "merge-base", "--is-ancestor", mainCommit, snapshot.headCommit,
      ], { cwd: dev.projectRoot }) !== null;
      const snapshotContainsDev = await gitMaybe([
        "merge-base", "--is-ancestor", devHeadBefore, snapshot.headCommit,
      ], { cwd: dev.projectRoot }) !== null;
      if (!dev.acceptedMainIntegrated && (!snapshotContainsMain || !snapshotContainsDev)) {
        throw new Error(
          `managed dev ${devHeadBefore} does not contain accepted local main ${localMain}; `
          + "Task result does not prove the exact main/dev bootstrap",
        );
      }
      if ((!dev.acceptedMainIntegrated || mainCommit !== localMain)
          && snapshotContainsMain && snapshotContainsDev) {
        dev = await this.#synchronizeMainIntoDevOwned({
          repoRoot: snapshot.repositoryRoot,
          observedMainCommit: mainCommit,
          snapshotResolution: snapshot,
          adoptionReceipt,
          lease: ownedLease,
        });
        if (!dev.integrated) {
          return {
            integrated: false,
            conflicts: dev.conflicts ?? [],
            error: `main to dev synchronization requires manual resolution: ${dev.reason}`,
            dev,
          };
        }
        if (dev.snapshotIntegrated) {
          return {
            integrated: true,
            alreadyIntegrated: false,
            bootstrapCommit: dev.bootstrapCommit,
            dev,
          };
        }
        devHeadBefore = dev.headCommit;
        statusBefore = await runGit([
          "status", "--porcelain=v1", "-z", "--untracked-files=all",
        ], { cwd: dev.projectRoot });
      }
      if (statusBefore) {
        return {
          integrated: false,
          conflicts: [],
          error: "managed dev worktree changed before Task result merge",
          dev: { ...dev, headCommit: devHeadBefore },
        };
      }
      const isMerged = await gitMaybe([
        "merge-base", "--is-ancestor", snapshot.headCommit, devHeadBefore,
      ], {
        cwd: dev.projectRoot,
      }) !== null;
      if (isMerged) {
        return {
          integrated: true,
          alreadyIntegrated: true,
          dev: { ...dev, headCommit: devHeadBefore },
        };
      }
      try {
        await ownedLease.assertOwned();
        await this.#revalidateExplicitUpstreamAdoption(adoptionReceipt, ownedLease);
        await this.#runOwned([
          "-c", "user.name=Agent Hub",
          "-c", "user.email=agent-hub@local.invalid",
          "merge", "--no-ff", "--no-edit", snapshot.headCommit,
        ], { cwd: dev.projectRoot, timeoutMs: 120_000, lease: ownedLease });
        await ownedLease.assertOwned();
        const headCommit = await this.#runOwned(["rev-parse", "HEAD^{commit}"], {
          cwd: dev.projectRoot, lease: ownedLease,
        });
        await this.#runOwned([
          "merge-base", "--is-ancestor", snapshot.headCommit, headCommit,
        ], { cwd: dev.projectRoot, lease: ownedLease });
        await this.#runOwned([
          "merge-base", "--is-ancestor", devHeadBefore, headCommit,
        ], { cwd: dev.projectRoot, lease: ownedLease });
        return {
          integrated: true,
          alreadyIntegrated: false,
          dev: { ...dev, headCommit },
        };
      } catch (error) {
        if (error?.processTreeStopped === false) {
          const blockFile = await this.#integrationBlockFile(dev.repositoryRoot);
          await mkdir(path.dirname(blockFile), { recursive: true });
          await writeFile(blockFile, `${JSON.stringify({
            repositoryRoot: dev.repositoryRoot,
            devRoot: dev.projectRoot,
            reason: error.message,
            processTreeStopUnproven: true,
            observedAt: new Date().toISOString(),
          }, null, 2)}\n`, "utf8");
          throw error;
        }
        const conflicts = String(await gitMaybe(["diff", "--name-only", "--diff-filter=U"], {
          cwd: dev.projectRoot,
        }) ?? "").split(/\r?\n/u).filter(Boolean);
        const aborted = await this.#runOwned(["merge", "--abort"], {
          cwd: dev.projectRoot, lease: ownedLease,
        }).then(() => true, () => false);
        await ownedLease.assertOwned();
        const headCommit = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: dev.projectRoot });
        const statusAfter = await runGit([
          "status", "--porcelain=v1", "-z", "--untracked-files=all",
        ], { cwd: dev.projectRoot });
        const mergeHead = path.resolve(await runGit([
          "rev-parse", "--git-path", "MERGE_HEAD",
        ], { cwd: dev.projectRoot }));
        const mergeStillActive = await access(mergeHead).then(() => true, () => false);
        if (!aborted || mergeStillActive || headCommit !== devHeadBefore || statusAfter !== statusBefore) {
          throw new Error(
            `Task result merge failed and could not restore managed dev ${devHeadBefore}: ${error.message}`,
          );
        }
        return {
          integrated: false,
          conflicts,
          devRestored: true,
          error: error.message,
          dev: { ...dev, headCommit },
        };
      }
    });
  }

  #withdrawalFile(repoRoot) {
    return path.join(this.dataDir, "dev-withdrawals", `${taskRepositoryKey(repoRoot)}.json`);
  }

  async #isTaskMergeParent(taskId, root, mergeHead) {
    void taskId;
    const currentDev = await runGit(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], { cwd: root });
    return mergeHead === currentDev;
  }

  #releaseWaitRef(taskId, repoRoot) {
    return `refs/agent-hub/task-release-waits/${normalizedTaskId(taskId)}/${taskRepositoryKey(repoRoot)}`;
  }

  async pendingWithdrawal({ projectRoot, taskId, operationId } = {}) {
    this.#assertAvailable("pendingWithdrawal");
    const repoRoot = await repositoryRoot(projectRoot);
    const record = await readFile(this.#withdrawalFile(repoRoot), "utf8").then(JSON.parse, (error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!record) return false;
    if (record.version !== 1 || record.taskId !== normalizedTaskId(taskId)
        || record.operationId !== String(operationId ?? "").trim()
        || !samePath(record.repositoryRoot, repoRoot)) {
      throw new Error("Task withdrawal recovery identity does not match");
    }
    return true;
  }

  async #assertTaskReleaseWait(taskId, repoRoot) {
    taskId = normalizedTaskId(taskId);
    const ref = this.#releaseWaitRef(taskId, repoRoot);
    const object = await gitMaybe(["rev-parse", "--verify", ref], { cwd: repoRoot });
    if (!object) return;
    const wait = JSON.parse(await runGit(["cat-file", "blob", object], { cwd: repoRoot }));
    if (wait.version !== 1 || wait.taskId !== taskId || !samePath(wait.repositoryRoot, repoRoot)
        || !/^[a-f0-9]{40}$/u.test(String(wait.blockedBy?.resultCommit ?? ""))) {
      throw new Error("Task release wait identity is invalid");
    }
    const publication = await this.readPublication();
    const publishedRepository = publicationStateRepositories(publication ?? {}).find((entry) => samePath(entry.root, repoRoot));
    const remote = await gitMaybe(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], { cwd: repoRoot });
    const published = publishedRepository?.revision;
    if (!publication?.generation || !remote || !/^[a-f0-9]{40}$/u.test(String(published ?? ""))
        || await gitMaybe(["merge-base", "--is-ancestor", wait.blockedBy.resultCommit, published], { cwd: repoRoot }) === null
        || await gitMaybe(["merge-base", "--is-ancestor", published, remote], { cwd: repoRoot }) === null) {
      throw new TaskDependencyPendingError(taskId, wait.blockedBy);
    }
  }

  async withdrawResultOwned({
    taskId, taskNumber = null, projectRoot, resultCommit, operationId, lease,
    tasks = [], blockedBy = null, commitWorkflow, readWorkflowOutcome,
  } = {}) {
    this.#assertAvailable("withdrawResultOwned");
    const id = normalizedTaskId(taskId);
    const result = exactCommitId(resultCommit, "withdrawn Task result");
    const operation = String(operationId ?? "").trim();
    if (!operation || typeof commitWorkflow !== "function" || typeof readWorkflowOutcome !== "function") {
      throw new Error("Task withdrawal requires its exact lifecycle operation and outcome readback");
    }
    await requiredGuardLease(lease).assertOwned();
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      const file = this.#withdrawalFile(repoRoot);
      try {
        let intent = await readFile(file, "utf8").then(JSON.parse, (error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (intent && (intent.operationId !== operation || intent.taskId !== id)) {
          const error = new Error("Another Task withdrawal requires reconciliation; this Task was not changed");
          error.code = "TASK_WITHDRAWAL_BUSY";
          throw error;
        }
        if (intent && (intent.version !== 1 || intent.operationId !== operation || intent.taskId !== id
            || intent.resultCommit !== result || !samePath(intent.repositoryRoot, repoRoot)
            || !samePath(intent.devRoot, path.join(this.devWorktreesRoot, taskRepositoryKey(repoRoot)))
            || intent.waitRef !== this.#releaseWaitRef(id, repoRoot)
            || ![intent.oldWait, intent.newWait].every((sha) => sha === null || /^[a-f0-9]{40}$/u.test(String(sha)))
            || ![intent.beforeDevCommit, intent.afterDevCommit].every((sha) => /^[a-f0-9]{40}$/u.test(String(sha))))) {
          throw new Error("Task withdrawal recovery identity does not match");
        }
        if (!intent) {
          const dev = await this.#prepareDevOwned(repoRoot, repoRoot, ownedLease);
          const branch = taskBranchName(id, repoRoot, taskNumber);
          const evidence = await this.releaseEvidence({ taskId: id, taskNumber, projectRoot: repoRoot, branch, resultCommit: result });
          const isAncestor = async (a, b) => await gitMaybe(["merge-base", "--is-ancestor", a, b], { cwd: repoRoot }) !== null;
          if (!await isAncestor(result, dev.headCommit)) throw new Error("Withdrawn Task result is not present in current dev");
          const published = await isAncestor(result, dev.mainCommit);
          const removed = [];
          const retained = [];
          let candidate = dev.mainCommit;
          if (published) candidate = dev.headCommit;
          else {
            const lineage = new Set(String(await this.#runOwned([
              "rev-list", "--first-parent", "--max-count=4097", result, `^${evidence.baseCommit}`, `^${dev.mainCommit}`,
            ], { cwd: repoRoot, lease: ownedLease })).split(/\r?\n/u).filter(Boolean));
            if (lineage.size > 4096) throw new Error("Task withdrawal lineage exceeds its bounded proof");
            const owners = [];
            if (tasks.length > 4096) throw new Error("Task withdrawal ownership exceeds its bounded proof");
            for (const task of tasks.filter((item) => item.taskId !== id)) {
              const head = exactCommitId(task.resultCommit, "retained Task result");
              const sideLineage = new Set(String(await this.#runOwned([
                "rev-list", "--first-parent", "--max-count=4097", head, `^${dev.mainCommit}`,
              ], { cwd: repoRoot, lease: ownedLease })).split(/\r?\n/u).filter(Boolean));
              if (sideLineage.size > 4096) throw new Error("Retained Task lineage exceeds its bounded proof");
              owners.push({ taskId: normalizedTaskId(task.taskId), resultCommit: head, lineage: sideLineage });
            }
            // A legacy Task may have been based directly on another Task result.
            // Its first-parent ancestry does not transfer that other Task's ownership.
            const inheritedOwners = owners.filter((owner) => lineage.has(owner.resultCommit));
            for (const owner of inheritedOwners) {
              for (const commit of owner.lineage) lineage.delete(commit);
            }
            const history = String(await this.#runOwned([
              "log", "--first-parent", "--reverse", "--format=%H %P", "--max-count=4097", dev.headCommit, `^${dev.mainCommit}`,
            ], { cwd: repoRoot, lease: ownedLease })).split(/\r?\n/u).filter(Boolean);
            if (history.length > 4096) throw new Error("dev withdrawal history exceeds its bounded proof");
            for (const line of history) {
              const [commit, first, side, ...extra] = line.split(" ");
              if (!side || extra.length) throw new Error(`dev withdrawal cannot attribute non-Task integration ${commit}`);
              if (await isAncestor(side, dev.mainCommit)) continue;
              if (lineage.has(side)) { removed.push(commit); continue; }
              const claims = owners.filter((owner) => owner.lineage.has(side));
              if (claims.length !== 1) throw new Error(`dev withdrawal has no unique Task owner for integration ${commit}`);
              const blocked = (message) => {
                const error = new Error(message);
                error.code = "TASK_WITHDRAWAL_DEPENDENCY";
                error.blockedTaskIds = [claims[0].taskId];
                error.integrationCommit = commit;
                return error;
              };
              const sideHistory = String(await this.#runOwned([
                "rev-list", "--max-count=4097", side, `^${dev.mainCommit}`,
              ], { cwd: repoRoot, lease: ownedLease })).split(/\r?\n/u).filter(Boolean);
              if (sideHistory.length > 4096) throw new Error("Retained Task ancestry exceeds its bounded proof");
              if (sideHistory.some((sha) => lineage.has(sha))) throw blocked(`Task ${claims[0].taskId} contains withdrawn Task ${id}`);
              const originalTree = String(await this.#runOwned(["merge-tree", "--write-tree", first, side], { cwd: repoRoot, lease: ownedLease })).split(/\s/u)[0];
              const recordedTree = await this.#runOwned(["rev-parse", `${commit}^{tree}`], { cwd: repoRoot, lease: ownedLease });
              if (originalTree !== recordedTree) throw new Error(`Task ${claims[0].taskId} has a manual dev resolution that cannot be separated automatically`);
              let nextTree;
              try {
                nextTree = String(await this.#runOwned(["merge-tree", "--write-tree", candidate, side], { cwd: repoRoot, lease: ownedLease })).split(/\s/u)[0];
              } catch (error) {
                if (error.processTreeStopped === false) throw error;
                throw blocked(`Task ${claims[0].taskId} cannot be retained without Task ${id}: ${error.message}`);
              }
              candidate = await this.#runOwned([
                "-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
                "commit-tree", exactCommitId(nextTree, "retained integration tree"), "-p", candidate, "-p", side,
                "-m", `Retain Task ${claims[0].taskId} after withdrawal of ${id}`,
              ], { cwd: repoRoot, lease: ownedLease });
              retained.push(commit);
            }
            if (!removed.length || await isAncestor(result, candidate)) throw new Error("Task withdrawal did not prove removal of the exact result");
          }
          const waitRef = this.#releaseWaitRef(id, repoRoot);
          const oldWait = await gitMaybe(["rev-parse", "--verify", waitRef], { cwd: repoRoot });
          let newWait = oldWait;
          const waiting = blockedBy ? { taskId: normalizedTaskId(blockedBy.taskId), resultCommit: exactCommitId(blockedBy.resultCommit, "dependency result") } : null;
          if (waiting) {
            newWait = await this.#runOwned(["hash-object", "-w", "--stdin"], {
              cwd: repoRoot, lease: ownedLease,
              input: JSON.stringify({ version: 1, taskId: id, repositoryRoot: repoRoot, blockedBy: waiting }),
            });
          }
          intent = {
            version: 1, operationId: operation, taskId: id, resultCommit: result, repositoryRoot: repoRoot,
            devRoot: dev.projectRoot, beforeDevCommit: dev.headCommit, afterDevCommit: candidate,
            waitRef, oldWait, newWait,
            evidence: {
              outcome: published ? "already_published" : "withdrawn", taskId: id, resultCommit: result,
              beforeDevCommit: dev.headCommit, afterDevCommit: candidate,
              removedIntegrations: removed, retainedIntegrations: retained,
              ...(waiting ? { blockedBy: waiting } : {}),
            },
          };
          await ownedLease.assertOwned();
          await mkdir(path.dirname(file), { recursive: true });
          const temporary = `${file}.${randomUUID()}.tmp`;
          const handle = await open(temporary, "wx");
          try {
            try { await handle.writeFile(`${JSON.stringify(intent)}\n`, "utf8"); await handle.sync(); }
            finally { await handle.close(); }
            await ownedLease.assertOwned();
            await rename(temporary, file);
          } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
        }
        const exchange = async (reverse = false) => {
          const from = reverse ? intent.afterDevCommit : intent.beforeDevCommit;
          const to = reverse ? intent.beforeDevCommit : intent.afterDevCommit;
          const oldWait = reverse ? intent.newWait : intent.oldWait;
          const newWait = reverse ? intent.oldWait : intent.newWait;
          const commands = [`update refs/heads/${this.devBranch} ${to} ${from}`];
          if (oldWait !== newWait) commands.push(newWait
            ? `update ${intent.waitRef} ${newWait} ${oldWait || "0".repeat(40)}`
            : `delete ${intent.waitRef} ${oldWait}`);
          await this.#runOwned(["update-ref", "--stdin"], {
            cwd: repoRoot, lease: ownedLease, input: `start\n${commands.join("\n")}\nprepare\ncommit\n`,
          });
          await this.#runOwned(["reset", "--hard", to], { cwd: intent.devRoot, lease: ownedLease });
        };
        const current = await this.#runOwned(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], { cwd: repoRoot, lease: ownedLease });
        const currentWait = await gitMaybe(["rev-parse", "--verify", intent.waitRef], { cwd: repoRoot });
        const before = current === intent.beforeDevCommit && currentWait === intent.oldWait;
        const after = current === intent.afterDevCommit && currentWait === intent.newWait;
        if (!before && !after) throw new Error("dev or release wait moved outside the pending withdrawal");
        const prior = await readWorkflowOutcome();
        if (prior?.status === "committed") {
          if (!after) throw new Error("Committed withdrawal does not match dev");
          await this.#runOwned(["reset", "--hard", intent.afterDevCommit], { cwd: intent.devRoot, lease: ownedLease });
          await unlink(file);
          return { workflow: prior.result, withdrawal: intent.evidence };
        }
        if (prior?.status !== "not_committed") throw new Error("Task withdrawal lifecycle outcome is unknown");
        try {
          if (!after) await exchange();
          else await this.#runOwned(["reset", "--hard", intent.afterDevCommit], { cwd: intent.devRoot, lease: ownedLease });
          await ownedLease.assertOwned();
          const workflow = await commitWorkflow(intent.evidence);
          await ownedLease.assertOwned();
          await unlink(file);
          return { workflow, withdrawal: intent.evidence };
        } catch (error) {
          await ownedLease.assertOwned();
          const outcome = await readWorkflowOutcome();
          if (outcome?.status === "committed") {
            await unlink(file);
            return { workflow: outcome.result, withdrawal: intent.evidence };
          }
          if (outcome?.status === "not_committed" && error.processTreeStopped !== false) {
            const head = await this.#runOwned(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], { cwd: repoRoot, lease: ownedLease });
            if (head === intent.afterDevCommit) await exchange(true);
            else if (head !== intent.beforeDevCommit) throw new Error("Task withdrawal rollback found an unrelated dev revision", { cause: error });
            await unlink(file);
          }
          throw error;
        }
      } catch (error) {
        // Read ownership before releasing the repository lock. A foreign intent
        // cannot turn this operation's proven refusal into an unknown effect.
        const pending = await readFile(file, "utf8").then(JSON.parse, (readError) => {
          if (readError.code === "ENOENT") return null;
          throw readError;
        });
        if (pending?.operationId === operation && pending?.taskId === id) {
          error.code = "TASK_WITHDRAWAL_UNKNOWN";
        }
        throw error;
      }
    });
  }

  async reconcile({ projectRoots = [] } = {}) {
    this.#assertAvailable("reconcile");
    const repositories = [];
    for (const registration of projectRoots) {
      const projectRoot = typeof registration === "string" ? registration : registration?.projectRoot;
      if (!projectRoot) continue;
      try {
        const repoRoot = await repositoryRoot(projectRoot);
        await this.#withClearDevLock(repoRoot, null, async (lease) => {
          const devRoot = await worktreeForBranch(repoRoot, this.devBranch);
          if (!devRoot) {
            repositories.push({ projectRoot, repositoryRoot: repoRoot, status: "ready", devRoot: null });
            return;
          }
          if (!pathInside(this.devWorktreesRoot, devRoot)) {
            repositories.push({ projectRoot, repositoryRoot: repoRoot, status: "external", devRoot });
            return;
          }
          await this.#assertRecoverableDev(repoRoot, devRoot, { lease });
          repositories.push({ projectRoot, repositoryRoot: repoRoot, status: "ready", devRoot });
        });
      } catch (error) {
        repositories.push({ projectRoot, status: "blocked", reason: error.message });
      }
    }
    return { repositories };
  }

  async snapshotAndMerge(params = {}) {
    this.#assertAvailable("snapshotAndMerge");
    return this.withTaskLock(params.taskId, (lease) => this.snapshotAndMergeOwned({ ...params, lease }));
  }

  async snapshotAndMergeOwned(params = {}) {
    this.#assertAvailable("snapshotAndMergeOwned");
    await requiredGuardLease(params.lease).assertOwned();
    await this.#assertNoProcessTreeGuard(params.taskId);
    await this.#assertTaskReleaseWait(params.taskId, await repositoryRoot(params.projectRoot));
    if (params.expectedResultCommit) {
      const reused = await this.#reuseTestResultOwned(params);
      if (reused) return reused;
    }
    const snapshot = await this.snapshotOwned(params);
    await params.lease.assertOwned();
    if (!snapshot.changedFiles.length) {
      const dev = await this.#withClearDevLock(snapshot.repositoryRoot, params.lease, (ownedLease) => (
        this.#prepareDevOwned(snapshot.repositoryRoot, snapshot.repositoryRoot, ownedLease)
      ));
      const alreadyIntegrated = await gitMaybe([
        "merge-base", "--is-ancestor", snapshot.headCommit, dev.headCommit,
      ], { cwd: dev.projectRoot }) !== null;
      return {
        snapshot,
        integration: {
          dev,
          alreadyIntegrated,
          outcome: "no_result",
          integrated: false,
          resultProved: false,
          error: "Task has no result relative to its immutable base",
        },
      };
    }
    await params.lease.assertOwned();
    const integration = await this.mergeIntoDevOwned(snapshot, { lease: params.lease });
    if (integration.integrated) {
      await params.lease.assertOwned();
      await this.#withClearDevLock(snapshot.repositoryRoot, params.lease, (ownedLease) => (
        this.#runOwned([
          "update-ref",
          taskResultRef(snapshot.taskId, taskRepositoryKey(snapshot.repositoryRoot)),
          snapshot.headCommit,
        ], { cwd: snapshot.repositoryRoot, lease: ownedLease })
      ));
      await params.lease.assertOwned();
    }
    return { snapshot, integration: { ...integration, outcome: integration.integrated ? "integrated" : "conflict", resultProved: integration.integrated } };
  }

  async #reuseTestResultOwned(params) {
    const expectedCommit = exactCommitId(params.expectedResultCommit, "previous Test result");
    const workspace = await this.prepareOwned(params);
    if (workspace.headCommit !== expectedCommit) return null;
    const taskRoot = await worktreeRoot(workspace.projectRoot);
    const resultRef = taskResultRef(workspace.taskId, taskRepositoryKey(workspace.repositoryRoot));
    const recordedCommit = await gitMaybe(["rev-parse", "--verify", `${resultRef}^{commit}`], {
      cwd: taskRoot,
    });
    if (recordedCommit !== expectedCommit) return null;
    const diff = await runGit([
      "-c", "core.quotePath=false", "diff", "--name-status", "--find-renames",
      workspace.baseCommit, expectedCommit, "--",
    ], { cwd: taskRoot });
    const changedFiles = changedFilesFromNameStatus(diff, workspace.repositoryRoot);
    if (!changedFiles.length) return null;
    return this.#withClearDevLock(workspace.repositoryRoot, params.lease, async (ownedLease) => {
      const dev = await this.#prepareDevOwned(workspace.repositoryRoot, workspace.repositoryRoot, ownedLease);
      // Waiting for dev must not turn an earlier clean-worktree observation into current evidence.
      if (await runGit(["rev-parse", "HEAD^{commit}"], { cwd: taskRoot }) !== expectedCommit) return null;
      const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        cwd: taskRoot,
      });
      if (status) return null;
      const mergeHeadPath = await runGit(["rev-parse", "--git-path", "MERGE_HEAD"], { cwd: taskRoot });
      if (await access(path.resolve(taskRoot, mergeHeadPath)).then(() => true, () => false)) return null;
      const integrated = await gitMaybe([
        "merge-base", "--is-ancestor", expectedCommit, dev.headCommit,
      ], { cwd: dev.projectRoot }) !== null;
      if (!integrated) return null;
      await ownedLease.assertOwned();
      return {
        snapshot: {
          ...workspace,
          changedFiles,
          resultSnapshot: { repoRoot: workspace.repositoryRoot, tree: expectedCommit },
        },
        integration: {
          dev, integrated: true, alreadyIntegrated: true, resultProved: true,
          outcome: "integrated", reusedResult: true,
        },
      };
    });
  }

  async releaseEvidence({ taskId, taskNumber = null, projectRoot, branch, resultCommit } = {}) {
    this.#assertAvailable("releaseEvidence");
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
    const adoptionRef = taskLegacyAdoptionRef(id, repoKey);
    const baseCommit = await runGit(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: repoRoot });
    const acceptedCommit = await runGit(["rev-parse", "--verify", `${String(resultCommit)}^{commit}`], { cwd: repoRoot });
    const branchCommit = await runGit(["rev-parse", "--verify", `refs/heads/${storedBranch}^{commit}`], { cwd: repoRoot });
    await runGit(["merge-base", "--is-ancestor", acceptedCommit, branchCommit], { cwd: repoRoot });
    const adoptedCommit = await gitMaybe(["rev-parse", "--verify", `${adoptionRef}^{commit}`], { cwd: repoRoot });
    const pathspecs = adoptedCommit === acceptedCommit
      ? ["--", ".", ":(exclude,glob)**/CHANGELOG.md"]
      : ["--"];
    const diff = await runGit([
      "-c", "core.quotePath=false",
      "diff", "--name-status", "--find-renames", baseCommit, acceptedCommit, ...pathspecs,
    ], { cwd: repoRoot });
    return {
      projectRoot: repoRoot,
      branch: storedBranch,
      baseCommit,
      resultCommit: acceptedCommit,
      changedFiles: changedFilesFromNameStatus(diff, repoRoot),
    };
  }

  async releaseBaseEvidence({ projectRoot, publishedBaseCommit, tasks = [], lease = null } = {}) {
    this.#assertAvailable("releaseBaseEvidence");
    const repoRoot = await repositoryRoot(projectRoot);
    const published = exactCommitId(publishedBaseCommit, "published release base");
    return this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      await this.#runOwned(["cat-file", "-e", `${published}^{commit}`], { cwd: repoRoot, lease: ownedLease });
      const localMain = await localMainCommit(repoRoot);
      let baseCommit = published;
      const adoptions = [];
      const ancestor = async (left, right) => await gitMaybe([
        "merge-base", "--is-ancestor", left, right,
      ], { cwd: repoRoot }) !== null;
      for (const task of [...tasks].sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)))) {
        const receipt = await this.#recordedUpstreamAdoptionForSnapshot({
          taskId: task.taskId, repoRoot, snapshotCommit: task.resultCommit, localMain, lease: ownedLease,
          publishedBaseCommit: published,
        });
        if (!receipt) continue;
        const adopted = receipt.record.adoptedCommit;
        if (await ancestor(adopted, published)) continue;
        if (!await ancestor(published, adopted)) throw new Error("adopted release base diverges from published history");
        if (await ancestor(baseCommit, adopted)) baseCommit = adopted;
        else if (!await ancestor(adopted, baseCommit)) throw new Error("selected Task release bases diverge");
        adoptions.push({ taskId: task.taskId, resultCommit: task.resultCommit,
          recordRef: receipt.recordRef, recordHash: receipt.recordHash });
      }
      return { publishedBaseCommit: published, baseCommit, adoptions };
    });
  }

  async #squashTransferPreview({
    source, survivor, projectRoot, baselineResultCommit, newResultCommit, devAfterTree,
    authority, lease,
  } = {}) {
    const repoRoot = await repositoryRoot(projectRoot);
    const sourceId = normalizedTaskId(source?.id);
    const survivorId = normalizedTaskId(survivor?.id);
    if (sourceId === survivorId) throw new Error("Task squash transfer requires two distinct Tasks");
    const referenceFor = (task, label) => {
      const references = (task?.gitReferences ?? []).filter((item) => samePath(item.projectRoot, repoRoot));
      if (references.length !== 1) throw new Error(`${label} requires one exact Test result`);
      return references[0];
    };
    const sourceReference = referenceFor(source, "Squash source Task");
    const survivorReference = referenceFor(survivor, "Squash survivor Task");
    const baseline = exactCommitId(baselineResultCommit, "squash baseline result");
    const result = exactCommitId(newResultCommit, "squash survivor result");
    const afterTree = exactCommitId(devAfterTree, "squash dev result tree");
    const previousResult = exactCommitId(
      survivorReference.resultCommit,
      "squash survivor previous result",
    );
    const sourceResult = exactCommitId(sourceReference.resultCommit, "squash source result");
    const sourceBranchHead = await this.#runOwned([
      "rev-parse", "--verify", `refs/heads/${sourceReference.branch}^{commit}`,
    ], { cwd: repoRoot, lease });
    const survivorBranchHead = await this.#runOwned([
      "rev-parse", "--verify", `refs/heads/${survivorReference.branch}^{commit}`,
    ], { cwd: repoRoot, lease });
    if (sourceBranchHead !== sourceResult) throw new Error("Squash source branch changed after Test");
    if (survivorBranchHead !== result) {
      throw new Error("Squash survivor branch must point to the exact new clean result");
    }
    if (await gitMaybe(["merge-base", "--is-ancestor", baseline, result], { cwd: repoRoot }) === null) {
      throw new Error("Squash clean baseline must be an ancestor of the new survivor result");
    }
    for (const [task, expected, label] of [
      [source, sourceResult, "source"], [survivor, result, "survivor"],
    ]) {
      const workspaces = await this.describe(task.id);
      const workspace = workspaces.find((item) => samePath(item.repositoryRoot, repoRoot));
      if (!workspace || workspace.dirty || workspace.headCommit !== expected) {
        throw new Error(`Squash ${label} Task requires a clean exact managed worktree`);
      }
    }
    const repoKey = taskRepositoryKey(repoRoot);
    const sourceBase = await this.#runOwned([
      "rev-parse", "--verify", `${taskBaseRef(sourceId, repoKey)}^{commit}`,
    ], { cwd: repoRoot, lease });
    const survivorBase = await this.#runOwned([
      "rev-parse", "--verify", `${taskBaseRef(survivorId, repoKey)}^{commit}`,
    ], { cwd: repoRoot, lease });
    await this.#runOwned(["cat-file", "-e", `${afterTree}^{tree}`], { cwd: repoRoot, lease });
    const devRoot = await worktreeForBranch(repoRoot, this.devBranch);
    if (!devRoot) throw new Error("Squash transfer requires the managed dev worktree");
    const devBeforeCommit = await this.#runOwned([
      "rev-parse", `refs/heads/${this.devBranch}^{commit}`,
    ], { cwd: repoRoot, lease });
    const devStatus = await this.#runOwned([
      "status", "--porcelain=v1", "-z", "--untracked-files=all",
    ], { cwd: devRoot, lease });
    if (devStatus) throw new Error("Squash transfer requires a clean managed dev worktree");
    const changedPaths = async (left, right) => String(await this.#runOwned([
      "diff", "--no-renames", "--name-only", "-z", left, right, "--",
      ".", ":(exclude,glob)**/CHANGELOG.md", ":(exclude)CHANGELOG.md",
    ], { cwd: repoRoot, lease })).split("\0").filter(Boolean).sort();
    const sourcePaths = await changedPaths(sourceBase, sourceResult);
    const ownerPaths = await changedPaths(baseline, result);
    if (!sourcePaths.length) throw new Error("Squash source result has no transferable changes");
    if (!ownerPaths.length) throw new Error("Squash survivor result has no replacement delta");
    const actualDevPaths = await changedPaths(devBeforeCommit, afterTree);
    const ownerPathSet = new Set(ownerPaths);
    const foreignChanges = actualDevPaths.filter((name) => !ownerPathSet.has(name));
    if (foreignChanges.length) {
      throw new Error(`Squash transfer changed paths outside its exact owner delta: ${foreignChanges.join(", ")}`);
    }
    const treeEntry = async (treeish, name) => {
      const value = await this.#treeEntryAt(repoRoot, treeish, name, lease);
      return value ? { mode: value.mode, object: value.object } : null;
    };
    const sourceWitnesses = [];
    for (const name of sourcePaths) sourceWitnesses.push({
      path: name,
      source: await treeEntry(sourceResult, name),
      survivor: await treeEntry(result, name),
    });
    const ownerWitnesses = [];
    for (const name of ownerPaths) ownerWitnesses.push({
      path: name,
      baseline: await treeEntry(baseline, name),
      beforeDev: await treeEntry(devBeforeCommit, name),
      newResult: await treeEntry(result, name),
      afterDev: await treeEntry(afterTree, name),
    });
    return normalizedTaskSquashTransfer({
      version: 1,
      kind: "task-squash-transfer-v1",
      survivor: {
        taskId: survivorId,
        revision: survivor.revision,
        releaseRevision: survivor.releaseRevision ?? survivor.revision,
        resultCommit: result,
        baseCommit: survivorBase,
        branch: survivorReference.branch,
      },
      source: {
        taskId: sourceId,
        revision: source.revision,
        releaseRevision: source.releaseRevision ?? source.revision,
        resultCommit: sourceResult,
        baseCommit: sourceBase,
        branch: sourceReference.branch,
      },
      projectRoot: repoRoot,
      previousResultCommit: previousResult,
      baselineResultCommit: baseline,
      devBeforeCommit,
      devAfterTree: afterTree,
      sourceWitnesses,
      ownerWitnesses,
      authority,
    });
  }

  async previewSquashTransferOwned(params = {}) {
    this.#assertAvailable("previewSquashTransferOwned");
    await requiredGuardLease(params.lease).assertOwned();
    const repoRoot = await repositoryRoot(params.projectRoot);
    return this.#withClearDevLock(repoRoot, params.lease, (lease) => (
      this.#squashTransferPreview({ ...params, projectRoot: repoRoot, lease })
    ));
  }

  async readSquashTransferOwned(proofValue, { projectRoot, lease } = {}) {
    this.#assertAvailable("readSquashTransferOwned");
    const proof = normalizedTaskSquashTransfer(proofValue);
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      const sourceBranch = await this.#runOwned([
        "rev-parse", "--verify", `refs/heads/${proof.source.branch}^{commit}`,
      ], { cwd: repoRoot, lease: ownedLease });
      const survivorBranch = await this.#runOwned([
        "rev-parse", "--verify", `refs/heads/${proof.survivor.branch}^{commit}`,
      ], { cwd: repoRoot, lease: ownedLease });
      const exactWorktree = async (taskId, expectedHead) => {
        const workspaces = await this.describe(taskId);
        const workspace = workspaces.find((item) => samePath(item.repositoryRoot, repoRoot));
        return Boolean(workspace && !workspace.dirty && workspace.headCommit === expectedHead);
      };
      if (sourceBranch !== proof.source.resultCommit
          || survivorBranch !== proof.survivor.resultCommit
          || !await exactWorktree(proof.source.taskId, proof.source.resultCommit)
          || !await exactWorktree(proof.survivor.taskId, proof.survivor.resultCommit)) {
        return { status: "unknown", proof, reason: "Task branch or clean worktree changed" };
      }
      const current = await this.#runOwned([
        "rev-parse", `refs/heads/${this.devBranch}^{commit}`,
      ], { cwd: repoRoot, lease: ownedLease });
      if (current === proof.devBeforeCommit) return { status: "not_applied", proof };
      const parents = String(await this.#runOwned([
        "show", "-s", "--format=%P", current,
      ], { cwd: repoRoot, lease: ownedLease })).split(" ").filter(Boolean);
      const tree = await this.#runOwned(["rev-parse", `${current}^{tree}`], { cwd: repoRoot, lease: ownedLease });
      if (parents.length === 2 && parents[0] === proof.devBeforeCommit
          && parents[1] === proof.survivor.resultCommit && tree === proof.devAfterTree) {
        const integratedProof = normalizedTaskSquashTransfer({ ...proof, integrationCommit: current });
        const devRoot = await worktreeForBranch(repoRoot, this.devBranch);
        if (!devRoot) return {
          status: "pending_materialization", proof: integratedProof,
          reason: "managed dev worktree is unavailable",
        };
        const head = await this.#runOwned(["rev-parse", "HEAD^{commit}"], {
          cwd: devRoot, lease: ownedLease,
        });
        const indexTree = await this.#runOwned(["write-tree"], { cwd: devRoot, lease: ownedLease });
        const status = await this.#runOwned([
          "status", "--porcelain=v1", "-z", "--untracked-files=all",
        ], { cwd: devRoot, lease: ownedLease });
        let deletedPathExists = false;
        for (const witness of proof.ownerWitnesses.filter((item) => item.afterDev == null)) {
          const exists = await stat(path.join(devRoot, witness.path)).then(
            () => true,
            (error) => {
              if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
              throw error;
            },
          );
          if (exists) {
            deletedPathExists = true;
            break;
          }
        }
        if (head !== current || indexTree !== proof.devAfterTree || status || deletedPathExists) return {
          status: "pending_materialization", proof: integratedProof,
          reason: "managed dev worktree or index does not exactly materialize the accepted integration",
        };
        return { status: "applied", proof: integratedProof };
      }
      return { status: "unknown", proof, currentDevCommit: current };
    });
  }

  async materializeSquashTransferOwned(proofValue, { projectRoot, lease } = {}) {
    this.#assertAvailable("materializeSquashTransferOwned");
    await requiredGuardLease(lease).assertOwned();
    const proof = normalizedTaskSquashTransfer(proofValue);
    if (!proof.integrationCommit) throw new Error("Squash transfer materialization requires the exact integration commit");
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      const current = await this.#runOwned([
        "rev-parse", `refs/heads/${this.devBranch}^{commit}`,
      ], { cwd: repoRoot, lease: ownedLease });
      if (current !== proof.integrationCommit) {
        throw new Error("Squash transfer materialization ref changed");
      }
      const existing = await this.readSquashTransferOwned(proof, {
        projectRoot: repoRoot, lease: ownedLease,
      });
      if (existing.status === "applied") return existing.proof;
      if (existing.status !== "pending_materialization") {
        throw new Error(`Squash transfer materialization identity is unknown: ${existing.reason ?? existing.status}`);
      }
      const devRoot = await worktreeForBranch(repoRoot, this.devBranch);
      if (!devRoot) throw new Error("Squash transfer requires the managed dev worktree");
      const beforeTree = await this.#runOwned(["rev-parse", `${proof.devBeforeCommit}^{tree}`], {
        cwd: repoRoot, lease: ownedLease,
      });
      const indexTree = await this.#runOwned(["write-tree"], { cwd: devRoot, lease: ownedLease });
      const indexPathValue = await this.#runOwned(["rev-parse", "--git-path", "index"], {
        cwd: devRoot, lease: ownedLease,
      });
      const commonDirValue = await this.#runOwned(["rev-parse", "--git-common-dir"], {
        cwd: devRoot, lease: ownedLease,
      });
      if (indexTree === proof.devAfterTree) {
        throw new Error(`Squash transfer materialization remains incomplete: ${existing.reason}`);
      }
      if (indexTree !== beforeTree) {
        throw new Error("Squash transfer materialization found a changed managed dev index");
      }
      const shadowRoot = path.join(
        this.dataDir,
        "task-squash-materializations",
        proof.transferHash,
      );
      const shadowIndex = path.join(shadowRoot, "index");
      const shadowHead = path.join(shadowRoot, "HEAD");
      const indexPath = path.resolve(devRoot, indexPathValue);
      const commonDir = path.resolve(devRoot, commonDirValue);
      const originalIndex = await readFile(indexPath);
      const shadowEnv = {
        GIT_DIR: shadowRoot,
        GIT_COMMON_DIR: commonDir,
        GIT_WORK_TREE: devRoot,
        GIT_INDEX_FILE: shadowIndex,
      };
      const deletedPathExists = async () => {
        for (const witness of proof.ownerWitnesses.filter((item) => item.afterDev == null)) {
          const exists = await stat(path.join(devRoot, witness.path)).then(
            () => true,
            (error) => {
              if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
              throw error;
            },
          );
          if (exists) return true;
        }
        return false;
      };
      await rm(shadowRoot, { recursive: true, force: true });
      await mkdir(shadowRoot, { recursive: true });
      try {
        await writeFile(shadowHead, `${proof.devBeforeCommit}\n`, { flag: "wx" });
        await writeFile(shadowIndex, originalIndex, { flag: "wx" });
        await this.#runOwned(["read-tree", proof.integrationCommit], {
          cwd: devRoot, lease: ownedLease, env: shadowEnv,
        });
        await this.#runOwned([
          "status", "--porcelain=v1", "-z", "--untracked-files=no",
        ], { cwd: devRoot, lease: ownedLease, env: shadowEnv });
        const targetDiff = await this.#runOwned(["diff-files", "--name-only", "-z"], {
          cwd: devRoot, lease: ownedLease, env: shadowEnv,
        });
        const alreadyMaterialized = !targetDiff && !await deletedPathExists();
        if (!alreadyMaterialized) {
          await writeFile(shadowHead, `${proof.devBeforeCommit}\n`);
          await writeFile(shadowIndex, originalIndex);
          await this.#runOwned([
            "checkout", "--detach", "--no-overwrite-ignore", proof.integrationCommit,
          ], { cwd: devRoot, lease: ownedLease, env: shadowEnv });
        }
        await this.#runOwned([
          "read-tree", "-m", proof.devBeforeCommit, proof.integrationCommit,
        ], { cwd: devRoot, lease: ownedLease });
      } finally {
        await rm(shadowRoot, { recursive: true, force: true }).catch(() => {});
      }
      const readback = await this.readSquashTransferOwned(proof, { projectRoot: repoRoot, lease: ownedLease });
      if (readback.status !== "applied") {
        throw new Error(`Squash transfer materialization remains incomplete: ${readback.reason ?? readback.status}`);
      }
      return readback.proof;
    });
  }

  async applySquashTransferOwned(params = {}) {
    this.#assertAvailable("applySquashTransferOwned");
    await requiredGuardLease(params.lease).assertOwned();
    const repoRoot = await repositoryRoot(params.projectRoot);
    return this.#withClearDevLock(repoRoot, params.lease, async (lease) => {
      const proof = await this.#squashTransferPreview({ ...params, projectRoot: repoRoot, lease });
      if (params.expectedTransferHash && proof.transferHash !== params.expectedTransferHash) {
        throw new Error("Squash transfer changed after confirmation");
      }
      const integrationCommit = await this.#runOwned([
        "-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
        "commit-tree", proof.devAfterTree, "-p", proof.devBeforeCommit,
        "-p", proof.survivor.resultCommit,
      ], {
        cwd: repoRoot,
        lease,
        input: `merge(agent-hub): exact squash transfer ${proof.transferHash}\n`,
      });
      await this.#runOwned([
        "update-ref", `refs/heads/${this.devBranch}`, integrationCommit, proof.devBeforeCommit,
      ], { cwd: repoRoot, lease });
      const integratedProof = normalizedTaskSquashTransfer({ ...proof, integrationCommit });
      await this.materializeSquashTransferOwned(integratedProof, { projectRoot: repoRoot, lease });
      const readback = await this.readSquashTransferOwned(integratedProof, { projectRoot: repoRoot, lease });
      if (readback.status !== "applied" || readback.proof.integrationCommit !== integrationCommit) {
        throw new Error("Squash transfer Git readback did not match the exact accepted effect");
      }
      return readback.proof;
    });
  }

  async releaseIntegrationEvidence({ projectRoot, tasks = [], lease = null } = {}) {
    this.#assertAvailable("releaseIntegrationEvidence");
    const dev = await this.prepareDev(projectRoot, { lease });
    const firstParentHistory = String(await runGit([
      "log", "--first-parent", "--reverse", "--format=%H%x00%P", dev.headCommit,
    ], { cwd: dev.projectRoot })).split(/\r?\n/u).filter(Boolean).map((line, order) => {
      const [commit, parentsText = ""] = line.split("\0");
      return { commit, parents: parentsText.split(" ").filter(Boolean), order };
    });
    const resolvedTasks = [];
    for (const task of tasks) {
      const taskRevision = Number(task.taskRevision);
      if (!Number.isInteger(taskRevision) || taskRevision < 1) {
        throw new Error(`Task ${task.taskId} requires an exact positive revision for release integration evidence`);
      }
      const evidence = await this.releaseEvidence(task);
      const squashTransfer = task.squashTransfer
        ? normalizedTaskSquashTransfer(task.squashTransfer)
        : null;
      if (squashTransfer && (
        squashTransfer.survivor.taskId !== String(task.taskId)
        || squashTransfer.survivor.resultCommit !== evidence.resultCommit
        || squashTransfer.survivor.releaseRevision + 1 !== taskRevision
        || !samePath(squashTransfer.projectRoot, evidence.projectRoot)
      )) throw new Error(`Task ${task.taskId} squash transfer does not match its frozen result`);
      const lineage = new Set(String(await runGit([
        "rev-list", "--first-parent", evidence.resultCommit, `^${evidence.baseCommit}`,
      ], { cwd: dev.projectRoot })).split(/\r?\n/u).filter(Boolean));
      const integrations = firstParentHistory.filter((entry) => (
        entry.parents.slice(1).some((parent) => lineage.has(parent))
      )).map((entry) => ({
        commit: entry.commit,
        parent: entry.parents[0],
        order: entry.order,
      }));
      if (squashTransfer) {
        const exactIntegration = firstParentHistory.find((entry) => (
          entry.commit === squashTransfer.integrationCommit
        ));
        const exactTree = exactIntegration
          ? await runGit(["rev-parse", `${exactIntegration.commit}^{tree}`], { cwd: dev.projectRoot })
          : null;
        if (!exactIntegration || exactIntegration.parents.length !== 2
            || exactIntegration.parents[0] !== squashTransfer.devBeforeCommit
            || exactIntegration.parents[1] !== squashTransfer.survivor.resultCommit
            || exactTree !== squashTransfer.devAfterTree
            || !integrations.some((entry) => entry.commit === exactIntegration.commit)) {
          throw new Error(`Task ${task.taskId} squash transfer has no exact dev integration readback`);
        }
      }
      const resultIntegrated = await gitMaybe([
        "merge-base", "--is-ancestor", evidence.resultCommit, dev.headCommit,
      ], { cwd: dev.projectRoot }) !== null;
      if (!resultIntegrated) {
        throw new Error(`Task result commit ${evidence.resultCommit} is not integrated into dev ${dev.headCommit}`);
      }
      if (!integrations.length) {
        const mainCommit = await localMainCommit(evidence.projectRoot);
        const includedInMain = await gitMaybe([
          "merge-base", "--is-ancestor", evidence.resultCommit, mainCommit,
        ], { cwd: dev.projectRoot }) !== null;
        if (!includedInMain) {
          throw new Error(`Task ${task.taskId} has no exact first-parent integration in dev`);
        }
      }
      resolvedTasks.push({
        taskId: String(task.taskId),
        taskRevision,
        baseCommit: evidence.baseCommit,
        resultCommit: evidence.resultCommit,
        integrations,
        lineage,
        ...(squashTransfer ? { squashTransfer } : {}),
      });
    }
    const integrationClaims = new Map();
    for (const task of resolvedTasks) {
      for (const integration of task.integrations) {
        const claims = integrationClaims.get(integration.commit) ?? [];
        claims.push(task);
        integrationClaims.set(integration.commit, claims);
      }
    }
    const integrationOwners = new Map();
    for (const [integrationCommit, claims] of integrationClaims) {
      if (claims.length === 1) {
        integrationOwners.set(integrationCommit, claims[0].taskId);
        continue;
      }
      const nestedOwners = claims.filter((candidate) => claims.every((claimant) => (
        claimant.taskId === candidate.taskId || claimant.lineage.has(candidate.resultCommit)
      )));
      if (nestedOwners.length !== 1) {
        throw new Error(`dev integration ${integrationCommit} is ambiguously owned by Tasks ${claims
          .map((claim) => claim.taskId).join(" and ")}`);
      }
      integrationOwners.set(integrationCommit, nestedOwners[0].taskId);
    }
    const integrationParents = new Map(firstParentHistory.map((entry) => [entry.commit, entry.parents]));
    for (const task of resolvedTasks) {
      // Dev ancestry alone can come from another Task's nested merge while this
      // Task's effective integrations still carry only an earlier result.
      const owned = task.integrations.filter((integration) => (
        integrationOwners.get(integration.commit) === task.taskId
      ));
      if (!task.integrations.length) continue; // Already proved contained in local main above.
      const carriedResults = new Set(owned.flatMap((integration) => (
        integrationParents.get(integration.commit).slice(1).filter((parent) => task.lineage.has(parent))
      )));
      if (!carriedResults.has(task.resultCommit)) {
        const error = new Error(`Task ${task.taskId} latest result ${task.resultCommit} is not covered by its owned dev integrations; submit the exact result for Test before release acceptance`);
        error.code = "TASK_RELEASE_RESULT_NOT_COVERED";
        throw error;
      }
    }
    return {
      ...dev,
      tasks: resolvedTasks.map(({ lineage, ...task }) => ({
        ...task,
        integrations: task.integrations.filter((integration) => (
          integrationOwners.get(integration.commit) === task.taskId
        )),
      })).sort((left, right) => (
        (left.integrations[0]?.order ?? Number.MAX_SAFE_INTEGER)
        - (right.integrations[0]?.order ?? Number.MAX_SAFE_INTEGER)
        || left.taskId.localeCompare(right.taskId)
      )),
    };
  }

  async adoptLegacyResult(params = {}) {
    this.#assertAvailable("adoptLegacyResult");
    return this.withTaskLock(params.taskId, (lease) => this.#adoptLegacyResultOwned({ ...params, lease }));
  }

  async #adoptLegacyResultOwned({
    taskId, taskNumber = null, projectRoot, reportedResultCommit, mainResultCommit, lease = null,
  } = {}) {
    const id = normalizedTaskId(taskId);
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(id);
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
    const reportedResultId = exactCommitId(reportedResultCommit, "reported result commit");
    const mainResultId = exactCommitId(mainResultCommit, "main result commit");
    const reportedCommit = await runGit([
      "rev-parse", "--verify", `${reportedResultId}^{commit}`,
    ], { cwd: repoRoot });
    const adoptedCommit = await runGit([
      "rev-parse", "--verify", `${mainResultId}^{commit}`,
    ], { cwd: repoRoot });
    const mainCommit = await localMainCommit(repoRoot);
    await runGit(["merge-base", "--is-ancestor", adoptedCommit, mainCommit], { cwd: repoRoot });
    const reportedParent = await singleParentCommit(repoRoot, reportedCommit);
    const adoptedParent = await singleParentCommit(repoRoot, adoptedCommit);
    const [reportedEvidence, adoptedEvidence] = await Promise.all([
      commitPatchEvidence(repoRoot, reportedParent, reportedCommit),
      commitPatchEvidence(repoRoot, adoptedParent, adoptedCommit),
    ]);
    if (
      reportedEvidence.patchId !== adoptedEvidence.patchId
      || reportedEvidence.nameStatus !== adoptedEvidence.nameStatus
    ) throw new Error("Legacy result does not match the selected main commit");

    const repoKey = taskRepositoryKey(repoRoot);
    const branch = taskBranchName(id, repoRoot, taskNumber);
    const branchRef = `refs/heads/${branch}`;
    const baseRef = taskBaseRef(id, repoKey);
    const adoptionRef = taskLegacyAdoptionRef(id, repoKey);
    const existingBranch = await gitMaybe(["rev-parse", "--verify", `${branchRef}^{commit}`], { cwd: repoRoot });
    const existingBase = await gitMaybe(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: repoRoot });
    const existingAdoption = await gitMaybe(["rev-parse", "--verify", `${adoptionRef}^{commit}`], { cwd: repoRoot });
    const pristinePreparedBranch = existingBranch === mainCommit && existingBase === mainCommit;
    if (existingBranch && existingBranch !== adoptedCommit && !pristinePreparedBranch) {
      throw new Error(`Task branch ${branch} already points to another commit`);
    }
    if (existingBase && existingBase !== adoptedParent && !pristinePreparedBranch) {
      throw new Error(`Task base ref for ${id} already points to another commit`);
    }
    if (existingAdoption && existingAdoption !== adoptedCommit) {
      throw new Error(`Legacy adoption ref for ${id} already points to another commit`);
    }
    const updates = [];
    const zeroCommit = "0".repeat(40);
    let branchRealignedInWorktree = false;
    if (pristinePreparedBranch && existingBranch !== adoptedCommit) {
      const taskWorktree = await worktreeForBranch(repoRoot, branch);
      if (taskWorktree) {
        if (!pathInside(path.join(this.taskWorktreesRoot, id), taskWorktree)) {
          throw new Error(`Task branch ${branch} is checked out outside its managed worktree`);
        }
        const dirty = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
          cwd: taskWorktree,
        });
        if (dirty) throw new Error(`Task branch ${branch} has uncommitted changes`);
        await this.#runOwned(["reset", "--hard", adoptedCommit], {
          cwd: taskWorktree, timeoutMs: 120_000, lease: ownedLease,
        });
        branchRealignedInWorktree = true;
      }
    }
    if (!branchRealignedInWorktree && existingBranch !== adoptedCommit) {
      updates.push(`update ${branchRef} ${adoptedCommit} ${existingBranch || zeroCommit}`);
    }
    if (existingBase !== adoptedParent) {
      updates.push(`update ${baseRef} ${adoptedParent} ${existingBase || zeroCommit}`);
    }
    if (!existingAdoption) updates.push(`update ${adoptionRef} ${adoptedCommit} ${zeroCommit}`);
    if (updates.length) {
      await this.#runOwned(["update-ref", "--stdin"], {
        cwd: repoRoot,
        input: `start\n${updates.join("\n")}\nprepare\ncommit\n`,
        lease: ownedLease,
      });
    }
    await ownedLease.assertOwned();
    return {
      taskId: id,
      projectRoot: repoRoot,
      branch,
      baseCommit: adoptedParent,
      reportedResultCommit: reportedCommit,
      resultCommit: adoptedCommit,
      mainCommit,
      patchId: adoptedEvidence.patchId,
      changedFiles: changedFilesFromNameStatus(adoptedEvidence.nameStatus, repoRoot),
    };
    });
  }

  async verifyReleaseResultsInDev({ projectRoot, resultCommits = [] } = {}) {
    this.#assertAvailable("verifyReleaseResultsInDev");
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

  async assertExplicitUpstreamAdoption({
    projectRoot, acceptedLocalMainCommit, approvedUpstreamCommit, frozenTasks = [],
  } = {}) {
    this.#assertAvailable("assertExplicitUpstreamAdoption");
    const repoRoot = await repositoryRoot(projectRoot);
    const localMain = await localMainCommit(repoRoot);
    const acceptedLocal = exactCommitId(acceptedLocalMainCommit, "accepted local main");
    const approvedUpstream = exactCommitId(approvedUpstreamCommit, "approved upstream main");
    if (localMain !== acceptedLocal) {
      throw new Error(`accepted local main changed from ${acceptedLocal} to ${localMain}`);
    }
    if (approvedUpstream === localMain) {
      return { projectRoot: repoRoot, localMain, approvedUpstream, adoptedByResultCommit: null };
    }
    await runGit(["rev-parse", "--verify", `${approvedUpstream}^{commit}`], { cwd: repoRoot });
    await runGit(["merge-base", "--is-ancestor", localMain, approvedUpstream], { cwd: repoRoot });
    const dev = await this.prepareDev(repoRoot);
    const adoptedInDev = await gitMaybe([
      "merge-base", "--is-ancestor", approvedUpstream, dev.headCommit,
    ], { cwd: dev.projectRoot }) !== null;
    const adoptedResults = [];
    for (const task of frozenTasks) {
      const exactResult = await runGit([
        "rev-parse", "--verify", `${exactCommitId(task?.resultCommit, "Task result commit")}^{commit}`,
      ], { cwd: repoRoot });
      try {
        const receipt = await this.withTaskLock(task.taskId, async (lease) => (
          this.#withClearDevLock(repoRoot, lease, async (ownedLease) => this.#requireExplicitUpstreamAdoption({
            taskId: task.taskId,
            taskNumber: task.taskNumber,
            repoRoot,
            branch: task.branch,
            baseCommit: await this.#runOwned([
              "rev-parse", "--verify", `${taskBaseRef(task.taskId, taskRepositoryKey(repoRoot))}^{commit}`,
            ], { cwd: repoRoot, lease: ownedLease }),
            snapshotCommit: exactResult,
            localMain,
            adoptedCommit: approvedUpstream,
            lease: ownedLease,
          }))
        ));
        adoptedResults.push({ resultCommit: exactResult, receipt });
      } catch {}
    }
    if (!adoptedInDev || adoptedResults.length === 0) {
      throw new Error(
        `approved upstream ${approvedUpstream} requires explicit adoption by a selected Task result and managed dev`,
      );
    }
    return {
      projectRoot: repoRoot,
      localMain,
      approvedUpstream,
      adoptedByResultCommit: adoptedResults.sort((left, right) => (
        left.resultCommit.localeCompare(right.resultCommit)
      ))[0].resultCommit,
      adoptionReceipt: adoptedResults[0].receipt,
      devHeadCommit: dev.headCommit,
    };
  }

  async describe(taskId) {
    this.#assertAvailable("describe");
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
      const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: projectRoot });
      const entries = status.split(/\r?\n/u).filter(Boolean);
      const repoRoot = await repositoryRoot(projectRoot);
      workspaces.push({
        taskId: id,
        repositoryKey: entry.name,
        projectRoot,
        repositoryRoot: repoRoot,
        branch,
        headCommit: await runGit(["rev-parse", "HEAD^{commit}"], { cwd: projectRoot }),
        dirty: entries.length > 0,
        changedPaths: entries.map((line) => line.slice(3)),
        untrackedPaths: entries.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3)),
      });
    }
    return workspaces;
  }

  async reviewDiff({ taskId, taskNumber } = {}) {
    this.#assertAvailable("reviewDiff");
    const workspaces = await this.describe(taskId);
    if (!workspaces.length) throw new Error("Рабочая папка Task недоступна");
    const repositories = [];
    let remainingBytes = 64 * 1024;
    for (const workspace of workspaces) {
      const root = await this.managedRepositoryRoot(workspace.projectRoot, { taskId, taskNumber });
      if (!root) throw new Error("Рабочая папка больше не принадлежит этой Task");
      const baseCommit = await runGit(["rev-parse", "--verify",
        `${taskBaseRef(taskId, taskRepositoryKey(root))}^{commit}`], { cwd: workspace.projectRoot });
      if (remainingBytes <= 0) return { repositories, truncated: true };
      const diff = await taskWorkingTreeDiff(workspace.projectRoot, baseCommit, { maxOutputBytes: remainingBytes });
      const head = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: workspace.projectRoot });
      if (head !== workspace.headCommit) throw new Error("Task изменилась во время чтения; откройте diff ещё раз");
      repositories.push({ projectRoot: workspace.projectRoot, branch: workspace.branch, baseCommit, ...diff });
      remainingBytes -= Buffer.byteLength(diff.text, "utf8");
      if (diff.truncated) return { repositories, truncated: true };
    }
    return { repositories, truncated: false };
  }

  async withAbsorptionEvidenceOwned({ source, target, lease }, operation) {
    this.#assertAvailable("withAbsorptionEvidenceOwned");
    await requiredGuardLease(lease).assertOwned();
    const workspaces = await this.describe(source.id);
    if (!workspaces.length) throw new Error("Combined closure requires the source Task worktree");
    if (workspaces.some((workspace) => workspace.dirty)) throw new Error("Save the source Task changes before closing it");
    for (const reference of source.gitReferences ?? []) {
      if (!workspaces.some((workspace) => samePath(workspace.repositoryRoot, reference.projectRoot))) {
        throw new Error("Source Task result has no managed worktree");
      }
    }
    const evidence = [];
    const visit = async (index, ownedLease) => {
      if (index === workspaces.length) return operation({ taskId: target.id, repositories: evidence }, ownedLease);
      const workspace = workspaces[index];
      const repoRoot = workspace.repositoryRoot;
      return this.#withDevLock(repoRoot, ownedLease, async (devLease) => {
        await this.#assertNoProcessTreeGuard(source.id);
        await this.#assertNoProcessTreeGuard(target.id);
        await this.#assertRepositoryProcessTreeClear(repoRoot);
        if (await access(this.#withdrawalFile(repoRoot)).then(() => true, () => false)) {
          throw new Error("Repository has a pending Task withdrawal");
        }
        if (!await this.managedRepositoryRoot(workspace.projectRoot, { taskId: source.id, taskNumber: source.taskNumber })) {
          throw new Error("Source Task worktree ownership changed");
        }
        const references = (target.gitReferences ?? []).filter((ref) => samePath(ref.projectRoot, repoRoot));
        if (references.length !== 1) throw new Error("Surviving Task requires one exact Test result per repository");
        const reference = references[0];
        const targetHead = await runGit(["rev-parse", `refs/heads/${reference.branch}^{commit}`], { cwd: repoRoot });
        if (targetHead !== reference.resultCommit) throw new Error("Surviving Task changed after Test");
        const targetWorkspaces = await this.describe(target.id);
        const targetWorkspace = targetWorkspaces.find((item) => samePath(item.repositoryRoot, repoRoot));
        if (!targetWorkspace || targetWorkspace.dirty || targetWorkspace.headCommit !== targetHead) {
          throw new Error("Surviving Task must have a clean tested worktree");
        }
        const sourceHead = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: workspace.projectRoot });
        if (sourceHead !== workspace.headCommit) throw new Error("Source Task changed during combined closure");
        const results = [...new Set([sourceHead, ...(source.gitReferences ?? [])
          .filter((ref) => samePath(ref.projectRoot, repoRoot)).map((ref) => ref.resultCommit)])];
        let squashTransfer = null;
        try {
          const candidate = target.squashTransfer
            ? normalizedTaskSquashTransfer(target.squashTransfer)
            : null;
          if (candidate
              && candidate.source.taskId === source.id
              && candidate.survivor.taskId === target.id
              && candidate.survivor.resultCommit === targetHead
              && candidate.source.resultCommit === sourceHead
              && candidate.transferHash === source.squashAbsorbedBy?.transferHash
              && samePath(candidate.projectRoot, repoRoot)) squashTransfer = candidate;
        } catch { squashTransfer = null; }
        if (!squashTransfer) {
          for (const result of results) {
            if (await gitMaybe(["merge-base", "--is-ancestor", result, targetHead], { cwd: repoRoot }) === null) {
              throw new Error("Surviving Task does not contain all source Task commits");
            }
          }
        }
        const main = await localMainCommit(repoRoot);
        const dev = await runGit(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], { cwd: repoRoot });
        if (squashTransfer) {
          const integration = squashTransfer.integrationCommit;
          const parents = String(await runGit(["show", "-s", "--format=%P", integration], { cwd: repoRoot }))
            .split(" ").filter(Boolean);
          const tree = await runGit(["rev-parse", `${integration}^{tree}`], { cwd: repoRoot });
          if (parents.length !== 2 || parents[0] !== squashTransfer.devBeforeCommit
              || parents[1] !== targetHead || tree !== squashTransfer.devAfterTree
              || await gitMaybe(["merge-base", "--is-ancestor", integration, dev], { cwd: repoRoot }) === null) {
            throw new Error("Surviving Task squash transfer is not the exact current dev ownership proof");
          }
        } else if (await gitMaybe(["merge-base", "--is-ancestor", targetHead, dev], { cwd: repoRoot }) === null) {
          throw new Error("Surviving Task result is not integrated into dev");
        }
        const sourceBase = await runGit(["rev-parse", `${taskBaseRef(source.id, workspace.repositoryKey)}^{commit}`], { cwd: repoRoot });
        const targetBase = await runGit(["rev-parse", `${taskBaseRef(target.id, workspace.repositoryKey)}^{commit}`], { cwd: repoRoot });
        const lineage = new Set(String(await runGit([
          "rev-list", "--first-parent", "--max-count=4097", sourceHead, `^${sourceBase}`, `^${main}`,
        ], { cwd: repoRoot })).split(/\r?\n/u).filter(Boolean));
        const targetLineage = new Set(String(await runGit([
          "rev-list", "--first-parent", "--max-count=4097", targetHead, `^${targetBase}`, `^${main}`,
        ], { cwd: repoRoot })).split(/\r?\n/u).filter(Boolean));
        if (targetLineage.size > 4096) throw new Error("Surviving Task lineage exceeds the bounded proof");
        if (lineage.size > 4096) throw new Error("Source Task lineage exceeds the bounded proof");
        const history = String(await runGit([
          "log", "--first-parent", "--format=%H %P", "--max-count=4097", dev, `^${main}`,
        ], { cwd: repoRoot })).split(/\r?\n/u).filter(Boolean);
        if (history.length > 4096) throw new Error("dev history exceeds the bounded proof");
        if (!squashTransfer) {
          for (const entry of history) {
            const [commit, , ...parents] = entry.split(" ");
            if (parents.some((parent) => lineage.has(parent) && !targetLineage.has(parent))) {
              throw new Error(`Source Task still has a separate dev integration ${commit}; return it before integrating the combined Task`);
            }
          }
        }
        evidence.push({
          projectRoot: repoRoot, sourceHead, targetHead, results,
          ...(squashTransfer ? { squashTransferHash: squashTransfer.transferHash } : {}),
        });
        return visit(index + 1, devLease);
      });
    };
    workspaces.sort((a, b) => a.repositoryRoot.localeCompare(b.repositoryRoot));
    return visit(0, lease);
  }

  async cleanupPreview(taskId, { gitReferences = [], squashAbsorbedBy = null } = {}) {
    this.#assertAvailable("cleanupPreview");
    const id = normalizedTaskId(taskId);
    const workspaces = await this.describe(id);
    const references = [];
    const publication = await this.readPublication();
    let squashTransfer = null;
    try {
      const candidate = squashAbsorbedBy
        ? normalizedTaskSquashTransfer(squashAbsorbedBy)
        : null;
      if (candidate?.source.taskId === id) squashTransfer = candidate;
    } catch { squashTransfer = null; }
    for (const reference of gitReferences) {
      const repoRoot = canonicalPath(reference.projectRoot);
      const resultCommit = String(reference.resultCommit ?? "").trim();
      let published = false;
      const remoteRevision = await gitMaybe([
        "rev-parse", "--verify", "refs/remotes/origin/main^{commit}",
      ], { cwd: repoRoot });
      const durableRevision = String(publication?.revision ?? "").trim();
      const durableGeneration = String(publication?.generation ?? "").trim();
      const publishedRevision = durableGeneration && durableRevision === remoteRevision ? remoteRevision : null;
      if (publishedRevision && resultCommit && await gitMaybe([
        "merge-base", "--is-ancestor", resultCommit, publishedRevision,
      ], { cwd: repoRoot }) !== null) published = true;
      const transferredPublished = Boolean(
        squashTransfer
        && samePath(squashTransfer.projectRoot, repoRoot)
        && squashTransfer.source.resultCommit === resultCommit
        && publishedRevision
        && await gitMaybe([
          "merge-base", "--is-ancestor", squashTransfer.survivor.resultCommit, publishedRevision,
        ], { cwd: repoRoot }) !== null,
      );
      if (transferredPublished) published = true;
      const branch = String(reference.branch ?? "").trim();
      const branchHeadCommit = branch ? await gitMaybe([
        "rev-parse", "--verify", `refs/heads/${branch}^{commit}`,
      ], { cwd: repoRoot }) : null;
      const branchPublished = !branchHeadCommit
        || (transferredPublished && branchHeadCommit === squashTransfer.source.resultCommit)
        || Boolean(publishedRevision && await gitMaybe([
          "merge-base", "--is-ancestor", branchHeadCommit, publishedRevision,
        ], { cwd: repoRoot }) !== null);
      references.push({
        ...reference,
        projectRoot: repoRoot,
        resultCommit,
        published,
        publishedRevision,
        publicationGeneration: publishedRevision ? durableGeneration : null,
        branchHeadCommit,
        branchPublished,
        ...(transferredPublished ? { publishedBySquashTransfer: squashTransfer.transferHash } : {}),
      });
    }
    const unpublishedWorktrees = [];
    for (const workspace of workspaces) {
      const reference = references.find((item) => samePath(item.projectRoot, workspace.repositoryRoot)
        && item.branch === workspace.branch);
      const transferredWorktree = reference?.publishedBySquashTransfer
        && workspace.headCommit === squashTransfer?.source.resultCommit;
      if (!reference?.publishedRevision || (!transferredWorktree && await gitMaybe([
        "merge-base", "--is-ancestor", workspace.headCommit, reference.publishedRevision,
      ], { cwd: workspace.repositoryRoot }) === null)) {
        unpublishedWorktrees.push({ ...workspace, reason: "current worktree head is not published" });
      }
    }
    const deleting = [];
    for (const workspace of workspaces) {
      deleting.push(
        { kind: "worktree", path: workspace.projectRoot },
        { kind: "branch", name: workspace.branch, repositoryRoot: workspace.repositoryRoot },
        { kind: "base_ref", name: taskBaseRef(id, workspace.repositoryKey), repositoryRoot: workspace.repositoryRoot },
        { kind: "result_ref", name: taskResultRef(id, workspace.repositoryKey), repositoryRoot: workspace.repositoryRoot },
        { kind: "adoption_ref", name: taskLegacyAdoptionRef(id, workspace.repositoryKey), repositoryRoot: workspace.repositoryRoot },
      );
      for (const name of await taskUpstreamAdoptionRefs(
        workspace.repositoryRoot, id, workspace.repositoryKey,
      )) deleting.push({ kind: "upstream_adoption_ref", name, repositoryRoot: workspace.repositoryRoot });
      const waitRef = this.#releaseWaitRef(id, workspace.repositoryRoot);
      if (await gitMaybe(["rev-parse", "--verify", waitRef], { cwd: workspace.repositoryRoot })) {
        deleting.push({ kind: "release_wait_ref", name: waitRef, repositoryRoot: workspace.repositoryRoot });
      }
    }
    for (const reference of references) {
      const repoKey = taskRepositoryKey(reference.projectRoot);
      if (reference.branch) deleting.push({ kind: "branch", name: reference.branch, repositoryRoot: reference.projectRoot });
      deleting.push(
        { kind: "base_ref", name: taskBaseRef(id, repoKey), repositoryRoot: reference.projectRoot },
        { kind: "result_ref", name: taskResultRef(id, repoKey), repositoryRoot: reference.projectRoot },
        { kind: "adoption_ref", name: taskLegacyAdoptionRef(id, repoKey), repositoryRoot: reference.projectRoot },
      );
      for (const name of await taskUpstreamAdoptionRefs(reference.projectRoot, id, repoKey)) {
        deleting.push({ kind: "upstream_adoption_ref", name, repositoryRoot: reference.projectRoot });
      }
      const waitRef = this.#releaseWaitRef(id, reference.projectRoot);
      if (await gitMaybe(["rev-parse", "--verify", waitRef], { cwd: reference.projectRoot })) {
        deleting.push({ kind: "release_wait_ref", name: waitRef, repositoryRoot: reference.projectRoot });
      }
    }
    const uniqueDeleting = [...new Map(deleting.map((item) => [
      `${item.kind}\0${item.repositoryRoot ?? ""}\0${item.path ?? item.name ?? ""}`, item,
    ])).values()];
    return {
      taskId: id,
      workspaces,
      gitReferences: references,
      dirty: workspaces.some((item) => item.dirty),
      unpublished: [...references.filter((item) => !item.published || !item.branchPublished), ...unpublishedWorktrees],
      deleting: uniqueDeleting,
      ...(squashTransfer ? { squashTransfer } : {}),
    };
  }

  async cleanup(taskId, options = {}) {
    this.#assertAvailable("cleanup");
    return this.withTaskLock(taskId, (lease) => this.cleanupOwned(taskId, { ...options, lease }));
  }

  async cleanupOwned(taskId, {
    allowDirty = false, requirePublished = false, gitReferences = [], squashAbsorbedBy = null,
    expectedPreview = null, lease = null,
  } = {}) {
    this.#assertAvailable("cleanupOwned");
    await requiredGuardLease(lease).assertOwned();
    const id = normalizedTaskId(taskId);
    await this.#assertNoProcessTreeGuard(id);
    const root = path.join(this.taskWorktreesRoot, id);
    if (!pathInside(this.taskWorktreesRoot, root)) throw new Error("Task worktree cleanup escaped its managed root");
    const preview = await this.cleanupPreview(id, { gitReferences, squashAbsorbedBy });
    if (expectedPreview) {
      const expectedPublication = JSON.stringify((expectedPreview.gitReferences ?? []).map((item) => ({
        projectRoot: item.projectRoot,
        resultCommit: item.resultCommit,
        publishedRevision: item.publishedRevision,
        publicationGeneration: item.publicationGeneration,
      })));
      const actualPublication = JSON.stringify((preview.gitReferences ?? []).map((item) => ({
        projectRoot: item.projectRoot,
        resultCommit: item.resultCommit,
        publishedRevision: item.publishedRevision,
        publicationGeneration: item.publicationGeneration,
      })));
      if (actualPublication !== expectedPublication) {
        throw new Error("Task cleanup blocked: durable publication generation changed after confirmation");
      }
    }
    const workspaces = preview.workspaces;
    if (!allowDirty && preview.dirty) throw new Error("Task cleanup blocked: managed worktree is dirty");
    if (requirePublished && preview.unpublished.length) {
      throw new Error("Task cleanup blocked: exact result or current branch/worktree head is not contained in published main");
    }
    const repositoryEvidence = (value, repoRoot) => ({
      workspaces: value.workspaces.filter((item) => samePath(item.repositoryRoot, repoRoot)),
      gitReferences: value.gitReferences.filter((item) => samePath(item.projectRoot, repoRoot)),
      deleting: value.deleting.filter((item) => item.repositoryRoot && samePath(item.repositoryRoot, repoRoot)),
    });
    const assertCurrentRepository = async (repoRoot) => {
      const current = await this.cleanupPreview(id, { gitReferences, squashAbsorbedBy });
      if (JSON.stringify(repositoryEvidence(current, repoRoot)) !== JSON.stringify(repositoryEvidence(preview, repoRoot))) {
        throw new Error("Task cleanup blocked: branch or worktree changed after confirmation");
      }
    };
    if (expectedPreview && JSON.stringify(expectedPreview) !== JSON.stringify(preview)) {
      throw new Error("Task cleanup blocked: branch or worktree changed after confirmation");
    }
    const cleanedRepositories = new Set();
    for (const workspace of workspaces) {
      await lease.assertOwned();
      if (!pathInside(root, workspace.projectRoot)) throw new Error("Task worktree is outside its managed Task root");
      const repoRoot = await repositoryRoot(workspace.projectRoot);
      const repoKey = taskRepositoryKey(repoRoot);
      await this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
        await assertCurrentRepository(repoRoot);
        await this.#runOwned(["worktree", "remove", ...(allowDirty ? ["--force"] : []), workspace.projectRoot], {
          cwd: repoRoot, timeoutMs: 120_000, lease: ownedLease,
        });
        await ownedLease.assertOwned();
        if (await branchExists(repoRoot, workspace.branch)) {
          if (await worktreeForBranch(repoRoot, workspace.branch)) throw new Error("Task cleanup blocked: branch is still checked out");
          await this.#runOwned(["update-ref", "-d", `refs/heads/${workspace.branch}`, workspace.headCommit], { cwd: repoRoot, lease: ownedLease });
        }
        await this.#runOwned(["update-ref", "-d", taskBaseRef(id, workspace.repositoryKey)], {
          cwd: repoRoot, lease: ownedLease,
        });
        await this.#runOwned(["update-ref", "-d", taskResultRef(id, workspace.repositoryKey)], {
          cwd: repoRoot, lease: ownedLease,
        });
        await this.#runOwned(["update-ref", "-d", taskLegacyAdoptionRef(id, workspace.repositoryKey)], {
          cwd: repoRoot, lease: ownedLease,
        });
        await this.#runOwned(["update-ref", "-d", this.#releaseWaitRef(id, repoRoot)], { cwd: repoRoot, lease: ownedLease });
        for (const name of await taskUpstreamAdoptionRefs(repoRoot, id, workspace.repositoryKey)) {
          await this.#runOwned(["update-ref", "-d", name], { cwd: repoRoot, lease: ownedLease });
        }
      });
      cleanedRepositories.add(repoKey);
    }
    for (const reference of gitReferences) {
      const repoRoot = canonicalPath(reference.projectRoot);
      const repoKey = taskRepositoryKey(repoRoot);
      if (cleanedRepositories.has(repoKey)) continue;
      await lease.assertOwned();
      const branch = String(reference.branch ?? "").trim();
      await this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
        await assertCurrentRepository(repoRoot);
        if (branch && await branchExists(repoRoot, branch)) {
          if (await worktreeForBranch(repoRoot, branch)) throw new Error("Task cleanup blocked: branch is still checked out");
          const expectedHead = preview.gitReferences.find((item) => samePath(item.projectRoot, repoRoot) && item.branch === branch)?.branchHeadCommit;
          if (!expectedHead) throw new Error("Task cleanup blocked: branch appeared after confirmation");
          await this.#runOwned(["update-ref", "-d", `refs/heads/${branch}`, expectedHead], { cwd: repoRoot, lease: ownedLease });
        }
        await this.#runOwned(["update-ref", "-d", taskBaseRef(id, repoKey)], {
          cwd: repoRoot, lease: ownedLease,
        });
        await this.#runOwned(["update-ref", "-d", taskResultRef(id, repoKey)], {
          cwd: repoRoot, lease: ownedLease,
        });
        await this.#runOwned(["update-ref", "-d", taskLegacyAdoptionRef(id, repoKey)], {
          cwd: repoRoot, lease: ownedLease,
        });
        await this.#runOwned(["update-ref", "-d", this.#releaseWaitRef(id, repoRoot)], { cwd: repoRoot, lease: ownedLease });
        for (const name of await taskUpstreamAdoptionRefs(repoRoot, id, repoKey)) {
          await this.#runOwned(["update-ref", "-d", name], { cwd: repoRoot, lease: ownedLease });
        }
      });
    }
    await lease.assertOwned();
    // Only known owned worktrees were removed above. Never sweep an unexpected
    // directory, detached checkout or late file together with the parent.
    await rmdir(root).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return { taskId: id, removed: workspaces.length, preview };
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
