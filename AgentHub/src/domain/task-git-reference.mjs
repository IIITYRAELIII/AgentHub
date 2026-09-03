import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { normalizedTaskNumber } from "./task-number.mjs";

export const TASK_BRANCH_PREFIX = "agenthub/task/";

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
