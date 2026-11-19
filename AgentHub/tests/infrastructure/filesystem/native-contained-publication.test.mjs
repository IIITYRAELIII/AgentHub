import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTaskGitCommand, TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { publishedMetadataContext } from "../../../src/infrastructure/filesystem/local-source-baseline.mjs";
import { assertNativeMergedResults, mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";

const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });
const readJson = async file => JSON.parse(await readFile(file, "utf8").catch(error => {
  if (error.code === "ENOENT") return "null";
  throw error;
}));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-contained-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"); await mkdir(sourceRoot);
  const git = (args, options) => gitAt(sourceRoot, args, options);
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@local.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  await git(["config", "core.symlinks", "false"]);
  const save = (file, bytes) => writeFile(path.join(sourceRoot, file), bytes);
  const staged = async message => { await git(["commit", "-m", message]); return git(["rev-parse", "HEAD"]); };
  const commit = async message => { await git(["add", "."]); return staged(message); };
  await save("stable.txt", "agreed baseline\n");
  await save("own-delete.txt", "remove this in the Task\n");
  await save("own-mode.txt", "own mode\n");
  await save("own-type", "original regular entry\n");
  await save("own.bin", Buffer.from([0, 1, 2, 3]));
  const main = await commit("agreed main");
  const inherited = Array.from({ length: 8 }, (_, i) => `inherited-${i}.txt`);
  for (const file of inherited) await save(file, "obsolete published context\n");
  await save("context.txt", "published context\n");
  await save("context.bin", Buffer.from([0, 8, 8]));
  const published = await commit("sealed publication");
  await save("early.txt", "entire earlier own contribution\n");
  await commit("earlier own correction");
  await save("new.txt", "entire new own contribution\n");
  await rm(path.join(sourceRoot, "own-delete.txt"));
  await save("own.bin", Buffer.from([0, 4, 5, 6]));
  await save("own-type", "early.txt");
  await git(["add", "."]);
  await git(["update-index", "--chmod=+x", "own-mode.txt"]);
  const link = await git(["hash-object", "-w", "--stdin"], { input: "early.txt" });
  await git(["update-index", "--cacheinfo", `120000,${link},own-type`]);
  const result = await staged("current own selected result");
  await git(["checkout", "--detach", published]);
  for (const file of inherited) await rm(path.join(sourceRoot, file));
  await save("context.txt", "later independent context\n");
  await save("context.bin", Buffer.from([0, 9, 9]));
  await commit("legitimate dev context");
  await git(["merge", "--no-ff", "--no-edit", result]);
  const before = await git(["rev-parse", "HEAD"]);
  const tasks = [{ taskId: "selected", baseCommit: main, resultCommit: result }];
  const publication = { generation: "original-sealed-generation", repositories: [{ root: sourceRoot, revision: published }] };
  const metadata = await publishedMetadataContext({ publication, repositoryRoot: sourceRoot, git });
  const identity = { policy: "native-dev-merge-v1", taskId: "selected", resultCommit: result, before, mainCommit: main,
    nativeHistoryAuthority: { baseline: null, adoptions: [], publishedMetadata: metadata } };
  const compose = (prefix = before, input = identity, folder = "capture") => mergeSelectedResults({
    root: path.join(root, folder), sourceRoot, baseCommit: prefix, tasks, identity: input, gitAt, readJson, writeJson });
  return { root, sourceRoot, git, save, commit, staged, main, published, result, before, inherited, tasks, identity, compose };
}

test("contained Test preserves the sealed publication context and still certifies the whole selected delta", async t => {
  const f = await fixture(t);
  assert.equal(await f.git(["merge-base", "--all", f.before, f.result]), f.result);
  const value = await f.compose();
  assert.equal(value.head, f.before);
  assert.equal(value.merges[0].contained, true);
  await assertNativeMergedResults({ git: (args, options) => gitAt(value.root, args, options),
    baseCommit: f.before, tasks: f.tasks, identity: f.identity, merges: value.merges, head: value.head, tree: value.tree });
  for (const file of f.inherited) assert.equal(await gitAt(value.root, ["ls-tree", "HEAD", "--", file]), "");
  assert.equal(await gitAt(value.root, ["show", "HEAD:context.txt"]), "later independent context");
  assert.equal(await gitAt(value.root, ["show", "HEAD:early.txt"]), "entire earlier own contribution");
  assert.equal(await gitAt(value.root, ["show", "HEAD:new.txt"]), "entire new own contribution");
  assert.equal(await gitAt(value.root, ["ls-tree", "HEAD", "--", "own-delete.txt"]), "");
  for (const file of ["own-mode.txt", "own-type", "own.bin"]) {
    assert.equal(await gitAt(value.root, ["ls-tree", "HEAD", "--", file]), await f.git(["ls-tree", f.result, "--", file]));
  }
  const journal = path.join(f.root, "capture", "merge.json"), bytes = await readFile(journal);
  assert.equal((await f.compose()).head, f.before);
  assert.deepEqual(await readFile(journal), bytes);
  assert.equal(await f.git(["rev-parse", "HEAD"]), f.before);
  assert.equal(await f.git(["status", "--porcelain=v1"]), "");
});

test("contained publication replay refuses earlier new deletion mode type and binary own losses", async t => {
  const f = await fixture(t);
  for (const loss of ["early", "new", "delete", "mode", "type", "binary"]) {
    await f.git(["checkout", "--detach", f.before]);
    let file;
    if (["early", "new"].includes(loss)) { file = `${loss}.txt`; await rm(path.join(f.sourceRoot, file)); await f.git(["add", "."]); }
    if (loss === "delete") { file = "own-delete.txt"; await f.save(file, "remove this in the Task\n"); await f.git(["add", "."]); }
    if (loss === "mode") { file = "own-mode.txt"; await f.git(["update-index", "--chmod=-x", file]); }
    if (loss === "type") { file = "own-type"; await f.save(file, "original regular entry\n");
      const oid = await f.git(["rev-parse", `${f.published}:${file}`]); await f.git(["update-index", "--cacheinfo", `100644,${oid},${file}`]); }
    if (loss === "binary") { file = "own.bin"; await f.save(file, Buffer.from([0, 1, 2, 3])); await f.git(["add", "."]); }
    const regressed = await f.staged(`lose own ${loss}`);
    assert.equal(await f.git(["merge-base", "--all", regressed, f.result]), f.result);
    await assert.rejects(f.compose(regressed, { ...f.identity, before: regressed }, `lost-${loss}`),
      error => error.code === "RELEASE_SELECTED_CONTENT_MISSING" && error.missingPaths.includes(file), `own loss: ${loss}`);
  }
});

test("contained publication replay requires its exact bound Task result before and metadata identity", async t => {
  const f = await fixture(t);
  const value = await f.compose();
  const verify = identity => assertNativeMergedResults({ git: (args, options) => gitAt(value.root, args, options),
    baseCommit: f.before, tasks: f.tasks, merges: value.merges, head: value.head, tree: value.tree, identity });
  const metadata = f.identity.nativeHistoryAuthority.publishedMetadata;
  for (const identity of [
    { ...f.identity, taskId: "foreign" }, { ...f.identity, resultCommit: f.published }, { ...f.identity, before: f.main },
    ...[{ generation: "" }, { recordHash: "invalid" }, { repositoryRoot: "" }, { tree: "0".repeat(40) }].map(change => ({
      ...f.identity, nativeHistoryAuthority: { ...f.identity.nativeHistoryAuthority, publishedMetadata: { ...metadata, ...change } } })),
    { ...f.identity, nativeHistoryAuthority: { ...f.identity.nativeHistoryAuthority, baseline: { foreign: true } } },
    { ...f.identity, nativeHistoryAuthority: { ...f.identity.nativeHistoryAuthority, sourcePublication: { revision: f.main } } },
  ]) await assert.rejects(verify(identity), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  for (const identity of [
    { ...f.identity, nativeHistoryAuthority: { baseline: null, adoptions: [] } },
    { ...f.identity, nativeHistoryAuthority: { ...f.identity.nativeHistoryAuthority, publishedMetadata: {
      ...metadata, commit: f.main, tree: await f.git(["rev-parse", `${f.main}^{tree}`]) } } },
  ]) await assert.rejects(verify(identity), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

test("TaskGit repeated Test binds and rereads the real publication record instead of trusting containment", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-contained-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary"); await mkdir(primary);
  const git = (args, options) => gitAt(primary, args, options);
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Fixture"]); await git(["config", "user.email", "fixture@local.invalid"]);
  await writeFile(path.join(primary, ".gitattributes"), "* text=auto eol=lf\n");
  await writeFile(path.join(primary, "base.txt"), "agreed\n");
  const commit = async (cwd, message) => { await gitAt(cwd, ["add", "."]);
    await gitAt(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message]);
    return gitAt(cwd, ["rev-parse", "HEAD"]); };
  const main = await commit(primary, "agreed main");
  let publication = null, drift = false, reads = 0;
  const service = new TaskGitWorkspaceService({ dataDir: path.join(root, "data"), readPublication: async () => {
    reads++;
    return drift && reads > 1 ? { ...publication, generation: "changed-after-binding" } : publication;
  } });
  const taskId = "33333333-3333-4333-8333-333333333333";
  const task = await service.prepare({ taskId, projectRoot: primary });
  const dev = await service.prepareDev(primary);
  await git(["checkout", "--detach", main]);
  await writeFile(path.join(primary, "inherited.txt"), "published old context\n");
  const published = await commit(primary, "published source");
  await git(["checkout", "main"]);
  publication = { generation: "original-publication", repositories: [{ root: primary, revision: published }] };
  await gitAt(task.projectRoot, ["merge", "--ff-only", published]);
  await writeFile(path.join(task.projectRoot, "own.txt"), "exact own work\n");
  await commit(task.projectRoot, "own result");
  await gitAt(dev.projectRoot, ["merge", "--ff-only", published]);
  await rm(path.join(dev.projectRoot, "inherited.txt"));
  await writeFile(path.join(dev.projectRoot, "later.txt"), "independent dev\n");
  await commit(dev.projectRoot, "legitimate inherited removal");
  const first = await service.snapshotAndMerge({ taskId, projectRoot: task.projectRoot });
  assert.equal(first.integration.integrated, true);
  const before = first.integration.dev.headCommit;
  const second = await service.snapshotAndMerge({ taskId, projectRoot: task.projectRoot });
  assert.equal(second.integration.integrated, true);
  assert.equal(second.integration.dev.headCommit, before);
  assert.equal(await gitAt(dev.projectRoot, ["ls-tree", "HEAD", "--", "inherited.txt"]), "");
  assert.equal(await readFile(path.join(dev.projectRoot, "own.txt"), "utf8"), "exact own work\n");
  reads = 0; drift = true;
  await assert.rejects(service.snapshotAndMerge({ taskId, projectRoot: task.projectRoot }), /authority changed/u);
  assert.equal(await git(["rev-parse", "dev"]), before);
  drift = false;
  publication = { generation: "foreign", repositories: [{ root: path.join(root, "foreign"), revision: published }] };
  await assert.rejects(service.snapshotAndMerge({ taskId, projectRoot: task.projectRoot }));
  assert.equal(await git(["rev-parse", "dev"]), before);
  assert.equal(await git(["rev-parse", "HEAD"]), main);
  assert.equal(await git(["status", "--porcelain=v1"]), "");
});
