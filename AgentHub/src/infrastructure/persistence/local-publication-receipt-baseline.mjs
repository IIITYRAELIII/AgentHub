import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseGitHubRemote } from "./github-publication-baseline.mjs";
import {
  gitOutput, publicationStateFile, readPublicationState, writePublicationState,
} from "./publication-state.mjs";
import { publicationRunPaths } from "./publication-run-store.mjs";
import { withPublicationLock } from "../process/publication-lock.mjs";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function requiredHash(value, pattern, name) {
  const text = requiredText(value, name).toLowerCase();
  if (!pattern.test(text)) throw new Error(`${name} has an invalid hash`);
  return text;
}

function canonicalRoot(value) {
  const resolved = path.resolve(requiredText(value, "project root"));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalOrigin(value) {
  const text = requiredText(value, "origin URL");
  const github = parseGitHubRemote(text);
  if (github) return `github:${github.owner.toLowerCase()}/${github.repo.toLowerCase()}`;
  return text.replace(/\/+$/u, "").toLowerCase();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
  };
  return JSON.stringify(normalize(value));
}

function legacyCore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "repositories"));
}

function repositoryRootOf(value) {
  return String(value?.root ?? value?.projectRoot ?? "").trim();
}

function repositoryRevisionOf(value) {
  return String(value?.revision ?? value?.publishedRevision ?? "").trim();
}

function parseJson(raw, name) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function exactDate(value, expected, name) {
  const actual = requiredText(value, name);
  if (!Number.isFinite(Date.parse(actual)) || actual !== expected) {
    throw new Error(`${name} does not match the operator-bound value`);
  }
  return actual;
}

export function localPublicationReceiptRequest(input = {}) {
  return {
    projectRoot: path.resolve(requiredText(input.projectRoot, "project root")),
    workspaceId: requiredText(input.workspaceId, "Workspace id"),
    runId: requiredText(input.runId, "publication run id"),
    expectedRevision: requiredHash(input.expectedRevision, COMMIT_PATTERN, "published revision"),
    expectedGeneration: requiredText(input.expectedGeneration, "publication generation"),
    expectedPublishedAt: requiredText(input.expectedPublishedAt, "publication timestamp"),
    expectedStateSha256: requiredHash(input.expectedStateSha256, SHA256_PATTERN, "publication state SHA-256"),
    expectedReceiptSha256: requiredHash(input.expectedReceiptSha256, SHA256_PATTERN, "publication receipt SHA-256"),
    expectedReleaseId: requiredText(input.expectedReleaseId, "runtime release id"),
    expectedOriginUrl: requiredText(input.expectedOriginUrl, "origin URL"),
    expectedOriginMainCommit: requiredHash(input.expectedOriginMainCommit, COMMIT_PATTERN, "origin/main commit"),
    requestId: requiredText(input.requestId, "operator request id"),
  };
}

async function defaultReadEvidence({ stateFile, statusFile, runtimeRoot, releaseId }) {
  const [stateRaw, receiptRaw, activeRaw, manifestRaw] = await Promise.all([
    readFile(stateFile, "utf8"),
    readFile(statusFile, "utf8"),
    readFile(path.join(runtimeRoot, "active.json"), "utf8"),
    readFile(path.join(runtimeRoot, "releases", releaseId, "runtime-manifest.json"), "utf8"),
  ]);
  return {
    stateRaw,
    receiptRaw,
    active: parseJson(activeRaw, "active runtime record"),
    manifest: parseJson(manifestRaw, "runtime manifest"),
  };
}

function assertLegacyState(state, request, receiptPublicationState) {
  if (!state || typeof state !== "object" || Array.isArray(state)
      || repositoryRootOf(state)
      || String(state?.primaryRoot ?? state?.release?.primaryRoot ?? "").trim()) {
    throw new Error("local publication receipt requires an unscoped legacy Agent Hub publication state");
  }
  if (state.revision !== request.expectedRevision
      || state.generation !== request.expectedGeneration
      || state.publishedAt !== request.expectedPublishedAt) {
    throw new Error("legacy publication state identity changed");
  }
  if (!Array.isArray(state.files) || !state.files.length
      || !state.plan || typeof state.plan !== "object" || Array.isArray(state.plan)) {
    throw new Error("legacy publication state is incomplete");
  }
  exactDate(state.publishedAt, request.expectedPublishedAt, "publication timestamp");
  if (stable(legacyCore(state)) !== stable(receiptPublicationState)) {
    throw new Error("publisher receipt publication state does not match the legacy state");
  }
}

function assertPublisherReceipt(receipt, request) {
  const release = receipt?.identity?.release;
  const publication = receipt?.progress?.publicationState;
  if (receipt?.version !== 2 || receipt?.status !== "succeeded" || receipt?.error != null) {
    throw new Error("local publication receipt is not a successful terminal publisher receipt");
  }
  if (receipt.runId !== request.runId || !release || !publication) {
    throw new Error("local publication receipt identity does not match the operator-bound run");
  }
  if (canonicalRoot(release.primaryRoot) !== canonicalRoot(request.projectRoot)
      || release.workspaceId !== request.workspaceId) {
    throw new Error("local publication receipt targets another repository or Workspace");
  }
  if (receipt.identity?.revision !== request.expectedRevision
      || release.preReleaseHead !== request.expectedRevision
      || publication.revision !== request.expectedRevision
      || publication.generation !== request.expectedGeneration
      || publication.publishedAt !== request.expectedPublishedAt) {
    throw new Error("local publication receipt revision or publication identity changed");
  }
  if (!release.planRevision || !release.manifestHash || !release.baseCommit
      || receipt.progress?.expectedReleaseId !== request.expectedReleaseId
      || !receipt.progress?.finalizationCommandId) {
    throw new Error("local publication receipt is missing release finalization evidence");
  }
  return { release, publication };
}

function expectedRepositoryEvidence({ request, receipt, release, originMain, originIdentity }) {
  return {
    root: request.projectRoot,
    revision: request.expectedRevision,
    planRevision: release.planRevision,
    manifestHash: release.manifestHash,
    baseCommit: release.baseCommit,
    preReleaseHead: release.preReleaseHead,
    publishedAt: request.expectedPublishedAt,
    adoptedFrom: "local-publisher-receipt",
    publisher: {
      kind: "agent-hub-publication-receipt",
      workspaceId: request.workspaceId,
      runId: request.runId,
      generation: request.expectedGeneration,
      expectedReleaseId: request.expectedReleaseId,
      finalizationCommandId: receipt.progress.finalizationCommandId,
      legacyStateSha256: request.expectedStateSha256,
      receiptSha256: request.expectedReceiptSha256,
      originIdentity,
      originMainCommit: originMain,
      operatorRequestId: request.requestId,
    },
  };
}

export async function verifyLocalPublicationReceiptBaseline(input = {}, {
  stateFile = publicationStateFile(),
  statusFile = publicationRunPaths().statusFile,
  readEvidence = defaultReadEvidence,
  git = gitOutput,
} = {}) {
  const request = localPublicationReceiptRequest(input);
  const runtimeRoot = path.dirname(stateFile);
  const evidence = await readEvidence({
    stateFile, statusFile, runtimeRoot, releaseId: request.expectedReleaseId,
  });
  const state = parseJson(evidence.stateRaw, "publication state");
  const receipt = parseJson(evidence.receiptRaw, "publication receipt");
  const { release, publication } = assertPublisherReceipt(receipt, request);
  assertLegacyState(state, request, publication);
  if (digest(evidence.receiptRaw) !== request.expectedReceiptSha256) {
    throw new Error("publication receipt raw bytes changed");
  }
  if (evidence.active?.release !== request.expectedReleaseId
      || evidence.manifest?.releaseId !== request.expectedReleaseId) {
    throw new Error("publisher receipt runtime release is not the active installed release");
  }
  const expectedSourceRoot = path.join(requiredText(receipt.identity?.worktreeRoot, "publisher worktree root"), "AgentHub");
  if (canonicalRoot(evidence.active?.sourceRoot) !== canonicalRoot(expectedSourceRoot)
      || canonicalRoot(evidence.manifest?.sourceRoot) !== canonicalRoot(expectedSourceRoot)) {
    throw new Error("active runtime source does not match the publisher receipt checkout");
  }
  const activatedAt = requiredText(evidence.active?.activatedAt, "runtime activation timestamp");
  if (!Number.isFinite(Date.parse(activatedAt)) || Date.parse(activatedAt) > Date.parse(request.expectedPublishedAt)) {
    throw new Error("runtime activation timestamp is inconsistent with publication completion");
  }

  const actualOriginUrl = await git(["config", "--get", "remote.origin.url"], { cwd: request.projectRoot });
  const originIdentity = canonicalOrigin(actualOriginUrl);
  if (originIdentity !== canonicalOrigin(request.expectedOriginUrl)) {
    throw new Error("local publication receipt targets another canonical origin");
  }
  const [localMain, originMain] = await Promise.all([
    git(["rev-parse", "refs/heads/main"], { cwd: request.projectRoot }),
    git(["rev-parse", "refs/remotes/origin/main"], { cwd: request.projectRoot }),
  ]);
  if (localMain !== request.expectedRevision) throw new Error("local main moved from the published legacy revision");
  if (originMain !== request.expectedOriginMainCommit) throw new Error("origin/main moved from the operator-bound observation");
  try {
    await git(["merge-base", "--is-ancestor", request.expectedRevision, originMain], { cwd: request.projectRoot });
  } catch {
    throw new Error("published legacy revision is not contained in origin/main");
  }

  const repository = expectedRepositoryEvidence({ request, receipt, release, originMain, originIdentity });
  const existing = (Array.isArray(state.repositories) ? state.repositories : []).find((entry) => (
    repositoryRootOf(entry) && canonicalRoot(repositoryRootOf(entry)) === canonicalRoot(request.projectRoot)
  ));
  if (existing && stable(existing) !== stable(repository)) {
    throw new Error("conflicting repository-scoped publication evidence already exists");
  }
  if (!existing && digest(evidence.stateRaw) !== request.expectedStateSha256) {
    throw new Error("publication state raw bytes changed");
  }
  if (existing && repositoryRevisionOf(existing) !== request.expectedRevision) {
    throw new Error("repository-scoped publication evidence is stale");
  }
  return { request, repository, alreadyAdopted: Boolean(existing) };
}

export async function previewLocalPublicationReceiptBaseline(input = {}, dependencies = {}) {
  const verified = await verifyLocalPublicationReceiptBaseline(input, dependencies);
  return {
    status: verified.alreadyAdopted ? "already_adopted" : "preview",
    repository: verified.repository,
    effects: ["no publication state write"],
  };
}

export async function enableLocalPublicationReceiptBaseline(input = {}, {
  lock = withPublicationLock,
  writeState = (state) => writePublicationState(state),
  ...dependencies
} = {}) {
  const preview = await verifyLocalPublicationReceiptBaseline(input, dependencies);
  const result = await lock(async () => {
    const verified = await verifyLocalPublicationReceiptBaseline(input, dependencies);
    if (stable(verified.repository) !== stable(preview.repository)
        || verified.alreadyAdopted !== preview.alreadyAdopted) {
      throw new Error("local publication receipt baseline changed before the guarded write");
    }
    if (!verified.alreadyAdopted) await writeState({ repositories: [verified.repository] });
    return verified;
  });
  return {
    status: result.alreadyAdopted ? "already_adopted" : "adopted",
    repository: result.repository,
    effects: result.alreadyAdopted ? ["no publication state write"] : ["repository-scoped publication state write"],
  };
}
