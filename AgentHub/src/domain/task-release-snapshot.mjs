import { createHash } from "node:crypto";
import path from "node:path";

const OPERATIONS = new Set(["added", "modified", "deleted"]);
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function canonicalRoot(value) {
  const resolved = path.resolve(String(value ?? "").trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizedRelativePath(value) {
  const normalized = String(value ?? "").trim().replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized)) throw new Error("Task release file path must be relative");
  const resolved = path.posix.normalize(normalized);
  if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
    throw new Error("Task release file path escapes its project root");
  }
  return resolved;
}

function normalizedEvidenceRoot(value) {
  const normalized = String(value ?? "").trim().replaceAll("\\", "/").replace(/\/$/u, "");
  if (!normalized) throw new Error("Task release repository root is required");
  return /^[a-z]:\//iu.test(normalized) ? `${normalized[0].toLowerCase()}${normalized.slice(1)}` : normalized;
}

function gitObject(value, name, { allowAbsent = false } = {}) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (allowAbsent && normalized === "absent") return normalized;
  if (!GIT_OBJECT_PATTERN.test(normalized)) throw new Error(`${name} must be an exact Git object id`);
  return normalized;
}

function normalizedPatchHash(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "";
  if (!SHA256_PATTERN.test(normalized)) throw new Error("patch hash must be SHA-256");
  return normalized;
}

export function normalizedTaskChangedFiles(values = []) {
  const files = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const projectRoot = path.resolve(String(value?.projectRoot ?? "").trim());
    const filePath = normalizedRelativePath(value?.path);
    const operation = String(value?.operation ?? "modified").trim().toLowerCase();
    if (!OPERATIONS.has(operation)) throw new Error(`Invalid Task release operation: ${operation}`);
    const turnId = String(value?.turnId ?? "").trim() || null;
    const key = `${canonicalRoot(projectRoot)}\0${process.platform === "win32" ? filePath.toLowerCase() : filePath}`;
    files.set(key, { projectRoot, path: filePath, operation, turnId });
  }
  return [...files.values()].sort((left, right) => (
    canonicalRoot(left.projectRoot).localeCompare(canonicalRoot(right.projectRoot))
    || left.path.localeCompare(right.path)
  ));
}

function mergedOperation(previous, incoming) {
  if (!previous) return incoming;
  if (previous === "added" && incoming === "deleted") return null;
  if (previous === "deleted" && incoming === "added") return "modified";
  if (previous === "added") return "added";
  return incoming;
}

export function mergeTaskChangedFiles(current = [], incoming = []) {
  const values = new Map(normalizedTaskChangedFiles(current).map((file) => [
    `${canonicalRoot(file.projectRoot)}\0${process.platform === "win32" ? file.path.toLowerCase() : file.path}`,
    file,
  ]));
  for (const file of normalizedTaskChangedFiles(incoming)) {
    const key = `${canonicalRoot(file.projectRoot)}\0${process.platform === "win32" ? file.path.toLowerCase() : file.path}`;
    const previous = values.get(key);
    const operation = mergedOperation(previous?.operation, file.operation);
    if (!operation) values.delete(key);
    else values.set(key, { ...file, operation });
  }
  return normalizedTaskChangedFiles([...values.values()]);
}

export function frozenTaskReleaseManifest({ revision, repositories = [], files = [] } = {}) {
  const normalizedRevision = Number(revision);
  if (!Number.isSafeInteger(normalizedRevision) || normalizedRevision < 1) {
    throw new Error("Task release revision must be a positive integer");
  }
  const normalizedRepositories = (Array.isArray(repositories) ? repositories : []).map((repository) => ({
    projectRoot: normalizedEvidenceRoot(repository?.projectRoot),
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
    if (!OPERATIONS.has(operation)) throw new Error("invalid frozen file operation");
    const projectRoot = normalizedEvidenceRoot(file?.projectRoot);
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
      path: normalizedRelativePath(file?.path),
      operation,
      baseBlob,
      resultBlob,
      patchHash: normalizedPatchHash(file?.patchHash),
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

export function taskReleaseManifest({ taskId, revision, changedFiles, repositoryRevisions = [] } = {}) {
  const payload = JSON.stringify({
    taskId: String(taskId ?? "").trim(),
    revision: Number(revision) || 0,
    changedFiles: normalizedTaskChangedFiles(changedFiles),
    repositoryRevisions: [...repositoryRevisions].sort((left, right) => (
      canonicalRoot(left.projectRoot).localeCompare(canonicalRoot(right.projectRoot))
    )),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function taskReleasePlanRevision(workspaceId, tasks = []) {
  const payload = JSON.stringify({
    workspaceId: String(workspaceId ?? "").trim(),
    tasks: tasks.map((task) => ({
      id: task.id,
      taskRevision: task.releaseRevision ?? task.frozenRevision ?? task.revision,
      manifestHash: task.releaseManifestHash,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function taskReleaseConflicts(tasks = []) {
  const owners = new Map();
  for (const task of tasks) {
    for (const file of normalizedTaskChangedFiles(task.changedFiles)) {
      if (/^(?:Utilities\/)?CHANGELOG\.md$/iu.test(file.path)) continue;
      const key = `${canonicalRoot(file.projectRoot)}\0${process.platform === "win32" ? file.path.toLowerCase() : file.path}`;
      const entry = owners.get(key) ?? { projectRoot: file.projectRoot, file: file.path, tasks: [] };
      entry.tasks.push({ id: task.id, streamId: task.streamId, revision: task.releaseRevision });
      owners.set(key, entry);
    }
  }
  return [...owners.values()].filter((entry) => new Set(entry.tasks.map((task) => task.id)).size > 1);
}
