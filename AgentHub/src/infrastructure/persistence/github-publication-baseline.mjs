import path from "node:path";
import { gitOutput, writePublicationState } from "./publication-state.mjs";

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
  const evidence = await verifyGithubReleaseBaseline(input, dependencies);
  return {
    status: "preview",
    repository: evidence,
    effects: ["no publication state write"],
  };
}

export async function enableGithubReleaseBaseline(input = {}, {
  writeState = writePublicationState,
  ...dependencies
} = {}) {
  const evidence = await verifyGithubReleaseBaseline(input, dependencies);
  await writeState({
    revision: evidence.revision,
    publishedAt: evidence.publisher.releasePublishedAt ?? new Date().toISOString(),
    mode: "adopted-github-release",
    repositories: [evidence],
  });
  return {
    status: "adopted",
    repository: evidence,
    effects: ["repository-scoped publication state write"],
  };
}
