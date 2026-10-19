import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-migrated-own-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary");
  const run = async (cwd, ...args) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
  await run(root, "init", "--bare", "--initial-branch=main", "origin.git");
  await run(root, "clone", "origin.git", primary);
  const git = (...args) => run(primary, ...args);
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "core.autocrlf", "false");
  const put = (name, bytes) => writeFile(path.join(primary, name), bytes, "utf8");
  const commit = async (message) => {
    await git("add", "-A");
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await put("outside.txt", "published outside\n");
  await put(".gitattributes", "* text eol=lf\n");
  const published = await commit("published");
  await git("push", "origin", "main");
  await put("local-context.txt", "unpublished main context\n");
  const base = await commit("preserved local main");
  await git("checkout", "-b", "neighbor", base);
  await put("neighbor.txt", "accepted neighbor\n");
  const neighborResult = await commit("neighbor result");
  await git("checkout", "-b", "consumer", base);
  await put("initial.txt", "full initial result\n");
  await put("corrected.txt", "before review\n");
  const priorResult = await commit("initial result");
  await put("corrected.txt", "after review\n");
  const result = await commit("review correction");
  await git("checkout", "-b", "dev", base);
  await put("neighbor.txt", "accepted neighbor\n");
  await put("initial.txt", "full initial result\n");
  await put("corrected.txt", "after review\n");
  await commit("different owner already carried result bytes");
  const integrate = async (ref, order) => {
    const parent = await git("rev-parse", "HEAD");
    await git("merge", "--no-ff", "--no-edit", ref);
    const integration = { commit: await git("rev-parse", "HEAD"), parent, order };
    assert.equal(await git("diff", "--name-only", parent, integration.commit), "");
    return integration;
  };
  const neighbor = { taskId: "neighbor", taskRevision: 1, baseCommit: base,
    resultCommit: neighborResult, integrations: [await integrate(neighborResult, 1)] };
  const consumer = { taskId: "consumer", taskRevision: 2, baseCommit: base,
    resultCommit: result, integrations: [await integrate(result, 2)] };
  await git("checkout", "main");
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "data") });
  const prior = await service.prepareCandidate({
    projectRoot: primary, approvedBaseCommit: base,
    planRevision: "before-consumer", frozenTasks: [neighbor],
  });
  const checkpointFile = path.join(path.dirname(prior.releaseRoot), "checkpoint.json");
  return { root, primary, run, git, put, commit, base, published, priorResult,
    neighbor, consumer, service, prior, checkpointFile };
}

test("native correction with zero dev delta retains full agreed-main history and retains the selected neighbor", async (t) => {
  const f = await fixture(t);
  const candidate = await f.service.prepareCandidate({
    projectRoot: f.primary, approvedBaseCommit: f.base,
    planRevision: "full-correction", frozenTasks: [f.neighbor, f.consumer],
  });
  assert.equal(await readFile(path.join(candidate.releaseRoot, "initial.txt"), "utf8"), "full initial result\n");
  assert.equal(await readFile(path.join(candidate.releaseRoot, "corrected.txt"), "utf8"), "after review\n");
  assert.equal(await readFile(path.join(candidate.releaseRoot, "neighbor.txt"), "utf8"), "accepted neighbor\n");
  assert.equal(await readFile(path.join(candidate.releaseRoot, "outside.txt"), "utf8"), "published outside\n");
  assert.equal(await readFile(path.join(candidate.releaseRoot, "local-context.txt"), "utf8"), "unpublished main context\n");
  assert.deepEqual(new Set(candidate.manifest.tasks.map(task => task.taskId)), new Set(["neighbor", "consumer"]));
  assert.equal(candidate.manifest.compositionPolicy, "main-selected-git-merge-v1");
  const manifest = JSON.parse(await readFile(candidate.manifestFile, "utf8"));
  assert.equal(manifest.candidateReuse, undefined);
  assert.equal(await f.git("rev-parse", "HEAD"), f.base);
  assert.equal(await f.git("status", "--porcelain"), "");
});

for (const scenario of ["manual integration", "foreign result merge", "wrong task-side parent", "duplicate owner"]) {
  test(`native result authority handles ${scenario} without dev projection`, async (t) => {
    const f = await fixture(t);
    const consumer = structuredClone(f.consumer);
    let tasks = [f.neighbor, consumer];
    if (scenario === "manual integration") {
      await f.git("checkout", "dev");
      await f.put("outside.txt", "unreviewed integration baggage\n");
      const tree = await f.commit("manual integration tree");
      const original = consumer.integrations[0];
      consumer.integrations[0].commit = await f.git("commit-tree", `${tree}^{tree}`,
        "-p", original.parent, "-p", consumer.resultCommit, "-m", "manual merge");
    } else if (scenario === "foreign result merge") {
      await f.git("checkout", "-b", "foreign", f.base);
      await f.put("foreign.txt", "foreign ownership\n");
      const foreign = await f.commit("foreign result");
      await f.git("checkout", "consumer");
      await f.git("merge", "--no-ff", "--no-edit", foreign);
      consumer.resultCommit = await f.git("rev-parse", "HEAD");
      await f.git("checkout", "dev");
      const parent = await f.git("rev-parse", "HEAD");
      await f.git("merge", "--no-ff", "--no-edit", consumer.resultCommit);
      consumer.integrations = [{ commit: await f.git("rev-parse", "HEAD"), parent, order: 3 }];
    } else if (scenario === "wrong task-side parent") {
      consumer.integrations = structuredClone(f.neighbor.integrations);
      tasks = [consumer];
    } else {
      tasks.push({ ...structuredClone(consumer), taskRevision: consumer.taskRevision + 1 });
    }
    await f.git("checkout", "main");
    const beforeCheckpoint = await readFile(f.checkpointFile);
    const beforeRef = await f.run(f.prior.releaseRoot, "rev-parse", "PreRelease");
    const request = { projectRoot: f.primary, approvedBaseCommit: f.base,
      planRevision: `native-${scenario}`, frozenTasks: tasks };
    if (scenario === "foreign result merge" || scenario === "duplicate owner") {
      await assert.rejects(f.service.prepareCandidate(request), scenario === "foreign result merge"
        ? { code: "RELEASE_NATIVE_HISTORY_REQUIRED" } : /multiple result commits or integration histories/u);
      assert.deepEqual(await readFile(f.checkpointFile), beforeCheckpoint);
      assert.equal(await f.run(f.prior.releaseRoot, "rev-parse", "PreRelease"), beforeRef);
    } else {
      const candidate = await f.service.prepareCandidate(request);
      assert.equal(await f.run(candidate.releaseRoot, "show", "PreRelease:outside.txt"), "published outside");
      assert.equal(await f.run(candidate.releaseRoot, "show", "PreRelease:corrected.txt"), "after review");
      assert.equal(candidate.manifest.compositionPolicy, "main-selected-git-merge-v1");
    }
    assert.equal(await f.run(f.prior.releaseRoot, "status", "--porcelain"), "");
    assert.equal(await f.git("rev-parse", "HEAD"), f.base);
  });
}
