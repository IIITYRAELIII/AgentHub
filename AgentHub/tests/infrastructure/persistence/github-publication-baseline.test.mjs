import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  enableGithubReleaseBaseline,
  parseGitHubRemote,
  previewGithubReleaseBaseline,
} from "../../../src/infrastructure/persistence/github-publication-baseline.mjs";
import {
  readPublicationState,
  writePublicationState,
} from "../../../src/infrastructure/persistence/publication-state.mjs";

const execFileAsync = promisify(execFile);
const published = "ca9804c0c55face48164a80d4e3caf0620e45053";

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "github-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "bookworm");
  await git(root, "init", repo);
  await git(repo, "remote", "add", "origin", "https://github.com/SidorukSV/bookworm.git");
  return { root, repo, stateFile: path.join(root, "publication-state.json") };
}

function githubApi({
  commit = published, owner = "SidorukSV", repo = "bookworm", tag = "v5.1.52.148", id = "384471803",
  draft = false, publishedAt = "2026-09-08T05:43:47Z",
} = {}) {
  return async (pathname) => {
    if (pathname === `/repos/${owner}/${repo}/releases/tags/${tag}`) {
      return {
        id,
        tag_name: tag,
        draft,
        html_url: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
        published_at: publishedAt,
      };
    }
    if (pathname === `/repos/${owner}/${repo}/git/ref/tags/${tag}`) {
      return { object: { type: "commit", sha: commit } };
    }
    throw new Error(`unexpected GitHub API path: ${pathname}`);
  };
}

test("GitHub release baseline preview verifies remote, release id and tag target without writing", async (t) => {
  const setup = await fixture(t);
  const result = await previewGithubReleaseBaseline({
    projectRoot: setup.repo,
    owner: "SidorukSV",
    repo: "bookworm",
    tag: "v5.1.52.148",
    releaseId: "384471803",
    targetCommit: published,
  }, { githubApi: githubApi() });

  assert.equal(result.status, "preview");
  assert.equal(result.repository.revision, published);
  assert.equal(result.repository.publisher.releaseId, "384471803");
  assert.equal(await readPublicationState(setup.stateFile), null);
});

test("GitHub release baseline enable writes repository-scoped state and retains other repositories", async (t) => {
  const setup = await fixture(t);
  const otherRoot = path.join(setup.root, "other");
  await writePublicationState({
    repositories: [{ root: otherRoot, revision: "b".repeat(40), planRevision: "other-plan" }],
  }, setup.stateFile);

  const result = await enableGithubReleaseBaseline({
    projectRoot: setup.repo,
    owner: "SidorukSV",
    repo: "bookworm",
    tag: "v5.1.52.148",
    releaseId: "384471803",
    targetCommit: published,
  }, {
    githubApi: githubApi(),
    readState: () => readPublicationState(setup.stateFile),
    writeState: (state) => writePublicationState(state, setup.stateFile),
  });

  const state = await readPublicationState(setup.stateFile);
  assert.equal(result.status, "adopted");
  assert.equal(state.repositories.length, 2);
  assert.equal(state.repositories.find((entry) => entry.root === setup.repo).revision, published);
  assert.equal(state.repositories.find((entry) => entry.root === otherRoot).revision, "b".repeat(40));
  assert.equal(state.repositories.find((entry) => entry.root === setup.repo).publisher.kind, "github-release");
});

test("GitHub release baseline adoption preserves Agent Hub global publication authority", async (t) => {
  const setup = await fixture(t);
  const hubRoot = path.join(setup.root, "hub");
  const hubRevision = "1".repeat(40);
  const hubGeneration = "hub-generation";
  await writePublicationState({
    revision: hubRevision,
    publishedAt: "2026-09-12T00:00:00Z",
    mode: "full",
    generation: hubGeneration,
    repositories: [{ root: hubRoot, revision: hubRevision, planRevision: "hub-plan" }],
  }, setup.stateFile);

  await enableGithubReleaseBaseline({
    projectRoot: setup.repo,
    owner: "SidorukSV",
    repo: "bookworm",
    tag: "v5.1.52.148",
    releaseId: "384471803",
    targetCommit: published,
  }, {
    githubApi: githubApi(),
    readState: () => readPublicationState(setup.stateFile),
    writeState: (state) => writePublicationState(state, setup.stateFile),
  });

  const state = await readPublicationState(setup.stateFile);
  assert.equal(state.revision, hubRevision);
  assert.equal(state.generation, hubGeneration);
  assert.equal(state.mode, "full");
  assert.equal(state.repositories.find((entry) => entry.root === hubRoot).revision, hubRevision);
  assert.equal(state.repositories.find((entry) => entry.root === setup.repo).revision, published);
});

test("GitHub release baseline refuses draft, unpublished, moved and stale evidence", async (t) => {
  const setup = await fixture(t);
  const request = {
    projectRoot: setup.repo,
    owner: "SidorukSV",
    repo: "bookworm",
    tag: "v5.1.52.148",
    releaseId: "384471803",
    targetCommit: published,
  };

  await assert.rejects(
    () => previewGithubReleaseBaseline(request, { githubApi: githubApi({ draft: true }) }),
    /published release/u,
  );
  await assert.rejects(
    () => previewGithubReleaseBaseline(request, { githubApi: githubApi({ publishedAt: null }) }),
    /published release/u,
  );

  let refReads = 0;
  await assert.rejects(
    () => enableGithubReleaseBaseline(request, {
      githubApi: async (pathname) => {
        if (pathname.endsWith("/git/ref/tags/v5.1.52.148")) {
          refReads += 1;
          return { object: { type: "commit", sha: refReads === 1 ? published : "d".repeat(40) } };
        }
        return githubApi()(pathname);
      },
      readState: () => readPublicationState(setup.stateFile),
      writeState: (state) => writePublicationState(state, setup.stateFile),
    }),
    /tag moved|changed before the guarded write/u,
  );

  await writePublicationState({
    repositories: [{
      root: setup.repo,
      revision: "e".repeat(40),
      publishedAt: "2026-09-09T00:00:00Z",
      publisher: { kind: "github-release", releasePublishedAt: "2026-09-09T00:00:00Z" },
    }],
  }, setup.stateFile);
  await assert.rejects(
    () => enableGithubReleaseBaseline(request, {
      githubApi: githubApi(),
      readState: () => readPublicationState(setup.stateFile),
      writeState: (state) => writePublicationState(state, setup.stateFile),
    }),
    /stale/u,
  );
});

test("GitHub release baseline refuses wrong repository and moved tag evidence", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    () => previewGithubReleaseBaseline({
      projectRoot: setup.repo,
      owner: "other",
      repo: "bookworm",
      tag: "v5.1.52.148",
      releaseId: "384471803",
      targetCommit: published,
    }, { githubApi: githubApi({ owner: "other" }) }),
    /targets another repository/u,
  );
  await assert.rejects(
    () => previewGithubReleaseBaseline({
      projectRoot: setup.repo,
      owner: "SidorukSV",
      repo: "bookworm",
      tag: "v5.1.52.148",
      releaseId: "384471803",
      targetCommit: published,
    }, { githubApi: githubApi({ commit: "d".repeat(40) }) }),
    /tag moved/u,
  );
});

test("GitHub remote parser accepts supported canonical remote forms", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/SidorukSV/bookworm.git"), {
    owner: "SidorukSV", repo: "bookworm",
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:SidorukSV/bookworm.git"), {
    owner: "SidorukSV", repo: "bookworm",
  });
});
