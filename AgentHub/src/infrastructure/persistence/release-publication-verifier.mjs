import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveTaskGitRepoRootsForFiles } from "../filesystem/task-git-diff.mjs";
import { gitOutput, readPublicationState } from "./publication-state.mjs";

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

async function assertTaskResultPublished({ repositoryRoot, taskRevision, publishedRevision }) {
  await gitOutput(["merge-base", "--is-ancestor", taskRevision, publishedRevision], { cwd: repositoryRoot });
}

async function repositoryPublishedRevision(repositoryRoot) {
  try {
    return await gitOutput(["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: repositoryRoot });
  } catch {
    return gitOutput(["rev-parse", "refs/heads/main^{commit}"], { cwd: repositoryRoot });
  }
}

export async function verifyWorkspaceReleasePublication({
  expectedRepositories = [], frozenCandidates = [], plan, conflictsResolved = false,
} = {}, {
  resolveRoots = resolveTaskGitRepoRootsForFiles,
  identifyRepository = repositoryIdentity,
  assertTaskResult = assertTaskResultPublished,
  readPublishedRevision = repositoryPublishedRevision,
  readPublication = readPublicationState,
  readPackage = readAgentHubPackage,
} = {}) {
  if (!Array.isArray(expectedRepositories) || !expectedRepositories.length) {
    throw new Error("release completion requires expected_revision for every repository");
  }
  const expectedByRoot = new Map(expectedRepositories.map((item) => {
    const root = String(item?.projectRoot ?? "").trim();
    const revision = String(item?.revision ?? "").trim();
    if (!root || !revision) throw new Error("each release repository requires projectRoot and expected revision");
    return [pathKey(root), { root: path.resolve(root), revision }];
  }));
  const frozenByRoot = new Map(frozenCandidates.map((item) => [pathKey(item.repositoryRoot), item]));
  const taskEvidenceByProjectRoot = new Map();
  for (const candidate of plan.candidates ?? []) {
    for (const reference of candidate.gitReferences ?? []) {
      const projectRoot = String(reference.projectRoot ?? "").trim();
      const resultCommit = String(reference.resultCommit ?? "").trim();
      if (!projectRoot || !resultCommit) continue;
      const key = pathKey(projectRoot);
      const evidence = taskEvidenceByProjectRoot.get(key) ?? [];
      evidence.push({ resultCommit });
      taskEvidenceByProjectRoot.set(key, evidence);
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
        taskEvidence: [],
      };
      for (const file of matchingFiles) repository.files.add(file);
      for (const evidence of taskEvidenceByProjectRoot.get(pathKey(group.projectRoot)) ?? []) {
        repository.taskEvidence.push(evidence);
      }
      repositoriesByRoot.set(key, repository);
    }
  }

  const logicalRepositories = new Map();
  for (const repository of repositoriesByRoot.values()) {
    const identity = String(await identifyRepository(repository.root)).trim();
    if (!identity) throw new Error(`release repository identity is unavailable: ${repository.root}`);
    const logical = logicalRepositories.get(identity) ?? {
      root: repository.root,
      files: new Set(),
      taskEvidence: [],
    };
    for (const file of repository.files) logical.files.add(file);
    logical.taskEvidence.push(...repository.taskEvidence);
    logicalRepositories.set(identity, logical);
  }

  const repositories = [];
  for (const repository of logicalRepositories.values()) {
    const expected = expectedByRoot.get(pathKey(repository.root));
    if (!expected) throw new Error(`expected_revision is missing for repository: ${repository.root}`);
    const frozen = frozenByRoot.get(pathKey(repository.root));
    if (!frozen) throw new Error(`frozen release checkpoint is missing for repository: ${repository.root}`);
    if (String(frozen.planRevision) !== String(plan.revision)
        || !frozen.manifestHash || !frozen.baseCommit || !frozen.preReleaseHead) {
      throw new Error(`frozen release checkpoint does not match plan ${plan.revision}: ${repository.root}`);
    }
    if (expected.revision !== frozen.preReleaseHead) {
      throw new Error(
        `published revision must exactly equal frozen PreRelease head ${frozen.preReleaseHead}: ${expected.revision}`,
      );
    }
    const observedRevision = String(await readPublishedRevision(repository.root)).trim();
    if (observedRevision !== expected.revision) {
      throw new Error(`published repository revision changed: expected ${expected.revision}, observed ${observedRevision}`);
    }
    for (const evidence of repository.taskEvidence) {
      try {
        await assertTaskResult({
          repositoryRoot: repository.root,
          taskRevision: evidence.resultCommit,
          publishedRevision: expected.revision,
        });
      } catch {
        throw new Error(
          `Task result commit ${evidence.resultCommit} is not contained in published revision ${expected.revision}`,
        );
      }
    }
    repositories.push({
      root: repository.root,
      revision: expected.revision,
      planRevision: frozen.planRevision,
      manifestHash: frozen.manifestHash,
      baseCommit: frozen.baseCommit,
      preReleaseHead: frozen.preReleaseHead,
    });
  }
  if (repositories.length !== expectedByRoot.size) {
    throw new Error("expected_repositories contains an unrelated repository");
  }

  const agentHubRepositories = [];
  for (const repository of logicalRepositories.values()) {
    const agentHubRoot = path.join(repository.root, "AgentHub");
    if (![...repository.files].some((file) => isInside(agentHubRoot, file))) continue;
    const expected = expectedByRoot.get(pathKey(repository.root));
    const manifest = await readPackage(repository.root, expected.revision);
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
      generation: String(publication.generation ?? ""),
      publishedAt: publication.publishedAt ?? null,
      mode: publication.mode ?? null,
    };
    if (!agentHubPublication.generation) throw new Error("Agent Hub publication generation is missing");
  }
  return { repositories, agentHubPublication };
}
