import { spawn } from "node:child_process";
import { preparationIsolationLayout, isolationDigest, assertPlainIsolationPath,
  withPreparationGitIsolation, preparationGitInvocation, preparationGitIsolationActive, guardedPreparationGit } from "./preparation-git-isolation.mjs";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseCandidateFrozenError } from "../../domain/task-board-task.mjs";
import { ReleasePreparationRejectedError } from "../../domain/release-preparation.mjs";
import { assertPreparationCheckpoint } from "./release-preparation-guard.mjs";
import { ReleaseGenerationTransportRetention } from "./release-generation-transport-retention.mjs";
import { createSelectedGitBundle } from "./selected-git-bundle.mjs";
import { runOwnedGit } from "./task-git-workspace.mjs";
import { assertInstalledLocalSourceBaseline, installedNativeHistoryBaseline,
  assertInstalledAgreedMainOrigin } from "./local-source-baseline.mjs";
import { readNativeUpstreamAdoptions, assertNativeUpstreamOrigin } from "./native-upstream-adoption.mjs";
import { inspectPublishedNotesArchive, archivePublishedNotesCheckout } from "./native-await-published-notes-recovery.mjs";
import { defaultRuntimeRoot } from "./runtime-layout.mjs";
import process from "node:process";
import { assertContourExternalEffects, assertContourGitAvailable } from "../../ports/contour-external-effects.mjs";

import { taskRepositoryKey } from "../../domain/task-git-reference.mjs";
import {
  assertReleaseBaseProvenance,
  EXPLICIT_REVIEWED_MAIN_PROVENANCE,
  NATIVE_MAIN_PROVENANCE,
  LOCAL_SOURCE_BASELINE_PROVENANCE,
  normalizedReleaseBaseProvenance,
  releaseBaseProvenanceApprovedBase,
} from "../../domain/release-base-provenance.mjs";
import { normalizedTaskSquashTransfer } from "../../domain/task-squash-transfer.mjs";
import { selectedCompositionFields, selectedCompositionIdentity } from "../../domain/task-selected-composition.mjs";
import { canonicalPath } from "./config.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import { withPublicationLock } from "../process/publication-lock.mjs";
import { recordTaskOperationTiming } from "../process/task-operation-timing.mjs";
import { publicationCheckpointFile, readPublicationCheckpoint } from "../persistence/publication-checkpoint.mjs";
import {
  failedFrozenPublicationEvidence,
  publicationRunPaths,
  readPublicationRunStatus,
} from "../persistence/publication-run-store.mjs";
import { publicationStateFile, publicationStateRepositories, readPublicationState } from "../persistence/publication-state.mjs";
import { freezePreparedPublicationCandidate } from "./freeze-publication-candidate.mjs";
import { assertNativeTaskHistories, assertNativePreparedComposition, mergeSelectedResults, NATIVE_RELEASE_POLICY } from "./native-release-merge.mjs";

const RELEASE_MARKER = "agent-hub-release-clone.json";
const RELEASE_BRANCH = "PreRelease";
// Both layers report an unknown Await outcome: this module owns the candidate
// restore, the lifecycle owns the Task CAS readback.
const AWAIT_UNKNOWN_OUTCOME_CODES = new Set([
  "AWAIT_PREPARATION_UNKNOWN",
  "AWAIT_ACCEPTANCE_UNKNOWN",
]);

function runGit(args, { cwd, timeoutMs = 120_000, rawOutput = false, acceptableExitCodes = [], input = null, stdoutFd = null } = {}) {
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
    const timer = setTimeout(() => {
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

function runGitWithInput(args, input, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const invocation = preparationGitInvocation(args, cwd);
    const child = spawn("git", invocation.args, { cwd, ...(invocation.env ? { env: invocation.env } : {}),
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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


function samePath(left, right) {
  const first = canonicalPath(left);
  const second = canonicalPath(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
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

function assertExactRecoveryExpectation(actual, expected, label) {
  if (!expected || actual !== String(expected).trim()) {
    throw new Error(`publication freeze recovery ${label} changed`);
  }
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

function assertRecoveryDigest(bytes, expected, label) {
  const digest = sha256(bytes);
  if (!/^[a-f0-9]{64}$/u.test(String(expected ?? "")) || digest !== expected) {
    throw new Error(`publication freeze recovery ${label} changed`);
  }
  return digest;
}

function normalizedReviewedOriginAdvance(expected = {}) {
  const advance = {
    reviewedOriginMain: String(expected.reviewedOriginMain ?? "").trim().toLowerCase(),
    reviewedOriginParent: String(expected.reviewedOriginParent ?? "").trim().toLowerCase(),
    reviewedOriginTree: String(expected.reviewedOriginTree ?? "").trim().toLowerCase(),
    reviewedOriginDiffSha256: String(expected.reviewedOriginDiffSha256 ?? "").trim().toLowerCase(),
    reviewedOriginDiffHashObject: String(expected.reviewedOriginDiffHashObject ?? "").trim().toLowerCase(),
    reviewedOriginPatchId: String(expected.reviewedOriginPatchId ?? "").trim().toLowerCase(),
    releaseTrackingOriginMain: String(expected.releaseTrackingOriginMain ?? "").trim().toLowerCase(),
    originUrlSha256: String(expected.originUrlSha256 ?? "").trim().toLowerCase(),
  };
  if (Object.values(advance).every((value) => !value)) return null;
  if (![advance.reviewedOriginMain, advance.reviewedOriginParent, advance.reviewedOriginTree,
    advance.reviewedOriginDiffHashObject, advance.reviewedOriginPatchId,
    advance.releaseTrackingOriginMain].every((value) => /^[a-f0-9]{40}$/u.test(value))
      || ![advance.reviewedOriginDiffSha256, advance.originUrlSha256]
        .every((value) => /^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("publication freeze recovery reviewed origin advance identity is incomplete");
  }
  return advance;
}

async function inspectRemoteObjectsInIsolation({
  originUrl, remoteMain, frozenHead, releaseRoot, approvedOriginMain = null, expectedAdvance = null,
}) {
  const objectRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-reviewed-origin-"));
  try {
    await runGit(["init", "--bare", "."], { cwd: objectRoot });
    await runGit(["fetch", "--no-tags", "--force", originUrl,
      "refs/heads/main:refs/heads/review-origin"], { cwd: objectRoot, timeoutMs: 300_000 });
    const fetchedMain = await runGit(["rev-parse", "refs/heads/review-origin^{commit}"], { cwd: objectRoot });
    if (fetchedMain !== remoteMain) {
      throw new Error("publication freeze recovery reviewed origin changed during isolated verification");
    }
    await runGit(["fetch", "--no-tags", "--force", releaseRoot,
      `${frozenHead}:refs/heads/review-frozen`], { cwd: objectRoot, timeoutMs: 300_000 });
    if (await gitMaybe(["merge-base", "--is-ancestor", frozenHead, remoteMain], { cwd: objectRoot }) !== null) {
      throw new Error("publication freeze recovery candidate acquired a foreign publication effect");
    }
    if (!expectedAdvance) return null;
    if (await gitMaybe(["merge-base", "--is-ancestor", approvedOriginMain, remoteMain], {
      cwd: objectRoot,
    }) === null) {
      throw new Error("publication freeze recovery reviewed origin is not an approved descendant");
    }
    const parents = String(await runGit(["show", "-s", "--format=%P", remoteMain], { cwd: objectRoot }))
      .split(/\s+/u).filter(Boolean);
    const tree = await runGit(["rev-parse", `${remoteMain}^{tree}`], { cwd: objectRoot });
    const diff = await runGit(["diff", "--binary", approvedOriginMain, remoteMain], {
      cwd: objectRoot, rawOutput: true,
    });
    const patchId = String(await runGitWithInput(["patch-id", "--stable"], diff, { cwd: objectRoot }))
      .split(/\s+/u)[0];
    const diffHashObject = String(await runGitWithInput(["hash-object", "--stdin"], diff, { cwd: objectRoot }));
    const observed = {
      reviewedOriginMain: remoteMain,
      reviewedOriginParent: parents.length === 1 ? parents[0] : null,
      reviewedOriginTree: tree,
      reviewedOriginDiffSha256: sha256(diff),
      reviewedOriginDiffHashObject: diffHashObject,
      reviewedOriginPatchId: patchId,
      releaseTrackingOriginMain: expectedAdvance.releaseTrackingOriginMain,
      originUrlSha256: sha256(originUrl),
      objectProof: "isolated-remote-objects-v1",
    };
    if (parents.length !== 1 || parents[0] !== approvedOriginMain
        || Object.entries(expectedAdvance).some(([key, value]) => observed[key] !== value)) {
      throw new Error("publication freeze recovery reviewed origin advance proof changed");
    }
    return observed;
  } finally {
    await rm(objectRoot, { recursive: true, force: true });
  }
}

const normalizedBaseProvenance = normalizedReleaseBaseProvenance;

// Independent freeze defense, checked under the release and repository locks
// before any freeze effect: an advanced base is frozen only with the same
// immutable provenance in its manifest and checkpoint. A later preflight
// receipt cannot retroactively repair a candidate that lacks it.
async function assertFreezeBaseProvenance(layout, publishedBaseCommit) {
  const checkpoint = JSON.parse(await readFile(layout.checkpointFile, "utf8"));
  if (!/^[a-f0-9]{64}$/u.test(String(checkpoint?.manifestHash ?? ""))) throw new Error("invalid prepared manifest hash");
  const manifestBytes = await readFile(path.join(layout.evidenceRoot, `${checkpoint.manifestHash}.json`));
  if (sha256(manifestBytes) !== checkpoint.manifestHash) throw new Error("prepared release manifest digest changed");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestProvenance = normalizedBaseProvenance(manifest.baseProvenance, manifest.baseCommit);
  const checkpointProvenance = normalizedBaseProvenance(checkpoint.baseProvenance, checkpoint.baseCommit);
  if (stableManifest(manifestProvenance) !== stableManifest(checkpointProvenance)
      || manifest.baseCommit !== checkpoint.baseCommit) {
    throw new Error("publication freeze base provenance disagrees with its immutable manifest");
  }
  assertReleaseBaseProvenance({
    publishedBaseCommit, baseCommit: manifest.baseCommit, provenance: manifestProvenance, phase: "publication freeze",
  });
  return { provenance: manifestProvenance, planRevision: manifest.planRevision, tasks: manifest.tasks };
}

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

function resultLineageMismatchError({ taskId, priorResultCommit, resultCommit }) {
  const error = new Error(
    `Selected result ${resultCommit} for Task ${taskId} is not a correction descendant of ${priorResultCommit}`,
  );
  error.code = "RELEASE_RESULT_LINEAGE_MISMATCH";
  error.taskId = taskId;
  error.priorResultCommit = priorResultCommit;
  error.resultCommit = resultCommit;
  return error;
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

const SUPPLEMENTAL_PROVENANCE_KIND = "supplemental-reviewed-adoption-v1";
const MISSING_PROVENANCE_RECOVERY_KIND = "missing-provenance-recovery-v1";

function redactedOriginUrl(value) {
  const text = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return text;
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "<unparseable-origin-url>";
  }
}

function missingProvenanceResolverResult(missingProvenance, candidate) {
  return missingProvenance.resolver({ request: missingProvenance.request, candidate });
}

function supplementalEvidenceMatches(evidence, identity) {
  if (!evidence || typeof evidence !== "object") return false;
  const manifestBytes = Buffer.from(String(evidence.preparedManifestBytesBase64 ?? ""), "base64");
  return sha256(manifestBytes) === identity?.sourceManifest?.preparedManifestHash
    && typeof evidence.preflightResultJson === "string"
    && sha256(Buffer.from(evidence.preflightResultJson, "utf8")) === identity?.authority?.receipt?.resultSha256
    && evidence.preflightResultSha256 === identity?.authority?.receipt?.resultSha256;
}

// The owner does not trust its resolver blindly: every returned field must bind
// the exact candidate facts this owner read from immutable files and Git.
function assertMissingProvenanceAuthority(authority, { request, candidate }) {
  const receipt = authority?.receipt;
  const adoption = authority?.adoption;
  const derived = authority?.derived;
  const bound = authority?.candidate;
  const frozenTask = candidate.frozenTasks.find((task) => task.taskId === adoption?.taskId);
  if (authority?.schemaVersion !== 1 || authority.kind !== SUPPLEMENTAL_PROVENANCE_KIND
      || authority.recoveryKind !== MISSING_PROVENANCE_RECOVERY_KIND
      || String(request?.kind ?? "") !== MISSING_PROVENANCE_RECOVERY_KIND
      || receipt?.requestId !== String(request?.preflightRequestId ?? "")
      || receipt.toolName !== "hub_release_preflight" || receipt.status !== "succeeded"
      || receipt.workspaceId !== candidate.workspaceId
      || receipt.argumentsHash !== String(request?.expectedArgumentsHash ?? "").toLowerCase()
      || receipt.resultSha256 !== String(request?.expectedResultSha256 ?? "").toLowerCase()
      || receipt.streamId !== String(request?.expectedCaller?.streamId ?? "")
      || receipt.provider !== String(request?.expectedCaller?.provider ?? "")
      || receipt.threadId !== String(request?.expectedCaller?.threadId ?? "")
      || adoption?.validation !== "historical-immutable-v1"
      || !Array.isArray(adoption.proofParents) || adoption.proofParents.length !== 2
      || adoption.proofParents[1] !== adoption.adoptedCommit
      || !/^[a-f0-9]{40}$/u.test(String(adoption.proofCommit ?? ""))
      || !/^[a-f0-9]{40}$/u.test(String(adoption.proofTree ?? ""))
      || !/^[a-f0-9]{40}$/u.test(String(adoption.snapshotTree ?? ""))
      || adoption?.taskId !== String(request?.expectedAdoption?.taskId ?? "")
      || adoption.recordRef !== String(request?.expectedAdoption?.recordRef ?? "")
      || adoption.recordHash !== String(request?.expectedAdoption?.recordHash ?? "").toLowerCase()
      || !frozenTask || adoption.resultCommit !== frozenTask.resultCommit
      || adoption.taskRevision !== frozenTask.taskRevision
      || adoption.adoptedCommit !== candidate.baseCommit
      || derived?.publishedBaseCommit !== candidate.publishedBaseCommit
      || derived.baseCommit !== candidate.baseCommit
      || derived.approvedOriginMainCommit !== candidate.baseCommit
      || !/^[a-f0-9]{40}$/u.test(String(derived.approvedLocalMainCommit ?? ""))
      || derived.approvedLocalMainCommit !== adoption.acceptedLocalMainCommit
      || bound?.planRevision !== candidate.planRevision
      || bound.preparedHead !== candidate.preparedHead
      || bound.preparedTree !== candidate.preparedTree
      || bound.preparedManifestHash !== candidate.preparedManifestHash
      || JSON.stringify(bound.taskIds) !== JSON.stringify(candidate.frozenTasks.map((task) => task.taskId).sort())) {
    throw new Error("publication freeze recovery missing-provenance authority does not bind this candidate");
  }
}

export class ReleaseGitWorkspaceService {
  #contourExternalEffects;
  #environment;
  #recoveryEvidenceWrite;
  #recoveryPhase;
  #validationBundle = null;
  #validationReferenceRoot = null;
  #isolationContext = null;
  #readPreparationAuthority;

  constructor({
    dataDir, contourExternalEffects = null, environment = process.env,
    recoveryEvidenceWrite = (handle, value) => handle.writeFile(value, "utf8"),
    recoveryPhase = async () => {}, verifyNativeResolutionReview = null,
    readPreparationAuthority = () => null,
  } = {}) {
    this.#contourExternalEffects = assertContourExternalEffects(contourExternalEffects);
    this.#environment = environment;
    this.#readPreparationAuthority = readPreparationAuthority;
    this.#recoveryEvidenceWrite = recoveryEvidenceWrite;
    this.#recoveryPhase = recoveryPhase;
    this.dataDir = canonicalPath(String(dataDir ?? ""));
    this.verifyNativeResolutionReview = verifyNativeResolutionReview;
    this.releaseRepositoriesRoot = path.join(this.dataDir, "release-repositories");
    this.lastReconciliation = {
      checked: 0, registeredWorkspaceRoots: 0, checkpointCount: 0, repositories: [],
    };
  }

  #assertAvailable(operation) {
    assertContourGitAvailable(this.#contourExternalEffects, "release-git", operation);
  }

  storageRetentionOwner({ readGeneration, isStopping } = {}) {
    this.#assertAvailable("storageRetentionOwner");
    return new ReleaseGenerationTransportRetention({ dataDir: this.dataDir, readGeneration, isStopping,
      withGenerationLease: (key, action) => withInterprocessLocks([
        path.join(this.dataDir, "locks", `release-generation-${key}`),
      ], action, { timeoutMs: 250 }),
      gitAt: async (root, args, { lease, ...options } = {}) => {
        await lease.assertOwned();
        if (["GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_SHALLOW_FILE",
          "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].some(name => process.env[name])) {
          throw new Error("Release retention requires its ordinary local Git object/index context");
        }
        const result = await runGit(["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks",
          "-c", "core.fsmonitor=false", ...args], { ...options, cwd: root });
        await lease.assertOwned();
        return result;
      } });
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
    const authority = this.#readPreparationAuthority(canonicalPath(projectRoot));
    if (authority && !preparationGitIsolationActive()) return withPreparationGitIsolation(authority.isolation.dataDir,
      () => this.inspectMainChanges({ projectRoot, publishedRevision, approvedLocalMainCommit, approvedOriginMainCommit }));
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
      const commitIds = new Set([
        ...(localContainsPublished ? await revisionList(clone.releaseRoot, [localMain, `^${baseline}`]) : []),
        ...await revisionList(clone.releaseRoot, [originMain, `^${baseline}`]),
        ...(!localContainsPublished && publishedContainsLocal
          ? await revisionList(clone.releaseRoot, [baseline, `^${localMain}`])
          : []),
      ]);
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
        localContainsPublished,
        publishedContainsLocal,
        originContainsPublished,
        approved,
        approvalRequired: (commits.length > 0 || localMain !== originMain) && !approved,
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

  async #ensureClone(primary) {
    const layout = this.#layout(primary.root);
    const authority = this.#readPreparationAuthority(primary.root);
    const allowedStorage = authority ? path.join(authority.isolation.dataDir, "release-repositories") : this.releaseRepositoriesRoot;
    if (!pathInside(allowedStorage, layout.releaseRoot)) {
      throw new Error("release clone escaped its Agent Hub-owned root");
    }
    const gitFile = path.join(layout.releaseRoot, ".git");
    let created = false;
    if (!await fileExists(gitFile) && !await stat(gitFile).catch(() => null)) {
      if (authority) throw new Error("Registered isolated candidate is missing; preserve its original recovery");
      const upstream = await gitMaybe(["remote", "get-url", "origin"], { cwd: primary.root });
      if (!upstream) throw new Error(`release repository has no origin remote: ${primary.root}`);
      await mkdir(layout.root, { recursive: true });
      // Transport objects and refs, never repository-local configuration or
      // hooks. Use the same bundle boundary as validation/generation; Git's
      // clone protection remains enabled and the source hook setup is intact.
      const sourceRoot = this.#validationReferenceRoot ?? primary.root;
      const transportRoot = this.#validationBundle ? null
        : await mkdtemp(path.join(layout.root, "clone-source-"));
      const bundle = this.#validationBundle ?? path.join(transportRoot, "source.bundle");
      try {
        if (transportRoot) await runGit(["bundle", "create", bundle, "refs/heads/main"], {
          cwd: sourceRoot, timeoutMs: 300_000,
        });
        await runGit([
          "-c", "core.longpaths=true", "clone", "--single-branch", "--branch", "main",
          "--no-local", "--no-hardlinks", "--no-checkout",
          ...(this.#validationReferenceRoot ? ["--reference-if-able", this.#validationReferenceRoot] : []),
          bundle, layout.releaseRoot,
        ], { cwd: layout.root, timeoutMs: 300_000 });
      } finally {
        if (transportRoot) {
          if (!pathInside(layout.root, transportRoot) || path.dirname(transportRoot) !== layout.root) throw new Error("Clone transport escaped its owned root");
          await rm(transportRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
      }
      await runGit(["remote", "rename", "origin", "workspace"], { cwd: layout.releaseRoot });
      if (!this.#validationBundle) await runGit(["remote", "set-url", "workspace", sourceRoot], { cwd: layout.releaseRoot });
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
        timeoutMs: 300_000,
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
    const marker = {
      schemaVersion: 1,
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

  // This is the ordinary composer in a disposable owned repository, not a second
  // projection policy. No live candidate/checkpoint is promoted or rolled back.
  // The application owner holds Await/Task/dev leases and revalidates identities.
  async validateCandidate({
    planRevision, projectRoot, workspaceId = null, frozenTasks = [],
    approvedBaseCommit = null, baseProvenance = null, validateBeforeCommit = null, commitPrepared = null,
  } = {}) {
    this.#assertAvailable("validateCandidate");
    if (commitPrepared != null) throw new Error("Composition validation cannot commit Task acceptance");
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ah-composition-"));
    try {
      const isolated = new ReleaseGitWorkspaceService({
        dataDir: temporaryRoot, contourExternalEffects: this.#contourExternalEffects,
        environment: this.#environment,
        verifyNativeResolutionReview: this.verifyNativeResolutionReview,
      });
      // Copy Git objects/refs only, never local repository configuration or
      // hooks. Git's clone protection remains enabled for the bundle transport.
      // The live primary still supplies identity and invariant checks.
      const bundle = path.join(temporaryRoot, "source.bundle");
      const sourceRoot = await repositoryRoot(projectRoot);
      const mainCommit = await runGit(["rev-parse", "refs/heads/main"], { cwd: sourceRoot });
      await createSelectedGitBundle({ root: temporaryRoot, sourceRoot, bundle, mainCommit,
        inputs: [mainCommit, String(approvedBaseCommit ?? "").trim(),
          ...normalizedFrozenTasks(frozenTasks).map(task => task.resultCommit)],
        gitAt: (cwd, args, options) => runGit(args, { ...options, cwd, timeoutMs: 300_000 }) });
      isolated.#validationBundle = bundle;
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
    } finally {
      // Only the exact freshly allocated directory is owned by this invocation.
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  async #preparedGenerationSource({ projectRoot, workspaceId, planRevision, frozenTasks, approvedBaseCommit, baseProvenance, changelogContent }) {
    const layout = this.#layout(projectRoot);
    const stale = message => Object.assign(new Error(`${message}; prepare the current Await candidate through the normal owner`),
      { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
    return withInterprocessLocks([path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`)], async () => {
      const source = await this.frozenCandidate(projectRoot, { changelogContent }).catch(error => { throw stale(error.message); });
      const manifest = JSON.parse(await readFile(source.manifestFile, "utf8"));
      const tasks = normalizedFrozenTasks(frozenTasks);
      if (source.checkpointPhase !== "prepared" || manifest.compositionPolicy !== NATIVE_RELEASE_POLICY
          || source.planRevision !== planRevision || source.baseCommit !== approvedBaseCommit
          || String(manifest.workspaceId ?? "") !== String(workspaceId ?? "")
          || stableManifest(normalizedFrozenTasks(manifest.tasks)) !== stableManifest(tasks)
          || (manifest.baseProvenance?.publishedBaseCommit ?? null) !== (baseProvenance?.publishedBaseCommit ?? null)
          || ([manifest.baseProvenance?.kind, baseProvenance?.kind].includes(LOCAL_SOURCE_BASELINE_PROVENANCE)
            && stableManifest(manifest.baseProvenance) !== stableManifest(baseProvenance))) {
        throw stale("Prepared PreRelease selection, base or evidence is stale");
      }
      const git = (args, options = {}) => runGit(args, { ...options, cwd: source.releaseRoot });
      const historyAuthority = await this.#nativeHistoryAuthority({ projectRoot, provenance: manifest.baseProvenance,
        planRevision, tasks });
      await assertNativePreparedComposition({ git, baseCommit: source.baseCommit, tasks,
        historyAuthority,
        merges: manifest.merges, head: source.preReleaseHead, tree: source.tree,
        identity: { policy: NATIVE_RELEASE_POLICY, workspaceId, planRevision, baseCommit: source.baseCommit, tasks },
        verifyReview: this.verifyNativeResolutionReview });
      if (historyAuthority?.adoptions.length) await assertNativeUpstreamOrigin({
        git: (args, options = {}) => runGit(args, { ...options, cwd: projectRoot }),
        adoptions: historyAuthority.adoptions, originCommit: manifest.baseProvenance.approvedOriginMainCommit });
      else if (manifest.baseProvenance?.adoptions) await assertInstalledAgreedMainOrigin({
        provenance: manifest.baseProvenance,
        git: (args, options = {}) => runGit(args, { ...options, cwd: projectRoot }) });
      const binding = { kind: "native-prepared-release-v1", releaseRoot: source.releaseRoot,
        commit: source.preReleaseHead, tree: source.tree, manifestHash: source.manifestHash,
        checkpointSha256: sha256(await readFile(source.checkpointFile)),
        inputHash: sha256(stableManifest({ workspaceId, planRevision, approvedBaseCommit, tasks, baseProvenance,
          changelogHash: changelogContent === undefined ? "prepared" : changelogContent === null ? null : sha256(Buffer.from(changelogContent)) })) };
      return { binding, candidate: { ...source, baseProvenance, frozenTasks: tasks,
        mergedTaskIds: tasks.map(task => task.taskId),
        manifest: { ...manifest, ...(baseProvenance ? { baseProvenance } : {}), preparedCandidate: binding } } };
    });
  }

  async prepareGeneration({
    operationId, generation, planRevision, projectRoot, workspaceId = null,
    frozenTasks = [], approvedBaseCommit = null, baseProvenance = null,
    validateBeforeCommit = null, changelogContent = undefined, freezePublication = true,
    ephemeral = false,
  } = {}) {
    this.#assertAvailable("prepareGeneration");
    const operation = String(operationId ?? "").trim();
    const generationNumber = Number(generation);
    if (!operation || !Number.isSafeInteger(generationNumber) || generationNumber < 1) {
      throw new Error("release generation requires an operation id and positive generation");
    }
    const sourceRoot = await repositoryRoot(projectRoot);
    const generationIdentitySha256 = sha256(`${operation}:${generationNumber}:${sourceRoot}`);
    const generationKey = generationIdentitySha256.slice(0, 24);
    const generationDataDir = path.join(this.dataDir, "release-gens", generationKey);
    const lock = path.join(this.dataDir, "locks", `release-generation-${generationKey}`);
    return withInterprocessLocks([lock], async () => {
      try {
        await mkdir(generationDataDir, { recursive: true });
        const identityFile = path.join(generationDataDir, "identity.json");
        let identity = {
          schemaVersion: 1,
          operationId: operation,
          generation: generationNumber,
          repositoryRoot: sourceRoot,
          identitySha256: generationIdentitySha256,
        };
        const existingIdentity = await readJson(identityFile);
        const { preparedCandidate: existingPrepared, ...existingOwner } = existingIdentity ?? {};
        if (existingIdentity && JSON.stringify(existingOwner) !== JSON.stringify(identity)) {
          throw new Error("release generation directory identity collision");
        }
        if (existingPrepared) identity = existingIdentity;
        if (!existingIdentity) await writeJsonAtomic(identityFile, identity);
        const preparedInput = { projectRoot: sourceRoot, workspaceId, planRevision,
          frozenTasks, approvedBaseCommit, baseProvenance, changelogContent };
        const generationLayout = this.#layout(sourceRoot);
        const localCheckpointFile = path.join(generationDataDir, "release-repositories", generationLayout.repositoryKey, "checkpoint.json");
        const localCheckpoint = freezePublication ? await readJson(localCheckpointFile) : null;
        let preparedSource = null;
        if (freezePublication) {
          const inputHash = sha256(stableManifest({ workspaceId, planRevision, approvedBaseCommit,
            tasks: normalizedFrozenTasks(frozenTasks), baseProvenance,
            changelogHash: changelogContent === undefined ? "prepared" : changelogContent === null ? null : sha256(Buffer.from(changelogContent)) }));
          if (existingPrepared && existingPrepared.inputHash !== inputHash) {
            throw Object.assign(new Error("Original generation prepared input changed"), { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
          }
          if (!localCheckpoint?.publicationFreeze) {
            preparedSource = await this.#preparedGenerationSource(preparedInput);
            if (existingPrepared && stableManifest(existingPrepared) !== stableManifest(preparedSource.binding)) {
              throw Object.assign(new Error("Original generation prepared PreRelease changed"), { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
            }
            if (!existingPrepared) {
              if (localCheckpoint) throw new Error("Existing generation has no prepared candidate binding");
              identity = { ...identity, preparedCandidate: preparedSource.binding };
              await writeJsonAtomic(identityFile, identity);
            }
          } else if (!existingPrepared) throw new Error("Frozen generation has no original prepared binding");
        }
        const bundle = path.join(generationDataDir, "source.bundle");
        if (!ephemeral && !await fileExists(bundle)) {
          const mainCommit = await runGit(["rev-parse", "refs/heads/main"], { cwd: sourceRoot });
          const inputs = [mainCommit, String(approvedBaseCommit ?? "").trim(),
            ...normalizedFrozenTasks(frozenTasks).map(task => task.resultCommit)];
          // The prepared candidate is fetched by exact identity below. Capture
          // only main/base/selected result ancestry, never unrelated source refs.
          // Preserve partial output for this original generation's recovery.
          await createSelectedGitBundle({ root: generationDataDir, sourceRoot, bundle, inputs, mainCommit,
            gitAt: (cwd, args, options) => runGit(args, { ...options, cwd, timeoutMs: 300_000 }) });
        }
        const isolated = new ReleaseGitWorkspaceService({
          dataDir: generationDataDir,
          contourExternalEffects: this.#contourExternalEffects,
          environment: this.#environment,
          verifyNativeResolutionReview: this.verifyNativeResolutionReview,
        });
        if (ephemeral) isolated.#validationReferenceRoot = sourceRoot;
        else isolated.#validationBundle = bundle;
        const validatePrepared = async () => {
          if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
          if (!localCheckpoint?.publicationFreeze) {
            const current = await this.#preparedGenerationSource(preparedInput);
            if (stableManifest(current.binding) !== stableManifest(identity.preparedCandidate)) {
              throw Object.assign(new Error("Prepared PreRelease changed during generation capture"), { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
            }
          }
        };
        let candidate;
        if (!freezePublication) {
          candidate = await isolated.prepareCandidate({ planRevision, projectRoot, workspaceId, frozenTasks,
            approvedBaseCommit, baseProvenance, validateBeforeCommit, preserveFrozen: false });
        } else {
          const journal = await readJson(path.join(path.dirname(localCheckpointFile), "native-preparation.json"));
          if (localCheckpoint && (localCheckpoint.publicationFreeze || journal?.phase === "completed")) {
            const manifestFile = path.join(path.dirname(localCheckpointFile), "evidence", `${localCheckpoint.manifestHash}.json`);
            const bytes = await readFile(manifestFile);
            if (sha256(bytes) !== localCheckpoint.manifestHash) throw new Error("Generation manifest changed");
            const manifest = JSON.parse(bytes.toString("utf8"));
            if (stableManifest(manifest.preparedCandidate) !== stableManifest(identity.preparedCandidate)
                || manifest.planRevision !== planRevision || manifest.baseCommit !== approvedBaseCommit
                || stableManifest(normalizedFrozenTasks(manifest.tasks)) !== stableManifest(normalizedFrozenTasks(frozenTasks))) {
              throw new Error("Generation no longer binds its original prepared candidate");
            }
            candidate = { repositoryRoot: sourceRoot, releaseRoot: isolated.#layout(sourceRoot).releaseRoot,
              planRevision, baseCommit: approvedBaseCommit, baseProvenance, manifest, manifestFile,
              manifestHash: localCheckpoint.manifestHash, preReleaseHead: identity.preparedCandidate.commit,
              tree: identity.preparedCandidate.tree, frozenTasks: normalizedFrozenTasks(frozenTasks),
              mergedTaskIds: frozenTasks.map(task => task.taskId) };
            if (!localCheckpoint.publicationFreeze) await isolated.frozenCandidate(sourceRoot);
            await validatePrepared();
          } else {
            candidate = await isolated.promoteGenerationCandidate({ projectRoot: sourceRoot,
              candidate: preparedSource.candidate, validateBeforeCommit: validatePrepared });
          }
        }
        if (!freezePublication) {
          return {
            ...candidate,
            tree: await runGit(["rev-parse", `${candidate.preReleaseHead}^{tree}`], { cwd: candidate.releaseRoot }),
            operationId: operation,
            generation: generationNumber,
            generationRoot: generationDataDir,
          };
        }
        const frozenChangelog = changelogContent === undefined
          ? await readFile(path.join(candidate.releaseRoot, "CHANGELOG.md")).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          })
          : changelogContent;
        if (changelogContent !== undefined && !localCheckpoint?.publicationFreeze) {
          const changelogFile = path.join(candidate.releaseRoot, "CHANGELOG.md");
          if (frozenChangelog === null) await rm(changelogFile, { force: true });
          else await writeFile(changelogFile, Buffer.from(frozenChangelog));
        }
        await isolated.freezePublicationCandidate({
          projectRoot: sourceRoot,
          workspaceId,
          expectedPlanRevision: planRevision,
          expectedPreparedHead: candidate.preReleaseHead,
          changelogContent: frozenChangelog,
          reusePersistedChangelog: Boolean(localCheckpoint?.publicationFreeze),
          validateBeforeCommit: validatePrepared,
        });
        const frozen = await isolated.frozenCandidate(sourceRoot);
        const tree = await runGit(["rev-parse", `${frozen.preReleaseHead}^{tree}`], {
          cwd: frozen.releaseRoot,
        });
        return {
          ...candidate,
          ...frozen,
          frozenTasks: candidate.frozenTasks,
          mergedTaskIds: candidate.mergedTaskIds,
          tree,
          operationId: operation,
          generation: generationNumber,
          generationRoot: generationDataDir,
        };
      } catch (error) {
        if (ephemeral) {
          await rm(generationDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
            .catch((cleanupError) => { error.cleanupError = cleanupError; });
        }
        throw error;
      }
    });
  }

  async discardGenerationCandidate(candidate) {
    this.#assertAvailable("discardGenerationCandidate");
    const key = path.basename(String(candidate?.generationRoot ?? ""));
    if (!/^[a-f0-9]{24}$/u.test(key)) throw new Error("release generation cleanup identity required");
    return withInterprocessLocks([path.join(this.dataDir, "locks", `release-generation-${key}`)],
      lease => this.#discardGenerationCandidate(candidate, lease));
  }

  async #discardGenerationCandidate(candidate, lease) {
    this.#assertAvailable("discardGenerationCandidate");
    await lease.assertOwned();
    const releaseGenerationsRoot = path.join(this.dataDir, "release-gens");
    const generationRoot = canonicalPath(String(candidate?.generationRoot ?? ""));
    if (!generationRoot || samePath(generationRoot, releaseGenerationsRoot)
        || !pathInside(releaseGenerationsRoot, generationRoot)) {
      throw new Error("release generation cleanup requires an exact Agent Hub-owned generation root");
    }
    const identity = await readJson(path.join(generationRoot, "identity.json"));
    if (!identity
        || identity.operationId !== String(candidate?.operationId ?? "")
        || identity.generation !== Number(candidate?.generation)
        || identity.identitySha256 !== sha256(`${identity.operationId}:${identity.generation}:${identity.repositoryRoot}`)) {
      throw new Error("release generation cleanup identity changed");
    }
    // Promotion may replace candidate.releaseRoot with the live release clone.
    // Archive only the immutable generation's own repository evidence.
    const evidenceSource = path.join(generationRoot, "release-repositories",
      taskRepositoryKey(identity.repositoryRoot));
    const archiveRoot = path.join(this.dataDir, "release-generation-evidence", path.basename(generationRoot));
    await mkdir(archiveRoot, { recursive: true });
    const preserve = async (source, destination) => {
      const bytes = await readFile(source);
      const existing = await readFile(destination).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        if (!existing.equals(bytes)) throw new Error("release generation archive evidence changed");
        return;
      }
      const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await copyFile(source, temporary);
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    };
    const archiveIdentity = await readJson(path.join(archiveRoot, "identity.json"));
    if (archiveIdentity && JSON.stringify(archiveIdentity) !== JSON.stringify(identity)) {
      throw new Error("release generation evidence archive identity changed");
    }
    await preserve(path.join(generationRoot, "identity.json"), path.join(archiveRoot, "identity.json"));
    const entries = await readdir(evidenceSource, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isFile() && /^(checkpoint|publication-run-status|publication-run-log)\.(json|log)$/u.test(entry.name)) {
        await preserve(path.join(evidenceSource, entry.name), path.join(archiveRoot, entry.name));
      } else if (entry.isDirectory() && entry.name === "evidence") {
        const archivedEvidence = path.join(archiveRoot, "evidence");
        await mkdir(archivedEvidence, { recursive: true });
        for (const item of await readdir(path.join(evidenceSource, entry.name), { withFileTypes: true })) {
          if (item.isFile() && /\.(json|bin)$/u.test(item.name)) {
            await preserve(path.join(evidenceSource, entry.name, item.name), path.join(archivedEvidence, item.name));
          }
        }
      }
    }
    await lease.assertOwned();
    await rm(generationRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  async assertSelectedResultLineage({ candidate, previousSelectedResults = [] } = {}) {
    this.#assertAvailable("assertSelectedResultLineage");
    const previous = new Map((Array.isArray(previousSelectedResults) ? previousSelectedResults : [])
      .map((item) => [String(item?.taskId ?? ""), item]));
    for (const task of candidate?.frozenTasks ?? []) {
      const prior = previous.get(String(task.taskId));
      const priorResultCommit = String(prior?.resultCommit ?? "");
      if (priorResultCommit === task.resultCommit && prior
          && selectedCompositionIdentity(prior) !== selectedCompositionIdentity(task)) {
        throw new Error(`PreRelease selected proof lineage changed for Task ${task.taskId}`);
      }
      if (!priorResultCommit || priorResultCommit === task.resultCommit) continue;
      const related = await gitMaybe(["merge-base", "--is-ancestor", priorResultCommit, task.resultCommit], {
        cwd: candidate.releaseRoot,
      });
      if (related === null) {
        throw resultLineageMismatchError({ taskId: task.taskId, priorResultCommit, resultCommit: task.resultCommit });
      }
    }
  }

  // One-time lineage in the existing immutable manifest. Original receipts,
  // checkpoint bytes and source commits remain historical authorities, never
  // migration aliases or new inputs to an ordinary merge.
  async #nativeCutover(clone, checkpoint) {
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
  }

  async promoteGenerationCandidate({ projectRoot, candidate, validateBeforeCommit = null, commitPrepared = null } = {}) {
    this.#assertAvailable("promoteGenerationCandidate");
    if (!candidate?.releaseRoot || !candidate?.preReleaseHead || !candidate?.manifest) {
      throw new Error("prospective release generation is incomplete");
    }
    const initial = await primarySnapshot(projectRoot);
    const primaryFailure = primaryInvariantFailure(initial, "Await generation promotion");
    if (primaryFailure) throw new Error(primaryFailure);
    const layout = this.#layout(initial.root);
    const lock = path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`);
    return withInterprocessLocks([lock], async () => {
      const clone = await this.#ensureClone(initial).catch((error) => {
        throw new Error(`Await promotion could not open the managed release clone: ${error.message}`, { cause: error });
      });
      const dirty = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: clone.releaseRoot });
      if (dirty) throw new Error(`Agent Hub-owned release clone is dirty: ${clone.releaseRoot}: ${dirty}`);
      const branchRef = `refs/heads/${RELEASE_BRANCH}`;
      const observedBefore = {
        head: await runGit(["rev-parse", "HEAD^{commit}"], { cwd: clone.releaseRoot }),
        checkout: await gitMaybe(["symbolic-ref", "-q", "HEAD"], { cwd: clone.releaseRoot }),
        branch: await gitMaybe(["rev-parse", `${branchRef}^{commit}`], { cwd: clone.releaseRoot }),
        checkpoint: await readJson(clone.checkpointFile),
        checkpointBytes: await readFile(clone.checkpointFile).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        }),
      };
      const journalFile = path.join(layout.root, "native-preparation.json");
      let journal = await readJson(journalFile);
      const pending = journal && !["completed", "rolled_back"].includes(journal.phase);
      if (pending && (journal.kind !== "native-generation-promotion-v1"
          || journal.target !== candidate.preReleaseHead
          || journal.sourceManifestHash !== candidate.manifestHash
          || journal.sourceRoot !== candidate.releaseRoot)) {
        throw Object.assign(new Error("A different native preparation remains unresolved"), { code: "AWAIT_PREPARATION_UNKNOWN" });
      }
      const before = pending ? { ...journal.before,
        checkpointBytes: journal.before.checkpointBytes === null ? null
          : Buffer.from(journal.before.checkpointBytes, "base64") } : observedBefore;
      await runGit(["fetch", "--no-tags", candidate.releaseRoot, candidate.preReleaseHead], {
        cwd: clone.releaseRoot, timeoutMs: 300_000,
      }).catch((error) => {
        throw new Error(`Await promotion could not import ${candidate.releaseRoot}@${candidate.preReleaseHead}: ${error.message}`, { cause: error });
      });
      const imported = await runGit(["rev-parse", "FETCH_HEAD^{commit}"], { cwd: clone.releaseRoot });
      if (imported !== candidate.preReleaseHead) throw new Error("prospective release generation identity changed during import");
      const importedTree = await runGit(["rev-parse", `${imported}^{tree}`], { cwd: clone.releaseRoot });
      if (candidate.tree && importedTree !== candidate.tree) throw new Error("prospective release generation tree changed during import");
      if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
      const cutover = pending ? journal.manifest.cutover : await this.#nativeCutover(clone, before.checkpoint);
      const manifest = {
        ...candidate.manifest,
        primaryRoot: initial.root,
        primaryGitCommonDir: initial.commonDir,
        releaseRoot: clone.releaseRoot,
        releaseGitCommonDir: clone.releaseGitCommonDir,
        ...(cutover ? { cutover } : {}),
      };
      const manifestText = stableManifest(manifest);
      const manifestHash = sha256(manifestText);
      const manifestFile = path.join(clone.evidenceRoot, `${manifestHash}.json`);
      const previousRef = before.branch || "0".repeat(40);
      let promoted = await gitMaybe(["rev-parse", `${branchRef}^{commit}`], { cwd: clone.releaseRoot }) === imported;
      const exactCheckout = async (head) => {
        if (await runGit(["rev-parse", "HEAD^{commit}"], { cwd: clone.releaseRoot }) !== head
            || await runGit(["write-tree"], { cwd: clone.releaseRoot }) !== await runGit(["rev-parse", `${head}^{tree}`], { cwd: clone.releaseRoot })
            || await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: clone.releaseRoot })) {
          throw Object.assign(new Error("Generation checkout changed; private bytes retained"), { code: "AWAIT_PREPARATION_UNKNOWN" });
        }
      };
      const validate = async () => {
        if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
        const current = await primarySnapshot(initial.root);
        if (current.mainCommit !== initial.mainCommit || current.headCommit !== initial.headCommit
            || current.branchRef !== initial.branchRef || current.dirty.fingerprint !== initial.dirty.fingerprint
            || current.dirty.indexFingerprint !== initial.dirty.indexFingerprint) {
          throw new Error("Registered primary changed during native generation promotion");
        }
      };
      if (!pending) {
        journal = { version: 1, policy: NATIVE_RELEASE_POLICY, kind: "native-generation-promotion-v1",
          phase: "prepared", target: imported, targetTree: importedTree, manifestHash, manifest,
          sourceRoot: candidate.releaseRoot, sourceManifestHash: candidate.manifestHash,
          before: { ...before, checkpointBytes: before.checkpointBytes?.toString("base64") ?? null } };
        await writeJsonAtomic(journalFile, journal);
      } else if (journal.version !== 1 || journal.policy !== NATIVE_RELEASE_POLICY
          || journal.manifestHash !== manifestHash || journal.targetTree !== importedTree) {
        throw Object.assign(new Error("Native generation promotion journal changed"), { code: "AWAIT_PREPARATION_UNKNOWN" });
      }
      try {
        await mkdir(clone.evidenceRoot, { recursive: true });
        if (!await fileExists(manifestFile)) await writeFile(manifestFile, manifestText, { flag: "wx", encoding: "utf8" });
        else if (sha256(await readFile(manifestFile)) !== manifestHash) throw new Error("Native generation manifest changed");
        const currentHead = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: clone.releaseRoot });
        const currentBranch = await gitMaybe(["rev-parse", `${branchRef}^{commit}`], { cwd: clone.releaseRoot });
        if (![before.head, imported].includes(currentHead) || ![before.branch, imported].includes(currentBranch)) {
          throw Object.assign(new Error("Native generation state is unknown"), { code: "AWAIT_PREPARATION_UNKNOWN" });
        }
        await exactCheckout(currentHead);
        await validate();
        if (currentHead !== imported) await runGit(["checkout", "--detach", "--no-overwrite-ignore", imported], { cwd: clone.releaseRoot });
        await exactCheckout(imported);
        await validate();
        if (currentBranch !== imported) await runGit(["update-ref", branchRef, imported, previousRef], { cwd: clone.releaseRoot });
        promoted = true;
        await writeJsonAtomic(clone.checkpointFile, {
          schemaVersion: 2,
          phase: "prepared",
          ...(manifest.compositionPolicy ? { compositionPolicy: manifest.compositionPolicy } : {}),
          planRevision: candidate.planRevision,
          manifestHash,
          manifestFile,
          baseCommit: candidate.baseCommit,
          ...(candidate.baseProvenance ? { baseProvenance: candidate.baseProvenance } : {}),
          preReleaseHead: imported,
          updatedAt: new Date().toISOString(),
        });
        await runGit(["symbolic-ref", "HEAD", branchRef], { cwd: clone.releaseRoot });
        await exactCheckout(imported);
        const result = {
          ...candidate,
          repositoryRoot: initial.root,
          releaseRoot: clone.releaseRoot,
          releaseGitCommonDir: clone.releaseGitCommonDir,
          primaryGitCommonDir: initial.commonDir,
          manifest,
          manifestHash,
          manifestFile,
          preReleaseHead: imported,
          tree: importedTree,
          branch: RELEASE_BRANCH,
          primaryPreserved: true,
        };
        await validate();
        if (commitPrepared) await commitPrepared(result);
        journal.phase = "completed";
        try { await writeJsonAtomic(journalFile, journal); }
        catch (error) { throw Object.assign(new Error("Native generation terminal persistence is unknown"), { code: "AWAIT_PREPARATION_UNKNOWN", cause: error }); }
        return result;
      } catch (error) {
        if (["AWAIT_PREPARATION_UNKNOWN", "AWAIT_ACCEPTANCE_UNKNOWN"].includes(error?.code)) throw error;
        try {
          if (promoted) {
            await exactCheckout(imported);
            await runGit(["checkout", "--detach", "--no-overwrite-ignore", before.head], { cwd: clone.releaseRoot });
            await exactCheckout(before.head);
            if (before.branch) await runGit(["update-ref", branchRef, before.branch, imported], { cwd: clone.releaseRoot });
            else await runGit(["update-ref", "-d", branchRef, imported], { cwd: clone.releaseRoot });
          }
          if (before.checkpointBytes) await writeFile(clone.checkpointFile, before.checkpointBytes);
          else await rm(clone.checkpointFile, { force: true });
          if (before.checkout) {
            if (!promoted) {
              const head = await runGit(["rev-parse", "HEAD^{commit}"], { cwd: clone.releaseRoot });
              await exactCheckout(head);
              if (![before.head, imported].includes(head)) throw new Error("Generation rollback head changed");
              if (head !== before.head) await runGit(["checkout", "--detach", "--no-overwrite-ignore", before.head], { cwd: clone.releaseRoot });
              await exactCheckout(before.head);
            }
            await runGit(["symbolic-ref", "HEAD", before.checkout], { cwd: clone.releaseRoot });
          } else {
            await exactCheckout(before.head);
          }
          journal.phase = "rolled_back";
          await writeJsonAtomic(journalFile, journal);
        } catch (rollbackError) {
          rollbackError.code = "AWAIT_PREPARATION_UNKNOWN";
          throw rollbackError;
        }
        throw error;
      }
    });
  }

  async deriveInstalledLocalSourceBaselineForSelection({ projectRoot, planRevision, tasks,
    publishedRevision, adoptions = [] }) {
    const initial = await primarySnapshot(projectRoot);
    await this.assertPrimaryInvariant(initial.root, { phase: "ordinary Await installed source binding" });
    if (publishedRevision !== await durablePublishedRevision(this.#environment, initial.root)) {
      throw new Error("Ordinary Await published baseline changed");
    }
    const git = (args, options = {}) => runGit(args, { ...options, cwd: initial.root, timeoutMs: 300_000 });
    const actual = await readNativeUpstreamAdoptions({ git, tasks, repositoryRoot: initial.root,
      localMainCommit: initial.mainCommit });
    const pins = actual.map(({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit }) =>
      ({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit }));
    if (JSON.stringify(pins) !== JSON.stringify(adoptions)) {
      throw new Error("Ordinary Await selected adoption evidence changed");
    }
    const provenance = await installedNativeHistoryBaseline({ git,
      sourceGit: (cwd, args) => runGit(args, { cwd, timeoutMs: 300_000 }),
      repositoryRoot: initial.root, primaryMainCommit: initial.mainCommit, publishedRevision,
      runtimeRoot: defaultRuntimeRoot({ environment: this.#environment }), planRevision, tasks, adoptions: actual });
    if (!provenance && pins.length) throw new Error("Ordinary adopted Await has no verified installed source baseline");
    return provenance;
  }

  async validateLocalSourceBaseline({ projectRoot, provenance, planRevision, tasks }) {
    const initial = await primarySnapshot(projectRoot);
    await this.assertPrimaryInvariant(initial.root, { phase: "local source baseline verification" });
    return assertInstalledLocalSourceBaseline({ provenance, planRevision, tasks,
      repositoryRoot: initial.root,
      primaryMainCommit: initial.mainCommit,
      publishedRevision: await durablePublishedRevision(this.#environment, initial.root),
      runtimeRoot: defaultRuntimeRoot({ environment: this.#environment }),
      git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root, timeoutMs: 300_000 }),
    });
  }

  async #nativeHistoryAuthority({ projectRoot, provenance, planRevision, tasks }) {
    if (provenance?.kind === LOCAL_SOURCE_BASELINE_PROVENANCE) {
      const verified = await this.validateLocalSourceBaseline({ projectRoot, provenance, planRevision, tasks });
      return { bases: [verified.provenance.sourceBaseCommit], metadataBases: verified.metadataBases,
        adoptions: verified.adoptions ?? [] };
    }
    const initial = await primarySnapshot(projectRoot);
    const adoptions = await readNativeUpstreamAdoptions({
      git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }), tasks,
      repositoryRoot: initial.root, localMainCommit: initial.mainCommit });
    // New incoming plus an installed carry must be sealed together in the
    // existing exact local-source envelope, not inferred from a moving origin.
    if (adoptions.length) throw new Error("Native adopted history requires its exact installed-source preparation binding");
    return null;
  }

  async inspectNativeAwaitRecovery({ projectRoot, original, frozenTasks }) {
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

  async archivedNativeAwaitOriginal({ projectRoot, operationId }) {
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

  async planPreparationIsolation({ requestId, argumentsHash, originalPreparation, preparation, devInventory, previousIsolation = null }) {
    if (previousIsolation) {
      const expected = preparationIsolationLayout(this.dataDir, preparation.repositories[0].projectRoot, requestId, argumentsHash);
      if (previousIsolation.key !== expected.key || previousIsolation.dataDir !== expected.dataDir) {
        throw new Error("Retained preparation isolation namespace changed");
      }
      await assertPlainIsolationPath(expected.dataDir);
      return structuredClone(previousIsolation);
    }
    const repository = preparation.repositories[0], projectRoot = canonicalPath(repository.projectRoot);
    const layout = preparationIsolationLayout(this.dataDir, projectRoot, requestId, argumentsHash);
    await assertPlainIsolationPath(layout.dataDir);
    const legacyRoot = path.join(this.releaseRepositoriesRoot, taskRepositoryKey(projectRoot));
    await assertPlainIsolationPath(legacyRoot);
    const checkpointFile = path.join(legacyRoot, "checkpoint.json");
    for (const file of [checkpointFile, path.join(legacyRoot, "native-preparation.json")]) {
      const entry = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.size > 512 * 1024)) {
        throw new Error(`Legacy preparation inventory record is unsafe or oversized: ${file}`);
      }
    }
    const checkpoint = await readFile(checkpointFile), legacyCheckpoint = JSON.parse(checkpoint.toString("utf8"));
    const legacyJournal = await readJson(path.join(legacyRoot, "native-preparation.json"));
    // Isolation excludes late legacy writes; it must not silently manufacture
    // another candidate if this original already has an unadopted legacy body.
    // Resumes of our isolated body use previousIsolation above and remain exact.
    const legacyOriginalEffect = legacyCheckpoint.preflightRequestId === requestId
      || legacyJournal?.requestId === requestId && !["completed", "rolled_back"].includes(legacyJournal.phase);
    const primary = await primarySnapshot(projectRoot);
    const configHash = sha256(await readFile(path.join(primary.commonDir, "config")));
    const inheritedConfigHash = sha256(await runGit(["config", "--null", "--show-origin", "--show-scope", "--list"],
      { cwd: primary.root, rawOutput: true }));
    const inheritedGitEnvironment = Object.entries(process.env).filter(([key]) => /^GIT_/iu.test(key))
      .map(([key, value]) => ({ key, valueHash: sha256(value) })).sort((a, b) => a.key.localeCompare(b.key));
    const targets = { legacyGit: primary.commonDir, legacyDevWorktree: devInventory?.projectRoot ?? null,
      legacyCandidate: { root: legacyRoot, checkout: path.join(legacyRoot, "repository"),
        checkpoint: path.join(legacyRoot, "checkpoint.json"), journal: path.join(legacyRoot, "native-preparation.json"),
        marker: path.join(legacyRoot, "repository", ".git", RELEASE_MARKER),
        staging: path.join(legacyRoot, "native-merges"), evidence: path.join(legacyRoot, "evidence") },
      newGitAndMetadata: layout.dataDir, sql: { database: path.join(this.dataDir, "journal.sqlite"),
        table: "hub_mcp_operations", requestId,
        field: "preparation_state_json", legacyFence: "hub_preparation_forward_legacy_fence" },
      excluded: ["primary refs/index/worktree", "dev mutation", "legacy candidate writes", "remote ref writes",
        "publication state/receipts", "Task status"],
      locks: { owner: "existing Await/Task/repository/candidate leases",
        paths: path.join(this.dataDir, "locks"), processGuards: path.join(this.dataDir, "task-process-tree-guards") },
      localGit: "independent bundle objects; no global/system/env path configuration/templates/hooks/fsmonitor/auto-maintenance",
      remoteReads: "existing credential owner; ls-remote only, no ref writes",
      excludedPublication: { state: publicationStateFile(this.#environment),
        run: publicationRunPaths(this.#environment).statusFile, checkpoint: publicationCheckpointFile(this.#environment),
        operations: path.join(this.dataDir, "runtime.sqlite") },
      diagnostics: "existing original-ID timing/log append; no candidate or publication authority" };
    return { schemaVersion: 1, kind: "preparation-isolated-git-v1", ...layout, projectRoot,
      requestId, argumentsHash, originalSourceClosureHash: originalPreparation.sourceClosureHash,
      originMainCommit: repository.originMainCommit, previousCheckpointHash: repository.checkpointHash,
      legacyCheckpointHash: sha256(checkpoint), legacyOriginalEffect,
      legacyJournalHash: legacyJournal ? isolationDigest(legacyJournal) : null, legacyConfigurationHash: configHash,
      inheritedConfigHash, inheritedGitEnvironment,
      targets, writeTargetsHash: isolationDigest(targets) };
  }

  async inspectIsolationMainPins({ projectRoot, publishedRevision, approvedLocalMainCommit, approvedOriginMainCommit }) {
    const primary = await primarySnapshot(projectRoot);
    const origin = (await runGit(["ls-remote", "origin", "refs/heads/main"], { cwd: primary.root })).split(/\s/u)[0];
    if (primary.mainCommit !== approvedLocalMainCommit || origin !== approvedOriginMainCommit) {
      throw new Error("Isolated preparation reviewed main/origin pins changed");
    }
    return { projectRoot: primary.root, publishedRevision, localMain: primary.mainCommit,
      originMain: origin, approved: true, approvalRequired: false };
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
    const isolated = new ReleaseGitWorkspaceService({ dataDir: expected.dataDir,
      contourExternalEffects: this.#contourExternalEffects, environment: this.#environment,
      verifyNativeResolutionReview: this.verifyNativeResolutionReview });
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
        gitAt: (cwd, args, extra) => runGit(args, { ...extra, cwd, timeoutMs: 300_000 }) });
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
    nativeResolutionReview = null, nativeAwaitRecovery = null, forwardPreparation = null,
  } = {}) {
    this.#assertAvailable("prepareCandidate");
    const isolation = forwardPreparation?.readIsolation?.();
    if (isolation && !this.#isolationContext) return this.#prepareIsolatedCandidate({
      planRevision, projectRoot, workspaceId, preflightRequestId, frozenTasks, approvedBaseCommit, baseProvenance,
      validateBeforeCommit, preserveFrozen, commitPrepared, preparationGuard, nativeResolutionReview,
      nativeAwaitRecovery, forwardPreparation }, isolation);
    const authority = this.#readPreparationAuthority(canonicalPath(projectRoot));
    if (authority && !preparationGitIsolationActive()) return withPreparationGitIsolation(authority.isolation.dataDir,
      () => this.prepareCandidate({ planRevision, projectRoot, workspaceId, preflightRequestId, frozenTasks,
        approvedBaseCommit, baseProvenance, validateBeforeCommit, preserveFrozen, commitPrepared, preparationGuard,
        nativeResolutionReview, nativeAwaitRecovery, forwardPreparation }));
    if (authority && authority.phase !== "completed" && preflightRequestId !== authority.requestId) {
      throw new Error("Isolated original preparation still owns this candidate");
    }
    const revision = String(planRevision ?? "").trim();
    const initial = await primarySnapshot(projectRoot);
    await this.assertPrimaryInvariant(initial.root, { phase: "native release preparation" });
    const baseCommit = String(approvedBaseCommit ?? "").trim();
    const localSource = baseProvenance?.kind === LOCAL_SOURCE_BASELINE_PROVENANCE
      ? normalizedBaseProvenance(baseProvenance, baseCommit) : null;
    if (!revision || !/^[a-f0-9]{40}$/u.test(baseCommit)
        || (localSource ? localSource.agreedMainCommit !== initial.mainCommit : baseCommit !== initial.mainCommit)) {
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
    const preparationLockStarted = preparationGuard ? performance.now() : null;
    return withInterprocessLocks([lock], async () => {
      if (preparationGuard) recordTaskOperationTiming("preparation:candidate-lock-wait", {
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
        : await this.#ensureClone(initial);
      if (this.#isolationContext) await this.#assertIsolationClone(clone, this.#isolationContext);
      const git = (args, options = {}) => runGit(args, { ...options, cwd: clone.releaseRoot, timeoutMs: 300_000 });
      const checkpoint = await readJson(clone.checkpointFile);
      if (forwardPreparation) {
        if (!preparationGuard || !preflightRequestId || typeof commitPrepared !== "function"
            || typeof forwardPreparation.observeEffects !== "function") throw new Error("Forward preparation owning boundaries are incomplete");
        const journalFile = path.join(layout.root, "native-preparation.json");
        const boundedRecord = async file => {
          const entry = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          if (!entry) return null;
          if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 512 * 1024) throw new Error("Forward preparation effect record is unsafe or oversized");
          const bytes = await readFile(file);
          return { sha256: sha256(bytes), bytes: bytes.length, value: JSON.parse(bytes) };
        };
        const journalRecord = await boundedRecord(journalFile), journal = journalRecord?.value;
        const checkpointBytes = await readFile(clone.checkpointFile).catch(error => {
          if (this.#isolationContext && error.code === "ENOENT") return null; throw error;
        });
        const nativeRoot = path.join(layout.root, "native-merges");
        const nativeInfo = await lstat(nativeRoot).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (nativeInfo && (!nativeInfo.isDirectory() || nativeInfo.isSymbolicLink())) throw new Error("Forward native staging custody changed");
        const entries = await readdir(nativeRoot, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
        if (entries.length > 64) throw new Error("Forward native inventory exceeds its explicit bound");
        const native = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const folder = path.join(nativeRoot, entry.name), info = await lstat(folder);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Forward native root custody changed");
          const merge = await boundedRecord(path.join(folder, "merge.json"));
          const bundle = await lstat(path.join(folder, "source.bundle")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          if (bundle && (!bundle.isFile() || bundle.isSymbolicLink())) throw new Error("Forward native transport custody changed");
          native.push({ root: entry.name, mergeHash: merge?.sha256 ?? null,
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
            verifyReview: this.verifyNativeResolutionReview });
          const current = await primarySnapshot(initial.root);
          const remote = await git(["ls-remote", "origin", "refs/heads/main"]);
          if (current.mainCommit !== preparationGuard.primaryMainCommit || current.headCommit !== initial.headCommit
              || current.branchRef !== initial.branchRef || current.dirty.indexFingerprint !== initial.dirty.indexFingerprint
              || current.dirty.fingerprint !== initial.dirty.fingerprint
              || remote.split(/\s/u)[0] !== preparationGuard.originMainCommit) throw new Error("Forward adoption current main/origin changed");
          if (localSource) await assertInstalledLocalSourceBaseline({ provenance: localSource, git,
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
          throw new ReleasePreparationRejectedError("Preparation current main or remote changed");
        }
      };
      await validatePreparationMain();
      if (this.#isolationContext) {
        if (checkpoint || await gitMaybe(["rev-parse", "refs/heads/PreRelease^{commit}"], { cwd: clone.releaseRoot })
            || await git(["rev-parse", "HEAD^{commit}"]) !== initial.mainCommit
            || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
          throw new ReleasePreparationRejectedError("Isolated first candidate checkpoint/ref/checkout is not pristine");
        }
      } else await assertPreparationCheckpoint({ guard: preparationGuard, clone, initial, checkpoint, git });
      await git(["fetch", "--prune", "workspace", "+refs/heads/main:refs/remotes/workspace/main"]);
      for (const commit of [baseCommit, ...tasks.map((task) => task.resultCommit)]) {
        if (await gitMaybe(["cat-file", "-e", `${commit}^{commit}`], { cwd: clone.releaseRoot }) === null) {
          await git(["fetch", "workspace", commit]);
        }
      }
      const validateLocalSource = async () => {
        if (localSource) await assertInstalledLocalSourceBaseline({ provenance: localSource, git,
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
      await assertNativeTaskHistories({ git, baseCommit, tasks, historyAuthority });
      const identity = { policy: NATIVE_RELEASE_POLICY, workspaceId, planRevision: revision, baseCommit, tasks };
      const mergeRoot = path.join(layout.root, "native-merges", sha256(stableManifest(identity)).slice(0, 24));
      const composition = await mergeSelectedResults({
        root: mergeRoot, sourceRoot: clone.releaseRoot, baseCommit, tasks, identity,
        resolutionReview: nativeResolutionReview, verifyReview: this.verifyNativeResolutionReview,
        deliveredHead: checkpoint?.preReleaseHead ?? null,
        gitAt: (cwd, args, options = {}) => runGit(args, { ...options, cwd, timeoutMs: 300_000 }),
        readJson, writeJson: writeJsonAtomic,
      }).catch(error => {
        // Only private native staging has changed at this boundary. Keep its
        // issued checkout for resolution without making a definite conflict
        // an unrecoverable unknown preparation receipt.
        if (preparationGuard && error.code === "RELEASE_NATIVE_MERGE_CONFLICT") {
          throw Object.assign(new ReleasePreparationRejectedError(error.message, { cause: error }),
            { conflictRoot: error.conflictRoot, conflicts: error.conflicts });
        }
        throw error;
      });
      // Exact approved tree follows the verified native ordered merge history.
      // Legacy per-file owned-union projection is not a native authority.
      if (preparationGuard && (composition.tree !== preparationGuard.approvedTree
          || baseCommit !== preparationGuard.approvedBaseCommit)) {
        throw new ReleasePreparationRejectedError("Full selected/joint preparation tree differs from the reviewed tree");
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
      const validate = async () => {
        if (typeof validateBeforeCommit === "function") await validateBeforeCommit();
        await validatePreparationMain();
        const current = await primarySnapshot(initial.root);
        await this.assertPrimaryInvariant(initial.root, { phase: "native release promotion" });
        if (current.mainCommit !== (localSource?.agreedMainCommit ?? baseCommit) || current.headCommit !== initial.headCommit
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
        historyAuthority = await this.#nativeHistoryAuthority(historyRequest);
        await assertNativeTaskHistories({ git, baseCommit, tasks, historyAuthority });
        if (historyAuthority?.adoptions.length) await assertNativeUpstreamOrigin({
          git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }),
          adoptions: historyAuthority.adoptions, originCommit: localSource.approvedOriginMainCommit });
        else if (localSource?.adoptions) await assertInstalledAgreedMainOrigin({ provenance: localSource,
          git: (args, options = {}) => runGit(args, { ...options, cwd: initial.root }) });
        if (nativeAwaitRecovery) {
          const remote = await git(["ls-remote", "origin", "refs/heads/main"]);
          if (remote.split(/\s/u)[0] !== nativeAwaitRecovery.originMainCommit) {
            throw Object.assign(new Error("Original Await origin changed after archive"), { code: "AWAIT_PREPARATION_UNKNOWN" });
          }
        }
      };
      const requireCheckout = async (head) => {
        if (await git(["rev-parse", "HEAD^{commit}"]) !== head
            || await git(["write-tree"]) !== await git(["rev-parse", `${head}^{tree}`])
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
        const baseBinding = await assertFreezeBaseProvenance(layout,
          await durablePublishedRevision(this.#environment, marker.primaryRoot));
        if (baseBinding.provenance?.kind === LOCAL_SOURCE_BASELINE_PROVENANCE) {
          await this.validateLocalSourceBaseline({ projectRoot: marker.primaryRoot, ...baseBinding });
        }
        const result = await freezePreparedPublicationCandidate({
          runtimeRoot: defaultRuntimeRoot({ environment: this.#environment }),
          ...options, layout, marker, workspaceId,
          validateBeforeCommit: async () => {
            await options.validateBeforeCommit?.();
            if (baseBinding.provenance?.kind === LOCAL_SOURCE_BASELINE_PROVENANCE) {
              await this.validateLocalSourceBaseline({ projectRoot: marker.primaryRoot, ...baseBinding });
            }
          },
        });
        const final = await this.assertPrimaryInvariant(projectRoot, { phase: "publication freeze completion" });
        if (initial.headCommit !== final.headCommit || initial.indexFingerprint !== final.indexFingerprint
          || initial.dirtyFingerprint !== final.dirtyFingerprint) throw new Error("primary Workspace changed during publication freeze");
        return result;
      });
    });
  }

  async recoverFreezingPublicationCandidate({
    projectRoot, workspaceId, requestId, sourceIdentity, expected = {}, confirm = false, expectedProofHash = null,
    recoveryMode = FREEZING_RECOVERY_MODE, missingProvenanceRecovery = null, missingProvenanceResolver = null,
  } = {}) {
    this.#assertAvailable("recoverFreezingPublicationCandidate");
    const operationId = String(requestId ?? "").trim();
    if (!operationId) throw new Error("publication freeze recovery requires an operation request ID");
    if (!String(workspaceId ?? "").trim()) throw new Error("publication freeze recovery requires its Workspace");
    const verifiedSource = {
      commit: String(sourceIdentity?.commit ?? "").trim().toLowerCase(),
      ownerSha256: String(sourceIdentity?.ownerSha256 ?? "").trim().toLowerCase(),
    };
    if (!/^[a-f0-9]{40}$/u.test(verifiedSource.commit)
        || !/^[a-f0-9]{64}$/u.test(verifiedSource.ownerSha256)) {
      throw new Error("publication freeze recovery requires the verified source identity");
    }
    if (![FREEZING_RECOVERY_MODE, FAILED_FROZEN_RECOVERY_MODE].includes(recoveryMode)) {
      throw new Error("publication freeze recovery mode is unsupported");
    }
    const missingProvenance = missingProvenanceRecovery == null ? null : {
      request: missingProvenanceRecovery, resolver: missingProvenanceResolver,
    };
    if (missingProvenance && (recoveryMode !== FAILED_FROZEN_RECOVERY_MODE
        || typeof missingProvenanceResolver !== "function")) {
      throw new Error("missing-provenance recovery applies only to failed-frozen recovery with its owner resolver");
    }
    return withPublicationLock(async () => this.withAwaitTransition(workspaceId, async () => {
      const initial = await this.assertPrimaryInvariant(projectRoot, { phase: "publication freeze recovery" });
      const layout = this.#layout(initial.projectRoot);
      const repositoryLock = path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`);
      return withInterprocessLocks([repositoryLock], async () => {
        const marker = await assertReleaseCloneForPublication({ repositoryRoot: layout.releaseRoot });
        if (!samePath(marker.primaryRoot, initial.projectRoot)) {
          throw new Error("publication freeze recovery clone belongs to another primary");
        }
        const result = await this.#recoverFreezingPublicationCandidateOwned({
          layout, marker, workspaceId: String(workspaceId), operationId, sourceIdentity: verifiedSource, expected,
          confirm, expectedProofHash: String(expectedProofHash ?? "").trim().toLowerCase() || null, recoveryMode,
          missingProvenance,
        });
        const final = await this.assertPrimaryInvariant(projectRoot, { phase: "publication freeze recovery completion" });
        if (initial.headCommit !== final.headCommit || initial.indexFingerprint !== final.indexFingerprint
          || initial.dirtyFingerprint !== final.dirtyFingerprint) {
          throw new Error("primary Workspace changed during publication freeze recovery");
        }
        return result;
      });
    }), { environment: this.#environment });
  }

  async #recoverFreezingPublicationCandidateOwned({
    layout, marker, workspaceId, operationId, sourceIdentity, expected, confirm, expectedProofHash, recoveryMode,
    missingProvenance = null,
  }) {
    const checkpointBytes = await readFile(layout.checkpointFile);
    let checkpoint = JSON.parse(checkpointBytes.toString("utf8"));
    if (["abandoning", "abandoned"].includes(checkpoint?.phase)) {
      if (checkpoint.recovery?.schemaVersion !== 2) {
        if (missingProvenance) throw new Error("legacy freezing recovery cannot carry missing-provenance recovery");
        return this.#resumeLegacyPublicationRecoveryOwned({
          layout, workspaceId, operationId, sourceIdentity, expected, confirm, expectedProofHash,
          recoveryMode, checkpoint,
        });
      }
      return this.#resumePublicationRecoveryOwned({
        layout, marker, workspaceId, operationId, sourceIdentity, expected, confirm, expectedProofHash,
        recoveryMode, checkpoint, missingProvenance,
      });
    }
    const requiredPhase = recoveryMode === FAILED_FROZEN_RECOVERY_MODE ? "frozen" : "freezing";
    if (checkpoint?.phase !== requiredPhase) {
      throw new Error(`publication freeze recovery requires an exact ${requiredPhase} attempt`);
    }
    if (!checkpoint?.publicationFreeze || !checkpoint?.manifestHash || !checkpoint?.preReleaseHead) {
      throw new Error("publication freeze recovery checkpoint is incomplete");
    }
    const manifestFile = path.join(layout.evidenceRoot, `${checkpoint.manifestHash}.json`);
    if (checkpoint.manifestFile && !samePath(checkpoint.manifestFile, manifestFile)) {
      throw new Error("publication freeze recovery manifest path changed");
    }
    const manifestBytes = await readFile(manifestFile);
    if (sha256(manifestBytes) !== checkpoint.manifestHash) {
      throw new Error("publication freeze recovery manifest digest changed");
    }
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (!samePath(manifest.primaryRoot, marker.primaryRoot)
        || !samePath(manifest.releaseRoot, layout.releaseRoot)
        || manifest.workspaceId !== workspaceId
        || manifest.planRevision !== checkpoint.planRevision
        || manifest.publication?.head !== checkpoint.preReleaseHead
        || manifest.publication?.preparedHead !== checkpoint.publicationFreeze.preparedHead) {
      throw new Error("publication freeze recovery manifest identity changed");
    }
    for (const operation of [
      "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "index.lock",
    ]) {
      const pending = await lstat(path.join(marker.releaseGitCommonDir, operation)).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (pending) throw new Error(`publication freeze recovery refuses pending Git operation: ${operation}`);
    }
    const frozenHead = checkpoint.preReleaseHead;
    const frozenTree = await runGit(["rev-parse", `${frozenHead}^{tree}`], { cwd: layout.releaseRoot });
    const intent = checkpoint.publicationFreeze;
    const baseProvenance = normalizedBaseProvenance(checkpoint.baseProvenance, checkpoint.baseCommit);
    if (stableManifest(baseProvenance) !== stableManifest(
      normalizedBaseProvenance(manifest.baseProvenance, manifest.baseCommit),
    ) || manifest.baseCommit !== checkpoint.baseCommit) {
      throw new Error("publication freeze recovery base provenance disagrees with its immutable manifest");
    }
    const supplemental = missingProvenance ? await this.#missingProvenanceAuthority({
      missingProvenance, layout, workspaceId, marker, checkpoint, manifest, intent,
    }) : null;
    const approvedBase = baseProvenance
      ? releaseBaseProvenanceApprovedBase(baseProvenance)
      : supplemental?.identity.authority.derived.approvedOriginMainCommit ?? null;
    assertExactRecoveryExpectation(checkpoint.planRevision, expected.planRevision, "plan revision");
    assertExactRecoveryExpectation(checkpoint.manifestHash, expected.manifestHash, "manifest hash");
    assertExactRecoveryExpectation(intent.preparedHead, expected.preparedHead, "prepared head");
    assertExactRecoveryExpectation(frozenHead, expected.frozenHead, "frozen head");
    assertExactRecoveryExpectation(frozenTree, expected.frozenTree, "frozen tree");
    assertExactRecoveryExpectation(intent.oldMain, expected.publishedRevision, "published revision");
    assertExactRecoveryExpectation(approvedBase, expected.approvedOriginMain, "approved origin main");
    const expectedReviewedOriginAdvance = normalizedReviewedOriginAdvance(expected);
    const [head, headRef, main, preRelease, dirty, unmerged, remoteLine, trackingOriginMain, originUrl] = await Promise.all([
      runGit(["rev-parse", "HEAD^{commit}"], { cwd: layout.releaseRoot }),
      gitMaybe(["symbolic-ref", "-q", "HEAD"], { cwd: layout.releaseRoot }),
      runGit(["rev-parse", "refs/heads/main^{commit}"], { cwd: layout.releaseRoot }),
      runGit(["rev-parse", "refs/heads/PreRelease^{commit}"], { cwd: layout.releaseRoot }),
      runGit(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], { cwd: layout.releaseRoot }),
      runGit(["ls-files", "--unmerged"], { cwd: layout.releaseRoot }),
      runGit(["ls-remote", "origin", "refs/heads/main"], { cwd: layout.releaseRoot, timeoutMs: 300_000 }),
      runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: layout.releaseRoot }),
      runGit(["remote", "get-url", "origin"], { cwd: layout.releaseRoot }),
    ]);
    if (dirty || unmerged) throw new Error("publication freeze recovery requires a clean unconflicted clone");
    const originMain = remoteLine.split(/\s+/u)[0];
    if (!/^[a-f0-9]{40}$/u.test(originMain)) {
      throw new Error("publication freeze recovery origin main is unreadable");
    }
    let reviewedOriginAdvance = null;
    if (originMain === approvedBase) {
      if (expectedReviewedOriginAdvance) {
        throw new Error("publication freeze recovery reviewed origin advance is not present");
      }
      if (trackingOriginMain !== approvedBase) {
        throw new Error("publication freeze recovery approved origin main changed");
      }
    } else {
      if (recoveryMode !== FAILED_FROZEN_RECOVERY_MODE || !expectedReviewedOriginAdvance
          || originMain !== expectedReviewedOriginAdvance.reviewedOriginMain
          || trackingOriginMain !== expectedReviewedOriginAdvance.releaseTrackingOriginMain
          || trackingOriginMain !== approvedBase
          || sha256(originUrl) !== expectedReviewedOriginAdvance.originUrlSha256) {
        throw new Error("publication freeze recovery approved origin main changed");
      }
      reviewedOriginAdvance = await inspectRemoteObjectsInIsolation({
        originUrl, remoteMain: originMain, frozenHead, releaseRoot: layout.releaseRoot,
        approvedOriginMain: approvedBase,
        expectedAdvance: expectedReviewedOriginAdvance,
      });
    }
    const acceptedFreshHeadRefs = recoveryMode === FAILED_FROZEN_RECOVERY_MODE
      ? ["refs/heads/main"] : ["refs/heads/main", null];
    if (main !== frozenHead || preRelease !== frozenHead || head !== frozenHead
        || !acceptedFreshHeadRefs.includes(headRef)) {
      throw new Error("publication freeze recovery refs or checkout changed");
    }

    const publicationStatePath = publicationStateFile(this.#environment);
    const publicationRunPath = publicationRunPaths(this.#environment).statusFile;
    const publicationStepPath = publicationCheckpointFile(this.#environment);
    const [publicationStateBytes, publicationRunBytes, publicationStepBytes] = await Promise.all([
      readFile(publicationStatePath),
      readFile(publicationRunPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)),
      readFile(publicationStepPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)),
    ]);
    const publicationState = parseRecoveryJson(publicationStateBytes, "publication state");
    const publicationRun = publicationRunBytes ? parseRecoveryJson(publicationRunBytes, "publication run") : null;
    const publicationStep = publicationStepBytes ? parseRecoveryJson(publicationStepBytes, "publication checkpoint") : null;
    const publishedRepository = publicationStateRepositories(publicationState ?? {})
      .find((entry) => samePath(entry.root, marker.primaryRoot));
    if (!publishedRepository || publishedRepository.revision !== intent.oldMain) {
      throw new Error("publication freeze recovery durable published revision changed");
    }
    let publicationEvidence = {
      publicationRunObservation: "no-current-candidate-evidence",
      publicationCheckpointObservation: "no-current-candidate-evidence",
    };
    let publicationLogBytes = null;
    if (recoveryMode === FAILED_FROZEN_RECOVERY_MODE) {
      if (!publicationRunBytes) {
        throw new Error("publication freeze recovery requires terminal publication run evidence");
      }
      const publicationRunSha256 = assertRecoveryDigest(
        publicationRunBytes, expected.publicationRunSha256, "publication run digest",
      );
      const expectsCheckpointAbsence = expected.publicationCheckpointAbsent === true;
      const expectsCheckpointDigest = /^[a-f0-9]{64}$/u.test(String(expected.publicationCheckpointSha256 ?? ""));
      if (expectsCheckpointAbsence === expectsCheckpointDigest) {
        throw new Error("publication freeze recovery requires exactly one checkpoint digest or explicit absence");
      }
      if (Boolean(publicationStepBytes) === expectsCheckpointAbsence) {
        throw new Error("publication freeze recovery checkpoint presence changed");
      }
      const publicationCheckpointSha256 = publicationStepBytes
        ? assertRecoveryDigest(publicationStepBytes, expected.publicationCheckpointSha256,
          "publication checkpoint digest")
        : null;
      const stageEvidence = failedFrozenPublicationEvidence(publicationRun, publicationStep, {
        expectedRunId: expected.publicationRunId,
        allowLegacyHashBound: true,
      });
      const releaseIdentity = publicationRun.identity?.release;
      if (publicationRun.identity?.mode !== "changed" || publicationRun.identity?.revision !== frozenHead
          || !samePath(publicationRun.identity?.worktreeRoot, layout.releaseRoot)
          || publicationRun.identity?.validationMode !== "full"
          || publicationRun.identity?.artifactProtocol !== 1
          || releaseIdentity?.workspaceId !== workspaceId
          || releaseIdentity?.planRevision !== checkpoint.planRevision
          || releaseIdentity?.manifestHash !== checkpoint.manifestHash
          || releaseIdentity?.baseCommit !== checkpoint.baseCommit
          || releaseIdentity?.preReleaseHead !== frozenHead
          || !samePath(releaseIdentity?.primaryRoot, marker.primaryRoot)) {
        throw new Error("publication freeze recovery publication run candidate identity changed");
      }
      const runPaths = publicationRunPaths(this.#environment);
      if (!pathInside(runPaths.logDirectory, publicationRun.logFile)
          || !path.basename(publicationRun.logFile).includes(publicationRun.runId)) {
        throw new Error("publication freeze recovery publication log identity changed");
      }
      publicationLogBytes = await readFile(publicationRun.logFile);
      const publicationLogSha256 = assertRecoveryDigest(
        publicationLogBytes, expected.publicationLogSha256, "publication log digest",
      );
      publicationEvidence = {
        publicationRunId: publicationRun.runId,
        publicationRunSha256,
        publicationCheckpointSha256,
        publicationCheckpointAbsent: publicationStepBytes === null,
        publicationLogSha256,
        publicationStageEvidence: stageEvidence,
      };
    } else {
      if (publicationRun && !PUBLICATION_TERMINAL_STATUSES.has(publicationRun.status)) {
        throw new Error("publication freeze recovery refuses an active or ambiguous publication run");
      }
      const matchesCandidate = (value) => value != null && [frozenHead, checkpoint.manifestHash, checkpoint.planRevision]
        .some((identity) => JSON.stringify(value).includes(identity));
      if (matchesCandidate(publicationRun) || matchesCandidate(publicationStep)) {
        throw new Error("publication freeze recovery found publication progress for this candidate");
      }
    }

    const recoveryIdentity = {
      schemaVersion: 2,
      mode: recoveryMode,
      operationId,
      sourceIdentity,
      workspaceId,
      repositoryKey: layout.repositoryKey,
      primaryRoot: marker.primaryRoot,
      releaseRoot: layout.releaseRoot,
      sourceCheckpointSha256: checkpoint.recovery?.sourceCheckpointSha256 ?? sha256(checkpointBytes),
      sourceManifestSha256: checkpoint.recovery?.sourceManifestSha256 ?? sha256(manifestBytes),
      planRevision: checkpoint.planRevision,
      manifestHash: checkpoint.manifestHash,
      preparedHead: intent.preparedHead,
      frozenHead,
      frozenTree,
      oldMain: intent.oldMain,
      oldPreRelease: intent.oldPreRelease,
      baseCommit: checkpoint.baseCommit,
      baseProvenance,
      ...(supplemental ? { supplementalProvenance: supplemental.identity } : {}),
      frozenTasks: (manifest.tasks ?? []).map((task) => ({
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        resultCommit: task.resultCommit,
        ...selectedCompositionFields(task),
        integrations: task.integrations,
      })),
      originMain,
      trackingOriginMain,
      originUrlSha256: sha256(originUrl),
      reviewedOriginAdvance,
      publicationStateSha256: sha256(publicationStateBytes),
      ...publicationEvidence,
      effects: [
        `refs/heads/main:${frozenHead}->${intent.oldMain}`,
        `refs/heads/PreRelease:${frozenHead}->${intent.oldPreRelease}`,
        `checkout:refs/heads/PreRelease@${intent.oldPreRelease}`,
      ],
    };
    const proofHash = recoveryDigest(recoveryIdentity);
    if (!confirm) return { status: "preview", proofHash, identity: recoveryIdentity, effects: recoveryIdentity.effects };
    if (!expectedProofHash || expectedProofHash !== proofHash) {
      throw new Error("publication freeze recovery confirmation proof changed");
    }

    // The source-checkpoint digest, rather than the caller proof, owns this
    // filename. If a process stops after evidence creation but before the
    // checkpoint CAS, another operation can observe and must not replace the
    // already admitted recovery identity.
    const evidenceFile = path.join(layout.evidenceRoot,
      `freeze-recovery-${recoveryIdentity.sourceCheckpointSha256}.json`);
    let existingEvidence = await readFile(evidenceFile).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    let evidenceSha256 = null;
    if (existingEvidence) {
      const parsedEvidence = JSON.parse(existingEvidence.toString("utf8"));
      if (parsedEvidence.proofHash !== proofHash || parsedEvidence.operationId !== operationId
          || stableManifest(parsedEvidence) !== existingEvidence.toString("utf8")
          || sha256(Buffer.from(parsedEvidence.sourceCheckpointBytesBase64 ?? "", "base64"))
            !== recoveryIdentity.sourceCheckpointSha256
          || sha256(Buffer.from(parsedEvidence.sourceManifestBytesBase64 ?? "", "base64"))
            !== recoveryIdentity.sourceManifestSha256
          || (recoveryMode === FAILED_FROZEN_RECOVERY_MODE
            && sha256(Buffer.from(parsedEvidence.publicationLogBytesBase64 ?? "", "base64"))
              !== recoveryIdentity.publicationLogSha256)
          || (recoveryMode === FAILED_FROZEN_RECOVERY_MODE
            && (recoveryIdentity.publicationCheckpointSha256
              ? sha256(Buffer.from(parsedEvidence.publicationCheckpointBytesBase64 ?? "", "base64"))
                !== recoveryIdentity.publicationCheckpointSha256
              : parsedEvidence.publicationCheckpointBytesBase64 != null))
          || Object.entries(recoveryIdentity).some(([key, value]) => (
            JSON.stringify(parsedEvidence[key]) !== JSON.stringify(value)
          ))
          || (supplemental
            && !supplementalEvidenceMatches(parsedEvidence.supplementalEvidence, supplemental.identity))) {
        throw new Error("publication freeze recovery evidence conflicts with the exact operation");
      }
      evidenceSha256 = sha256(existingEvidence);
    } else {
      const evidence = { ...recoveryIdentity, proofHash,
        sourceCheckpointBytesBase64: checkpointBytes.toString("base64"),
        sourceManifestBytesBase64: manifestBytes.toString("base64"),
        ...(publicationLogBytes ? { publicationLogBytesBase64: publicationLogBytes.toString("base64") } : {}),
        ...(publicationStepBytes
          ? { publicationCheckpointBytesBase64: publicationStepBytes.toString("base64") } : {}),
        sourceCheckpoint: checkpoint, sourceManifest: manifest,
        ...(supplemental ? { supplementalEvidence: supplemental.evidence } : {}),
        publicationState, publicationRun, publicationCheckpoint: publicationStep };
      const evidenceText = stableManifest(evidence);
      const temporary = path.join(layout.evidenceRoot,
        `.freeze-recovery-${recoveryIdentity.sourceCheckpointSha256}-${randomUUID()}.tmp`);
      let handle = null;
      try {
        handle = await open(temporary, "wx");
        await this.#recoveryEvidenceWrite(handle, evidenceText);
        await handle.sync();
        await handle.close();
        handle = null;
        await this.#recoveryPhase("evidence-temporary");
        try {
          await link(temporary, evidenceFile);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      } finally {
        await handle?.close().catch(() => {});
        await rm(temporary, { force: true });
      }
      existingEvidence = await readFile(evidenceFile);
      if (!existingEvidence.equals(Buffer.from(evidenceText))) {
        throw new Error("publication freeze recovery evidence conflicts with the exact operation");
      }
      evidenceSha256 = sha256(existingEvidence);
    }
    if (checkpoint.recovery?.evidenceSha256 && checkpoint.recovery.evidenceSha256 !== evidenceSha256) {
      throw new Error("publication freeze recovery evidence digest changed");
    }
    await this.#recoveryPhase("evidence");
    if (recoveryMode === FAILED_FROZEN_RECOVERY_MODE) {
      const [runReadback, checkpointReadback, logReadback, remoteReadback,
        trackingReadback, originUrlReadback] = await Promise.all([
        readFile(publicationRunPath),
        readFile(publicationStepPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)),
        readFile(publicationRun.logFile),
        runGit(["ls-remote", "origin", "refs/heads/main"], { cwd: layout.releaseRoot, timeoutMs: 300_000 }),
        runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: layout.releaseRoot }),
        runGit(["remote", "get-url", "origin"], { cwd: layout.releaseRoot }),
      ]);
      if (sha256(runReadback) !== recoveryIdentity.publicationRunSha256
          || (recoveryIdentity.publicationCheckpointSha256
            ? !checkpointReadback || sha256(checkpointReadback) !== recoveryIdentity.publicationCheckpointSha256
            : checkpointReadback !== null)
          || sha256(logReadback) !== recoveryIdentity.publicationLogSha256
          || remoteReadback.split(/\s+/u)[0] !== recoveryIdentity.originMain
          || trackingReadback !== recoveryIdentity.trackingOriginMain
          || sha256(originUrlReadback) !== recoveryIdentity.originUrlSha256) {
        throw new Error("publication freeze recovery external evidence changed before admission");
      }
    }
    if (recoveryIdentity.supplementalProvenance) {
      await this.#assertMissingProvenanceCurrentObservation({ layout, marker, identity: recoveryIdentity });
    }
    checkpoint = { ...checkpoint, phase: "abandoning", recovery: {
      schemaVersion: 2, operationId, proofHash, evidenceFile, evidenceSha256, sourceIdentity,
      identity: recoveryIdentity,
    }, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(layout.checkpointFile, checkpoint);
    await this.#recoveryPhase("intent");
    return this.#finalizePublicationRecoveryOwned({ layout, checkpoint, recoveryIdentity, reused: false });
  }

  // Supplemental authority for a legacy frozen candidate whose immutable
  // manifest and checkpoint both lack provenance. The old candidate bytes are
  // only read; its prepared manifest must be the exact freeze source.
  async #missingProvenanceAuthority({
    missingProvenance, layout, workspaceId, marker, checkpoint, manifest, intent,
  }) {
    const { request, resolver } = missingProvenance;
    if (typeof resolver !== "function") throw new Error("missing-provenance recovery requires its owner resolver");
    for (const [label, value] of [["checkpoint", checkpoint], ["manifest", manifest]]) {
      if (Object.hasOwn(value, "baseProvenance")) {
        throw new Error(`missing-provenance recovery refuses a ${label} that already carries base provenance`);
      }
      if (Object.hasOwn(value, "preflightRequestId")) {
        throw new Error(`missing-provenance recovery refuses a ${label} bound to a preflight request`);
      }
    }
    const preparedManifestHash = String(manifest.publication?.sourceManifestHash ?? "");
    if (!/^[a-f0-9]{64}$/u.test(preparedManifestHash)) {
      throw new Error("missing-provenance recovery requires the exact prepared source manifest");
    }
    const preparedManifestBytes = await readFile(path.join(layout.evidenceRoot, `${preparedManifestHash}.json`));
    if (sha256(preparedManifestBytes) !== preparedManifestHash) {
      throw new Error("missing-provenance recovery prepared manifest digest changed");
    }
    const preparedManifest = parseRecoveryJson(preparedManifestBytes, "prepared manifest");
    const frozenManifestText = stableManifest({
      ...preparedManifest, workspaceId: manifest.workspaceId, publication: manifest.publication,
    });
    if (Object.hasOwn(preparedManifest, "baseProvenance") || Object.hasOwn(preparedManifest, "preflightRequestId")
        || sha256(frozenManifestText) !== checkpoint.manifestHash
        || manifest.publication?.preparedHead !== intent.preparedHead
        || preparedManifest.workspaceId !== workspaceId
        || preparedManifest.baseCommit !== checkpoint.baseCommit
        || preparedManifest.planRevision !== checkpoint.planRevision) {
      throw new Error("missing-provenance recovery prepared manifest is not the exact frozen source");
    }
    const candidate = {
      workspaceId,
      projectRoot: marker.primaryRoot,
      planRevision: checkpoint.planRevision,
      publishedBaseCommit: intent.oldMain,
      baseCommit: checkpoint.baseCommit,
      preparedHead: intent.preparedHead,
      preparedTree: await runGit(["rev-parse", `${intent.preparedHead}^{tree}`], { cwd: layout.releaseRoot }),
      preparedManifestHash,
      frozenTasks: normalizedFrozenTasks(manifest.tasks ?? []).map((task) => ({
        taskId: task.taskId, taskRevision: task.taskRevision, resultCommit: task.resultCommit,
        ...selectedCompositionFields(task),
      })),
    };
    const resolved = await resolver({ request, candidate });
    assertMissingProvenanceAuthority(resolved?.authority, { request, candidate });
    const identity = {
      schemaVersion: 1,
      kind: SUPPLEMENTAL_PROVENANCE_KIND,
      sourceManifest: { preparedManifestHash, frozenManifestHash: checkpoint.manifestHash },
      recheckCandidate: candidate,
      authority: resolved.authority,
      authoritySha256: recoveryDigest(resolved.authority),
      currentObservation: await this.#missingProvenanceCurrentObservation({ layout, marker }),
    };
    return {
      identity,
      evidence: {
        preparedManifestBytesBase64: preparedManifestBytes.toString("base64"),
        preflightResultJson: resolved.receiptResultJson,
        preflightResultSha256: resolved.authority.receipt.resultSha256,
      },
    };
  }

  // Current state, observed separately from the historical tuple. It never
  // authorizes the candidate base or adoption; it only fences drift after
  // preview for this supplemental recovery.
  async #missingProvenanceCurrentObservation({ layout, marker }) {
    const primary = await this.assertPrimaryInvariant(marker.primaryRoot, {
      phase: "missing-provenance current observation",
    });
    const [remoteLine, releaseTracking, originUrl] = await Promise.all([
      runGit(["ls-remote", "origin", "refs/heads/main"], { cwd: layout.releaseRoot, timeoutMs: 300_000 }),
      runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: layout.releaseRoot }),
      runGit(["remote", "get-url", "origin"], { cwd: layout.releaseRoot }),
    ]);
    return {
      primary: {
        projectRoot: primary.projectRoot,
        gitCommonDir: primary.gitCommonDir,
        branch: primary.branch,
        headCommit: primary.headCommit,
        mainCommit: primary.mainCommit,
        indexFingerprint: primary.indexFingerprint,
        dirtyFingerprint: primary.dirtyFingerprint,
      },
      remoteOriginMain: remoteLine.split(/\s+/u)[0],
      releaseTrackingOriginMain: releaseTracking,
      originUrl: redactedOriginUrl(originUrl),
      originUrlSha256: sha256(originUrl),
    };
  }

  async #assertMissingProvenanceCurrentObservation({ layout, marker, identity }) {
    const admitted = identity.supplementalProvenance?.currentObservation;
    const current = await this.#missingProvenanceCurrentObservation({ layout, marker });
    if (!admitted || recoveryDigest(current) !== recoveryDigest(admitted)) {
      throw new Error("publication freeze recovery current primary, remote, tracking or URL changed after preview");
    }
  }

  async #recheckMissingProvenanceAuthority({ missingProvenance, identity, layout, marker, workspaceId }) {
    const supplemental = identity.supplementalProvenance;
    const candidate = supplemental?.recheckCandidate;
    if (!missingProvenance || typeof missingProvenance.resolver !== "function" || !candidate
        || candidate.workspaceId !== workspaceId || !samePath(candidate.projectRoot, marker.primaryRoot)
        || candidate.planRevision !== identity.planRevision || candidate.preparedHead !== identity.preparedHead
        || candidate.baseCommit !== identity.baseCommit || candidate.publishedBaseCommit !== identity.oldMain
        || supplemental.authoritySha256 !== recoveryDigest(supplemental.authority)) {
      throw new Error("publication freeze recovery missing-provenance identity changed after admission");
    }
    const resolved = await missingProvenanceResolverResult(missingProvenance, candidate);
    assertMissingProvenanceAuthority(resolved?.authority, { request: missingProvenance.request, candidate });
    if (recoveryDigest(resolved.authority) !== supplemental.authoritySha256) {
      throw new Error("publication freeze recovery missing-provenance authority changed after admission");
    }
    await this.#assertMissingProvenanceCurrentObservation({ layout, marker, identity });
  }

  async #resumeLegacyPublicationRecoveryOwned({
    layout, workspaceId, operationId, sourceIdentity, expected, confirm, expectedProofHash,
    recoveryMode, checkpoint,
  }) {
    const recovery = checkpoint?.recovery;
    if (recoveryMode !== FREEZING_RECOVERY_MODE || recovery?.operationId !== operationId
        || JSON.stringify(recovery.sourceIdentity) !== JSON.stringify(sourceIdentity)
        || !pathInside(layout.evidenceRoot, String(recovery.evidenceFile ?? ""))) {
      throw new Error("publication freeze recovery belongs to another exact operation");
    }
    const evidenceStat = await lstat(recovery.evidenceFile);
    if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink()) {
      throw new Error("publication freeze recovery evidence is not an exact regular file");
    }
    const evidenceBytes = await readFile(recovery.evidenceFile);
    if (sha256(evidenceBytes) !== recovery.evidenceSha256) {
      throw new Error("publication freeze recovery evidence digest changed");
    }
    const evidence = parseRecoveryJson(evidenceBytes, "legacy recovery evidence");
    const {
      proofHash, sourceCheckpointBytesBase64, sourceManifestBytesBase64,
      sourceCheckpoint, sourceManifest, publicationState, publicationRun, publicationCheckpoint,
      ...identity
    } = evidence;
    if (stableManifest(evidence) !== evidenceBytes.toString("utf8")
        || proofHash !== recovery.proofHash || recoveryDigest(identity) !== proofHash
        || (expectedProofHash && expectedProofHash !== proofHash)
        || identity.operationId !== operationId || identity.workspaceId !== workspaceId
        || identity.repositoryKey !== layout.repositoryKey
        || JSON.stringify(identity.sourceIdentity) !== JSON.stringify(sourceIdentity)
        || sha256(Buffer.from(sourceCheckpointBytesBase64 ?? "", "base64")) !== identity.sourceCheckpointSha256
        || sha256(Buffer.from(sourceManifestBytesBase64 ?? "", "base64")) !== identity.sourceManifestSha256) {
      throw new Error("publication freeze recovery legacy evidence identity changed");
    }
    for (const [actual, requested, label] of [
      [identity.planRevision, expected.planRevision, "plan revision"],
      [identity.manifestHash, expected.manifestHash, "manifest hash"],
      [identity.preparedHead, expected.preparedHead, "prepared head"],
      [identity.frozenHead, expected.frozenHead, "frozen head"],
      [identity.frozenTree, expected.frozenTree, "frozen tree"],
      [identity.oldMain, expected.publishedRevision, "published revision"],
      [releaseBaseProvenanceApprovedBase(identity.baseProvenance), expected.approvedOriginMain, "approved origin main"],
    ]) assertExactRecoveryExpectation(actual, requested, label);
    const expectedReviewedOriginAdvance = normalizedReviewedOriginAdvance(expected);
    if (JSON.stringify(identity.reviewedOriginAdvance ?? null)
        !== JSON.stringify(expectedReviewedOriginAdvance
          ? { ...expectedReviewedOriginAdvance, objectProof: "isolated-remote-objects-v1" } : null)) {
      throw new Error("publication freeze recovery reviewed origin advance identity changed");
    }
    if (!confirm) return { status: checkpoint.phase, proofHash, identity, effects: identity.effects, reused: true };
    if (checkpoint.phase === "abandoned") {
      return { status: "abandoned", reused: true, proofHash, recovery };
    }
    const currentPublicationState = await readPublicationState(publicationStateFile(this.#environment));
    const publishedRepository = publicationStateRepositories(currentPublicationState ?? {})
      .find((entry) => samePath(entry.root, identity.primaryRoot));
    if (!publishedRepository || recoveryDigest(publishedRepository) !== identity.publicationStateSha256) {
      throw new Error("publication freeze recovery durable published revision changed after admission");
    }
    const [currentRun, currentCheckpoint, remoteLine] = await Promise.all([
      readPublicationRunStatus(publicationRunPaths(this.#environment).statusFile),
      readPublicationCheckpoint(publicationCheckpointFile(this.#environment)),
      runGit(["ls-remote", "origin", "refs/heads/main"], { cwd: layout.releaseRoot, timeoutMs: 300_000 }),
    ]);
    if (currentRun && !PUBLICATION_TERMINAL_STATUSES.has(currentRun.status)) {
      throw new Error("publication freeze recovery refuses an active or ambiguous publication run");
    }
    const matchesCandidate = (value) => value != null && [identity.frozenHead, identity.manifestHash, identity.planRevision]
      .some((candidateIdentity) => JSON.stringify(value).includes(candidateIdentity));
    if (matchesCandidate(currentRun) || matchesCandidate(currentCheckpoint)) {
      throw new Error("publication freeze recovery found publication progress for this candidate");
    }
    const remoteMain = remoteLine.split(/\s+/u)[0];
    if (!/^[a-f0-9]{40}$/u.test(remoteMain)) {
      throw new Error("publication freeze recovery origin main is unreadable");
    }
    if (remoteMain !== identity.originMain) {
      await runGit(["fetch", "--no-write-fetch-head", "origin", remoteMain], {
        cwd: layout.releaseRoot, timeoutMs: 300_000,
      });
      if (await gitMaybe(["merge-base", "--is-ancestor", identity.frozenHead, remoteMain], {
        cwd: layout.releaseRoot,
      }) !== null) {
        throw new Error("publication freeze recovery candidate acquired a foreign publication effect");
      }
    }
    return this.#finalizePublicationRecoveryOwned({ layout, checkpoint, recoveryIdentity: identity, reused: true });
  }

  async #resumePublicationRecoveryOwned({
    layout, marker, workspaceId, operationId, sourceIdentity, expected, confirm, expectedProofHash,
    recoveryMode, checkpoint, missingProvenance = null,
  }) {
    const recovery = checkpoint?.recovery;
    const identity = recovery?.identity;
    if (recovery?.schemaVersion !== 2 || identity?.schemaVersion !== 2
        || recovery.operationId !== operationId || identity.operationId !== operationId
        || identity.workspaceId !== workspaceId || identity.repositoryKey !== layout.repositoryKey
        || identity.mode !== recoveryMode
        || JSON.stringify(recovery.sourceIdentity) !== JSON.stringify(sourceIdentity)
        || JSON.stringify(identity.sourceIdentity) !== JSON.stringify(sourceIdentity)) {
      throw new Error("publication freeze recovery belongs to another exact operation");
    }
    const proofHash = recoveryDigest(identity);
    if (recovery.proofHash !== proofHash || (expectedProofHash && expectedProofHash !== proofHash)) {
      throw new Error("publication freeze recovery proof changed after admission");
    }
    for (const [actual, requested, label] of [
      [identity.planRevision, expected.planRevision, "plan revision"],
      [identity.manifestHash, expected.manifestHash, "manifest hash"],
      [identity.preparedHead, expected.preparedHead, "prepared head"],
      [identity.frozenHead, expected.frozenHead, "frozen head"],
      [identity.frozenTree, expected.frozenTree, "frozen tree"],
      [identity.oldMain, expected.publishedRevision, "published revision"],
      [identity.baseProvenance
        ? releaseBaseProvenanceApprovedBase(identity.baseProvenance)
        : identity.supplementalProvenance?.authority?.derived?.approvedOriginMainCommit,
      expected.approvedOriginMain, "approved origin main"],
    ]) assertExactRecoveryExpectation(actual, requested, label);
    if (Boolean(identity.supplementalProvenance) !== Boolean(missingProvenance)) {
      throw new Error("publication freeze recovery missing-provenance request changed after admission");
    }
    if (recoveryMode === FAILED_FROZEN_RECOVERY_MODE) {
      for (const [actual, requested, label] of [
        [identity.publicationRunId, expected.publicationRunId, "publication run ID"],
        [identity.publicationRunSha256, expected.publicationRunSha256, "publication run digest"],
        [identity.publicationLogSha256, expected.publicationLogSha256, "publication log digest"],
      ]) assertExactRecoveryExpectation(actual, requested, label);
      if (identity.publicationCheckpointAbsent !== (expected.publicationCheckpointAbsent === true)
          || (identity.publicationCheckpointSha256 ?? null) !== (expected.publicationCheckpointSha256 ?? null)) {
        throw new Error("publication freeze recovery publication checkpoint expectation changed");
      }
    }
    const expectedReviewedOriginAdvance = normalizedReviewedOriginAdvance(expected);
    if (JSON.stringify(identity.reviewedOriginAdvance ?? null)
        !== JSON.stringify(expectedReviewedOriginAdvance
          ? { ...expectedReviewedOriginAdvance, objectProof: "isolated-remote-objects-v1" } : null)) {
      throw new Error("publication freeze recovery reviewed origin advance identity changed");
    }
    const evidenceFile = String(recovery.evidenceFile ?? "");
    if (!pathInside(layout.evidenceRoot, evidenceFile)) {
      throw new Error("publication freeze recovery evidence path changed");
    }
    const evidenceStat = await lstat(evidenceFile);
    if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink()) {
      throw new Error("publication freeze recovery evidence is not an exact regular file");
    }
    const evidenceBytes = await readFile(evidenceFile);
    if (sha256(evidenceBytes) !== recovery.evidenceSha256) {
      throw new Error("publication freeze recovery evidence digest changed");
    }
    const evidence = parseRecoveryJson(evidenceBytes, "recovery evidence");
    if (stableManifest(evidence) !== evidenceBytes.toString("utf8")
        || evidence.proofHash !== proofHash || evidence.operationId !== operationId
        || Object.entries(identity).some(([key, value]) => (
          JSON.stringify(evidence[key]) !== JSON.stringify(value)
        ))
        || sha256(Buffer.from(evidence.sourceCheckpointBytesBase64 ?? "", "base64"))
          !== identity.sourceCheckpointSha256
        || sha256(Buffer.from(evidence.sourceManifestBytesBase64 ?? "", "base64"))
          !== identity.sourceManifestSha256
        || (recoveryMode === FAILED_FROZEN_RECOVERY_MODE
          && sha256(Buffer.from(evidence.publicationLogBytesBase64 ?? "", "base64"))
            !== identity.publicationLogSha256)
        || (recoveryMode === FAILED_FROZEN_RECOVERY_MODE
          && (identity.publicationCheckpointSha256
            ? sha256(Buffer.from(evidence.publicationCheckpointBytesBase64 ?? "", "base64"))
              !== identity.publicationCheckpointSha256
            : evidence.publicationCheckpointBytesBase64 != null))
        || (identity.supplementalProvenance
          && !supplementalEvidenceMatches(evidence.supplementalEvidence, identity.supplementalProvenance))) {
      throw new Error("publication freeze recovery evidence identity changed");
    }
    if (identity.supplementalProvenance) {
      // Preview, confirmation, resume and completed replay all re-read the
      // exact receipt and adoption owners before any return or ref effect.
      await this.#recheckMissingProvenanceAuthority({ missingProvenance, identity, layout, marker, workspaceId });
    }
    if (!confirm) {
      return { status: checkpoint.phase, proofHash, identity, effects: identity.effects, reused: true };
    }
    if (checkpoint.phase === "abandoned") {
      return { ...checkpoint.recovery.outcome, reused: true };
    }
    if (checkpoint.phase !== "abandoning") {
      throw new Error("publication freeze recovery persisted phase is unsupported");
    }

    const publicationStatePath = publicationStateFile(this.#environment);
    const publicationRunPath = publicationRunPaths(this.#environment).statusFile;
    const publicationStepPath = publicationCheckpointFile(this.#environment);
    const admittedLogFile = recoveryMode === FAILED_FROZEN_RECOVERY_MODE
      ? String(evidence.publicationRun?.logFile ?? "") : null;
    if (admittedLogFile && !pathInside(publicationRunPaths(this.#environment).logDirectory, admittedLogFile)) {
      throw new Error("publication freeze recovery publication log identity changed after admission");
    }
    const [stateBytes, runBytes, stepBytes, logBytes, originUrl, remoteLine, trackingOriginMain] = await Promise.all([
      readFile(publicationStatePath),
      recoveryMode === FAILED_FROZEN_RECOVERY_MODE ? readFile(publicationRunPath) : Promise.resolve(null),
      recoveryMode === FAILED_FROZEN_RECOVERY_MODE
        ? readFile(publicationStepPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error))
        : Promise.resolve(null),
      recoveryMode === FAILED_FROZEN_RECOVERY_MODE ? readFile(admittedLogFile) : Promise.resolve(null),
      runGit(["remote", "get-url", "origin"], { cwd: layout.releaseRoot }),
      runGit(["ls-remote", "origin", "refs/heads/main"], { cwd: layout.releaseRoot, timeoutMs: 300_000 }),
      runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: layout.releaseRoot }),
    ]);
    if (sha256(stateBytes) !== identity.publicationStateSha256 || sha256(originUrl) !== identity.originUrlSha256
        || (runBytes && sha256(runBytes) !== identity.publicationRunSha256)
        || (identity.publicationCheckpointSha256
          ? !stepBytes || sha256(stepBytes) !== identity.publicationCheckpointSha256
          : stepBytes !== null)
        || (logBytes && sha256(logBytes) !== identity.publicationLogSha256)) {
      throw new Error("publication freeze recovery durable external evidence changed after admission");
    }
    const remoteMain = remoteLine.split(/\s+/u)[0];
    if (!/^[a-f0-9]{40}$/u.test(remoteMain)) {
      throw new Error("publication freeze recovery origin main is unreadable");
    }
    if (identity.reviewedOriginAdvance) {
      if (remoteMain !== identity.originMain || trackingOriginMain !== identity.trackingOriginMain) {
        throw new Error("publication freeze recovery reviewed origin changed after admission");
      }
    } else if (remoteMain !== identity.originMain) {
      await inspectRemoteObjectsInIsolation({
        originUrl, remoteMain, frozenHead: identity.frozenHead, releaseRoot: layout.releaseRoot,
      });
    }
    return this.#finalizePublicationRecoveryOwned({ layout, checkpoint, recoveryIdentity: identity, reused: true });
  }

  async #finalizePublicationRecoveryOwned({ layout, checkpoint, recoveryIdentity, reused }) {
    const releaseGitCommonDir = path.resolve(layout.releaseRoot,
      await runGit(["rev-parse", "--git-common-dir"], { cwd: layout.releaseRoot }));
    for (const operation of [
      "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "index.lock",
    ]) {
      const pending = await lstat(path.join(releaseGitCommonDir, operation)).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (pending) throw new Error(`publication freeze recovery refuses pending Git operation: ${operation}`);
    }
    const state = async () => {
      const [head, headRef, main, preRelease, dirty, unmerged] = await Promise.all([
        runGit(["rev-parse", "HEAD^{commit}"], { cwd: layout.releaseRoot }),
        gitMaybe(["symbolic-ref", "-q", "HEAD"], { cwd: layout.releaseRoot }),
        runGit(["rev-parse", "refs/heads/main^{commit}"], { cwd: layout.releaseRoot }),
        runGit(["rev-parse", "refs/heads/PreRelease^{commit}"], { cwd: layout.releaseRoot }),
        runGit(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: layout.releaseRoot,
        }),
        runGit(["ls-files", "--unmerged"], { cwd: layout.releaseRoot }),
      ]);
      if (dirty || unmerged) throw new Error("publication freeze recovery requires a clean unconflicted clone");
      return { head, headRef, main, preRelease };
    };
    const { frozenHead, oldMain, oldPreRelease } = recoveryIdentity;
    let current = await state();
    const known = (
      current.head === frozenHead && ["refs/heads/main", null].includes(current.headRef)
        && current.main === frozenHead && current.preRelease === frozenHead
    ) || (
      current.head === oldPreRelease && current.headRef === null
        && [frozenHead, oldMain].includes(current.main) && [frozenHead, oldPreRelease].includes(current.preRelease)
        && !(current.preRelease === oldPreRelease && current.main !== oldMain)
    ) || (
      current.head === oldPreRelease && current.headRef === "refs/heads/PreRelease"
        && current.main === oldMain && current.preRelease === oldPreRelease
    );
    if (!known) throw new Error("publication freeze recovery clone is not in an admitted resumable state");

    if (current.head === frozenHead) {
      await runGit(["checkout", "--detach", "--force", oldPreRelease], { cwd: layout.releaseRoot });
      await this.#recoveryPhase("detached");
      await this.#recoveryPhase("prepared-detached");
      current = await state();
    }
    if (current.main === frozenHead) {
      await runGit(["update-ref", "refs/heads/main", oldMain, frozenHead], { cwd: layout.releaseRoot });
      await this.#recoveryPhase("main");
      current = await state();
    }
    if (current.preRelease === frozenHead) {
      await runGit(["update-ref", "refs/heads/PreRelease", oldPreRelease, frozenHead], { cwd: layout.releaseRoot });
      await this.#recoveryPhase("refs");
      current = await state();
    }
    if (current.headRef === null) {
      await runGit(["symbolic-ref", "HEAD", "refs/heads/PreRelease"], { cwd: layout.releaseRoot });
      await this.#recoveryPhase("checkout");
      current = await state();
    }
    if (current.head !== oldPreRelease || current.headRef !== "refs/heads/PreRelease"
        || current.main !== oldMain || current.preRelease !== oldPreRelease) {
      throw new Error("publication freeze recovery final refs do not match admitted evidence");
    }
    const outcome = {
      status: "abandoned", operationId: recoveryIdentity.operationId,
      proofHash: checkpoint.recovery.proofHash, evidenceFile: checkpoint.recovery.evidenceFile,
      evidenceSha256: checkpoint.recovery.evidenceSha256, completedAt: new Date().toISOString(),
      reused: Boolean(reused),
    };
    checkpoint = { ...checkpoint, phase: "abandoned", recovery: { ...checkpoint.recovery, outcome },
      updatedAt: outcome.completedAt };
    await writeJsonAtomic(layout.checkpointFile, checkpoint);
    await this.#recoveryPhase("completed");
    return outcome;
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

  async frozenCandidate(projectRoot, { changelogContent = undefined } = {}) {
    this.#assertAvailable("frozenCandidate");
    const authority = this.#readPreparationAuthority(canonicalPath(projectRoot));
    if (authority && !preparationGitIsolationActive()) return withPreparationGitIsolation(authority.isolation.dataDir,
      () => this.frozenCandidate(projectRoot, { changelogContent }));
    const primary = await primarySnapshot(projectRoot);
    const layout = this.#layout(primary.root);
    const checkpoint = await readJson(layout.checkpointFile);
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
      runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: marker.releaseRoot, rawOutput: true })
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
    if (releaseBranch !== expectedCheckout || releaseHead !== branchHead || (releaseDirty && !authorizedNotes)) {
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
        tasks: manifestTasks.map((task) => ({
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          ...(task.resultReleaseRevision != null
            ? { resultReleaseRevision: task.resultReleaseRevision }
            : {}),
          ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}),
          resultCommit: task.resultCommit,
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

  async verifyPublishedPrimary({ projectRoot, publishedRevision } = {}) {
    this.#assertAvailable("verifyPublishedPrimary");
    const target = String(publishedRevision ?? "").trim();
    if (!/^[a-f0-9]{40}$/u.test(target)) throw new Error("published primary verification requires an exact revision");
    const initial = await this.assertPrimaryInvariant(projectRoot, { phase: "published primary verification" });
    const layout = this.#layout(initial.projectRoot);
    return withInterprocessLocks([path.join(this.dataDir, "locks", `release-git-${layout.repositoryKey}`)], async () => {
      await runGit(["fetch", "--no-tags", "--no-recurse-submodules", "origin",
        "+refs/heads/main:refs/remotes/origin/main"], { cwd: initial.projectRoot, timeoutMs: 300_000 });
      const originMain = await runGit(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: initial.projectRoot });
      if (originMain !== target) throw new Error("published primary origin changed");
      await runGit(["merge-base", "--is-ancestor", initial.headCommit, target], { cwd: initial.projectRoot });
      const after = await this.assertPrimaryInvariant(initial.projectRoot, { phase: "published primary verification completion" });
      if (after.headCommit !== initial.headCommit || after.indexFingerprint !== initial.indexFingerprint
          || after.dirtyFingerprint !== initial.dirtyFingerprint) throw new Error("registered primary changed during publication readback");
      return { status: "preserved", publishedRevision: target, primaryHead: after.headCommit };
    });
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
