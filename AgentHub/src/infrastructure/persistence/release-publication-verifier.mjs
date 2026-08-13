import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveTaskGitRepoRootsForFiles } from "../filesystem/task-git-diff.mjs";
import {
  assertCurrentPublicationRevision,
  gitOutput,
  parseWorkingTreeStatus,
  readPublicationState,
} from "./publication-state.mjs";

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readAgentHubPackage(repositoryRoot) {
  try {
    return JSON.parse(await readFile(path.join(repositoryRoot, "AgentHub", "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function verifyWorkspaceReleasePublication({ expectedRevision = null, plan } = {}, {
  resolveRoots = resolveTaskGitRepoRootsForFiles,
  status = gitOutput,
  assertRevision = assertCurrentPublicationRevision,
  readPublication = readPublicationState,
  readPackage = readAgentHubPackage,
} = {}) {
  const groupedChanges = new Map();
  for (const change of plan.ready) {
    const projectRoot = String(change.projectRoot ?? "").trim();
    if (!projectRoot) throw new Error("release change has no project root");
    const key = pathKey(projectRoot);
    const group = groupedChanges.get(key) ?? { projectRoot: path.resolve(projectRoot), files: [] };
    group.files.push(...(change.files ?? []));
    groupedChanges.set(key, group);
  }

  const repositoriesByRoot = new Map();
  for (const group of groupedChanges.values()) {
    const roots = await resolveRoots(group.projectRoot, group.files);
    if (!roots.length) throw new Error(`release repository is not found for: ${group.projectRoot}`);
    for (const root of roots) {
      const resolvedRoot = path.resolve(root);
      const key = pathKey(resolvedRoot);
      const repository = repositoriesByRoot.get(key) ?? { root: resolvedRoot, files: new Set() };
      for (const file of group.files) {
        const absoluteFile = path.resolve(group.projectRoot, String(file ?? ""));
        if (isInside(resolvedRoot, absoluteFile)) repository.files.add(absoluteFile);
      }
      repositoriesByRoot.set(key, repository);
    }
  }

  const repositories = [];
  for (const repository of repositoriesByRoot.values()) {
    const changes = parseWorkingTreeStatus(await status([
      "status", "--porcelain=v1", "--untracked-files=all",
    ], { cwd: repository.root }));
    if (changes.length) throw new Error(`release repository is dirty: ${repository.root}`);
    const revision = await assertRevision({ cwd: repository.root });
    repositories.push({ root: repository.root, revision });
  }
  if (expectedRevision && (repositories.length !== 1 || repositories[0].revision !== expectedRevision)) {
    throw new Error("release revision does not match expected_revision");
  }

  const agentHubRepositories = [];
  for (const repository of repositoriesByRoot.values()) {
    const agentHubRoot = path.join(repository.root, "AgentHub");
    if (![...repository.files].some((file) => isInside(agentHubRoot, file))) continue;
    const manifest = await readPackage(repository.root);
    if (manifest?.name !== "agent-hub") {
      throw new Error(`Agent Hub package is not found in release repository: ${repository.root}`);
    }
    agentHubRepositories.push(repository);
  }
  if (agentHubRepositories.length > 1) throw new Error("release contains multiple Agent Hub repositories");

  let agentHubPublication = null;
  if (agentHubRepositories.length === 1) {
    const repository = repositories.find(
      (item) => pathKey(item.root) === pathKey(agentHubRepositories[0].root),
    );
    const publication = await readPublication();
    if (!publication?.revision || publication.revision !== repository.revision) {
      throw new Error("Utilities revision is not the currently published Agent Hub revision");
    }
    agentHubPublication = {
      revision: publication.revision,
      publishedAt: publication.publishedAt ?? null,
      mode: publication.mode ?? null,
    };
  }
  return { repositories, agentHubPublication };
}
