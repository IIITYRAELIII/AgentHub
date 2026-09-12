import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertContourExternalEffects, assertContourGitAvailable } from "../../ports/contour-external-effects.mjs";
import process from "node:process";

import { canonicalPath } from "./config.mjs";
import { prepareTaskWorktreeDependencies } from "./task-worktree-dependencies.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import {
  isTrustedWindowsPowerShellPath,
  readTrustedSystemBootIdentity,
} from "../process/system-boot-identity.mjs";
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
  commandLabel = "git",
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

  async #runOwned(args, { lease = null, guardCommand = null, ...options } = {}) {
    const owner = requiredGuardLease(lease);
    await owner.assertOwned();
    const guard = await owner.beginProcessTreeGuard({ args: guardCommand ?? args, cwd: options.cwd });
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
    this.#assertAvailable("withTaskLock");
    return withInterprocessLocks([this.#taskLock(taskId)], async (lease) => {
      await this.#assertNoProcessTreeGuard(taskId);
      return operation(this.#guardedLease(taskId, lease));
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
    const mergeHeadPath = path.resolve(await runGit(["rev-parse", "--git-path", "MERGE_HEAD"], { cwd: root }));
    const mergeHead = await readFile(mergeHeadPath, "utf8").then((value) => value.trim(), () => null);
    if (!created && mergeHead) {
      const devHead = await runGit(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], { cwd: root });
      if (mergeHead !== devHead) {
        throw new Error("Task snapshot has a merge parent other than the exact managed dev head");
      }
      const configured = await runGit(["sparse-checkout", "list"], { cwd: root });
      const scopes = configured.split(/\r?\n/u).filter(Boolean);
      if (scopes.length !== 1 || scopes[0] !== selection.scope) {
        throw new Error(`Task sparse-checkout scope mismatch: expected ${selection.scope}, got ${configured || "<empty>"}`);
      }
      return;
    }
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

  async #refreshPreferredMainCommit(repoRoot, lease) {
    await requiredGuardLease(lease).assertOwned();
    const origin = await gitMaybe(["remote", "get-url", "origin"], { cwd: repoRoot });
    if (origin) {
      await this.#runOwned([
        "-c", "remote.origin.tagOpt=--no-tags",
        "-c", "fetch.recurseSubmodules=false",
        "fetch", "--no-tags", "--no-recurse-submodules",
        "origin", "+refs/heads/main:refs/remotes/origin/main",
      ], { cwd: repoRoot, timeoutMs: 300_000, lease });
      return this.#runOwned([
        "rev-parse", "--verify", "refs/remotes/origin/main^{commit}",
      ], { cwd: repoRoot, lease });
    }
    return preferredMainCommit(repoRoot);
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

  async #synchronizeMainIntoDevOwned({
    repoRoot, expectedMainCommit = null, observedMainCommit = null, lease,
  }) {
    await requiredGuardLease(lease).assertOwned();
    const repoKey = taskRepositoryKey(repoRoot);
    const mainCommit = observedMainCommit ?? await this.#refreshPreferredMainCommit(repoRoot, lease);
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
    try {
      await lease.assertOwned();
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

  async prepareDev(projectRoot) {
    this.#assertAvailable("prepareDev");
    const synchronization = await this.synchronizeMainIntoDev({ projectRoot });
    if (!synchronization.integrated) {
      const conflicts = synchronization.conflicts?.length
        ? `; conflicts: ${synchronization.conflicts.join(", ")}`
        : "";
      throw new Error(`main to dev synchronization requires manual resolution: ${synchronization.reason}${conflicts}`);
    }
    return synchronization;
  }

  async synchronizeMainIntoDev({ projectRoot, publishedRevision = null } = {}) {
    this.#assertAvailable("synchronizeMainIntoDev");
    const repoRoot = await repositoryRoot(projectRoot);
    await this.#assertRepositoryProcessTreeClear(repoRoot);
    return this.#withDevLock(repoRoot, null, (lease) => this.#synchronizeMainIntoDevOwned({
      repoRoot,
      expectedMainCommit: publishedRevision,
      lease,
    }));
  }

  async prepare(params = {}) {
    this.#assertAvailable("prepare");
    return this.withTaskLock(params.taskId, (lease) => this.prepareOwned({ ...params, lease }));
  }

  async prepareOwned({ taskId, taskNumber = null, projectRoot, lease = null } = {}) {
    this.#assertAvailable("prepareOwned");
    const id = normalizedTaskId(taskId);
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(id);
    const selectedRoot = canonicalPath(projectRoot);
    const selectedWorktreeRoot = await worktreeRoot(selectedRoot);
    const selection = taskSparseCheckoutSelection(selectedWorktreeRoot, selectedRoot);
    const repoRoot = await repositoryRoot(projectRoot);
    await this.#assertRepositoryProcessTreeClear(repoRoot);
    return this.#withDevLock(repoRoot, lease, async (ownedLease) => {
      const repoKey = taskRepositoryKey(repoRoot);
      const branch = taskBranchName(id, repoRoot, taskNumber);
      const baseRef = taskBaseRef(id, repoKey);
      let baseCommit = await gitMaybe(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: repoRoot });
      let dev;
      if (!baseCommit) {
        dev = await this.#synchronizeMainIntoDevOwned({ repoRoot, lease: ownedLease });
        if (!dev.integrated) {
          const conflicts = dev.conflicts?.length ? `; conflicts: ${dev.conflicts.join(", ")}` : "";
          throw new Error(`main to dev synchronization requires manual resolution: ${dev.reason}${conflicts}`);
        }
        baseCommit = dev.mainCommit;
        await this.#runOwned(["update-ref", baseRef, baseCommit], { cwd: repoRoot, lease: ownedLease });
      } else {
        dev = await this.#prepareDevOwned(projectRoot, repoRoot, ownedLease);
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
        worktreeRoot: taskRoot,
        selection,
        created: taskWorktree.created,
        lease: ownedLease,
      });
      const scopedProjectRoot = canonicalPath(path.resolve(taskRoot, selection.relativePath));
      if (!pathInside(taskRoot, scopedProjectRoot)) {
        throw new Error("Task project root escaped its managed worktree");
      }
      const lockfiles = await trackedNpmLockfiles(taskRoot, scopedProjectRoot);
      const dependencyLock = path.join(this.dataDir, "locks", `task-dependencies-${id}-${repoKey}`);
      if (lockfiles.length > 0) {
        await withInterprocessLocks([dependencyLock], async (dependencyLease) => {
          const taskDependencyLease = combinedLease(ownedLease, dependencyLease);
          await taskDependencyLease.assertOwned();
          await this.prepareDependencies({
            projectRoot: scopedProjectRoot,
            lockfiles,
            lease: taskDependencyLease,
            runNpm: (args, options) => this.#runOwnedNpm(args, {
              ...options,
              lease: taskDependencyLease,
            }),
          });
          await taskDependencyLease.assertOwned();
        });
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
    this.#assertAvailable("mergeIntoDev");
    return this.withTaskLock(snapshot.taskId, (lease) => this.mergeIntoDevOwned(snapshot, { lease }));
  }

  async mergeIntoDevOwned(snapshot, { lease = null } = {}) {
    this.#assertAvailable("mergeIntoDevOwned");
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(snapshot.taskId);
    await this.#assertRepositoryProcessTreeClear(snapshot.repositoryRoot);
    return this.#withDevLock(snapshot.repositoryRoot, lease, async (ownedLease) => {
      let dev = await this.#prepareDevOwned(snapshot.repositoryRoot, snapshot.repositoryRoot, ownedLease);
      let devHeadBefore = dev.headCommit;
      let statusBefore = await runGit([
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
      ], { cwd: dev.projectRoot });
      const mainCommit = await this.#refreshPreferredMainCommit(snapshot.repositoryRoot, ownedLease);
      const snapshotContainsMain = await gitMaybe([
        "merge-base", "--is-ancestor", mainCommit, snapshot.headCommit,
      ], { cwd: dev.projectRoot }) !== null;
      const snapshotContainsDev = await gitMaybe([
        "merge-base", "--is-ancestor", devHeadBefore, snapshot.headCommit,
      ], { cwd: dev.projectRoot }) !== null;
      if (snapshotContainsMain && snapshotContainsDev) {
        dev = {
          ...dev,
          status: "bootstrap_ready",
          mainCommit,
          devHeadBefore,
          headCommit: devHeadBefore,
        };
      } else {
        dev = await this.#synchronizeMainIntoDevOwned({
          repoRoot: snapshot.repositoryRoot,
          observedMainCommit: mainCommit,
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
          error: error.message,
          dev: { ...dev, headCommit },
        };
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
    this.#assertAvailable("snapshotAndMerge");
    return this.withTaskLock(params.taskId, (lease) => this.snapshotAndMergeOwned({ ...params, lease }));
  }

  async snapshotAndMergeOwned(params = {}) {
    this.#assertAvailable("snapshotAndMergeOwned");
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

  async releaseIntegrationEvidence({ projectRoot, tasks = [] } = {}) {
    this.#assertAvailable("releaseIntegrationEvidence");
    const dev = await this.prepareDev(projectRoot);
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
      const resultIntegrated = await gitMaybe([
        "merge-base", "--is-ancestor", evidence.resultCommit, dev.headCommit,
      ], { cwd: dev.projectRoot }) !== null;
      if (!resultIntegrated) {
        throw new Error(`Task result commit ${evidence.resultCommit} is not integrated into dev ${dev.headCommit}`);
      }
      if (!integrations.length) {
        const mainCommit = await preferredMainCommit(evidence.projectRoot);
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
        resultCommit: evidence.resultCommit,
        integrations,
        lineage,
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
    await this.#assertRepositoryProcessTreeClear(repoRoot);
    return this.#withDevLock(repoRoot, lease, async (ownedLease) => {
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

  async cleanupPreview(taskId, { gitReferences = [] } = {}) {
    this.#assertAvailable("cleanupPreview");
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
      { kind: "adoption_ref", name: taskLegacyAdoptionRef(id, workspace.repositoryKey), repositoryRoot: workspace.repositoryRoot },
    ]);
    for (const reference of references) {
      const repoKey = taskRepositoryKey(reference.projectRoot);
      if (reference.branch) deleting.push({ kind: "branch", name: reference.branch, repositoryRoot: reference.projectRoot });
      deleting.push(
        { kind: "base_ref", name: taskBaseRef(id, repoKey), repositoryRoot: reference.projectRoot },
        { kind: "result_ref", name: taskResultRef(id, repoKey), repositoryRoot: reference.projectRoot },
        { kind: "adoption_ref", name: taskLegacyAdoptionRef(id, repoKey), repositoryRoot: reference.projectRoot },
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
    this.#assertAvailable("cleanup");
    return this.withTaskLock(taskId, (lease) => this.cleanupOwned(taskId, { ...options, lease }));
  }

  async cleanupOwned(taskId, {
    allowDirty = false, requirePublished = false, gitReferences = [], expectedPreview = null, lease = null,
  } = {}) {
    this.#assertAvailable("cleanupOwned");
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
      await this.#runOwned(["update-ref", "-d", taskLegacyAdoptionRef(id, workspace.repositoryKey)], { cwd: repoRoot, lease });
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
      await this.#runOwned(["update-ref", "-d", taskLegacyAdoptionRef(id, repoKey)], { cwd: repoRoot, lease });
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
