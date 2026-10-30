import { ownedGitArguments } from "../filesystem/preparation-git-isolation.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { publicationRunPaths, readPublicationRunStatus } from "./publication-run-store.mjs";

const execute = promisify(execFile);
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;

function samePath(left, right) {
  const first = path.resolve(String(left ?? ""));
  const second = path.resolve(String(right ?? ""));
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function json(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function gitTree(repositoryRoot, commit) {
  const { stdout } = await execute("git", ownedGitArguments(["rev-parse", `${commit}^{tree}`]), {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function exactTasks(manifest) {
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  return tasks.map((task) => ({
    taskId: String(task?.taskId ?? "").trim(),
    resultCommit: String(task?.resultCommit ?? "").trim(),
    acceptanceRevision: Number.isSafeInteger(Number(task?.resultReleaseRevision))
      ? Number(task.resultReleaseRevision)
      : null,
  })).filter((task) => task.taskId && SHA40.test(task.resultCommit));
}

function matchingStatus(status, checkpoint, manifest) {
  if (!status || status.version !== 2) return null;
  const revision = String(status.identity?.revision ?? "").trim();
  if (revision !== checkpoint.preReleaseHead) return null;
  const worktreeRoot = String(status.identity?.worktreeRoot ?? "").trim();
  if (worktreeRoot && !samePath(worktreeRoot, manifest.releaseRoot)) return null;
  return status;
}

export async function importLegacyReleaseOperations({
  store,
  dataDir,
  runnerVersion,
  statusFile = publicationRunPaths().statusFile,
  readStatus = readPublicationRunStatus,
  resolveTree = gitTree,
  reportDiagnostic = () => {},
} = {}) {
  if (!store || typeof store.importLegacy !== "function") throw new TypeError("release operation store is required");
  if (!String(dataDir ?? "").trim()) throw new TypeError("dataDir is required");
  const repositoriesRoot = path.join(String(dataDir), "release-repositories");
  const entries = await readdir(repositoriesRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const publicationStatus = await readStatus(statusFile).catch(() => null);
  const imported = [];
  const skipped = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const root = path.join(repositoriesRoot, entry.name);
    try {
    const checkpoint = await json(path.join(root, "checkpoint.json"));
    if (!checkpoint || !SHA64.test(String(checkpoint.manifestHash ?? ""))
        || !SHA40.test(String(checkpoint.baseCommit ?? ""))
        || !SHA40.test(String(checkpoint.preReleaseHead ?? ""))) {
      skipped.push({ repositoryKey: entry.name, reason: "incomplete-checkpoint" });
      continue;
    }
    const manifestFile = path.join(root, "evidence", `${checkpoint.manifestHash}.json`);
    const manifestBytes = await readFile(manifestFile).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!manifestBytes || sha256(manifestBytes) !== checkpoint.manifestHash) {
      skipped.push({ repositoryKey: entry.name, reason: "manifest-digest" });
      continue;
    }
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const selectedResults = exactTasks(manifest);
    const workspaceId = String(manifest.workspaceId ?? publicationStatus?.identity?.release?.workspaceId ?? "").trim();
    if (!workspaceId || !selectedResults.length || !samePath(manifest.releaseRoot, path.join(root, "repository"))) {
      skipped.push({ repositoryKey: entry.name, reason: "missing-authoritative-identity" });
      continue;
    }
    const status = matchingStatus(publicationStatus, checkpoint, manifest);
    const evidenceOnly = !status;
    const evidence = status
      ? { checkpoint, manifest, publicationStatus: status, status: status.status }
      : { checkpoint, manifest, phase: checkpoint.phase };
    let tree;
    try { tree = await resolveTree(manifest.releaseRoot, checkpoint.preReleaseHead); }
    catch (cause) {
      throw Object.assign(new Error(`Historical release Git evidence unavailable: ${cause.message}`, { cause }),
        { code: "RELEASE_LEGACY_GIT_UNAVAILABLE" });
    }
    const sourceIdentity = status?.runId
      ? `publication-run:${status.runId}`
      : `release-checkpoint:${checkpoint.manifestHash}`;
    const result = store.importLegacy({
      workspaceId,
      streamId: String(status?.identity?.streamId ?? "legacy-release-migration"),
      threadId: String(status?.identity?.threadId ?? sourceIdentity),
      sourceKind: status ? "publication-status-v2" : "release-checkpoint-v2",
      sourceIdentity,
      evidence,
      evidenceOnly,
      authorization: {
        taskIds: selectedResults.map((item) => item.taskId),
        validationMode: String(status?.identity?.validationMode ?? "full"),
        approvedTargets: [{
          targetId: `legacy-publication:${entry.name}`,
          kind: "agent-hub-publication",
          repositoryRoot: manifest.primaryRoot,
          approvedLocalMainCommit: checkpoint.baseCommit,
          approvedOriginMainCommit: checkpoint.baseCommit,
        }],
      },
      runnerVersion,
      candidateGeneration: {
        createdAt: String(status?.startedAt ?? checkpoint.updatedAt ?? "1970-01-01T00:00:00.000Z"),
        repositoryBases: [{ repositoryRoot: manifest.primaryRoot, baseCommit: checkpoint.baseCommit }],
        selectedResults,
        candidates: [{
          repositoryRoot: manifest.primaryRoot,
          releaseRoot: manifest.releaseRoot,
          commit: checkpoint.preReleaseHead,
          tree,
          manifestHash: checkpoint.manifestHash,
        }],
        sourceFingerprint: checkpoint.manifestHash,
      },
    });
    imported.push({
      operationId: result.operation.operationId,
      created: result.created,
      state: result.operation.state,
      evidenceOnly,
      repositoryKey: entry.name,
    });
    } catch (error) {
      if (!(error instanceof SyntaxError) && !["ENOENT", "RELEASE_LEGACY_GIT_UNAVAILABLE",
        "RELEASE_LEGACY_EVIDENCE_CHANGED"].includes(error.code)) throw error;
      const diagnostic = { repositoryKey: entry.name, reason: "historical-evidence-unavailable",
        code: error.code ?? "INVALID_JSON", message: error.message };
      skipped.push(diagnostic);
      reportDiagnostic(diagnostic);
    }
  }
  return { imported, skipped };
}
