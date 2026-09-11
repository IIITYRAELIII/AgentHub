import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { assertContourExternalEffects, assertContourGitAvailable } from "../../ports/contour-external-effects.mjs";

import { taskRepositoryKey } from "../../domain/task-git-reference.mjs";
import { canonicalPath } from "./config.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import { freezePreparedPublicationCandidate } from "./freeze-publication-candidate.mjs";
import { resolveExactOrderPreservingUnion } from "./release-order-preserving-union.mjs";
import { releaseTaskNetProjections } from "./release-task-net-projection.mjs";

const RELEASE_MARKER = "agent-hub-release-clone.json";
const RELEASE_BRANCH = "PreRelease";

function runGit(args, { cwd, timeoutMs = 120_000, rawOutput = false } = {}) {
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
      const bytes = Buffer.concat(stdout);
      const output = rawOutput ? bytes : bytes.toString("utf8").trim();
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(output);
      else reject(new Error(errorText || `git ${args[0]} exited with ${code}`));
    });
  });
}

function runGitWithInput(args, input, { cwd, timeoutMs = 120_000 } = {}) {
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

async function gitMaybe(args, options) {
  try {
    return await runGit(args, options);
  } catch {
    return null;
  }
}

async function pendingTaskIntegrations(tasks, baseCommit, git) {
  const pending = [];
  for (const task of tasks) {
    const integrations = [];
    for (const integration of task.integrations) {
      const parents = String(await git(["show", "-s", "--format=%P", integration.commit]))
        .split(" ").filter(Boolean);
      if (parents[0] !== integration.parent) {
        throw new Error(`PreRelease integration parent changed for Task ${task.taskId}`);
      }
      let publishedAutomaticMerge = false;
      let taskSidePublished = false;
      if (parents.length === 2) {
        try { await git(["merge-base", "--is-ancestor", parents[1], baseCommit]); taskSidePublished = true; }
        catch { /* A non-published task-side parent remains part of the pending delta. */ }
      }
      if (taskSidePublished) {
        try {
          const mergeTree = String(await git(["merge-tree", "--write-tree", ...parents]))
            .split(/\r?\n/u)[0];
          publishedAutomaticMerge = mergeTree === await git(["rev-parse", `${integration.commit}^{tree}`]);
        } catch { /* Retain the effective delta unless Git proves the published merge exactly. */ }
      }
      if (!publishedAutomaticMerge) integrations.push(integration);
    }
    pending.push({ ...task, integrations });
  }
  return pending;
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

function githubLoginFromEmail(value) {
  const match = String(value ?? "").trim().match(/^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)@users\.noreply\.github\.com$/iu);
  return match?.[1] ?? null;
}

function releaseImpact(files) {
  const categories = new Set();
  for (const file of files) {
    if (file.startsWith("AgentHub/src/") || /(^|\/)AgentHub\/[^/]+\.mjs$/u.test(file)) categories.add("runtime");
    else if (file.startsWith("AgentHub/assets/") || file.startsWith("AgentHub/VSCodeExtension/")) categories.add("client");
    else if (file.startsWith("AgentHub/cloudflare-worker/")) categories.add("worker");
    else if (file.startsWith("AgentHub/docs/") || file === "AgentHub/README.md") categories.add("documentation");
    else if (file.startsWith("AgentHub/tests/")) categories.add("tests");
    else if (file === "AGENTS.md" || file.endsWith("/AGENTS.md")) categories.add("agent-rules");
    else categories.add("workspace");
  }
  return [...categories].sort();
}

async function disclosedCommit(root, commit, { localMain, originMain }) {
  const fields = String(await runGit([
    "show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%cI%x00%G?%x00%GS%x00%s",
    commit,
  ], { cwd: root })).split("\0");
  const parents = String(fields[1] ?? "").split(" ").filter(Boolean);
  const files = String(await runGit([
    "diff", "--name-only", "--diff-filter=ACMRTUXB", parents[0], commit, "--",
  ], { cwd: root })).split(/\r?\n/u).filter(Boolean).sort();
  return {
    commit: fields[0],
    parents,
    subject: fields[10] ?? "",
    author: {
      name: fields[2] ?? "",
      email: fields[3] ?? "",
      githubLogin: githubLoginFromEmail(fields[3]),
      at: fields[6] ?? "",
    },
    committer: {
      name: fields[4] ?? "",
      email: fields[5] ?? "",
      githubLogin: githubLoginFromEmail(fields[5]),
      at: fields[7] ?? "",
    },
    signature: { status: fields[8] ?? "N", signer: fields[9] ?? "" },
    files,
    impact: releaseImpact(files),
    inLocalMain: await gitMaybe(["merge-base", "--is-ancestor", commit, localMain], { cwd: root }) !== null,
    inOriginMain: await gitMaybe(["merge-base", "--is-ancestor", commit, originMain], { cwd: root }) !== null,
  };
}

function normalizedFrozenTasks(tasks = []) {
  const unique = new Map();
  for (const task of tasks) {
    const taskId = String(task?.taskId ?? "").trim();
    const taskRevision = Number(task?.taskRevision);
    const resultCommit = String(task?.resultCommit ?? "").trim();
    if (!taskId || !Number.isInteger(taskRevision) || taskRevision < 1 || !resultCommit) {
      throw new Error("release candidate requires exact Task IDs, revisions and result commits");
    }
    const integrations = (Array.isArray(task?.integrations) ? task.integrations : []).map((integration) => ({
      commit: String(integration?.commit ?? "").trim(),
      parent: String(integration?.parent ?? "").trim(),
      order: Number(integration?.order),
    }));
    if (integrations.some((integration) => (
      !integration.commit || !integration.parent || !Number.isInteger(integration.order) || integration.order < 0
    ))) throw new Error(`release Task ${taskId} has invalid dev integration evidence`);
    const normalized = { taskId, taskRevision, resultCommit, integrations };
    const existing = unique.get(taskId);
    if (existing && stableManifest(existing) !== stableManifest(normalized)) {
      throw new Error(`release Task ${taskId} has multiple result commits or integration histories`);
    }
    unique.set(taskId, normalized);
  }
  return [...unique.values()].sort((left, right) => (
    (left.integrations[0]?.order ?? Number.MAX_SAFE_INTEGER)
    - (right.integrations[0]?.order ?? Number.MAX_SAFE_INTEGER)
    || left.taskId.localeCompare(right.taskId)
  ));
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

export async function assertReleaseCandidateContourSource({ sourceRoot: requestedRoot } = {}) {
  const requestedSourceRoot = canonicalPath(String(requestedRoot ?? ""));
  const marker = await assertReleaseCloneForPublication({ repositoryRoot: requestedSourceRoot });
  const expectedSourceRoot = canonicalPath(path.join(marker.releaseRoot, "AgentHub"));
  if (!samePath(requestedSourceRoot, expectedSourceRoot)) {
    throw new Error("release candidate contour source must be the AgentHub directory of the managed release clone");
  }
  const [branch, headCommit, mainCommit, dirty] = await Promise.all([
    runGit(["symbolic-ref", "--short", "HEAD"], { cwd: marker.releaseRoot }),
    runGit(["rev-parse", "HEAD^{commit}"], { cwd: marker.releaseRoot }),
    runGit(["rev-parse", "refs/heads/main^{commit}"], { cwd: marker.releaseRoot }),
    runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: marker.releaseRoot }),
  ]);
  if (branch !== "main") {
    throw new Error(`release candidate contour source must be attached to main, got ${branch}`);
  }
  if (headCommit !== mainCommit) {
    throw new Error("release candidate contour source HEAD must equal refs/heads/main");
  }
  if (dirty) {
    throw new Error("release candidate contour source must be clean");
  }
  return {
    kind: "release-candidate",
    branch,
    headCommit,
    sourceRoot: expectedSourceRoot,
    releaseRoot: marker.releaseRoot,
    releaseGitCommonDir: marker.releaseGitCommonDir,
    markerFile: marker.markerFile,
  };
}

export class ReleaseGitWorkspaceService {
  #contourExternalEffects;

  constructor({ dataDir, contourExternalEffects = null } = {}) {
    this.#contourExternalEffects = assertContourExternalEffects(contourExternalEffects);
    this.dataDir = canonicalPath(String(dataDir ?? ""));
    this.releaseRepositoriesRoot = path.join(this.dataDir, "release-repositories");
    this.lastReconciliation = {
      checked: 0, registeredWorkspaceRoots: 0, checkpointCount: 0, repositories: [],
    };
  }

  #assertAvailable(operation) {
    assertContourGitAvailable(this.#contourExternalEffects, "release-git", operation);
  }

  async assertPrimaryInvariant(projectRoot, { phase = "release" } = {}) {
    this.#assertAvailable("assertPrimaryInvariant");
    const snapshot = await primarySnapshot(projectRoot);
    const failure = primaryInvariantFailure(snapshot, phase);
    if (failure) throw new Error(failure);
    return publicPrimaryEvidence(snapshot);
  }

  async withAwaitTransition(workspaceId, operation) {
    this.#assertAvailable("withAwaitTransition");
    if (typeof operation !== "function") throw new TypeError("Await transition operation is required");
    const identity = sha256(String(workspaceId ?? "").trim()).slice(0, 24);
    const lock = path.join(this.dataDir, "locks", `release-await-${identity}`);
    return withInterprocessLocks([lock], operation);
  }

  async inspectMainChanges({
    projectRoot, publishedRevision, approvedLocalMainCommit = null, approvedOriginMainCommit = null,
  } = {}) {
    this.#assertAvailable("inspectMainChanges");
    const baseline = String(publishedRevision ?? "").trim();
    if (!baseline) throw new Error("main review requires the last published revision");
    const primary = await primarySnapshot(projectRoot);
    await this.assertPrimaryInvariant(primary.root, { phase: "main review" });
    const layout = this.#layout(primary.root);
    const lock = path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`);
    return withInterprocessLocks([lock], async () => {
      const clone = await this.#ensureClone(primary);
      await runGit(["fetch", "workspace", "+refs/heads/main:refs/remotes/workspace/main"], {
        cwd: clone.releaseRoot,
        timeoutMs: 300_000,
      });
      await runGit(["fetch", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
        cwd: clone.releaseRoot,
        timeoutMs: 300_000,
      });
      if (await gitMaybe(["cat-file", "-e", `${baseline}^{commit}`], { cwd: clone.releaseRoot }) === null) {
        await runGit(["fetch", "workspace", baseline], { cwd: clone.releaseRoot, timeoutMs: 300_000 });
      }
      const localMain = primary.mainCommit;
      const originMain = await runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: clone.releaseRoot });
      for (const target of [localMain, originMain]) {
        if (await gitMaybe(["merge-base", "--is-ancestor", baseline, target], { cwd: clone.releaseRoot }) === null) {
          throw new Error(`last published revision ${baseline} is not an ancestor of main ${target}`);
        }
      }
      const commitIds = String(await runGit([
        "rev-list", "--reverse", "--topo-order", localMain, originMain, `^${baseline}`,
      ], { cwd: clone.releaseRoot })).split(/\r?\n/u).filter(Boolean);
      const commits = [];
      for (const commit of commitIds) commits.push(await disclosedCommit(clone.releaseRoot, commit, {
        localMain,
        originMain,
      }));
      const approved = String(approvedLocalMainCommit ?? "").trim() === localMain
        && String(approvedOriginMainCommit ?? "").trim() === originMain;
      const audit = {
        projectRoot: primary.root,
        publishedRevision: baseline,
        localMain,
        originMain,
        commits,
        changed: commits.length > 0,
        diverged: localMain !== originMain,
        approved,
        approvalRequired: commits.length > 0 && !approved,
      };
      const finalPrimary = await primarySnapshot(primary.root);
      await this.assertPrimaryInvariant(finalPrimary.root, { phase: "main review" });
      if (
        finalPrimary.headCommit !== primary.headCommit
        || finalPrimary.mainCommit !== primary.mainCommit
        || finalPrimary.branchRef !== primary.branchRef
        || finalPrimary.dirty.indexFingerprint !== primary.dirty.indexFingerprint
      ) {
        throw new Error("registered primary Workspace changed during main review");
      }
      return audit;
    });
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
      await runGit([
        "-c", "core.longpaths=true", "clone", "--single-branch", "--branch", "main",
        "--no-local", "--no-hardlinks", "--no-checkout",
        primary.root, layout.releaseRoot,
      ], {
        cwd: layout.root,
        timeoutMs: 300_000,
      });
      await runGit(["remote", "rename", "origin", "workspace"], { cwd: layout.releaseRoot });
      await runGit(["config", "core.longpaths", "true"], { cwd: layout.releaseRoot });
      created = true;
      await runGit(["remote", "add", "origin", upstream], { cwd: layout.releaseRoot });
      await runGit(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
        cwd: layout.releaseRoot,
        timeoutMs: 300_000,
      });
      await runGit(["checkout", "-B", "main", "refs/remotes/origin/main"], { cwd: layout.releaseRoot });
      await runGit(["reset", "--hard", "refs/remotes/origin/main"], { cwd: layout.releaseRoot });
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

  async prepareCandidate({
    planRevision, projectRoot, workspaceId = null, frozenTasks = [], approvedBaseCommit = null, validateBeforeCommit = null,
  } = {}) {
    this.#assertAvailable("prepareCandidate");
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
      if (dirty) throw new Error(`Agent Hub-owned release clone is dirty: ${clone.releaseRoot}: ${dirty}`);
      await runGit(["fetch", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
        cwd: clone.releaseRoot,
        timeoutMs: 300_000,
      });
      await runGit(["fetch", "--prune", "workspace", "+refs/heads/*:refs/remotes/workspace/*"], {
        cwd: clone.releaseRoot,
        timeoutMs: 300_000,
      });
      for (const task of tasks) {
        for (const commit of [task.resultCommit, ...task.integrations.flatMap((item) => [item.parent, item.commit])]) {
          if (await gitMaybe(["cat-file", "-e", `${commit}^{commit}`], { cwd: clone.releaseRoot }) === null) {
            await runGit(["fetch", "workspace", commit], { cwd: clone.releaseRoot, timeoutMs: 300_000 });
          }
        }
      }
      for (const [order, task] of tasks.entries()) {
        if (task.integrations.length) continue;
        const parent = await runGit(["rev-parse", `${task.resultCommit}^1`], { cwd: clone.releaseRoot });
        task.integrations = [{ commit: task.resultCommit, parent, order }];
      }
      const baseCommit = await runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: clone.releaseRoot });
      if (approvedBaseCommit != null && String(approvedBaseCommit).trim() !== baseCommit) {
        throw new Error(`approved origin/main changed: expected ${approvedBaseCommit}, got ${baseCommit}`);
      }
      const manifest = {
        schemaVersion: 2,
        projectionPolicy: "task-net-ancestry-v2",
        ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
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
      let netProjectedTaskIds = [];
      if (checkpoint?.manifestHash === manifestHash && checkpoint?.preReleaseHead) {
        const storedHead = await gitMaybe(["rev-parse", `${checkpoint.preReleaseHead}^{commit}`], { cwd: clone.releaseRoot });
        const branchHead = await gitMaybe(["rev-parse", `refs/heads/${RELEASE_BRANCH}^{commit}`], { cwd: clone.releaseRoot });
        if (storedHead && storedHead === branchHead) {
          await runGit(["checkout", RELEASE_BRANCH], { cwd: clone.releaseRoot });
          preReleaseHead = storedHead;
          reused = true;
          netProjectedTaskIds = checkpoint.netProjectedTaskIds ?? [];
        }
      }
      if (!preReleaseHead) {
        const branchRef = `refs/heads/${RELEASE_BRANCH}`;
        const previousBranchHead = await gitMaybe(["rev-parse", `${branchRef}^{commit}`], { cwd: clone.releaseRoot });
        let branchCommitted = false;
        const restoreWorkingTree = async () => {
          await runGit(["reset", "--hard", previousBranchHead || baseCommit], { cwd: clone.releaseRoot });
          if (previousBranchHead) await runGit(["checkout", "-f", RELEASE_BRANCH], { cwd: clone.releaseRoot });
          else await runGit(["checkout", "--detach", baseCommit], { cwd: clone.releaseRoot });
        };
        try {
          await runGit(["checkout", "--detach", baseCommit], { cwd: clone.releaseRoot });
          const pendingTasks = await pendingTaskIntegrations(tasks, baseCommit,
            (args) => runGit(args, { cwd: clone.releaseRoot, timeoutMs: 300_000 }));
          const projections = await releaseTaskNetProjections({
            tasks: pendingTasks, baseCommit,
            git: (args) => runGit(args, { cwd: clone.releaseRoot, timeoutMs: 300_000 }),
          });
          netProjectedTaskIds = [...projections.keys()];
          const integrations = pendingTasks.flatMap((task) => {
            const projection = projections.get(task.taskId);
            const selected = projection ? [{
              ...projection, netProjection: true,
              order: Math.max(...task.integrations.map((item) => item.order)),
            }] : task.integrations;
            return selected.map((integration) => ({ ...integration, taskId: task.taskId }));
          }).sort((left, right) => left.order - right.order || left.commit.localeCompare(right.commit));
          for (const integration of integrations) {
            const priorTree = await runGit(["write-tree"], { cwd: clone.releaseRoot });
            const actualParents = String(await runGit([
              "show", "-s", "--format=%P", integration.commit,
            ], { cwd: clone.releaseRoot })).split(" ").filter(Boolean);
            if (!integration.netProjection && actualParents[0] !== integration.parent) {
              throw new Error(`PreRelease integration parent changed for Task ${integration.taskId}`);
            }
            const patch = await runGit([
              "diff", "--binary", "--full-index", "--find-renames",
              integration.parent, integration.commit, "--", ".", ":(exclude,glob)**/CHANGELOG.md", ":(exclude)CHANGELOG.md",
            ], { cwd: clone.releaseRoot, timeoutMs: 300_000, rawOutput: true });
            // A patch is a byte protocol: blank context lines and binary block
            // terminators must reach git apply exactly as git diff emitted them.
            if (!patch.length) continue;
            try {
              await runGitWithInput([
                "apply", "--index", "--whitespace=nowarn", "-",
              ], patch, { cwd: clone.releaseRoot, timeoutMs: 300_000 });
            } catch {
              await runGit(["read-tree", "--reset", "-u", priorTree], { cwd: clone.releaseRoot });
              try {
                await runGitWithInput([
                  "apply", "--3way", "--index", "--whitespace=nowarn", "-",
                ], patch, { cwd: clone.releaseRoot, timeoutMs: 300_000 });
                continue;
              } catch (error) {
                const conflicts = String(await gitMaybe(["diff", "--name-only", "--diff-filter=U"], {
                  cwd: clone.releaseRoot,
                }) ?? "").split(/\r?\n/u).filter(Boolean);
                if (integration.netProjection && integration.orderPreserving
                    && await resolveExactOrderPreservingUnion({
                      candidateRoot: clone.releaseRoot,
                      conflicts,
                      approvedBaseCommit: baseCommit,
                    })) continue;
                throw new Error(
                  `PreRelease delta ${integration.commit} (dev order ${integration.order}) failed for Task `
                  + `${integration.taskId}: ${conflicts.join(", ") || error.message}`,
                );
              }
            }
          }
          const staged = await gitMaybe(["diff", "--cached", "--quiet", "--"], { cwd: clone.releaseRoot }) === null;
          if (staged) {
            const tree = await runGit(["write-tree"], { cwd: clone.releaseRoot });
            const parents = [baseCommit, ...new Set(tasks.map((task) => task.resultCommit))]
              .flatMap((commit) => ["-p", commit]);
            preReleaseHead = await runGit([
              "-c", "user.name=Agent Hub",
              "-c", "user.email=agent-hub@local.invalid",
              "commit-tree", tree, ...parents, "-m", `release: aggregate ${tasks.length} Await Tasks`,
            ], { cwd: clone.releaseRoot });
          } else {
            preReleaseHead = baseCommit;
          }
          if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
          await mkdir(clone.evidenceRoot, { recursive: true });
          if (!await fileExists(manifestFile)) await writeFile(manifestFile, manifestText, "utf8");
          const previousRef = previousBranchHead || "0".repeat(40);
          await runGit(["update-ref", branchRef, preReleaseHead, previousRef], { cwd: clone.releaseRoot });
          branchCommitted = true;
          await writeJsonAtomic(clone.checkpointFile, {
            schemaVersion: 2,
            phase: "prepared",
            netProjectedTaskIds,
            planRevision: revision,
            manifestHash,
            manifestFile,
            baseCommit,
            preReleaseHead,
            updatedAt: new Date().toISOString(),
          });
          await runGit(["symbolic-ref", "HEAD", branchRef], { cwd: clone.releaseRoot });
          await runGit(["reset", "--hard", preReleaseHead], { cwd: clone.releaseRoot });
        } catch (error) {
          if (branchCommitted) {
            if (previousBranchHead) {
              await runGit(["update-ref", branchRef, previousBranchHead, preReleaseHead], { cwd: clone.releaseRoot });
            } else {
              await runGit(["update-ref", "-d", branchRef, preReleaseHead], { cwd: clone.releaseRoot });
            }
            if (checkpoint) await writeJsonAtomic(clone.checkpointFile, checkpoint);
            else await rm(clone.checkpointFile, { force: true });
          }
          await restoreWorkingTree();
          throw error;
        }
      }

      const finalPrimary = await primarySnapshot(initial.root);
      await this.assertPrimaryInvariant(finalPrimary.root, { phase: "release candidate preparation" });
      if (
        finalPrimary.headCommit !== initial.headCommit
        || finalPrimary.branchRef !== initial.branchRef
        || finalPrimary.dirty.indexFingerprint !== initial.dirty.indexFingerprint
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
        netProjectedTaskIds,
        reused,
        independentGitCommonDir: !samePath(clone.releaseGitCommonDir, initial.commonDir),
        releaseGitCommonDir: clone.releaseGitCommonDir,
        primaryGitCommonDir: initial.commonDir,
        primaryPreserved: true,
        legacyLinkedHolders: initial.legacyLinkedHolders,
      };
    });
  }

  async freezePublicationCandidate({ projectRoot, workspaceId, ...options } = {}) {
    this.#assertAvailable("freezePublicationCandidate");
    if (!String(workspaceId ?? "").trim()) throw new Error("publication freeze requires its Workspace");
    return this.withAwaitTransition(workspaceId, async () => {
      const initial = await this.assertPrimaryInvariant(projectRoot, { phase: "publication freeze" });
      const layout = this.#layout(initial.projectRoot);
      const lock = path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`);
      return withInterprocessLocks([lock], async () => {
        const marker = await assertReleaseCloneForPublication({ repositoryRoot: layout.releaseRoot });
        if (!samePath(marker.primaryRoot, initial.projectRoot)) throw new Error("publication freeze clone belongs to another primary");
        const result = await freezePreparedPublicationCandidate({ ...options, layout, marker, workspaceId });
        const final = await this.assertPrimaryInvariant(projectRoot, { phase: "publication freeze completion" });
        if (initial.headCommit !== final.headCommit || initial.indexFingerprint !== final.indexFingerprint
          || initial.dirtyFingerprint !== final.dirtyFingerprint) throw new Error("primary Workspace changed during publication freeze");
        return result;
      });
    });
  }

  async frozenCandidate(projectRoot) {
    this.#assertAvailable("frozenCandidate");
    const primary = await primarySnapshot(projectRoot);
    const layout = this.#layout(primary.root);
    const checkpoint = await readJson(layout.checkpointFile);
    if (!checkpoint?.planRevision || !checkpoint?.manifestHash
        || !checkpoint?.baseCommit || !checkpoint?.preReleaseHead) {
      throw new Error(`release checkpoint is incomplete: ${layout.checkpointFile}`);
    }
    return {
      repositoryRoot: primary.root,
      releaseRoot: layout.releaseRoot,
      checkpointFile: layout.checkpointFile,
      planRevision: String(checkpoint.planRevision),
      manifestHash: String(checkpoint.manifestHash),
      baseCommit: String(checkpoint.baseCommit),
      preReleaseHead: String(checkpoint.preReleaseHead),
    };
  }

  async synchronizePublishedPrimary({ projectRoot, publishedRevision, planRevision = null } = {}) {
    this.#assertAvailable("synchronizePublishedPrimary");
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
    this.#assertAvailable("reconcile");
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
        const layout = this.#layout(snapshot.root);
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
            repositoryKey: layout.repositoryKey,
            status: "manual_required",
            reason: failure ?? legacyFailure,
            primary: publicPrimaryEvidence(snapshot),
            releaseRoot: layout.releaseRoot,
            checkpointPresent: checkpoint != null,
          });
          continue;
        }
        const releaseRootExists = await lstat(layout.releaseRoot).then(() => true).catch((error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        });
        if (releaseRootExists && !checkpoint) {
          repositories.push({
            source: "registered_workspace",
            workspaceId: registeredRoot.workspaceId,
            registrationSource: registeredRoot.registrationSource,
            repositoryKey: layout.repositoryKey,
            status: "manual_required",
            reason: `orphan managed release repository exists without a valid checkpoint (${layout.releaseRoot})`,
            primary: publicPrimaryEvidence(snapshot),
            releaseRoot: layout.releaseRoot,
            checkpointPresent: false,
          });
          continue;
        }
        let releaseRoot = null;
        if (checkpoint) {
          if (checkpoint.repositoryKey !== layout.repositoryKey
            || !samePath(checkpoint.checkpointFile, layout.checkpointFile)
            || !samePath(checkpoint.manifest.releaseRoot, layout.releaseRoot)) {
            throw new Error(`release checkpoint does not match the expected managed layout (${layout.releaseRoot})`);
          }
          const marker = await assertReleaseCloneForPublication({ repositoryRoot: layout.releaseRoot });
          if (!samePath(marker.primaryRoot, snapshot.root)
            || !samePath(marker.primaryGitCommonDir, snapshot.commonDir)) {
            throw new Error(`managed release clone ownership does not match the registered primary Workspace (${snapshot.root})`);
          }
          releaseRoot = marker.releaseRoot;
        }
        repositories.push({
          source: "registered_workspace",
          workspaceId: registeredRoot.workspaceId,
          registrationSource: registeredRoot.registrationSource,
          repositoryKey: layout.repositoryKey,
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
