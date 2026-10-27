import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { defaultRuntimeRoot } from "../../../src/infrastructure/filesystem/runtime-layout.mjs";

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run("git", args, { cwd, windowsHide: true })).stdout.trim();
async function save(root, file, body) {
  const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, body);
}
async function commit(root, message) {
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-published-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary"); await mkdir(primary);
  await git(primary, "init", "--initial-branch=main");
  await git(primary, "config", "core.autocrlf", "false");
  await save(primary, "CHANGELOG.md", "# History\n\nOld publication.\n");
  await save(primary, "AgentHub/package.json", JSON.stringify({ name: "agent-hub", version: "2.0.0" }) + "\n");
  await save(primary, "AgentHub/package-lock.json", JSON.stringify({ name: "agent-hub", version: "2.0.0", packages: { "": { name: "agent-hub", version: "2.0.0" } } }) + "\n");
  await save(primary, "AgentHub/server.mjs", "export const main = true;\n");
  const main = await commit(primary, "agreed main");
  const origin = path.join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "remote", "add", "origin", origin);
  await git(primary, "push", "origin", "main");
  const publishedRoot = path.join(root, "published");
  await git(primary, "worktree", "add", "-b", "publication", publishedRoot, main);
  await save(publishedRoot, "CHANGELOG.md", "# History\n\nPublished release notes.\n");
  for (const file of ["package.json", "package-lock.json"]) {
    const data = JSON.parse(await readFile(path.join(publishedRoot, "AgentHub", file), "utf8"));
    data.version = "2.0.1"; if (data.packages) data.packages[""].version = "2.0.1";
    await save(publishedRoot, `AgentHub/${file}`, JSON.stringify(data) + "\n");
  }
  const published = await commit(publishedRoot, "published release");
  await git(publishedRoot, "push", "origin", "HEAD:main");
  const environment = { ...process.env, LOCALAPPDATA: path.join(root, "state"), XDG_STATE_HOME: path.join(root, "state") };
  const runtimeRoot = defaultRuntimeRoot({ environment }), dataDir = path.join(runtimeRoot, "data");
  let publication = { generation: "published-original", repositories: [{ root: primary, revision: published, manifestHash: "original-manifest" }] };
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const taskId = "11111111-1111-4111-8111-111111111111";
  const source = await service.prepare({ taskId, taskNumber: "HUB-1", projectRoot: primary });
  await git(source.projectRoot, "sparse-checkout", "disable");
  await git(source.projectRoot, "merge", "--ff-only", published);
  await save(source.projectRoot, "AgentHub/selected.mjs", "export const selected = true;\n");
  const resultCommit = await commit(source.projectRoot, "selected correction");
  const dev = await service.prepareDev(primary); await git(dev.projectRoot, "merge", "--ff-only", published);
  await save(runtimeRoot, "current.json", JSON.stringify({ current: "published-runtime" }));
  await save(runtimeRoot, "releases/published-runtime/runtime-manifest.json", JSON.stringify({ releaseId: "published-runtime",
    publicationRevision: published, sourceRoot: path.join(root, "retired-generation", "AgentHub"), files: [] }));
  await save(runtimeRoot, "publication-state.json", JSON.stringify(publication));
  const task = { taskId, taskRevision: 2, baseCommit: main, resultCommit };
  return { root, primary, main, published, source, dev, service, taskId, task, environment, dataDir, runtimeRoot,
    publication: () => publication, setPublication: value => { publication = value; } };
}

test("ordinary Test inherits exact published notes/version while main remains fixed, with terminal publication fencing", async t => {
  const f = await fixture(t), operationId = "published-notes-test";
  const result = await f.service.snapshotAndMerge({ taskId: f.taskId, projectRoot: f.primary, operationId });
  assert.equal(result.integration.integrated, true);
  assert.equal(result.snapshot.headCommit, f.task.resultCommit);
  assert.equal(await git(f.primary, "rev-parse", "refs/heads/main"), f.main);
  const check = () => f.service.withTaskLock(f.taskId, lease => f.service.assertNativeIntegrationOwned(result.snapshot, { operationId, lease }));
  await check();
  const original = f.publication();
  for (const changed of [{ ...original, generation: "foreign-generation" },
    { ...original, repositories: [{ ...original.repositories[0], manifestHash: "changed-manifest" }] },
    { ...original, repositories: [{ ...original.repositories[0], revision: f.main }] },
    { ...original, repositories: [] }]) {
    f.setPublication(changed);
    await assert.rejects(check(), /publication|authority changed/iu);
  }
  f.setPublication(original); await check();
});

test("ordinary Test still refuses unpublished release notes and package versions", async t => {
  const f = await fixture(t);
  await save(f.source.projectRoot, "CHANGELOG.md", "# History\n\nUnpublished Task notes.\n");
  await commit(f.source.projectRoot, "unpublished notes");
  await assert.rejects(f.service.snapshotAndMerge({ taskId: f.taskId, projectRoot: f.primary, operationId: "foreign-notes" }), /release-owned CHANGELOG/u);
  await git(f.source.projectRoot, "sparse-checkout", "disable");
  await git(f.source.projectRoot, "restore", `--source=${f.published}`, "--staged", "--worktree", "--", "CHANGELOG.md");
  const file = path.join(f.source.projectRoot, "AgentHub/package.json");
  const data = JSON.parse(await readFile(file, "utf8")); data.version = "9.9.9";
  await writeFile(file, JSON.stringify(data) + "\n"); await commit(f.source.projectRoot, "unpublished version");
  await assert.rejects(f.service.snapshotAndMerge({ taskId: f.taskId, projectRoot: f.primary, operationId: "foreign-version" }), /release-owned package-version/u);
});

test("ordinary candidate accepts only exact durable published context over the fixed agreed main", async t => {
  const f = await fixture(t);
  const candidate = new ReleaseGitWorkspaceService({ dataDir: f.dataDir, environment: f.environment });
  const prepared = await candidate.prepareCandidate({ projectRoot: f.primary, workspaceId: "fixture", planRevision: "published-plan",
    frozenTasks: [f.task], approvedBaseCommit: f.main });
  assert.ok(prepared.preReleaseHead);
  assert.equal(await git(f.primary, "rev-parse", "refs/heads/main"), f.main);
});

test("missing publication generation gives no metadata credit but preserves ordinary unchanged legacy metadata", async t => {
  const f = await fixture(t);
  const { generation, ...legacy } = f.publication();
  f.setPublication(legacy);
  await assert.rejects(f.service.snapshotAndMerge({ taskId: f.taskId, projectRoot: f.primary,
    operationId: "unproved-published-notes" }), /release-owned CHANGELOG/u);
  const taskId = "22222222-2222-4222-8222-222222222222";
  const source = await f.service.prepare({ taskId, taskNumber: "HUB-2", projectRoot: f.primary });
  await save(source.projectRoot, "AgentHub/legacy.mjs", "export const legacy = true;\n");
  await commit(source.projectRoot, "ordinary legacy metadata unchanged");
  const result = await f.service.snapshotAndMerge({ taskId, projectRoot: f.primary, operationId: "unchanged-legacy" });
  assert.equal(result.integration.integrated, true);
});

test("published dev and copied metadata alone cannot authorize a source without published ancestry", async t => {
  const f = await fixture(t), taskId = "33333333-3333-4333-8333-333333333333";
  const source = await f.service.prepare({ taskId, taskNumber: "HUB-3", projectRoot: f.primary });
  await git(source.projectRoot, "sparse-checkout", "disable");
  const notes = await git(f.primary, "show", `${f.published}:CHANGELOG.md`);
  await save(source.projectRoot, "CHANGELOG.md", notes + "\n");
  await commit(source.projectRoot, "copied published notes without publication ancestry");
  await assert.rejects(f.service.snapshotAndMerge({ taskId, projectRoot: f.primary,
    operationId: "dev-is-not-metadata-authority" }), /release-owned CHANGELOG/u);
});

test("ordinary candidate refuses publication record drift before the owning commit", async t => {
  const f = await fixture(t), candidate = new ReleaseGitWorkspaceService({ dataDir: f.dataDir, environment: f.environment });
  let committed = false;
  await assert.rejects(candidate.prepareCandidate({ projectRoot: f.primary, workspaceId: "fixture", planRevision: "fenced-published-plan",
    frozenTasks: [f.task], approvedBaseCommit: f.main,
    validateBeforeCommit: async () => save(f.runtimeRoot, "publication-state.json", JSON.stringify({
      ...f.publication(), generation: "changed-generation-same-commit" })),
    commitPrepared: async () => { committed = true; },
  }), /published metadata authority changed/u);
  assert.equal(committed, false);
  assert.equal(await git(f.primary, "rev-parse", "refs/heads/main"), f.main);
});
