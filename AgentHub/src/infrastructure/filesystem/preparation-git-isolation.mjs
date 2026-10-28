import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

const contexts = new AsyncLocalStorage();
export const isolationDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function preparationIsolationLayout(dataDir, projectRoot, requestId, argumentsHash) {
  const key = isolationDigest({ requestId, argumentsHash, projectRoot: path.resolve(projectRoot) });
  return { key, dataDir: path.join(dataDir, "release-prep", key.slice(0, 24)) };
}
export async function assertPlainIsolationPath(value) {
  const absolute = path.resolve(value), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const name of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, name);
    const entry = await lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!entry) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Preparation isolation path is not plain: ${current}`);
  }
}
export const preparationGitIsolationActive = () => Boolean(contexts.getStore());
export function withPreparationGitIsolation(dataDir, operation, lease = null) {
  return contexts.run({ dataDir, lease, gitTail: Promise.resolve() }, operation);
}
export function guardedPreparationGit(operation) {
  const active = contexts.getStore();
  if (!active?.lease) return null;
  // The existing guard has one active child per owned repository. This queue
  // is scoped to this root/invocation, never a global execution lane.
  const result = active.gitTail.then(() => operation(active.lease));
  active.gitTail = result.catch(() => {});
  return result;
}
export function preparationGitInvocation(args, cwd) {
  const active = contexts.getStore();
  if (!active) return { args };
  const noHooks = ["-c", `core.hooksPath=${path.join(active.dataDir, "empty-hooks")}`, "-c", "core.fsmonitor=false",
    "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
  // Read-only remote authentication remains with the existing credential owner;
  // it cannot update a remote ref or publish a candidate. Local object/ref/index
  // operations inherit neither global config, templates nor Git path overrides.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
  if (args[0] === "ls-remote" || args[0] === "fetch" && args.includes("origin")) {
    // Use ordinary remote authentication, but never inherit Git directory,
    // object/index, command-config or worktree redirects for this local clone.
    if (process.env.GIT_CONFIG_GLOBAL) env.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
    return { args: [...noHooks, "-c", `core.worktree=${cwd}`, ...args], env };
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(active.dataDir, "empty-gitconfig"),
    GIT_TERMINAL_PROMPT: "0" });
  return { args: ["--no-replace-objects", "--no-lazy-fetch", ...noHooks,
    ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
    "-c", `init.templateDir=${path.join(active.dataDir, "empty-hooks")}`, ...args], env };
}
