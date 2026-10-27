import path from "node:path";
import { gitOutput, publicationStateRepositories, readPublicationState, writePublicationState } from "./publication-state.mjs";
import { withPublicationLock } from "../process/publication-lock.mjs";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/iu;

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function requiredCommit(value, name) {
  const commit = requiredText(value, name);
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`${name} must be a 40-character commit SHA`);
  return commit.toLowerCase();
}

function canonicalOwnerRepo(owner, repo) {
  const normalizedOwner = requiredText(owner, "GitHub owner");
  const normalizedRepo = requiredText(repo, "GitHub repository");
  return {
    owner: normalizedOwner,
    repo: normalizedRepo.replace(/\.git$/iu, ""),
  };
}

export function parseGitHubRemote(value) {
  const remote = String(value ?? "").trim();
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(remote);
  if (https) return canonicalOwnerRepo(https[1], https[2]);
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu.exec(remote);
  if (ssh) return canonicalOwnerRepo(ssh[1], ssh[2]);
  const sshUrl = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu.exec(remote);
  if (sshUrl) return canonicalOwnerRepo(sshUrl[1], sshUrl[2]);
  return null;
}

export function githubBaselineRequest(input = {}) {
  const expected = canonicalOwnerRepo(input.owner, input.repo);
  return {
    projectRoot: path.resolve(requiredText(input.projectRoot, "project root")),
    owner: expected.owner,
    repo: expected.repo,
    releaseTag: requiredText(input.releaseTag ?? input.tag, "release tag"),
    releaseId: String(input.releaseId ?? input.id ?? "").trim(),
    expectedTargetCommit: requiredCommit(input.expectedTargetCommit ?? input.targetCommit, "expected target commit"),
  };
}

async function defaultGithubApi(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: { "Accept": "application/vnd.github+json", "User-Agent": "AgentHub-release-baseline" },
  });
  if (!response.ok) throw new Error(`GitHub API ${pathname} failed: ${response.status}`);
  return response.json();
}

function releaseTagRefPath(tag) {
  return `/repos/{owner}/{repo}/git/ref/tags/${encodeURIComponent(tag).replaceAll("%2F", "/")}`;
}

function canonicalRoot(value) {
  const resolved = path.resolve(String(value ?? "").trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function repositoryPublishedAt(entry = {}) {
  const value = String(entry?.publishedAt ?? entry?.publisher?.releasePublishedAt ?? "").trim();
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export async function verifyGithubReleaseBaseline(input = {}, {
  git = gitOutput,
  githubApi = defaultGithubApi,
} = {}) {
  const request = githubBaselineRequest(input);
  const remote = await git(["config", "--get", "remote.origin.url"], { cwd: request.projectRoot });
  const remoteIdentity = parseGitHubRemote(remote);
  if (!remoteIdentity
      || remoteIdentity.owner.toLowerCase() !== request.owner.toLowerCase()
      || remoteIdentity.repo.toLowerCase() !== request.repo.toLowerCase()) {
    throw new Error(`GitHub publication baseline targets another repository: ${remote}`);
  }
  const releasePath = `/repos/${request.owner}/${request.repo}/releases/tags/${encodeURIComponent(request.releaseTag)}`;
  const tagPath = releaseTagRefPath(request.releaseTag)
    .replace("{owner}", request.owner)
    .replace("{repo}", request.repo);
  const [release, tagRef] = await Promise.all([
    githubApi(releasePath),
    githubApi(tagPath),
  ]);
  if (String(release?.id ?? "") !== request.releaseId) {
    throw new Error(`GitHub release id changed for ${request.owner}/${request.repo}@${request.releaseTag}`);
  }
  if (String(release?.tag_name ?? "") !== request.releaseTag) {
    throw new Error("GitHub release tag does not match requested baseline");
  }
  if (release?.draft === true || !String(release?.published_at ?? "").trim()) {
    throw new Error("GitHub publication baseline requires an already published release");
  }
  if (String(tagRef?.object?.type ?? "") !== "commit") {
    throw new Error("GitHub release tag must resolve directly to a commit");
  }
  const observedCommit = String(tagRef?.object?.sha ?? "").trim().toLowerCase();
  if (observedCommit !== request.expectedTargetCommit) {
    throw new Error(`GitHub release tag moved: expected ${request.expectedTargetCommit}, observed ${observedCommit}`);
  }
  return {
    status: "verified",
    root: request.projectRoot,
    revision: request.expectedTargetCommit,
    publishedAt: release.published_at,
    mode: "adopted-github-release",
    publisher: {
      kind: "github-release",
      owner: request.owner,
      repo: request.repo,
      releaseTag: request.releaseTag,
      releaseId: request.releaseId,
      targetCommit: request.expectedTargetCommit,
      releaseUrl: release.html_url ?? null,
      releasePublishedAt: release.published_at ?? null,
      tagObjectType: "commit",
    },
    adoptedFrom: "github-release",
  };
}

export async function previewGithubReleaseBaseline(input = {}, dependencies = {}) {
  const evidence = input.kind === "source-bootstrap"
    ? await verifyGithubSourceBaseline(input, dependencies) : await verifyGithubReleaseBaseline(input, dependencies);
  return {
    status: "preview",
    repository: evidence,
    effects: ["no publication state write"],
  };
}

export async function enableGithubReleaseBaseline(input = {}, {
  lock = withPublicationLock,
  readState = readPublicationState,
  writeState = writePublicationState,
  ...dependencies
} = {}) {
  if (input.kind === "source-bootstrap") {
    const preview = await verifyGithubSourceBaseline(input, dependencies);
    return lock(async () => {
      const verified = await verifyGithubSourceBaseline(input, dependencies);
      if (JSON.stringify(verified) !== JSON.stringify(preview)) throw new Error("GitHub source changed before the guarded write");
      const current = await readState();
      const existing = publicationStateRepositories(current ?? {}).find(entry => canonicalRoot(entry.root) === canonicalRoot(verified.root));
      if (existing && JSON.stringify(existing) !== JSON.stringify(verified)) {
        throw new Error("Source bootstrap cannot replace an existing repository publication");
      }
      await assertCleanSourceMain({ projectRoot: verified.root, commit: verified.revision, tree: verified.publisher.sourceTree }, dependencies.git ?? gitOutput);
      if (!existing) await writeState({ repositories: [verified] });
      return { status: existing ? "already_registered" : "source_registered", repository: verified,
        effects: existing ? ["no publication state write"] : ["repository-scoped source baseline write"], runtimeDelivery: false };
    });
  }
  const previewEvidence = await verifyGithubReleaseBaseline(input, dependencies);
  const evidence = await lock(async () => {
    const verified = await verifyGithubReleaseBaseline(input, dependencies);
    if (JSON.stringify(verified) !== JSON.stringify(previewEvidence)) {
      throw new Error("GitHub publication baseline changed before the guarded write");
    }
    const current = await readState();
    const existing = (current?.repositories ?? []).find((entry) => (
      canonicalRoot(entry.root) === canonicalRoot(verified.root)
    ));
    if (existing && String(existing.revision ?? "") !== verified.revision) {
      const existingPublishedAt = repositoryPublishedAt(existing);
      const incomingPublishedAt = repositoryPublishedAt(verified);
      if (existingPublishedAt == null || incomingPublishedAt == null || existingPublishedAt >= incomingPublishedAt) {
        throw new Error("GitHub publication baseline is stale for the selected repository");
      }
    }
    await writeState({ repositories: [verified] });
    return verified;
  });
  return {
    status: "adopted",
    repository: evidence,
    effects: ["repository-scoped publication state write"],
  };
}

async function assertCleanSourceMain(request, git) {
  const run = args => git(args, { cwd: request.projectRoot });
  const [branch, head, main, tree, dirty, origin] = await Promise.all([
    run(["symbolic-ref", "--quiet", "HEAD"]), run(["rev-parse", "HEAD^{commit}"]),
    run(["rev-parse", "refs/heads/main^{commit}"]), run(["rev-parse", "HEAD^{tree}"]),
    run(["status", "--porcelain=v1", "--untracked-files=all"]),
    run(["config", "--get", "remote.origin.url"]),
  ]);
  const remote = parseGitHubRemote(origin);
  if (remote?.owner.toLowerCase() !== "iiityraeliii" || remote?.repo.toLowerCase() !== "agenthub") {
    throw new Error("Source bootstrap origin is not canonical Agent Hub");
  }
  if (branch !== "refs/heads/main" || head !== request.commit || main !== request.commit || tree !== request.tree || dirty) {
    throw new Error("Source bootstrap requires its exact clean local main");
  }
}

// First standalone source publication is a Git fact, not an installed runtime
// or an invented GitHub Release. Reuse the existing baseline owner and lock.
export async function verifyGithubSourceBaseline(input = {}, {
  git = gitOutput, githubApi = defaultGithubApi,
} = {}) {
  const allowed = new Set(["kind", "projectRoot", "owner", "repo", "expectedTargetCommit", "expectedTree", "requestId"]);
  if (input.kind !== "source-bootstrap" || Object.keys(input).some(key => !allowed.has(key))
    || [...allowed].some(key => typeof input[key] !== "string" || !input[key].trim())) {
    throw new Error("Source bootstrap requires its exact explicit source identity");
  }
  const request = { projectRoot: path.resolve(input.projectRoot), owner: input.owner, repo: input.repo,
    commit: requiredCommit(input.expectedTargetCommit, "source commit"), tree: requiredCommit(input.expectedTree, "source tree"),
    requestId: input.requestId };
  if (request.owner.toLowerCase() !== "iiityraeliii" || request.repo.toLowerCase() !== "agenthub") {
    throw new Error("Source bootstrap supports only the canonical Agent Hub repository");
  }
  await assertCleanSourceMain(request, git);
  const root = "/repos/IIITYRAELIII/AgentHub";
  const [repository, ref, commit] = await Promise.all([
    githubApi(root), githubApi(`${root}/git/ref/heads/main`), githubApi(`${root}/git/commits/${request.commit}`),
  ]);
  if (repository?.id !== 1428402643 || repository.owner?.id !== 95281881 || repository.private !== false
    || repository.default_branch !== "main" || ref?.object?.type !== "commit" || ref.object.sha !== request.commit
    || commit?.sha !== request.commit || commit.tree?.sha !== request.tree) {
    throw new Error("Canonical published source commit/tree identity changed");
  }
  await assertCleanSourceMain(request, git);
  return { root: request.projectRoot, revision: request.commit, mode: "github-source-bootstrap", deliveryStatus: "source-only",
    publisher: { kind: "github-source-bootstrap", owner: "IIITYRAELIII", repo: "AgentHub", repositoryId: 1428402643,
      ownerId: 95281881, sourceCommit: request.commit, sourceTree: request.tree, operatorRequestId: request.requestId } };
}

export function sourceOnlyGitPublication(entry) {
  const bootstrap = entry?.publisher?.kind === "github-source-bootstrap";
  if (!bootstrap && entry?.deploymentProfile !== "github-release") return null;
  if (typeof entry.revision !== "string" || !/^[a-f0-9]{40}$/u.test(entry.revision)) {
    throw new Error("Source-only published revision is not an exact Git pin");
  }
  const revision = requiredCommit(entry.revision, "source-only published revision");
  if (bootstrap && (entry.mode !== "github-source-bootstrap" || entry.deliveryStatus !== "source-only"
    || entry.publisher.owner !== "IIITYRAELIII" || entry.publisher.repo !== "AgentHub"
    || entry.publisher.repositoryId !== 1428402643 || entry.publisher.ownerId !== 95281881
    || entry.publisher.sourceCommit !== revision || typeof entry.publisher.sourceTree !== "string"
    || !COMMIT_PATTERN.test(entry.publisher.sourceTree)
    || typeof entry.publisher.operatorRequestId !== "string" || !entry.publisher.operatorRequestId.trim())) {
    throw new Error("Source-only publication evidence is incomplete");
  }
  if (!bootstrap && (typeof entry.planRevision !== "string" || !entry.planRevision.trim()
    || typeof entry.manifestHash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.manifestHash) || entry.preReleaseHead !== revision
    || typeof entry.baseCommit !== "string" || !COMMIT_PATTERN.test(entry.baseCommit))) {
    throw new Error("Archive publication lacks its frozen source identity");
  }
  return { revision, ...(bootstrap ? { tree: entry.publisher.sourceTree } : {}) };
}
