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

async function readAgentHubPackage(repositoryRoot, revision = null) {
  try {
    if (revision) {
      return JSON.parse(await gitOutput(["show", `${revision}:AgentHub/package.json`], { cwd: repositoryRoot }));
    }
    return JSON.parse(await readFile(path.join(repositoryRoot, "AgentHub", "package.json"), "utf8"));
  } catch (error) {
    if (revision || error.code === "ENOENT") return null;
    throw error;
  }
}

async function repositoryIdentity(repositoryRoot) {
  try {
    const origin = await gitOutput(["config", "--get", "remote.origin.url"], { cwd: repositoryRoot });
    if (origin) return `origin:${origin}`;
  } catch {}
  return `root:${pathKey(repositoryRoot)}`;
}

async function assertRevisionAncestor({ repositoryRoot, ancestor, descendant }) {
  await gitOutput(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repositoryRoot });
}

export async function verifyWorkspaceReleasePublication({ expectedRevision = null, plan } = {}, {
  resolveRoots = resolveTaskGitRepoRootsForFiles,
  status = gitOutput,
  assertRevision = assertCurrentPublicationRevision,
  identifyRepository = repositoryIdentity,
  assertAncestor = assertRevisionAncestor,
  readPublication = readPublicationState,
  readPackage = readAgentHubPackage,
} = {}) {
  const frozenRevisionsByProjectRoot = new Map();
  for (const candidate of plan.candidates ?? []) {
    for (const repository of candidate.frozenRepositories ?? []) {
      const projectRoot = String(repository.projectRoot ?? "").trim();
      const resultRevision = String(repository.resultRevision ?? "").trim();
      if (!projectRoot || !resultRevision) continue;
      const key = pathKey(projectRoot);
      const revisions = frozenRevisionsByProjectRoot.get(key) ?? new Set();
      revisions.add(resultRevision);
      frozenRevisionsByProjectRoot.set(key, revisions);
    }
  }
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
      const matchingFiles = group.files
        .map((file) => path.resolve(group.projectRoot, String(file ?? "")))
        .filter((file) => isInside(resolvedRoot, file));
      if (!matchingFiles.length) continue;
      const key = pathKey(resolvedRoot);
      const repository = repositoriesByRoot.get(key) ?? {
        root: resolvedRoot,
        files: new Set(),
        frozenRevisions: new Set(),
      };
      for (const file of matchingFiles) repository.files.add(file);
      for (const revision of frozenRevisionsByProjectRoot.get(pathKey(group.projectRoot)) ?? []) {
        repository.frozenRevisions.add(revision);
      }
      repositoriesByRoot.set(key, repository);
    }
  }

  const logicalRepositories = new Map();
  for (const repository of repositoriesByRoot.values()) {
    const identity = expectedRevision
      ? String(await identifyRepository(repository.root)).trim()
      : pathKey(repository.root);
    if (!identity) throw new Error(`release repository identity is unavailable: ${repository.root}`);
    const logical = logicalRepositories.get(identity) ?? {
      root: repository.root,
      files: new Set(),
      frozenRevisions: new Set(),
    };
    for (const file of repository.files) logical.files.add(file);
    for (const revision of repository.frozenRevisions) logical.frozenRevisions.add(revision);
    logicalRepositories.set(identity, logical);
  }

  const repositories = [];
  for (const repository of logicalRepositories.values()) {
    if (expectedRevision) {
      for (const frozenRevision of repository.frozenRevisions) {
        try {
          await assertAncestor({
            repositoryRoot: repository.root,
            ancestor: frozenRevision,
            descendant: expectedRevision,
          });
        } catch {
          throw new Error(
            `frozen Task revision ${frozenRevision} is not contained in published revision ${expectedRevision}`,
          );
        }
      }
      repositories.push({ root: repository.root, revision: expectedRevision });
      continue;
    }
    const releasePaths = [...repository.files]
      .map((file) => path.relative(repository.root, file).split(path.sep).join("/"))
      .sort();
    const changes = parseWorkingTreeStatus(await status([
      "status", "--porcelain=v1", "--untracked-files=all", "--", ...releasePaths,
    ], { cwd: repository.root }));
    if (changes.length) throw new Error(`release paths are dirty: ${repository.root}`);
    const revision = await assertRevision({ cwd: repository.root });
    repositories.push({ root: repository.root, revision });
  }
  if (expectedRevision && (repositories.length !== 1 || repositories[0].revision !== expectedRevision)) {
    throw new Error("release revision does not match expected_revision");
  }

  const agentHubRepositories = [];
  for (const repository of logicalRepositories.values()) {
    const agentHubRoot = path.join(repository.root, "AgentHub");
    if (![...repository.files].some((file) => isInside(agentHubRoot, file))) continue;
    const manifest = await readPackage(repository.root, expectedRevision);
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
