import { ownedGitArguments } from "./preparation-git-isolation.mjs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access, chmod, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, rmdir,
  stat, symlink, unlink, writeFile, realpath,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { assertContourExternalEffects, assertContourGitAvailable } from "../../ports/contour-external-effects.mjs";
import process from "node:process";

import { normalizePublishedResolution } from "./selected-composition-proof.mjs";
import { verifyCleanupPreservation } from "./cleanup-preservation.mjs";
import { selectedCompositionFields, selectedCompositionIdentity, selectedCompositionRequiredError,
  normalizedSelectedAbsorption, selectedAbsorptionHandoff } from "../../domain/task-selected-composition.mjs";
import { readSelectedCheckoutAuthority, verifySelectedCompositionFiles, verifySelectedCompositionRecord }
  from "./selected-composition-materializer.mjs";
import { canonicalPath } from "./config.mjs";
import { taskWorkingTreeDiff } from "./task-git-diff.mjs";
import * as legacySelectedV1 from "./legacy-selected-composition-materializer-v1.mjs";
import { mergeSelectedResults, assertNativeTaskHistories } from "./native-release-merge.mjs";
import { NativeMergeTransportRetention } from "./native-merge-transport-retention.mjs";
import { installedNativeHistoryBaseline, assertInstalledLocalSourceBaseline,
  assertInstalledAgreedMainOrigin, assertOwnGitPublicationOrigin, publishedMetadataContext } from "./local-source-baseline.mjs";
import { readNativeUpstreamAdoptions, assertNativeUpstreamOrigin } from "./native-upstream-adoption.mjs";
import {
  applySelectedCompositionFiles, prepareSelectedCompositionFiles, readSelectedCompositionFiles,
  selectedCompositionFilePlan,
} from "./selected-composition-materializer.mjs";
import { TaskDependencyPendingError, TaskClaimLockAdmissionError } from "../../domain/task-board-task.mjs";
import { prepareTaskWorktreeDependencies } from "./task-worktree-dependencies.mjs";
import { readClaimCustodyWip, copyClaimCustodyWip } from "./claim-source-custody.mjs";
import { claimCustodyHash } from "../../domain/claim-forward-custody.mjs";
import { readDirectTaskPublication } from "./direct-task-publication.mjs";
import { withInterprocessLocks as acquireInterprocessLocks, interprocessLockAdmissionTimeoutPath } from "../process/interprocess-lock.mjs";
import {
  measureTaskOperation, measureTaskOperationAwait, recordTaskOperationTiming, withTaskOperationTiming,
} from "../process/task-operation-timing.mjs";
import {
  isTrustedWindowsPowerShellPath,
  readTrustedSystemBootIdentity,
} from "../process/system-boot-identity.mjs";
import { publicationStateRepositories, readPublicationState } from "../persistence/publication-state.mjs";
import { parseGitHubRemote, sourceOnlyGitPublication } from "../persistence/github-publication-baseline.mjs";
import { readNativePublishedSelectedComposition, readOwnGitPublicationOrigin, readPublishedReleaseServiceGeneration } from "../persistence/release-operation-store.mjs";
import {
  normalizedTaskId,
  TASK_BRANCH_PREFIX,
  TaskGitHistoryRejectedError,
  taskBranchName,
  taskRepositoryKey,
} from "../../domain/task-git-reference.mjs";
import {
  exactCrLfToLfNormalization,
  LF_NORMALIZATION_ALREADY_PRESENT,
  normalizedTaskSquashTransfer,
} from "../../domain/task-squash-transfer.mjs";
import { normalizedTaskSquashCutover } from "../../domain/task-squash-cutover.mjs";

export const TASK_DEV_BRANCH = "dev";
const TASK_BASE_REF_PREFIX = "refs/agent-hub/task-bases/";
const TASK_LEGACY_ADOPTION_REF_PREFIX = "refs/agent-hub/legacy-adoptions/";
const TASK_RESULT_REF_PREFIX = "refs/agent-hub/task-results/";
const TASK_UPSTREAM_ADOPTION_REF_PREFIX = "refs/agent-hub/upstream-adoptions/";
const MAX_UPSTREAM_ADOPTION_PROOFS = 512;
const HISTORICAL_ADOPTION_RECOVERY_KIND = "missing-provenance-recovery-v1";
const HISTORICAL_ADOPTION_VALIDATION = "historical-immutable-v1";
const LEGACY_CLAIM_REPOSITORY_GUARD_NO_EFFECT_VERSION = "task-git-repository-guard-before-dev-lock-v1";
const CLAIM_REPOSITORY_GUARD_NO_EFFECT_VERSION = "task-git-repository-guard-under-dev-lock-v2";
const CLAIM_REPOSITORY_GUARD_ERROR_PREFIX = "Task Git repository blocked: unresolved process-tree guard requires operator proof";

async function writeSelectedRecord(pathname, value) {
  const temporary = `${pathname}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // The final name is published only after complete, synced JSON exists.
    // A crash before link leaves an ignorable private temp, never partial
    // intent/completion authority. link() also refuses an existing final name.
    await link(temporary, pathname);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

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

async function sameMaterializedPath(source, destination) {
  const [sourceStat, destinationStat] = await Promise.all([lstat(source), lstat(destination)]);
  if (sourceStat.isSymbolicLink() || destinationStat.isSymbolicLink()) {
    return sourceStat.isSymbolicLink() && destinationStat.isSymbolicLink()
      && await readlink(source) === await readlink(destination);
  }
  if (!sourceStat.isFile() || !destinationStat.isFile() || sourceStat.size !== destinationStat.size) return false;
  return (await readFile(source)).equals(await readFile(destination));
}

async function pathUsesExactCase(root, relativePath) {
  let current = root;
  for (const part of relativePath.split("/").filter(Boolean)) {
    if (!(await readdir(current)).includes(part)) return false;
    current = path.join(current, part);
  }
  return true;
}

async function materializePathWithoutOverwrite(sourceRoot, worktreeRoot, relativePath) {
  const source = path.resolve(sourceRoot, relativePath);
  const destination = path.resolve(worktreeRoot, relativePath);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const relativeParent = path.posix.dirname(relativePath);
  if (relativeParent !== "." && !await pathUsesExactCase(worktreeRoot, relativeParent)) {
    throw new Error(`Squash cutover target collides with unknown path casing: ${relativePath}`);
  }
  const sourceStat = await lstat(source);
  try {
    if (sourceStat.isSymbolicLink()) await symlink(await readlink(source), destination);
    else if (sourceStat.isFile()) {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      await chmod(destination, sourceStat.mode & 0o777);
    } else {
      throw new Error(`Squash cutover cannot materialize unsupported Git entry: ${relativePath}`);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!await pathUsesExactCase(worktreeRoot, relativePath)
        || !await sameMaterializedPath(source, destination)) {
      throw new Error(`Squash cutover target collides with unknown bytes: ${relativePath}`);
    }
  }
}

function gitCommandKind(args, commandLabel) {
  if (commandLabel !== "git") return "external";
  const verbs = new Set(["rev-parse", "status", "log", "show", "diff", "merge-base", "merge",
    "worktree", "sparse-checkout", "config", "symbolic-ref", "update-ref", "for-each-ref",
    "cat-file", "rev-list", "add", "commit", "reset", "read-tree", "checkout", "ls-files"]);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-c" || args[index] === "-C") { index += 1; continue; }
    if (verbs.has(args[index])) return args[index] === "merge" && args[index + 1] === "--abort"
      ? "merge-abort" : args[index];
  }
  return "other";
}

function withInterprocessLocks(paths, operation, options = {}) {
  const lockKind = paths.some(value => path.basename(value).startsWith("task-git-dev-"))
    ? "repository" : paths.some(value => path.basename(value).startsWith("task-dependencies-"))
      ? "dependencies" : "task";
  return measureTaskOperation("lock", () => acquireInterprocessLocks(paths, operation, {
    ...options,
    onAcquired: (event) => {
      recordTaskOperationTiming("lock-acquired", { lockKind, waitMs: event.waitMs, lockCount: event.lockCount });
      options.onAcquired?.(event);
    },
  }), { lockKind });
}

export function runTaskGitCommand(args, options = {}) {
  return measureTaskOperation("git-child", () => runTaskGitCommandUntraced(args, options), {
    detail: true, command: gitCommandKind(args, options.commandLabel ?? "git"),
    cwdKey: options.cwd ? taskRepositoryKey(options.cwd) : null,
  });
}

function runTaskGitCommandUntraced(args, {
  cwd, timeoutMs = 60_000, executable = "git", spawnProcess = spawn, signal = null, input = null,
  commandLabel = "git", env = null, rawOutput = false, acceptableExitCodes = [],
  stdoutFd = null,
} = {}) {
  if (stdoutFd !== null && (!Number.isSafeInteger(stdoutFd) || stdoutFd < 3)) throw new TypeError("Invalid owned Git output descriptor");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Task Git lease ownership was lost"));
      return;
    }
    const child = spawnProcess(executable, ownedGitArguments(args, { executable }), {
      cwd,
      windowsHide: true,
      stdio: [input == null ? "ignore" : "pipe", stdoutFd ?? "pipe", "pipe"],
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
    const timer = timeoutMs == null ? null : setTimeout(() => terminate("timed out"), timeoutMs);
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
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
      const stdoutBytes = Buffer.concat(stdout);
      const output = rawOutput ? stdoutBytes : stdoutBytes.toString("utf8").trim();
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (termination && terminationOutcome == null) return;
      if (termination) settle(() => reject(
        taskGitTerminationError(args, timeoutMs, terminationOutcome, termination, commandLabel),
      ));
      else if (code === 0 || acceptableExitCodes.includes(code)) settle(() => resolve(output));
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

function taskUpstreamAdoptionTaskKey(taskId) {
  return createHash("sha256").update(normalizedTaskId(taskId), "utf8").digest("hex").slice(0, 16);
}

function taskUpstreamAdoptionPrefix(taskId, repoKey) {
  return `${TASK_UPSTREAM_ADOPTION_REF_PREFIX}t-${taskUpstreamAdoptionTaskKey(taskId)}/${repoKey}/`;
}

function taskUpstreamAdoptionLegacyPrefix(taskId, repoKey) {
  return `${TASK_UPSTREAM_ADOPTION_REF_PREFIX}${normalizedTaskId(taskId)}/${repoKey}/`;
}

function taskUpstreamAdoptionPrefixes(taskId, repoKey) {
  return [taskUpstreamAdoptionPrefix(taskId, repoKey), taskUpstreamAdoptionLegacyPrefix(taskId, repoKey)];
}

function taskUpstreamAdoptionRef(taskId, repoKey, snapshotCommit, adoptedCommit) {
  return `${taskUpstreamAdoptionPrefix(taskId, repoKey)}${snapshotCommit}/${adoptedCommit}`;
}

function taskUpstreamAdoptionIdentityRefs(taskId, repoKey, snapshotCommit, adoptedCommit) {
  return taskUpstreamAdoptionPrefixes(taskId, repoKey)
    .map((prefix) => `${prefix}${snapshotCommit}/${adoptedCommit}`);
}

async function taskUpstreamAdoptionRefs(repoRoot, taskId, repoKey) {
  const refs = [];
  for (const prefix of taskUpstreamAdoptionPrefixes(taskId, repoKey)) {
    refs.push(...String(await runGit([
      "for-each-ref", "--format=%(refname)", prefix,
    ], { cwd: repoRoot })).split(/\r?\n/u).filter(Boolean));
  }
  return [...new Set(refs)];
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
  #claimLockAdmissionErrors = new WeakMap();
  #publishedDeliveryProofs = new WeakMap();

  constructor({
    dataDir,
    devBranch = TASK_DEV_BRANCH,
    prepareDependencies = prepareTaskWorktreeDependencies,
    readPublication = readPublicationState,
    runCommand = runTaskGitCommand,
    readSystemBootIdentity = readTrustedSystemBootIdentity,
    removeProcessGuard = unlink,
    contourExternalEffects = null,
    verifyNativeResolutionReview = null,
    readClaimCustodyNamespace = () => null,
    recordTiming = (event) => console.info(`[task-operation-timing] ${JSON.stringify(event)}`),
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
    this.recordTiming = recordTiming;
    this.verifyNativeResolutionReview = verifyNativeResolutionReview;
    this.readClaimCustodyNamespace = readClaimCustodyNamespace;
  }

  withOperationTrace(identity, operation) {
    return withTaskOperationTiming({ ...identity, record: this.recordTiming }, operation);
  }

  measureOperation(stage, operation) {
    return measureTaskOperation(stage, operation);
  }

  #assertAvailable(operation) {
    assertContourGitAvailable(this.#contourExternalEffects, "task-git", operation);
  }

  #claimNamespace(taskId) {
    const state = this.readClaimCustodyNamespace(taskId);
    if (!state) return null;
    const expected = this.planIndependentClaimNamespace({ taskId, source: state.source,
      requestId: state.planRequestId, originalHash: state.originalHash });
    const { workspace, ...identity } = state.namespace;
    if (!workspace || claimCustodyHash(identity) !== claimCustodyHash(expected)) {
      throw new Error("This data root does not own the isolated Task source capability");
    }
    return state;
  }

  #custodyBaseRef(taskId, repositoryKey) {
    const state = this.#claimNamespace(normalizedTaskId(taskId));
    if (!state) return taskBaseRef(taskId, repositoryKey);
    if (repositoryKey !== state.namespace.repositoryKey) throw new Error("Custody logical repository key changed");
    return `${state.namespace.refPrefix}/base`;
  }

  #custodyResultRef(taskId, repositoryKey) {
    const state = this.#claimNamespace(normalizedTaskId(taskId));
    if (!state) return taskResultRef(taskId, repositoryKey);
    if (repositoryKey !== state.namespace.repositoryKey) throw new Error("Custody logical repository key changed");
    return `${state.namespace.refPrefix}/result`;
  }

  async #importCustodySnapshotOwned(snapshot, lease) {
    const state = this.#claimNamespace(normalizedTaskId(snapshot.taskId));
    if (!state) {
      if (snapshot.custodyEpoch) throw new Error("Snapshot custody authority disappeared");
      return;
    }
    if (snapshot.custodyEpoch !== state.namespace.epoch
        || !samePath(snapshot.repositoryRoot, state.source.repositoryRoot)
        || !samePath(snapshot.projectRoot, state.namespace.workspace.projectRoot)) throw new Error("Snapshot is outside current Task custody");
    await this.readIndependentClaimNamespaceOwned({ state, lease });
    for (const [suffix, commit] of [[`objects/${snapshot.headCommit}`, snapshot.headCommit], ["base", snapshot.baseCommit]]) {
      const ref = `${state.namespace.refPrefix}/${suffix}`;
      const old = await gitMaybe(["rev-parse", "--verify", ref], { cwd: snapshot.repositoryRoot });
      if (old && old !== commit) throw new Error("Immutable custody import reference changed");
      if (!old) await this.#runOwned(["fetch", "--no-tags", "--no-write-fetch-head",
        state.namespace.root, `${commit}:${ref}`], { cwd: snapshot.repositoryRoot, lease });
      if (await runGit(["rev-parse", `${ref}^{commit}`], { cwd: snapshot.repositoryRoot }) !== commit) throw new Error("Canonical custody import readback differs");
    }
  }

  async #runOwned(args, { lease = null, guardCommand = null, guardScope = "repository", ...options } = {}) {
    return measureTaskOperation("owned-command", () => this.#runOwnedTraced(args, {
      lease, guardCommand, guardScope, ...options,
    }), { detail: true, command: gitCommandKind(args, options.commandLabel ?? "git") });
  }

  async #runOwnedTraced(args, { lease, guardCommand, guardScope, guardRepositoryRoot, ...options }) {
    const owner = requiredGuardLease(lease);
    await owner.assertOwned();
    const guard = await owner.beginProcessTreeGuard({ args: guardCommand ?? args, cwd: options.cwd,
      scope: guardScope, repositoryRoot: guardRepositoryRoot });
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

  #acceptedMainBootstrapReceiptFile(repoRoot, requestId) {
    const key = createHash("sha256").update(requestId, "utf8").digest("hex");
    return path.join(this.dataDir, "task-accepted-main-bootstraps", taskRepositoryKey(repoRoot), `${key}.json`);
  }

  async #acceptedMainBootstrapPublication(repoRoot, expectedRevision, expectedGeneration) {
    const publication = await this.readPublication();
    const revision = publicationStateRepositories(publication ?? {})
      .find((entry) => samePath(entry.root, repoRoot))?.revision;
    if (publication?.generation !== expectedGeneration || revision !== expectedRevision) {
      throw new Error("Accepted-main bootstrap publication provenance changed");
    }
  }

  async #acceptedMainBootstrapMain(repoRoot, expectedCommit) {
    const branch = await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: repoRoot });
    const main = await localMainCommit(repoRoot);
    const head = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: repoRoot });
    if (branch !== "refs/heads/main" || main !== expectedCommit || head !== expectedCommit) {
      throw new Error("Accepted-main bootstrap local main identity changed");
    }
  }

  async #acceptedMainBootstrapPublishedAncestry(repoRoot, published, main, base, lease) {
    const publishedBase = await this.#runOwned([
      "merge-base", "--all", published, main,
    ], { cwd: repoRoot, lease });
    if (publishedBase === base) return true;
    // Both branches may already contain accepted upstream newer than the last
    // publication. Admit only an exact published ancestor of that shared base;
    // an older divergent publication branch grants no additional ancestry.
    if (publishedBase !== published) return false;
    return await this.#runOwned([
      "merge-base", "--all", published, base,
    ], { cwd: repoRoot, lease }) === published;
  }

  async #readAcceptedMainBootstrapReceipt(repoRoot, requestId) {
    const file = this.#acceptedMainBootstrapReceiptFile(repoRoot, requestId);
    return readFile(file, "utf8").then(JSON.parse, (error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
  }

  async #writeAcceptedMainBootstrapReceipt(record) {
    const file = this.#acceptedMainBootstrapReceiptFile(record.repositoryRoot, record.requestId);
    const receipt = { ...record, phase: "completed" };
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await this.#readAcceptedMainBootstrapReceipt(record.repositoryRoot, record.requestId);
      if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
        throw new Error("Accepted-main bootstrap receipt identity changed");
      }
    }
  }

  async #assertAcceptedMainBootstrapModificationsOnly(devRoot, oldCommit, nextCommit, lease,
    requiredTrackedCommit = null) {
    // This bounded owner path cannot make Git materialization atomic against a
    // newly appearing ignored file at an added path. Permit only content edits
    // to already tracked regular files; no path graph or file-type changes.
    const raw = await this.#runOwned([
      "diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--raw", "--abbrev=40", "-z",
      oldCommit, nextCommit, "--",
    ], { cwd: devRoot, lease });
    const entries = raw.split("\0").filter(Boolean);
    if (entries.length % 2 !== 0) {
      throw new Error("Accepted-main bootstrap modifications-only proof is malformed");
    }
    for (let index = 0; index < entries.length; index += 2) {
      const match = /^:(\d{6}) (\d{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} ([A-Z])$/u.exec(entries[index]);
      const relative = entries[index + 1];
      if (!match || !relative) {
        throw new Error("Accepted-main bootstrap modifications-only proof is malformed");
      }
      const [, beforeMode, afterMode, status] = match;
      if (status !== "M" || beforeMode !== afterMode
        || !["100644", "100755"].includes(beforeMode)) {
        throw new Error(`Accepted-main bootstrap supports only existing regular-file content edits: ${relative}`);
      }
      if (requiredTrackedCommit) {
        const tracked = await this.#treeEntryAt(devRoot, requiredTrackedCommit, relative, lease);
        if (tracked?.path !== relative || tracked.mode !== beforeMode || tracked.type !== "blob") {
          throw new Error(`Accepted-main bootstrap supports only existing regular-file content edits: ${relative}`);
        }
      }
    }
  }

  async #recoverAcceptedMainBootstrapTransaction(record, repoRoot, devRoot, lease) {
    const exact = record.version === 2
      && record.kind === "accepted-local-main-bootstrap-v1"
      && samePath(record.repositoryRoot, repoRoot)
      && samePath(record.devRoot, devRoot)
      && record.devBranch === this.devBranch
      && typeof record.publicationGeneration === "string" && record.publicationGeneration.length > 0
      && typeof record.requestId === "string" && record.requestId.length > 0
      && record.requestId.length <= 200
      && (record.reviewedResolvedTree == null
        || (/^[0-9a-f]{40}$/u.test(record.reviewedResolvedTree)
          && record.reviewedResolvedTree === record.resultTree))
      && [record.oldDevCommit, record.mainCommit, record.publishedRevision,
        record.mergeBaseCommit, record.integrationCommit, record.resultTree]
        .every((value) => /^[0-9a-f]{40}$/u.test(String(value ?? "")));
    if (!exact) throw new Error("Accepted-main bootstrap recovery identity is invalid");
    // The record was written before the atomic main-verify/dev-CAS transaction.
    // Once that exact CAS is observable, newer publication or main state must
    // not prevent materializing and receipting the already-admitted effect.
    const parents = await this.#runOwned(["rev-list", "--parents", "-n", "1", record.integrationCommit], { cwd: repoRoot, lease });
    const tree = await this.#runOwned(["rev-parse", `${record.integrationCommit}^{tree}`], { cwd: repoRoot, lease });
    const bases = await this.#runOwned(["merge-base", "--all", record.oldDevCommit, record.mainCommit], { cwd: repoRoot, lease });
    const publishedAncestry = await this.#acceptedMainBootstrapPublishedAncestry(
      repoRoot, record.publishedRevision, record.mainCommit, record.mergeBaseCommit, lease,
    );
    const branch = await this.#runOwned(["symbolic-ref", "--quiet", "HEAD"], { cwd: devRoot, lease });
    const current = await this.#runOwned(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], { cwd: repoRoot, lease });
    const indexTree = await this.#runOwned(["write-tree"], { cwd: devRoot, lease });
    const worktreeDiff = await this.#runOwned(["diff-files", "--name-only", "-z"], { cwd: devRoot, lease });
    const otherFiles = await this.#runOwned([
      "ls-files", "--others", "--exclude-standard", "-z",
    ], { cwd: devRoot, lease });
    const oldTree = await this.#runOwned(["rev-parse", `${record.oldDevCommit}^{tree}`], { cwd: repoRoot, lease });
    if (parents !== `${record.integrationCommit} ${record.oldDevCommit} ${record.mainCommit}`
      || tree !== record.resultTree || bases !== record.mergeBaseCommit
      || !publishedAncestry
      || branch !== `refs/heads/${this.devBranch}` || worktreeDiff || otherFiles
      || ![oldTree, record.resultTree].includes(indexTree)) {
      throw new Error("Accepted-main bootstrap recovery proof changed");
    }
    const file = this.#devBootstrapRecoveryFile(repoRoot);
    if (current === record.oldDevCommit) {
      if (indexTree !== oldTree) throw new Error("Accepted-main bootstrap changed index before dev CAS");
      await unlink(file);
      return { recovered: false, record };
    }
    if (current !== record.integrationCommit) {
      throw new Error(`Accepted-main bootstrap found unexpected dev ${current}`);
    }
    if (indexTree === oldTree) {
      await this.#assertAcceptedMainBootstrapModificationsOnly(
        devRoot, record.oldDevCommit, record.integrationCommit, lease,
      );
    }
    // The exact tree-shape proof above excludes added paths before read-tree
    // updates only already tracked regular files. Do not use reset --hard here.
    await this.#runOwned([
      "read-tree", "-m", "-u", record.oldDevCommit, record.integrationCommit,
    ], { cwd: devRoot, lease });
    const status = await this.#runOwned([
      "status", "--porcelain=v1", "-z", "--untracked-files=all",
    ], { cwd: devRoot, lease });
    if (status) throw new Error("Accepted-main bootstrap did not restore a clean worktree");
    await this.#writeAcceptedMainBootstrapReceipt(record);
    await unlink(file);
    return { recovered: true, record };
  }

  async #treeEntryAt(repoRoot, commit, relativePath, lease) {
    const output = await this.#runOwned([
      "ls-tree", "-z", exactCommitId(commit, "tree entry commit"), "--", relativePath,
    ], { cwd: repoRoot, lease });
    if (!output) return null;
    return exactTreeEntry(output.replace(/\0$/u, ""), `tree entry for ${relativePath}`);
  }

  async #blobBytes(repoRoot, entry, lease) {
    if (!entry) return null;
    return this.#runOwned(["cat-file", "blob", entry.object], {
      cwd: repoRoot, lease, rawOutput: true,
    });
  }

  async #isExactLfNormalizationWitness(repoRoot, witness, lease) {
    if (witness.disposition !== LF_NORMALIZATION_ALREADY_PRESENT) return false;
    return exactCrLfToLfNormalization({
      baseline: await this.#blobBytes(repoRoot, witness.baseline, lease),
      newResult: await this.#blobBytes(repoRoot, witness.newResult, lease),
      dev: await this.#blobBytes(repoRoot, witness.beforeDev, lease),
    });
  }

  async #verifySquashNormalizationWitnesses(repoRoot, proof, lease) {
    for (const witness of proof.ownerWitnesses) {
      if (witness.disposition === LF_NORMALIZATION_ALREADY_PRESENT
          && !await this.#isExactLfNormalizationWitness(repoRoot, witness, lease)) {
        throw new Error(`Squash LF normalization evidence changed for ${witness.path}`);
      }
    }
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
    if (record.version === 2) {
      return this.#recoverAcceptedMainBootstrapTransaction(record, repoRoot, devRoot, lease);
    }
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
    return measureTaskOperation("repository-guards", () => this.#assertRepositoryProcessTreeClearTraced(repositoryRootValue));
  }

  async #assertRepositoryProcessTreeClearTraced(repositoryRootValue) {
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

  async #beginProcessTreeGuard(taskId, lease, { args, cwd, scope = "repository", repositoryRoot: guardRepositoryRoot } = {}, state) {
    if (typeof lease?.assertOwned !== "function") throw new Error("Task Git guard owner lease is required");
    await measureTaskOperationAwait("process-guard-lease-await", () => lease.assertOwned());
    if (state.unresolved) throw state.unresolved;
    const repositoryRoot = await measureTaskOperationAwait("process-guard-identity-await",
      () => repositoryIdentityFromPath(guardRepositoryRoot ?? cwd));
    const guardId = randomUUID();
    const file = path.join(
      this.#processGuardDirectory(taskId),
      `${taskRepositoryKey(repositoryRoot)}.json`,
    );
    await measureTaskOperationAwait("process-guard-mkdir-await",
      () => mkdir(path.dirname(file), { recursive: true }));
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
      await measureTaskOperationAwait("process-guard-write-await",
        () => writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
          encoding: "utf8", flag: "wx", mode: 0o600,
        }));
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
        const current = await measureTaskOperationAwait("process-guard-clear-read-await",
          () => readFile(file, "utf8").then(JSON.parse, () => null));
        if (current?.guardId !== guardId) {
          state.unresolved = new Error(`Task Git process-tree guard ownership changed (${file})`);
          throw state.unresolved;
        }
        await measureTaskOperationAwait("process-guard-clear-unlink-await", () => unlink(file));
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

  storageRetentionOwner({ taskBoard, isStopping } = {}) {
    this.#assertAvailable("storageRetentionOwner");
    return new NativeMergeTransportRetention({ dataDir: this.dataDir, taskBoard, taskGitWorkspaces: this,
      isStopping, gitAt: (cwd, args, options = {}) => this.#runOwned(args, {
        ...options, cwd, guardRepositoryRoot: cwd, timeoutMs: 60_000,
      }) });
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
      assertOwned: () => measureTaskOperation("lease-assert", async () => {
        await lease.assertOwned();
        if (state.unresolved) throw state.unresolved;
      }, { detail: true }),
      beginProcessTreeGuard: (context) => measureTaskOperation("process-guard", () => this.#beginProcessTreeGuard(id, lease, context, state), { detail: true }),
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

  async claimAdmissionNoEffectEvidence(params = {}) {
    this.#assertAvailable("claimAdmissionNoEffectEvidence");
    const { taskId, projectRoot, operationId = null, error } = params;
    const id = normalizedTaskId(taskId);
    const repositoryRootValue = await repositoryIdentityFromPath(projectRoot);
    const lockAdmission = this.#claimLockAdmissionErrors.get(error);
    if (lockAdmission && lockAdmission.taskId === id && lockAdmission.operationId === operationId
        && samePath(lockAdmission.repositoryRoot, repositoryRootValue)) return lockAdmission;
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
    const repositoryKeys = new Set([repositoryKey, taskRepositoryKey(projectRoot)]);
    if (segments.length !== 2
      || normalizedTaskId(segments[0]) === id
      || !repositoryKeys.has(segments[1].replace(/\.json$/u, ""))) return null;
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
    return measureTaskOperation("sparse-worktree", () => this.#ensureSparseTaskWorktreeTraced({ taskId, worktreeRoot: root, selection, created, lease }));
  }

  async #ensureSparseTaskWorktreeTraced({ taskId, worktreeRoot: root, selection, created, lease }) {
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

  async #prepareDevOwned(projectRoot, repoRoot, lease, { allowUnadoptedLocalMain = false, synchronizeAcceptedMain = false } = {}) {
    return measureTaskOperation("prepare-dev", () => this.#prepareDevOwnedTraced(projectRoot, repoRoot, lease, { allowUnadoptedLocalMain, synchronizeAcceptedMain }));
  }

  async #prepareDevOwnedTraced(projectRoot, repoRoot, lease, { allowUnadoptedLocalMain, synchronizeAcceptedMain }) {
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
      if (synchronizeAcceptedMain) {
        const synchronized = await this.#synchronizeMainIntoDevOwned({ repoRoot,
          expectedMainCommit: mainCommit, observedMainCommit: mainCommit, lease });
        if (synchronized.integrated) return { ...synchronized, acceptedMainIntegrated: true };
        throw Object.assign(new Error(synchronized.reason || "Accepted main conflicts with managed dev"),
          { code: "RELEASE_PREPARATION_REJECTED", conflicts: synchronized.conflicts,
            conflictRoot: devRoot });
      }
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

  async #publishedTaskHistoryBase(repoRoot, localMain) {
    const publication = await this.readPublication();
    const published = publicationStateRepositories(publication ?? {})
      .find((entry) => samePath(entry.root, repoRoot))?.revision;
    if (!publication?.generation || !/^[a-f0-9]{40}$/u.test(String(published ?? ""))) return null;
    const remote = await gitMaybe(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], { cwd: repoRoot });
    if (!remote || await gitMaybe([
      "merge-base", "--is-ancestor", published, remote,
    ], { cwd: repoRoot }) === null || await gitMaybe([
      "merge-base", "--is-ancestor", localMain, published,
    ], { cwd: repoRoot }) === null) return null;
    // Exclude published ancestry only; do not adopt new upstream or move main.
    return { published, remote };
  }

  async #unpublishedTrackedBases(repoRoot, commit, publishedHistory, lease) {
    if (!publishedHistory) return [];
    const bases = String(await this.#runOwned([
      "merge-base", "--all", commit, publishedHistory.remote,
    ], { cwd: repoRoot, lease })).split(/\r?\n/u).filter(Boolean);
    const unpublished = [];
    for (const base of bases) {
      if (await gitMaybe([
        "merge-base", "--is-ancestor", base, publishedHistory.published,
      ], { cwd: repoRoot }) === null) unpublished.push(base);
    }
    return unpublished;
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
      const base = await gitMaybe(["rev-parse", "--verify", `${this.#custodyBaseRef(owner, relative[1])}^{commit}`], { cwd: repoRoot });
      if (!base || !await this.managedRepositoryRoot(root, {
        taskId: owner, taskNumber: /^branch refs\/heads\/(.+)$/mu.exec(record)?.[1],
      })) continue;
      const publishedHistory = await this.#publishedTaskHistoryBase(repoRoot, localMain);
      const unpublished = await this.#unpublishedTrackedBases(repoRoot, commit, publishedHistory, lease);
      if (unpublished.length) {
        const adoption = await this.#recordedUpstreamAdoptionForSnapshot({
          taskId: owner, repoRoot, snapshotCommit: commit, localMain, lease,
        });
        for (const base of unpublished) {
          if (!adoption || await gitMaybe([
            "merge-base", "--is-ancestor", base, adoption.record.adoptedCommit,
          ], { cwd: repoRoot }) === null) {
            throw new TaskGitHistoryRejectedError(`Sibling Task ${owner} at ${commit} contains unpublished tracked remote history ${base}`);
          }
        }
      }
      const merges = String(await runGit([
        "log", "--first-parent", "--merges", "--format=%H %P",
        `--max-count=${MAX_UPSTREAM_ADOPTION_PROOFS + 1}`, commit, `^${base}`, `^${localMain}`,
        ...(publishedHistory ? [`^${publishedHistory.published}`] : []),
      ], { cwd: repoRoot })).split(/\r?\n/u).filter(Boolean);
      if (merges.length > MAX_UPSTREAM_ADOPTION_PROOFS) throw new TaskGitHistoryRejectedError(`Sibling Task ${owner} merge history exceeds the bounded proof`);
      for (const merge of merges) {
        const [, , ...sides] = merge.split(" ");
        for (const side of sides) {
          if (await gitMaybe(["merge-base", "--is-ancestor", side, localMain], { cwd: repoRoot }) !== null) continue;
          if (await this.#isOtherTaskHead(owner, repoRoot, side, localMain, lease, visiting)) continue;
          const adoption = await this.#recordedUpstreamAdoptionForSnapshot({
            taskId: owner, repoRoot, snapshotCommit: commit, localMain, lease,
          });
          if (adoption?.record?.adoptedCommit !== side) {
            throw new TaskGitHistoryRejectedError(`Sibling Task ${owner} at ${commit} contains an unapproved upstream or dev merge: ${merge.split(" ")[0]} parent ${side}`);
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
      "rev-parse", "--verify", `${this.#custodyBaseRef(id, repoKey)}^{commit}`,
    ], { cwd: repoRoot, lease });
    const observedSnapshot = await this.#runOwned([
      "rev-parse", "--verify", `${branchRef}^{commit}`,
    ], { cwd: repoRoot, lease });
    if (observedMain !== acceptedLocalMain) {
      throw new Error(`accepted local main changed from ${acceptedLocalMain} to ${observedMain}`);
    }
    if (observedBase !== exactBase) throw new Error("explicit upstream adoption Task base changed");
    if (observedSnapshot !== exactSnapshot) throw new Error("explicit upstream adoption Task snapshot changed");
    const publishedHistory = await this.#publishedTaskHistoryBase(repoRoot, acceptedLocalMain);
    for (const base of await this.#unpublishedTrackedBases(repoRoot, exactSnapshot, publishedHistory, lease)) {
      if (!expectedAdopted || await gitMaybe([
        "merge-base", "--is-ancestor", base, expectedAdopted,
      ], { cwd: repoRoot }) === null) {
        throw new TaskGitHistoryRejectedError(`Task snapshot ${exactSnapshot} contains unpublished tracked remote history ${base}`);
      }
    }
    return this.#upstreamAdoptionProofFromObjects({
      id, repoKey, repoRoot, expectedBranch, branchRef, exactBase, exactSnapshot, acceptedLocalMain,
      expectedAdopted, devCommit, lease,
      publishedHistoryBase: expectedAdopted ? null : publishedHistory?.published ?? null,
    });
  }

  // Object-only part of an adoption proof. It reads immutable commits and
  // trees only; callers own every ref fence. `rev-list --parents` prints the
  // commit followed by its parents, so a proof commit has exactly three tokens:
  // itself, the first parent and the adopted commit as the second parent.
  async #upstreamAdoptionProofFromObjects({
    id, repoKey, repoRoot, expectedBranch, branchRef, exactBase, exactSnapshot, acceptedLocalMain,
    expectedAdopted, devCommit, lease, publishedHistoryBase = null,
  }) {
    const history = String(await this.#runOwned([
      "log", "--first-parent", "--merges", "--format=%H %P",
      `--max-count=${MAX_UPSTREAM_ADOPTION_PROOFS + 1}`, exactSnapshot, `^${exactBase}`,
      ...(publishedHistoryBase ? [`^${publishedHistoryBase}`] : []),
    ], { cwd: repoRoot, lease })).split(/\r?\n/u).filter(Boolean);
    if (history.length > MAX_UPSTREAM_ADOPTION_PROOFS) {
      throw new Error("explicit upstream adoption proof exceeds the bounded first-parent history");
    }
    const proofs = [];
    for (const entry of history) {
      const parents = entry.split(/\s+/u).filter(Boolean);
      const commit = parents[0];
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

  // Historical verification used only by supplemental missing-provenance
  // recovery of a legacy frozen candidate. It proves that an immutable adoption
  // record existed for the exact frozen Task snapshot, deriving every historical
  // field from the verified record and immutable objects. Current main, Task
  // base and Task branch refs are never authority here, and the result is not
  // admission or publication readiness: ordinary callers use releaseBaseEvidence.
  async historicalUpstreamAdoptionEvidence({
    projectRoot, publishedBaseCommit, tasks = [], expected = {}, recoveryKind = null,
  } = {}) {
    this.#assertAvailable("historicalUpstreamAdoptionEvidence");
    if (recoveryKind !== HISTORICAL_ADOPTION_RECOVERY_KIND) {
      throw new Error("historical upstream adoption evidence is limited to missing-provenance recovery");
    }
    const repoRoot = await repositoryRoot(projectRoot);
    const repoKey = taskRepositoryKey(repoRoot);
    const published = exactCommitId(publishedBaseCommit, "published release base");
    const expectedTaskId = normalizedTaskId(expected?.taskId);
    const expectedRef = String(expected?.recordRef ?? "").trim();
    const expectedHash = exactCommitId(expected?.recordHash, "expected adoption record blob");
    const frozen = [...tasks].map((task) => ({
      taskId: normalizedTaskId(task?.taskId),
      resultCommit: exactCommitId(task?.resultCommit, "frozen Task result commit"),
    })).sort((left, right) => left.taskId.localeCompare(right.taskId));
    if (!frozen.length || new Set(frozen.map((task) => task.taskId)).size !== frozen.length) {
      throw new Error("historical upstream adoption evidence requires the exact frozen Task set");
    }
    return this.#withClearDevLock(repoRoot, null, async (lease) => {
      const ancestor = async (left, right) => await gitMaybe([
        "merge-base", "--is-ancestor", left, right,
      ], { cwd: repoRoot }) !== null;
      await this.#runOwned(["cat-file", "-e", `${published}^{commit}`], { cwd: repoRoot, lease });
      const outstanding = [];
      for (const task of frozen) {
        const refs = [];
        for (const prefix of taskUpstreamAdoptionPrefixes(task.taskId, repoKey)) {
          refs.push(...String(await this.#runOwned([
            "for-each-ref", "--format=%(refname)%00%(objectname)", `${prefix}${task.resultCommit}/`,
          ], { cwd: repoRoot, lease })).split(/\r?\n/u).filter(Boolean));
        }
        if (refs.length > 1) throw new Error("frozen Task snapshot has ambiguous historical adoption receipts");
        if (!refs.length) continue;
        const [recordRef, recordHash] = refs[0].split("\0");
        const verified = await this.#historicalAdoptionRecord({
          repoRoot, repoKey, task, recordRef, recordHash, published, lease, ancestor,
        });
        // A published-contained receipt is ignored only after full validation.
        if (!verified.outstanding) continue;
        outstanding.push(verified);
      }
      if (outstanding.length !== 1) {
        throw new Error(outstanding.length
          ? "frozen Tasks carry multiple outstanding historical adoptions"
          : "frozen Tasks carry no outstanding historical adoption");
      }
      const [adoption] = outstanding;
      if (adoption.taskId !== expectedTaskId || adoption.recordRef !== expectedRef
          || adoption.recordHash !== expectedHash) {
        throw new Error("historical upstream adoption does not match the expected exact ref and blob");
      }
      return {
        validation: HISTORICAL_ADOPTION_VALIDATION,
        publishedBaseCommit: published,
        adoptedBaseCommit: adoption.adoptedCommit,
        adoption: {
          taskId: adoption.taskId,
          resultCommit: adoption.resultCommit,
          recordRef: adoption.recordRef,
          recordHash: adoption.recordHash,
          requestId: adoption.requestId,
          branch: adoption.branch,
          taskBaseCommit: adoption.taskBaseCommit,
          acceptedLocalMainCommit: adoption.acceptedLocalMainCommit,
          adoptedCommit: adoption.adoptedCommit,
          snapshotTree: adoption.snapshotTree,
          proofCommit: adoption.proofCommit,
          proofParents: adoption.proofParents,
          proofTree: adoption.proofTree,
        },
      };
    });
  }

  async #historicalAdoptionRecord({ repoRoot, repoKey, task, recordRef, recordHash, published, lease, ancestor }) {
    const hash = exactCommitId(recordHash, "historical adoption record blob");
    const type = await this.#runOwned(["cat-file", "-t", hash], { cwd: repoRoot, lease });
    if (type !== "blob") throw new Error("historical adoption receipt is not a Git blob");
    let record;
    try {
      record = JSON.parse(await this.#runOwned(["cat-file", "-p", hash], { cwd: repoRoot, lease }));
    } catch {
      throw new Error("historical adoption receipt is invalid JSON");
    }
    const verifiedHash = await this.#runOwned(["hash-object", "--stdin"], {
      cwd: repoRoot, input: `${JSON.stringify(record)}\n`, lease,
    });
    if (verifiedHash !== hash) throw new Error("historical adoption receipt bytes are not canonical");
    if (record?.version !== 1 || record.kind !== "task-upstream-adoption"
        || record.taskId !== task.taskId || record.repositoryKey !== repoKey
        || !samePath(record.repositoryRoot, repoRoot) || record.snapshotCommit !== task.resultCommit) {
      throw new Error("historical adoption receipt does not describe the exact frozen Task snapshot");
    }
    const adopted = exactCommitId(record.adoptedCommit, "historical adopted commit");
    const acceptedLocalMain = exactCommitId(record.acceptedLocalMainCommit, "historical accepted local main");
    const exactBase = exactCommitId(record.taskBaseCommit, "historical Task base");
    if (!taskUpstreamAdoptionIdentityRefs(task.taskId, repoKey, task.resultCommit, adopted).includes(recordRef)) {
      throw new Error("historical adoption receipt ref does not derive from its record");
    }
    const branch = String(record.branch ?? "").trim();
    if (!branch) throw new Error("historical adoption receipt has no Task branch");
    const proof = await this.#upstreamAdoptionProofFromObjects({
      id: task.taskId, repoKey, repoRoot, expectedBranch: branch, branchRef: `refs/heads/${branch}`,
      exactBase, exactSnapshot: task.resultCommit, acceptedLocalMain, expectedAdopted: adopted,
      devCommit: null, lease,
    });
    if (JSON.stringify(this.#upstreamAdoptionRecord(proof, record.requestId)) !== JSON.stringify(record)) {
      throw new Error("historical adoption receipt does not match its immutable object proof");
    }
    const actualParents = String(await this.#runOwned([
      "rev-list", "--parents", "-n", "1", proof.proofCommit,
    ], { cwd: repoRoot, lease })).split(/\s+/u).filter(Boolean);
    if (actualParents.length !== 3 || actualParents[0] !== proof.proofCommit
        || JSON.stringify(actualParents.slice(1)) !== JSON.stringify(record.proofParents)
        || record.proofParents[1] !== adopted) {
      throw new Error("historical adoption proof commit parents changed");
    }
    const outstanding = !await ancestor(adopted, published);
    if (outstanding && (!await ancestor(published, acceptedLocalMain) || !await ancestor(published, adopted))) {
      throw new Error("historical adoption does not extend the published release base");
    }
    return {
      taskId: task.taskId, resultCommit: task.resultCommit, recordRef, recordHash: hash, outstanding,
      requestId: record.requestId, branch, taskBaseCommit: exactBase, acceptedLocalMainCommit: acceptedLocalMain,
      adoptedCommit: adopted, snapshotTree: proof.snapshotTree, proofCommit: proof.proofCommit,
      proofParents: proof.proofParents, proofTree: proof.proofTree,
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
          input: `start\nverify refs/heads/main ${proof.acceptedLocalMainCommit}\nverify ${this.#custodyBaseRef(proof.taskId, proof.repositoryKey)} ${proof.taskBaseCommit}\nverify ${proof.branchRef} ${proof.snapshotCommit}\ncreate ${recordRef} ${recordHash}\nprepare\ncommit\n`,
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
    const receipts = await readNativeUpstreamAdoptions({
      git: (args, options = {}) => this.#runOwned(args, { ...options, cwd: repoRoot, lease }),
      tasks: [{ taskId: proof.taskId, baseCommit: proof.taskBaseCommit, resultCommit: proof.snapshotCommit }],
      repositoryRoot: repoRoot, localMainCommit: proof.acceptedLocalMainCommit,
    });
    if (receipts.length !== 1) throw new Error("approved upstream requires a durable explicit adoption receipt");
    const { recordRef, recordHash, record } = receipts[0];
    if (JSON.stringify(record) !== JSON.stringify(this.#upstreamAdoptionRecord(proof, record.requestId))) {
      throw new Error("explicit upstream adoption receipt identity changed");
    }
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
    const records = [];
    for (const prefix of taskUpstreamAdoptionPrefixes(id, repoKey)) {
      records.push(...String(await this.#runOwned([
        "for-each-ref", "--format=%(refname)%00%(objectname)", `${prefix}${exactSnapshot}/`,
      ], { cwd: repoRoot, lease })).split(/\r?\n/u).filter(Boolean));
    }
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
    return measureTaskOperation("ancestry-proof", () => this.#snapshotAdoptedMainCommitTraced({ snapshot, repoRoot, localMain, devCommit, lease }));
  }

  async #snapshotAdoptedMainCommitTraced({ snapshot, repoRoot, localMain, devCommit, lease }) {
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
    adoptionReceipt = null, verifySynchronization = null, lease,
  }) {
    await requiredGuardLease(lease).assertOwned();
    await verifySynchronization?.();
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
      await verifySynchronization?.();
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
    await verifySynchronization?.();
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

  async readDev(projectRoot) {
    this.#assertAvailable("readDev");
    const repoRoot = await repositoryRoot(projectRoot);
    const headCommit = await runGit(["rev-parse", "--verify", `refs/heads/${this.devBranch}^{commit}`], { cwd: repoRoot });
    const worktrees = await runGit(["worktree", "list", "--porcelain"], { cwd: repoRoot });
    const record = worktrees.split(/\r?\n\r?\n/u).find((entry) => (
      entry.split(/\r?\n/u).includes(`branch refs/heads/${this.devBranch}`)
    ));
    const worktree = record?.split(/\r?\n/u).find((line) => line.startsWith("worktree "));
    // An observational ref read is not integration/adoption evidence and must
    // never create a worktree, recover dev or wait for its mutation lease.
    return {
      repositoryRoot: repoRoot,
      projectRoot: worktree ? canonicalPath(worktree.slice("worktree ".length)) : null,
      branch: this.devBranch,
      headCommit,
    };
  }

  async prepareDev(projectRoot, { lease = null, synchronizeAcceptedMain = false } = {}) {
    this.#assertAvailable("prepareDev");
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, lease, (owned) => this.#prepareDevOwned(projectRoot, repoRoot, owned, { synchronizeAcceptedMain }));
  }

  // Forward preparation inventories the existing dev under the same already
  // held repository lease. It never creates a worktree, aborts a merge, clears a
  // block or runs bootstrap recovery as a side effect of reading integration.
  async inspectForwardPreparationDevOwned(projectRoot, { lease } = {}) {
    this.#assertAvailable("inspectForwardPreparationDevOwned");
    await requiredGuardLease(lease).assertOwned();
    const repoRoot = await repositoryRoot(projectRoot);
    if (!lease.repositoryLockKeys?.has(taskRepositoryKey(repoRoot))) throw new Error("Forward dev inspection requires its repository lease");
    await this.#assertRepositoryProcessTreeClear(repoRoot);
    const devRoot = await worktreeForBranch(repoRoot, this.devBranch);
    if (!devRoot || !pathInside(this.devWorktreesRoot, devRoot)) throw new Error("Forward preparation requires the existing managed dev");
    const info = await lstat(devRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Forward managed dev custody changed");
    for (const file of [this.#withdrawalFile(repoRoot), this.#devBootstrapRecoveryFile(repoRoot),
      await this.#integrationBlockFile(repoRoot)]) {
      if (await access(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
        throw new Error("Forward preparation preserves pending dev recovery; use its original owner first");
      }
    }
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "index.lock"]) {
      const file = path.resolve(await runGit(["rev-parse", "--git-path", name], { cwd: devRoot }));
      if (await access(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
        throw new Error(`Forward preparation preserves unfinished dev Git operation: ${name}`);
      }
    }
    const mainCommit = await localMainCommit(repoRoot);
    const headCommit = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: devRoot });
    const branch = await runGit(["symbolic-ref", "HEAD"], { cwd: devRoot });
    const reference = await runGit(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], { cwd: repoRoot });
    const dirty = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: devRoot });
    if (headCommit !== reference || branch !== `refs/heads/${this.devBranch}` || dirty
        || await gitMaybe(["merge-base", "--is-ancestor", mainCommit, headCommit], { cwd: devRoot }) === null) {
      throw new Error("Forward preparation requires exact clean dev containing accepted main");
    }
    return { repositoryRoot: repoRoot, projectRoot: devRoot, branch: this.devBranch, mainCommit,
      headCommit, acceptedMainIntegrated: true, forwardReadOnly: true };
  }

  async synchronizeMainIntoDev({ projectRoot, publishedRevision = null } = {}) {
    this.#assertAvailable("synchronizeMainIntoDev");
    const expectedMainCommit = exactCommitId(publishedRevision, "published revision");
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, null, async (lease) => {
      const currentLocalMain = await localMainCommit(repoRoot);
      let verifySynchronization = null;
      if (currentLocalMain !== expectedMainCommit) {
        const publication = await this.readPublication();
        const published = publicationStateRepositories(publication ?? {})
          .find((entry) => samePath(entry.root, repoRoot))?.revision;
        if (!publication?.generation || published !== expectedMainCommit) {
          throw new Error(
            `published revision ${expectedMainCommit} is not the accepted local main ${currentLocalMain}`,
          );
        }
        verifySynchronization = async () => {
          await lease.assertOwned();
          await this.#acceptedMainBootstrapPublication(repoRoot, expectedMainCommit, publication.generation);
          if (await localMainCommit(repoRoot) !== currentLocalMain) {
            throw new Error("Published synchronization local main changed");
          }
          const remote = await this.#runOwned(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
            { cwd: repoRoot, lease });
          await this.#runOwned(["merge-base", "--is-ancestor", expectedMainCommit, remote], { cwd: repoRoot, lease });
          await this.#runOwned(["merge-base", "--is-ancestor", currentLocalMain, expectedMainCommit], { cwd: repoRoot, lease });
        };
      }
      return this.#synchronizeMainIntoDevOwned({
        repoRoot,
        expectedMainCommit,
        observedMainCommit: expectedMainCommit,
        verifySynchronization,
        lease,
      });
    });
  }

  async bootstrapAcceptedMainIntoDev({
    projectRoot, acceptedMainCommit, expectedDevCommit, publishedRevision,
    expectedPublicationGeneration, expectedMergeBaseCommit, requestId,
    reviewedChangelogFile = null, expectedResolvedTree = null,
  } = {}) {
    this.#assertAvailable("bootstrapAcceptedMainIntoDev");
    const main = exactCommitId(acceptedMainCommit, "accepted local main");
    const oldDev = exactCommitId(expectedDevCommit, "expected managed dev");
    const published = exactCommitId(publishedRevision, "durable published revision");
    const generation = String(expectedPublicationGeneration ?? "").trim();
    if (!generation || generation.length > 200) {
      throw new Error("Accepted-main bootstrap requires exact publication generation");
    }
    const base = exactCommitId(expectedMergeBaseCommit, "expected main/dev merge base");
    const hasReviewFile = reviewedChangelogFile != null;
    const hasResolvedTree = expectedResolvedTree != null;
    if (hasReviewFile !== hasResolvedTree) {
      throw new Error("Accepted-main bootstrap needs both reviewed CHANGELOG bytes and exact resolved tree");
    }
    const resolvedTree = hasResolvedTree ? exactCommitId(expectedResolvedTree, "reviewed resolved tree") : null;
    const id = String(requestId ?? "").trim();
    if (!id || id.length > 200 || id.includes("\0")) {
      throw new Error("Accepted-main bootstrap requires one bounded request id");
    }
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, null, async (lease) => {
      const devRoot = await worktreeForBranch(repoRoot, this.devBranch);
      if (!devRoot || !pathInside(this.devWorktreesRoot, devRoot)) {
        throw new Error("Accepted-main bootstrap requires the existing managed dev worktree");
      }
      await this.#assertRecoverableDev(repoRoot, devRoot, { lease });
      const receipt = await this.#readAcceptedMainBootstrapReceipt(repoRoot, id);
      if (receipt) {
        if (receipt.version !== 2 || receipt.phase !== "completed"
          || receipt.requestId !== id || !samePath(receipt.repositoryRoot, repoRoot)
          || receipt.mainCommit !== main || receipt.oldDevCommit !== oldDev
          || receipt.publishedRevision !== published || receipt.publicationGeneration !== generation
          || receipt.mergeBaseCommit !== base || (receipt.reviewedResolvedTree ?? null) !== resolvedTree) {
          throw new Error("Accepted-main bootstrap request identity changed");
        }
        const current = await this.#runOwned(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], {
          cwd: repoRoot, lease,
        });
        if (await gitMaybe(["merge-base", "--is-ancestor", receipt.integrationCommit, current], {
          cwd: repoRoot,
        }) === null) throw new Error("Accepted-main bootstrap completed dev identity was replaced");
        return { status: "completed_replay", integrated: true, ...receipt, headCommit: current };
      }
      await this.#acceptedMainBootstrapPublication(repoRoot, published, generation);
      await this.#acceptedMainBootstrapMain(repoRoot, main);
      const devHead = await this.#runOwned(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], {
        cwd: repoRoot, lease,
      });
      const [worktreeHead, branch, status, bases] = await Promise.all([
        runGit(["rev-parse", "HEAD^{commit}"], { cwd: devRoot }),
        runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: devRoot }),
        runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: devRoot }),
        runGit(["merge-base", "--all", oldDev, main], { cwd: repoRoot }),
      ]);
      if (devHead !== oldDev || worktreeHead !== oldDev || branch !== `refs/heads/${this.devBranch}`) {
        throw new Error("Accepted-main bootstrap managed dev CAS changed");
      }
      if (status) throw new Error("Accepted-main bootstrap requires a clean managed dev worktree");
      if (bases !== base) throw new Error("Accepted-main bootstrap ancestry proof changed");
      if (!await this.#acceptedMainBootstrapPublishedAncestry(repoRoot, published, main, base, lease)) {
        throw new Error("Accepted-main bootstrap published ancestry proof changed");
      }
      if (await gitMaybe(["merge-base", "--is-ancestor", main, oldDev], { cwd: repoRoot }) !== null) {
        return { status: "already_current", integrated: true, mainCommit: main, headCommit: oldDev };
      }
      await this.#assertAcceptedMainBootstrapModificationsOnly(devRoot, base, main, lease, oldDev);
      let reviewedChangelogBytes = null;
      if (hasReviewFile) {
        const source = path.resolve(String(reviewedChangelogFile));
        const sourceStat = await lstat(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
          throw new Error("Accepted-main bootstrap reviewed CHANGELOG source must be a regular file");
        }
        reviewedChangelogBytes = await readFile(source);
      }
      let mergeActive = false;
      let casStarted = false;
      let conflicts = [];
      let reviewedConflictApplied = false;
      try {
        try {
          await this.#runOwned([
            "-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
            "merge", "--no-ff", "--no-commit", main,
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
          if (resolvedTree && conflicts.length === 1 && conflicts[0] === "CHANGELOG.md") {
            await writeFile(path.join(devRoot, "CHANGELOG.md"), reviewedChangelogBytes);
            await this.#runOwned(["add", "--", "CHANGELOG.md"], { cwd: devRoot, lease });
            const reviewedTree = await this.#runOwned(["write-tree"], { cwd: devRoot, lease });
            if (reviewedTree !== resolvedTree) {
              throw new Error("Accepted-main bootstrap reviewed resolution tree changed");
            }
            reviewedConflictApplied = true;
          } else {
            await this.#runOwned(["merge", "--abort"], { cwd: devRoot, lease });
            mergeActive = false;
            const restored = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: devRoot });
            const restoredHead = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: devRoot });
            if (restored || restoredHead !== oldDev) throw new Error("Accepted-main bootstrap conflict rollback is unproved");
            return { status: "conflict", integrated: false, conflicts, mainCommit: main, headCommit: oldDev };
          }
        }
        const resultTree = await this.#runOwned(["write-tree"], { cwd: devRoot, lease });
        await this.#assertAcceptedMainBootstrapModificationsOnly(devRoot, oldDev, resultTree, lease);
        if (resolvedTree && (!reviewedConflictApplied || resultTree !== resolvedTree)) {
          throw new Error("Accepted-main bootstrap reviewed conflict proof was not applied");
        }
        const integrationCommit = await this.#runOwned([
          "-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
          "commit-tree", resultTree, "-p", oldDev, "-p", main,
        ], { cwd: repoRoot, lease, input: "merge(agent-hub): bootstrap accepted local main into dev\n" });
        await this.#runOwned(["merge", "--abort"], { cwd: devRoot, lease });
        mergeActive = false;
        const restored = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: devRoot });
        const restoredHead = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: devRoot });
        if (restored || restoredHead !== oldDev) throw new Error("Accepted-main bootstrap pre-CAS restore is unproved");
        await lease.assertOwned();
        await this.#acceptedMainBootstrapPublication(repoRoot, published, generation);
        await this.#acceptedMainBootstrapMain(repoRoot, main);
        const currentBase = await this.#runOwned(["merge-base", "--all", oldDev, main], { cwd: repoRoot, lease });
        if (currentBase !== base) throw new Error("Accepted-main bootstrap ancestry changed before CAS");
        if (!await this.#acceptedMainBootstrapPublishedAncestry(repoRoot, published, main, base, lease)) {
          throw new Error("Accepted-main bootstrap published ancestry changed before CAS");
        }
        const record = {
          version: 2, kind: "accepted-local-main-bootstrap-v1", repositoryRoot: repoRoot,
          devRoot, devBranch: this.devBranch, requestId: id, oldDevCommit: oldDev,
          mainCommit: main, publishedRevision: published, publicationGeneration: generation,
          mergeBaseCommit: base, reviewedResolvedTree: resolvedTree,
          integrationCommit, resultTree, createdAt: new Date().toISOString(),
        };
        const file = this.#devBootstrapRecoveryFile(repoRoot);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
          encoding: "utf8", flag: "wx", mode: 0o600,
        });
        casStarted = true;
        await this.#runOwned(["update-ref", "--stdin"], {
          cwd: repoRoot, lease,
          input: `start\nverify refs/heads/main ${main}\nupdate refs/heads/${this.devBranch} ${integrationCommit} ${oldDev}\nprepare\ncommit\n`,
        });
        const recovered = await this.#recoverDevBootstrapTransaction(repoRoot, devRoot, lease);
        if (!recovered?.recovered) throw new Error("Accepted-main bootstrap CAS outcome is unknown");
        let publicationCurrent = true;
        try {
          await this.#acceptedMainBootstrapPublication(repoRoot, published, generation);
        } catch (error) {
          if (error.message !== "Accepted-main bootstrap publication provenance changed") throw error;
          publicationCurrent = false;
        }
        return {
          status: publicationCurrent ? "merged" : "merged_publication_advanced",
          integrated: true, publicationCurrent, mainCommit: main, devHeadBefore: oldDev,
          headCommit: integrationCommit, resultTree, mergeBaseCommit: base,
          reviewedResolvedTree: resolvedTree, requestId: id,
        };
      } catch (error) {
        if (error?.processTreeStopped === false) throw error;
        // After the CAS boundary the durable record, not an in-process retry,
        // owns reconciliation of an unknown effect.
        if (casStarted) throw error;
        if (mergeActive) {
          await this.#runOwned(["merge", "--abort"], { cwd: devRoot, lease });
        }
        await this.#recoverDevBootstrapTransaction(repoRoot, devRoot, lease);
        throw error;
      }
    });
  }

  async prepare(params = {}) {
    this.#assertAvailable("prepare");
    return this.withTaskLock(params.taskId, (lease) => this.prepareOwned({ ...params, lease }));
  }

  async prepareOwned({ taskId, taskNumber = null, projectRoot, lease = null, dependencyMode = "skip", dependencyOverrideReason = null, claimOperationId = null } = {}) {
    return measureTaskOperation("prepare-task", () => this.#prepareOwned({
      taskId, taskNumber, projectRoot, lease, dependencyMode, dependencyOverrideReason, claimOperationId,
    }));
  }

  async #prepareOwned({ taskId, taskNumber, projectRoot, lease, dependencyMode, dependencyOverrideReason, claimOperationId }) {
    this.#assertAvailable("prepareOwned");
    if (!["skip", "ensure", "verify"].includes(dependencyMode)) throw new Error("Invalid Task dependency mode");
    const id = normalizedTaskId(taskId);
    const custody = this.#claimNamespace(id);
    if (custody) {
      if (dependencyOverrideReason != null) throw new Error("Custody cannot override a prior release wait");
      const workspace = await this.readIndependentClaimNamespaceOwned({ state: custody, lease });
      if (![custody.source.repositoryRoot, custody.source.projectRoot, workspace.projectRoot].some(root => samePath(root, projectRoot))) {
        throw new Error("Task custody does not match the selected logical repository");
      }
      if (dependencyMode !== "skip") {
        const lockfiles = await trackedNpmLockfiles(custody.namespace.root, workspace.projectRoot);
        if (lockfiles.length) await withInterprocessLocks([path.join(this.dataDir, "locks", `task-dependencies-${id}-${custody.namespace.epoch}`)], async dependencyLease => {
          await this.prepareDependencies({ projectRoot: workspace.projectRoot, lockfiles,
            verify: dependencyMode === "verify", lease: combinedLease(lease, dependencyLease),
            runNpm: (args, options) => this.#runOwnedNpm(args, { ...options, lease: combinedLease(lease, dependencyLease) }) });
        });
      }
      return workspace;
    }
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(id);
    const selectedRoot = canonicalPath(projectRoot);
    const selectedWorktreeRoot = await worktreeRoot(selectedRoot);
    const selection = taskSparseCheckoutSelection(selectedWorktreeRoot, selectedRoot);
    const repoRoot = await repositoryRoot(projectRoot);
    let prepareEntered = false;
    const workspace = await this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      prepareEntered = true;
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
      const baseRef = this.#custodyBaseRef(id, repoKey);
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
    }).catch(async error => {
      const repositoryKey = taskRepositoryKey(repoRoot);
      const lockPath = path.join(this.dataDir, "locks", `task-git-dev-${repositoryKey}.lock`);
      const timedOutPath = interprocessLockAdmissionTimeoutPath(error);
      if (!prepareEntered && typeof claimOperationId === "string" && claimOperationId
          && timedOutPath && samePath(timedOutPath, lockPath)) {
        await requiredGuardLease(lease).assertOwned();
        const refusal = new TaskClaimLockAdmissionError();
        this.#claimLockAdmissionErrors.set(refusal, Object.freeze({
          version: 1, kind: "task-git-dev-lock-admission-v1", phase: "before-prepare",
          taskId: id, operationId: claimOperationId, repositoryRoot: repoRoot, repositoryKey, lockPath,
        }));
        throw refusal;
      }
      throw error;
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

  async assertInitialNativeTestOwned(evidence, { lease, record = null } = {}) {
    this.#assertAvailable("assertInitialNativeTestOwned");
    await requiredGuardLease(lease).assertOwned();
    const identity = evidence.identity;
    const managed = await this.managedRepositoryRoot(identity.sourceRoot,
      { taskId: evidence.taskId, taskNumber: evidence.taskNumber });
    if (!managed || !samePath(managed, evidence.projectRoot)) throw new Error("Initial native Test source is not its exact managed Task checkout");
    const git = (args, cwd = identity.sourceRoot) => this.#runOwned(args, { cwd, lease });
    if (identity.returnedResultCommit) {
      await git(["merge-base", "--is-ancestor", identity.returnedResultCommit, identity.sourceCommit]);
    }
    if (await git(["rev-parse", "HEAD^{commit}"]) !== identity.sourceCommit
        || await git(["rev-parse", "HEAD^{tree}"]) !== identity.sourceTree
        || await git(["symbolic-ref", "--quiet", "--short", "HEAD"]) !== identity.sourceBranch
        || await git(["status", "--porcelain=v1", "--untracked-files=all"])
        || await localMainCommit(managed) !== identity.mainCommit) throw new Error("Initial native Test exact source or main changed");
    if (record && (record.before !== identity.devCommit || record.mainCommit !== identity.mainCommit
        || JSON.stringify(record.initialNativeTest) !== JSON.stringify(evidence))) throw new Error("Initial native Test original dev/source intent changed");
    const dev = await git(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], managed);
    if (dev !== identity.devCommit && dev !== record?.target) throw new Error("Initial native Test exact dev changed");
  }

  async #readCustodyWip(root, source) {
    if (source.origin === "registered-base") {
      if (!Array.isArray(source.wipPaths) || source.wipPaths.length || source.wipDigest !== claimCustodyHash([])) {
        throw new Error("Registered base cannot replace discovered Task WIP");
      }
      return { digest: claimCustodyHash([]), records: [] };
    }
    return readClaimCustodyWip(root, source.wipPaths);
  }

  async #reuseUnassignedBase({ taskId, taskNumber, source, lease, registeredProjectRoot }) {
    const id = normalizedTaskId(taskId);
    if (!registeredProjectRoot || !samePath(source.projectRoot, registeredProjectRoot)) {
      throw new Error("Unassigned base must be the current registered project root");
    }
    const repoRoot = await repositoryRoot(registeredProjectRoot);
    const repoKey = taskRepositoryKey(repoRoot);
    const branch = taskBranchName(id, repoRoot, taskNumber);
    // No existing Task artifact is discarded or silently replaced by local main.
    // An interrupted old prepare must be pinned through the managed-source route.
    const priorRoot = await lstat(path.join(this.taskWorktreesRoot, id)).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const refs = (await this.#runOwned(["for-each-ref", "--format=%(refname)"], { cwd: repoRoot, lease })).split(/\r?\n/);
    if (priorRoot || refs.some(ref => ref === `refs/heads/${branch}`
        || ref === `refs/heads/${taskBranchName(id, repoRoot)}` || ref.includes(`/${id}/`) || ref.endsWith(`/${id}`))) {
      throw new Error("Discovered prior Task source or refs require an exact preserved managed-source handoff");
    }
    const headCommit = await localMainCommit(repoRoot);
    const tree = await this.#runOwned(["rev-parse", `${headCommit}^{tree}`], { cwd: repoRoot, lease });
    if (source.headCommit !== headCommit || source.baseCommit !== headCommit || source.tree !== tree || source.branch !== branch
        || source.repositoryRoot && !samePath(source.repositoryRoot, repoRoot)) throw new Error("Pinned registered base changed");
    const pinned = { ...source, origin: "registered-base" };
    await this.#readCustodyWip(await worktreeRoot(registeredProjectRoot), pinned);
    await requiredGuardLease(lease).assertOwned();
    return { taskId, origin: "registered-base", repositoryRoot: repoRoot, projectRoot: canonicalPath(registeredProjectRoot),
      branch, baseRef: taskBaseRef(id, repoKey), baseCommit: headCommit, headCommit,
      gitBaseline: { repoRoot, tree: headCommit }, wipDigest: source.wipDigest };
  }

  async reuseClaimWorkspaceOwned(params = {}) {
    this.#assertAvailable("reuseClaimWorkspaceOwned");
    const { taskId, taskNumber, source, lease, unassigned = false, registeredProjectRoot = null } = params;
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(taskId);
    const repoRoot = await this.managedRepositoryRoot(source.projectRoot, { taskId, taskNumber });
    if (!repoRoot && unassigned) return this.#reuseUnassignedBase({ taskId, taskNumber, source, lease, registeredProjectRoot });
    if (!repoRoot) throw new Error("Custody source is not this managed Task workspace");
    if (source.origin === "registered-base" || unassigned && (!registeredProjectRoot
        || !samePath(repoRoot, await repositoryRoot(registeredProjectRoot)))) throw new Error("Custody registered repository differs");
    const taskRoot = await worktreeRoot(source.projectRoot);
    const git = args => this.#runOwned(args, { cwd: taskRoot, lease });
    const headCommit = await git(["rev-parse", "HEAD^{commit}"]);
    if (headCommit !== source.headCommit || await git(["rev-parse", "HEAD^{tree}"]) !== source.tree
        || await git(["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Custody source identity or clean state changed");
    const inventory = await readClaimCustodyWip(taskRoot, source.wipPaths);
    if (inventory.digest !== source.wipDigest
        || (await readClaimCustodyWip(taskRoot, source.wipPaths)).digest !== inventory.digest) throw new Error("Custody WIP differs from the saved handoff");
    const baseRef = this.#custodyBaseRef(normalizedTaskId(taskId), taskRepositoryKey(repoRoot));
    const baseCommit = await git(["rev-parse", `${baseRef}^{commit}`]);
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if ((source.baseCommit && source.baseCommit !== baseCommit) || (source.branch && source.branch !== branch)
        || (source.repositoryRoot && source.repositoryRoot !== repoRoot)) throw new Error("Custody registered source baseline changed");
    await requiredGuardLease(lease).assertOwned();
    return { taskId, repositoryRoot: repoRoot, projectRoot: canonicalPath(source.projectRoot), branch,
      baseRef, baseCommit, headCommit, gitBaseline: { repoRoot, tree: baseCommit }, wipDigest: inventory.digest };
  }

  planIndependentClaimNamespace(params) {
    this.#assertAvailable("planIndependentClaimNamespace");
    const { taskId, source, requestId, originalHash } = params;
    const epoch = claimCustodyHash({ taskId, requestId, originalHash, source });
    return { epoch, root: path.join(this.dataDir, "task-custody", epoch.slice(0, 32), "repository"),
      repositoryKey: taskRepositoryKey(source.repositoryRoot), logicalRepositoryRoot: source.repositoryRoot,
      refPrefix: `refs/agent-hub/task-custody/${epoch.slice(0, 32)}` };
  }

  async stageIndependentClaimNamespaceOwned(params) {
    this.#assertAvailable("stageIndependentClaimNamespaceOwned");
    const { state, lease } = params;
    await requiredGuardLease(lease).assertOwned();
    const { source, namespace } = state;
    const root = namespace.root;
    const expected = this.planIndependentClaimNamespace({ taskId: state.taskId, source,
      requestId: state.requestId, originalHash: state.originalHash });
    if (claimCustodyHash(expected) !== claimCustodyHash(namespace)) throw new Error("Independent namespace plan changed");
    const parent = path.dirname(root);
    const physicalData = await realpath(this.dataDir);
    let directory = this.dataDir;
    for (const segment of path.relative(this.dataDir, parent).split(path.sep)) {
      if (!segment || segment === "..") throw new Error("Invalid independent custody namespace");
      directory = path.join(directory, segment);
      const entry = await lstat(directory).catch(e => { if (e.code === "ENOENT") return null; throw e; });
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error("Custody parent is aliased or not a directory");
      if (!entry) await mkdir(directory);
      if (!pathInside(physicalData, await realpath(directory))) throw new Error("Custody parent escaped its data owner");
    }
    const intentFile = path.join(parent, "intent.json");
    const prior = await readFile(intentFile, "utf8").then(JSON.parse, e => { if (e.code === "ENOENT") return null; throw e; });
    if (prior && claimCustodyHash(prior) !== claimCustodyHash(namespace)) throw new Error("Namespace staging is owned by another intent");
    const existingRoot = await lstat(root).catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (existingRoot && (!existingRoot.isDirectory() || existingRoot.isSymbolicLink()
        || (!prior && (await readdir(root)).length))) throw new Error("Custody refuses an unowned or aliased source namespace");
    const existingGit = existingRoot && await lstat(path.join(root, ".git")).catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (existingGit && (!existingGit.isDirectory() || existingGit.isSymbolicLink())) throw new Error("Custody cannot reuse linked Git");
    if (!prior) await writeSelectedRecord(intentFile, namespace);
    await mkdir(root, { recursive: true });
    // init/fetch by immutable object identity are repeatable private staging,
    // not Task prepare/ensure. No linked Git/common objects/hardlink clone.
    const git = args => this.#runOwned(args, { cwd: root, lease });
    await git(["init", "-b", source.branch]);
    if (process.platform === "win32") await git(["config", "core.longpaths", "true"]);
    await git(["config", "core.autocrlf", "false"]);
    if (await access(path.join(root, ".git", "objects", "info", "alternates")).then(() => true, () => false)
        || await access(path.join(root, ".git", "shallow")).then(() => true, () => false)) throw new Error("Custody requires independent full Git objects");
    for (const commit of new Set([source.headCommit, source.baseCommit])) {
      if (await gitMaybe(["cat-file", "-e", `${commit}^{commit}`], { cwd: root }) === null) {
        await git(["fetch", "--no-tags", "--no-write-fetch-head", source.repositoryRoot, commit]);
      }
      await git(["rev-list", "--objects", "--missing=error", commit]);
    }
    const branch = `refs/heads/${source.branch}`;
    const head = await gitMaybe(["rev-parse", "--verify", branch], { cwd: root });
    if (head && head !== source.headCommit) throw new Error("Private staged branch changed; refusing overwrite");
    if (!head) await git(["update-ref", branch, source.headCommit, "0".repeat(40)]);
    await git(["symbolic-ref", "HEAD", branch]);
    if (!await access(path.join(root, ".git", "index")).then(() => true, () => false)) await git(["checkout"]);
    if (await git(["rev-parse", "HEAD^{tree}"]) !== source.tree || await git(["status", "--porcelain=v1", "--untracked-files=all"])) {
      throw new Error("Independent source did not materialize its exact clean tree");
    }
    const sourceRoot = await worktreeRoot(source.projectRoot);
    const wip = await this.#readCustodyWip(sourceRoot, source);
    if (wip.digest !== source.wipDigest) throw new Error("Legacy WIP changed before snapshot");
    await copyClaimCustodyWip(sourceRoot, root, wip);
    await copyClaimCustodyWip(sourceRoot, path.join(parent, "retained-wip"), wip);
    if ((await this.#readCustodyWip(root, source)).digest !== wip.digest) throw new Error("Independent WIP copy differs");
    const baseRef = `${namespace.refPrefix}/base`;
    const base = await gitMaybe(["rev-parse", "--verify", baseRef], { cwd: root });
    if (base && base !== source.baseCommit) throw new Error("Private base changed");
    if (!base) await git(["update-ref", baseRef, source.baseCommit, "0".repeat(40)]);
    const sourceRef = `${namespace.refPrefix}/source`;
    const retainedSource = await gitMaybe(["rev-parse", "--verify", sourceRef], { cwd: root });
    if (retainedSource && retainedSource !== source.headCommit) throw new Error("Retained custody source changed");
    if (!retainedSource) await git(["update-ref", sourceRef, source.headCommit, "0".repeat(40)]);
    const workspace = { taskId: state.taskId, repositoryRoot: source.repositoryRoot,
      projectRoot: canonicalPath(path.join(root, path.relative(sourceRoot, source.projectRoot))),
      branch: source.branch, baseRef, baseCommit: source.baseCommit, headCommit: source.headCommit,
      custodyEpoch: namespace.epoch, gitBaseline: { repoRoot: source.repositoryRoot, tree: source.baseCommit, custodyEpoch: namespace.epoch }, wipDigest: wip.digest };
    const result = { ...namespace, workspace };
    const snapshotFile = path.join(parent, "snapshot.json");
    const saved = await readFile(snapshotFile, "utf8").then(JSON.parse, e => { if (e.code === "ENOENT") return null; throw e; });
    if (saved && claimCustodyHash(saved) !== claimCustodyHash(result)) throw new Error("Independent snapshot differs on exact staging retry");
    if (!saved) await writeSelectedRecord(snapshotFile, result);
    return result;
  }

  async readIndependentClaimNamespaceOwned(params) {
    this.#assertAvailable("readIndependentClaimNamespaceOwned");
    const { state, lease, exactInitial = false } = params;
    await requiredGuardLease(lease).assertOwned();
    const { namespace } = state;
    const expected = this.planIndependentClaimNamespace({ taskId: state.taskId, source: state.source,
      requestId: state.planRequestId ?? state.requestId, originalHash: state.originalHash });
    const { workspace, ...identity } = namespace;
    if (!workspace || claimCustodyHash(expected) !== claimCustodyHash(identity)) throw new Error("Namespace authority changed");
    const root = namespace.root;
    const physical = await realpath(root);
    if (!samePath(root, physical) || !(await lstat(path.join(root, ".git"))).isDirectory()
        || await access(path.join(root, ".git", "objects", "info", "alternates")).then(() => true, () => false)
        || !samePath(await runGit(["rev-parse", "--absolute-git-dir"], { cwd: root }), path.join(root, ".git"))) {
      throw new Error("Private custody source shares or aliases mutable Git");
    }
    const recorded = JSON.parse(await readFile(path.join(path.dirname(root), "snapshot.json"), "utf8"));
    if (claimCustodyHash(recorded) !== claimCustodyHash(namespace)) throw new Error("Durable namespace snapshot differs");
    if (await runGit(["rev-parse", `${namespace.refPrefix}/source^{commit}`], { cwd: root }) !== state.source.headCommit) {
      throw new Error("Retained custody history reference changed");
    }
    const headCommit = await this.#runOwned(["rev-parse", "HEAD^{commit}"], { cwd: root, lease });
    if (await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }) !== workspace.branch
        || await runGit(["rev-parse", `${workspace.baseRef}^{commit}`], { cwd: root }) !== workspace.baseCommit) throw new Error("Namespace branch/base authority changed");
    if (exactInitial && (headCommit !== workspace.headCommit
        || await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root })
        || (await this.#readCustodyWip(root, state.source)).digest !== state.source.wipDigest)) throw new Error("Initial namespace snapshot changed before takeover");
    return { ...workspace, headCommit };
  }

  async managedRepositoryRoot(projectRoot, { taskId, taskNumber = null } = {}) {
    this.#assertAvailable("managedRepositoryRoot");
    const expectedTaskId = String(taskId ?? "").trim();
    if (!expectedTaskId) return null;
    const id = normalizedTaskId(expectedTaskId);
    const candidate = canonicalPath(projectRoot);
    const custody = this.#claimNamespace(id);
    if (custody) return samePath(candidate, custody.namespace.workspace.projectRoot) ? custody.source.repositoryRoot : null;
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
    return measureTaskOperation("snapshot", () => this.#snapshotOwned({ taskId, taskNumber, projectRoot, turnId, summary, lease }));
  }

  async #snapshotOwned({ taskId, taskNumber, projectRoot, turnId, summary, lease }) {
    this.#assertAvailable("snapshotOwned");
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(taskId);
    const repoRoot = this.#claimNamespace(normalizedTaskId(taskId))?.source.repositoryRoot ?? await repositoryRoot(projectRoot);
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
        resultSnapshot: { repoRoot: workspace.repositoryRoot, tree: headCommit,
          ...(workspace.custodyEpoch ? { custodyEpoch: workspace.custodyEpoch } : {}) },
      };
    });
  }

  async mergeIntoDev(snapshot) {
    this.#assertAvailable("mergeIntoDev");
    return this.withTaskLock(snapshot.taskId, (lease) => this.mergeIntoDevOwned(snapshot, { lease }));
  }

  async mergeIntoDevOwned(snapshot, options = {}) {
    return measureTaskOperation("integrate-dev", () => this.#mergeIntoDevOwned(snapshot, options));
  }

  async #assertSelectedAbsorptionGit(input, repoRoot, lease) {
    if (!input) return;
    const binding = normalizedSelectedAbsorption(input);
    const { declaration: d } = selectedAbsorptionHandoff({ requestId: binding.requestId, text: binding.text });
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(d.sourceTaskId);
    const repoKey = taskRepositoryKey(repoRoot);
    const sourceRoot = path.join(this.taskWorktreesRoot, d.sourceTaskId, repoKey);
    if (!samePath(await this.managedRepositoryRoot(sourceRoot, {
      taskId: d.sourceTaskId, taskNumber: binding.sourceTaskNumber,
    }), repoRoot)) throw selectedCompositionRequiredError("absorbed source checkout identity changed");
    const [head, base, branch, status] = await Promise.all([
      runGit(["rev-parse", "HEAD^{commit}"], { cwd: sourceRoot }),
      runGit(["rev-parse", `${this.#custodyBaseRef(d.sourceTaskId, repoKey)}^{commit}`], { cwd: repoRoot }),
      runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: sourceRoot }),
      runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: sourceRoot }),
    ]);
    if (head !== d.sourceCommit || base !== d.baseCommit || status
        || branch !== taskBranchName(d.sourceTaskId, repoRoot, binding.sourceTaskNumber)
        || await runGit(["rev-parse", `refs/heads/${branch}^{commit}`], { cwd: repoRoot }) !== head) {
      throw selectedCompositionRequiredError("absorbed source HEAD/base/branch or saved cleanliness changed");
    }
  }

  #selectedMaterializationBinding(preview, lease) {
    const blobs = new Map();
    return {
      root: preview.devRoot, files: preview.worktreePlan,
      readBlob: async (blob) => {
        if (!blobs.has(blob)) blobs.set(blob, await this.#runOwned(["cat-file", "blob", blob], {
          cwd: preview.repositoryRoot, rawOutput: true, lease,
        }));
        return blobs.get(blob);
      },
      readCheckout: (paths) => readSelectedCheckoutAuthority((args, options) => this.#runOwned(args, {
        ...options, cwd: preview.devRoot, lease,
      }), paths),
    };
  }

  async #selectedCompositionForResult({ taskId, repositoryRoot: repoRoot,
    resultCommit, devHeadCommit }) {
    const id = normalizedTaskId(taskId);
    const recordsRoot = path.join(this.dataDir, "task-selected-compositions",
      id, taskRepositoryKey(repoRoot));
    const operations = await readdir(recordsRoot).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    if (operations.length > 64) {
      throw new Error("Selected composition durable operation history exceeds its bound");
    }
    const matches = [];
    for (const operationId of operations) {
      const root = path.join(recordsRoot, operationId);
      const receipt = await readFile(path.join(root, "completed.json"), "utf8")
        .then(JSON.parse, (error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
      if (receipt?.resultCommit !== resultCommit) continue;
      const intent = JSON.parse(await readFile(path.join(root, "intent.json"), "utf8"));
      const preview = intent?.preview;
      if (![1, 2].includes(intent.version) || intent.operationId !== operationId
          || receipt.version !== intent.version || receipt.operationId !== operationId
          || preview?.taskId !== id || !samePath(preview.repositoryRoot, repoRoot)
          || preview.taskCommit !== resultCommit
          || receipt.previewHash !== preview.previewHash
          || receipt.devCommit !== preview.proofCommit
          || createHash("sha256").update(JSON.stringify({
            ...preview, previewHash: undefined,
          })).digest("hex") !== preview.previewHash) {
        throw new Error("Selected composition result receipt lacks exact durable proof");
      }
      const journalRoot = path.join(root, "materialization");
      const record = JSON.parse(await readFile(path.join(journalRoot, "record.json"), "utf8"));
      // Legacy interpretation belongs to actual v1 capture, not merely two
      // mutable headers. Retained v2-only identities cannot bypass their seal.
      if (record.version !== intent.version
          || (intent.version === 1 && (Object.hasOwn(receipt, "materializationHash")
            || Object.hasOwn(record, "checkout")
            || !Array.isArray(record.files)
            || record.files.some((file) => ["oldGitSha256", "newGitSha256", "oldSerialization"]
              .some((key) => Object.hasOwn(file, key)))))) {
        throw new Error("Selected composition historical materialization version changed");
      }
      if (receipt.version === 2) {
        if (receipt.materializationHash !== createHash("sha256").update(JSON.stringify(record)).digest("hex")) {
          throw new Error("Selected composition historical materialization binding changed");
        }
        await verifySelectedCompositionRecord(record, {
          root: preview.devRoot, journalRoot, files: preview.worktreePlan,
          readBlob: (blob) => runGit(["cat-file", "blob", blob], { cwd: repoRoot, rawOutput: true }),
        });
      }
      const retained = await readFile(path.join(root, "review.bundle"));
      if (createHash("sha256").update(retained).digest("hex") !== preview.bundleSha256) {
        throw new Error("Selected composition retained review bundle changed");
      }
      if (preview.publishedResolutionInput) {
        const retainedPublished = await readFile(path.join(root, "published-review.bundle"));
        if (createHash("sha256").update(retainedPublished).digest("hex")
            !== preview.publishedResolutionInput.resolutionBundleSha256) {
          throw new Error("Selected composition retained published resolution bundle changed");
        }
      }
      if (await gitMaybe(["merge-base", "--is-ancestor", preview.proofCommit,
        devHeadCommit], { cwd: repoRoot }) === null) {
        throw new Error("Selected composition exact integration is absent from managed dev");
      }
      const publication = await this.readPublication();
      if (publication?.generation !== preview.publicationGeneration
          || publicationStateRepositories(publication ?? {})
            .find((entry) => samePath(entry.root, repoRoot))?.revision !== preview.publishedCommit) {
        throw new Error("Selected composition publication advanced since its exact Test proof");
      }
      const remote = await runGit(["ls-remote", preview.remoteUrl, "refs/heads/main"], {
        cwd: repoRoot,
      });
      if (remote !== `${preview.remoteCommit}\trefs/heads/main`) {
        const remoteCommit = /^([a-f0-9]{40})\trefs\/heads\/main$/u.exec(remote)?.[1];
        const published = readNativePublishedSelectedComposition({ dataDir: this.dataDir, preview, remoteCommit });
        if (!published) throw new Error("Selected composition remote advanced since its exact Test proof");
      }
      matches.push(preview);
    }
    if (matches.length > 1) throw new Error("Selected composition Task result has ambiguous durable receipts");
    return matches[0] ?? null;
  }

  async previewSelectedCompositionOwned({
    taskId, taskNumber = null, projectRoot, proofCommit, bundlePath,
    bundleSha256, authority, expectedTaskRevision, lease = null,
  } = {}) {
    this.#assertAvailable("previewSelectedCompositionOwned");
    throw Object.assign(new Error("New Test conflicts use native Git resolution; legacy selected materialization is recovery-only"),
      { code: "TASK_NATIVE_GIT_REQUIRED" });
  }

  #selectedCompositionRecordRoot(preview, operationId) {
    const id = String(operationId ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(id)) {
      throw new Error("Selected composition operation id is not a safe durable identity");
    }
    return path.join(this.dataDir, "task-selected-compositions",
      normalizedTaskId(preview.taskId), taskRepositoryKey(preview.repositoryRoot), id);
  }

  async #selectedRecoveryVersion(root, intent, receipt = null) {
    if (![1, 2].includes(intent.version) || (receipt && receipt.version !== intent.version)) {
      throw new Error("Selected recovery explicit version changed");
    }
    const record = await readFile(path.join(root, "materialization", "record.json"), "utf8")
      .then(JSON.parse, error => { if (error.code === "ENOENT") return null; throw error; });
    if (record && (record.version !== intent.version
        || (intent.version === 1 && (Object.hasOwn(record, "checkout")
          || record.files.some(file => ["oldGitSha256", "newGitSha256", "oldSerialization"]
            .some(key => Object.hasOwn(file, key))))))) {
      throw new Error("Selected recovery materialization version changed");
    }
    if (intent.version === 1 && (intent.preview.absorptionInput
        || (receipt && Object.hasOwn(receipt, "materializationHash")))) {
      throw new Error("Selected recovery cannot reinterpret v2 authority as v1");
    }
    return intent.version;
  }

  async #selectedCompositionIntent(preview, operationId) {
    const root = this.#selectedCompositionRecordRoot(preview, operationId);
    const pathname = path.join(root, "intent.json");
    const existing = await readFile(pathname, "utf8").then(JSON.parse, (error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      const existingVersion = await this.#selectedRecoveryVersion(root, existing);
      const expected = { version: existingVersion, kind: "selected-task-composition-v1", operationId, preview };
      if (JSON.stringify(existing) !== JSON.stringify(expected)) {
        throw new Error("Selected composition original operation identity changed");
      }
      return { root, intent: existing };
    }
    throw Object.assign(new Error("Legacy materialization requires an existing original intent"),
      { code: "TASK_NATIVE_GIT_REQUIRED" });
  }

  async readSelectedCompositionOwned(preview, { operationId, lease = null, validateAbsorption = null } = {}) {
    this.#assertAvailable("readSelectedCompositionOwned");
    await requiredGuardLease(lease).assertOwned();
    const root = this.#selectedCompositionRecordRoot(preview, operationId);
    const intent = await readFile(path.join(root, "intent.json"), "utf8").then(JSON.parse, (error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!intent) return { status: "not_admitted" };
    if (![1, 2].includes(intent.version) || intent.kind !== "selected-task-composition-v1"
        || intent.operationId !== operationId
        || JSON.stringify(intent.preview) !== JSON.stringify(preview)) {
      throw new Error("Selected composition durable intent changed");
    }
    const receipt = await readFile(path.join(root, "completed.json"), "utf8").then(JSON.parse, (error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    const version = await this.#selectedRecoveryVersion(root, intent, receipt);
    const readFiles = version === 1 ? legacySelectedV1.readSelectedCompositionFiles : readSelectedCompositionFiles;
    const devRef = await runGit(["rev-parse", "--verify", "refs/heads/dev^{commit}"], {
      cwd: preview.repositoryRoot,
    });
    if (preview.absorptionInput && (receipt || devRef === preview.proofCommit)) {
      if (typeof validateAbsorption !== "function") {
        throw selectedCompositionRequiredError("live absorbed terminal fence unavailable");
      }
      validateAbsorption();
      await this.#assertSelectedAbsorptionGit(preview.absorptionInput, preview.repositoryRoot, lease);
      validateAbsorption();
      await requiredGuardLease(lease).assertOwned();
    }
    if (receipt) {
      const journal = await readFiles(path.join(root, "materialization"), null, {
        ...this.#selectedMaterializationBinding(preview, lease), phase: "applied",
      });
      if (receipt.version !== version || (version === 2 && receipt.materializationHash !== createHash("sha256").update(JSON.stringify(journal)).digest("hex"))
          || receipt.operationId !== operationId
          || receipt.previewHash !== preview.previewHash
          || receipt.devCommit !== preview.proofCommit || devRef !== preview.proofCommit) {
        throw new Error("Selected composition completion receipt or dev ref changed");
      }
      const [head, status, resultRef] = await Promise.all([
        runGit(["rev-parse", "HEAD^{commit}"], { cwd: preview.devRoot }),
        runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: preview.devRoot }),
        gitMaybe(["rev-parse", "--verify", `${this.#custodyResultRef(preview.taskId,
          taskRepositoryKey(preview.repositoryRoot))}^{commit}`], { cwd: preview.repositoryRoot }),
      ]);
      if (head !== preview.proofCommit || status || resultRef !== preview.taskCommit) {
        throw new Error("Selected composition completed receipt lacks exact clean Git readback");
      }
      return { status: "applied", proof: preview, receipt };
    }
    if (devRef === preview.devCommit) return { status: "before_cas", proof: preview };
    if (devRef === preview.proofCommit) return { status: "after_cas", proof: preview };
    throw new Error("Selected composition dev ref is neither old nor exact reviewed CAS result");
  }

  async applySelectedCompositionOwned(preview, { operationId, lease = null, validateAbsorption = null } = {}) {
    this.#assertAvailable("applySelectedCompositionOwned");
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(preview.taskId);
    return this.#withClearDevLock(preview.repositoryRoot, lease, async (ownedLease) => {
      const { root, intent } = await this.#selectedCompositionIntent(preview, operationId);
      const version = intent.version;
      const readFiles = version === 1 ? legacySelectedV1.readSelectedCompositionFiles : readSelectedCompositionFiles;
      const prepareFiles = version === 1 ? legacySelectedV1.prepareSelectedCompositionFiles : prepareSelectedCompositionFiles;
      const applyFiles = version === 1 ? legacySelectedV1.applySelectedCompositionFiles : applySelectedCompositionFiles;
      const resultRef = this.#custodyResultRef(preview.taskId, taskRepositoryKey(preview.repositoryRoot));
      const materializationBinding = this.#selectedMaterializationBinding(preview, ownedLease);
      const state = await this.readSelectedCompositionOwned(preview, { operationId, lease: ownedLease, validateAbsorption });
      if (state.status === "applied") return state;
      if (state.status === "before_cas") {
        if (preview.absorptionInput) {
          if (typeof validateAbsorption !== "function") throw selectedCompositionRequiredError("live absorbed Task fence unavailable");
          validateAbsorption();
          await this.#assertSelectedAbsorptionGit(preview.absorptionInput, preview.repositoryRoot, ownedLease);
        }
        const [main, base, task, dev, taskStatus, devStatus, publication, remoteOutput,
          currentResultRef, configuredRemote, taskBranch, devBranch] = await Promise.all([
          runGit(["rev-parse", "--verify", "refs/heads/main^{commit}"], { cwd: preview.repositoryRoot }),
          runGit(["rev-parse", "--verify", `${this.#custodyBaseRef(preview.taskId,
            taskRepositoryKey(preview.repositoryRoot))}^{commit}`], { cwd: preview.repositoryRoot }),
          runGit(["rev-parse", "HEAD^{commit}"], { cwd: preview.taskRoot }),
          runGit(["rev-parse", "HEAD^{commit}"], { cwd: preview.devRoot }),
          runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: preview.taskRoot }),
          runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: preview.devRoot }),
          this.readPublication(),
          this.#runOwned(["ls-remote", preview.remoteUrl, "refs/heads/main"], {
            cwd: preview.repositoryRoot, lease: ownedLease,
          }),
          gitMaybe(["rev-parse", "--verify", `${resultRef}^{commit}`], { cwd: preview.repositoryRoot }),
          runGit(["remote", "get-url", "origin"], { cwd: preview.repositoryRoot }),
          runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: preview.taskRoot }),
          runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: preview.devRoot }),
        ]);
        if (main !== preview.acceptedLocalMainCommit || base !== preview.taskBaseCommit
            || task !== preview.taskCommit || dev !== preview.devCommit || taskStatus || devStatus
            || configuredRemote !== preview.remoteUrl || taskBranch !== preview.branch
            || devBranch !== this.devBranch
            || currentResultRef !== preview.resultRefBefore
            || publication?.generation !== preview.publicationGeneration
            || publicationStateRepositories(publication ?? {})
              .find((entry) => samePath(entry.root, preview.repositoryRoot))?.revision !== preview.publishedCommit
            || remoteOutput !== `${preview.remoteCommit}\trefs/heads/main`) {
          const refusal = new Error("Selected composition inputs changed before its Git CAS; no ref effect");
          refusal.code = "SELECTED_COMPOSITION_NO_EFFECT";
          throw refusal;
        }
        const bundleBytes = await readFile(preview.bundlePath);
        if (createHash("sha256").update(bundleBytes).digest("hex") !== preview.bundleSha256) {
          const refusal = new Error("Selected composition reviewed bundle changed before Git CAS");
          refusal.code = "SELECTED_COMPOSITION_NO_EFFECT";
          throw refusal;
        }
        const retainedBundle = path.join(root, "review.bundle");
        const retained = await readFile(retainedBundle).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (!retained) await writeFile(retainedBundle, bundleBytes, { flag: "wx" });
        else if (!retained.equals(bundleBytes)) throw new Error("Selected composition retained bundle changed");
        await this.#runOwned(["bundle", "verify", retainedBundle], {
          cwd: preview.repositoryRoot, lease: ownedLease,
        });
        await this.#runOwned(["bundle", "unbundle", retainedBundle], {
          cwd: preview.repositoryRoot, lease: ownedLease,
        });
        if (preview.publishedResolutionInput) {
          const published = preview.publishedResolutionInput;
          const bytes = await readFile(published.resolutionBundlePath);
          if (createHash("sha256").update(bytes).digest("hex") !== published.resolutionBundleSha256) {
            const refusal = new Error("Selected composition published resolution bundle changed before Git CAS");
            refusal.code = "SELECTED_COMPOSITION_NO_EFFECT";
            throw refusal;
          }
          const retainedPath = path.join(root, "published-review.bundle");
          const existing = await readFile(retainedPath).catch((error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
          });
          if (!existing) await writeFile(retainedPath, bytes, { flag: "wx" });
          else if (!existing.equals(bytes)) throw new Error("Selected composition retained published bundle changed");
          await this.#runOwned(["bundle", "verify", retainedPath], { cwd: preview.repositoryRoot, lease: ownedLease });
          await this.#runOwned(["bundle", "unbundle", retainedPath], { cwd: preview.repositoryRoot, lease: ownedLease });
        }
        const importedPlan = selectedCompositionFilePlan(await this.#runOwned([
          "diff-tree", "--raw", "-r", "-z", "--no-renames", preview.devTree, preview.proofTree,
        ], { cwd: preview.repositoryRoot, lease: ownedLease }));
        if (JSON.stringify(importedPlan) !== JSON.stringify(preview.worktreePlan)
            || await this.#runOwned(["rev-parse", `${preview.proofCommit}^{tree}`], {
              cwd: preview.repositoryRoot, lease: ownedLease,
            }) !== preview.proofTree) {
          throw new Error("Selected composition imported objects changed their exact reviewed tree");
        }
        if (preview.absorptionInput) {
          const checked = await verifySelectedCompositionObjects({ ...preview,
            git: (args, options) => runGit(args, { ...options, cwd: preview.repositoryRoot }) });
          if (checked.proofHash !== preview.proofHash) {
            throw selectedCompositionRequiredError("absorbed proof changed before materialization");
          }
        }
        const journalRoot = path.join(root, "materialization");
        const materialization = await readFile(path.join(journalRoot, "record.json"), "utf8")
          .then(() => readFiles(journalRoot, null, materializationBinding), (error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
          });
        if (!materialization) await prepareFiles({
          root: preview.devRoot, journalRoot, ...materializationBinding,
        });
        const beforeCas = await this.readSelectedCompositionOwned(preview, { operationId, lease: ownedLease, validateAbsorption });
        if (beforeCas.status !== "before_cas") {
          throw new Error("Selected composition dev CAS state changed after materialization preparation");
        }
        await this.#assertSelectedAbsorptionGit(preview.absorptionInput, preview.repositoryRoot, ownedLease);
        if (preview.absorptionInput) validateAbsorption();
        const [finalPublication, finalRemote, finalMain, finalTask,
          finalTaskStatus, finalConfiguredRemote] = await Promise.all([
          this.readPublication(),
          this.#runOwned(["ls-remote", preview.remoteUrl, "refs/heads/main"], {
            cwd: preview.repositoryRoot, lease: ownedLease,
          }),
          runGit(["rev-parse", "refs/heads/main^{commit}"], { cwd: preview.repositoryRoot }),
          runGit(["rev-parse", "HEAD^{commit}"], { cwd: preview.taskRoot }),
          runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: preview.taskRoot }),
          runGit(["remote", "get-url", "origin"], { cwd: preview.repositoryRoot }),
        ]);
        if (finalPublication?.generation !== preview.publicationGeneration
            || publicationStateRepositories(finalPublication ?? {})
              .find((entry) => samePath(entry.root, preview.repositoryRoot))?.revision !== preview.publishedCommit
            || finalRemote !== `${preview.remoteCommit}\trefs/heads/main`
            || finalMain !== preview.acceptedLocalMainCommit
            || finalTask !== preview.taskCommit || finalTaskStatus
            || finalConfiguredRemote !== preview.remoteUrl) {
          const refusal = new Error("Selected composition proof changed at the last pre-CAS readback");
          refusal.code = "SELECTED_COMPOSITION_NO_EFFECT";
          throw refusal;
        }
        if (preview.publishedResolutionInput && createHash("sha256")
          .update(await readFile(preview.publishedResolutionInput.resolutionBundlePath)).digest("hex")
          !== preview.publishedResolutionInput.resolutionBundleSha256) {
          const refusal = new Error("Selected composition published resolution bundle changed at the last pre-CAS readback");
          refusal.code = "SELECTED_COMPOSITION_NO_EFFECT";
          throw refusal;
        }
        await this.#assertSelectedAbsorptionGit(preview.absorptionInput, preview.repositoryRoot, ownedLease);
        if (preview.absorptionInput) validateAbsorption();
        const preparedFiles = await readFiles(journalRoot, null, materializationBinding);
        if (version === 2) await verifySelectedCompositionFiles(preparedFiles, { ...materializationBinding, phase: "before_cas" });
        await this.#runOwned(["update-ref", "refs/heads/dev", preview.proofCommit, preview.devCommit], {
          cwd: preview.repositoryRoot, lease: ownedLease,
        });
      }
      const afterCas = await this.readSelectedCompositionOwned(preview, { operationId, lease: ownedLease, validateAbsorption });
      if (afterCas.status !== "after_cas") {
        throw new Error("Selected composition exact dev CAS cannot be proven");
      }
      const journal = await readFiles(path.join(root, "materialization"), null, materializationBinding);
      await applyFiles(journal, materializationBinding);
      await this.#runOwned(["read-tree", preview.proofTree], { cwd: preview.devRoot, lease: ownedLease });
      const [devHead, status] = await Promise.all([
        runGit(["rev-parse", "HEAD^{commit}"], { cwd: preview.devRoot }),
        runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: preview.devRoot }),
      ]);
      if (devHead !== preview.proofCommit || status) {
        throw new Error("Selected composition exact CAS was not cleanly materialized");
      }
      const oldResultRef = preview.resultRefBefore ?? "0".repeat(40);
      const observedResult = await gitMaybe(["rev-parse", "--verify", `${resultRef}^{commit}`], {
        cwd: preview.repositoryRoot,
      });
      if (observedResult !== preview.taskCommit) {
        if (observedResult !== preview.resultRefBefore) {
          throw new Error("Selected composition Task result ref changed after dev CAS");
        }
        await this.#runOwned(["update-ref", resultRef, preview.taskCommit, oldResultRef], {
          cwd: preview.repositoryRoot, lease: ownedLease,
        });
      }
      const receipt = { version, operationId, previewHash: preview.previewHash,
        ...(version === 2 ? { materializationHash: createHash("sha256").update(JSON.stringify(journal)).digest("hex") } : {}),
        devCommit: preview.proofCommit, resultCommit: preview.taskCommit };
      const completedPath = path.join(root, "completed.json");
      try {
        await writeSelectedRecord(completedPath, receipt);
      } catch (error) {
        if (error?.code !== "EEXIST"
            || JSON.stringify(JSON.parse(await readFile(completedPath, "utf8"))) !== JSON.stringify(receipt)) {
          throw error;
        }
      }
      return this.readSelectedCompositionOwned(preview, { operationId, lease: ownedLease, validateAbsorption });
    });
  }

  #nativeIntegrationFile(taskId, repoRoot, operationId) {
    const operation = String(operationId ?? "").trim();
    if (!operation) throw new Error("Native Test requires its original lifecycle operation id");
    return path.join(this.dataDir, "task-native-integrations", normalizedTaskId(taskId),
      taskRepositoryKey(repoRoot), `${createHash("sha256").update(operation).digest("hex")}.json`);
  }

  async pendingNativeIntegrationOwned({ taskId, projectRoot, operationId, lease } = {}) {
    this.#assertAvailable("pendingNativeIntegrationOwned");
    await requiredGuardLease(lease).assertOwned();
    const repoRoot = await repositoryRoot(projectRoot);
    const file = this.#nativeIntegrationFile(taskId, repoRoot, operationId);
    const record = await readFile(file, "utf8").then(JSON.parse, (error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!record) return null;
    if (record.version !== 1 || record.kind !== "native-task-integration-v1"
        || record.operationId !== operationId || record.snapshot.taskId !== taskId
        || !samePath(record.snapshot.repositoryRoot, repoRoot)) throw new Error("Native Test journal identity changed");
    return record.phase === "failed" ? null : record;
  }

  async withAppliedNativeTerminalOwned({ taskId, projectRoot, operationId, lease } = {}, commit) {
    this.#assertAvailable("withAppliedNativeTerminalOwned");
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      const original = await this.pendingNativeIntegrationOwned({ taskId, projectRoot, operationId, lease: ownedLease });
      if (!original?.target || original.nativeAbsorptionInput || original.nativeAbsorptionHistory
          || original.initialNativeTest || original.nativeResolutionReview) {
        throw new Error("Applied ordinary native Test intent is required");
      }
      const verify = async () => {
        await ownedLease.assertOwned();
        await this.#assertNoProcessTreeGuard(taskId);
        const record = await this.pendingNativeIntegrationOwned({ taskId, projectRoot, operationId, lease: ownedLease });
        if (JSON.stringify(record) !== JSON.stringify(original)) throw new Error("Native Test original intent changed");
        const s = record.snapshot;
        if (record.nativeHistoryAuthority) await this.#nativeHistoryAuthority(s,
          { mainCommit: record.mainCommit, headCommit: record.before }, ownedLease, record.nativeHistoryAuthority);
        const managedRoot = await this.managedRepositoryRoot(s.projectRoot, { taskId, taskNumber: s.branch });
        if (!managedRoot || !samePath(managedRoot, repoRoot)) {
          throw new Error("Native Test managed source binding changed");
        }
        const git = (args, cwd = repoRoot) => this.#runOwned(["--no-optional-locks", ...args], { cwd, lease: ownedLease });
        const { root, identity } = this.#nativeIntegrationStaging(record);
        const capture = JSON.parse(await readFile(path.join(root, "merge.json"), "utf8"));
        if (!samePath(record.stageRoot, path.join(root, "repository"))
            || JSON.stringify(capture.identity) !== JSON.stringify(identity)
            || capture.next !== 1 || capture.head !== record.target || capture.conflict || capture.merging
            || capture.merges?.length !== 1 || capture.merges[0].taskId !== taskId
            || capture.merges[0].resultCommit !== s.headCommit || capture.merges[0].commit !== record.target
            || await git(["rev-parse", "refs/heads/main^{commit}"]) !== record.mainCommit
            || await git(["rev-parse", `${s.baseRef}^{commit}`]) !== s.baseCommit
            || await git(["show", "-s", "--format=%P", record.target]) !== `${record.before} ${s.headCommit}`
            || await git(["rev-parse", `${record.target}^{tree}`]) !== record.targetTree
            || await git(["rev-parse", "refs/heads/dev^{commit}"]) !== record.target
            || await git(["symbolic-ref", "-q", "HEAD"], s.projectRoot) !== `refs/heads/${s.branch}`
            || await git(["rev-parse", "HEAD^{commit}"], s.projectRoot) !== s.headCommit
            || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], s.projectRoot)
            || await git(["symbolic-ref", "-q", "HEAD"], record.devRoot) !== "refs/heads/dev") {
          throw new Error("Applied native Test Git binding changed");
        }
        for (const cwd of [record.devRoot, record.stageRoot]) {
          if (await git(["rev-parse", "HEAD^{commit}"], cwd) !== record.target
              || await git(["rev-parse", "HEAD^{tree}"], cwd) !== record.targetTree
              || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd)) {
            throw new Error("Applied native Test materialization changed");
          }
        }
        await this.#nativeHistoryOrigin(s, record.nativeHistoryAuthority, ownedLease);
        await ownedLease.assertOwned();
      };
      await verify();
      return commit(original, verify);
    });
  }

  async assertNativeIntegrationOwned(snapshot, { operationId, lease, nativeAbsorptionInput = null,
    nativeAbsorptionHistory = null, validateAbsorption = null } = {}) {
    this.#assertAvailable("assertNativeIntegrationOwned");
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(snapshot.taskId);
    const git = (args, cwd = snapshot.projectRoot) => this.#runOwned(args, { cwd, lease });
    if (await git(["rev-parse", "HEAD^{commit}"]) !== snapshot.headCommit
        || await git(["symbolic-ref", "-q", "HEAD"]) !== `refs/heads/${snapshot.branch}`
        || await git(["rev-parse", `${this.#custodyBaseRef(snapshot.taskId, taskRepositoryKey(snapshot.repositoryRoot))}^{commit}`], snapshot.repositoryRoot) !== snapshot.baseCommit
        || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
      throw Object.assign(new Error("Native Test source changed before terminal persistence"), { code: "TASK_NATIVE_INTEGRATION_UNKNOWN" });
    }
    const record = operationId ? await this.pendingNativeIntegrationOwned({
      taskId: snapshot.taskId, projectRoot: snapshot.repositoryRoot, operationId, lease,
    }) : null;
    if (nativeAbsorptionHistory) {
      if (typeof validateAbsorption !== "function") throw new Error("Native accepted absorption authority missing");
      validateAbsorption();
      await this.#nativeSelectedCompositionForResult(nativeAbsorptionHistory, lease);
    }
    if (record) {
      if (record.nativeHistoryAuthority) await this.#nativeHistoryAuthority(snapshot,
        { mainCommit: record.mainCommit, headCommit: record.before }, lease, record.nativeHistoryAuthority);
      if (JSON.stringify(record.nativeAbsorptionInput ?? null) !== JSON.stringify(nativeAbsorptionInput)
          || JSON.stringify(record.nativeAbsorptionHistory ?? null) !== JSON.stringify(nativeAbsorptionHistory)) {
        throw new Error("Native Test original absorption binding changed");
      }
      if (nativeAbsorptionInput) {
        if (typeof validateAbsorption !== "function") throw new Error("Native Test live absorption authority missing");
        validateAbsorption();
        await this.#assertSelectedAbsorptionGit(nativeAbsorptionInput, snapshot.repositoryRoot, lease);
      }
      if (record.snapshot.headCommit !== snapshot.headCommit || record.snapshot.baseCommit !== snapshot.baseCommit
          || record.snapshot.branch !== snapshot.branch) throw new Error("Native Test source binding changed");
      if (record.target) {
        await this.#nativeIntegrationComposition(record, lease);
        if (await localMainCommit(snapshot.repositoryRoot) !== record.mainCommit) {
          throw Object.assign(new Error("Native Test main changed before terminal persistence"), { code: "TASK_NATIVE_INTEGRATION_UNKNOWN" });
        }
        if (await git(["rev-parse", `refs/heads/${this.devBranch}^{commit}`], snapshot.repositoryRoot) !== record.target
            || await git(["rev-parse", "HEAD^{commit}"], record.devRoot) !== record.target
            || await git(["write-tree"], record.devRoot) !== record.targetTree
            || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], record.devRoot)) {
          throw Object.assign(new Error("Native Test Git effect lacks exact readback"), { code: "TASK_NATIVE_INTEGRATION_UNKNOWN" });
        }
      }
    }
    if (!record) {
      const dev = await this.#prepareDevOwned(snapshot.repositoryRoot, snapshot.repositoryRoot, lease);
      if (await git(["symbolic-ref", "-q", "HEAD"], dev.projectRoot) !== `refs/heads/${this.devBranch}`
          || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], dev.projectRoot)
          || await gitMaybe(["merge-base", "--is-ancestor", snapshot.headCommit, dev.headCommit], { cwd: snapshot.repositoryRoot }) === null) {
        throw Object.assign(new Error("Reused native Test lacks exact current dev readback"), { code: "TASK_NATIVE_INTEGRATION_UNKNOWN" });
      }
    }
    await this.#nativeHistoryOrigin(snapshot, record?.nativeHistoryAuthority, lease);
    return record;
  }

  async withNativeIntegrationTerminalOwned(snapshot, { operationId, lease, nativeAbsorptionInput = null,
    nativeAbsorptionHistory = null, validateAbsorption = null, initialNativeTest = null, validateInitialNativeTest = null } = {}, commit) {
    this.#assertAvailable("withNativeIntegrationTerminalOwned");
    return this.#withClearDevLock(snapshot.repositoryRoot, lease, async (ownedLease) => {
      const record = await this.assertNativeIntegrationOwned(snapshot,
        { operationId, lease: ownedLease, nativeAbsorptionInput, nativeAbsorptionHistory, validateAbsorption });
      const descriptor = record && (nativeAbsorptionInput || nativeAbsorptionHistory)
        ? this.#nativeIntegrationDescriptor(record) : null;
      if (initialNativeTest) {
        if (JSON.stringify(record?.initialNativeTest) !== JSON.stringify(initialNativeTest)) throw new Error("Initial native Test terminal Git binding changed");
        await validateInitialNativeTest({ record });
        // The source/candidate verifier awaits I/O. Re-fence this exact dev
        // owner and materialization after it, immediately before SQL terminal.
        await ownedLease.assertOwned();
        await this.assertNativeIntegrationOwned(snapshot,
          { operationId, lease: ownedLease, nativeAbsorptionInput, nativeAbsorptionHistory, validateAbsorption });
      }
      validateAbsorption?.();
      return commit(descriptor);
    });
  }

  #nativeIntegrationDescriptor(record) {
    if (!record?.target || (!record.nativeAbsorptionInput && !record.nativeAbsorptionHistory)) {
      throw new Error("Native absorbed Test capture missing");
    }
    const descriptor = { kind: "native-task-integration-v1", taskId: record.snapshot.taskId,
      operationId: record.operationId, expectedTaskRevision: record.expectedTaskRevision,
      repositoryRoot: record.snapshot.repositoryRoot, taskBaseCommit: record.snapshot.baseCommit,
      taskCommit: record.snapshot.headCommit, devCommit: record.before, proofCommit: record.target,
      proofTree: record.targetTree, mainCommit: record.mainCommit,
      absorptionInput: record.nativeAbsorptionInput ?? record.nativeAbsorptionHistory.absorptionInput,
      ...(record.nativeAbsorptionHistory ? { absorptionHistory: record.nativeAbsorptionHistory } : {}) };
    descriptor.descriptorHash = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
    return selectedCompositionFields({ taskId: descriptor.taskId, resultCommit: descriptor.taskCommit,
      selectedComposition: descriptor }).selectedComposition;
  }

  async #nativeSelectedCompositionForResult(proof, lease) {
    if (!lease) return this.withTaskLock(proof.taskId,
      ownedLease => this.#nativeSelectedCompositionForResult(proof, ownedLease));
    const descriptor = selectedCompositionFields({ taskId: proof.taskId, resultCommit: proof.taskCommit,
      selectedComposition: proof }).selectedComposition;
    const file = this.#nativeIntegrationFile(descriptor.taskId, descriptor.repositoryRoot, descriptor.operationId);
    const record = JSON.parse(await readFile(file, "utf8"));
    if (record.version !== 1 || record.kind !== "native-task-integration-v1" || record.phase === "failed"
        || record.operationId !== descriptor.operationId
        || JSON.stringify(this.#nativeIntegrationDescriptor(record)) !== JSON.stringify(descriptor)) {
      throw selectedCompositionRequiredError("native historical intent differs from committed Test");
    }
    const { root } = this.#nativeIntegrationStaging(record);
    if (!samePath(record.stageRoot, path.join(root, "repository"))) {
      throw selectedCompositionRequiredError("native historical staging root changed");
    }
    const captured = JSON.parse(await readFile(path.join(root, "merge.json"), "utf8"));
    if (captured.next !== 1 || captured.merges?.length !== 1 || captured.head !== record.target
        || captured.conflict || captured.merging) {
      throw selectedCompositionRequiredError("native historical merge capture is not completed");
    }
    // Historical evidence is Git objects plus the original capture, never the
    // later rolling dev/source checkout or its current config/physical bytes.
    await this.#nativeIntegrationComposition(record, lease);
    if (descriptor.absorptionHistory) await this.#nativeSelectedCompositionForResult(descriptor.absorptionHistory, lease);
    await assertNativeTaskHistories({
      git: (args, options = {}) => this.#runOwned(args, { ...options, cwd: descriptor.repositoryRoot, lease }),
      baseCommit: descriptor.mainCommit,
      tasks: [{ taskId: descriptor.taskId, baseCommit: descriptor.taskBaseCommit,
        resultCommit: descriptor.taskCommit, selectedComposition: descriptor }],
    });
    return descriptor;
  }

  #nativeIntegrationStaging(record) {
    const snapshot = record.snapshot;
    const identity = { policy: "native-dev-merge-v1", taskId: snapshot.taskId,
      resultCommit: snapshot.headCommit, before: record.before, mainCommit: record.mainCommit,
      ...(record.nativeHistoryAuthority ? { nativeHistoryAuthority: record.nativeHistoryAuthority } : {}),
      ...(record.nativeAbsorptionInput || record.nativeAbsorptionHistory ? {
        ...(record.nativeAbsorptionInput ? { nativeAbsorptionInput: record.nativeAbsorptionInput } : {}),
        ...(record.nativeAbsorptionHistory ? { nativeAbsorptionHistory: record.nativeAbsorptionHistory } : {}),
        expectedTaskRevision: record.expectedTaskRevision } : {}) };
    const root = path.join(this.dataDir, "task-native-merges",
      createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24));
    return { root, identity };
  }

  async #nativeIntegrationComposition(record, lease) {
    const snapshot = record.snapshot;
    const { root, identity } = this.#nativeIntegrationStaging(record);
    if (record.target) {
      if (!samePath(record.stageRoot, path.join(root, "repository"))) {
        throw new Error("Native Test staging root binding changed");
      }
      // A journaled effect cannot reconstruct a missing staging capture.
      await readFile(path.join(root, "merge.json"), "utf8");
    }
    const composition = await mergeSelectedResults({ root, sourceRoot: snapshot.repositoryRoot,
      baseCommit: record.before, tasks: [{ taskId: snapshot.taskId, baseCommit: snapshot.baseCommit, resultCommit: snapshot.headCommit }], identity,
      resolutionReview: record.nativeResolutionReview ?? null,
      verifyReview: this.verifyNativeResolutionReview,
      deliveredHead: record.target ?? null,
      gitAt: (cwd, args, options = {}) => this.#runOwned(args, { ...options, cwd, lease,
        guardRepositoryRoot: snapshot.repositoryRoot, timeoutMs: 300_000 }),
      readJson: pathname => readFile(pathname, "utf8").then(JSON.parse, error => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
      writeJson: async (pathname, value) => {
        const temporary = `${pathname}.${randomUUID()}.tmp`;
        await writeSelectedRecord(temporary, value);
        await rename(temporary, pathname);
      },
    });
    if (record.target && (record.target !== composition.head || record.targetTree !== composition.tree)) {
      throw new Error("Native Test completed merge binding changed");
    }
    return composition;
  }

  async #nativeHistoryOrigin(snapshot, binding, lease) {
    if (binding?.sourcePublication) await this.#assertSourcePublication(snapshot.repositoryRoot, binding.sourcePublication, lease);
    if (binding?.adoptions?.length) await assertNativeUpstreamOrigin({
      git: (args, options = {}) => this.#runOwned(args, { ...options, cwd: snapshot.repositoryRoot, lease }),
      adoptions: binding.adoptions, originCommit: binding.adoptions[0].adoptedCommit });
    else if (binding?.baseline?.ownGitPublication) await assertOwnGitPublicationOrigin({ provenance: binding.baseline,
      repositoryRoot: snapshot.repositoryRoot, tasks: [{ taskId: snapshot.taskId }],
      readOwnGitPublication: input => readOwnGitPublicationOrigin({ dataDir: this.dataDir, ...input }),
      git: (args, options = {}) => this.#runOwned(args, { ...options, cwd: snapshot.repositoryRoot, lease }) });
    else if (binding?.baseline?.adoptions) await assertInstalledAgreedMainOrigin({ provenance: binding.baseline,
      git: (args, options = {}) => this.#runOwned(args, { ...options, cwd: snapshot.repositoryRoot, lease }) });
    if (binding?.publishedMetadata) {
      const current = await publishedMetadataContext({ publication: await this.readPublication(), repositoryRoot: snapshot.repositoryRoot,
        git: (args, options = {}) => this.#runOwned(args, { ...options, cwd: snapshot.repositoryRoot, lease }) });
      if (JSON.stringify(current) !== JSON.stringify(binding.publishedMetadata)) throw new Error("Native Test published metadata authority changed");
    }
  }

  async #assertSourcePublication(repoRoot, binding, lease) {
    const publication = await this.readPublication();
    const entry = publicationStateRepositories(publication ?? {}).find(item => samePath(item.root, repoRoot));
    const source = sourceOnlyGitPublication(entry);
    if (!source || source.revision !== binding.revision || createHash("sha256").update(JSON.stringify(entry)).digest("hex") !== binding.entrySha256) {
      throw new Error("Source-only Git publication changed during native Test");
    }
    const git = args => this.#runOwned(args, { cwd: repoRoot, lease });
    const remote = parseGitHubRemote(await git(["config", "--get", "remote.origin.url"]));
    if (remote?.owner.toLowerCase() !== "iiityraeliii" || remote?.repo.toLowerCase() !== "agenthub"
      || String(await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0] !== binding.originCommit) {
      throw new Error("Source-only Git publication origin changed");
    }
    await git(["merge-base", "--is-ancestor", source.revision, binding.originCommit]);
    if (source.tree && await git(["rev-parse", `${source.revision}^{tree}`]) !== source.tree) {
      throw new Error("Source-only Git publication tree changed");
    }
  }

  async #nativeHistoryAuthority(snapshot, dev, lease, expected = undefined) {
    const tasks = [{ taskId: snapshot.taskId, baseCommit: snapshot.baseCommit, resultCommit: snapshot.headCommit }];
    const git = (args, options = {}) => this.#runOwned(args, { ...options, cwd: snapshot.repositoryRoot, lease });
    const adoptions = await readNativeUpstreamAdoptions({ git, tasks, repositoryRoot: snapshot.repositoryRoot,
      localMainCommit: dev.mainCommit });
    if (adoptions.length) await assertNativeUpstreamOrigin({ git, adoptions, originCommit: adoptions[0].adoptedCommit });
    const publication = await this.readPublication();
    const publishedEntry = publicationStateRepositories(publication ?? {})
      .find(entry => samePath(entry.root, snapshot.repositoryRoot));
    const published = publishedEntry?.revision;
    const source = sourceOnlyGitPublication(publishedEntry);
    const sourcePublication = source ? { revision: source.revision, entrySha256: createHash("sha256").update(JSON.stringify(publishedEntry)).digest("hex"),
      originCommit: adoptions[0]?.adoptedCommit ?? source.revision } : null;
    if (sourcePublication) await this.#assertSourcePublication(snapshot.repositoryRoot, sourcePublication, lease);
    const runtimeRoot = path.dirname(this.dataDir);
    const planRevision = `native-test:${snapshot.taskId}:${snapshot.headCommit}`;
    let baseline = expected?.baseline ?? null;
    if (expected === undefined && publication?.generation && published && !sourcePublication) {
      baseline = await installedNativeHistoryBaseline({ git, repositoryRoot: snapshot.repositoryRoot,
        primaryMainCommit: dev.mainCommit, publishedRevision: published, tasks, runtimeRoot, planRevision, adoptions,
        readOwnGitPublication: input => readOwnGitPublicationOrigin({ dataDir: this.dataDir, ...input }),
        sourceGit: (cwd, args) => this.#runOwned(args, { cwd, lease, guardRepositoryRoot: snapshot.repositoryRoot }) });
    } else if (baseline) {
      await assertInstalledLocalSourceBaseline({ provenance: baseline, git, repositoryRoot: snapshot.repositoryRoot,
        primaryMainCommit: dev.mainCommit, publishedRevision: published, planRevision, tasks, runtimeRoot,
        readOwnGitPublication: input => readOwnGitPublicationOrigin({ dataDir: this.dataDir, ...input }) });
    }
    let publishedMetadata = null;
    // Older originals retain precisely their captured authority. New admissions
    // may inherit exact already-published metadata only after both source and dev
    // contain that immutable publication; dev alone never grants metadata credit.
    if (!baseline && (expected === undefined || Object.hasOwn(expected, "publishedMetadata"))) {
      const context = await publishedMetadataContext({ publication, repositoryRoot: snapshot.repositoryRoot, git });
      if (context && await git(["merge-base", context.commit, snapshot.headCommit]) === context.commit
          && await git(["merge-base", context.commit, dev.headCommit]) === context.commit) publishedMetadata = context;
    }
    const binding = { baseline, adoptions, ...(sourcePublication ? { sourcePublication } : {}),
      ...(publishedMetadata ? { publishedMetadata } : {}) };
    if (expected !== undefined && JSON.stringify(binding) !== JSON.stringify(expected)) {
      throw new Error("Native Test installed source or adoption authority changed");
    }
    return { binding, bases: [dev.headCommit, ...(baseline ? [baseline.sourceBaseCommit,
      ...(baseline.ownGitPublication ? [baseline.ownGitPublication.commit] : [])] : [])],
      metadataBases: [...(baseline ? [baseline.sourceBaseCommit, ...(baseline.ownGitPublication ? [baseline.ownGitPublication.commit] : [])] : []),
        ...(publishedMetadata ? [publishedMetadata.commit] : [])], adoptions };
  }

  async #mergeIntoDevOwned(snapshot, { lease, operationId = null, nativeAbsorptionInput = null,
    nativeAbsorptionHistory = null, expectedTaskRevision = null, validateAbsorption = null,
    initialNativeTest = null, validateInitialNativeTest = null, nativeResolutionReview = null }) {
    this.#assertAvailable("mergeIntoDevOwned");
    await requiredGuardLease(lease).assertOwned();
    await this.#assertNoProcessTreeGuard(snapshot.taskId);
    // Direct private Git callers also receive a stable content identity; public
    // lifecycle calls always supply their original durable operation id.
    operationId ??= `native:${snapshot.taskId}:${snapshot.headCommit}`;
    return this.#withClearDevLock(snapshot.repositoryRoot, lease, async (ownedLease) => {
      await this.#importCustodySnapshotOwned(snapshot, ownedLease);
      const file = this.#nativeIntegrationFile(snapshot.taskId, snapshot.repositoryRoot, operationId);
      let record = await this.pendingNativeIntegrationOwned({ taskId: snapshot.taskId,
        projectRoot: snapshot.repositoryRoot, operationId, lease: ownedLease });
      let dev;
      if (initialNativeTest) await validateInitialNativeTest({ record });
      if (record) {
        if (JSON.stringify(record.nativeResolutionReview ?? null) !== JSON.stringify(nativeResolutionReview)) {
          throw new Error("Native Test original reviewed resolution changed");
        }
        if (JSON.stringify(record.initialNativeTest ?? null) !== JSON.stringify(initialNativeTest)) throw new Error("Initial native Test original Git binding changed");
        if (JSON.stringify(record.nativeAbsorptionInput ?? null) !== JSON.stringify(nativeAbsorptionInput)
            || JSON.stringify(record.nativeAbsorptionHistory ?? null) !== JSON.stringify(nativeAbsorptionHistory)
            || ((nativeAbsorptionInput || nativeAbsorptionHistory) && record.expectedTaskRevision !== expectedTaskRevision)) {
          throw new Error("Native Test original absorbed admission changed");
        }
        snapshot = record.snapshot;
        dev = { repositoryRoot: snapshot.repositoryRoot, projectRoot: record.devRoot,
          branch: this.devBranch, headCommit: record.before, mainCommit: record.mainCommit };
      } else {
        dev = await this.#prepareDevOwned(snapshot.repositoryRoot, snapshot.repositoryRoot, ownedLease);
        if (nativeAbsorptionHistory) {
          if (typeof validateAbsorption !== "function") throw new Error("Native accepted absorption authority missing");
          validateAbsorption();
          await this.#nativeSelectedCompositionForResult(nativeAbsorptionHistory, ownedLease);
          if (await gitMaybe(["merge-base", "--is-ancestor", nativeAbsorptionHistory.taskCommit, snapshot.headCommit],
            { cwd: snapshot.repositoryRoot }) === null) throw new Error("Native absorbed history is not this result's ancestor");
        }
        if (nativeAbsorptionInput) {
          normalizedSelectedAbsorption(nativeAbsorptionInput);
          if (typeof validateAbsorption !== "function") throw new Error("Native absorbed Test lacks live authority");
          validateAbsorption();
          await this.#assertSelectedAbsorptionGit(nativeAbsorptionInput, snapshot.repositoryRoot, ownedLease);
        }
        const historyAuthority = await this.#nativeHistoryAuthority(snapshot, dev, ownedLease);
        await assertNativeTaskHistories({
          git: (args, options = {}) => this.#runOwned(args, { ...options, cwd: snapshot.repositoryRoot, lease: ownedLease }),
          baseCommit: dev.mainCommit,
          historyAuthority,
          tasks: [{ taskId: snapshot.taskId, baseCommit: snapshot.baseCommit, resultCommit: snapshot.headCommit,
            ...(nativeAbsorptionInput || nativeAbsorptionHistory
              ? { nativeAbsorptionInput: nativeAbsorptionInput ?? nativeAbsorptionHistory.absorptionInput } : {}) }],
        });
        record = { version: 1, kind: "native-task-integration-v1", operationId, phase: "prepared",
          snapshot, devRoot: dev.projectRoot, before: dev.headCommit, mainCommit: dev.mainCommit,
          nativeHistoryAuthority: historyAuthority.binding,
          ...(nativeResolutionReview ? { nativeResolutionReview } : {}),
          ...(initialNativeTest ? { initialNativeTest } : {}),
          ...(nativeAbsorptionInput || nativeAbsorptionHistory ? { expectedTaskRevision,
            ...(nativeAbsorptionInput ? { nativeAbsorptionInput } : {}),
            ...(nativeAbsorptionHistory ? { nativeAbsorptionHistory } : {}) } : {}) };
        await mkdir(path.dirname(file), { recursive: true });
        await writeSelectedRecord(file, record);
      }
      const git = (args, cwd = dev.projectRoot, options = {}) => this.#runOwned(args, { ...options, cwd, lease: ownedLease,
        guardRepositoryRoot: snapshot.repositoryRoot, timeoutMs: 300_000 });
      const sourceFence = async () => {
        await ownedLease.assertOwned();
        if (record.nativeHistoryAuthority) {
          const historyAuthority = await this.#nativeHistoryAuthority(snapshot, dev, ownedLease, record.nativeHistoryAuthority);
          await assertNativeTaskHistories({ git: (args, options = {}) => git(args, snapshot.repositoryRoot, options),
            baseCommit: record.mainCommit, tasks: [{ taskId: snapshot.taskId, baseCommit: snapshot.baseCommit,
              resultCommit: snapshot.headCommit, ...(nativeAbsorptionInput || nativeAbsorptionHistory
                ? { nativeAbsorptionInput: nativeAbsorptionInput ?? nativeAbsorptionHistory.absorptionInput } : {}) }],
            historyAuthority });
        }
        if (initialNativeTest) await validateInitialNativeTest({ record });
        if (nativeAbsorptionHistory) validateAbsorption();
        if (nativeAbsorptionInput) {
          validateAbsorption();
          await this.#assertSelectedAbsorptionGit(nativeAbsorptionInput, snapshot.repositoryRoot, ownedLease);
        }
        await this.#assertNoProcessTreeGuard(snapshot.taskId);
        if (await git(["rev-parse", "HEAD^{commit}"], snapshot.projectRoot) !== snapshot.headCommit
            || await git(["symbolic-ref", "-q", "HEAD"], snapshot.projectRoot) !== `refs/heads/${snapshot.branch}`
            || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], snapshot.projectRoot)
            || await localMainCommit(snapshot.repositoryRoot) !== record.mainCommit
            || await git(["rev-parse", `${this.#custodyBaseRef(snapshot.taskId, taskRepositoryKey(snapshot.repositoryRoot))}^{commit}`], snapshot.repositoryRoot) !== snapshot.baseCommit) {
          throw Object.assign(new Error("Native Test source/main changed; original remains unresolved"), { code: "TASK_NATIVE_INTEGRATION_UNKNOWN" });
        }
        await this.#nativeHistoryOrigin(snapshot, record.nativeHistoryAuthority, ownedLease);
      };
      await sourceFence();
      {
        try {
          const composition = await this.#nativeIntegrationComposition(record, ownedLease);
          record.target = composition.head;
          record.targetTree = composition.tree;
          record.stageRoot = composition.root;
        } catch (error) {
          if (error.code !== "RELEASE_NATIVE_MERGE_CONFLICT") throw error;
          if (await git(["rev-parse", `refs/heads/${this.devBranch}^{commit}`]) !== record.before
              || await git(["rev-parse", "HEAD^{commit}"]) !== record.before
              || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) throw error;
          record.phase = "failed";
          const temporary = `${file}.${randomUUID()}.tmp`;
          await writeSelectedRecord(temporary, record); await rename(temporary, file);
          return { integrated: false, conflicts: error.conflicts, devRestored: true,
            nativeConflictRoot: error.conflictRoot, error: error.message, dev };
        }
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeSelectedRecord(temporary, record); await rename(temporary, file);
      }
      // The target is journaled before import. Reopen must also finish that
      // import when the process stopped between these two steps.
      await git(["fetch", "--no-tags", record.stageRoot, record.target]);
      await sourceFence();
      const head = await git(["rev-parse", "HEAD^{commit}"]);
      const ref = await git(["rev-parse", `refs/heads/${this.devBranch}^{commit}`]);
      if (![record.before, record.target].includes(head) || ![record.before, record.target].includes(ref)
          || await git(["write-tree"]) !== await git(["rev-parse", `${head}^{tree}`])
          || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
        throw Object.assign(new Error("Native Test materialization is unknown; foreign bytes retained"), { code: "TASK_NATIVE_INTEGRATION_UNKNOWN" });
      }
      try {
        if (head !== record.target) await git(["checkout", "--detach", "--no-overwrite-ignore", record.target]);
        await sourceFence();
        if (ref !== record.target) await git(["update-ref", `refs/heads/${this.devBranch}`, record.target, record.before]);
        await git(["symbolic-ref", "HEAD", `refs/heads/${this.devBranch}`]);
        await sourceFence();
        await this.assertNativeIntegrationOwned(snapshot,
          { operationId, lease: ownedLease, nativeAbsorptionInput, nativeAbsorptionHistory, validateAbsorption });
      } catch (error) {
        throw Object.assign(new Error(`Native Test original Git effect requires readback: ${error.message}`), { code: "TASK_NATIVE_INTEGRATION_UNKNOWN" });
      }
      return { integrated: true, alreadyIntegrated: record.before === record.target,
        nativeOperationId: operationId, dev: { ...dev, headCommit: record.target } };
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
    if (params.initialNativeTest) await params.validateInitialNativeTest();
    const repoRoot = await repositoryRoot(params.projectRoot);
    await this.#assertTaskReleaseWait(params.taskId, repoRoot);
    if (params.nativeAbsorptionHistory) {
      params.validateAbsorption();
      await this.#nativeSelectedCompositionForResult(params.nativeAbsorptionHistory, params.lease);
    }
    if (params.expectedResultReferences) {
      params = { ...params, expectedResultCommit: params.expectedResultReferences
        .find((reference) => samePath(reference.projectRoot, repoRoot))?.resultCommit ?? null };
    }
    if (params.expectedResultCommit) {
      const reused = await this.#reuseTestResultOwned(params);
      if (reused) return reused;
    }
    const pendingNative = params.operationId ? await this.pendingNativeIntegrationOwned({ ...params, projectRoot: repoRoot }) : null;
    const snapshot = pendingNative?.snapshot ?? await this.snapshotOwned(params);
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
    const integration = await this.mergeIntoDevOwned(snapshot, { lease: params.lease, operationId: params.operationId,
      nativeAbsorptionInput: params.nativeAbsorptionInput, expectedTaskRevision: params.expectedTaskRevision,
      nativeAbsorptionHistory: params.nativeAbsorptionHistory,
      initialNativeTest: params.initialNativeTest, validateInitialNativeTest: params.validateInitialNativeTest,
      nativeResolutionReview: params.nativeResolutionReview,
      validateAbsorption: params.validateAbsorption });
    if (integration.integrated) {
      await params.lease.assertOwned();
      await this.#withClearDevLock(snapshot.repositoryRoot, params.lease, (ownedLease) => (
        this.#runOwned([
          "update-ref",
          this.#custodyResultRef(snapshot.taskId, taskRepositoryKey(snapshot.repositoryRoot)),
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
    const resultRef = this.#custodyResultRef(workspace.taskId, taskRepositoryKey(workspace.repositoryRoot));
    const recordedCommit = await gitMaybe(["rev-parse", "--verify", `${resultRef}^{commit}`], {
      cwd: workspace.repositoryRoot,
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
    // A stored Windows root may use its 8.3 spelling while Git resolves the
    // same repository to the long native path (or vice versa). Branch names
    // created before that canonicalization must remain valid for this exact
    // repository; the commit and repository evidence below are still checked.
    const storedRootBranch = taskBranchName(id, projectRoot, taskNumber);
    const storedRootLegacyBranch = taskBranchName(id, projectRoot);
    const storedBranch = String(branch ?? "").trim();
    if (![expectedBranch, legacyBranch, storedRootBranch, storedRootLegacyBranch].includes(storedBranch)) {
      throw new Error(`Task branch does not match its repository: ${branch}`);
    }
    const repoKeys = [...new Set([taskRepositoryKey(repoRoot), taskRepositoryKey(projectRoot)])];
    const existingCommits = async (refForKey) => {
      const values = [];
      for (const repoKey of repoKeys) {
        const commit = await gitMaybe(["rev-parse", "--verify", `${refForKey(repoKey)}^{commit}`], { cwd: repoRoot });
        if (commit && !values.includes(commit)) values.push(commit);
      }
      if (values.length > 1) throw new Error("Task repository path aliases have conflicting Git evidence");
      return values[0] ?? null;
    };
    const baseCommit = await existingCommits((repoKey) => this.#custodyBaseRef(id, repoKey));
    if (!baseCommit) {
      await runGit(["rev-parse", "--verify", `${this.#custodyBaseRef(id, repoKeys[0])}^{commit}`], { cwd: repoRoot });
      throw new Error("Task base reference is unavailable");
    }
    const acceptedCommit = await runGit(["rev-parse", "--verify", `${String(resultCommit)}^{commit}`], { cwd: repoRoot });
    const custody = this.#claimNamespace(id);
    if (custody && storedBranch !== custody.namespace.workspace.branch) throw new Error("Custody result branch differs");
    const branchCommit = await runGit(["rev-parse", "--verify", `refs/heads/${storedBranch}^{commit}`], {
      cwd: custody ? custody.namespace.root : repoRoot });
    if (custody && await runGit(["rev-parse", `${this.#custodyResultRef(id, taskRepositoryKey(repoRoot))}^{commit}`], { cwd: repoRoot }) !== acceptedCommit) {
      throw new Error("Task result is not the current custody result authority");
    }
    await runGit(["merge-base", "--is-ancestor", acceptedCommit, branchCommit], { cwd: repoRoot });
    const adoptedCommit = await existingCommits((repoKey) => taskLegacyAdoptionRef(id, repoKey));
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
      // local main is the agreed branch baseline. Publication and observation
      // remain separate authorities and do not silently choose another base.
      const adoptions = [];
      for (const task of [...tasks].sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)))) {
        const verified = await this.#recordedUpstreamAdoptionForSnapshot({ taskId: task.taskId,
          repoRoot, snapshotCommit: task.resultCommit, localMain, lease: ownedLease,
          publishedBaseCommit: published });
        if (!verified) continue;
        if (task.baseCommit != null && task.baseCommit !== verified.record.taskBaseCommit) {
          throw new Error("Selected Task adoption registered base changed");
        }
        adoptions.push({ taskId: task.taskId, resultCommit: task.resultCommit,
          recordRef: verified.recordRef, recordHash: verified.recordHash,
          adoptedCommit: verified.record.adoptedCommit, acceptedLocalMainCommit: localMain });
      }
      return { publishedBaseCommit: published, baseCommit: localMain,
        compositionPolicy: "main-selected-git-merge-v1", adoptions };
    });
  }

  async #squashTransferPreview({
    source, survivor, projectRoot, baselineResultCommit, newResultCommit, devAfterTree,
    authority, lease, cutover = null,
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
    if (cutover) {
      if (survivorBranchHead !== previousResult) {
        throw new Error("Squash cutover survivor branch changed from the accepted prior result");
      }
      const main = await this.#runOwned(["rev-parse", "refs/heads/main^{commit}"], { cwd: repoRoot, lease });
      if (main !== cutover.expectedMainCommit) throw new Error("Squash cutover main identity changed");
      const snapshot = await this.#taskWorktreeSnapshotTree(survivorId, repoRoot, lease);
      if (snapshot.headCommit !== previousResult || snapshot.tree !== cutover.expectedPreservedTree) {
        throw new Error("Squash cutover survivor worktree changed from the reviewed preserved tree");
      }
    } else if (survivorBranchHead !== result) {
      throw new Error("Squash survivor branch must point to the exact new clean result");
    }
    if (await gitMaybe(["merge-base", "--is-ancestor", baseline, result], { cwd: repoRoot }) === null) {
      throw new Error("Squash clean baseline must be an ancestor of the new survivor result");
    }
    for (const [task, expected, label] of [
      [source, sourceResult, "source"], ...(!cutover ? [[survivor, result, "survivor"]] : []),
    ]) {
      const workspaces = await this.describe(task.id);
      const workspace = workspaces.find((item) => samePath(item.repositoryRoot, repoRoot));
      if (!workspace || workspace.dirty || workspace.headCommit !== expected) {
        throw new Error(`Squash ${label} Task requires a clean exact managed worktree`);
      }
    }
    const repoKey = taskRepositoryKey(repoRoot);
    const sourceBase = await this.#runOwned([
      "rev-parse", "--verify", `${this.#custodyBaseRef(sourceId, repoKey)}^{commit}`,
    ], { cwd: repoRoot, lease });
    const survivorBase = await this.#runOwned([
      "rev-parse", "--verify", `${this.#custodyBaseRef(survivorId, repoKey)}^{commit}`,
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
    for (const name of ownerPaths) {
      const witness = {
        path: name,
        baseline: await treeEntry(baseline, name),
        beforeDev: await treeEntry(devBeforeCommit, name),
        newResult: await treeEntry(result, name),
        afterDev: await treeEntry(afterTree, name),
      };
      if (sameTreeEntry(witness.beforeDev, witness.afterDev)
          && !sameTreeEntry(witness.afterDev, witness.newResult)) {
        witness.disposition = LF_NORMALIZATION_ALREADY_PRESENT;
        if (!await this.#isExactLfNormalizationWitness(repoRoot, witness, lease)) {
          delete witness.disposition;
        }
      }
      ownerWitnesses.push(witness);
    }
    const proof = normalizedTaskSquashTransfer({
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
    await this.#verifySquashNormalizationWitnesses(repoRoot, proof, lease);
    return proof;
  }

  async #taskWorktreeSnapshotTree(taskId, repoRoot, lease) {
    const workspace = (await this.describe(taskId))
      .find((item) => samePath(item.repositoryRoot, repoRoot));
    if (!workspace) throw new Error("Squash cutover requires the managed survivor worktree");
    const root = await worktreeRoot(workspace.projectRoot);
    const headCommit = await this.#runOwned(["rev-parse", "HEAD^{commit}"], { cwd: root, lease });
    const indexPath = path.resolve(root, await this.#runOwned(["rev-parse", "--git-path", "index"], {
      cwd: root, lease,
    }));
    const temporaryRoot = path.join(this.dataDir, "task-squash-cutover-indices", randomUUID());
    const temporaryIndex = path.join(temporaryRoot, "index");
    await mkdir(temporaryRoot, { recursive: true });
    try {
      await writeFile(temporaryIndex, await readFile(indexPath), { flag: "wx" });
      const env = { GIT_INDEX_FILE: temporaryIndex };
      await this.#runOwned(["add", "-A", "--", "."], { cwd: root, lease, env });
      const tree = await this.#runOwned(["write-tree"], { cwd: root, lease, env });
      return { workspace, root, headCommit, tree };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #squashCutoverMaterializationPlan(cutover, repoRoot, lease) {
    const addedPaths = String(await this.#runOwned([
      "diff", "--no-renames", "--name-only", "--diff-filter=A", "-z",
      cutover.expectedPreservedTree, cutover.reviewedSourceTree,
    ], { cwd: repoRoot, lease })).split("\0").filter(Boolean).sort();
    const temporaryRoot = path.join(this.dataDir, "task-squash-cutover-indices", randomUUID());
    const temporaryIndex = path.join(temporaryRoot, "index");
    await mkdir(temporaryRoot, { recursive: true });
    try {
      const env = { GIT_INDEX_FILE: temporaryIndex };
      await this.#runOwned(["read-tree", cutover.reviewedSourceTree], { cwd: repoRoot, lease, env });
      if (addedPaths.length) {
        await this.#runOwned(["update-index", "--force-remove", "-z", "--stdin"], {
          cwd: repoRoot, lease, env, input: `${addedPaths.join("\0")}\0`,
        });
      }
      const withoutAddedTree = await this.#runOwned(["write-tree"], { cwd: repoRoot, lease, env });
      const additions = [];
      for (const name of addedPaths) {
        const entry = await this.#treeEntryAt(repoRoot, cutover.reviewedSourceTree, name, lease);
        if (!entry) throw new Error(`Squash cutover target addition changed: ${name}`);
        additions.push({ path: name, mode: entry.mode, object: entry.object });
      }
      return { additions, withoutAddedTree };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #isSquashCutoverPartialTree(tree, plan, cutover, repoRoot, lease) {
    if (tree === plan.withoutAddedTree) return true;
    const changedPaths = String(await this.#runOwned([
      "diff", "--name-only", "-z", plan.withoutAddedTree, tree,
    ], { cwd: repoRoot, lease })).split("\0").filter(Boolean);
    const additions = new Map(plan.additions.map((entry) => [entry.path, entry]));
    if (!changedPaths.length || changedPaths.some((name) => !additions.has(name))) return false;
    for (const name of changedPaths) {
      const actual = await this.#treeEntryAt(repoRoot, tree, name, lease);
      const expected = additions.get(name);
      if (!actual || actual.mode !== expected.mode || actual.object !== expected.object) return false;
    }
    return true;
  }

  async previewSquashCutoverOwned(params = {}) {
    this.#assertAvailable("previewSquashCutoverOwned");
    await requiredGuardLease(params.lease).assertOwned();
    const repoRoot = await repositoryRoot(params.projectRoot);
    return this.#withClearDevLock(repoRoot, params.lease, async (lease) => {
      const sourceRoot = canonicalPath(params.reviewedSourceRoot);
      const result = exactCommitId(params.newResultCommit, "squash survivor result");
      await this.#runOwned(["fetch", "--no-tags", "--no-write-fetch-head", sourceRoot, result], {
        cwd: repoRoot, lease,
      });
      const resultTree = await this.#runOwned(["rev-parse", `${result}^{tree}`], { cwd: repoRoot, lease });
      if (resultTree !== params.cutover?.reviewedSourceTree) {
        throw new Error("Squash cutover reviewed source tree changed");
      }
      return this.#squashTransferPreview({ ...params, projectRoot: repoRoot, lease });
    });
  }

  async readSquashCutoverOwned(cutoverValue, { projectRoot, lease } = {}) {
    this.#assertAvailable("readSquashCutoverOwned");
    const cutover = normalizedTaskSquashCutover(cutoverValue);
    const proof = cutover.squashTransfer;
    const repoRoot = await repositoryRoot(projectRoot);
    return this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      const main = await this.#runOwned(["rev-parse", "refs/heads/main^{commit}"], { cwd: repoRoot, lease: ownedLease });
      if (main !== cutover.expectedMainCommit) return { status: "unknown", cutover, reason: "main changed" };
      const branch = await this.#runOwned([
        "rev-parse", `refs/heads/${proof.survivor.branch}^{commit}`,
      ], { cwd: repoRoot, lease: ownedLease });
      const snapshot = await this.#taskWorktreeSnapshotTree(proof.survivor.taskId, repoRoot, ownedLease);
      if (branch === proof.previousResultCommit && snapshot.headCommit === proof.previousResultCommit
          && snapshot.tree === cutover.expectedPreservedTree) {
        const preservedRef = `refs/agent-hub/task-squash-cutovers/${cutover.cutoverHash}/preserved`;
        const preservedCommit = await gitMaybe(["rev-parse", "--verify", `${preservedRef}^{commit}`], { cwd: repoRoot });
        if (preservedCommit) {
          const plan = await this.#squashCutoverMaterializationPlan(cutover, repoRoot, ownedLease);
          const stagedTree = await this.#runOwned(["write-tree"], { cwd: snapshot.root, lease: ownedLease });
          const unstaged = await this.#runOwned(["diff-files", "--name-only", "-z"], {
            cwd: snapshot.root, lease: ownedLease,
          });
          if (plan.additions.length && plan.withoutAddedTree === cutover.expectedPreservedTree
              && stagedTree === plan.withoutAddedTree && !unstaged) {
            return { status: "materializing_additions", cutover };
          }
          return { status: "pending_survivor_index", cutover };
        }
        return { status: "not_staged", cutover };
      }
      if (branch === proof.previousResultCommit && snapshot.headCommit === proof.previousResultCommit
          && snapshot.tree === cutover.reviewedSourceTree) {
        const stagedTree = await this.#runOwned(["write-tree"], { cwd: snapshot.root, lease: ownedLease });
        const unstaged = await this.#runOwned(["diff-files", "--name-only", "-z"], {
          cwd: snapshot.root, lease: ownedLease,
        });
        if (stagedTree === cutover.reviewedSourceTree && !unstaged) {
          return { status: "staged_before_ref", cutover };
        }
      }
      if (branch === proof.previousResultCommit && snapshot.headCommit === proof.previousResultCommit) {
        const plan = await this.#squashCutoverMaterializationPlan(cutover, repoRoot, ownedLease);
        if (await this.#isSquashCutoverPartialTree(
          snapshot.tree, plan, cutover, repoRoot, ownedLease,
        )) return { status: "materializing_additions", cutover };
      }
      if (branch !== proof.survivor.resultCommit || snapshot.headCommit !== proof.survivor.resultCommit
          || snapshot.tree !== cutover.reviewedSourceTree || snapshot.workspace.dirty) {
        return { status: "unknown", cutover, reason: "survivor staging is partial or changed" };
      }
      const squash = await this.readSquashTransferOwned(proof, { projectRoot: repoRoot, lease: ownedLease });
      return { ...squash, cutover };
    });
  }

  async applySquashCutoverOwned({ cutover: cutoverValue, source, survivor, lease } = {}) {
    this.#assertAvailable("applySquashCutoverOwned");
    await requiredGuardLease(lease).assertOwned();
    const cutover = normalizedTaskSquashCutover(cutoverValue);
    const proof = cutover.squashTransfer;
    const repoRoot = await repositoryRoot(proof.projectRoot);
    return this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
      const preservedRef = `refs/agent-hub/task-squash-cutovers/${cutover.cutoverHash}/preserved`;
      const preservedMessage = `task squash cutover preserved ${cutover.cutoverHash}`;
      const readPreservedCommit = async () => {
        const existing = await gitMaybe(["rev-parse", "--verify", `${preservedRef}^{commit}`], { cwd: repoRoot });
        if (!existing) return null;
        const existingTree = await this.#runOwned(["rev-parse", `${existing}^{tree}`], {
          cwd: repoRoot, lease: ownedLease,
        });
        const existingParent = await this.#runOwned(["rev-parse", `${existing}^`], {
          cwd: repoRoot, lease: ownedLease,
        });
        const existingMessage = await this.#runOwned(["show", "-s", "--format=%B", existing], {
          cwd: repoRoot, lease: ownedLease,
        });
        if (existingTree !== cutover.expectedPreservedTree
            || existingParent !== proof.previousResultCommit
            || existingMessage !== preservedMessage) {
          throw new Error("Squash cutover preserved ref changed");
        }
        return existing;
      };
      let readback = await this.readSquashCutoverOwned(cutover, { projectRoot: repoRoot, lease: ownedLease });
      if (["not_staged", "pending_survivor_index"].includes(readback.status)) {
        const snapshot = await this.#taskWorktreeSnapshotTree(proof.survivor.taskId, repoRoot, ownedLease);
        if (snapshot.headCommit !== proof.previousResultCommit
            || snapshot.tree !== cutover.expectedPreservedTree) {
          throw new Error("Squash cutover survivor changed after preservation readback");
        }
        const ignoredPaths = String(await this.#runOwned([
          "ls-files", "--others", "--ignored", "--exclude-standard", "-z",
        ], { cwd: snapshot.root, lease: ownedLease })).split("\0").filter(Boolean);
        const targetPaths = String(await this.#runOwned([
          "ls-tree", "-r", "--name-only", "-z", proof.survivor.resultCommit,
        ], { cwd: repoRoot, lease: ownedLease })).split("\0").filter(Boolean);
        const ignoreCase = await this.#runOwned(["config", "--bool", "core.ignorecase"], {
          cwd: snapshot.root, lease: ownedLease,
        }).catch(() => "false") === "true";
        const comparablePath = (value) => ignoreCase ? value.toLocaleLowerCase("en-US") : value;
        const ignoredCollision = ignoredPaths.find((ignoredPath) => targetPaths.some((targetPath) => (
          comparablePath(ignoredPath) === comparablePath(targetPath)
          || comparablePath(ignoredPath).startsWith(`${comparablePath(targetPath)}/`)
          || comparablePath(targetPath).startsWith(`${comparablePath(ignoredPath)}/`)
        )));
        if (ignoredCollision) {
          throw new Error(`Squash cutover target collides with ignored bytes: ${ignoredCollision}`);
        }
        let preservedCommit = await readPreservedCommit();
        if (!preservedCommit) {
          preservedCommit = await this.#runOwned([
            "-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
            "commit-tree", cutover.expectedPreservedTree, "-p", proof.previousResultCommit,
          ], { cwd: repoRoot, lease: ownedLease, input: `${preservedMessage}\n` });
          await this.#runOwned([
            "update-ref", preservedRef, preservedCommit, "0000000000000000000000000000000000000000",
          ], { cwd: repoRoot, lease: ownedLease });
        }
        const actualTree = await this.#runOwned(["rev-parse", `${proof.survivor.resultCommit}^{tree}`], { cwd: repoRoot, lease: ownedLease });
        if (actualTree !== cutover.reviewedSourceTree) throw new Error("Squash cutover imported result tree changed");
        const plan = await this.#squashCutoverMaterializationPlan(cutover, repoRoot, ownedLease);
        await this.#runOwned(["read-tree", cutover.expectedPreservedTree], { cwd: snapshot.root, lease: ownedLease });
        await this.#runOwned(["update-index", "--refresh"], { cwd: snapshot.root, lease: ownedLease });
        await this.#runOwned([
          "read-tree", "-m", "-u", cutover.expectedPreservedTree, plan.withoutAddedTree,
        ], { cwd: snapshot.root, lease: ownedLease });
        readback = await this.readSquashCutoverOwned(cutover, { projectRoot: repoRoot, lease: ownedLease });
      }
      if (readback.status === "materializing_additions") {
        if (!await readPreservedCommit()) throw new Error("Squash cutover preserved ref is missing");
        const actualTree = await this.#runOwned(["rev-parse", `${proof.survivor.resultCommit}^{tree}`], {
          cwd: repoRoot, lease: ownedLease,
        });
        if (actualTree !== cutover.reviewedSourceTree) throw new Error("Squash cutover imported result tree changed");
        const plan = await this.#squashCutoverMaterializationPlan(cutover, repoRoot, ownedLease);
        const snapshot = await this.#taskWorktreeSnapshotTree(proof.survivor.taskId, repoRoot, ownedLease);
        const temporaryRoot = path.join(this.dataDir, "task-squash-cutover-materialization", randomUUID());
        const temporaryIndex = path.join(temporaryRoot, "index");
        const sourceRoot = path.join(temporaryRoot, "source");
        await mkdir(sourceRoot, { recursive: true });
        try {
          if (plan.additions.length) {
            const env = { GIT_INDEX_FILE: temporaryIndex };
            await this.#runOwned(["read-tree", cutover.reviewedSourceTree], {
              cwd: repoRoot, lease: ownedLease, env,
            });
            const prefix = `${sourceRoot.replaceAll("\\", "/")}/`;
            await this.#runOwned(["checkout-index", "-z", "--stdin", `--prefix=${prefix}`], {
              cwd: repoRoot,
              lease: ownedLease,
              env,
              input: `${plan.additions.map((entry) => entry.path).join("\0")}\0`,
            });
            for (const entry of plan.additions) {
              await this.#runOwned(["cat-file", "-e", `${cutover.reviewedSourceTree}:${entry.path}`], {
                cwd: snapshot.root, lease: ownedLease,
              });
              await materializePathWithoutOverwrite(sourceRoot, snapshot.root, entry.path);
              await this.#runOwned([
                "update-index", "--add", "--cacheinfo", entry.mode, entry.object, entry.path,
              ], { cwd: snapshot.root, lease: ownedLease });
            }
          }
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
        }
        await this.#runOwned(["update-index", "--refresh"], { cwd: snapshot.root, lease: ownedLease });
        const stagedTree = await this.#runOwned(["write-tree"], { cwd: snapshot.root, lease: ownedLease });
        const unstaged = await this.#runOwned(["diff-files", "--name-only", "-z"], { cwd: snapshot.root, lease: ownedLease });
        if (stagedTree !== cutover.reviewedSourceTree || unstaged) {
          throw new Error(`Squash cutover could not materialize the exact reviewed survivor tree: staged ${stagedTree}, expected ${cutover.reviewedSourceTree}, unstaged ${unstaged || "<none>"}`);
        }
        const materialized = await this.#taskWorktreeSnapshotTree(proof.survivor.taskId, repoRoot, ownedLease);
        if (materialized.headCommit !== proof.previousResultCommit
            || materialized.tree !== cutover.reviewedSourceTree) {
          throw new Error("Squash cutover survivor changed during safe materialization");
        }
        readback = await this.readSquashCutoverOwned(cutover, { projectRoot: repoRoot, lease: ownedLease });
      }
      if (readback.status === "staged_before_ref") {
        const survivorRef = `refs/heads/${proof.survivor.branch}`;
        await this.#runOwned([
          "update-ref", survivorRef,
          proof.survivor.resultCommit, proof.previousResultCommit,
        ], { cwd: repoRoot, lease: ownedLease });
        readback = await this.readSquashCutoverOwned(cutover, { projectRoot: repoRoot, lease: ownedLease });
      }
      if (readback.status === "not_applied") {
        const applied = await this.applySquashTransferOwned({
          source, survivor, projectRoot: repoRoot,
          baselineResultCommit: proof.baselineResultCommit,
          newResultCommit: proof.survivor.resultCommit,
          devAfterTree: proof.devAfterTree,
          authority: proof.authority,
          expectedTransferHash: proof.transferHash,
          lease: ownedLease,
        });
        return { cutover, squashTransfer: applied };
      }
      if (readback.status === "pending_materialization") {
        const applied = await this.materializeSquashTransferOwned(readback.proof, { projectRoot: repoRoot, lease: ownedLease });
        return { cutover, squashTransfer: applied };
      }
      if (readback.status === "applied") return { cutover, squashTransfer: readback.proof };
      throw new Error(`Squash cutover Git outcome is unknown: ${readback.reason ?? readback.status}`);
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
      await this.#verifySquashNormalizationWitnesses(repoRoot, proof, ownedLease);
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
          "read-tree", "-i", "-m", proof.devBeforeCommit, proof.integrationCommit,
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

  async releaseIntegrationEvidence({ projectRoot, tasks = [], lease = null, forwardPreparation = false, synchronizeAcceptedMain = false } = {}) {
    this.#assertAvailable("releaseIntegrationEvidence");
    const dev = forwardPreparation ? await this.inspectForwardPreparationDevOwned(projectRoot, { lease })
      : await this.prepareDev(projectRoot, { lease, synchronizeAcceptedMain });
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
      const authoritative = selectedCompositionFields(task);
      const selectedComposition = authoritative.selectedComposition?.kind === "native-task-integration-v1"
        ? await this.#nativeSelectedCompositionForResult(authoritative.selectedComposition, lease)
        : await this.#selectedCompositionForResult({
        taskId: task.taskId, repositoryRoot: evidence.projectRoot,
        resultCommit: evidence.resultCommit, devHeadCommit: dev.headCommit,
      });
      if (authoritative.selectedCompositionRequired && (!selectedComposition
          || selectedCompositionIdentity({ ...task, selectedComposition })
            !== selectedCompositionIdentity({ ...task, ...authoritative }))) {
        throw selectedCompositionRequiredError("selected Test filesystem proof missing or differs from durable outcome");
      }
      const squashTransfer = task.squashTransfer
        ? normalizedTaskSquashTransfer(task.squashTransfer)
        : null;
      if (squashTransfer && (
        squashTransfer.survivor.taskId !== String(task.taskId)
        || squashTransfer.survivor.releaseRevision + 1 !== Number(task.resultReleaseRevision)
        || !samePath(squashTransfer.projectRoot, evidence.projectRoot)
      )) throw new Error(`Task ${task.taskId} squash transfer does not match its frozen result`);
      const lineage = new Set(String(await runGit([
        "rev-list", "--first-parent", evidence.resultCommit, `^${evidence.baseCommit}`,
      ], { cwd: dev.projectRoot })).split(/\r?\n/u).filter(Boolean));
      if (squashTransfer && !lineage.has(squashTransfer.survivor.resultCommit)) {
        throw new Error(`Task ${task.taskId} squash transfer does not match its frozen result lineage`);
      }
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
        ...selectedCompositionFields({ taskId: String(task.taskId), resultCommit: evidence.resultCommit,
          ...(selectedComposition ? { selectedComposition } : authoritative) }),
        integrations,
        lineage,
        ...(squashTransfer ? {
          resultReleaseRevision: Number(task.resultReleaseRevision),
          squashTransfer,
        } : {}),
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
    const integrationParents = new Map(firstParentHistory.map((entry) => [entry.commit, entry.parents]));
    const integrationOwners = new Map();
    const sharedHistory = [];
    for (const [integrationCommit, claims] of integrationClaims) {
      if (claims.length === 1) {
        integrationOwners.set(integrationCommit, claims[0].taskId);
        continue;
      }
      const nestedOwners = claims.filter((candidate) => claims.every((claimant) => (
        claimant.taskId === candidate.taskId || claimant.lineage.has(candidate.resultCommit)
      )));
      if (nestedOwners.length !== 1) {
        sharedHistory.push([integrationCommit, claims]);
        continue;
      }
      integrationOwners.set(integrationCommit, nestedOwners[0].taskId);
    }
    const ownsCurrentResult = (task) => task.integrations.some((integration) => (
      integrationOwners.get(integration.commit) === task.taskId
      && integrationParents.get(integration.commit).slice(1).includes(task.resultCommit)
    ));
    for (const [integrationCommit, claims] of sharedHistory) {
      // A common historical prefix is not another integration of each current
      // Task. Leave it unassigned only after every claimant independently proves
      // its own exact current result in an unambiguous dev integration. Ancestry,
      // equal trees and foreign wrapper integrations cannot supply that proof.
      if (!claims.every(ownsCurrentResult)) {
        throw new Error(`dev integration ${integrationCommit} is ambiguously owned by Tasks ${claims
          .map((claim) => claim.taskId).join(" and ")}`);
      }
    }
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
    const baseRef = this.#custodyBaseRef(id, repoKey);
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
              "rev-parse", "--verify", `${this.#custodyBaseRef(task.taskId, taskRepositoryKey(repoRoot))}^{commit}`,
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
    const custody = this.#claimNamespace(id);
    if (custody) {
      const root = custody.namespace.root;
      const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
      const entries = status.split(/\r?\n/u).filter(Boolean);
      return [{ ...custody.namespace.workspace, repositoryKey: custody.namespace.repositoryKey,
        projectRoot: root, headCommit: await runGit(["rev-parse", "HEAD^{commit}"], { cwd: root }),
        dirty: entries.length > 0, changedPaths: entries.map(line => line.slice(3)),
        untrackedPaths: entries.filter(line => line.startsWith("?? ")).map(line => line.slice(3)) }];
    }
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
        `${this.#custodyBaseRef(taskId, taskRepositoryKey(root))}^{commit}`], { cwd: workspace.projectRoot });
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

  async withAbsorptionEvidenceOwned({ source, target, lease, nativeAbsorption = null } = {}, operation) {
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
        let priorNativeSource = null;
        if (nativeAbsorption) {
          const proof = selectedCompositionFields({ taskId: target.id, resultCommit: targetHead,
            selectedComposition: nativeAbsorption }).selectedComposition;
          if (proof.kind !== "native-task-integration-v1" || proof.taskId !== target.id
              || proof.taskCommit !== targetHead || !samePath(proof.repositoryRoot, repoRoot)) {
            throw selectedCompositionRequiredError("combined native absorption result changed");
          }
          await this.#nativeSelectedCompositionForResult(proof, devLease);
          const input = normalizedSelectedAbsorption(proof.absorptionInput);
          const d = selectedAbsorptionHandoff({ requestId: input.requestId, text: input.text }).declaration;
          if (d.sourceTaskId !== source.id || d.sourceTaskRevision !== source.revision || d.sourceCommit !== sourceHead) {
            throw selectedCompositionRequiredError("combined native absorbed source changed");
          }
          const prior = input.priorResults?.find(result => result.taskId === source.id);
          const sourceRefs = (source.gitReferences ?? []).filter(ref => samePath(ref.projectRoot, repoRoot));
          if (sourceRefs.length ? sourceRefs.length !== 1 || !prior || sourceRefs[0].resultCommit !== prior.resultCommit
            : Boolean(prior)) throw selectedCompositionRequiredError("combined native prior source result changed");
          priorNativeSource = prior ? { ...prior, devCommit: proof.devCommit } : null;
        }
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
        const sourceBase = await runGit(["rev-parse", `${this.#custodyBaseRef(source.id, workspace.repositoryKey)}^{commit}`], { cwd: repoRoot });
        const targetBase = await runGit(["rev-parse", `${this.#custodyBaseRef(target.id, workspace.repositoryKey)}^{commit}`], { cwd: repoRoot });
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
            for (const parent of parents.filter(parent => lineage.has(parent) && !targetLineage.has(parent))) {
              if (!priorNativeSource
                  || await gitMaybe(["merge-base", "--is-ancestor", parent, priorNativeSource.resultCommit], { cwd: repoRoot }) === null
                  || await gitMaybe(["merge-base", "--is-ancestor", commit, priorNativeSource.devCommit], { cwd: repoRoot }) === null) {
                throw new Error(`Source Task still has a separate dev integration ${commit}; return it before integrating the combined Task`);
              }
            }
          }
        }
        evidence.push({
          projectRoot: repoRoot, sourceHead, targetHead, results,
          ...(squashTransfer ? { squashTransferHash: squashTransfer.transferHash } : {}),
          ...(nativeAbsorption ? { nativeAbsorptionHash: nativeAbsorption.descriptorHash } : {}),
        });
        return visit(index + 1, devLease);
      });
    };
    workspaces.sort((a, b) => a.repositoryRoot.localeCompare(b.repositoryRoot));
    return visit(0, lease);
  }

  async publishedReleaseServiceEvidenceOwned({ source, selectedTasks, lease } = {}) {
    this.#assertAvailable("publishedReleaseServiceEvidenceOwned");
    await requiredGuardLease(lease).assertOwned();
    if ((source.gitReferences ?? []).length || (source.gitAdoptions ?? []).length
        || source.squashTransfer || source.squashAbsorbedBy) {
      throw new Error("Release service Task must not claim an implementation result");
    }
    const workspaces = await this.describe(source.id);
    if (workspaces.length !== 1 || workspaces[0].dirty) {
      throw new Error("Release service Task requires one clean managed worktree to preserve");
    }
    const repositoryRoot = workspaces[0].repositoryRoot;
    const completed = readPublishedReleaseServiceGeneration({ dataDir: this.dataDir,
      workspaceId: source.workspaceId, repositoryRoot,
      selectedTasks: (selectedTasks ?? []).map(task => ({ id: task.id,
        resultCommit: (task.gitReferences ?? []).find(ref => samePath(ref.projectRoot, repositoryRoot))?.resultCommit })) });
    const publication = completed ? null : await this.readPublication();
    const published = completed ? { root: completed.candidate.repositoryRoot,
      revision: completed.candidate.commit, manifestHash: completed.candidate.manifestHash,
      planRevision: completed.candidate.planRevision } :
      publicationStateRepositories(publication ?? {}).find((item) => samePath(item.root, repositoryRoot));
    const generation = completed ? `${completed.operationId}:${completed.generation}` : String(publication?.generation ?? "").trim();
    const publishedRevision = exactCommitId(published?.revision, "published repository revision");
    const manifestHash = String(published?.manifestHash ?? "").trim();
    if (!generation || !/^[a-f0-9]{64}$/u.test(manifestHash) || !published?.planRevision) {
      throw new Error("Release service Task requires exact durable publication and manifest evidence");
    }
    const repositoryKeys = [...new Set([
      taskRepositoryKey(repositoryRoot),
      taskRepositoryKey(published.root),
      taskRepositoryKey(workspaces[0].projectRoot),
    ])];
    const manifestCopies = [];
    const manifestFiles = [];
    for (const repositoryKey of repositoryKeys) {
      manifestFiles.push(path.join(this.dataDir, "release-repositories", repositoryKey,
        "evidence", `${manifestHash}.json`));
    }
    if (completed) {
      const identityHash = createHash("sha256").update(
        `${completed.operationId}:${completed.generation}:${completed.candidate.repositoryRoot}`).digest("hex");
      const key = identityHash.slice(0, 24);
      const generationRoot = path.join(this.dataDir, "release-gens", key);
      if (!completed.candidate.generationRoot || !samePath(completed.candidate.generationRoot, generationRoot)) {
        throw new Error("Published release generation root changed");
      }
      for (const [root, evidence] of [
        [generationRoot, path.join("release-repositories", taskRepositoryKey(completed.candidate.repositoryRoot), "evidence")],
        [path.join(this.dataDir, "release-generation-evidence", key), "evidence"],
      ]) {
        const identityBytes = await readFile(path.join(root, "identity.json")).catch(error => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (!identityBytes) continue;
        const identity = JSON.parse(identityBytes.toString("utf8"));
        if (identity.operationId !== completed.operationId || identity.generation !== completed.generation
            || !samePath(identity.repositoryRoot, completed.candidate.repositoryRoot)
            || identity.identitySha256 !== identityHash) throw new Error("Published release archive identity changed");
        manifestFiles.push(path.join(root, evidence, `${manifestHash}.json`));
      }
    }
    for (const manifestFile of [...new Set(manifestFiles)]) {
      const bytes = await readFile(manifestFile).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (bytes) manifestCopies.push(bytes);
    }
    if (!manifestCopies.length) throw new Error("Published release manifest evidence is unavailable");
    if (manifestCopies.some((bytes) => !bytes.equals(manifestCopies[0]))) {
      throw new Error("Published release repository path aliases have conflicting manifest evidence");
    }
    const manifestBytes = manifestCopies[0];
    if (createHash("sha256").update(manifestBytes).digest("hex") !== manifestHash) {
      throw new Error("Published release manifest bytes changed");
    }
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.workspaceId !== source.workspaceId || manifest.planRevision !== published.planRevision
        || !Array.isArray(manifest.tasks)) {
      throw new Error("Published release manifest does not bind the service Task Workspace and plan");
    }
    const selected = [...(selectedTasks ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    const manifestTasks = [...manifest.tasks].sort((left, right) => String(left.taskId).localeCompare(String(right.taskId)));
    if (!selected.length || selected.length !== manifestTasks.length
        || selected.some((task, index) => task.id !== manifestTasks[index].taskId
          || task.status !== "done" || task.workflowStatus !== "done"
          || (task.gitReferences ?? []).filter((ref) => samePath(ref.projectRoot, repositoryRoot)
            && ref.resultCommit === manifestTasks[index].resultCommit).length !== 1)) {
      throw new Error("Release service checklist does not match exact published Done results");
    }
    const localMain = await localMainCommit(repositoryRoot);
    const remoteMain = await gitMaybe(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], { cwd: repositoryRoot });
    if (await gitMaybe(["merge-base", "--is-ancestor", publishedRevision, localMain], { cwd: repositoryRoot }) === null
        || !remoteMain || await gitMaybe(["merge-base", "--is-ancestor", publishedRevision, remoteMain],
          { cwd: repositoryRoot }) === null) {
      throw new Error("Durable published revision is not contained in local and tracked main");
    }
    await lease.assertOwned();
    return {
      version: 1, mode: "published_release_service",
      source: { taskId: source.id, taskRevision: source.revision },
      publicationGeneration: generation, publishedRevision,
      ...(completed ? { releaseOperation: { operationId: completed.operationId,
        generation: completed.generation, identitySha256: completed.identitySha256 } } : {}),
      planRevision: published.planRevision, manifestHash,
      selectedResults: selected.map((task, index) => ({ taskId: task.id, revision: task.revision,
        resultCommit: manifestTasks[index].resultCommit })),
      cleanupPlan: { strategy: "preserve_managed_source", deleting: [] },
      preserving: [{ kind: "managed_source", projectRoot: repositoryRoot,
        branch: workspaces[0].branch, headCommit: workspaces[0].headCommit }],
    };
  }

  async withPublishedDuplicateEvidenceOwned({ source, target, lease } = {}, operation) {
    this.#assertAvailable("withPublishedDuplicateEvidenceOwned");
    await requiredGuardLease(lease).assertOwned();
    if ((source.gitReferences ?? []).length || (source.gitAdoptions ?? []).length
        || source.squashTransfer || source.squashAbsorbedBy) {
      throw new Error("Published duplicate closure requires a source without independent Git result evidence");
    }
    const workspaces = await this.describe(source.id);
    if (!workspaces.length) throw new Error("Published duplicate closure requires the source Task worktree");
    if (workspaces.some((workspace) => workspace.dirty)) {
      throw new Error("Published duplicate closure requires a clean source Task worktree");
    }
    if ((target.gitReferences ?? []).length !== workspaces.length) {
      throw new Error("Published survivor requires one exact result per source repository");
    }
    const publication = await this.readPublication();
    const generation = String(publication?.generation ?? "").trim();
    if (!generation) throw new Error("Published duplicate closure requires durable publication evidence");
    const publishedRepositories = publicationStateRepositories(publication);
    const repositories = [];
    const visit = async (index, ownedLease) => {
      if (index === workspaces.length) {
        return operation({
          version: 1,
          mode: "published_duplicate",
          source: { taskId: source.id, taskRevision: source.revision },
          survivor: { taskId: target.id, taskRevision: target.revision },
          publicationGeneration: generation,
          cleanupPlan: { strategy: "preserve_managed_source", deleting: [] },
          repositories,
        }, ownedLease);
      }
      const workspace = workspaces[index];
      const repoRoot = workspace.repositoryRoot;
      return this.#withDevLock(repoRoot, ownedLease, async (devLease) => {
        await this.#assertNoProcessTreeGuard(source.id);
        await this.#assertNoProcessTreeGuard(target.id);
        await this.#assertRepositoryProcessTreeClear(repoRoot);
        if (await access(this.#withdrawalFile(repoRoot)).then(() => true, () => false)) {
          throw new Error("Repository has a pending Task withdrawal");
        }
        if (!await this.managedRepositoryRoot(workspace.projectRoot, {
          taskId: source.id, taskNumber: source.taskNumber,
        })) throw new Error("Source Task worktree ownership changed");
        const current = (await this.describe(source.id)).find((item) => (
          samePath(item.repositoryRoot, repoRoot)
        ));
        if (!current || current.dirty || current.headCommit !== workspace.headCommit) {
          throw new Error("Source Task changed during published duplicate validation");
        }
        const published = publishedRepositories.find((item) => samePath(item.root, repoRoot));
        const publishedRevision = exactCommitId(published?.revision, "published repository revision");
        const localMain = await localMainCommit(repoRoot);
        const remoteMain = await gitMaybe([
          "rev-parse", "--verify", "refs/remotes/origin/main^{commit}",
        ], { cwd: repoRoot });
        if (publishedRevision !== localMain || publishedRevision !== remoteMain
            || publishedRevision !== current.headCommit) {
          throw new Error("Source Task HEAD must equal exact durable local and origin published main");
        }
        const references = (target.gitReferences ?? []).filter((reference) => (
          samePath(reference.projectRoot, repoRoot)
        ));
        if (references.length !== 1) {
          throw new Error("Published survivor requires one exact result per source repository");
        }
        const survivorResult = exactCommitId(references[0].resultCommit, "published survivor result");
        if (await gitMaybe(["rev-parse", "--verify", `${survivorResult}^{commit}`], { cwd: repoRoot }) !== survivorResult
            || await gitMaybe(["merge-base", "--is-ancestor", survivorResult, publishedRevision], { cwd: repoRoot }) === null) {
          throw new Error("Surviving Task exact result is not contained in published main");
        }
        const baseCommit = await runGit([
          "rev-parse", `${this.#custodyBaseRef(source.id, workspace.repositoryKey)}^{commit}`,
        ], { cwd: repoRoot });
        repositories.push({
          projectRoot: repoRoot,
          sourceBranch: current.branch,
          sourceBaseCommit: baseCommit,
          sourceHead: current.headCommit,
          survivorBranch: String(references[0].branch ?? ""),
          survivorResult,
          publishedRevision,
        });
        return visit(index + 1, devLease);
      });
    };
    workspaces.sort((left, right) => left.repositoryRoot.localeCompare(right.repositoryRoot));
    return visit(0, lease);
  }

  async #operationalCleanupProof({ taskId, source, input }) {
    if (source.headCommit !== source.immutableBaseCommit) throw Error("Operational cleanup requires zero own source commits");
    const publication = input?.publication;
    const revision = exactCommitId(publication?.revision, "operational published revision");
    if (!publication.generation) throw Error("Operational cleanup requires durable publication evidence");
    await runGit(["merge-base", "--is-ancestor", source.headCommit, revision], { cwd: source.repositoryRoot });
    await runGit(["merge-base", "--is-ancestor", revision, "refs/remotes/origin/main"], { cwd: source.repositoryRoot });
    return { version: 1, kind: "operational-zero-own-cleanup-v1", taskId, source: { ...source }, input,
      publication: { ...publication } };
  }

  async publishedDeliveryPreviewOwned(params = {}) {
    this.#assertAvailable("publishedDeliveryPreviewOwned");
    const { task, input: originalInput, lease, admitted = null, operational = false, operationalAuthority = null } = params;
    let input = originalInput;
    await requiredGuardLease(lease).assertOwned();
    const workspaces = await this.describe(task.id);
    if (workspaces.length > 1 || (!admitted && workspaces.length !== 1)) throw Error("Direct delivery requires one exact managed source");
    const source = admitted?.source ?? workspaces[0];
    if (operational && ((task.gitReferences ?? []).length || (task.gitAdoptions ?? []).length
        || task.squashTransfer || task.squashAbsorbedBy)) throw Error("Operational cleanup cannot discard implementation evidence");
    const baseRef = this.#custodyBaseRef(task.id, source.repositoryKey);
    const base = await gitMaybe(["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: source.repositoryRoot });
    if (!admitted && !base || base && admitted && base !== admitted.source.immutableBaseCommit) throw Error("Immutable Task cleanup baseline changed");
    const pinned = { ...source, immutableBaseCommit: admitted?.source.immutableBaseCommit ?? base };
    if (operational) {
      if (admitted && admitted.kind !== "operational-zero-own-cleanup-v1") throw Error("Operational cleanup admission mode changed");
      const publication = admitted ? null : await this.readPublication();
      const entry = operationalAuthority?.publication
        ?? (publication && publicationStateRepositories(publication).find(r => samePath(r.root, source.repositoryRoot)));
      if (operationalAuthority && (!samePath(entry.root, source.repositoryRoot) || source.headCommit !== operationalAuthority.requiredHead)) {
        throw Error("Historical closed source differs from its canonical completion");
      }
      const currentInput = operationalAuthority ? { publication: { revision: entry.revision, generation: entry.generation },
        completedOperation: operationalAuthority.completedOperation } : null;
      if (admitted?.input.completedOperation && JSON.stringify(admitted.input) !== JSON.stringify(currentInput)) throw Error("Historical closure outcome changed");
      input = currentInput ?? admitted?.input ?? { publication: { revision: entry?.revision, generation: publication?.generation } };
    } else if (admitted && admitted.kind !== "direct-published-task-cleanup-v1") throw Error("Direct cleanup admission mode changed");
    const proof = operational ? await this.#operationalCleanupProof({ taskId: task.id, source: pinned, input })
      : await readDirectTaskPublication({ taskId: task.id, source: pinned, input,
        git: (args, options = {}) => runGit(args, { cwd: source.repositoryRoot, ...options }) });
    if (admitted && JSON.stringify(proof) !== JSON.stringify(admitted)) throw Error("Admitted direct publication evidence changed");
    this.#publishedDeliveryProofs.set(proof, { taskId: task.id, source: pinned, input, operational, allowMissing: Boolean(admitted) });
    await requiredGuardLease(lease).assertOwned();
    return this.cleanupPreview(task.id, { gitReferences: task.gitReferences, publishedDelivery: proof });
  }

  async #checkedPublishedDelivery(taskId, proof, workspaces, gitReferences) {
    const state = this.#publishedDeliveryProofs.get(proof);
    if (!state || state.taskId !== taskId) throw Error("Direct cleanup requires the live publication owner proof");
    const source = state.source;
    if (workspaces.length > 1 || !state.allowMissing && workspaces.length !== 1
        || workspaces.some(w => w.dirty || !samePath(w.projectRoot, source.projectRoot)
          || !samePath(w.repositoryRoot, source.repositoryRoot) || w.branch !== source.branch || w.headCommit !== source.headCommit)
        || gitReferences.some(r => !samePath(r.projectRoot, source.repositoryRoot)
          || r.branch !== source.branch || r.resultCommit !== source.headCommit)) throw Error("Direct published source changed or has later work");
    const branchHead = await gitMaybe(["rev-parse", "--verify", `refs/heads/${source.branch}^{commit}`], { cwd: source.repositoryRoot });
    if (branchHead && branchHead !== source.headCommit || !branchHead && !state.allowMissing) throw Error("Direct published branch changed");
    const base = await gitMaybe(["rev-parse", "--verify", `${this.#custodyBaseRef(taskId, source.repositoryKey)}^{commit}`], { cwd: source.repositoryRoot });
    if (base && base !== source.immutableBaseCommit || !base && !state.allowMissing) throw Error("Direct published Task baseline changed");
    const current = state.operational ? await this.#operationalCleanupProof({ taskId, source, input: state.input })
      : await readDirectTaskPublication({ taskId, source, input: state.input,
        git: (args, options = {}) => runGit(args, { cwd: source.repositoryRoot, ...options }) });
    if (JSON.stringify(current) !== JSON.stringify(proof)) throw Error("Direct publication proof changed");
    return state;
  }

  async cleanupPreview(taskId, { gitReferences = [], squashAbsorbedBy = null, publishedDelivery = null } = {}) {
    this.#assertAvailable("cleanupPreview");
    const id = normalizedTaskId(taskId);
    if (this.#claimNamespace(id)) {
      throw new Error("Task cleanup blocked: independent custody history/WIP requires its artifact owner's verified retirement");
    }
    const workspaces = await this.describe(id);
    const delivery = publishedDelivery ? await this.#checkedPublishedDelivery(id, publishedDelivery, workspaces, gitReferences) : null;
    // This is an artifact cleanup pin, never a fabricated Task/Test reference.
    const cleanupReferences = delivery && !gitReferences.length ? [{ projectRoot: delivery.source.repositoryRoot,
      branch: delivery.source.branch, resultCommit: delivery.source.headCommit, artifactOnly: true }] : [];
    // A clean Git status excludes ignored data. Native worktree remove can
    // discard that data even without --force, so it is a separate cleanup pin.
    for (const workspace of workspaces) {
      workspace.ignoredPaths = String(await runGit([
        "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z",
      ], { cwd: workspace.projectRoot })).split("\0").filter(Boolean);
    }
    const references = [];
    const publication = await this.readPublication();
    let squashTransfer = null;
    try {
      const candidate = squashAbsorbedBy
        ? normalizedTaskSquashTransfer(squashAbsorbedBy)
        : null;
      if (candidate?.source.taskId === id) squashTransfer = candidate;
    } catch { squashTransfer = null; }
    for (const reference of [...gitReferences, ...cleanupReferences]) {
      const repoRoot = canonicalPath(reference.projectRoot);
      const resultCommit = String(reference.resultCommit ?? "").trim();
      let published = false;
      const remoteRevision = await gitMaybe([
        "rev-parse", "--verify", "refs/remotes/origin/main^{commit}",
      ], { cwd: repoRoot });
      const durableRevision = String(publication?.revision ?? "").trim();
      const durableGeneration = String(publication?.generation ?? "").trim();
      const publishedRevision = delivery ? publishedDelivery.publication.revision
        : durableGeneration && durableRevision === remoteRevision ? remoteRevision : null;
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
      if (delivery && resultCommit === delivery.source.headCommit) published = true;
      const branch = String(reference.branch ?? "").trim();
      const branchHeadCommit = branch ? await gitMaybe([
        "rev-parse", "--verify", `refs/heads/${branch}^{commit}`,
      ], { cwd: repoRoot }) : null;
      const branchPublished = !branchHeadCommit
        || Boolean(delivery && branchHeadCommit === delivery.source.headCommit)
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
        publicationGeneration: delivery ? publishedDelivery.publication.generation : publishedRevision ? durableGeneration : null,
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
      if (!reference?.publishedRevision || (!delivery && !transferredWorktree && await gitMaybe([
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
        { kind: "base_ref", name: this.#custodyBaseRef(id, workspace.repositoryKey), repositoryRoot: workspace.repositoryRoot },
        { kind: "result_ref", name: this.#custodyResultRef(id, workspace.repositoryKey), repositoryRoot: workspace.repositoryRoot },
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
        { kind: "base_ref", name: this.#custodyBaseRef(id, repoKey), repositoryRoot: reference.projectRoot },
        { kind: "result_ref", name: this.#custodyResultRef(id, repoKey), repositoryRoot: reference.projectRoot },
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
      gitReferences: references.filter(r => !r.artifactOnly),
      ...(delivery ? { publishedCleanupReferences: references.filter(r => r.artifactOnly), publishedDelivery } : {}),
      dirty: workspaces.some((item) => item.dirty),
      retainedIgnored: workspaces.filter(item => item.ignoredPaths.length)
        .map(item => ({ projectRoot: item.projectRoot, paths: item.ignoredPaths })),
      unpublished: [...references.filter((item) => !item.published || !item.branchPublished), ...unpublishedWorktrees],
      deleting: uniqueDeleting,
      ...(squashTransfer ? { squashTransfer } : {}),
    };
  }

  async confirmedDeleteResumePreviewOwned(params = {}) {
    this.#assertAvailable("confirmedDeleteResumePreviewOwned");
    const { task, prior, preservedFiles, lease } = params;
    await requiredGuardLease(lease).assertOwned();
    const cleanupReferences = [...task.gitReferences];
    for (const w of prior.workspaces) if (!cleanupReferences.some(r => samePath(r.projectRoot, w.repositoryRoot) && r.branch === w.branch)) {
      cleanupReferences.push({ projectRoot: w.repositoryRoot, branch: w.branch, resultCommit: w.headCommit, cleanupOnly: true });
    }
    const cleanup = await this.cleanupPreview(task.id, { gitReferences: cleanupReferences, squashAbsorbedBy: task.squashAbsorbedBy });
    const withoutIgnored = value => { const { ignoredPaths, ...rest } = value; return rest; };
    const refPin = r => JSON.stringify([r.projectRoot, r.branch, r.resultCommit]);
    if (cleanup.retainedIgnored.length || cleanup.workspaces.some(w => !prior.workspaces.some(p =>
      JSON.stringify(withoutIgnored(w)) === JSON.stringify(withoutIgnored(p))))
        || cleanup.deleting.some(d => !prior.deleting.some(p => JSON.stringify(d) === JSON.stringify(p)))
        || cleanup.gitReferences.some(r => ![...prior.gitReferences, ...prior.workspaces.map(w => ({
          projectRoot: w.repositoryRoot, branch: w.branch, resultCommit: w.headCommit, branchHeadCommit: w.headCommit,
        }))].some(p => refPin(p) === refPin(r)
          && (!r.branchHeadCommit || r.branchHeadCommit === p.branchHeadCommit)))) throw Error("Original Delete source or remaining artifacts changed");
    await verifyCleanupPreservation({ allowedWorkspaces: prior.workspaces, workspaces: cleanup.workspaces, files: preservedFiles,
      git: (cwd, args, options = {}) => runGit(args, { cwd, ...options }) });
    await requiredGuardLease(lease).assertOwned();
    return cleanup;
  }

  async cleanup(taskId, options = {}) {
    this.#assertAvailable("cleanup");
    return this.withTaskLock(taskId, (lease) => this.cleanupOwned(taskId, { ...options, lease }));
  }

  async cleanupOwned(taskId, {
    allowDirty = false, requirePublished = false, gitReferences = [], squashAbsorbedBy = null,
    expectedPreview = null, lease = null, publishedDelivery = null, preservation = null,
  } = {}) {
    this.#assertAvailable("cleanupOwned");
    await requiredGuardLease(lease).assertOwned();
    const id = normalizedTaskId(taskId);
    await this.#assertNoProcessTreeGuard(id);
    const root = path.join(this.taskWorktreesRoot, id);
    if (!pathInside(this.taskWorktreesRoot, root)) throw new Error("Task worktree cleanup escaped its managed root");
    if (publishedDelivery) {
      const state = this.#publishedDeliveryProofs.get(publishedDelivery);
      if (!state || state.taskId !== id) throw Error("Missing direct cleanup owner");
      state.allowMissing = true; // Caller has durably admitted this exact cleanup.
    }
    const preview = await this.cleanupPreview(id, { gitReferences, squashAbsorbedBy, publishedDelivery });
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
    if (preview.retainedIgnored.length) throw new Error("Task cleanup blocked: ignored local data requires its artifact owner's verified retirement");
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
      const current = await this.cleanupPreview(id, { gitReferences, squashAbsorbedBy, publishedDelivery });
      if (JSON.stringify(repositoryEvidence(current, repoRoot)) !== JSON.stringify(repositoryEvidence(preview, repoRoot))) {
        throw new Error("Task cleanup blocked: branch or worktree changed after confirmation");
      }
      if (preservation) await verifyCleanupPreservation({ allowedWorkspaces: preservation.workspaces,
        workspaces: current.workspaces, files: preservation.files, git: (cwd, args, options = {}) => runGit(args, { cwd, ...options }) });
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
        await this.#runOwned(["update-ref", "-d", this.#custodyBaseRef(id, workspace.repositoryKey)], {
          cwd: repoRoot, lease: ownedLease,
        });
        await this.#runOwned(["update-ref", "-d", this.#custodyResultRef(id, workspace.repositoryKey)], {
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
    for (const reference of [...gitReferences, ...(preview.publishedCleanupReferences ?? [])]) {
      const repoRoot = canonicalPath(reference.projectRoot);
      const repoKey = taskRepositoryKey(repoRoot);
      if (cleanedRepositories.has(repoKey)) continue;
      await lease.assertOwned();
      const branch = String(reference.branch ?? "").trim();
      await this.#withClearDevLock(repoRoot, lease, async (ownedLease) => {
        await assertCurrentRepository(repoRoot);
        if (branch && await branchExists(repoRoot, branch)) {
          if (await worktreeForBranch(repoRoot, branch)) throw new Error("Task cleanup blocked: branch is still checked out");
          const expectedHead = [...preview.gitReferences, ...(preview.publishedCleanupReferences ?? [])].find((item) => samePath(item.projectRoot, repoRoot) && item.branch === branch)?.branchHeadCommit;
          if (!expectedHead) throw new Error("Task cleanup blocked: branch appeared after confirmation");
          await this.#runOwned(["update-ref", "-d", `refs/heads/${branch}`, expectedHead], { cwd: repoRoot, lease: ownedLease });
        }
        await this.#runOwned(["update-ref", "-d", this.#custodyBaseRef(id, repoKey)], {
          cwd: repoRoot, lease: ownedLease,
        });
        await this.#runOwned(["update-ref", "-d", this.#custodyResultRef(id, repoKey)], {
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
