import { spawn } from "node:child_process";
import { preparationIsolationLayout, assertPlainIsolationPath, withPreparationGitIsolation, preparationGitInvocation, preparationGitIsolationActive, guardedPreparationGit, preparationObjectStore, assertPreparationProcessOwned } from "./preparation-git-isolation.mjs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseCandidateFrozenError } from "../../domain/task-board-task.mjs";
import { TaskPreparationRejectedError } from "../../domain/task-preparation-error.mjs";
import { assertPreparationCheckpoint } from "./release-preparation-guard.mjs";
import { createSelectedGitBundle } from "./selected-git-bundle.mjs";
import { runOwnedGit, TaskGitWorkspaceService } from "./task-git-workspace.mjs";
import { readOwnGitPublicationOrigin } from "../persistence/task-publication-history.mjs";
import { assertInstalledLocalSourceBaseline, installedNativeHistoryBaseline, publishedMetadataContext, assertInstalledAgreedMainOrigin, assertOwnGitPublicationOrigin, assertHistoricalChangelog } from "./local-source-baseline.mjs";
import { readNativeUpstreamAdoptions, assertNativeUpstreamOrigin } from "./native-upstream-adoption.mjs";
import { inspectPublishedNotesArchive, archivePublishedNotesCheckout } from "./native-await-published-notes-recovery.mjs";
import { defaultRuntimeRoot } from "./runtime-layout.mjs";
import process from "node:process";
import { assertContourExternalEffects, assertContourGitAvailable } from "../../ports/contour-external-effects.mjs";

import { taskRepositoryKey, taskGitIdentityHash } from "../../domain/task-git-reference.mjs";
import { assertReleaseBaseProvenance, NATIVE_MAIN_PROVENANCE, LOCAL_SOURCE_BASELINE_PROVENANCE, normalizedReleaseBaseProvenance } from "../../domain/release-base-provenance.mjs";
import { normalizedTaskSquashTransfer } from "../../domain/task-squash-transfer.mjs";
import { selectedCompositionFields } from "../../domain/task-selected-composition.mjs";
import { canonicalPath } from "./config.mjs";
import { withInterprocessLocks, interprocessLockAdmissionTimeoutPath } from "../process/interprocess-lock.mjs";
import { measureTaskOperation, recordTaskOperationTiming } from "../process/task-operation-timing.mjs";
import { publicationStateFile, publicationStateRepositories, readPublicationState } from "../persistence/publication-state.mjs";
import { assertNativeTaskHistories, assertNativePreparedComposition, mergeSelectedResults, NATIVE_RELEASE_POLICY } from "./native-release-merge.mjs";

const RELEASE_MARKER = "agent-hub-release-clone.json";
const RELEASE_BRANCH = "PreRelease";
// Both layers report an unknown Await outcome: this module owns the candidate
// restore, the lifecycle owns the Task CAS readback.
const AWAIT_UNKNOWN_OUTCOME_CODES = new Set([
  "AWAIT_PREPARATION_UNKNOWN",
  "AWAIT_ACCEPTANCE_UNKNOWN",
]);


function runGit(args, options = {}) {
  return measureTaskOperation("release:git-command", () => runGitUnmeasured(args, options), { detail: true });
}

function runGitUnmeasured(args, { cwd, timeoutMs = null, rawOutput = false, acceptableExitCodes = [], input = null, stdoutFd = null } = {}) {
  if (stdoutFd !== null && (!Number.isSafeInteger(stdoutFd) || stdoutFd < 3)) throw new TypeError("Invalid owned Git output descriptor");
  const guarded = guardedPreparationGit(lease => {
    const invocation = preparationGitInvocation(args, cwd);
    // runOwnedGit merges its environment with process.env; explicit undefined
    // removes inherited Git keys instead of accidentally reintroducing them.
    const env = { ...Object.fromEntries(Object.keys(process.env).filter(key => /^GIT_/iu.test(key))
      .map(key => [key, undefined])), ...invocation.env };
    return runOwnedGit(invocation.args, { lease, cwd, timeoutMs, rawOutput, acceptableExitCodes, input, stdoutFd, env });
  });
  if (guarded) return guarded;
  return new Promise((resolve, reject) => {
    const invocation = preparationGitInvocation(args, cwd);
    const child = spawn("git", invocation.args, { cwd, ...(invocation.env ? { env: invocation.env } : {}),
      windowsHide: true, stdio: [input == null ? "ignore" : "pipe", stdoutFd ?? "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = timeoutMs == null ? null : setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
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
      if (code === 0 || acceptableExitCodes.includes(code)) resolve(output);
      else reject(new Error(errorText || `git ${args[0]} exited with ${code}`));
    });
    if (input != null) child.stdin.end(input);
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

async function dirtyState(root) {
  const [status, indexEntries] = await Promise.all([
    runGit(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all",
      "--ignore-submodules=none", "--no-renames"], { cwd: root }),
    runGit(["ls-files", "--stage", "-z"], { cwd: root }),
  ]);
  // Preserve the existing path/fingerprint format for dirty or unmerged
  // primary checkouts. Nothing has to be enumerated again on a clean checkout.
  const changed = status ? await Promise.all([
    runGit(["diff", "--name-only", "-z", "--"], { cwd: root }),
    runGit(["diff", "--cached", "--name-only", "-z", "--"], { cwd: root }),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root }),
  ]) : [];
  const paths = [...new Set(changed.flatMap(value => value.split("\0").filter(Boolean)))].sort();
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
  const [revisions, commonDir, worktrees, dirty] = await Promise.all([
    // --not marks main independently of HEAD, including when main is absent.
    // Only OIDs/ref names are batched: rev-parse does not quote path outputs.
    runGit(["rev-parse", "--revs-only", "HEAD^{commit}", "--not",
      "refs/heads/main^{commit}", "--not", "--symbolic-full-name", "HEAD"], { cwd: root }),
    gitCommonDir(root),
    runGit(["worktree", "list", "--porcelain"], { cwd: root }),
    dirtyState(root),
  ]);
  const fields = revisions.split("\n");
  const headCommit = fields.shift();
  const main = fields[0]?.startsWith("^") ? fields.shift() : null;
  const branch = fields.shift();
  const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
  if (!oid.test(headCommit ?? "") || fields.length
      || !(branch === undefined || branch === "HEAD" || branch.startsWith("refs/"))
      || (main !== null && (!main.startsWith("^") || !oid.test(main.slice(1))))) {
    throw new Error("Cannot resolve the primary HEAD/main revisions");
  }
  // An absent main stops rev-parse's option parsing; an ambiguous HEAD name
  // can omit its symbolic form. Preserve symbolic-ref's own semantics there,
  // including recursive refs and a genuinely detached HEAD.
  const branchRef = branch === undefined || branch === "HEAD"
    ? await gitMaybe(["symbolic-ref", "--quiet", "HEAD"], { cwd: root }) : branch;
  const mainCommit = main === null ? null : main.slice(1);
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

function recoveryDigest(value) {
  return sha256(`${JSON.stringify(stableValue(value))}\n`);
}

const PUBLICATION_TERMINAL_STATUSES = new Set(["succeeded", "published", "failed", "interrupted"]);
const FREEZING_RECOVERY_MODE = "abandon-freezing-candidate-v1";
const FAILED_FROZEN_RECOVERY_MODE = "abandon-failed-frozen-candidate-v1";

function parseRecoveryJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`publication freeze recovery ${label} is not valid JSON`);
  }
}

const normalizedBaseProvenance = normalizedReleaseBaseProvenance;

// Independent freeze defense, checked under the release and repository locks
// before any freeze effect: an advanced base is frozen only with the same
// immutable provenance in its manifest and checkpoint. A later preflight
// receipt cannot retroactively repair a candidate that lacks it.
async function durablePublishedRevision(environment, primaryRoot) {
  const state = await readPublicationState(publicationStateFile(environment));
  const entry = publicationStateRepositories(state ?? {}).find((item) => samePath(item.root, primaryRoot));
  return entry?.revision ?? null;
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

async function revisionList(root, args) {
  const output = String(await runGit(["rev-list", "--reverse", "--topo-order", ...args], { cwd: root }));
  return output.split(/\r?\n/u).filter(Boolean);
}

function normalizedFrozenTasks(tasks = []) {
  const unique = new Map();
  for (const task of tasks) {
    const taskId = String(task?.taskId ?? "").trim();
    const taskRevision = Number(task?.taskRevision);
    const resultReleaseRevision = task?.resultReleaseRevision == null
      ? null
      : Number(task.resultReleaseRevision);
    const baseCommit = String(task?.baseCommit ?? "").trim();
    const resultCommit = String(task?.resultCommit ?? "").trim();
    if (!taskId || !Number.isInteger(taskRevision) || taskRevision < 1 || !resultCommit) {
      throw new Error("release candidate requires exact Task IDs, revisions and result commits");
    }
    if (resultReleaseRevision != null
        && (!Number.isInteger(resultReleaseRevision) || resultReleaseRevision < 1)) {
      throw new Error(`release Task ${taskId} has an invalid result release revision`);
    }
    if (baseCommit && !/^[0-9a-f]{40}$/u.test(baseCommit)) {
      throw new Error(`release Task ${taskId} has an invalid base commit`);
    }
    const integrations = (Array.isArray(task?.integrations) ? task.integrations : []).map((integration) => ({
      commit: String(integration?.commit ?? "").trim(),
      parent: String(integration?.parent ?? "").trim(),
      order: Number(integration?.order),
    }));
    if (integrations.some((integration) => (
      !integration.commit || !integration.parent || !Number.isInteger(integration.order) || integration.order < 0
    ))) throw new Error(`release Task ${taskId} has invalid dev integration evidence`);
    const normalized = {
      taskId, taskRevision,
      ...(resultReleaseRevision != null ? { resultReleaseRevision } : {}),
      ...(baseCommit ? { baseCommit } : {}), resultCommit, integrations,
      ...selectedCompositionFields(task),
      ...(task?.squashTransfer ? {
        squashTransfer: normalizedTaskSquashTransfer(task.squashTransfer),
      } : {}),
    };
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

function assertPrimarySnapshot(snapshot, phase) {
  const failure = primaryInvariantFailure(snapshot, phase);
  if (failure) throw new Error(failure);
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

const SUPPLEMENTAL_PROVENANCE_KIND = "supplemental-reviewed-adoption-v1";
const MISSING_PROVENANCE_RECOVERY_KIND = "missing-provenance-recovery-v1";

async function withPreparationCleanup(root, operation) {
  const before = await lstat(root);
  let result, original;
  try { result = await operation(); } catch (error) { original = error; }
  try {
    await assertPreparationProcessOwned();
    const current = await lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() || before.dev !== current.dev
        || before.ino !== current.ino || before.birthtimeMs !== current.birthtimeMs) throw new Error("Invocation cleanup root changed; retained");
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (cleanup) {
    if (original) throw new AggregateError([original, cleanup], "Preparation and owned cleanup failed", { cause: original });
    throw cleanup;
  }
  if (original) throw original;
  return result;
}

export class TaskIntegrationGitService {
  #contourExternalEffects;
  #environment;
  #validationBundle = null;
  #validationReferenceRoot = null;
  #isolationContext = null;
  #readPreparationAuthority;
  #readPreparationOriginal;
  #publicationDataDir;

  #repositoryOwner;
  #ownedInputs = [];

  constructor({
    dataDir, contourExternalEffects = null, environment = process.env,
    readPreparationAuthority = () => null,
    readPreparationOriginal = () => null,
  } = {}) {
    this.#contourExternalEffects = assertContourExternalEffects(contourExternalEffects);
    this.#environment = environment;
    this.#readPreparationAuthority = readPreparationAuthority;
    this.#readPreparationOriginal = readPreparationOriginal;
    this.dataDir = canonicalPath(String(dataDir ?? ""));
    this.#publicationDataDir = this.dataDir;
    this.#repositoryOwner = new TaskGitWorkspaceService({ dataDir: this.dataDir, contourExternalEffects });
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
    assertPrimarySnapshot(snapshot, phase);
    return publicPrimaryEvidence(snapshot);
  }

  async withAwaitTransition(workspaceId, operation) {
    this.#assertAvailable("withAwaitTransition");
    if (typeof operation !== "function") throw new TypeError("Await transition operation is required");
    const identity = sha256(String(workspaceId ?? "").trim()).slice(0, 24);
    const lock = path.join(this.dataDir, "locks", `release-await-${identity}`);
    return measureTaskOperation("release:await-boundary", () => withInterprocessLocks([lock],
      lease => measureTaskOperation("release:await-owned", () => operation(lease)), {
        onAcquired: metadata => recordTaskOperationTiming("release:await-acquired", metadata),
      }));
  }

  awaitTransitionAdmissionNoEffect(workspaceId, error) {
    const identity = sha256(String(workspaceId ?? "").trim()).slice(0, 24);
    const lockPath = path.join(this.dataDir, "locks", `release-await-${identity}.lock`);
    return interprocessLockAdmissionTimeoutPath(error) === lockPath
      ? { kind: "release-await-lock-admission-v1", workspaceId, lockPath } : null;
  }

  async inspectMainChanges({
    projectRoot, publishedRevision, approvedLocalMainCommit = null, approvedOriginMainCommit = null,
  } = {}) {
    this.#assertAvailable("inspectMainChanges");
    if (!preparationObjectStore()) {
      const sourceRoot = await repositoryRoot(projectRoot);
      return this.#repositoryOwner.withNativeRepositoryOwner({ sourceRoot,
        repositoryRoot: this.#layout(sourceRoot).releaseRoot }, ({ lease, objects }) =>
        withPreparationGitIsolation(this.dataDir, () => this.inspectMainChanges({ projectRoot,
          publishedRevision, approvedLocalMainCommit, approvedOriginMainCommit }), lease, objects));
    }
    const authority = this.#readPreparationAuthority(canonicalPath(projectRoot));
    if (authority && !preparationGitIsolationActive()) return withPreparationGitIsolation(authority.isolation.dataDir,
      () => this.inspectMainChanges({ projectRoot, publishedRevision, approvedLocalMainCommit, approvedOriginMainCommit }));
    const baseline = String(publishedRevision ?? "").trim();
    if (!baseline) throw new Error("main review requires the last published revision");
    // Fixed phases survive the shared detail budget without recording Git args,
    // repository paths, commit metadata or credentials. Lock includes waiting;
    // owned begins only after acquisition, so the intervals remain separable.
    const measured = (phase, operation, metadata = {}) =>
      measureTaskOperation(`release:main-review:${phase}`, operation, metadata);
    const primary = await measured("primary", () => primarySnapshot(projectRoot));
    assertPrimarySnapshot(primary, "main review");
    const layout = this.#layout(primary.root);
    const lock = path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`);
    return measured("lock", () => withInterprocessLocks([lock], () => measured("owned", async () => {
      const clone = await measured("clone", () => this.#ensureClone(primary));
      const workspace = authority?.phase === "completed" ? primary.root : "workspace";
      await measured("workspace-fetch", () => runGit(["fetch", workspace, "+refs/heads/main:refs/remotes/workspace/main"], {
        cwd: clone.releaseRoot,
        timeoutMs: null,
      }));
      await measured("origin-fetch", () => runGit(["fetch", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
        cwd: clone.releaseRoot,
        timeoutMs: null,
      }));
      if (await measured("baseline-check", () => gitMaybe(["cat-file", "-e", `${baseline}^{commit}`], { cwd: clone.releaseRoot })) === null) {
        await measured("baseline-fetch", () => runGit(["fetch", workspace, baseline], { cwd: clone.releaseRoot, timeoutMs: null }));
      }
      const localMain = primary.mainCommit;
      const originMain = await runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: clone.releaseRoot });
      const { localContainsPublished, publishedContainsLocal, originContainsPublished } = await measured("ancestry", async () => {
      const localContainsPublished = await gitMaybe(["merge-base", "--is-ancestor", baseline, localMain], {
        cwd: clone.releaseRoot,
      }) !== null;
      const publishedContainsLocal = await gitMaybe(["merge-base", "--is-ancestor", localMain, baseline], {
        cwd: clone.releaseRoot,
      }) !== null;
      if (!localContainsPublished && !publishedContainsLocal) {
        throw new Error(`last published revision ${baseline} is unrelated to local main ${localMain}`);
      }
      const originContainsPublished = await gitMaybe(["merge-base", "--is-ancestor", baseline, originMain], {
        cwd: clone.releaseRoot,
      }) !== null;
      if (!originContainsPublished) {
        throw new Error(`last published revision ${baseline} is not an ancestor of origin/main ${originMain}`);
      }
      return { localContainsPublished, publishedContainsLocal, originContainsPublished };
      });
      const commitIds = await measured("revision-list", async () => new Set([
        ...(localContainsPublished ? await revisionList(clone.releaseRoot, [localMain, `^${baseline}`]) : []),
        ...await revisionList(clone.releaseRoot, [originMain, `^${baseline}`]),
        ...(!localContainsPublished && publishedContainsLocal
          ? await revisionList(clone.releaseRoot, [baseline, `^${localMain}`])
          : []),
      ]));
      const commits = await measured("disclosures", async () => {
        const commits = [];
        for (const commit of commitIds) commits.push(await disclosedCommit(clone.releaseRoot, commit, {
          localMain,
          originMain,
        }));
        return commits;
      }, { commitCount: commitIds.size });
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
        localContainsPublished,
        publishedContainsLocal,
        originContainsPublished,
        approved,
        approvalRequired: (commits.length > 0 || localMain !== originMain) && !approved,
      };
      const finalPrimary = await measured("final-primary", () => primarySnapshot(primary.root));
      assertPrimarySnapshot(finalPrimary, "main review");
      if (
        finalPrimary.headCommit !== primary.headCommit
        || finalPrimary.mainCommit !== primary.mainCommit
        || finalPrimary.branchRef !== primary.branchRef
        || finalPrimary.dirty.indexFingerprint !== primary.dirty.indexFingerprint
      ) {
        throw new Error("registered primary Workspace changed during main review");
      }
      return audit;
    })));
  }

  #layout(primaryRoot) {
    const repositoryKey = taskRepositoryKey(primaryRoot);
    const authority = this.#readPreparationAuthority(primaryRoot);
    let storage = this.releaseRepositoriesRoot;
    if (authority) {
      const expected = preparationIsolationLayout(this.dataDir, primaryRoot, authority.requestId, authority.argumentsHash);
      if (authority.isolation?.dataDir !== expected.dataDir || authority.isolation.projectRoot !== primaryRoot
          || authority.isolation.key !== expected.key) throw new Error("Preparation candidate routing identity changed");
      storage = path.join(expected.dataDir, "release-repositories");
    }
    const root = path.join(storage, repositoryKey);
    return {
      repositoryKey,
      root,
      releaseRoot: path.join(root, "repository"),
      evidenceRoot: path.join(root, "evidence"),
      checkpointFile: path.join(root, "checkpoint.json"),
    };
  }

  async #ensureClone(primary, inputs = this.#ownedInputs) {
    const layout = this.#layout(primary.root);
    const authority = this.#readPreparationAuthority(primary.root);
    const allowedStorage = authority ? path.join(authority.isolation.dataDir, "release-repositories") : this.releaseRepositoriesRoot;
    if (!pathInside(allowedStorage, layout.releaseRoot)) {
      throw new Error("release clone escaped its Agent Hub-owned root");
    }
    const gitFile = path.join(layout.releaseRoot, ".git");
    let created = false, objectStorage = null;
    if (!await fileExists(gitFile) && !await stat(gitFile).catch(() => null)) {
      if (authority) throw new Error("Registered isolated candidate is missing; preserve its original recovery");
      const upstream = await gitMaybe(["remote", "get-url", "origin"], { cwd: primary.root });
      if (!upstream) throw new Error(`release repository has no origin remote: ${primary.root}`);
      await mkdir(layout.root, { recursive: true });
      const sourceRoot = this.#validationReferenceRoot ?? primary.root;
      const objects = preparationObjectStore();
      if (!objects) throw new Error("Release object provisioning requires its guarded repository owner");
      if (this.#validationBundle) {
        // A retained legacy generation keeps its original transport identity.
        await runGit(["clone", "--single-branch", "--branch", "main", "--no-local", "--no-hardlinks",
          "--no-checkout", this.#validationBundle, layout.releaseRoot], { cwd: layout.root, timeoutMs: null });
        await runGit(["remote", "rename", "origin", "workspace"], { cwd: layout.releaseRoot });
      } else {
        const required = [...new Set([primary.mainCommit, ...inputs].filter(Boolean))];
        const identityHash = taskGitIdentityHash({ kind: "release-input-clone-v1", repository: layout.releaseRoot,
          sourceRoot, inputs: required });
        const storage = await objects.provision({ sourceRoot, repository: layout.releaseRoot,
          inputs: required, identityHash });
        await objects.assertConsumer({ repository: layout.releaseRoot, inputs: required, identityHash, storage });
        objectStorage = { inputs: required, identityHash, storage };
        await runGit(["update-ref", "refs/heads/main", primary.mainCommit, "0".repeat(40)], { cwd: layout.releaseRoot });
        await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: layout.releaseRoot });
        await runGit(["remote", "add", "workspace", sourceRoot], { cwd: layout.releaseRoot });
      }
      await runGit(["config", "core.longpaths", "true"], { cwd: layout.releaseRoot });
      if (this.#isolationContext) {
        for (const [key, value] of [["core.hooksPath", path.join(this.dataDir, "empty-hooks")],
          ["core.fsmonitor", "false"], ["gc.auto", "0"], ["maintenance.auto", "false"]]) {
          await runGit(["config", key, value], { cwd: layout.releaseRoot });
        }
      }
      created = true;
      await runGit(["remote", "add", "origin", upstream], { cwd: layout.releaseRoot });
      if (this.#isolationContext) {
        await runGit(["update-ref", "refs/remotes/origin/main", this.#isolationContext.originMainCommit,
          "0".repeat(40)], { cwd: layout.releaseRoot });
      } else await runGit(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
        cwd: layout.releaseRoot,
        timeoutMs: null,
      });
      await runGit(["checkout", "--no-overwrite-ignore", "main"], { cwd: layout.releaseRoot });
      if (await runGit(["rev-parse", "HEAD^{commit}"], { cwd: layout.releaseRoot }) !== primary.mainCommit) {
        throw new Error("Initial release checkout does not match the agreed main");
      }
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
    objectStorage ??= existingMarker?.objectStorage ?? null;
    if (objectStorage) await preparationObjectStore().assertConsumer({ repository: releaseRoot, ...objectStorage });
    const marker = {
      schemaVersion: 1,
      ...(objectStorage ? { objectStorage } : {}),
      kind: "agent-hub-owned-release-clone",
      managedRoot: path.dirname(layout.root),
      primaryRoot: primary.root,
      primaryGitCommonDir: primary.commonDir,
      releaseRoot,
      releaseGitCommonDir: releaseCommonDir,
    };
    await writeJsonAtomic(markerFile, marker);
    return { ...layout, ...marker, markerFile };
  }

  // Revalidate an exact prepared native result, including its accepted resolutions.
  // Otherwise use the ordinary composer in a disposable owned repository.
  // No live candidate/checkpoint is promoted or rolled back.
  // The application owner holds Await/Task/dev leases and revalidates identities.
  async validateCandidate({
    planRevision, projectRoot, workspaceId = null, frozenTasks = [],
    approvedBaseCommit = null, baseProvenance = null, validateBeforeCommit = null, commitPrepared = null,
  } = {}) {
    this.#assertAvailable("validateCandidate");
    if (commitPrepared != null) throw new Error("Composition validation cannot commit Task acceptance");
    const checkpoint = await readJson(this.#layout(projectRoot).checkpointFile);
    if (checkpoint?.phase === "prepared" && checkpoint.planRevision === planRevision
        && checkpoint.baseCommit === approvedBaseCommit) {
      const input = { projectRoot, workspaceId, planRevision, frozenTasks, approvedBaseCommit,
        baseProvenance, exactBaseProvenance: true };
      const verificationRoot = await mkdtemp(path.join(os.tmpdir(), "ah-composition-"));
      return withPreparationCleanup(verificationRoot, async () => {
        if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
        const prepared = await measureTaskOperation("release:prepared-source", async () => this.#preparedGenerationSource({ ...input,
          verificationRoot: path.join(verificationRoot, "before") }));
        if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
        const current = await measureTaskOperation("release:prepared-source", async () => this.#preparedGenerationSource({ ...input,
          verificationRoot: path.join(verificationRoot, "after") }));
        if (stableManifest(current.binding) !== stableManifest(prepared.binding)) {
          throw new Error("Prepared composition changed during validation");
        }
        if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
        return { status: "validated", repositoryRoot: current.candidate.repositoryRoot,
          planRevision, baseCommit: current.candidate.baseCommit, tree: current.candidate.tree,
          taskIds: current.candidate.frozenTasks.map(task => task.taskId).sort(),
          mergedTaskIds: current.candidate.mergedTaskIds };
      });
    }
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ah-composition-"));
    return withPreparationCleanup(temporaryRoot, async () => {
      const isolated = new TaskIntegrationGitService({
        dataDir: temporaryRoot, contourExternalEffects: this.#contourExternalEffects,
        environment: this.#environment,
      });
      isolated.#publicationDataDir = this.#publicationDataDir;
      isolated.#repositoryOwner = this.#repositoryOwner;
      const candidate = await isolated.prepareCandidate({
        planRevision, projectRoot, workspaceId, frozenTasks, approvedBaseCommit, baseProvenance,
        validateBeforeCommit,
      });
      const tree = await runGit(["rev-parse", `${candidate.preReleaseHead}^{tree}`], { cwd: candidate.releaseRoot });
      // Recheck after the final read as well; callers must not close a Task from
      // a result whose selection or approved base changed during validation.
      if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
      return {
        status: "validated", repositoryRoot: candidate.repositoryRoot,
        planRevision, baseCommit: candidate.baseCommit, tree,
        taskIds: candidate.frozenTasks.map((task) => task.taskId).sort(),
        mergedTaskIds: candidate.mergedTaskIds,
      };
    });
  }

  async #preparedGenerationSource({ projectRoot, workspaceId, planRevision, frozenTasks, approvedBaseCommit, baseProvenance, changelogContent, releaseVersion, expectedRuntimeVersion,
    exactBaseProvenance = false, verificationRoot = null }) {
    const layout = this.#layout(projectRoot);
    const stale = message => Object.assign(new Error(`${message}; prepare the current Await candidate through the normal owner`),
      { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
    return measureTaskOperation("release:prepared-source-lock", () => withInterprocessLocks([path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`)], async () => {
      const source = await this.frozenCandidate(projectRoot, { changelogContent }).catch(error => { throw stale(error.message); });
      const manifest = JSON.parse(await readFile(source.manifestFile, "utf8"));
      try {
        assertReleaseBaseProvenance({ publishedBaseCommit: await durablePublishedRevision(this.#environment, projectRoot),
          baseCommit: source.baseCommit, provenance: normalizedBaseProvenance(manifest.baseProvenance, source.baseCommit),
          phase: "PUBLIC prepared generation" });
      } catch (error) { throw stale(error.message); }
      const tasks = normalizedFrozenTasks(frozenTasks);
      if (source.checkpointPhase !== "prepared" || manifest.compositionPolicy !== NATIVE_RELEASE_POLICY
          || source.planRevision !== planRevision || source.baseCommit !== approvedBaseCommit
          || String(manifest.workspaceId ?? "") !== String(workspaceId ?? "")
          || stableManifest(normalizedFrozenTasks(manifest.tasks)) !== stableManifest(tasks)
          || (exactBaseProvenance && stableManifest(normalizedBaseProvenance(manifest.baseProvenance, source.baseCommit))
            !== stableManifest(normalizedBaseProvenance(baseProvenance, approvedBaseCommit)))
          || (manifest.baseProvenance?.publishedBaseCommit ?? null) !== (baseProvenance?.publishedBaseCommit ?? null)
          || ([manifest.baseProvenance?.kind, baseProvenance?.kind].includes(LOCAL_SOURCE_BASELINE_PROVENANCE)
            && stableManifest(manifest.baseProvenance) !== stableManifest(baseProvenance))) {
        throw stale("Prepared PreRelease selection, base or evidence is stale");
      }
      const verify = async verificationRepository => {
      const git = (args, options = {}) => runGit(args, { ...options, cwd: verificationRepository });
      const historyAuthority = await this.#nativeHistoryAuthority({ projectRoot, provenance: manifest.baseProvenance,
        planRevision, tasks });
      await assertNativePreparedComposition({ git, baseCommit: source.baseCommit, tasks,
        historyAuthority,
        merges: manifest.merges, head: source.preReleaseHead, tree: source.tree,
        identity: { policy: NATIVE_RELEASE_POLICY, workspaceId, planRevision, baseCommit: source.baseCommit, tasks },
        });
      if (historyAuthority?.adoptions.length) await assertNativeUpstreamOrigin({
        git: (args, options = {}) => runGit(args, { ...options, cwd: projectRoot }),
        adoptions: historyAuthority.adoptions, originCommit: manifest.baseProvenance.approvedOriginMainCommit });
      else if (manifest.baseProvenance?.ownGitPublication) await assertOwnGitPublicationOrigin({
        provenance: manifest.baseProvenance, repositoryRoot: projectRoot, tasks,
        readOwnGitPublication: input => readOwnGitPublicationOrigin({ dataDir: this.#publicationDataDir, ...input }),
        git: (args, options = {}) => runGit(args, { ...options, cwd: projectRoot }) });
      else if (manifest.baseProvenance?.adoptions) await assertInstalledAgreedMainOrigin({
        provenance: manifest.baseProvenance,
        git: (args, options = {}) => runGit(args, { ...options, cwd: projectRoot }) });
      const binding = { kind: "native-prepared-release-v1", releaseRoot: source.releaseRoot,
        commit: source.preReleaseHead, tree: source.tree, manifestHash: source.manifestHash,
        checkpointSha256: sha256(await readFile(source.checkpointFile)),
        inputHash: sha256(stableManifest({ workspaceId, planRevision, approvedBaseCommit, tasks, baseProvenance,
          changelogHash: changelogContent === undefined ? "prepared" : changelogContent === null ? null : sha256(Buffer.from(changelogContent)),
          ...(releaseVersion !== undefined ? { releaseVersion } : {}),
          ...(expectedRuntimeVersion !== undefined ? { expectedRuntimeVersion } : {}) })) };
      return { binding, candidate: { ...source, baseProvenance, frozenTasks: tasks,
        mergedTaskIds: tasks.map(task => task.taskId),
        manifest: { ...manifest, ...(baseProvenance ? { baseProvenance } : {}), preparedCandidate: binding } } };
      };
      if (!verificationRoot) return verify(source.releaseRoot);
      return this.#repositoryOwner.withNativeRepositoryOwner({ sourceRoot: source.releaseRoot,
        repositoryRoot: verificationRoot }, ({ lease, objects }) =>
        withPreparationGitIsolation(this.dataDir, () => objects.withInputMath({ sourceRoot: source.releaseRoot,
          inputs: [source.baseCommit, source.preReleaseHead, ...tasks.map(task => task.resultCommit)] },
          ({ repository }) => verify(repository)), lease, objects));
    }, { onAcquired: metadata => recordTaskOperationTiming("release:git-acquired", metadata) }));
  }

  async #nativeCutover(clone, checkpoint) {
    return measureTaskOperation("native:cutover", async () => {
    if (!checkpoint) return null;
    const bytes = await readFile(clone.checkpointFile);
    const manifestBytes = await readFile(checkpoint.manifestFile);
    if (sha256(manifestBytes) !== checkpoint.manifestHash) throw new Error("Cutover manifest digest changed");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.compositionPolicy === NATIVE_RELEASE_POLICY) return manifest.cutover ?? null;
    const head = checkpoint.preReleaseHead;
    const current = await runGit(["rev-parse", `refs/heads/${RELEASE_BRANCH}^{commit}`], { cwd: clone.releaseRoot });
    const journal = await readJson(path.join(clone.root, "native-preparation.json"));
    const exactOriginalInFlight = journal?.version === 1 && journal.policy === NATIVE_RELEASE_POLICY
      && !["completed", "rolled_back"].includes(journal.phase) && journal.target === current
      && journal.before?.branch === head
      && journal.before?.checkpointBytes === bytes.toString("base64");
    let abandonedRecovery = null;
    if (checkpoint.phase === "abandoned" && checkpoint.recovery?.outcome?.status === "abandoned") {
      const recovery = checkpoint.recovery, identity = recovery.identity;
      const evidenceFile = String(recovery.evidenceFile ?? "");
      if (!pathInside(clone.evidenceRoot, evidenceFile)) throw new Error("Cutover recovery evidence path changed");
      const stat = await lstat(evidenceFile), evidenceBytes = await readFile(evidenceFile);
      const evidence = parseRecoveryJson(evidenceBytes, "cutover recovery evidence");
      if (!stat.isFile() || stat.isSymbolicLink() || sha256(evidenceBytes) !== recovery.evidenceSha256
          || stableManifest(evidence) !== evidenceBytes.toString("utf8")
          || recoveryDigest(identity) !== recovery.proofHash || evidence.proofHash !== recovery.proofHash
          || recovery.outcome.proofHash !== recovery.proofHash
          || recovery.outcome.operationId !== recovery.operationId
          || Object.entries(identity).some(([key, value]) => JSON.stringify(evidence[key]) !== JSON.stringify(value))
          || identity.frozenHead !== head || identity.manifestHash !== checkpoint.manifestHash
          || identity.sourceManifestSha256 !== sha256(manifestBytes)
          || sha256(Buffer.from(evidence.sourceCheckpointBytesBase64 ?? "", "base64")) !== identity.sourceCheckpointSha256
          || sha256(Buffer.from(evidence.sourceManifestBytesBase64 ?? "", "base64")) !== identity.sourceManifestSha256
          || identity.oldPreRelease !== current) throw new Error("Cutover completed recovery identity changed");
      abandonedRecovery = { evidenceSha256: recovery.evidenceSha256,
        evidenceBytesBase64: evidenceBytes.toString("base64"), preparedHead: current };
    }
    if (!/^[a-f0-9]{40}$/u.test(String(head)) || (current !== head && !exactOriginalInFlight && !abandonedRecovery)) {
      throw new Error("Cutover requires the exact historical candidate ref");
    }
    const digest = sha256(bytes);
    const ref = `refs/agent-hub/release-cutovers/${digest}`;
    const prior = await gitMaybe(["rev-parse", `${ref}^{commit}`], { cwd: clone.releaseRoot });
    if (prior && prior !== head) throw new Error("Cutover retained ref changed");
    if (!prior) await runGit(["update-ref", ref, head, "0".repeat(40)], { cwd: clone.releaseRoot });
    return {
      version: 1, kind: "original-main-results-native-cutover-v1", retainedRef: ref,
      head, tree: await runGit(["rev-parse", `${head}^{tree}`], { cwd: clone.releaseRoot }),
      checkpointSha256: digest, checkpointBytesBase64: bytes.toString("base64"),
      manifestSha256: checkpoint.manifestHash, manifestBytesBase64: manifestBytes.toString("base64"),
      ...(abandonedRecovery ? { abandonedRecovery } : {}),
      // Each exact result still passes the bounded native-history admission.
      // This envelope preserves history; it grants no merge-side exception.
      originalTasks: manifest.tasks,
    };
    });
  }

  async deriveInstalledLocalSourceBaselineForSelection({ projectRoot, planRevision, tasks,
    publishedRevision, adoptions = [] } = {}) {
    this.#assertAvailable("deriveInstalledLocalSourceBaselineForSelection");
    const initial = await primarySnapshot(projectRoot);
    this.#assertAvailable("assertPrimaryInvariant");
    assertPrimarySnapshot(initial, "ordinary Await installed source binding");
    if (publishedRevision !== await durablePublishedRevision(this.#environment, initial.root)) {
      throw new Error("Ordinary Await published baseline changed");
    }
    const git = (args, options = {}) => runGit(args, { ...options, cwd: initial.root, timeoutMs: null });
    const actual = await readNativeUpstreamAdoptions({ git, tasks, repositoryRoot: initial.root,
      localMainCommit: initial.mainCommit });
    const pins = actual.map(({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit }) =>
      ({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit }));
    if (JSON.stringify(pins) !== JSON.stringify(adoptions)) {
      throw new Error("Ordinary Await selected adoption evidence changed");
    }
    const provenance = await installedNativeHistoryBaseline({ git,
      sourceGit: (cwd, args, options = {}) => runGit(args, { ...options, cwd, timeoutMs: null }),
      repositoryRoot: initial.root, primaryMainCommit: initial.mainCommit, publishedRevision,
      runtimeRoot: defaultRuntimeRoot({ environment: this.#environment }), planRevision, tasks, adoptions: actual,
      readOwnGitPublication: input => readOwnGitPublicationOrigin({ dataDir: this.#publicationDataDir, ...input }) });
    if (!provenance && pins.length) throw new Error("Ordinary adopted Await has no verified installed source baseline");
    return provenance ? { ...provenance, compositionBaseCommit: provenance.ownGitPublication?.commit ?? publishedRevision } : null;
  }

  #historicalChangelogOriginal(provenance) {
    if (!provenance?.historicalChangelog) return null;
    const row = this.#readPreparationOriginal(provenance.historicalChangelog.requestId);
    if (!row || row.toolName !== "hub_release_prepare" || row.status !== "unknown" || row.receiptState !== "unknown"
        || row.operationStatus !== "pending" || row.preparationState?.kind !== "original-preparation-forward-v1") {
      throw new Error("Historical root CHANGELOG original record is unavailable");
    }
    return { requestId: row.requestId, argumentsHash: row.argumentsHash, originalPreparation: row.preparationState.originalPreparation };
  }

  async validateLocalSourceBaseline({ projectRoot, provenance, planRevision, tasks, originalAuthority = null } = {}) {
    this.#assertAvailable("validateLocalSourceBaseline");
    const initial = await primarySnapshot(projectRoot);
    this.#assertAvailable("assertPrimaryInvariant");
    assertPrimarySnapshot(initial, "local source baseline verification");
    return assertInstalledLocalSourceBaseline({ provenance, planRevision, tasks,
      readOwnGitPublication: input => readOwnGitPublicationOrigin({ dataDir: this.#publicationDataDir, ...input }),
      originalAuthority: originalAuthority ?? this.#historicalChangelogOriginal(provenance),
      repositoryRoot: initial.root,
      primaryMainCommit: initial.mainCommit,
      publishedRevision: await durablePublishedRevision(this.#environment, initial.root),
      runtimeRoot: defaultRuntimeRoot({ environment: this.#environment }),
      git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root, timeoutMs: null }),
    });
  }

  async #nativeHistoryAuthority({ projectRoot, provenance, planRevision, tasks, expectedPublishedMetadata = undefined, primary = null }) {
    return measureTaskOperation("native:history-authority", async () => {
    if (provenance?.kind === LOCAL_SOURCE_BASELINE_PROVENANCE) {
      const verified = await this.validateLocalSourceBaseline({ projectRoot, provenance, planRevision, tasks });
      const publicBases = [...new Set([verified.provenance.compositionBaseCommit ?? verified.provenance.sourceBaseCommit,
        ...(verified.provenance.compositionBaseCommit ? [verified.provenance.publishedBaseCommit] : []),
        ...(verified.provenance.ownGitPublication ? [verified.provenance.ownGitPublication.commit] : [])])];
      return { bases: publicBases,
        metadataBases: verified.provenance.compositionBaseCommit ? publicBases : verified.metadataBases,
        ...(verified.changelogEntries ? { changelogEntries: verified.changelogEntries } : {}),
        adoptions: verified.adoptions ?? [] };
    }
    const initial = primary ?? await primarySnapshot(projectRoot);
    const adoptions = await readNativeUpstreamAdoptions({
      git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }), tasks,
      repositoryRoot: initial.root, localMainCommit: initial.mainCommit });
    // New incoming plus an installed carry must be sealed together in the
    // existing exact local-source envelope, not inferred from a moving origin.
    if (adoptions.length) throw new Error("Native adopted history requires its exact installed-source preparation binding");
    if (provenance?.kind !== NATIVE_MAIN_PROVENANCE) return null;
    const publishedMetadata = await publishedMetadataContext({ repositoryRoot: initial.root,
      publication: await readPublicationState(publicationStateFile(this.#environment)),
      git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }) });
    if (!publishedMetadata && expectedPublishedMetadata === undefined) return null;
    if (!publishedMetadata || publishedMetadata.commit !== provenance.publishedBaseCommit
        || (expectedPublishedMetadata !== undefined
          && JSON.stringify(publishedMetadata) !== JSON.stringify(expectedPublishedMetadata))) {
      throw new Error("Native candidate published metadata authority changed");
    }
    return { bases: [publishedMetadata.commit], metadataBases: [publishedMetadata.commit], adoptions: [], publishedMetadata };
    });
  }

  async inspectNativeAwaitRecovery({ projectRoot, original, frozenTasks } = {}) {
    this.#assertAvailable("inspectNativeAwaitRecovery");
    const primary = await primarySnapshot(projectRoot);
    const layout = { ...this.#layout(primary.root), primaryRoot: primary.root };
    return withInterprocessLocks([path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`)], async () => {
      await this.assertPrimaryInvariant(primary.root, { phase: "original native Await inspection" });
      const publishedRevision = await durablePublishedRevision(this.#environment, primary.root);
      if (!publishedRevision) throw new Error("Original Await has no OWN publication");
      const remote = await runGit(["ls-remote", "origin", "refs/heads/main"], { cwd: primary.root });
      const originMainCommit = remote.split(/\s/u)[0];
      if (!/^[a-f0-9]{40}$/u.test(originMainCommit) || (original.originMainCommit
          && original.originMainCommit !== originMainCommit)) throw new Error("Original Await origin pin changed");
      return inspectPublishedNotesArchive({ layout,
        original: original.predecessor ?? { ...original, originMainCommit },
        successor: original.predecessor ? original : null, frozenTasks, publishedRevision,
        gitAt: (cwd, args, options) => runGit(args, { ...options, cwd }),
        assertClone: repositoryRoot => assertReleaseCloneForPublication({ repositoryRoot }), readJson });
    });
  }

  async archivedNativeAwaitOriginal({ projectRoot, operationId } = {}) {
    this.#assertAvailable("archivedNativeAwaitOriginal");
    const primary = await primarySnapshot(projectRoot), layout = this.#layout(primary.root);
    return withInterprocessLocks([path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`)], async () => {
      const journal = await readJson(path.join(layout.root, "native-preparation.json"));
      if (!journal?.publishedNotesArchive) return null;
      if (journal.phase !== "published-notes-archived"
          && (!journal.awaitSuccessor || journal.awaitSuccessor.operationId !== operationId)) return null;
      // Observation only. The lifecycle must prove the old terminal failure;
      // prepareCandidate independently verifies physical archive/current pins.
      return structuredClone(journal.publishedNotesArchive.original);
    });
  }

  async #assertIsolationClone(clone, isolation) {
    await assertPlainIsolationPath(clone.releaseRoot);
    await assertPlainIsolationPath(clone.releaseGitCommonDir);
    if (!samePath(clone.releaseGitCommonDir, path.join(clone.releaseRoot, ".git"))) throw new Error("Isolation candidate is a linked worktree");
    for (const file of ["objects/info/alternates", "objects/info/http-alternates", "commondir"]) {
      const entry = await lstat(path.join(clone.releaseGitCommonDir, file)).catch(error => {
        if (error.code === "ENOENT") return null; throw error;
      });
      if (entry) throw new Error(`Isolated Git object/common store is shared: ${file}`);
    }
    let count = 0;
    const verifyObjects = async root => {
      await assertPlainIsolationPath(root);
      for (const name of await readdir(root)) {
        if (++count > 100000) throw new Error("Isolation object custody inventory exceeds its bound");
        const file = path.join(root, name), entry = await lstat(file);
        if (entry.isSymbolicLink()) throw new Error(`Isolation object path is redirected: ${file}`);
        if (entry.isDirectory()) await verifyObjects(file);
        else if (!entry.isFile() || entry.nlink !== 1) throw new Error(`Isolation object file is shared: ${file}`);
      }
    };
    await verifyObjects(path.join(clone.releaseGitCommonDir, "objects"));
    for (const file of ["config", RELEASE_MARKER]) {
      const entry = await lstat(path.join(clone.releaseGitCommonDir, file));
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error(`Isolated Git control file is shared: ${file}`);
    }
    const git = args => runGit(args, { cwd: clone.releaseRoot });
    const allowed = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|longpaths|hookspath|fsmonitor)|gc\.auto|maintenance\.auto|remote\.(?:workspace|origin)\.(?:url|fetch)|branch\.main\.(?:remote|merge))$/u;
    const keys = String(await git(["config", "--local", "--null", "--name-only", "--list"])).split("\0").filter(Boolean);
    if (keys.some(key => !allowed.test(key))) throw new Error("Isolated Git contains an unowned configuration/helper");
    for (const [key, expected] of [["core.hooksPath", path.join(isolation.dataDir, "empty-hooks")],
      ["core.fsmonitor", "false"], ["gc.auto", "0"], ["maintenance.auto", "false"]]) {
      if (await git(["config", "--local", "--get", key]) !== expected) throw new Error(`Isolated Git configuration changed: ${key}`);
    }
    await assertPlainIsolationPath(path.join(isolation.dataDir, "empty-hooks"));
    if ((await readdir(path.join(isolation.dataDir, "empty-hooks"))).length) throw new Error("Isolation hooks directory changed");
    await git(["fsck", "--full", "--strict"]);
  }

  async #prepareIsolatedCandidate(options, isolation) {
    const expected = preparationIsolationLayout(this.dataDir, canonicalPath(options.projectRoot),
      options.preflightRequestId, options.preparationGuard.argumentsHash);
    if (isolation.key !== expected.key || isolation.dataDir !== expected.dataDir) throw new Error("Isolation candidate owner identity changed");
    await assertPlainIsolationPath(expected.dataDir);
    const isolated = new TaskIntegrationGitService({ dataDir: expected.dataDir,
      contourExternalEffects: this.#contourExternalEffects, environment: this.#environment,
      readPreparationOriginal: this.#readPreparationOriginal,
      });
    isolated.#publicationDataDir = this.#publicationDataDir;
    isolated.#repositoryOwner = this.#repositoryOwner;
    isolated.#isolationContext = isolation;
    const lease = options.forwardPreparation.repositoryLease;
    if (typeof lease?.assertOwned !== "function" || typeof lease?.beginProcessTreeGuard !== "function") {
      throw new Error("Isolated preparation requires its existing repository process guard lease");
    }
    return withPreparationGitIsolation(expected.dataDir, async () => {
      await mkdir(expected.dataDir, { recursive: true });
      for (const name of ["identity.json", "source.bundle", "empty-gitconfig"]) {
        const entry = await lstat(path.join(expected.dataDir, name)).catch(error => {
          if (error.code === "ENOENT") return null; throw error;
        });
        if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)) {
          throw new Error(`Isolation file custody changed: ${name}`);
        }
      }
      const identityFile = path.join(expected.dataDir, "identity.json");
      const identity = await readJson(identityFile);
      if (identity && stableManifest(identity) !== stableManifest(isolation)) throw new Error("Isolated preparation identity changed");
      if (!identity) {
        if ((await readdir(expected.dataDir)).length) throw new Error("Unregistered isolation output requires exact owner readback");
        await writeFile(identityFile, stableManifest(isolation), { flag: "wx" });
      }
      await mkdir(path.join(expected.dataDir, "empty-hooks"), { recursive: true });
      await assertPlainIsolationPath(path.join(expected.dataDir, "empty-hooks"));
      const config = path.join(expected.dataDir, "empty-gitconfig");
      if (!await fileExists(config)) await writeFile(config, "", { flag: "wx" });
      if ((await readFile(config)).length || (await readdir(path.join(expected.dataDir, "empty-hooks"))).length) {
        throw new Error("Isolation Git config/hooks changed");
      }
      const bundle = path.join(expected.dataDir, "source.bundle");
      const main = options.preparationGuard.primaryMainCommit;
      if (!await fileExists(bundle)) await createSelectedGitBundle({ root: expected.dataDir,
        sourceRoot: options.projectRoot, bundle, mainCommit: main,
        inputs: [...new Set([main, isolation.originMainCommit, options.approvedBaseCommit,
          ...options.frozenTasks.map(task => task.resultCommit)])],
        gitAt: (cwd, args, extra) => runGit(args, { ...extra, cwd, timeoutMs: null }) });
      await runGit(["bundle", "verify", bundle], { cwd: options.projectRoot });
      isolated.#validationBundle = bundle;
      const result = await isolated.prepareCandidate(options);
      return result;
    }, lease);
  }

  async prepareCandidate({
    planRevision, projectRoot, workspaceId = null, preflightRequestId = null,
    frozenTasks = [], approvedBaseCommit = null, baseProvenance = null,
    validateBeforeCommit = null, preserveFrozen = false, commitPrepared = null, preparationGuard = null,
    nativeAwaitRecovery = null, forwardPreparation = null,
  } = {}) {
    this.#assertAvailable("prepareCandidate");
    if (!preparationObjectStore()) {
      const sourceRoot = await repositoryRoot(projectRoot);
      return this.#repositoryOwner.withNativeRepositoryOwner({ sourceRoot,
        repositoryRoot: this.#layout(sourceRoot).releaseRoot }, ({ lease, objects }) =>
        withPreparationGitIsolation(this.dataDir, () => this.prepareCandidate({
          planRevision, projectRoot, workspaceId, preflightRequestId, frozenTasks, approvedBaseCommit, baseProvenance,
          validateBeforeCommit, preserveFrozen, commitPrepared, preparationGuard,
          nativeAwaitRecovery, forwardPreparation }), lease, objects));
    }
    const isolation = forwardPreparation?.readIsolation?.();
    if (isolation && !this.#isolationContext) return this.#prepareIsolatedCandidate({
      planRevision, projectRoot, workspaceId, preflightRequestId, frozenTasks, approvedBaseCommit, baseProvenance,
      validateBeforeCommit, preserveFrozen, commitPrepared, preparationGuard,
      nativeAwaitRecovery, forwardPreparation }, isolation);
    const authority = this.#readPreparationAuthority(canonicalPath(projectRoot));
    if (authority && !preparationGitIsolationActive()) return withPreparationGitIsolation(authority.isolation.dataDir,
      () => this.prepareCandidate({ planRevision, projectRoot, workspaceId, preflightRequestId, frozenTasks,
        approvedBaseCommit, baseProvenance, validateBeforeCommit, preserveFrozen, commitPrepared, preparationGuard,
        nativeAwaitRecovery, forwardPreparation }));
    if (authority && authority.phase !== "completed" && preflightRequestId !== authority.requestId) {
      throw new Error("Isolated original preparation still owns this candidate");
    }
    const revision = String(planRevision ?? "").trim();
    const initial = await primarySnapshot(projectRoot);
    assertPrimarySnapshot(initial, "native release preparation");
    const baseCommit = String(approvedBaseCommit ?? "").trim();
    const localSource = baseProvenance?.kind === LOCAL_SOURCE_BASELINE_PROVENANCE
      ? normalizedBaseProvenance(baseProvenance, baseCommit) : null;
    const nativeSource = baseProvenance?.kind === NATIVE_MAIN_PROVENANCE
      ? normalizedBaseProvenance(baseProvenance, baseCommit) : null;
    if (!revision || !/^[a-f0-9]{40}$/u.test(baseCommit)
        || ((localSource ?? nativeSource)?.agreedMainCommit ?? baseCommit) !== initial.mainCommit) {
      throw new Error("native release requires the exact agreed local main and plan revision");
    }
    const published = await durablePublishedRevision(this.#environment, initial.root);
    const provenance = normalizedBaseProvenance(baseProvenance ?? (published ? {
      schemaVersion: 1, kind: NATIVE_MAIN_PROVENANCE,
      publishedBaseCommit: published, agreedMainCommit: baseCommit,
    } : null), baseCommit);
    assertReleaseBaseProvenance({ publishedBaseCommit: published, baseCommit, provenance });
    const tasks = normalizedFrozenTasks(frozenTasks);
    const layout = this.#layout(initial.root);
    const lock = path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`);
    const preparationLockStarted = performance.now();
    return withInterprocessLocks([lock], async () => {
      recordTaskOperationTiming("preparation:candidate-lock-wait", {
        durationMs: performance.now() - preparationLockStarted,
      });
      const validateArchive = async () => {
        if (validateBeforeCommit) await validateBeforeCommit();
        await this.assertPrimaryInvariant(initial.root, { phase: "original Await archive" });
        const current = await primarySnapshot(initial.root);
        const remote = await runGit(["ls-remote", "origin", "refs/heads/main"], { cwd: initial.root });
        if (current.mainCommit !== initial.mainCommit || current.headCommit !== initial.headCommit
            || current.branchRef !== initial.branchRef
            || current.dirty.indexFingerprint !== initial.dirty.indexFingerprint
            || current.dirty.fingerprint !== initial.dirty.fingerprint
            || await durablePublishedRevision(this.#environment, initial.root) !== published
            || remote.split(/\s/u)[0] !== nativeAwaitRecovery.originMainCommit) throw new Error("Original Await archive authority changed");
      };
      const archive = nativeAwaitRecovery ? await archivePublishedNotesCheckout({
        layout: { ...layout, primaryRoot: initial.root }, original: nativeAwaitRecovery.predecessor ?? nativeAwaitRecovery,
        successor: nativeAwaitRecovery.predecessor ? nativeAwaitRecovery : null,
        frozenTasks: tasks, publishedRevision: published, validate: validateArchive,
        gitAt: (cwd, args, options) => runGit(args, { ...options, cwd }),
        assertClone: repositoryRoot => assertReleaseCloneForPublication({ repositoryRoot }),
        readJson, writeJson: writeJsonAtomic,
      }) : null;
      // Forward custody never recreates a missing clone or rewrites its marker
      // before accounting for the original effects. Missing/partial stays put.
      if (forwardPreparation && nativeAwaitRecovery) throw new Error("Forward preparation cannot archive another Await original");
      const clone = forwardPreparation && !this.#isolationContext
        ? { ...layout, ...await assertReleaseCloneForPublication({ repositoryRoot: layout.releaseRoot }) }
        : await this.#ensureClone(initial, [baseCommit, ...tasks.map(task => task.resultCommit)]);
      if (this.#isolationContext) await this.#assertIsolationClone(clone, this.#isolationContext);
      const git = (args, options = {}) => runGit(args, { ...options, cwd: clone.releaseRoot, timeoutMs: null });
      const checkpoint = await readJson(clone.checkpointFile);
      if (forwardPreparation) {
        if (!preparationGuard || !preflightRequestId || typeof commitPrepared !== "function"
            || typeof forwardPreparation.observeEffects !== "function") throw new Error("Forward preparation owning boundaries are incomplete");
        const journalFile = path.join(layout.root, "native-preparation.json");
        const readEffectRecord = async file => {
          const entry = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          if (!entry) return null;
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Forward preparation effect record is unsafe");
          const bytes = await readFile(file);
          return { sha256: sha256(bytes), bytes: bytes.length, value: JSON.parse(bytes) };
        };
        // Native journals contain complete index/automatic inventories. Their
        // evidence digest is streamed independently of parsed checkpoints;
        // the native sequencer still owns parsing and semantic validation.
        const nativeRecordHash = async file => {
          const entry = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          if (!entry) return null;
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Forward preparation effect record is unsafe");
          const sameFile = info => info.isFile() && !info.isSymbolicLink()
            && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => info[key] === entry[key]);
          const handle = await open(file, "r");
          try {
            if (!sameFile(await handle.stat())) throw new Error("Forward native effect record changed");
            const digest = createHash("sha256");
            let bytes = 0;
            for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
              bytes += chunk.length;
              if (bytes > entry.size) throw new Error("Forward native effect record changed");
              digest.update(chunk);
            }
            if (bytes !== entry.size || !sameFile(await handle.stat()) || !sameFile(await lstat(file))) {
              throw new Error("Forward native effect record changed");
            }
            return digest.digest("hex");
          } finally { await handle.close(); }
        };
        const journalRecord = await readEffectRecord(journalFile), journal = journalRecord?.value;
        const checkpointBytes = await readFile(clone.checkpointFile).catch(error => {
          if (this.#isolationContext && error.code === "ENOENT") return null; throw error;
        });
        const nativeRoot = path.join(layout.root, "native-merges");
        const nativeInfo = await lstat(nativeRoot).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (nativeInfo && (!nativeInfo.isDirectory() || nativeInfo.isSymbolicLink())) throw new Error("Forward native staging custody changed");
        const entries = await readdir(nativeRoot, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
        const native = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const folder = path.join(nativeRoot, entry.name), info = await lstat(folder);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Forward native root custody changed");
          const mergeHash = await nativeRecordHash(path.join(folder, "merge.json"));
          const bundle = await lstat(path.join(folder, "source.bundle")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          if (bundle && (!bundle.isFile() || bundle.isSymbolicLink())) throw new Error("Forward native transport custody changed");
          native.push({ root: entry.name, mergeHash,
            transport: bundle ? { bytes: bundle.size, dev: bundle.dev, ino: bundle.ino, mtimeMs: bundle.mtimeMs } : null });
        }
        const inventory = { schemaVersion: 1, checkpointHash: checkpointBytes === null ? null : sha256(checkpointBytes),
          markerHash: sha256(await readFile(clone.markerFile)),
          journalHash: journalRecord?.sha256 ?? null, native,
          refsHash: sha256(await git(["for-each-ref", "--format=%(refname)%00%(objectname)"])),
          checkoutHead: await git(["rev-parse", "HEAD^{commit}"]),
          checkoutTree: await git(["rev-parse", "HEAD^{tree}"]),
          checkoutIndexHash: sha256(await git(["ls-files", "--stage", "-z"])),
          checkoutDirtyHash: sha256(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) };
        await forwardPreparation.observeEffects(inventory);
        await validateBeforeCommit();
        // A committed candidate with a lost reply is adopted exactly once,
        // without composing, fetching, checking out or creating another body.
        if (checkpoint?.preflightRequestId === preflightRequestId) {
          const source = await this.frozenCandidate(initial.root);
          const manifest = JSON.parse(await readFile(source.manifestFile, "utf8"));
          const p = manifest.preparationIdentity;
          const allowedSources = [forwardPreparation.originalEnvelope, { sourceCommit: preparationGuard.sourceCommit,
            sourceTree: preparationGuard.sourceTree, sourceClosureHash: preparationGuard.sourceClosureHash }];
          if (source.checkpointPhase !== "prepared" || manifest.compositionPolicy !== NATIVE_RELEASE_POLICY
              || source.planRevision !== revision || source.baseCommit !== baseCommit
              || source.tree !== preparationGuard.approvedTree || manifest.workspaceId !== workspaceId
              || stableManifest(normalizedFrozenTasks(manifest.tasks)) !== stableManifest(tasks)
              || stableManifest(manifest.baseProvenance) !== stableManifest(provenance)
              || p?.argumentsHash !== preparationGuard.argumentsHash || p.publicationHash !== preparationGuard.publicationHash
              || ![preparationGuard.checkpointHash, forwardPreparation.originalEnvelope.repositories[0].checkpointHash]
                .includes(p.previousCheckpointHash)
              || !allowedSources.some(s => s.sourceCommit === p.sourceCommit && s.sourceTree === p.sourceTree
                && s.sourceClosureHash === p.sourceClosureHash)
              || !journal || journal.requestId !== preflightRequestId || !["prepared", "completed"].includes(journal.phase)
              || journal.manifestHash !== source.manifestHash || journal.target !== source.preReleaseHead
              || journal.targetTree !== source.tree) throw new Error("Original committed preparation candidate cannot be adopted exactly");
          const authority = await this.#nativeHistoryAuthority({ projectRoot: initial.root, provenance,
            planRevision: revision, tasks });
          await assertNativePreparedComposition({ git, baseCommit, tasks, historyAuthority: authority,
            merges: manifest.merges, head: source.preReleaseHead, tree: source.tree,
            identity: { policy: NATIVE_RELEASE_POLICY, workspaceId, planRevision: revision, baseCommit, tasks },
            });
          const current = await primarySnapshot(initial.root);
          const remote = await git(["ls-remote", "origin", "refs/heads/main"]);
          if (current.mainCommit !== preparationGuard.primaryMainCommit || current.headCommit !== initial.headCommit
              || current.branchRef !== initial.branchRef || current.dirty.indexFingerprint !== initial.dirty.indexFingerprint
              || current.dirty.fingerprint !== initial.dirty.fingerprint
              || remote.split(/\s/u)[0] !== preparationGuard.originMainCommit) throw new Error("Forward adoption current main/origin changed");
          if (localSource) await assertInstalledLocalSourceBaseline({ provenance: localSource, git,
            readOwnGitPublication: input => readOwnGitPublicationOrigin({ dataDir: this.#publicationDataDir, ...input }),
            originalAuthority: this.#historicalChangelogOriginal(localSource),
            repositoryRoot: initial.root, adoptionGit: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }),
            primaryMainCommit: current.mainCommit, publishedRevision: published, planRevision: revision,
            tasks, runtimeRoot: defaultRuntimeRoot({ environment: this.#environment }) });
          await validateBeforeCommit();
          const result = { ...source, manifest, frozenTasks: tasks, mergedTaskIds: tasks.map(task => task.taskId),
            reused: true, forwardAdoptedOriginal: true };
          if (journal.phase !== "completed") await writeJsonAtomic(journalFile, { ...journal, phase: "completed" });
          await commitPrepared(result);
          return result;
        }
        if (journal && !["completed", "rolled_back"].includes(journal.phase)) {
          throw Object.assign(new Error("Original preparation has partial promotion without a complete candidate; preserve its journal"),
            { code: "AWAIT_PREPARATION_UNKNOWN" });
        }
      }
      if (nativeAwaitRecovery?.predecessor && !checkpoint) {
        if (await runGit(["rev-parse", "HEAD^{commit}"], { cwd: clone.releaseRoot }) !== initial.mainCommit
            || await runGit(["symbolic-ref", "HEAD"], { cwd: clone.releaseRoot }) !== "refs/heads/main"
            || await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: clone.releaseRoot })
            || await gitMaybe(["rev-parse", "refs/heads/PreRelease^{commit}"], { cwd: clone.releaseRoot })) {
          throw Object.assign(new Error("Failed Await successor requires an exact fresh clone"), { code: "AWAIT_PREPARATION_UNKNOWN" });
        }
      }
      if (preserveFrozen && ["freezing", "frozen"].includes(checkpoint?.phase)) throw new ReleaseCandidateFrozenError();
      const validatePreparationMain = async () => {
        if (!preparationGuard) return;
        const current = await primarySnapshot(initial.root);
        const remote = await git(["ls-remote", "origin", "refs/heads/main"]);
        if (current.mainCommit !== preparationGuard.primaryMainCommit
            || current.headCommit !== initial.headCommit || current.branchRef !== initial.branchRef
            || remote.split(/\s/u)[0] !== preparationGuard.originMainCommit) {
          throw new TaskPreparationRejectedError("Preparation current main or remote changed");
        }
      };
      await validatePreparationMain();
      if (this.#isolationContext) {
        if (checkpoint || await gitMaybe(["rev-parse", "refs/heads/PreRelease^{commit}"], { cwd: clone.releaseRoot })
            || await git(["rev-parse", "HEAD^{commit}"]) !== initial.mainCommit
            || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
          throw new TaskPreparationRejectedError("Isolated first candidate checkpoint/ref/checkout is not pristine");
        }
      } else await assertPreparationCheckpoint({ guard: preparationGuard, clone, initial, checkpoint, git });
      // The original isolation bundle remains historical evidence. Once its
      // owner completed, ordinary later selections read their exact objects
      // from the registered primary without changing either repository's config.
      const workspace = authority?.phase === "completed" && !forwardPreparation ? initial.root : "workspace";
      await git(["fetch", "--prune", workspace, "+refs/heads/main:refs/remotes/workspace/main"]);
      // Operational source objects are verification inputs, not merge bases.
      for (const commit of [baseCommit, ...(localSource ? [localSource.sourceBaseCommit] : []),
        ...tasks.map((task) => task.resultCommit)]) {
        if (await gitMaybe(["cat-file", "-e", `${commit}^{commit}`], { cwd: clone.releaseRoot }) === null) {
          await git(["fetch", workspace, commit]);
        }
      }
      const validateLocalSource = async () => {
        if (localSource) await assertInstalledLocalSourceBaseline({ provenance: localSource, git,
          readOwnGitPublication: input => readOwnGitPublicationOrigin({ dataDir: this.#publicationDataDir, ...input }),
          originalAuthority: this.#historicalChangelogOriginal(localSource),
          repositoryRoot: initial.root,
          adoptionGit: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }),
          primaryMainCommit: (await primarySnapshot(initial.root)).mainCommit,
          publishedRevision: await durablePublishedRevision(this.#environment, initial.root),
          planRevision: revision, tasks, runtimeRoot: defaultRuntimeRoot({ environment: this.#environment }),
        });
      };
      await validateLocalSource();
      const historyRequest = { projectRoot: initial.root, provenance, planRevision: revision, tasks };
      let historyAuthority = await this.#nativeHistoryAuthority(historyRequest);
      if (historyAuthority?.publishedMetadata) historyRequest.expectedPublishedMetadata = historyAuthority.publishedMetadata;
      await measureTaskOperation("native:task-histories", () => assertNativeTaskHistories({ git, baseCommit, tasks, historyAuthority }));
      const identity = { policy: NATIVE_RELEASE_POLICY, workspaceId, planRevision: revision, baseCommit, tasks };
      const mergeRoot = path.join(layout.root, "native-merges", sha256(stableManifest(identity)).slice(0, 24));
      const readLegacyReuseBinding = async () => measureTaskOperation("native:legacy-prepared-verify", async () => {
        if (checkpoint?.phase !== "prepared" || checkpoint.baseCommit !== baseCommit
            || stableManifest(checkpoint.baseProvenance ?? null) !== stableManifest(provenance ?? null)) return null;
        const retained = await this.frozenCandidate(initial.root);
        const manifestBytes = await readFile(retained.manifestFile);
        if (sha256(manifestBytes) !== retained.manifestHash) throw new Error("Retained native manifest changed");
        const old = JSON.parse(manifestBytes);
        if (retained.checkpointPhase !== "prepared" || old.compositionPolicy !== NATIVE_RELEASE_POLICY
            || String(old.workspaceId ?? "") !== String(workspaceId ?? "")
            || stableManifest(old.baseProvenance ?? null) !== stableManifest(provenance ?? null)) return null;
        const oldTasks = normalizedFrozenTasks(old.tasks);
        const oldIdentity = { policy: NATIVE_RELEASE_POLICY, workspaceId, planRevision: retained.planRevision, baseCommit, tasks: oldTasks };
        const oldRoot = path.join(layout.root, "native-merges", sha256(stableManifest(oldIdentity)).slice(0, 24));
        const stateFile = path.join(oldRoot, "merge.json");
        const stateInfo = await lstat(stateFile).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (!stateInfo?.isFile() || stateInfo.isSymbolicLink()) return null;
        const bytes = await readFile(stateFile), state = JSON.parse(bytes);
        if (taskGitIdentityHash(state.identity) !== taskGitIdentityHash(oldIdentity) || state.head !== retained.preReleaseHead
            || taskGitIdentityHash(state.merges) !== taskGitIdentityHash(old.merges)) return null;
        const oldAuthority = await this.#nativeHistoryAuthority({ projectRoot: initial.root, provenance,
          planRevision: retained.planRevision, tasks: oldTasks });
        if (taskGitIdentityHash(oldAuthority) !== taskGitIdentityHash(historyAuthority)) return null;
        const checkpointBytes = await readFile(clone.checkpointFile);
        if (sha256(await readFile(retained.manifestFile)) !== retained.manifestHash
            || stableManifest(JSON.parse(checkpointBytes)) !== stableManifest(checkpoint)) {
          throw new Error("Retained prepared prefix custody changed");
        }
        return { root: oldRoot, identityHash: taskGitIdentityHash(oldIdentity), head: retained.preReleaseHead,
          tree: retained.tree, journalHash: sha256(bytes), mergesHash: taskGitIdentityHash(old.merges),
          verifyInRepository: retainedGit => assertNativePreparedComposition({ git: retainedGit, baseCommit,
            tasks: oldTasks, merges: old.merges, head: retained.preReleaseHead, tree: retained.tree,
            identity: oldIdentity, historyAuthority: oldAuthority }),
          unchanged: async () => sha256(await readFile(clone.checkpointFile)) === sha256(checkpointBytes)
            && sha256(await readFile(retained.manifestFile)) === retained.manifestHash };
      });
      const composition = await mergeSelectedResults({
        root: mergeRoot, sourceRoot: clone.releaseRoot, baseCommit, tasks, identity,
        reuseContext: { repositoryRoot: initial.root, primaryGitCommonDir: initial.commonDir,
          baseProvenance: provenance ?? null, historyAuthority: historyAuthority ?? null },
        readLegacyReuseBinding,
        deliveredHead: checkpoint?.preReleaseHead ?? null,
        gitAt: (cwd, args, options = {}) => runGit(args, { ...options, cwd, timeoutMs: null }),
        readJson, writeJson: writeJsonAtomic,
        provisionNativeObjects: input => preparationObjectStore().provision({ ...input,
          identityHash: taskGitIdentityHash({ repository: input.repository, identityHash: input.identityHash }) }),
        verifyNativeObjects: input => preparationObjectStore().assertConsumer({ ...input,
          identityHash: taskGitIdentityHash({ repository: input.repository, identityHash: input.identityHash }) }),
      }).catch(error => {
        // Only private native staging has changed at this boundary. Keep its
        // issued checkout for resolution without making a definite conflict
        // an unrecoverable unknown preparation receipt.
        if (error.code === "RELEASE_SELECTED_CONTENT_MISSING") {
          throw Object.assign(new TaskPreparationRejectedError(error.message, { cause: error }), {
            selectedContentMissing: { taskId: error.taskId, resultCommit: error.resultCommit,
              candidateCommit: error.candidateCommit, missingPaths: error.missingPaths },
          });
        }
        if (preparationGuard && error.code === "RELEASE_NATIVE_MERGE_CONFLICT") {
          throw Object.assign(new TaskPreparationRejectedError(error.message, { cause: error }),
            { conflictRoot: error.conflictRoot, conflicts: error.conflicts });
        }
        throw error;
      });
      // Exact approved tree follows the verified native ordered merge history.
      // Legacy per-file owned-union projection is not a native authority.
      if (preparationGuard && (composition.tree !== preparationGuard.approvedTree
          || baseCommit !== preparationGuard.approvedBaseCommit)) {
        throw new TaskPreparationRejectedError("Full selected/joint preparation tree differs from the reviewed tree");
      }
      const cutover = archive?.cutover ?? await this.#nativeCutover(clone, checkpoint);
      const manifest = {
        schemaVersion: 2, compositionPolicy: NATIVE_RELEASE_POLICY,
        ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
        ...(preflightRequestId ? { preflightRequestId: String(preflightRequestId) } : {}),
        ...(preparationGuard ? { preparationIdentity: {
          argumentsHash: preparationGuard.argumentsHash, sourceCommit: preparationGuard.sourceCommit,
          sourceTree: preparationGuard.sourceTree, sourceClosureHash: preparationGuard.sourceClosureHash,
          publicationHash: preparationGuard.publicationHash, approvedTree: preparationGuard.approvedTree,
          previousCheckpointHash: preparationGuard.checkpointHash,
        } } : {}),
        planRevision: revision, primaryRoot: initial.root, primaryGitCommonDir: initial.commonDir,
        releaseRoot: clone.releaseRoot, releaseGitCommonDir: clone.releaseGitCommonDir,
        baseCommit, ...(provenance ? { baseProvenance: provenance } : {}),
        tasks, merges: composition.merges,
        ...(cutover ? { cutover } : {}),
      };
      const manifestText = stableManifest(manifest);
      const manifestHash = sha256(manifestText);
      const manifestFile = path.join(clone.evidenceRoot, `${manifestHash}.json`);
      const branchRef = `refs/heads/${RELEASE_BRANCH}`;
      const journalFile = path.join(layout.root, "native-preparation.json");
      let journal = await readJson(journalFile);
      if (archive && journal?.phase === "published-notes-archived") journal = null;
      if (journal && journal.phase !== "completed" && journal.phase !== "rolled_back"
          && journal.manifestHash !== manifestHash) {
        throw Object.assign(new Error("A different native preparation remains unresolved"), { code: "AWAIT_PREPARATION_UNKNOWN" });
      }
      const validate = async () => measureTaskOperation("native:promotion-authority", async () => {
        if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
        await validatePreparationMain();
        const current = await primarySnapshot(initial.root);
        assertPrimarySnapshot(current, "native release promotion");
        if (current.mainCommit !== ((localSource ?? nativeSource)?.agreedMainCommit ?? baseCommit) || current.headCommit !== initial.headCommit
            || current.branchRef !== initial.branchRef
            || current.dirty.indexFingerprint !== initial.dirty.indexFingerprint
            || current.dirty.fingerprint !== initial.dirty.fingerprint) {
          throw new Error("Registered primary changed during native release preparation");
        }
        if (!localSource && (provenance?.approvedLocalMainCommit || provenance?.approvedOriginMainCommit)) {
          const remote = await git(["ls-remote", "origin", "refs/heads/main"]);
          if (current.mainCommit !== provenance.approvedLocalMainCommit
              || remote.split(/\s/u)[0] !== provenance.approvedOriginMainCommit) {
            throw new Error("reviewed main authority changed during native PreRelease preparation");
          }
        }
        if (await durablePublishedRevision(this.#environment, initial.root) !== published) {
          throw new Error("Publication authority changed during native release preparation");
        }
        await validateLocalSource();
        historyAuthority = await this.#nativeHistoryAuthority({ ...historyRequest, primary: current });
        await measureTaskOperation("native:task-histories", () => assertNativeTaskHistories({ git, baseCommit, tasks, historyAuthority }));
        if (historyAuthority?.adoptions.length) await assertNativeUpstreamOrigin({
          git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }),
          adoptions: historyAuthority.adoptions, originCommit: localSource.approvedOriginMainCommit });
        else if (localSource?.ownGitPublication) await assertOwnGitPublicationOrigin({ provenance: localSource,
          repositoryRoot: initial.root, tasks,
          readOwnGitPublication: input => readOwnGitPublicationOrigin({ dataDir: this.#publicationDataDir, ...input }),
          git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }) });
        else if (localSource?.adoptions) await assertInstalledAgreedMainOrigin({ provenance: localSource,
          git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }) });
        if (nativeAwaitRecovery) {
          const remote = await git(["ls-remote", "origin", "refs/heads/main"]);
          if (remote.split(/\s/u)[0] !== nativeAwaitRecovery.originMainCommit) {
            throw Object.assign(new Error("Original Await origin changed after archive"), { code: "AWAIT_PREPARATION_UNKNOWN" });
          }
        }
      });
      const requireCheckout = async (head) => {
        const [actualHead, actualTree, ...extra] = String(await git(
          ["rev-parse", "HEAD^{commit}", "HEAD^{tree}"])).split(/\r?\n/u);
        if (actualHead !== head || !actualTree || extra.length
            || await git(["write-tree"]) !== actualTree
            || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
          throw Object.assign(new Error("Native release checkout changed; foreign bytes retained"), { code: "AWAIT_PREPARATION_UNKNOWN" });
        }
      };
      await validate();
      let reused = checkpoint?.manifestHash === manifestHash && checkpoint?.preReleaseHead === composition.head;
      if (reused) {
        if (await git(["rev-parse", `${branchRef}^{commit}`]) !== composition.head) throw new Error("Native candidate ref changed");
        await requireCheckout(composition.head);
      } else {
        await git(["fetch", "--no-tags", composition.root, composition.head]);
        if (!journal || ["completed", "rolled_back"].includes(journal.phase)) {
          const before = {
            head: await git(["rev-parse", "HEAD^{commit}"]),
            checkout: await gitMaybe(["symbolic-ref", "-q", "HEAD"], { cwd: clone.releaseRoot }),
            branch: await gitMaybe(["rev-parse", `${branchRef}^{commit}`], { cwd: clone.releaseRoot }),
            checkpoint,
            checkpointBytes: (await readFile(clone.checkpointFile).catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            }))?.toString("base64") ?? null,
          };
          await requireCheckout(before.head);
          journal = { version: 1, policy: NATIVE_RELEASE_POLICY, phase: "prepared",
            manifestHash, target: composition.head, targetTree: composition.tree, before,
            ...(preflightRequestId ? { requestId: String(preflightRequestId) } : {}),
            ...(archive ? { requestId: nativeAwaitRecovery.operationId, publishedNotesArchive: archive.descriptor,
              ...(nativeAwaitRecovery.predecessor ? { awaitSuccessor: Object.fromEntries(
                ["operationId", "taskId", "workspaceId", "argumentsHash", "resultCommit", "originMainCommit", "taskRevision"]
                  .map(key => [key, nativeAwaitRecovery[key]])) } : {}) } : {}) };
          await writeJsonAtomic(journalFile, journal);
        }
        if (journal.version !== 1 || journal.policy !== NATIVE_RELEASE_POLICY
            || journal.manifestHash !== manifestHash || journal.target !== composition.head
            || journal.targetTree !== composition.tree) throw new Error("Native preparation journal identity changed");
        const branch = await gitMaybe(["rev-parse", `${branchRef}^{commit}`], { cwd: clone.releaseRoot });
        const head = await git(["rev-parse", "HEAD^{commit}"]);
        if (![journal.before.branch, composition.head].includes(branch)
            || ![journal.before.head, composition.head].includes(head)) {
          throw Object.assign(new Error("Native preparation ref state is unknown"), { code: "AWAIT_PREPARATION_UNKNOWN" });
        }
        await requireCheckout(head);
        await validate();
        try {
        // Git owns physical checkout and EOL. No reset, clean, force checkout,
        // per-file serializer or hard-link publication enters the ordinary path.
        if (head !== composition.head) await git(["checkout", "--detach", "--no-overwrite-ignore", composition.head]);
        await requireCheckout(composition.head);
        await validate();
        if (branch !== composition.head) await git(["update-ref", branchRef, composition.head, journal.before.branch || "0".repeat(40)]);
        await git(["symbolic-ref", "HEAD", branchRef]);
        await requireCheckout(composition.head);
        await mkdir(clone.evidenceRoot, { recursive: true });
        if (!await fileExists(manifestFile)) await writeFile(manifestFile, manifestText, { flag: "wx", encoding: "utf8" });
        else if (sha256(await readFile(manifestFile)) !== manifestHash) throw new Error("Native manifest changed");
        await writeJsonAtomic(clone.checkpointFile, {
          schemaVersion: 2, phase: "prepared", compositionPolicy: NATIVE_RELEASE_POLICY,
          planRevision: revision, manifestHash, manifestFile, baseCommit,
          ...(provenance ? { baseProvenance: provenance } : {}), preReleaseHead: composition.head,
          ...(preflightRequestId ? { preflightRequestId: String(preflightRequestId) } : {}),
          ...(preparationGuard ? { preparationIdentity: manifest.preparationIdentity } : {}),
        });
        } catch (error) {
          // A refused checkout is a known no-effect only after both native
          // identities and the complete index/worktree prove the old state.
          // A partial checkout or moved ref stays on the original journal.
          try {
            const actualBranch = await gitMaybe(["rev-parse", `${branchRef}^{commit}`], { cwd: clone.releaseRoot });
            if (actualBranch !== journal.before.branch) throw new Error("Candidate ref moved");
            await requireCheckout(journal.before.head);
            if (journal.before.checkout) await git(["symbolic-ref", "HEAD", journal.before.checkout]);
            journal.phase = "rolled_back";
            await writeJsonAtomic(journalFile, journal);
          } catch (readbackError) {
            throw Object.assign(new Error(`Native promotion requires original readback: ${readbackError.message}`),
              { code: "AWAIT_PREPARATION_UNKNOWN", cause: error });
          }
          throw error;
        }
      }
      const result = {
        repositoryRoot: initial.root, releaseRoot: clone.releaseRoot, branch: RELEASE_BRANCH,
        baseCommit, preReleaseHead: composition.head, tree: composition.tree,
        manifestHash, manifestFile, planRevision: revision, manifest, frozenTasks: tasks,
        mergedTaskIds: tasks.map((task) => task.taskId), reused,
        independentGitCommonDir: !samePath(clone.releaseGitCommonDir, initial.commonDir),
        releaseGitCommonDir: clone.releaseGitCommonDir, primaryGitCommonDir: initial.commonDir,
        primaryPreserved: true, legacyLinkedHolders: initial.legacyLinkedHolders,
        ...((nativeAwaitRecovery || localSource) ? { verifyNativeAwaitAuthority: validate } : {}),
      };
      try {
        await validate();
        await requireCheckout(composition.head);
        // Forward completion must not outlive unfinished native bookkeeping.
        // The same in-memory rollback boundary and lease remain live; on an
        // interrupted forward SQL write the exact candidate is adopted later.
        if (forwardPreparation && journal?.manifestHash === manifestHash) {
          journal.phase = "completed";
          await writeJsonAtomic(journalFile, journal);
        }
        if (commitPrepared) await commitPrepared(result);
      } catch (error) {
        if (AWAIT_UNKNOWN_OUTCOME_CODES.has(error?.code) || reused) throw error;
        try {
          await requireCheckout(composition.head);
          if (await git(["rev-parse", `${branchRef}^{commit}`]) !== composition.head) throw new Error("Native rollback ref changed");
          await git(["checkout", "--detach", "--no-overwrite-ignore", journal.before.head]);
          await requireCheckout(journal.before.head);
          if (journal.before.branch) await git(["update-ref", branchRef, journal.before.branch, composition.head]);
          else await git(["update-ref", "-d", branchRef, composition.head]);
          if (journal.before.checkout) await git(["symbolic-ref", "HEAD", journal.before.checkout]);
          if (journal.before.checkpointBytes) {
            await writeFile(clone.checkpointFile, Buffer.from(journal.before.checkpointBytes, "base64"));
          } else if (journal.before.checkpoint) {
            // Reader for the first native journal revision; no inferred bytes.
            await writeJsonAtomic(clone.checkpointFile, journal.before.checkpoint);
          } else await rm(clone.checkpointFile, { force: true });
          journal.phase = "rolled_back";
          await writeJsonAtomic(journalFile, journal);
        } catch (rollbackError) {
          throw Object.assign(new Error(`Native rollback remains unknown: ${rollbackError.message}`), { code: "AWAIT_PREPARATION_UNKNOWN" });
        }
        throw error;
      }
      if (journal?.manifestHash === manifestHash) {
        journal.phase = "completed";
        try { await writeJsonAtomic(journalFile, journal); }
        catch (error) {
          throw Object.assign(new Error("Native terminal journal persistence is unknown"),
            { code: "AWAIT_PREPARATION_UNKNOWN", cause: error });
        }
      }
      return result;
    });
  }

  async initialNativeTestCandidate(projectRoot) {
    this.#assertAvailable("initialNativeTestCandidate");
    const primary = await primarySnapshot(projectRoot);
    const layout = this.#layout(primary.root);
    const bytes = await readFile(layout.checkpointFile).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (bytes === null) return { checkpointSha256: null, candidate: null };
    return { checkpointSha256: sha256(bytes), candidate: await this.frozenCandidate(projectRoot) };
  }

  async frozenCandidate(projectRoot, { changelogContent = undefined, allowAbsent = false } = {}) {
    return this.#readFrozenCandidate(projectRoot, { changelogContent, allowAbsent });
  }

  async #readFrozenCandidate(projectRoot, { changelogContent = undefined, allowAbsent = false, metadataPreview = false } = {}) {
    this.#assertAvailable("frozenCandidate");
    const authority = this.#readPreparationAuthority(canonicalPath(projectRoot));
    if (authority && !preparationGitIsolationActive()) return withPreparationGitIsolation(authority.isolation.dataDir,
      () => this.#readFrozenCandidate(projectRoot, { changelogContent, allowAbsent, metadataPreview }));
    const primary = await primarySnapshot(projectRoot);
    const layout = this.#layout(primary.root);
    const checkpoint = await readJson(layout.checkpointFile);
    if (allowAbsent && checkpoint === null) return null;
    if (!checkpoint?.planRevision || !checkpoint?.manifestHash
        || !checkpoint?.baseCommit || !checkpoint?.preReleaseHead) {
      throw new Error(`release checkpoint is incomplete: ${layout.checkpointFile}`);
    }
    const manifestFile = path.join(layout.evidenceRoot, `${checkpoint.manifestHash}.json`);
    if (checkpoint.manifestFile && !samePath(checkpoint.manifestFile, manifestFile)) {
      throw new Error("release checkpoint manifest path does not match its digest");
    }
    const manifestBytes = await readFile(manifestFile);
    if (sha256(manifestBytes) !== checkpoint.manifestHash) {
      throw new Error("release checkpoint manifest digest changed");
    }
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const manifestBaseProvenance = normalizedBaseProvenance(manifest.baseProvenance, manifest.baseCommit);
    const checkpointBaseProvenance = normalizedBaseProvenance(checkpoint.baseProvenance, checkpoint.baseCommit);
    if (stableManifest(manifestBaseProvenance) !== stableManifest(checkpointBaseProvenance)) {
      throw new Error("release checkpoint reviewed-main provenance disagrees with its immutable manifest");
    }
    const marker = await assertReleaseCloneForPublication({ repositoryRoot: layout.releaseRoot });
    if (authority || this.#isolationContext) await this.#assertIsolationClone({ ...layout, ...marker },
      authority?.isolation ?? this.#isolationContext);
    for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "index.lock"]) {
      const pending = await lstat(path.join(marker.releaseGitCommonDir, operation)).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (pending) {
        throw new Error(`release checkpoint has an unfinished Git operation: ${operation}`);
      }
    }
    const [branchHead, mainHead] = await Promise.all([
      runGit(["rev-parse", `refs/heads/${RELEASE_BRANCH}^{commit}`], { cwd: marker.releaseRoot }),
      runGit(["rev-parse", "refs/heads/main^{commit}"], { cwd: marker.releaseRoot }),
    ]);
    if (branchHead !== String(checkpoint.preReleaseHead)) {
      throw new Error("release checkpoint PreRelease branch no longer matches its prepared head");
    }
    const checkpointPhase = String(checkpoint.phase ?? "");
    const expectedCheckout = checkpointPhase === "prepared"
      ? RELEASE_BRANCH
      : checkpointPhase === "frozen" ? "main" : null;
    if (!expectedCheckout) {
      throw new Error(`release checkpoint phase is not readable as a candidate: ${checkpointPhase || "missing"}`);
    }
    if (checkpointPhase === "frozen" && mainHead !== String(checkpoint.preReleaseHead)) {
      throw new Error("frozen release checkpoint main branch no longer matches its prepared head");
    }
    const primaryFailure = primaryInvariantFailure(primary, "preflight frozen candidate readback");
    if (primaryFailure) throw new Error(primaryFailure);
    const [releaseBranch, releaseHead, releaseTree, releaseDirty] = await Promise.all([
      gitMaybe(["symbolic-ref", "--short", "HEAD"], { cwd: marker.releaseRoot }),
      runGit(["rev-parse", "HEAD^{commit}"], { cwd: marker.releaseRoot }),
      runGit(["rev-parse", "HEAD^{tree}"], { cwd: marker.releaseRoot }),
      runGit(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: marker.releaseRoot, rawOutput: true })
        .then(bytes => Buffer.from(bytes).toString("utf8")),
    ]);
    let authorizedNotes = false;
    if (checkpointPhase === "prepared" && releaseDirty && changelogContent != null
        && releaseDirty.split("\0").filter(Boolean).every(line => line.slice(3) === "CHANGELOG.md")) {
      const file = path.join(marker.releaseRoot, "CHANGELOG.md");
      const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      authorizedNotes = Boolean(info?.isFile() && !info.isSymbolicLink()
        && (await readFile(file)).equals(Buffer.from(changelogContent)));
    }
    const pendingMetadata = [];
    if (releaseBranch !== expectedCheckout || releaseHead !== branchHead || (releaseDirty && !authorizedNotes && !pendingMetadata.length)) {
      throw new Error(`release checkpoint clone is not an exact clean ${expectedCheckout} checkout for phase ${checkpointPhase}`);
    }
    if (manifest.schemaVersion !== 2
        || manifest.planRevision !== checkpoint.planRevision
        || manifest.baseCommit !== checkpoint.baseCommit
        || !samePath(manifest.primaryRoot, primary.root)
        || !samePath(manifest.releaseRoot, marker.releaseRoot)
        || !samePath(manifest.primaryGitCommonDir, primary.commonDir)
        || !samePath(manifest.releaseGitCommonDir, marker.releaseGitCommonDir)) {
      throw new Error("release checkpoint manifest identity does not match the managed repository");
    }
    const checkpointRequestId = String(checkpoint.preflightRequestId ?? "");
    const manifestRequestId = String(manifest.preflightRequestId ?? "");
    if (checkpointRequestId && !manifestRequestId) {
      throw new Error("release checkpoint request identity is missing from the immutable manifest");
    }
    if (checkpointRequestId && manifestRequestId && checkpointRequestId !== manifestRequestId) {
      throw new Error("release checkpoint request identity disagrees with the immutable manifest");
    }
    const checkpointWorkspaceId = String(checkpoint.workspaceId ?? "");
    const manifestWorkspaceId = String(manifest.workspaceId ?? "");
    if (checkpointWorkspaceId && manifestWorkspaceId && checkpointWorkspaceId !== manifestWorkspaceId) {
      throw new Error("release checkpoint Workspace identity disagrees with the immutable manifest");
    }
    const manifestTasks = normalizedFrozenTasks(manifest.tasks ?? []);
    if (manifestBaseProvenance?.historicalChangelog) {
      await assertHistoricalChangelog({ provenance: manifestBaseProvenance, tasks: manifestTasks,
        repositoryRoot: primary.root, originalAuthority: this.#historicalChangelogOriginal(manifestBaseProvenance),
        runtimeRoot: defaultRuntimeRoot({ environment: this.#environment }),
        git: (args, options = {}) => runGit(args, { ...options, cwd: primary.root }),
      });
    }
    const selectedTasks = manifestTasks.filter((task) => task.selectedCompositionRequired);
    if (manifest.compositionPolicy !== NATIVE_RELEASE_POLICY
        && (String(manifest.projectionPolicy ?? "").includes("mandatory-selected-v1") !== Boolean(selectedTasks.length)
          || selectedTasks.some((task) => !checkpoint.netProjectedTaskIds?.includes(task.taskId)))) {
      throw new Error("release checkpoint mandatory selected proof identity is incomplete");
    }
    return {
      repositoryRoot: primary.root,
      releaseRoot: layout.releaseRoot,
      checkpointFile: layout.checkpointFile,
      checkpointPhase,
      ...(pendingMetadata.length ? { pendingMetadata } : {}),
      planRevision: String(checkpoint.planRevision),
      manifestHash: String(checkpoint.manifestHash),
      manifestFile,
      manifest: {
        manifestHash: String(checkpoint.manifestHash),
        schemaVersion: manifest.schemaVersion,
        workspaceId: manifest.workspaceId ?? null,
        preflightRequestId: manifest.preflightRequestId ?? null,
        planRevision: String(manifest.planRevision ?? ""),
        primaryRoot: manifest.primaryRoot,
        releaseRoot: manifest.releaseRoot,
        baseCommit: String(manifest.baseCommit ?? ""),
        ...(manifestBaseProvenance ? { baseProvenance: manifestBaseProvenance } : {}),
        ...(manifest.compositionPolicy ? { compositionPolicy: manifest.compositionPolicy } : {}),
        ...(manifest.merges ? { merges: manifest.merges } : {}),
        ...(manifest.cutover ? { cutover: manifest.cutover } : {}),
        ...(manifest.preparedCandidate ? { preparedCandidate: manifest.preparedCandidate } : {}),
        ...(manifest.publication ? { publication: structuredClone(manifest.publication) } : {}),
        tasks: manifestTasks.map((task) => ({
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          ...(task.resultReleaseRevision != null
            ? { resultReleaseRevision: task.resultReleaseRevision }
            : {}),
          ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}),
          resultCommit: task.resultCommit,
          ...(task.integrations.length ? { integrations: task.integrations.map(integration => ({ ...integration })) } : {}),
          ...(task.squashTransfer ? { squashTransfer: task.squashTransfer } : {}),
          ...selectedCompositionFields(task),
        })),
        taskIds: manifestTasks.map((task) => task.taskId).sort(),
      },
      preflightRequestId: manifestRequestId,
      baseCommit: String(checkpoint.baseCommit),
      preReleaseHead: String(checkpoint.preReleaseHead),
      tree: releaseTree,
    };
  }

  async reconcile({ projectRoots = [] } = {}) {
    this.#assertAvailable("reconcile");
    const entries = await readdir(this.releaseRepositoriesRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const checkpoints = [];
    const repositories = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const checkpointFile = path.join(this.releaseRepositoriesRoot, entry.name, "checkpoint.json");
      try {
      const checkpoint = await readJson(checkpointFile);
      const manifest = checkpoint?.manifestFile ? await readJson(checkpoint.manifestFile) : null;
      if (manifest?.primaryRoot) checkpoints.push({
        repositoryKey: entry.name, checkpointFile, checkpoint, manifest,
      });
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const diagnostic = { source: "checkpoint", repositoryKey: entry.name,
          status: "manual_required", reason: error.message, code: "INVALID_HISTORICAL_JSON" };
        repositories.push(diagnostic);
        console.warn("Historical release entry unavailable", diagnostic);
      }
    }

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
        let checkpoint = checkpoints.find((item) => samePath(item.manifest.primaryRoot, snapshot.root)) ?? null;
        if (this.#readPreparationAuthority(snapshot.root)) {
          const selected = await readJson(layout.checkpointFile);
          const selectedManifest = selected?.manifestFile ? await readJson(selected.manifestFile) : null;
          checkpoint = selectedManifest ? { repositoryKey: layout.repositoryKey, checkpointFile: layout.checkpointFile,
            checkpoint: selected, manifest: selectedManifest } : null;
        }
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
      if (this.#readPreparationAuthority(canonicalPath(checkpoint.manifest.primaryRoot))) continue;
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
