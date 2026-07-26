import path from "node:path";
import { taskRunKey } from "./task-runs.mjs";

function normalizedPath(value) {
  const resolved = path.resolve(String(value ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function findRepositoryWriteConflict(target, repoRoots, candidates = []) {
  const targetRoots = new Set((Array.isArray(repoRoots) ? repoRoots : [repoRoots])
    .filter(Boolean)
    .map(normalizedPath));
  if (!targetRoots.size) return null;
  const targetKey = taskRunKey(target);
  return candidates.find((candidate) => (
    taskRunKey(candidate) !== targetKey
      && (Array.isArray(candidate?.repoRoots) ? candidate.repoRoots : [candidate?.repoRoot])
        .filter(Boolean)
        .some((repoRoot) => targetRoots.has(normalizedPath(repoRoot)))
  )) ?? null;
}
