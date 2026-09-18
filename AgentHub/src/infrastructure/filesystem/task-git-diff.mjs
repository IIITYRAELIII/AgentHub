import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { canonicalPath } from "./config.mjs";

const DEFAULT_MAX_DIFF_BYTES = 64 * 1024;

function decodedGitPathToken(value) {
  const token = String(value ?? "").trim();
  if (!token.startsWith('"')) return token;
  try {
    return JSON.parse(token);
  } catch {
    return token;
  }
}

function encodedGitPathToken(value) {
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}

function prefixGitDiffMarkerPaths(diff, prefix) {
  return String(diff).replace(/^(---|\+\+\+) (.+)$/gm, (_line, marker, rawPath) => {
    const gitPath = decodedGitPathToken(rawPath);
    if (gitPath === "/dev/null" || !/^[ab]\//u.test(gitPath)) return `${marker} ${rawPath}`;
    return `${marker} ${encodedGitPathToken(`${gitPath.slice(0, 2)}${prefix}/${gitPath.slice(2)}`)}`;
  });
}

function runGit(args, { cwd, env = {}, timeoutMs = 20_000, maxOutputBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let settled = false;
    const append = (current, chunk, decoder, isStdout) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (isStdout) {
        const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
        stdoutBytes += buffer.length;
        if (buffer.length > remaining) stdoutTruncated = true;
        return current + decoder.write(buffer.subarray(0, remaining));
      }
      return current + decoder.write(buffer);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ ...result, stdout, stderr, stdoutTruncated });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, error: new Error(`git timed out after ${timeoutMs} ms`) });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, stdoutDecoder, true); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, stderrDecoder, false); });
    child.on("error", (error) => finish({ code: null, error }));
    child.on("close", (code) => finish({ code }));
  });
}

async function gitText(args, options) {
  const result = await runGit(args, options);
  if (result.error || result.code !== 0) {
    throw result.error ?? new Error(result.stderr.trim() || `git ${args[0]} exited with ${result.code}`);
  }
  return result.stdout.trim();
}

async function worktreeTree(repoRoot, dataDir, token = randomUUID()) {
  const indexDir = path.join(dataDir, "task-diff-indexes");
  const indexPath = path.join(indexDir, `${token}.index`);
  await mkdir(indexDir, { recursive: true });
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const gitIndex = await gitText(["rev-parse", "--git-path", "index"], { cwd: repoRoot });
    const sourceIndex = path.isAbsolute(gitIndex) ? gitIndex : path.resolve(repoRoot, gitIndex);
    try {
      await copyFile(sourceIndex, indexPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await gitText(["read-tree", "--empty"], { cwd: repoRoot, env });
    }
    const relativeIndexDir = path.relative(repoRoot, indexDir);
    const indexInsideRepo = relativeIndexDir
      && relativeIndexDir !== ".."
      && !relativeIndexDir.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeIndexDir);
    const addArgs = ["add", "-A", "--", "."];
    if (indexInsideRepo) {
      addArgs.push(`:(exclude)${relativeIndexDir.split(path.sep).join("/")}/**`);
    }
    await gitText(addArgs, { cwd: repoRoot, env, timeoutMs: 60_000 });
    return await gitText(["write-tree"], { cwd: repoRoot, env });
  } finally {
    await Promise.all([
      rm(indexPath, { force: true }),
      rm(`${indexPath}.lock`, { force: true }),
    ].map((operation) => operation.catch(() => {})));
  }
}

async function captureRepositoryBaseline(repoRoot, dataDir, token) {
  try {
    const tree = await worktreeTree(repoRoot, dataDir, `${token}-before`);
    const indexTree = await gitText(["write-tree"], { cwd: repoRoot }).catch(() => null);
    return { repoRoot: canonicalPath(repoRoot), tree, indexTree, capturedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

function changedFilesFromNameStatus(value, repoRoot) {
  return String(value ?? "").split(/\r?\n/u).flatMap((line) => {
    const fields = line.split("\t");
    const status = String(fields[0] ?? "").trim().toUpperCase();
    const operation = status.startsWith("A") ? "added"
      : status.startsWith("D") ? "deleted"
        : "modified";
    if (status.startsWith("R") && fields[1] && fields[2]) {
      return [
        { projectRoot: repoRoot, path: fields[1], operation: "deleted" },
        { projectRoot: repoRoot, path: fields[2], operation: "added" },
      ];
    }
    if (!status || !fields[1]) return [];
    return [{ projectRoot: repoRoot, path: fields.at(-1), operation }];
  });
}

function normalizedRepositoryKey(value) {
  const resolved = canonicalPath(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function scopedRepositoryFiles(repositories, ownedFiles) {
  const byRoot = new Map(repositories.map((repository) => [
    normalizedRepositoryKey(repository.repoRoot),
    { repository, files: new Set() },
  ]));
  for (const file of ownedFiles) {
    const entry = byRoot.get(normalizedRepositoryKey(file?.projectRoot));
    if (!entry) throw new Error("Task file does not belong to its captured Git baseline");
    const repoRoot = path.resolve(entry.repository.repoRoot);
    const candidate = String(file?.path ?? "").replaceAll("\\", "/");
    const absolute = path.resolve(repoRoot, candidate);
    const relative = path.relative(repoRoot, absolute);
    if (!candidate || path.isAbsolute(candidate) || relative === ".."
      || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Task file must be relative to its captured Git repository");
    }
    entry.files.add(relative.split(path.sep).join("/"));
  }
  return [...byRoot.values()]
    .filter((entry) => entry.files.size)
    .map((entry) => ({ ...entry, files: [...entry.files].sort((left, right) => left.localeCompare(right)) }));
}

async function scopedWorktreeTree(repository, files, dataDir, token) {
  const repoRoot = path.resolve(repository.repoRoot);
  const indexDir = path.join(dataDir, "task-diff-indexes");
  const indexPath = path.join(indexDir, `${token}.index`);
  await mkdir(indexDir, { recursive: true });
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await gitText(["read-tree", repository.tree], { cwd: repoRoot, env });
    await gitText([
      "add", "-A", "--",
      ...files.map((file) => `:(top,literal)${file}`),
    ], { cwd: repoRoot, env, timeoutMs: 60_000 });
    return await gitText(["write-tree"], { cwd: repoRoot, env });
  } finally {
    await Promise.all([
      rm(indexPath, { force: true }),
      rm(`${indexPath}.lock`, { force: true }),
    ].map((operation) => operation.catch(() => {})));
  }
}

async function captureRepositoryResult(repository, files, dataDir, token) {
  const repoRoot = path.resolve(repository.repoRoot);
  const tree = await scopedWorktreeTree(repository, files, dataDir, `${token}-after`);
  const result = await runGit([
    "-c", "core.quotePath=false",
    "diff", "--name-status", "--find-renames", repository.tree, tree, "--",
  ], { cwd: repoRoot, maxOutputBytes: 4 * 1024 * 1024, timeoutMs: 30_000 });
  if (result.error || result.code !== 0 || result.stdoutTruncated) {
    throw result.error ?? new Error(
      result.stdoutTruncated
        ? "Task changed-file inventory exceeded 4 MiB"
        : result.stderr.trim() || "Cannot capture Task changed-file inventory",
    );
  }
  return {
    snapshot: {
      repoRoot,
      tree,
      indexTree: tree,
      capturedAt: new Date().toISOString(),
    },
    changedFiles: changedFilesFromNameStatus(result.stdout, repoRoot),
  };
}

export async function captureTaskGitBaseline(projectRoot, dataDir, token = randomUUID()) {
  const resolvedProjectRoot = canonicalPath(projectRoot);
  const repoRoots = await resolveTaskGitRepoRoots(resolvedProjectRoot);
  const repositories = (await Promise.all(repoRoots.map(
    (repoRoot, index) => captureRepositoryBaseline(repoRoot, dataDir, `${token}-${index}`),
  ))).filter(Boolean);
  if (!repositories.length) return null;
  if (repositories.length === 1) return repositories[0];
  return {
    projectRoot: resolvedProjectRoot,
    repositories,
    capturedAt: new Date().toISOString(),
  };
}

export async function captureTaskGitResult(baseline, dataDir, token = randomUUID(), ownedFiles = []) {
  const repositories = Array.isArray(baseline?.repositories)
    ? baseline.repositories
    : baseline?.repoRoot ? [baseline] : [];
  const scopes = scopedRepositoryFiles(repositories, Array.isArray(ownedFiles) ? ownedFiles : []);
  if (!scopes.length) return null;
  const results = await Promise.all(scopes.map(
    ({ repository, files }, index) => captureRepositoryResult(
      repository, files, dataDir, `${token}-${index}`,
    ),
  ));
  return {
    snapshot: Array.isArray(baseline?.repositories) ? {
      projectRoot: canonicalPath(baseline.projectRoot),
      repositories: results.map((result) => result.snapshot),
      capturedAt: new Date().toISOString(),
    } : results[0].snapshot,
    changedFiles: results.flatMap((result) => result.changedFiles),
  };
}

export async function resolveTaskGitRepoRoot(projectRoot) {
  try {
    const repoRoot = await gitText(["rev-parse", "--show-toplevel"], { cwd: projectRoot });
    return canonicalPath(repoRoot);
  } catch {
    return null;
  }
}

const REPOSITORY_SCAN_IGNORED_DIRECTORIES = new Set([
  ".git", ".idea", ".vscode", "node_modules", "dist", "build", "coverage", "data", "Import", "WIP",
]);

async function findNestedGitRepoRoots(directory, roots, depth, maximumDepth) {
  if (depth > maximumDepth) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const marker = entries.find((entry) => entry.name === ".git");
  if (marker) {
    const validMarker = marker.isFile() || await readdir(path.join(directory, ".git"))
      .then((gitEntries) => gitEntries.includes("HEAD"), () => false);
    if (validMarker) {
      roots.push(path.resolve(directory));
      return;
    }
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !REPOSITORY_SCAN_IGNORED_DIRECTORIES.has(entry.name))
    .map((entry) => findNestedGitRepoRoots(
      path.join(directory, entry.name), roots, depth + 1, maximumDepth,
    )));
}

export async function resolveTaskGitRepoRoots(projectRoot, { maximumDepth = 5 } = {}) {
  const containing = await resolveTaskGitRepoRoot(projectRoot);
  if (containing) return [containing];
  const roots = [];
  await findNestedGitRepoRoots(path.resolve(projectRoot), roots, 0, maximumDepth);
  return [...new Set(roots)].sort((left, right) => left.localeCompare(right));
}

export async function resolveTaskGitRepoRootsForFiles(projectRoot, files = []) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const roots = new Set();
  for (const file of files) {
    const absoluteFile = path.resolve(resolvedProjectRoot, String(file ?? ""));
    const relativeFile = path.relative(resolvedProjectRoot, absoluteFile);
    if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) continue;
    let candidate = absoluteFile;
    while (true) {
      const root = await resolveTaskGitRepoRoot(candidate);
      if (root) {
        roots.add(root);
        break;
      }
      if (candidate === resolvedProjectRoot) break;
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

export async function taskGitDiff(
  baseline,
  dataDir,
  token = randomUUID(),
  { maxOutputBytes = DEFAULT_MAX_DIFF_BYTES } = {},
) {
  if (Array.isArray(baseline?.repositories)) {
    const projectRoot = path.resolve(baseline.projectRoot);
    const parts = [];
    for (const [index, repository] of baseline.repositories.entries()) {
      const diff = await taskGitDiff(repository, dataDir, `${token}-${index}`, { maxOutputBytes });
      if (!diff) continue;
      const prefix = path.relative(projectRoot, repository.repoRoot).replaceAll(path.sep, "/");
      const withPrefix = prefix
        ? prefixGitDiffMarkerPaths(
          diff.replace(
            /^(diff --git a\/)(\S+)( b\/)(\S+)$/gm,
            `$1${prefix}/$2$3${prefix}/$4`,
          ),
          prefix,
        )
        : diff;
      parts.push(withPrefix);
    }
    return parts.join("\n\n");
  }
  if (!baseline?.repoRoot || !baseline?.tree) return null;
  try {
    const currentTree = await worktreeTree(baseline.repoRoot, dataDir, `${token}-after`);
    const currentIndexTree = await gitText(["write-tree"], { cwd: baseline.repoRoot }).catch(() => null);
    const worktreeChanged = currentTree !== baseline.tree;
    const indexChanged = Boolean(
      baseline.indexTree && currentIndexTree && currentIndexTree !== baseline.indexTree,
    );
    if (!worktreeChanged && !indexChanged) return "";
    const leftTree = worktreeChanged ? baseline.tree : baseline.indexTree;
    const rightTree = worktreeChanged ? currentTree : currentIndexTree;
    const result = await runGit([
      "-c", "core.quotePath=false",
      "diff", "--no-ext-diff", "--find-renames", leftTree, rightTree, "--",
    ], {
      cwd: baseline.repoRoot,
      maxOutputBytes,
      timeoutMs: 30_000,
    });
    if (result.error || result.code !== 0) throw result.error ?? new Error(result.stderr.trim());
    let diff = result.stdout.trim();
    if (worktreeChanged && indexChanged) {
      const stagedFiles = await gitText([
        "-c", "core.quotePath=false",
        "diff", "--name-status", "--find-renames", baseline.indexTree, currentIndexTree, "--",
      ], { cwd: baseline.repoRoot, maxOutputBytes: 16 * 1024 });
      if (stagedFiles) diff += `\n\nИзменения индекса (staged):\n${stagedFiles}`;
    }
    if (result.stdoutTruncated) {
      const files = await gitText([
        "-c", "core.quotePath=false",
        "diff", "--name-status", "--find-renames", baseline.tree, currentTree, "--",
      ], { cwd: baseline.repoRoot, maxOutputBytes: 16 * 1024 });
      diff += `\n\n… diff усечён до ${Math.round(maxOutputBytes / 1024)} КиБ.\n\nИзменённые файлы:\n${files}`;
    }
    return diff;
  } catch {
    return null;
  }
}

// Read-only preview: never stage files, write trees, invoke textconv or external diff drivers.
export async function taskWorkingTreeDiff(repoRoot, baseCommit, { maxOutputBytes = DEFAULT_MAX_DIFF_BYTES } = {}) {
  const deadline = Date.now() + 15_000;
  const run = async (args, { bytes = maxOutputBytes, difference = false } = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Чтение Git diff превысило время ожидания");
    const result = await runGit(["--no-optional-locks", "-c", "core.quotePath=false", ...args], {
      cwd: repoRoot, timeoutMs: remaining, maxOutputBytes: bytes,
    });
    if (result.error || (result.code !== 0 && !(difference && result.code === 1))) {
      throw result.error ?? new Error(result.stderr.trim() || "Не удалось прочитать Git diff");
    }
    return result;
  };
  const tracked = await run(["diff", "--no-ext-diff", "--no-textconv", baseCommit, "--",
    ".", ":(exclude,glob)**/CHANGELOG.md"]);
  const parts = [tracked.stdout];
  let truncated = tracked.stdoutTruncated;
  let remainingBytes = maxOutputBytes - Buffer.byteLength(tracked.stdout, "utf8");
  if (remainingBytes <= 0) truncated = true;
  if (!truncated && remainingBytes > 0) {
    const files = await run(["ls-files", "--others", "--exclude-standard", "-z", "--",
      ".", ":(exclude,glob)**/CHANGELOG.md"]);
    if (files.stdoutTruncated) throw new Error("Список новых файлов слишком велик для просмотра diff");
    const paths = files.stdout.split("\0").filter(Boolean);
    for (const file of paths) {
      if (remainingBytes <= 0) { truncated = true; break; }
      const result = await run(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", file],
        { bytes: remainingBytes, difference: true });
      parts.push(result.stdout);
      remainingBytes -= Buffer.byteLength(result.stdout, "utf8");
      if (result.stdoutTruncated) { truncated = true; break; }
    }
  }
  return { text: parts.join(""), truncated };
}

export async function cleanupTaskGitIndexes(dataDir) {
  const indexDir = path.join(dataDir, "task-diff-indexes");
  let entries;
  try {
    entries = await readdir(indexDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  const stale = entries.filter((entry) => entry.isFile() && entry.name.includes(".index"));
  await Promise.all(stale.map((entry) => rm(path.join(indexDir, entry.name), { force: true })));
  return stale.length;
}
