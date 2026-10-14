import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { verifySelectedCompositionObjects } from "../../../src/infrastructure/filesystem/selected-composition-proof.mjs";
import { releaseTaskNetProjections } from "../../../src/infrastructure/filesystem/release-task-net-projection.mjs";
import { ordinaryPublishedResolutionFixture } from "../../fixtures/ordinary-published-resolution-fixture.mjs";

const exec = promisify(execFile);

async function repository(t, { ordinary = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "selected-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args, options = {}) => runTaskGitCommand(args, { ...options, cwd: root });
  const command = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  const commit = async (message) => {
    await command("add", "-A");
    await command("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
    return command("rev-parse", "HEAD");
  };
  await command("init", "-q");
  await writeFile(path.join(root, "conflict.txt"), "base\n");
  await writeFile(path.join(root, "CHANGELOG.md"), "base\n");
  const base = await commit("base");
  await command("switch", "-q", "-c", "published");
  await writeFile(path.join(root, "conflict.txt"), "published\n");
  const published = await commit("published");
  await command("switch", "-q", "-c", "local", base);
  await writeFile(path.join(root, "local.txt"), "accepted local\n");
  const local = await commit("local");
  await command("switch", "-q", "-c", "task");
  await writeFile(path.join(root, "feature.txt"), "selected feature\n");
  if (ordinary) await writeFile(path.join(root, "conflict.txt"), "own\n");
  await commit("task feature");
  if (!ordinary) await command("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "-m", "approved published side", published);
  await writeFile(path.join(root, "task-later.txt"), "later selected feature\n");
  const task = await commit("task later");
  await command("switch", "-q", "-c", "dev", local);
  await writeFile(path.join(root, "conflict.txt"), "dev\n");
  await writeFile(path.join(root, "unselected.txt"), "unselected dev\n");
  const dev = await commit("unselected dev");
  let baseline;
  try {
    await command("merge-tree", "--write-tree", dev, task);
    throw new Error("fixture unexpectedly has no conflict");
  } catch (error) {
    baseline = String(error.stdout ?? "").split(/\r?\n/u)[0];
  }
  assert.match(baseline, /^[0-9a-f]{40}$/u);
  const index = path.join(root, "selected.index");
  const indexCommand = async (...args) => (await exec("git", args, {
    cwd: root, env: { ...process.env, GIT_INDEX_FILE: index },
  })).stdout.trim();
  await indexCommand("read-tree", baseline);
  await writeFile(path.join(root, "resolved.txt"), "reviewed resolution\n");
  const resolvedBlob = await command("hash-object", "-w", "resolved.txt");
  await indexCommand("update-index", "--add", "--cacheinfo", "100644", resolvedBlob, "conflict.txt");
  const resolvedTree = await indexCommand("write-tree");
  const proof = (await exec("git", ["commit-tree", resolvedTree, "-p", dev, "-p", task,
    "-m", "reviewed conflict resolution"], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  })).stdout.trim();
  return { root, git, base, local, published, task, dev, proof, resolvedTree };
}

function inputs(f) {
  return { git: f.git, taskId: "test-task", repositoryKey: "repo", taskBaseCommit: f.local,
    acceptedLocalMainCommit: f.local, taskCommit: f.task, devCommit: f.dev,
    proofCommit: f.proof, publishedCommit: f.published, publicationGeneration: "generation-1",
    remoteCommit: f.published, bundleSha256: "a".repeat(64) };
}

test("selected proof binds one published Task side and only reviewed conflict entries", async (t) => {
  const f = await repository(t);
  const proof = await verifySelectedCompositionObjects(inputs(f));
  assert.equal(proof.releaseParent, f.published);
  assert.equal(Object.hasOwn(proof, "proofRoute"), false);
  assert.equal(Object.hasOwn(proof, "ownPlan"), false);
  assert.equal(proof.conflictWitnesses.length, 1);
  assert.deepEqual(proof.conflictWitnesses.map((item) => item.path), ["conflict.txt"]);
  assert.ok(proof.worktreePlan.some((item) => item.path === "feature.txt"));
  assert.ok(!proof.worktreePlan.some((item) => item.path === "unselected.txt"));
  const selectedPaths = await f.git(["diff", "--name-only", proof.releaseParent, f.task]);
  assert.ok(!selectedPaths.split(/\r?\n/u).includes("unselected.txt"));
  assert.equal((await readFile(path.join(f.root, "unselected.txt"), "utf8")), "unselected dev\n");
});

test("ordinary own conflict keeps its immutable base without a published-side merge", async (t) => {
  const f = await repository(t, { ordinary: true });
  const proof = await verifySelectedCompositionObjects(inputs(f));
  assert.equal(proof.proofRoute, "ordinary-own-conflict-v1");
  assert.equal(proof.releaseParent, f.local);
  assert.equal(proof.taskMergeCommit, null);
  assert.deepEqual(proof.conflictWitnesses.map((item) => item.path), ["conflict.txt"]);
  assert.ok(!proof.worktreePlan.some((item) => item.path === "unselected.txt"));
  assert.equal(proof.selectedReleaseTree, null);
  assert.deepEqual(proof.releaseConflictPaths, ["conflict.txt"]);
  await assert.rejects(releaseTaskNetProjections({ git: f.git, baseCommit: f.published,
    tasks: [{ taskId: proof.taskId, resultCommit: f.task, selectedComposition: proof,
      integrations: [{ commit: f.proof, parent: f.dev, order: 1 }] }] }),
  (error) => error.code === "TASK_SELECTED_PROJECTION_REQUIRED");
});

test("ordinary published resolution yields the complete published OWN projection", async (t) => {
  const f = await repository(t, { ordinary: true });
  const published = await ordinaryPublishedResolutionFixture(f, inputs(f));
  const proof = await verifySelectedCompositionObjects({ ...inputs(f), publishedResolutionInput: published.input });
  assert.equal(proof.selectedReleaseTree, published.tree);
  assert.equal(proof.publishedResolution.resolutionCommit, published.commit);
  const projections = await releaseTaskNetProjections({ git: f.git, baseCommit: f.published,
    tasks: [{ taskId: proof.taskId, resultCommit: f.task, selectedComposition: proof,
      integrations: [{ commit: f.proof, parent: f.dev, order: 1 }] }] });
  const projection = projections.get(proof.taskId);
  assert.equal(projection.parent, f.published);
  assert.equal(projection.commit, published.commit);
  assert.deepEqual(projection.paths.sort(), proof.ownPlan.map((p) => p.path).sort());
  assert.equal(await f.git(["ls-tree", published.tree, "--", "local.txt", "unselected.txt"]), "");
});

async function changedProof(f, { parents = [f.dev, f.task], edits = {} } = {}) {
  const index = path.join(f.root, "negative.index");
  const command = async (...args) => (await exec("git", args, {
    cwd: f.root, env: { ...process.env, GIT_INDEX_FILE: index },
  })).stdout.trim();
  await command("read-tree", f.resolvedTree);
  for (const [name, text] of Object.entries(edits)) {
    const blob = await runTaskGitCommand(["hash-object", "-w", "--stdin"], {
      cwd: f.root, input: Buffer.from(text),
    });
    await command("update-index", "--add", "--cacheinfo", "100644", blob, name);
  }
  const tree = await command("write-tree");
  return (await exec("git", ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "negative"],
    { cwd: f.root, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } })).stdout.trim();
}

test("ordinary published resolution refuses stale bindings and missing extra or forged conflicts", async (t) => {
  const f = await repository(t, { ordinary: true });
  const published = await ordinaryPublishedResolutionFixture(f, inputs(f));
  const verify = (publishedResolutionInput) => verifySelectedCompositionObjects({ ...inputs(f), publishedResolutionInput });
  for (const key of ["taskId", "repositoryKey", "taskBaseCommit", "acceptedLocalMainCommit", "taskCommit",
    "devCommit", "proofCommit", "publishedCommit", "publicationGeneration", "remoteCommit", "bundleSha256"]) {
    const value = key.endsWith("Commit") ? f.base : key === "bundleSha256" ? "b".repeat(64) : "stale";
    await assert.rejects(verify({ ...published.input, [key]: value }), /bound .* changed/u);
  }
  await assert.rejects(verify({ ...published.input, resolutions: [] }), /incomplete/u);
  await assert.rejects(verify({ ...published.input, resolutions: [...published.input.resolutions,
    { path: "feature.txt", mode: "100644", blob: published.input.resolutions[0].blob }] }), /exact actual conflicts/u);
  await assert.rejects(verify({ ...published.input, resolutions: [{ ...published.input.resolutions[0], blob: "f".repeat(40) }] }), /reviewed conflict/u);
  await assert.rejects(verify({ ...published.input, resolutions: [{ ...published.input.resolutions[0], mode: "100755" }] }), /unsupported/u);
  await assert.rejects(verify({ ...published.input, reviewerApproved: true }), /unsupported identity/u);
});

test("ordinary published resolution refuses altered parents nonconflict outside deletions renames and modes", async (t) => {
  const f = await repository(t, { ordinary: true });
  const published = await ordinaryPublishedResolutionFixture(f, inputs(f));
  const command = async (args, env = {}) => (await exec("git", args, {
    cwd: f.root, env: { ...process.env, ...env },
  })).stdout.trim();
  const candidate = async ({ parents = [f.published], edits = [], remove = [] } = {}) => {
    const env = { GIT_INDEX_FILE: path.join(f.root, "published-negative.index") };
    await command(["read-tree", published.tree], env);
    for (const name of remove) await command(["update-index", "--force-remove", "--", name], env);
    for (const [name, mode, text] of edits) {
      const blob = await f.git(["hash-object", "-w", "--stdin"], { input: Buffer.from(text) });
      await command(["update-index", "--add", "--cacheinfo", mode, blob, name], env);
    }
    const tree = await command(["write-tree"], env);
    return command(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "forged projection"], {
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
    });
  };
  for (const change of [{ parents: [f.local] }, { parents: [f.published, f.task] },
    { edits: [["feature.txt", "100644", "unreviewed clean change\n"]] },
    { edits: [["CHANGELOG.md", "100644", "unreviewed release history\n"]] },
    { edits: [["outside.txt", "100644", "foreign\n"]] },
    { remove: ["feature.txt"] }, { remove: ["feature.txt"], edits: [["renamed.txt", "100644", "selected feature\n"]] },
    { edits: [["feature.txt", "100755", "selected feature\n"]] },
    { edits: [["feature.txt", "120000", "foreign-link"]] }]) {
    const resolutionCommit = await candidate(change);
    await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f),
      publishedResolutionInput: { ...published.input, resolutionCommit } }), /parents changed|unreviewed|regular file/u);
  }
});

test("ordinary conflict refuses substituted parents, non-conflict edits and stale base/result/dev", async (t) => {
  const f = await repository(t, { ordinary: true });
  const wrongParents = await changedProof(f, { parents: [f.task, f.dev] });
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), proofCommit: wrongParents }), /parents changed/u);
  const outside = await changedProof(f, { edits: { "unselected.txt": "stolen dev\n" } });
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), proofCommit: outside }), /non-conflict path/u);
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), taskBaseCommit: f.base }), /unchanged local main Task base/u);
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), taskCommit: f.local }), /history is empty/u);
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), devCommit: f.task }), /partial or ambiguous/u);
});

test("ordinary conflict refuses deletion and rename in own delta before proof admission", async (t) => {
  const f = await repository(t, { ordinary: true });
  await exec("git", ["switch", "-q", "task"], { cwd: f.root });
  await exec("git", ["rm", "feature.txt"], { cwd: f.root });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "delete"], { cwd: f.root });
  const deleted = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
  // Delete an inherited file: dropping a newly added own file would simply
  // remove it from the net delta and is not a deletion of preserved bytes.
  await exec("git", ["rm", "conflict.txt"], { cwd: f.root });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "delete base file"], { cwd: f.root });
  const removed = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), taskCommit: removed }), /cannot materialize/u);
  await exec("git", ["switch", "-q", "-c", "rename", deleted], { cwd: f.root });
  await exec("git", ["mv", "conflict.txt", "renamed.txt"], { cwd: f.root });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "rename"], { cwd: f.root });
  const renamed = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), taskCommit: renamed }), /cannot materialize/u);
});

test("ordinary proof bounds own ancestry and cannot classify a foreign merge as own-only", async (t) => {
  const f = await repository(t, { ordinary: true });
  const foreign = await changedProof(f, { parents: [f.task, f.dev] });
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), taskCommit: foreign }), /ancestry changed/u);
  let commit = f.task;
  const tree = await f.git(["rev-parse", `${f.task}^{tree}`]);
  for (let index = 0; index < 255; index += 1) {
    commit = (await exec("git", ["commit-tree", tree, "-p", commit, "-m", `own-${index}`], {
      cwd: f.root, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
    })).stdout.trim();
  }
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), taskCommit: commit }), /exceeds its bound/u);
});

test("selected proof rejects wrong review parent, remote and publication identity", async (t) => {
  const f = await repository(t);
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), taskCommit: f.published }), /ancestry changed/u);
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), remoteCommit: f.local }), /publication, bundle or Task identity/u);
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), publishedCommit: f.local,
    remoteCommit: f.local }), /divergent published-main case/u);
});
