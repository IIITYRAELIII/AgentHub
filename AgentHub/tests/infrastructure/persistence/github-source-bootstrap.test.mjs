import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { enableGithubReleaseBaseline, previewGithubReleaseBaseline, sourceOnlyGitPublication } from "../../../src/infrastructure/persistence/github-publication-baseline.mjs";
import { readPublicationState, writePublicationState } from "../../../src/infrastructure/persistence/publication-state.mjs";
import { runReleasePolicyCli } from "../../../src/interfaces/cli/release-policy.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { publicationRepositories } from "../../../publish-all.mjs";

const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout.trim();

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-source-base-"));
  const oldLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  t.after(async () => {
    if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal;
    await rm(root, { recursive: true, force: true });
  });
  const repo = path.join(root, "source");
  await mkdir(path.join(repo, "AgentHub"), { recursive: true });
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(repo, "AgentHub/package.json"), '{"version":"2.0.1"}\n');
  await writeFile(path.join(repo, "CHANGELOG.md"), "# Published source notes\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "source");
  const head = await git(repo, "rev-parse", "HEAD"), tree = await git(repo, "rev-parse", "HEAD^{tree}");
  await git(repo, "remote", "add", "origin", "https://github.com/IIITYRAELIII/AgentHub.git");
  await git(repo, "update-ref", "refs/remotes/origin/main", head);
  const request = { kind: "source-bootstrap", projectRoot: repo, owner: "IIITYRAELIII", repo: "AgentHub",
    expectedTargetCommit: head, expectedTree: tree, requestId: "reviewed-source-registration" };
  const api = async route => {
    if (route === "/repos/IIITYRAELIII/AgentHub") return { id: 1428402643, owner: { id: 95281881 }, private: false, default_branch: "main" };
    if (route.endsWith("/git/ref/heads/main")) return { object: { type: "commit", sha: head } };
    if (route.endsWith(`/git/commits/${head}`)) return { sha: head, tree: { sha: tree } };
    throw new Error("Unexpected source bootstrap request");
  };
  const stateFile = path.join(root, "state.json");
  const old = { root: path.join(root, "old-utilities"), revision: "a".repeat(40), manifestHash: "b".repeat(64) };
  await writePublicationState({ revision: old.revision, generation: "old-generation", mode: "changed", repositories: [old] }, stateFile);
  const deps = { githubApi: api, readState: () => readPublicationState(stateFile), writeState: state => writePublicationState(state, stateFile) };
  return { root, repo, head, tree, request, api, stateFile, old, deps };
}

test("first exact public source baseline uses the existing owner and retains old publication byte identity", async t => {
  const f = await fixture(t);
  const before = await readFile(f.stateFile);
  const preview = await previewGithubReleaseBaseline(f.request, f.deps);
  assert.equal(preview.repository.deliveryStatus, "source-only");
  assert.deepEqual(await readFile(f.stateFile), before);
  assert.equal((await enableGithubReleaseBaseline(f.request, f.deps)).status, "source_registered");
  const state = await readPublicationState(f.stateFile);
  assert.equal(state.revision, f.old.revision); assert.equal(state.generation, "old-generation");
  assert.deepEqual(state.repositories.find(row => row.root === f.old.root), f.old);
  const registered = await readFile(f.stateFile);
  assert.equal((await enableGithubReleaseBaseline(f.request, f.deps)).status, "already_registered");
  assert.deepEqual(await readFile(f.stateFile), registered);
  await assert.rejects(enableGithubReleaseBaseline({ ...f.request, requestId: "foreign" }, f.deps), /cannot replace/u);
  assert.deepEqual(await readFile(f.stateFile), registered);
});

test("source bootstrap rejects local/API drift and a competing existing baseline before a write", async t => {
  const f = await fixture(t);
  const before = await readFile(f.stateFile);
  let reads = 0;
  await assert.rejects(enableGithubReleaseBaseline(f.request, { ...f.deps, githubApi: async route => {
    const result = await f.api(route);
    if (route.endsWith("/git/ref/heads/main") && ++reads === 2) result.object.sha = "e".repeat(40);
    return result;
  } }), /identity changed/u);
  assert.deepEqual(await readFile(f.stateFile), before);
  await assert.rejects(enableGithubReleaseBaseline(f.request, { ...f.deps, githubApi: async route => {
    const result = await f.api(route);
    if (route.includes("/git/commits/")) await writeFile(path.join(f.repo, "changed-during-api.txt"), "unreviewed");
    return result;
  } }), /exact clean local main/u);
  assert.deepEqual(await readFile(f.stateFile), before);
  await rm(path.join(f.repo, "changed-during-api.txt"));
  await writeFile(path.join(f.repo, "unreviewed.txt"), "not committed");
  await assert.rejects(enableGithubReleaseBaseline(f.request, f.deps), /exact clean local main/u);
  assert.deepEqual(await readFile(f.stateFile), before);
});

test("existing baseline CLI explicitly selects source-only mode without inventing a release id", async () => {
  const calls = [];
  const args = ["github-baseline", "preview", "--project-root", "D:/source", "--owner", "IIITYRAELIII", "--repo", "AgentHub",
    "--target-commit", "a".repeat(40), "--source-tree", "b".repeat(40), "--request-id", "registration", "--source-only", "true"];
  await runReleasePolicyCli(args, { write: () => {}, previewGithub: async input => { calls.push(input); return {}; } });
  assert.deepEqual(calls, [{ kind: "source-bootstrap", projectRoot: "D:/source", owner: "IIITYRAELIII", repo: "AgentHub",
    expectedTargetCommit: "a".repeat(40), expectedTree: "b".repeat(40), requestId: "registration" }]);
  await assert.rejects(runReleasePolicyCli([...args.slice(0, -1), "false"], { write: () => {} }), /explicit/u);
  await assert.rejects(runReleasePolicyCli([...args, "--tag", "invented"], { write: () => {} }), /cannot include/u);
});

test("source-only metadata evidence refuses incomplete archive pins and coerced bootstrap pins", () => {
  assert.equal(sourceOnlyGitPublication({ revision: "a".repeat(40) }), null);
  assert.throws(() => sourceOnlyGitPublication({ deploymentProfile: "github-release", revision: "a".repeat(40) }), /frozen source identity/u);
  assert.throws(() => sourceOnlyGitPublication({ deploymentProfile: "github-release", revision: ["a".repeat(40)] }), /exact Git pin/u);
  assert.throws(() => sourceOnlyGitPublication({ mode: "github-source-bootstrap", deliveryStatus: "source-only", revision: "a".repeat(40),
    publisher: { kind: "github-source-bootstrap", owner: "IIITYRAELIII", repo: "AgentHub", repositoryId: 1428402643,
      ownerId: 95281881, sourceCommit: "a".repeat(40), sourceTree: ["b".repeat(40)], operatorRequestId: "request" } }), /incomplete/u);
});

for (const profile of ["bootstrap", "distribution"]) test(`ordinary Task Git uses ${profile} source publication without borrowing foreign installed runtime`, async t => {
  const f = await fixture(t);
  await enableGithubReleaseBaseline(f.request, f.deps);
  if (profile === "distribution") await writePublicationState({ repositories: publicationRepositories({
    worktreeRoot: f.repo, deploymentProfile: "github-release", release: { primaryRoot: f.repo,
      planRevision: "source-plan", manifestHash: "c".repeat(64), baseCommit: f.head, preReleaseHead: f.head },
  }, f.head) }, f.stateFile);
  const runtimeRoot = path.join(f.root, "runtime"), dataDir = path.join(runtimeRoot, "data");
  await mkdir(path.join(runtimeRoot, "releases", "foreign"), { recursive: true });
  const pointer = '{"current":"foreign"}\n';
  const manifest = JSON.stringify({ releaseId: "foreign", sourceRoot: path.join(f.root, "missing-old-utilities"), publicationRevision: "e".repeat(40), files: [] });
  await writeFile(path.join(runtimeRoot, "current.json"), pointer);
  await writeFile(path.join(runtimeRoot, "releases/foreign/runtime-manifest.json"), manifest);
  let drift = null, reads = 0;
  const service = new TaskGitWorkspaceService({ dataDir, recordTiming: () => {},
    readPublication: async () => {
      const state = await readPublicationState(f.stateFile);
      if (drift === "entry" && ++reads > 1) state.repositories.find(row => row.root === f.repo).unexpected = "changed";
      return state;
    },
    runCommand: (args, options) => args.includes("ls-remote")
      ? Promise.resolve(`${drift === "origin" ? "e".repeat(40) : f.head}\trefs/heads/main\n`) : runTaskGitCommand(args, options),
  });
  const taskId = "12121212-1212-4212-8212-121212121212";
  const workspace = await service.prepare({ taskId, taskNumber: "HUB-999", projectRoot: f.repo });
  await writeFile(path.join(workspace.projectRoot, "AgentHub/result.txt"), "reviewed Task work\n");
  await git(workspace.projectRoot, "add", "."); await git(workspace.projectRoot, "commit", "-m", "result");
  const snapshot = await service.snapshot({ taskId, projectRoot: workspace.projectRoot });
  const before = await service.prepareDev(f.repo);
  drift = "entry";
  await assert.rejects(service.mergeIntoDev(snapshot), /Source-only Git publication changed/u);
  assert.equal(await git(f.repo, "rev-parse", "dev"), before.headCommit);
  drift = "origin";
  await assert.rejects(service.mergeIntoDev(snapshot), /Source-only Git publication origin changed/u);
  assert.equal(await git(f.repo, "rev-parse", "dev"), before.headCommit);
  drift = null;
  await service.mergeIntoDev(snapshot);
  assert.equal(await git(f.repo, "rev-parse", "main"), f.head);
  assert.equal(await git(f.repo, "status", "--porcelain"), "");
  assert.equal(await readFile(path.join(runtimeRoot, "current.json"), "utf8"), pointer);
  assert.equal(await readFile(path.join(runtimeRoot, "releases/foreign/runtime-manifest.json"), "utf8"), manifest);
  const acceptedDev = await git(f.repo, "rev-parse", "dev");
  await writeFile(path.join(workspace.projectRoot, "AgentHub/package.json"), '{"version":"2.0.2"}\n');
  await git(workspace.projectRoot, "add", "."); await git(workspace.projectRoot, "commit", "-m", "unaccepted metadata");
  const invalid = await service.snapshot({ taskId, projectRoot: workspace.projectRoot });
  await assert.rejects(service.mergeIntoDev(invalid), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await git(f.repo, "rev-parse", "dev"), acceptedDev);
});
