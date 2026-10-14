import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { normalizedTaskNumber } from "./task-number.mjs";

export const TASK_BRANCH_PREFIX = "agenthub/task/";

export function taskGitIdentityHash(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

// An argument family of the existing status operation, never a separate ledger.
export function normalizedInitialNativeTest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Initial native Test identity is required");
  const keys = ["sourceRoot", "sourceCommit", "sourceTree", "sourceBranch", "mainCommit", "devCommit",
    "publicationHash", "candidateHash", "planRevision", "runtimeHash"];
  if (value.returnedResultCommit != null) keys.push("returnedResultCommit");
  if (Object.keys(value).length !== keys.length || keys.some(key => typeof value[key] !== "string" || !value[key].trim())) {
    throw new Error("Initial native Test requires its complete exact identity");
  }
  const result = Object.fromEntries(keys.map(key => [key, value[key].trim()]));
  if (result.returnedResultCommit && !/^[a-f0-9]{40}$/u.test(result.returnedResultCommit)) {
    throw new Error("Returned native Test requires an exact prior accepted result");
  }
  result.sourceRoot = path.resolve(result.sourceRoot);
  if (!["sourceCommit", "sourceTree", "mainCommit", "devCommit"].every(key => /^[a-f0-9]{40}$/u.test(result[key]))
      || !["publicationHash", "candidateHash", "planRevision", "runtimeHash"].every(key => /^[a-f0-9]{64}$/u.test(result[key]))
      || result.sourceBranch.length > 200 || result.sourceBranch.includes("\0")) {
    throw new Error("Initial native Test commit, tree, branch or hash is invalid");
  }
  return result;
}

function canonicalRoot(value) {
  const resolved = path.resolve(String(value ?? "").trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizedTaskId(value) {
  const taskId = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/u.test(taskId)) {
    throw new Error("Task Git reference requires a stable Task id");
  }
  return taskId;
}

export function taskRepositoryKey(projectRoot) {
  return createHash("sha256").update(canonicalRoot(projectRoot).toLowerCase(), "utf8").digest("hex").slice(0, 12);
}

export function taskBranchName(taskId, projectRoot, taskNumber = null) {
  const numbered = normalizedTaskNumber(taskNumber);
  return numbered || `${TASK_BRANCH_PREFIX}${normalizedTaskId(taskId)}/${taskRepositoryKey(projectRoot)}`;
}

export function normalizedTaskGitReferences(values = []) {
  const references = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const projectRoot = path.resolve(String(value?.projectRoot ?? "").trim());
    const branch = String(value?.branch ?? "").trim();
    const resultCommit = String(value?.resultCommit ?? value?.resultRevision ?? "").trim().toLowerCase();
    if (!projectRoot || !branch || !resultCommit) continue;
    if (!branch.startsWith(TASK_BRANCH_PREFIX)) normalizedTaskNumber(branch, { allowEmpty: false });
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(resultCommit)) {
      throw new Error(`Invalid Task result commit: ${resultCommit}`);
    }
    references.set(canonicalRoot(projectRoot), { projectRoot, branch, resultCommit });
  }
  return [...references.values()].sort((left, right) => canonicalRoot(left.projectRoot).localeCompare(canonicalRoot(right.projectRoot)));
}
// Only explicit ancestry validation refusals, before the dev merge starts.
export class TaskGitHistoryRejectedError extends Error {
  constructor(message) {
    super(message);
    this.code = "TASK_GIT_HISTORY_REJECTED";
  }
}
