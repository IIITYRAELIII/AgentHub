import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { taskRepositoryKey } from "../../domain/task-git-reference.mjs";
import { canonicalPath } from "./config.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";

const RELEASE_MARKER = "agent-hub-release-clone.json";
const RELEASE_BRANCH = "PreRelease";

function runGit(args, { cwd, timeoutMs = 120_000 } = {}) {
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

function samePath(left, right) {
  const first = canonicalPath(left);
  const second = canonicalPath(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function pathInside(root, candidate) {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseWorktrees(value) {
  const records = [];
  let current = null;
  for (const line of String(value ?? "").split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      current = { path: canonicalPath(line.slice(9)), branchRef: null, detached: false };
      records.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branchRef = line.slice(7);
    } else if (current && line === "detached") {
      current.detached = true;
    }
  }
  return records;
}

async function repositoryRoot(projectRoot) {
  return canonicalPath(await runGit([
    "rev-parse", "--path-format=absolute", "--show-toplevel",
  ], { cwd: path.resolve(projectRoot) }));
}

async function gitCommonDir(projectRoot) {
  return canonicalPath(path.resolve(await runGit([
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ], { cwd: path.resolve(projectRoot) })));
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableManifest(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedFrozenTasks(tasks = []) {
  const unique = new Map();
  for (const task of tasks) {
    const taskId = String(task?.taskId ?? "").trim();
    const resultCommit = String(task?.resultCommit ?? "").trim();
    if (!taskId || !resultCommit) throw new Error("release candidate requires exact Task IDs and result commits");
    const existing = unique.get(taskId);
    if (existing && existing !== resultCommit) throw new Error(`release Task ${taskId} has multiple result commits`);
    unique.set(taskId, resultCommit);
  }
  if (!unique.size) throw new Error("release candidate requires at least one frozen Task result");
  return [...unique].map(([taskId, resultCommit]) => ({ taskId, resultCommit }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.resultCommit.localeCompare(right.resultCommit));
}

async function dirtyState(root) {
  const [unstaged, staged, untracked, indexEntries] = await Promise.all([
    runGit(["diff", "--name-only", "-z", "--"], { cwd: root }),
    runGit(["diff", "--cached", "--name-only", "-z", "--"], { cwd: root }),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root }),
    runGit(["ls-files", "--stage", "-z"], { cwd: root }),
  ]);
  const paths = [...new Set([unstaged, staged, untracked]
    .flatMap((value) => value.split("\0").filter(Boolean)))].sort();
  const files = [];
  for (const relativePath of paths) {
    const bytes = await readFile(path.join(root, relativePath)).catch((error) => {
      if (error?.code === "ENOENT" || error?.code === "EISDIR") return null;
      throw error;
    });
    files.push({
      path: relativePath,
      sha256: bytes == null ? null : createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return {
    files,
    fingerprint: sha256(JSON.stringify(files)),
    indexFingerprint: sha256(indexEntries),
  };
}

async function primarySnapshot(projectRoot) {
  const root = await repositoryRoot(projectRoot);
  const [branchRef, headCommit, mainCommit, commonDir, worktrees, dirty] = await Promise.all([
    gitMaybe(["symbolic-ref", "--quiet", "HEAD"], { cwd: root }),
    runGit(["rev-parse", "HEAD^{commit}"], { cwd: root }),
    gitMaybe(["rev-parse", "refs/heads/main^{commit}"], { cwd: root }),
    gitCommonDir(root),
    runGit(["worktree", "list", "--porcelain"], { cwd: root }),
    dirtyState(root),
  ]);
  const linked = parseWorktrees(worktrees);
  const legacyLinkedHolders = linked.filter((item) => (
    !samePath(item.path, root)
    && (
      item.branchRef === "refs/heads/main"
      || item.branchRef === `refs/heads/${RELEASE_BRANCH}`
      || /(?:^|[-_.])prerelease(?:[-_.]|$)/iu.test(path.basename(item.path))
    )
  ));
  return {
    root, branchRef, headCommit, mainCommit, commonDir, dirty, worktrees: linked, legacyLinkedHolders,
  };
}

function primaryInvariantFailure(snapshot, phase) {
  if (snapshot.branchRef !== "refs/heads/main" || snapshot.headCommit !== snapshot.mainCommit) {
    return `registered primary Workspace invariant failed during ${phase}: `
      + `HEAD must remain attached to refs/heads/main (${snapshot.root})`;
  }
  const mainHolder = snapshot.worktrees.find((item) => item.branchRef === "refs/heads/main");
  if (!mainHolder || !samePath(mainHolder.path, snapshot.root)) {
    return `registered primary Workspace does not own refs/heads/main during ${phase}`;
  }
  return null;
}

function publicPrimaryEvidence(snapshot) {
  return {
    projectRoot: snapshot.root,
    gitCommonDir: snapshot.commonDir,
    branch: snapshot.branchRef,
    headCommit: snapshot.headCommit,
    mainCommit: snapshot.mainCommit,
    dirtyFingerprint: snapshot.dirty.fingerprint,
    indexFingerprint: snapshot.dirty.indexFingerprint,
    dirtyPaths: snapshot.dirty.files.map((item) => item.path),
    legacyLinkedHolders: snapshot.legacyLinkedHolders,
  };
}

export async function assertReleaseCloneForPublication({ repositoryRoot: requestedRoot } = {}) {
  const root = await repositoryRoot(requestedRoot);
  const commonDir = await gitCommonDir(root);
  const markerFile = path.join(commonDir, RELEASE_MARKER);
  const marker = await readJson(markerFile);
  if (marker?.kind !== "agent-hub-owned-release-clone" || marker.schemaVersion !== 1) {
    throw new Error("publication requires an Agent Hub-owned independent release clone");
  }
  if (!samePath(marker.releaseRoot, root) || !samePath(marker.releaseGitCommonDir, commonDir)) {
    throw new Error("release clone marker does not match the current repository");
  }
  if (samePath(marker.primaryRoot, root) || samePath(marker.primaryGitCommonDir, commonDir)) {
    throw new Error("publication from the registered primary Workspace is forbidden");
  }
  return { ...marker, markerFile };
}

export class ReleaseGitWorkspaceService {
  constructor({ dataDir } = {}) {
    this.dataDir = canonicalPath(String(dataDir ?? ""));
    this.releaseRepositoriesRoot = path.join(this.dataDir, "release-repositories");
    this.lastReconciliation = {
      checked: 0, registeredWorkspaceRoots: 0, checkpointCount: 0, repositories: [],
    };
  }

  async assertPrimaryInvariant(projectRoot, { phase = "release" } = {}) {
    const snapshot = await primarySnapshot(projectRoot);
    const failure = primaryInvariantFailure(snapshot, phase);
    if (failure) throw new Error(failure);
    return publicPrimaryEvidence(snapshot);
  }

  #layout(primaryRoot) {
    const repositoryKey = taskRepositoryKey(primaryRoot);
    const root = path.join(this.releaseRepositoriesRoot, repositoryKey);
    return {
      repositoryKey,
      root,
      releaseRoot: path.join(root, "repository"),
      evidenceRoot: path.join(root, "evidence"),
      checkpointFile: path.join(root, "checkpoint.json"),
    };
  }

  async #ensureClone(primary) {
    const layout = this.#layout(primary.root);
    if (!pathInside(this.releaseRepositoriesRoot, layout.releaseRoot)) {
      throw new Error("release clone escaped its Agent Hub-owned root");
    }
    const gitFile = path.join(layout.releaseRoot, ".git");
    let created = false;
    if (!await fileExists(gitFile) && !await stat(gitFile).catch(() => null)) {
      const upstream = await gitMaybe(["remote", "get-url", "origin"], { cwd: primary.root });
      if (!upstream) throw new Error(`release repository has no origin remote: ${primary.root}`);
      await mkdir(layout.root, { recursive: true });
      await runGit(["clone", "--no-local", "--no-hardlinks", "--no-checkout", primary.root, layout.releaseRoot], {
        cwd: layout.root,
        timeoutMs: 300_000,
      });
      await runGit(["remote", "rename", "origin", "workspace"], { cwd: layout.releaseRoot });
      created = true;
      await runGit(["remote", "add", "origin", upstream], { cwd: layout.releaseRoot });
      await runGit(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
        cwd: layout.releaseRoot,
        timeoutMs: 300_000,
      });
      await runGit(["checkout", "-B", "main", "refs/remotes/origin/main"], { cwd: layout.releaseRoot });
    }

    const releaseRoot = await repositoryRoot(layout.releaseRoot);
    if (!samePath(releaseRoot, layout.releaseRoot)) throw new Error("managed release clone root is not canonical");
    const releaseCommonDir = await gitCommonDir(releaseRoot);
    if (samePath(releaseCommonDir, primary.commonDir)) {
      throw new Error("release repository is a linked worktree of the registered primary Workspace");
    }
    const markerFile = path.join(releaseCommonDir, RELEASE_MARKER);
    const existingMarker = await readJson(markerFile);
    if (!created && !existingMarker) {
      throw new Error("unmarked release repository requires explicit migration");
    }
    if (existingMarker && (
      existingMarker.kind !== "agent-hub-owned-release-clone"
      || !samePath(existingMarker.primaryRoot, primary.root)
      || !samePath(existingMarker.releaseRoot, releaseRoot)
    )) {
      throw new Error("managed release clone marker belongs to another repository");
    }
    const marker = {
      schemaVersion: 1,
      kind: "agent-hub-owned-release-clone",
      managedRoot: this.releaseRepositoriesRoot,
      primaryRoot: primary.root,
      primaryGitCommonDir: primary.commonDir,
      releaseRoot,
      releaseGitCommonDir: releaseCommonDir,
    };
    await writeJsonAtomic(markerFile, marker);
    return { ...layout, ...marker, markerFile };
  }

  async prepareCandidate({ planRevision, projectRoot, frozenTasks = [] } = {}) {
    const revision = String(planRevision ?? "").trim();
    if (!revision) throw new Error("release candidate requires the exact plan revision");
    const tasks = normalizedFrozenTasks(frozenTasks);
    const initial = await primarySnapshot(projectRoot);
    await this.assertPrimaryInvariant(initial.root, { phase: "release preflight" });
    const layout = this.#layout(initial.root);
    const lock = path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`);
    return withInterprocessLocks([lock], async () => {
      const clone = await this.#ensureClone(initial);
      const dirty = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: clone.releaseRoot });
      if (dirty) throw new Error(`Agent Hub-owned release clone is dirty: ${clone.releaseRoot}`);
      await runGit(["fetch", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
        cwd: clone.releaseRoot,
        timeoutMs: 300_000,
      });
      await runGit(["fetch", "--prune", "workspace", "+refs/heads/*:refs/remotes/workspace/*"], {
        cwd: clone.releaseRoot,
        timeoutMs: 300_000,
      });
      for (const task of tasks) {
        if (await gitMaybe(["cat-file", "-e", `${task.resultCommit}^{commit}`], { cwd: clone.releaseRoot }) === null) {
          await runGit(["fetch", "workspace", task.resultCommit], { cwd: clone.releaseRoot, timeoutMs: 300_000 });
        }
      }
      const baseCommit = await runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: clone.releaseRoot });
      const manifest = {
        schemaVersion: 1,
        planRevision: revision,
        primaryRoot: initial.root,
        primaryGitCommonDir: initial.commonDir,
        releaseRoot: clone.releaseRoot,
        releaseGitCommonDir: clone.releaseGitCommonDir,
        baseCommit,
        tasks,
      };
      const manifestText = stableManifest(manifest);
      const manifestHash = sha256(manifestText);
      const manifestFile = path.join(clone.evidenceRoot, `${manifestHash}.json`);
      const checkpoint = await readJson(clone.checkpointFile);
      let preReleaseHead = null;
      let reused = false;
      if (checkpoint?.manifestHash === manifestHash && checkpoint?.preReleaseHead) {
        const storedHead = await gitMaybe(["rev-parse", `${checkpoint.preReleaseHead}^{commit}`], { cwd: clone.releaseRoot });
        const branchHead = await gitMaybe(["rev-parse", `refs/heads/${RELEASE_BRANCH}^{commit}`], { cwd: clone.releaseRoot });
        if (storedHead && storedHead === branchHead) {
          await runGit(["checkout", RELEASE_BRANCH], { cwd: clone.releaseRoot });
          preReleaseHead = storedHead;
          reused = true;
        }
      }
      if (!preReleaseHead) {
        await runGit(["checkout", "-B", "main", baseCommit], { cwd: clone.releaseRoot });
        await runGit(["checkout", "-B", RELEASE_BRANCH, "main"], { cwd: clone.releaseRoot });
        for (const task of tasks) {
          const integrated = await gitMaybe(["merge-base", "--is-ancestor", task.resultCommit, "HEAD"], {
            cwd: clone.releaseRoot,
          }) !== null;
          if (integrated) continue;
          try {
            await runGit([
              "-c", "user.name=Agent Hub",
              "-c", "user.email=agent-hub@local.invalid",
              "merge", "--no-ff", "--no-edit", task.resultCommit,
            ], { cwd: clone.releaseRoot, timeoutMs: 300_000 });
          } catch (error) {
            const conflicts = String(await gitMaybe(["diff", "--name-only", "--diff-filter=U"], {
              cwd: clone.releaseRoot,
            }) ?? "").split(/\r?\n/u).filter(Boolean);
            await gitMaybe(["merge", "--abort"], { cwd: clone.releaseRoot });
            throw new Error(`PreRelease merge failed for Task ${task.taskId}: ${conflicts.join(", ") || error.message}`);
          }
        }
        preReleaseHead = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: clone.releaseRoot });
      }
      await mkdir(clone.evidenceRoot, { recursive: true });
      if (!await fileExists(manifestFile)) await writeFile(manifestFile, manifestText, "utf8");
      await writeJsonAtomic(clone.checkpointFile, {
        schemaVersion: 1,
        phase: "prepared",
        planRevision: revision,
        manifestHash,
        manifestFile,
        baseCommit,
        preReleaseHead,
        updatedAt: new Date().toISOString(),
      });

      const finalPrimary = await primarySnapshot(initial.root);
      await this.assertPrimaryInvariant(finalPrimary.root, { phase: "release candidate preparation" });
      if (
        finalPrimary.headCommit !== initial.headCommit
        || finalPrimary.branchRef !== initial.branchRef
        || finalPrimary.dirty.indexFingerprint !== initial.dirty.indexFingerprint
        || finalPrimary.dirty.fingerprint !== initial.dirty.fingerprint
      ) {
        throw new Error("release candidate preparation changed the registered primary Workspace");
      }
      return {
        repositoryRoot: initial.root,
        releaseRoot: clone.releaseRoot,
        branch: RELEASE_BRANCH,
        baseCommit,
        preReleaseHead,
        manifestHash,
        manifestFile,
        frozenTasks: tasks,
        reused,
        independentGitCommonDir: !samePath(clone.releaseGitCommonDir, initial.commonDir),
        releaseGitCommonDir: clone.releaseGitCommonDir,
        primaryGitCommonDir: initial.commonDir,
        primaryPreserved: true,
        legacyLinkedHolders: initial.legacyLinkedHolders,
      };
    });
  }

  async synchronizePublishedPrimary({ projectRoot, publishedRevision, planRevision = null } = {}) {
    const target = String(publishedRevision ?? "").trim();
    const initial = await primarySnapshot(projectRoot);
    try {
      await this.assertPrimaryInvariant(initial.root, { phase: "post-release synchronization" });
    } catch (error) {
      return { status: "manual_required", reason: error.message, primary: publicPrimaryEvidence(initial) };
    }
    const layout = this.#layout(initial.root);
    const lock = path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`);
    return withInterprocessLocks([lock], async () => {
      await runGit(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
        cwd: initial.root,
        timeoutMs: 300_000,
      });
      const originMain = await runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: initial.root });
      if (target && originMain !== target) {
        return {
          status: "manual_required",
          reason: `origin/main ${originMain} does not match published revision ${target}`,
          primary: publicPrimaryEvidence(await primarySnapshot(initial.root)),
        };
      }
      const fastForward = await gitMaybe(["merge-base", "--is-ancestor", initial.headCommit, originMain], {
        cwd: initial.root,
      }) !== null;
      if (!fastForward) {
        return {
          status: "manual_required",
          reason: "published main is not a fast-forward of the registered primary Workspace",
          primary: publicPrimaryEvidence(await primarySnapshot(initial.root)),
        };
      }
      const changedPaths = new Set(String(await runGit([
        "diff", "--name-only", "-z", initial.headCommit, originMain, "--",
      ], { cwd: initial.root })).split("\0").filter(Boolean));
      const overlaps = initial.dirty.files.map((item) => item.path).filter((item) => changedPaths.has(item));
      if (overlaps.length) {
        return {
          status: "manual_required",
          reason: `intentional local modifications overlap published main: ${overlaps.join(", ")}`,
          conflicts: overlaps,
          primary: publicPrimaryEvidence(await primarySnapshot(initial.root)),
        };
      }
      if (initial.headCommit !== originMain) {
        await runGit(["merge", "--ff-only", "--no-edit", originMain], { cwd: initial.root, timeoutMs: 300_000 });
      }
      const final = await primarySnapshot(initial.root);
      await this.assertPrimaryInvariant(final.root, { phase: "post-release verification" });
      if (final.headCommit !== originMain || final.dirty.fingerprint !== initial.dirty.fingerprint) {
        throw new Error("post-release fast-forward did not preserve the registered primary Workspace");
      }
      const checkpoint = await readJson(layout.checkpointFile);
      await writeJsonAtomic(layout.checkpointFile, {
        ...(checkpoint ?? { schemaVersion: 1 }),
        phase: "primary-synchronized",
        planRevision: String(planRevision ?? checkpoint?.planRevision ?? "") || null,
        publishedRevision: originMain,
        primarySynchronization: { status: "fast_forwarded", dirtyFingerprint: final.dirty.fingerprint },
        updatedAt: new Date().toISOString(),
      });
      return {
        status: initial.headCommit === originMain ? "already_current" : "fast_forwarded",
        publishedRevision: originMain,
        dirtyPathsPreserved: final.dirty.files.map((item) => item.path),
        primary: publicPrimaryEvidence(final),
      };
    });
  }

  async reconcile({ projectRoots = [] } = {}) {
    const entries = await readdir(this.releaseRepositoriesRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const checkpoints = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const checkpointFile = path.join(this.releaseRepositoriesRoot, entry.name, "checkpoint.json");
      const checkpoint = await readJson(checkpointFile);
      const manifest = checkpoint?.manifestFile ? await readJson(checkpoint.manifestFile) : null;
      if (manifest?.primaryRoot) checkpoints.push({
        repositoryKey: entry.name, checkpointFile, checkpoint, manifest,
      });
    }

    const repositories = [];
    const auditedRoots = [];
    const attemptedRegisteredRoots = [];
    const registeredRoots = projectRoots.map((item) => ({
      workspaceId: typeof item === "object" ? String(item?.workspaceId ?? "").trim() || null : null,
      registrationSource: typeof item === "object"
        ? String(item?.registrationSource ?? "").trim() || null
        : null,
      projectRoot: String(typeof item === "object" ? item?.projectRoot ?? "" : item ?? "").trim(),
    })).filter((item) => item.projectRoot);
    for (const registeredRoot of registeredRoots) {
      const requestedRoot = registeredRoot.projectRoot;
      if (attemptedRegisteredRoots.some((item) => samePath(item, requestedRoot))) continue;
      attemptedRegisteredRoots.push(requestedRoot);
      try {
        const snapshot = await primarySnapshot(requestedRoot);
        if (auditedRoots.some((item) => samePath(item, snapshot.root))) continue;
        auditedRoots.push(snapshot.root);
        const checkpoint = checkpoints.find((item) => samePath(item.manifest.primaryRoot, snapshot.root)) ?? null;
        const failure = primaryInvariantFailure(snapshot, "startup reconciliation");
        const legacyFailure = snapshot.legacyLinkedHolders.length
          ? `legacy linked release holder detected for registered primary Workspace (${snapshot.root})`
          : null;
        if (failure || legacyFailure) {
          repositories.push({
            source: "registered_workspace",
            workspaceId: registeredRoot.workspaceId,
            registrationSource: registeredRoot.registrationSource,
            repositoryKey: taskRepositoryKey(snapshot.root),
            status: "manual_required",
            reason: failure ?? legacyFailure,
            primary: publicPrimaryEvidence(snapshot),
            releaseRoot: checkpoint?.manifest?.releaseRoot ?? null,
            checkpointPresent: checkpoint != null,
          });
          continue;
        }
        let releaseRoot = null;
        if (checkpoint) {
          releaseRoot = (await assertReleaseCloneForPublication({
            repositoryRoot: checkpoint.manifest.releaseRoot,
          })).releaseRoot;
        }
        repositories.push({
          source: "registered_workspace",
          workspaceId: registeredRoot.workspaceId,
          registrationSource: registeredRoot.registrationSource,
          repositoryKey: taskRepositoryKey(snapshot.root),
          status: "ready",
          primary: publicPrimaryEvidence(snapshot),
          releaseRoot,
          checkpointPresent: checkpoint != null,
        });
      } catch (error) {
        repositories.push({
          source: "registered_workspace",
          workspaceId: registeredRoot.workspaceId,
          registrationSource: registeredRoot.registrationSource,
          projectRoot: requestedRoot,
          repositoryKey: taskRepositoryKey(requestedRoot),
          status: "manual_required",
          reason: error.message,
          checkpointPresent: false,
        });
      }
    }

    for (const checkpoint of checkpoints) {
      if (auditedRoots.some((item) => samePath(item, checkpoint.manifest.primaryRoot))) continue;
      try {
        const primary = await this.assertPrimaryInvariant(checkpoint.manifest.primaryRoot, {
          phase: "startup reconciliation",
        });
        const marker = await assertReleaseCloneForPublication({
          repositoryRoot: checkpoint.manifest.releaseRoot,
        });
        repositories.push({
          source: "checkpoint",
          repositoryKey: checkpoint.repositoryKey,
          status: "ready",
          primary,
          releaseRoot: marker.releaseRoot,
          checkpointPresent: true,
        });
      } catch (error) {
        repositories.push({
          source: "checkpoint",
          repositoryKey: checkpoint.repositoryKey,
          status: "manual_required",
          reason: error.message,
          checkpointPresent: true,
        });
      }
    }
    this.lastReconciliation = {
      checked: repositories.length,
      registeredWorkspaceRoots: attemptedRegisteredRoots.length,
      checkpointCount: checkpoints.length,
      repositories,
    };
    return this.lastReconciliation;
  }

  diagnostics() {
    return structuredClone(this.lastReconciliation);
  }
}
