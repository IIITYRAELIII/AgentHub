import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { taskGitIdentityHash } from "../../../src/domain/task-git-reference.mjs";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { assertNativeMergedResults, mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";

async function fixture(t, { lost = null, conflict = false, descendants = false, foreignBase = false, sourceEntry = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-automatic-deletion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot);
  const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });
  const git = (args, options) => gitAt(sourceRoot, args, options);
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@local.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  const save = (name, text) => writeFile(path.join(sourceRoot, name), text);
  const commit = async message => {
    await git(["add", "."]);
    await git(["commit", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  await save("stable.txt", "stable baseline\n");
  if (conflict) await save("shared.txt", "header\nbaseline\nfooter\n");
  const main = await commit("agreed base");
  const inherited = Array.from({ length: 8 }, (_, i) => `inherited-${i}.txt`);
  for (const file of inherited) await save(file, `sealed ${file}\n`);
  const published = await commit("sealed publication");
  await git(["checkout", "--detach", descendants ? published : main]);
  await save("early.txt", "entire early own contribution\n");
  const early = await commit("earlier own Task work");
  let peer = published;
  if (descendants) {
    await git(["checkout", "--detach", foreignBase ? main : published]);
    await save("peer.txt", "independent dependency work\n");
    peer = await commit("other accepted dependency tip");
    await git(["merge", "--no-ff", "--no-edit", early]);
  } else await git(["merge", "--no-ff", "--no-edit", published]);
  const leftMerge = await git(["rev-parse", "HEAD"]);
  for (const file of inherited) await rm(path.join(sourceRoot, file));
  if (lost === "early") await rm(path.join(sourceRoot, "early.txt"));
  if (conflict) await save("shared.txt", "header\nleft current\nfooter\n");
  let before = await commit("later dev removes inherited publication files");
  await git(["checkout", "--detach", peer]);
  await git(["merge", "--no-ff", "--no-edit", early]);
  await save("new.txt", "entire new own contribution\n");
  if (conflict) await save("shared.txt", "header\nsource current\nfooter\n");
  let result = await commit("current Task result");
  if (sourceEntry) {
    await save(inherited[0], sourceEntry === "binary" ? Buffer.from([0, 1, 2, 3]) : "owned replacement payload\n");
    await git(["add", inherited[0]]);
    if (sourceEntry === "mode") await git(["update-index", "--chmod=+x", inherited[0]]);
    if (sourceEntry === "type") {
      const blob = await git(["hash-object", "-w", inherited[0]]);
      await git(["update-index", "--add", "--cacheinfo", "120000", blob, inherited[0]]);
    }
    await git(["commit", "-m", "own selected entry change"]);
    result = await git(["rev-parse", "HEAD"]);
  }
  if (lost === "new") {
    // The current result descends from an earlier selected result now contained
    // in dev. Git therefore deletes its unchanged own file automatically.
    await git(["checkout", "--detach", before]);
    await git(["merge", "--no-ff", "--no-edit", result]);
    await rm(path.join(sourceRoot, "new.txt"));
    before = await commit("later dev loses new selected work");
    await git(["checkout", "--detach", result]);
    await save("later.txt", "latest own correction\n");
    result = await commit("later Task correction keeps earlier work");
  }
  const tasks = [{ taskId: "selected", baseCommit: main, resultCommit: result }];
  const publication = { generation: "sealed", repositoryRoot: sourceRoot,
    recordHash: taskGitIdentityHash({ published, sourceRoot }), commit: published,
    tree: await git(["rev-parse", `${published}^{tree}`]) };
  const identity = { policy: "native-dev-merge-v1", taskId: "selected", resultCommit: result, before,
    mainCommit: main, nativeHistoryAuthority: { baseline: null, adoptions: [], publishedMetadata: publication } };
  const readJson = async file => JSON.parse(await readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return "null";
    throw error;
  }));
  const compose = () => mergeSelectedResults({ root: path.join(root, "capture"), sourceRoot,
    baseCommit: before, tasks, identity, gitAt, readJson,
    writeJson: (file, value) => writeFile(file, JSON.stringify(value)) });
  const verify = (value, changed = {}) => assertNativeMergedResults({
    git: (args, options) => gitAt(value.root, args, options), baseCommit: before,
    tasks, identity, merges: value.merges, head: value.head, tree: value.tree, ...changed });
  return { root, sourceRoot, git, gitAt, save, commit, main, published, early, peer, leftMerge,
    before, result, inherited, tasks, identity, compose, verify };
}

test("sealed published files deleted by the exact automatic multiple-base merge stay absent", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.git(["merge-base", "--all", f.before, f.result])).split(/\r?\n/u).sort(),
    [f.published, f.early].sort());
  const value = await f.compose();
  await f.verify(value);
  for (const file of f.inherited) {
    assert.equal(await f.git(["ls-tree", f.main, "--", file]), "");
    assert.equal(await f.git(["rev-parse", `${f.published}:${file}`]),
      await f.git(["rev-parse", `${f.result}:${file}`]));
    assert.equal(await f.gitAt(value.root, ["ls-tree", "HEAD", "--", file]), "");
  }
  assert.equal(await f.gitAt(value.root, ["show", "HEAD:early.txt"]), "entire early own contribution");
  assert.equal(await f.gitAt(value.root, ["show", "HEAD:new.txt"]), "entire new own contribution");
  const automatic = (await f.git(["merge-tree", "--write-tree", f.before, f.result])).split(/\r?\n/u)[0];
  assert.equal(value.tree, automatic);
  assert.equal((await f.compose()).head, value.head);
  assert.equal(await f.git(["rev-parse", "main"]), f.published);
});

for (const lost of ["early", "new"]) test(`automatic absence cannot credit lost ${lost} own Task work`, async t => {
  const f = await fixture(t, { lost });
  await assert.rejects(f.compose(), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
    && error.missingPaths.includes(`${lost}.txt`));
});

test("automatic deletion credit remains bound to sealed Task publication authority", async t => {
  const f = await fixture(t);
  const value = await f.compose();
  for (const changed of [
    { ...f.identity, taskId: "foreign" },
    { ...f.identity, resultCommit: f.published },
    { ...f.identity, before: f.main },
    { ...f.identity, nativeHistoryAuthority: { ...f.identity.nativeHistoryAuthority,
      publishedMetadata: { ...f.identity.nativeHistoryAuthority.publishedMetadata,
        tree: await f.git(["rev-parse", `${f.main}^{tree}`]) } } },
    { ...f.identity, nativeHistoryAuthority: { ...f.identity.nativeHistoryAuthority,
      sourcePublication: { revision: f.main } } },
  ]) await assert.rejects(f.verify(value, { identity: changed }), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  for (const changed of [
    { ...f.identity, nativeHistoryAuthority: { baseline: null, adoptions: [] } },
    { ...f.identity, nativeHistoryAuthority: { ...f.identity.nativeHistoryAuthority,
      publishedMetadata: { ...f.identity.nativeHistoryAuthority.publishedMetadata,
        commit: f.main, tree: await f.git(["rev-parse", `${f.main}^{tree}`]) } } },
  ]) await assert.rejects(f.verify(value, { identity: changed }),
    error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
      && f.inherited.every(file => error.missingPaths.includes(file)));
});

test("deletion evidence cannot replace exact automatic output or resolution bindings", async t => {
  const f = await fixture(t, { conflict: true });
  await assert.rejects(f.compose(), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  const checkout = path.join(f.root, "capture", "repository");
  await writeFile(path.join(checkout, "shared.txt"), "header\nleft current\nsource current\nfooter\n");
  await f.gitAt(checkout, ["add", "."]);
  await f.gitAt(checkout, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
    "commit", "-m", "normal exact conflict resolution"]);
  const value = await f.compose();
  await f.verify(value);
  const stale = structuredClone(value.merges);
  stale[0].resolution.binding.diffSha256 = "0".repeat(64);
  await assert.rejects(f.verify(value, { merges: stale }), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  await writeFile(path.join(checkout, "alien.txt"), "unselected content\n");
  await f.gitAt(checkout, ["add", "."]);
  await f.gitAt(checkout, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
    "commit", "--amend", "--no-edit"]);
  const head = await f.gitAt(checkout, ["rev-parse", "HEAD"]);
  const tree = await f.gitAt(checkout, ["rev-parse", "HEAD^{tree}"]);
  await assert.rejects(f.verify(value, { head, tree, merges: [{ ...value.merges[0], commit: head }] }),
    { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
});

test("automatic absence survives when every exact common base contains the sealed publication", async t => {
  const f = await fixture(t, { descendants: true });
  const bases = (await f.git(["merge-base", "--all", f.before, f.result])).split(/\r?\n/u).sort();
  assert.deepEqual(bases, [f.early, f.peer].sort());
  assert.ok(!bases.includes(f.published));
  for (const base of bases) await f.git(["merge-base", "--is-ancestor", f.published, base]);
  const value = await f.compose();
  await f.verify(value);
  for (const file of f.inherited) {
    assert.equal(await f.git(["ls-tree", f.result, "--", file]), await f.git(["ls-tree", f.published, "--", file]));
    assert.equal(await f.gitAt(value.root, ["ls-tree", "HEAD", "--", file]), "");
  }
  assert.equal(await f.gitAt(value.root, ["show", "HEAD:early.txt"]), "entire early own contribution");
  assert.equal(await f.gitAt(value.root, ["show", "HEAD:new.txt"]), "entire new own contribution");
  assert.equal((await f.compose()).head, value.head);
});

for (const lost of ["early", "new"]) test(`descendant publication bases do not waive lost ${lost} own work`, async t => {
  const f = await fixture(t, { descendants: true, lost });
  await assert.rejects(f.compose(), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
    && error.missingPaths.includes(`${lost}.txt`));
});

test("one common base outside the publication refuses automatic absence", async t => {
  const f = await fixture(t, { descendants: true, foreignBase: true });
  assert.deepEqual((await f.git(["merge-base", "--all", f.before, f.result])).split(/\r?\n/u).sort(),
    [f.early, f.peer].sort());
  await assert.rejects(f.git(["merge-base", "--is-ancestor", f.published, f.peer]));
  await assert.rejects(f.compose(), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
    && f.inherited.every(file => error.missingPaths.includes(file)));
});

test("descendant absence retains publication identity and automatic graph guards", async t => {
  const f = await fixture(t, { descendants: true });
  const value = await f.compose();
  const missing = error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
    && f.inherited.every(file => error.missingPaths.includes(file));
  await assert.rejects(f.verify(value, { identity: { ...f.identity,
    nativeHistoryAuthority: { baseline: null, adoptions: [] } } }), missing);
  await assert.rejects(f.verify(value, { identity: { ...f.identity,
    nativeHistoryAuthority: { ...f.identity.nativeHistoryAuthority,
      publishedMetadata: { ...f.identity.nativeHistoryAuthority.publishedMetadata,
        commit: f.main, tree: await f.git(["rev-parse", `${f.main}^{tree}`]) } } } }), missing);
  for (const changed of [{ ...f.identity, taskId: "foreign" },
    { ...f.identity, before: f.main },
    { ...f.identity, nativeHistoryAuthority: { ...f.identity.nativeHistoryAuthority,
      publishedMetadata: { ...f.identity.nativeHistoryAuthority.publishedMetadata, tree: "0".repeat(40) } } },
  ]) await assert.rejects(f.verify(value, { identity: changed }), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  const stale = structuredClone(value.merges);
  stale[0].resolution.binding.automaticTree = await f.git(["rev-parse", `${f.result}^{tree}`]);
  await assert.rejects(f.verify(value, { merges: stale }), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  // Reinsert one deleted entry after the automatic merge. Absence evidence
  // cannot hide a candidate that differs from the actual automatic output.
  await writeFile(path.join(value.root, f.inherited[0]), "unselected resurrection\n");
  await f.gitAt(value.root, ["add", "."]);
  await f.gitAt(value.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit"]);
  const head = await f.gitAt(value.root, ["rev-parse", "HEAD"]);
  await assert.rejects(f.verify(value, { head, tree: await f.gitAt(value.root, ["rev-parse", "HEAD^{tree}"]),
    merges: [{ ...value.merges[0], commit: head, resolution: null }] }), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

for (const sourceEntry of ["blob", "mode", "type", "binary"]) {
  test(`publication ancestry does not credit removed own ${sourceEntry} entry`, async t => {
    const f = await fixture(t, { descendants: true, sourceEntry });
    const file = f.inherited[0];
    assert.notEqual(await f.git(["ls-tree", f.result, "--", file]), await f.git(["ls-tree", f.published, "--", file]));
    await assert.rejects(f.compose(), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
    const checkout = path.join(f.root, "capture", "repository");
    await f.gitAt(checkout, ["rm", "-f", "--", file]);
    await f.gitAt(checkout, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "remove selected entry"]);
    await assert.rejects(f.compose(), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
      && error.missingPaths.includes(file));
  });
}

