import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { canonicalPath } from "./config.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import { readPublicationState } from "../persistence/publication-state.mjs";
import {
  normalizedTaskId,
  TASK_BRANCH_PREFIX,
  taskBranchName,
  taskRepositoryKey,
} from "../../domain/task-git-reference.mjs";

export const TASK_DEV_BRANCH = "dev";
const TASK_BASE_REF_PREFIX = "refs/agent-hub/task-bases/";
const TASK_LEGACY_ADOPTION_REF_PREFIX = "refs/agent-hub/legacy-adoptions/";
const TASK_RESULT_REF_PREFIX = "refs/agent-hub/task-results/";

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

function taskGitTerminationError(args, timeoutMs, processTreeStopped, cause = "timed out") {
  const error = new Error(processTreeStopped
    ? `git ${args[0]} ${cause} after ${timeoutMs} ms; process tree stopped`
    : `git ${args[0]} ${cause} after ${timeoutMs} ms; process tree stop is unproven`);
  error.processTreeStopped = processTreeStopped;
  error.code = processTreeStopped ? "TASK_GIT_TERMINATED" : "TASK_GIT_TREE_UNPROVEN";
  return error;
}

export function runTaskGitCommand(args, {
  cwd, timeoutMs = 60_000, executable = "git", spawnProcess = spawn, signal = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Task Git lease ownership was lost"));
      return;
    }
    const child = spawnProcess(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
          settle(() => reject(taskGitTerminationError(args, timeoutMs, false, cause)));
          return;
        }
        if (settled) return;
        if (childClosed) {
          settle(() => reject(taskGitTerminationError(args, timeoutMs, true, cause)));
          return;
        }
        stopTimer = setTimeout(() => settle(() => reject(
          taskGitTerminationError(args, timeoutMs, true, cause),
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
      if (termination) settle(() => reject(taskGitTerminationError(args, timeoutMs, terminationOutcome, termination)));
      else if (code === 0) settle(() => resolve(output));
      else settle(() => reject(new Error(errorText || `git ${args[0]} exited with ${code}`)));
    });
  });
}

function runGitWithInput(args, input, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(input);
  });
}

const runGit = runTaskGitCommand;

function requiredGuardLease(lease) {
  if (typeof lease?.assertOwned !== "function" || typeof lease?.beginProcessTreeGuard !== "function") {
    throw new Error("Task Git mutation requires an owned process-tree guard lease");
  }
  return lease;
}

function combinedLease(primary, secondary) {
  requiredGuardLease(primary);
  if (typeof secondary?.assertOwned !== "function") throw new Error("Task Git dev lock lease is required");
  const signals = [primary.signal, secondary.signal].filter(Boolean);
  return {
    ...primary,
    ownerId: `${primary.ownerId}|${secondary.ownerId}`,
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

function taskResultRef(taskId, repoKey) {
  return `${TASK_RESULT_REF_PREFIX}${normalizedTaskId(taskId)}/${repoKey}`;
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
  return {
    relativePath,
    cone: Boolean(relativePath),
    scope: relativePath ? relativePath.split(path.sep).join("/") : "/*",
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

async function localMainCommit(repositoryRootValue) {
  return runGit(["rev-parse", "--verify", "refs/heads/main^{commit}"], { cwd: repositoryRootValue });
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
  await runOwnedGit(["add", "--sparse", "-A", "--", "."], { cwd: worktreeRoot, lease });
  if (await gitMaybe(["diff", "--cached", "--quiet"], { cwd: worktreeRoot }) !== null) return false;
  await runOwnedGit([
    "-c", "user.name=Agent Hub",
    "-c", "user.email=agent-hub@local.invalid",
    "commit", "--no-gpg-sign", "-m", message,
  ], { cwd: worktreeRoot, timeoutMs: 120_000, lease });
  return true;
}

export class TaskGitWorkspaceService {
  constructor({
    dataDir, devBranch = TASK_DEV_BRANCH, readPublication = readPublicationState,
    runCommand = runTaskGitCommand,
  } = {}) {
    this.dataDir = canonicalPath(String(dataDir ?? ""));
    this.taskWorktreesRoot = path.join(this.dataDir, "task-worktrees");
    this.devWorktreesRoot = path.join(this.dataDir, "dev-worktrees");
    this.devBranch = String(devBranch ?? TASK_DEV_BRANCH).trim() || TASK_DEV_BRANCH;
    this.readPublication = readPublication;
    this.runCommand = runCommand;
  }

  async #runOwned(args, { lease = null, ...options } = {}) {
    const owner = requiredGuardLease(lease);
    await owner.assertOwned();
    const guard = await owner.beginProcessTreeGuard({ args, cwd: options.cwd });
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

  #taskLock(taskId) {
    return path.join(this.dataDir, "locks", `task-lifecycle-${normalizedTaskId(taskId)}`);
  }

  #processGuardDirectory(taskId) {
    return path.join(this.dataDir, "task-process-tree-guards", normalizedTaskId(taskId));
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
        if (guard?.repositoryRoot && samePath(guard.repositoryRoot, repositoryRootValue)) {
          throw new Error(`Task Git repository blocked: unresolved process-tree guard requires operator proof (${file})`);
        }
      }
    }
  }

  async #beginProcessTreeGuard(taskId, lease, { args, cwd } = {}, state) {
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
    return withInterprocessLocks([this.#taskLock(taskId)], async (lease) => {
      await this.#assertNoProcessTreeGuard(taskId);
      return operation(this.#guardedLease(taskId, lease));
    }, options);
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
    const devLock = path.join(this.dataDir, "locks", `task-git-dev-${repoKey}`);
    return withInterprocessLocks([devLock], async (devLease) => {
      const lease = outerLease
        ? combinedLease(outerLease, devLease)
        : this.#guardedLease(`repository-${repoKey}`, devLease);
      return operation(lease);
    });
  }

  async recoverProcessTreeGuard(taskId, { repositoryRoot: root, operatorProof } = {}) {
    if (operatorProof !== "confirmed-no-descendants") {
      throw new Error("Task Git process-tree guard recovery requires explicit operator proof");
    }
    const file = path.join(
      this.#processGuardDirectory(taskId),
      `${taskRepositoryKey(canonicalPath(root))}.json`,
    );
    const guard = await readFile(file, "utf8").then(JSON.parse, () => null);
    if (!guard?.guardId || !samePath(guard.repositoryRoot, root)) {
      throw new Error("Task Git process-tree guard does not match the proved repository");
    }
    await unlink(file);
    return { recovered: true, guard };
  }

  async #integrationBlockFile(repoRoot) {
    return path.join(this.dataDir, "integration-blocks", `${taskRepositoryKey(repoRoot)}.json`);
  }

  async #assertRecoverableDev(repoRoot, devRoot, { lease = null } = {}) {
    await requiredGuardLease(lease).assertOwned();
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

  async #ensureSparseTaskWorktree({ worktreeRoot: root, selection, created, lease = null }) {
    const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
    const [branchBefore, headBefore, statusBefore] = await Promise.all([
      runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }),
      runGit(["rev-parse", "HEAD^{commit}"], { cwd: root }),
      runGit(statusArgs, { cwd: root }),
    ]);
    await this.#runOwned([
      "sparse-checkout", "set", selection.cone ? "--cone" : "--no-cone", "--", selection.scope,
    ], {
      cwd: root,
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
    const scopes = configured.split(/\r?\n/u).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== selection.scope) {
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

  async #prepareDevOwned(projectRoot, repoRoot, lease) {
    await requiredGuardLease(lease).assertOwned();
    const mainCommit = await preferredMainCommit(repoRoot);
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
    return {
      repositoryRoot: repoRoot,
      projectRoot: devRoot,
      branch: this.devBranch,
      headCommit: await this.#runOwned(["rev-parse", "HEAD^{commit}"], { cwd: devRoot, lease }),
    };
  }

  async prepareDev(projectRoot) {
    const repoRoot = await repositoryRoot(projectRoot);
    await this.#assertRepositoryProcessTreeClear(repoRoot);
    return this.#withDevLock(repoRoot, null, (lease) => this.#prepareDevOwned(projectRoot, repoRoot, lease));
  }

  async prepare(params = {}) {
    return this.withTaskLock(params.taskId, (lease) => this.prepareOwned({ ...params, lease }));
  }

  async prepareOwned({ taskId, taskNumber = null, projectRoot, lease = null } = {}) {
    const id = normalizedTaskId(taskId);
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(id);
    const selectedRoot = canonicalPath(projectRoot);
    const selectedWorktreeRoot = await worktreeRoot(selectedRoot);
    const selection = taskSparseCheckoutSelection(selectedWorktreeRoot, selectedRoot);
    const repoRoot = await repositoryRoot(projectRoot);
    await this.#assertRepositoryProcessTreeClear(repoRoot);
    return this.#withDevLock(repoRoot, lease, async (ownedLease) => {
    const dev = await this.#prepareDevOwned(projectRoot, repoRoot, ownedLease);
    const repoKey = taskRepositoryKey(dev.repositoryRoot);
    const branch = taskBranchName(id, dev.repositoryRoot, taskNumber);
    const baseRef = taskBaseRef(id, repoKey);
    let baseCommit = await gitMaybe(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: dev.repositoryRoot });
    if (!baseCommit) {
      baseCommit = await preferredMainCommit(dev.repositoryRoot);
      await this.#runOwned(["update-ref", baseRef, baseCommit], { cwd: dev.repositoryRoot, lease: ownedLease });
    }
    const taskRootPath = path.join(this.taskWorktreesRoot, id, repoKey);
    await this.#alignExistingTaskBranch({
      repositoryRoot: dev.repositoryRoot,
      worktreeRoot: taskRootPath,
      branch,
      lease: ownedLease,
    });
    const taskWorktree = await this.#ensureBranchWorktree({
      repositoryRoot: dev.repositoryRoot,
      branch,
      worktreeRoot: taskRootPath,
      managedRoot: path.join(this.taskWorktreesRoot, id),
      startCommit: baseCommit,
      noCheckout: true,
      lease: ownedLease,
    });
    const taskRoot = taskWorktree.root;
    await this.#ensureSparseTaskWorktree({
      worktreeRoot: taskRoot,
      selection,
      created: taskWorktree.created,
      lease: ownedLease,
    });
    const scopedProjectRoot = canonicalPath(path.resolve(taskRoot, selection.relativePath));
    if (!pathInside(taskRoot, scopedProjectRoot)) {
      throw new Error("Task project root escaped its managed worktree");
    }
    const headCommit = await this.#runOwned(["rev-parse", "HEAD^{commit}"], { cwd: taskRoot, lease: ownedLease });
    return {
      taskId: id,
      repositoryRoot: dev.repositoryRoot,
      projectRoot: scopedProjectRoot,
      branch,
      baseRef,
      baseCommit,
      headCommit,
      gitBaseline: { repoRoot: dev.repositoryRoot, tree: baseCommit },
    };
    });
  }

  async managedRepositoryRoot(projectRoot, { taskId, taskNumber = null } = {}) {
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
    return this.withTaskLock(params.taskId, (lease) => this.snapshotOwned({ ...params, lease }));
  }

  async snapshotOwned({ taskId, taskNumber = null, projectRoot, turnId = null, summary = "", lease = null } = {}) {
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(taskId);
    const workspace = await this.prepareOwned({ taskId, taskNumber, projectRoot, lease });
    const taskRoot = await worktreeRoot(workspace.projectRoot);
    const suffix = String(turnId ?? "").trim() || randomUUID();
    await commitDirtyWorktree(
      taskRoot,
      `task(${workspace.taskId.slice(0, 8)}): ${String(summary ?? "").trim() || `snapshot ${suffix}`}`,
      { lease },
    );
    const headCommit = await this.#runOwned(["rev-parse", "HEAD^{commit}"], { cwd: taskRoot, lease });
    const diff = await this.#runOwned([
      "-c", "core.quotePath=false",
      "diff", "--name-status", "--find-renames", workspace.baseCommit, headCommit, "--",
    ], { cwd: taskRoot, lease });
    return {
      ...workspace,
      headCommit,
      changedFiles: changedFilesFromNameStatus(diff, workspace.repositoryRoot),
      resultSnapshot: { repoRoot: workspace.repositoryRoot, tree: headCommit },
    };
  }

  async mergeIntoDev(snapshot) {
    return this.withTaskLock(snapshot.taskId, (lease) => this.mergeIntoDevOwned(snapshot, { lease }));
  }

  async mergeIntoDevOwned(snapshot, { lease = null } = {}) {
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(snapshot.taskId);
    await this.#assertRepositoryProcessTreeClear(snapshot.repositoryRoot);
    return this.#withDevLock(snapshot.repositoryRoot, lease, async (ownedLease) => {
      const dev = await this.#prepareDevOwned(snapshot.repositoryRoot, snapshot.repositoryRoot, ownedLease);
      const isMerged = await gitMaybe(["merge-base", "--is-ancestor", snapshot.headCommit, "HEAD"], {
        cwd: dev.projectRoot,
      }) !== null;
      if (isMerged) return { integrated: true, alreadyIntegrated: true, dev };
      try {
        await ownedLease.assertOwned();
        await this.#runOwned([
          "-c", "user.name=Agent Hub",
          "-c", "user.email=agent-hub@local.invalid",
          "merge", "--no-ff", "--no-edit", snapshot.headCommit,
        ], { cwd: dev.projectRoot, timeoutMs: 120_000, lease: ownedLease });
        await ownedLease.assertOwned();
        return {
          integrated: true,
          alreadyIntegrated: false,
          dev: { ...dev, headCommit: await this.#runOwned(["rev-parse", "HEAD^{commit}"], { cwd: dev.projectRoot, lease: ownedLease }) },
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
        try {
          await this.#assertRecoverableDev(dev.repositoryRoot, dev.projectRoot, { lease: ownedLease });
        } catch (recoveryError) {
          throw new Error(`${error.message}; integration recovery failed: ${recoveryError.message}`);
        }
        if (!aborted && conflicts.length) {
          throw new Error(`${error.message}; merge --abort did not complete`);
        }
        return { integrated: false, conflicts, error: error.message, dev };
      }
    });
  }

  async reconcile({ projectRoots = [] } = {}) {
    const repositories = [];
    for (const registration of projectRoots) {
      const projectRoot = typeof registration === "string" ? registration : registration?.projectRoot;
      if (!projectRoot) continue;
      try {
        const repoRoot = await repositoryRoot(projectRoot);
        await this.#assertRepositoryProcessTreeClear(repoRoot);
        const devRoot = await worktreeForBranch(repoRoot, this.devBranch);
        if (!devRoot) {
          repositories.push({ projectRoot, repositoryRoot: repoRoot, status: "ready", devRoot: null });
          continue;
        }
        if (!pathInside(this.devWorktreesRoot, devRoot)) {
          repositories.push({ projectRoot, repositoryRoot: repoRoot, status: "external", devRoot });
          continue;
        }
        await this.#withDevLock(repoRoot, null, (lease) => (
          this.#assertRecoverableDev(repoRoot, devRoot, { lease })
        ));
        repositories.push({ projectRoot, repositoryRoot: repoRoot, status: "ready", devRoot });
      } catch (error) {
        repositories.push({ projectRoot, status: "blocked", reason: error.message });
      }
    }
    return { repositories };
  }

  async snapshotAndMerge(params = {}) {
    return this.withTaskLock(params.taskId, (lease) => this.snapshotAndMergeOwned({ ...params, lease }));
  }

  async snapshotAndMergeOwned(params = {}) {
    await requiredGuardLease(params.lease).assertOwned();
    await this.#assertNoProcessTreeGuard(params.taskId);
    const snapshot = await this.snapshotOwned(params);
    await params.lease.assertOwned();
    if (!snapshot.changedFiles.length) {
      const dev = await this.#withDevLock(snapshot.repositoryRoot, params.lease, (ownedLease) => (
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
      await this.#runOwned([
        "update-ref",
        taskResultRef(snapshot.taskId, taskRepositoryKey(snapshot.repositoryRoot)),
        snapshot.headCommit,
      ], { cwd: snapshot.repositoryRoot, lease: params.lease });
      await params.lease.assertOwned();
    }
    return { snapshot, integration: { ...integration, outcome: integration.integrated ? "integrated" : "conflict", resultProved: integration.integrated } };
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
      resultCommit: acceptedCommit,
      changedFiles: changedFilesFromNameStatus(diff, repoRoot),
    };
  }

  async adoptLegacyResult({
    taskId, taskNumber = null, projectRoot, reportedResultCommit, mainResultCommit,
  } = {}) {
    const id = normalizedTaskId(taskId);
    const repoRoot = await repositoryRoot(projectRoot);
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
        await runGit(["reset", "--hard", adoptedCommit], { cwd: taskWorktree, timeoutMs: 120_000 });
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
      await runGitWithInput(["update-ref", "--stdin"], `start\n${updates.join("\n")}\nprepare\ncommit\n`, {
        cwd: repoRoot,
      });
    }
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

  async cleanupPreview(taskId, { gitReferences = [] } = {}) {
    const id = normalizedTaskId(taskId);
    const workspaces = await this.describe(id);
    const references = [];
    const publication = await this.readPublication();
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
      references.push({
        ...reference,
        projectRoot: repoRoot,
        resultCommit,
        published,
        publishedRevision,
        publicationGeneration: publishedRevision ? durableGeneration : null,
      });
    }
    const deleting = workspaces.flatMap((workspace) => [
      { kind: "worktree", path: workspace.projectRoot },
      { kind: "branch", name: workspace.branch, repositoryRoot: workspace.repositoryRoot },
      { kind: "base_ref", name: taskBaseRef(id, workspace.repositoryKey), repositoryRoot: workspace.repositoryRoot },
      { kind: "result_ref", name: taskResultRef(id, workspace.repositoryKey), repositoryRoot: workspace.repositoryRoot },
    ]);
    for (const reference of references) {
      const repoKey = taskRepositoryKey(reference.projectRoot);
      if (reference.branch) deleting.push({ kind: "branch", name: reference.branch, repositoryRoot: reference.projectRoot });
      deleting.push(
        { kind: "base_ref", name: taskBaseRef(id, repoKey), repositoryRoot: reference.projectRoot },
        { kind: "result_ref", name: taskResultRef(id, repoKey), repositoryRoot: reference.projectRoot },
      );
    }
    const uniqueDeleting = [...new Map(deleting.map((item) => [
      `${item.kind}\0${item.repositoryRoot ?? ""}\0${item.path ?? item.name ?? ""}`, item,
    ])).values()];
    return {
      taskId: id,
      workspaces,
      gitReferences: references,
      dirty: workspaces.some((item) => item.dirty),
      unpublished: references.filter((item) => !item.published),
      deleting: uniqueDeleting,
    };
  }

  async cleanup(taskId, options = {}) {
    return this.withTaskLock(taskId, (lease) => this.cleanupOwned(taskId, { ...options, lease }));
  }

  async cleanupOwned(taskId, {
    allowDirty = false, requirePublished = false, gitReferences = [], expectedPreview = null, lease = null,
  } = {}) {
    await requiredGuardLease(lease).assertOwned();
    const id = normalizedTaskId(taskId);
    await this.#assertNoProcessTreeGuard(id);
    const root = path.join(this.taskWorktreesRoot, id);
    if (!pathInside(this.taskWorktreesRoot, root)) throw new Error("Task worktree cleanup escaped its managed root");
    const preview = await this.cleanupPreview(id, { gitReferences });
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
      throw new Error("Task cleanup blocked: exact result commit is not contained in published main");
    }
    const cleanedRepositories = new Set();
    for (const workspace of workspaces) {
      await lease.assertOwned();
      if (!pathInside(root, workspace.projectRoot)) throw new Error("Task worktree is outside its managed Task root");
      const repoRoot = await repositoryRoot(workspace.projectRoot);
      const repoKey = taskRepositoryKey(repoRoot);
      await this.#runOwned(["worktree", "remove", "--force", workspace.projectRoot], {
        cwd: repoRoot, timeoutMs: 120_000, lease,
      });
      await lease.assertOwned();
      if (await branchExists(repoRoot, workspace.branch)) {
        await this.#runOwned(["branch", "-D", workspace.branch], { cwd: repoRoot, lease });
      }
      await this.#runOwned(["update-ref", "-d", taskBaseRef(id, workspace.repositoryKey)], { cwd: repoRoot, lease });
      await this.#runOwned(["update-ref", "-d", taskResultRef(id, workspace.repositoryKey)], { cwd: repoRoot, lease });
      cleanedRepositories.add(repoKey);
    }
    for (const reference of gitReferences) {
      const repoRoot = canonicalPath(reference.projectRoot);
      const repoKey = taskRepositoryKey(repoRoot);
      if (cleanedRepositories.has(repoKey)) continue;
      await lease.assertOwned();
      const branch = String(reference.branch ?? "").trim();
      if (branch && await branchExists(repoRoot, branch)) {
        await this.#runOwned(["branch", "-D", branch], { cwd: repoRoot, lease });
      }
      await this.#runOwned(["update-ref", "-d", taskBaseRef(id, repoKey)], { cwd: repoRoot, lease });
      await this.#runOwned(["update-ref", "-d", taskResultRef(id, repoKey)], { cwd: repoRoot, lease });
    }
    await lease.assertOwned();
    await rm(root, { recursive: true, force: true });
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
