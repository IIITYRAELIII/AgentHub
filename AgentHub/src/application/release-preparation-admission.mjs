import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalMcpValue } from "../domain/mcp-arguments-hash.mjs";
import { ReleasePreparationRejectedError } from "../domain/release-preparation.mjs";
export { ReleasePreparationRejectedError } from "../domain/release-preparation.mjs";

export const preparationHash = (value) => createHash("sha256")
  .update(JSON.stringify(canonicalMcpValue(value))).digest("hex");

function object(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !fields.includes(key))
      || fields.some((key) => !Object.hasOwn(value, key))) {
    throw new ReleasePreparationRejectedError(`Invalid exact ${label} envelope`);
  }
}
function text(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max) {
    throw new ReleasePreparationRejectedError(`Invalid ${label}`);
  }
}
function digest(value, length, label) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value)) {
    throw new ReleasePreparationRejectedError(`Invalid ${label}`);
  }
}
function unique(items, key, label) {
  if (!Array.isArray(items) || !items.length || items.length > 128
      || new Set(items.map((item) => item?.[key])).size !== items.length) {
    throw new ReleasePreparationRejectedError(`Invalid ${label} set`);
  }
}

// Deliberately no selection, Task transition, publication or arbitrary path
// for importing an owner. Every byte of this envelope participates in intake.
export function validatePreparationEnvelope(value) {
  object(value, ["schemaVersion", "planRevision", "publicationHash", "sourceCommit",
    "sourceTree", "sourceClosureHash", "tasks", "repositories"], "preparation");
  if (value.schemaVersion !== 1) throw new ReleasePreparationRejectedError("Unsupported preparation schema");
  text(value.planRevision, "plan revision", 128);
  for (const key of ["publicationHash", "sourceClosureHash"]) digest(value[key], 64, key);
  for (const key of ["sourceCommit", "sourceTree"]) digest(value[key], 40, key);
  unique(value.tasks, "taskId", "Task");
  for (const task of value.tasks) {
    object(task, ["taskId", "rowRevision", "taskRevision", "baseCommit", "resultCommit", "projectRoot"], "Task");
    text(task.taskId, "Task id");
    text(task.projectRoot, "Task repository", 2048);
    digest(task.resultCommit, 40, "Task result");
    digest(task.baseCommit, 40, "Task registered base");
    for (const key of ["rowRevision", "taskRevision"]) {
      if (!Number.isSafeInteger(task[key]) || task[key] < 1) throw new ReleasePreparationRejectedError("Invalid Task CAS");
    }
  }
  unique(value.repositories, "projectRoot", "repository");
  if (value.repositories.length > 8) throw new ReleasePreparationRejectedError("Too many repositories");
  for (const repository of value.repositories) {
    object(repository, ["projectRoot", "approvedBaseCommit", "publishedRevision", "primaryMainCommit", "originMainCommit",
      "checkpointHash", "manifestHash", "preReleaseHead", "tree", "approvedTree"], "repository");
    text(repository.projectRoot, "repository root", 2048);
    for (const key of ["checkpointHash", "manifestHash"]) digest(repository[key], 64, key);
    for (const key of ["approvedBaseCommit", "publishedRevision", "primaryMainCommit", "originMainCommit",
      "preReleaseHead", "tree", "approvedTree"]) digest(repository[key], 40, key);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 48 * 1024) {
    throw new ReleasePreparationRejectedError("Preparation envelope exceeds its bounded receipt budget");
  }
  return structuredClone(value);
}

// Fixed runtime root, complete src inventory and executable/package entrypoints.
// No caller-supplied inventory can silently omit an imported module. Frozen
// loading additionally verifies these bytes before importing the factory.
export async function readPreparationSourceClosure(root = fileURLToPath(new URL("../../", import.meta.url))) {
  const inventory = [];
  let total = 0;
  const visit = async (relative) => {
    const target = path.join(root, relative);
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) throw new ReleasePreparationRejectedError("Source closure contains a link");
    if (entry.isDirectory()) {
      for (const name of (await readdir(target)).sort()) await visit(path.join(relative, name));
    } else {
      if (!entry.isFile() || inventory.length >= 4096 || (total += entry.size) > 32 * 1024 * 1024) {
        throw new ReleasePreparationRejectedError("Source closure exceeds its bounded regular-file inventory");
      }
      const bytes = await readFile(target);
      inventory.push({ path: relative.split(path.sep).join("/"), length: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  };
  await visit("src");
  for (const name of (await readdir(root)).sort()) {
    if (/\.(?:mjs|cjs|js)$/u.test(name) || /^package(?:-lock)?\.json$/u.test(name)) await visit(name);
  }
  inventory.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { hash: preparationHash(inventory), files: inventory.length, bytes: total };
}

export function assertPreparationRows(envelope, taskBoard, workspaceId) {
  for (const expected of envelope.tasks) {
    const actual = taskBoard.task(expected.taskId);
    if (!actual || actual.workspaceId !== workspaceId || actual.workflowStatus !== "awaiting_implementation"
        || actual.revision !== expected.rowRevision) {
      throw new ReleasePreparationRejectedError(`Selected Task CAS changed: ${expected.taskId}`);
    }
  }
}
