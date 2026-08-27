import { createHash } from "node:crypto";

export const CHANGE_SET_STATUSES = Object.freeze(["draft", "ready", "released", "discarded"]);
export const CHANGE_SET_FILE_OPERATIONS = Object.freeze(["added", "modified", "deleted"]);

const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function identifier(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 200 || normalized.includes("\0")) {
    throw new Error(`invalid ${name}`);
  }
  return normalized;
}

function boundedText(value, name, maximumLength) {
  const normalized = String(value ?? "").trim();
  if (normalized.length > maximumLength || normalized.includes("\0")) {
    throw new Error(`invalid ${name}`);
  }
  return normalized;
}

function normalizedRoot(value) {
  const root = boundedText(value, "repository root", 2_000).replaceAll("\\", "/").replace(/\/$/u, "");
  if (!root) throw new Error("repository root is required");
  return /^[a-z]:\//iu.test(root) ? `${root[0].toLowerCase()}${root.slice(1)}` : root;
}

function normalizedPath(value) {
  const file = boundedText(value, "file path", 2_000).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!file || file.startsWith("/") || /^[a-z]:\//iu.test(file) || file.split("/").includes("..")) {
    throw new Error("file path must be repository-relative");
  }
  return file;
}

function gitObject(value, name, { allowAbsent = false } = {}) {
  const normalized = boundedText(value, name, 80).toLowerCase();
  if (allowAbsent && normalized === "absent") return normalized;
  if (!GIT_OBJECT_PATTERN.test(normalized)) throw new Error(`${name} must be an exact Git object id`);
  return normalized;
}

function patchHash(value) {
  const normalized = boundedText(value, "patch hash", 80).toLowerCase();
  if (!normalized) return "";
  if (!SHA256_PATTERN.test(normalized)) throw new Error("patch hash must be SHA-256");
  return normalized;
}

export function normalizedChangeSetId(value) {
  return identifier(value, "ChangeSet id");
}

export function normalizedDashboardTaskId(value) {
  if (value == null || String(value).trim() === "") return null;
  return identifier(value, "Dashboard task id");
}

export function changeSetLogicalKey({ taskId = null, changeSetId } = {}) {
  const normalizedTaskId = normalizedDashboardTaskId(taskId);
  return normalizedTaskId
    ? `task:${normalizedTaskId}`
    : `changeset:${normalizedChangeSetId(changeSetId)}`;
}

export function normalizedChangeSetStatus(value, { allowReleased = false } = {}) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!CHANGE_SET_STATUSES.includes(status)) throw new Error("invalid ChangeSet status");
  if (status === "released" && !allowReleased) throw new Error("released status is reserved for ReleaseBatch completion");
  return status;
}

export function normalizedTurnObservation({
  provider, threadId, turnId, projectRoot = "", summary = "", status = "completed",
  changedFiles = [], diffHash = "", legacyChangeId = null,
} = {}) {
  const normalizedProvider = identifier(provider, "provider").toLowerCase();
  const normalizedThreadId = identifier(threadId, "provider thread id");
  const normalizedTurnId = identifier(turnId, "provider turn id");
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : [])
    .map((file) => String(file ?? "").trim().replaceAll("\\", "/"))
    .filter((file) => file && !file.includes("\0")))].slice(0, 500);
  if (!files.length) throw new Error("TurnObservation requires changed files");
  const normalizedDiffHash = boundedText(diffHash, "observation diff hash", 128).toLowerCase();
  if (normalizedDiffHash && !SHA256_PATTERN.test(normalizedDiffHash)) {
    throw new Error("observation diff hash must be SHA-256");
  }
  return {
    provider: normalizedProvider,
    threadId: normalizedThreadId,
    turnId: normalizedTurnId,
    projectRoot: boundedText(projectRoot, "project root", 2_000),
    summary: boundedText(summary, "observation summary", 500),
    observedStatus: boundedText(status, "observation status", 40).toLowerCase() || "completed",
    files,
    diffHash: normalizedDiffHash,
    legacyChangeId: legacyChangeId == null ? null : identifier(legacyChangeId, "legacy release change id"),
  };
}

export function normalizedDraftChangeSetFiles(files = []) {
  const normalized = (Array.isArray(files) ? files : []).map((file) => ({
    projectRoot: normalizedRoot(file?.projectRoot),
    path: normalizedPath(file?.path),
  }));
  if (normalized.length > 500) throw new Error("draft ChangeSet file selection is too large");
  const unique = new Map(normalized.map((file) => [`${file.projectRoot}\0${file.path}`, file]));
  return [...unique.values()].toSorted((left, right) => (
    left.projectRoot.localeCompare(right.projectRoot) || left.path.localeCompare(right.path)
  ));
}

export function frozenChangeSetManifest({ revision, repositories = [], files = [] } = {}) {
  const normalizedRevision = Number(revision);
  if (!Number.isSafeInteger(normalizedRevision) || normalizedRevision < 1) {
    throw new Error("ChangeSet revision must be a positive integer");
  }
  const normalizedRepositories = (Array.isArray(repositories) ? repositories : []).map((repository) => ({
    projectRoot: normalizedRoot(repository?.projectRoot),
    baseRevision: gitObject(repository?.baseRevision, "base revision"),
    resultRevision: gitObject(repository?.resultRevision, "result revision"),
  })).toSorted((left, right) => left.projectRoot.localeCompare(right.projectRoot));
  if (!normalizedRepositories.length) throw new Error("freeze requires repository revisions");
  if (new Set(normalizedRepositories.map((item) => item.projectRoot)).size !== normalizedRepositories.length) {
    throw new Error("freeze contains duplicate repository roots");
  }
  const repositoryRoots = new Set(normalizedRepositories.map((item) => item.projectRoot));
  const normalizedFiles = (Array.isArray(files) ? files : []).map((file) => {
    const operation = String(file?.operation ?? "").trim().toLowerCase();
    if (!CHANGE_SET_FILE_OPERATIONS.includes(operation)) throw new Error("invalid frozen file operation");
    const projectRoot = normalizedRoot(file?.projectRoot);
    if (!repositoryRoots.has(projectRoot)) throw new Error("frozen file does not belong to a declared repository");
    const baseBlob = gitObject(file?.baseBlob, "base blob", { allowAbsent: true });
    const resultBlob = gitObject(file?.resultBlob, "result blob", { allowAbsent: true });
    if (baseBlob === "absent" && resultBlob === "absent") throw new Error("frozen file cannot be absent on both sides");
    if (operation === "added" && baseBlob !== "absent") throw new Error("added file must have an absent base blob");
    if (operation === "deleted" && resultBlob !== "absent") throw new Error("deleted file must have an absent result blob");
    if (operation === "modified" && (baseBlob === "absent" || resultBlob === "absent")) {
      throw new Error("modified file requires exact base and result blobs");
    }
    return {
      projectRoot,
      path: normalizedPath(file?.path),
      operation,
      baseBlob,
      resultBlob,
      patchHash: patchHash(file?.patchHash),
    };
  }).toSorted((left, right) => (
    left.projectRoot.localeCompare(right.projectRoot) || left.path.localeCompare(right.path)
  ));
  if (!normalizedFiles.length) throw new Error("freeze requires exact file evidence");
  const identities = normalizedFiles.map((file) => `${file.projectRoot}\0${file.path}`);
  if (new Set(identities).size !== identities.length) throw new Error("freeze contains duplicate files");
  const manifest = {
    schemaVersion: 1,
    revision: normalizedRevision,
    repositories: normalizedRepositories,
    files: normalizedFiles,
  };
  return {
    ...manifest,
    manifestHash: createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex"),
  };
}

export function normalizedReleaseBatch({
  id, workspaceId, planRevision, changeSetIds = [], repositoryRevisions = [],
  publicationEvidence = {}, deploymentEvidence = {},
} = {}) {
  const changes = [...new Set((Array.isArray(changeSetIds) ? changeSetIds : [])
    .map((changeSetId) => normalizedChangeSetId(changeSetId)))];
  if (!changes.length) throw new Error("ReleaseBatch requires ChangeSets");
  const repositories = (Array.isArray(repositoryRevisions) ? repositoryRevisions : []).map((repository) => ({
    projectRoot: normalizedRoot(repository?.projectRoot),
    revision: gitObject(repository?.revision, "released repository revision"),
  })).toSorted((left, right) => left.projectRoot.localeCompare(right.projectRoot));
  if (!repositories.length) throw new Error("ReleaseBatch requires repository revisions");
  return {
    id: normalizedChangeSetId(id),
    workspaceId: identifier(workspaceId, "workspace id"),
    planRevision: identifier(planRevision, "release plan revision"),
    changeSetIds: changes.toSorted(),
    repositoryRevisions: repositories,
    publicationEvidence: publicationEvidence && typeof publicationEvidence === "object" ? publicationEvidence : {},
    deploymentEvidence: deploymentEvidence && typeof deploymentEvidence === "object" ? deploymentEvidence : {},
  };
}
