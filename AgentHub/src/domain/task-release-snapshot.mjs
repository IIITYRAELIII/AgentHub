import { createHash } from "node:crypto";
import path from "node:path";

const OPERATIONS = new Set(["added", "modified", "deleted"]);

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
      taskRevision: task.revision,
      manifestHash: taskReleaseManifest({
        taskId: task.id,
        revision: task.revision,
        changedFiles: task.changedFiles,
        repositoryRevisions: task.repositoryRevisions,
      }),
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
      entry.tasks.push({ id: task.id, streamId: task.streamId, revision: task.revision });
      owners.set(key, entry);
    }
  }
  return [...owners.values()].filter((entry) => new Set(entry.tasks.map((task) => task.id)).size > 1);
}
