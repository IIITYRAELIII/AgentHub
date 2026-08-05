import path from "node:path";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class RunConflictPolicy {
  #d;
  #repoRoots = new Map();

  constructor(dependencies = {}) {
    for (const name of ["enabled", "resolveRepoRoots", "taskCatalog", "activeRuns", "findConflict"]) {
      requiredFunction(dependencies[name], name);
    }
    this.#d = dependencies;
  }

  async repositoryRoots(projectRoot) {
    const resolved = path.resolve(String(projectRoot ?? ""));
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (this.#repoRoots.has(key)) return this.#repoRoots.get(key);
    const repoRoots = await this.#d.resolveRepoRoots(projectRoot);
    // Do not cache an empty result: the directory may become a repository later.
    if (repoRoots.length) this.#repoRoots.set(key, repoRoots);
    return repoRoots;
  }

  async check(target) {
    if (!this.#d.enabled()) return null;
    const repoRoots = await this.repositoryRoots(target.projectRoot);
    if (!repoRoots.length) return null;
    const catalog = await this.#d.taskCatalog();
    const candidates = [
      ...this.#d.activeRuns(),
      ...catalog.filter((entry) => entry.running),
    ];
    const enriched = await Promise.all(candidates.map(async (candidate) => ({
      ...candidate,
      repoRoots: Array.isArray(candidate.gitBaseline?.repositories)
        ? candidate.gitBaseline.repositories.map((repository) => repository.repoRoot)
        : candidate.gitBaseline?.repoRoot
          ? [candidate.gitBaseline.repoRoot]
          : await this.repositoryRoots(candidate.projectRoot),
    })));
    return this.#d.findConflict(target, repoRoots, enriched);
  }
}
