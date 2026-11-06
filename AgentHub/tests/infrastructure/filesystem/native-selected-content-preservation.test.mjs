import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTaskGitCommand, TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { assertNativeMergedResults, assertNativePreparedComposition, mergeSelectedResults, NATIVE_RELEASE_POLICY }
  from "../../../src/infrastructure/filesystem/native-release-merge.mjs";

const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });
const readJson = async file => JSON.parse(await readFile(file, "utf8").catch(error => {
  if (error.code === "ENOENT") return "null";
  throw error;
}));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value), "utf8");
async function commit(root, message) {
  await gitAt(root, ["add", "."]);
  await gitAt(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message]);
  return gitAt(root, ["rev-parse", "HEAD"]);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-content-preservation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"); await mkdir(sourceRoot);
  await gitAt(sourceRoot, ["init", "--initial-branch=main"]);
  await writeFile(path.join(sourceRoot, "selection.txt"), "old selected\n");
  const base = await commit(sourceRoot, "main");
  const create = async (name, body, from = base) => {
    await gitAt(sourceRoot, ["checkout", "--detach", from]);
    await writeFile(path.join(sourceRoot, "selection.txt"), body);
    return commit(sourceRoot, name);
  };
  const compose = (baseCommit, tasks, options = {}, folder = "capture") => mergeSelectedResults({
    root: path.join(root, folder), sourceRoot, baseCommit, tasks,
    identity: { policy: NATIVE_RELEASE_POLICY, baseCommit, tasks },
    gitAt, readJson, writeJson, ...options,
  });
  return { root, sourceRoot, base, create, compose };
}

test("published ordinary Test replay binds its original identity without changing other selection policies", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "inherited.txt"), "header\n\nmiddle\n\nfooter\n");
  const main = await commit(f.sourceRoot, "agreed base");
  await writeFile(path.join(f.sourceRoot, "inherited.txt"), "header\n\nmiddle\npublished once\nfooter\n");
  const published = await commit(f.sourceRoot, "publication");
  await writeFile(path.join(f.sourceRoot, "inherited.txt"), "header\npublished once\nmiddle\n\nfooter\n");
  const dev = await commit(f.sourceRoot, "move inherited block in dev");
  await gitAt(f.sourceRoot, ["checkout", "--detach", published]);
  await writeFile(path.join(f.sourceRoot, "own.txt"), "exact own delta\n");
  const result = await commit(f.sourceRoot, "own correction");
  const tasks = [{ taskId: "selected", baseCommit: main, resultCommit: result }];
  const metadata = { generation: "original", repositoryRoot: f.sourceRoot,
    recordHash: taskGitIdentityHash({ root: f.sourceRoot, revision: published }), commit: published,
    tree: await gitAt(f.sourceRoot, ["rev-parse", `${published}^{tree}`]) };
  const identity = { policy: "native-dev-merge-v1", taskId: "selected", resultCommit: result, before: dev, mainCommit: main,
    nativeHistoryAuthority: { baseline: null, adoptions: [], publishedMetadata: metadata } };
  const value = await f.compose(dev, tasks, { identity });
  const verify = input => assertNativePreparedComposition({ git: (args, options) => gitAt(value.root, args, options),
    baseCommit: dev, tasks, merges: value.merges, head: value.head, tree: value.tree, identity: input,
    historyAuthority: { bases: [dev], metadataBases: [published] } });
  await verify(identity);
  for (const changed of [
    { ...identity, taskId: "foreign" }, { ...identity, resultCommit: published }, { ...identity, before: main },
    { ...identity, nativeHistoryAuthority: { ...identity.nativeHistoryAuthority,
      publishedMetadata: { ...metadata, tree: await gitAt(f.sourceRoot, ["rev-parse", `${main}^{tree}`]) } } },
    { ...identity, nativeHistoryAuthority: { ...identity.nativeHistoryAuthority,
      sourcePublication: { revision: main } } },
  ]) await assert.rejects(verify(changed), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  for (const changed of [{ ...identity, nativeHistoryAuthority: { baseline: null, adoptions: [] } },
    { ...identity, policy: NATIVE_RELEASE_POLICY }]) {
    await assert.rejects(verify(changed), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
  }
  assert.equal(await gitAt(value.root, ["show", "HEAD:own.txt"]), "exact own delta");
  assert.equal(await gitAt(value.root, ["show", "HEAD:inherited.txt"]), "header\npublished once\nmiddle\n\nfooter");
  await gitAt(f.sourceRoot, ["checkout", "--detach", result]);
  await rm(path.join(f.sourceRoot, "own.txt"));
  const regressed = await commit(f.sourceRoot, "lost own correction");
  await assert.rejects(f.compose(regressed, tasks, { identity: { ...identity, before: regressed } }, "lost-own"),
    error => error.code === "RELEASE_SELECTED_CONTENT_MISSING" && error.missingPaths.includes("own.txt"));
  assert.equal(await gitAt(f.sourceRoot, ["rev-parse", "main"]), dev);
});

test("an ancestor result cannot silently lose its selected content", async t => {
  const f = await fixture(t);
  const result = await f.create("accepted result", "new head\n");
  const regressed = await f.create("later whole-file rollback", "old selected\n", result);
  assert.equal(await gitAt(f.sourceRoot, ["merge-base", "--is-ancestor", result, regressed]), "");
  await assert.rejects(f.compose(regressed, [{ taskId: "selected", baseCommit: f.base, resultCommit: result }]),
    error => error.code === "RELEASE_SELECTED_CONTENT_MISSING" && error.missingPaths.includes("selection.txt"));
  assert.equal(await gitAt(f.sourceRoot, ["rev-parse", "HEAD"]), regressed);
  assert.equal(await gitAt(f.sourceRoot, ["show-ref", "--heads"]), `${f.base} refs/heads/main`);
});

test("canonical preparation refuses missing selected content before promotion and callback", async t => {
  const f = await fixture(t);
  const result = await f.create("accepted result", "new head\n");
  const regressed = await f.create("later rollback", "old selected\n", result);
  await gitAt(f.sourceRoot, ["branch", "-f", "main", regressed]);
  await gitAt(f.sourceRoot, ["checkout", "main"]);
  const origin = path.join(f.root, "origin.git");
  await gitAt(f.root, ["init", "--bare", "--initial-branch=main", origin]);
  await gitAt(f.sourceRoot, ["remote", "add", "origin", origin]);
  await gitAt(f.sourceRoot, ["push", "origin", "main"]);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "release-data"),
    environment: { ...process.env, LOCALAPPDATA: path.join(f.root, "state"), XDG_STATE_HOME: path.join(f.root, "state") } });
  const task = { taskId: "selected", taskRevision: 1, baseCommit: f.base, resultCommit: result };
  let callbacks = 0;
  await assert.rejects(service.prepareCandidate({ projectRoot: f.sourceRoot, workspaceId: "fixture",
    planRevision: "missing-content", approvedBaseCommit: regressed, frozenTasks: [task],
    commitPrepared: async () => { callbacks++; } }), error => error.code === "RELEASE_PREPARATION_REJECTED"
      && error.cause.code === "RELEASE_SELECTED_CONTENT_MISSING"
      && error.selectedContentMissing.missingPaths.includes("selection.txt"));
  assert.equal(callbacks, 0);
  assert.equal(await service.frozenCandidate(f.sourceRoot, { allowAbsent: true }), null);
  assert.equal(await gitAt(f.sourceRoot, ["rev-parse", "HEAD"]), regressed);
  assert.equal(await gitAt(f.sourceRoot, ["status", "--porcelain=v1"]), "");
});

test("native Test combines independent Task bases without treating prior dev content as a deletion", async t => {
  const f = await fixture(t);
  const service = new TaskGitWorkspaceService({ dataDir: path.join(f.root, "task-data"),
    readPublication: async () => null });
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const first = await service.prepare({ taskId: firstId, projectRoot: f.sourceRoot });
  const second = await service.prepare({ taskId: secondId, projectRoot: f.sourceRoot });
  assert.equal(first.baseCommit, f.base);
  assert.equal(second.baseCommit, f.base);
  await writeFile(path.join(first.projectRoot, "first.txt"), "first independent result\n");
  await commit(first.projectRoot, "first Task result");
  await service.snapshotAndMerge({ taskId: firstId, projectRoot: first.projectRoot });
  await writeFile(path.join(second.projectRoot, "second.txt"), "second independent result\n");
  await commit(second.projectRoot, "second Task result");
  await assert.rejects(gitAt(second.projectRoot, ["cat-file", "-e", "HEAD:first.txt"]));
  await service.snapshotAndMerge({ taskId: secondId, projectRoot: second.projectRoot });
  assert.equal(await gitAt(f.sourceRoot, ["show", "dev:first.txt"]), "first independent result");
  assert.equal(await gitAt(f.sourceRoot, ["show", "dev:second.txt"]), "second independent result");
  assert.equal(await gitAt(f.sourceRoot, ["rev-parse", "main"]), f.base);
});

test("preserved selected code coexists with later unrelated changes", async t => {
  const f = await fixture(t);
  const result = await f.create("accepted result", "new head\n");
  await writeFile(path.join(f.sourceRoot, "later.txt"), "keep this\n");
  const later = await commit(f.sourceRoot, "unrelated later content");
  const tasks = [{ taskId: "selected", baseCommit: f.base, resultCommit: result }];
  const value = await f.compose(later, tasks);
  assert.equal(value.head, later);
  assert.equal(await gitAt(value.root, ["show", "HEAD:later.txt"]), "keep this");
  await assertNativePreparedComposition({ git: (args, options) => gitAt(value.root, args, options),
    baseCommit: later, tasks, merges: value.merges, head: value.head, tree: value.tree });
});

test("a later selected result may restore an earlier contained regression", async t => {
  const f = await fixture(t);
  const accepted = await f.create("accepted result", "new head\n");
  const regressed = await f.create("rollback", "old selected\n", accepted);
  const corrected = await f.create("own corrected result", "new head\n", regressed);
  const value = await f.compose(regressed, [
    { taskId: "original", baseCommit: f.base, resultCommit: accepted },
    { taskId: "correction", baseCommit: f.base, resultCommit: corrected },
  ]);
  assert.equal(await gitAt(value.root, ["show", "HEAD:selection.txt"]), "new head");
});

test("completed legacy journal is checked again rather than trusted", async t => {
  const f = await fixture(t);
  const result = await f.create("accepted result", "new head\n");
  const regressed = await f.create("rollback", "old selected\n", result);
  const tasks = [{ taskId: "selected", baseCommit: f.base, resultCommit: result }];
  await assert.rejects(f.compose(regressed, tasks), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
  const state = await readJson(path.join(f.root, "capture", "merge.json"));
  assert.equal(state.next, 1); assert.equal(state.merges[0].contained, true);
  await assert.rejects(f.compose(regressed, tasks), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

test("lost selected deletion is not mistaken for already integrated history", async t => {
  const f = await fixture(t);
  await rm(path.join(f.sourceRoot, "selection.txt"));
  const result = await commit(f.sourceRoot, "accepted deletion");
  const regressed = await f.create("accidental resurrection", "old selected\n", result);
  await assert.rejects(f.compose(regressed, [{ taskId: "selected", baseCommit: f.base, resultCommit: result }]),
    { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

test("lost selected mode is checked with content", async t => {
  const f = await fixture(t);
  await gitAt(f.sourceRoot, ["update-index", "--chmod=+x", "selection.txt"]);
  await gitAt(f.sourceRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "accepted mode"]);
  const result = await gitAt(f.sourceRoot, ["rev-parse", "HEAD"]);
  await gitAt(f.sourceRoot, ["update-index", "--chmod=-x", "selection.txt"]);
  await gitAt(f.sourceRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "rollback mode"]);
  const regressed = await gitAt(f.sourceRoot, ["rev-parse", "HEAD"]);
  await assert.rejects(f.compose(regressed, [{ taskId: "selected", baseCommit: f.base, resultCommit: result }]),
    { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

test("a real conflict does not hide lost clean lines elsewhere in its file", async t => {
  const f = await fixture(t);
  const original = "old\n" + "context\n".repeat(12) + "shared old\n";
  const selected = "accepted\n" + "context\n".repeat(12) + "shared accepted\n";
  await writeFile(path.join(f.sourceRoot, "selection.txt"), original);
  const taskBase = await commit(f.sourceRoot, "larger main");
  const result = await f.create("accepted separate changes", selected, taskBase);
  const regressed = await f.create("rollback clean line and alter shared area", "old\n" + "context\n".repeat(12) + "shared later\n", result);
  await assert.rejects(f.compose(regressed, [{ taskId: "selected", baseCommit: taskBase, resultCommit: result }]),
    error => error.code === "RELEASE_SELECTED_CONTENT_MISSING" && error.missingPaths.includes("selection.txt"));
});

test("whole conflicted file replacement cannot discard clean merged changes", async t => {
  const f = await fixture(t);
  const middle = "context\n".repeat(12);
  const body = (header, shared, footer) => `${header}\n${middle}${shared}\n${middle}${footer}\n`;
  await writeFile(path.join(f.sourceRoot, "selection.txt"), body("header old", "shared old", "footer old"));
  const base = await commit(f.sourceRoot, "conflict main");
  const a = await f.create("A", body("header A", "shared A", "footer old"), base);
  const b = await f.create("B", body("header old", "shared B", "footer B"), base);
  const tasks = [{ taskId: "A", baseCommit: base, resultCommit: a }, { taskId: "B", baseCommit: base, resultCommit: b }];
  let capture;
  await assert.rejects(f.compose(base, tasks), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT"); capture = error.conflictRoot; return true;
  });
  await writeFile(path.join(capture, "selection.txt"), body("header old", "shared B", "footer B"));
  await commit(capture, "incorrect whole-file side choice");
  await assert.rejects(f.compose(base, tasks), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
    && error.missingPaths.includes("selection.txt"));
  await writeFile(path.join(capture, "selection.txt"), body("header A", "shared A+B", "footer B"));
  await gitAt(capture, ["add", "."]);
  await gitAt(capture, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit"]);
  const correct = await f.compose(base, tasks);
  assert.equal(await gitAt(correct.root, ["show", "HEAD:selection.txt"]), body("header A", "shared A+B", "footer B").trim());
});

test("owned compatibility cleanup and completed prefix reopen need no review envelope", async t => {
  const f = await fixture(t);
  const original = "// top\n\n// middle\n\n// end\n";
  await writeFile(path.join(f.sourceRoot, "selection.txt"), original);
  const base = await commit(f.sourceRoot, "compat main");
  const a = await f.create("A", "// top\nfunction check() {}\n// middle\n\n// end\n", base);
  const b = await f.create("B", "// top\n\n// middle\nfunction check() {}\n// end\n", base);
  const tasks = [{ taskId: "A", baseCommit: base, resultCommit: a }, { taskId: "B", baseCommit: base, resultCommit: b }];
  const automatic = await f.compose(base, tasks);
  await writeFile(path.join(automatic.root, "selection.txt"), "// top\nfunction check() {}\n// middle\n\n// end\n");
  await gitAt(automatic.root, ["add", "."]);
  await gitAt(automatic.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit"]);
  const target = await gitAt(automatic.root, ["rev-parse", "HEAD"]);
  const value = await f.compose(base, tasks);
  assert.equal(value.head, target);
  assert.equal((await f.compose(base, tasks)).head, target);
  await assertNativePreparedComposition({ git: (args, options) => gitAt(value.root, args, options),
    baseCommit: base, tasks, merges: value.merges, head: target, tree: value.tree });
  // Historical messages remain inert metadata, including an unavailable old
  // receipt. Reopen still verifies the exact Git binding and selected code.
  const stateFile = path.join(f.root, "capture", "merge.json");
  const state = await readJson(stateFile);
  state.merges[1].reviewedResolution = { ...state.merges[1].resolution,
    review: { requestId: "historical-unavailable", text: "not an approval capability" } };
  delete state.merges[1].resolution;
  await writeJson(stateFile, state);
  assert.equal((await f.compose(base, tasks)).head, target);
  const unchanged = await readFile(stateFile);
  await assert.rejects(f.compose(base, tasks, { deliveredHead: target, identity: { foreign: true } }),
    { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  assert.deepEqual(await readFile(stateFile), unchanged);
  const changed = structuredClone(state);
  changed.merges[1].reviewedResolution.binding.tree = base;
  await writeJson(stateFile, changed);
  await assert.rejects(f.compose(base, tasks), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
});

test("an owned amendment cannot discard unique selected code", async t => {
  const f = await fixture(t);
  const result = await f.create("A", "unique selected implementation\n");
  const tasks = [{ taskId: "A", baseCommit: f.base, resultCommit: result }];
  const value = await f.compose(f.base, tasks);
  await writeFile(path.join(value.root, "selection.txt"), "old selected\n");
  await gitAt(value.root, ["add", "."]);
  await gitAt(value.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit"]);
  await assert.rejects(f.compose(f.base, tasks), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

test("owned conflict compatibility rejects cross-region removal credit for a selected addition", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, ".gitattributes"), "*.txt text eol=lf\n");
  const gap = name => Array.from({ length: 12 }, (_, i) => `${name} context ${i}\n`).join("");
  const body = (first, second, tail) => `${first}${gap("first")}${second}${gap("second")}${tail}\n`;
  await writeFile(path.join(f.sourceRoot, "selection.txt"), body("base clean\n", "implementation selected unique\n", "base shared"));
  const base = await commit(f.sourceRoot, "cross-region base");
  const a = await f.create("A", body("unique selected implementation\nbase clean\n", "implementation selected unique\n", "selected A"), base);
  const b = await f.create("B", body("base clean\n", "", "selected B"), base);
  const tasks = [{ taskId: "A", baseCommit: base, resultCommit: a }, { taskId: "B", baseCommit: base, resultCommit: b }];
  let repository;
  await assert.rejects(f.compose(base, tasks), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT"); repository = error.conflictRoot; return true;
  });
  const automatic = await readFile(path.join(repository, "selection.txt"), "utf8");
  assert.ok(automatic.startsWith("unique selected implementation\nbase clean\n"));
  assert.ok(!automatic.includes("implementation selected unique\n"));
  assert.ok(automatic.indexOf("unique selected implementation") < automatic.indexOf("<<<<<<< HEAD"));
  const lost = body("base clean\n", "", "selected A+B");
  await writeFile(path.join(repository, "selection.txt"), lost);
  const target = await commit(repository, "incorrectly lose A using unrelated B removals");
  const stateFile = path.join(f.root, "capture", "merge.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    const unchanged = await readFile(stateFile);
    await assert.rejects(f.compose(base, tasks), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
      && error.missingPaths.includes("selection.txt"));
    assert.deepEqual(await readFile(stateFile), unchanged);
    assert.equal(await gitAt(repository, ["rev-parse", "HEAD"]), target);
    assert.equal(await readFile(path.join(repository, "selection.txt"), "utf8"), lost);
  }
});

test("owned conflict compatibility edits retain their selected-content evidence on reopen", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, ".gitattributes"), "*.txt text eol=lf\n");
  const gap = Array.from({ length: 12 }, (_, i) => `stable context ${i}\n`).join("");
  const apiGap = Array.from({ length: 12 }, (_, i) => `API context ${i}\n`).join("");
  const body = (api, clean, shared) => `${api}\n${apiGap}${clean}\n${gap}${shared}\n`;
  await writeFile(path.join(f.sourceRoot, "selection.txt"), body("function provide(legacy) {}", "base clean", "base shared"));
  const base = await commit(f.sourceRoot, "compatibility base");
  const a = await f.create("A", body("function provide(legacy) {}", "uniqueCall(legacy)", "selected A"), base);
  const b = await f.create("B", body("function provide() {}", "base clean", "selected B"), base);
  const tasks = [{ taskId: "A", baseCommit: base, resultCommit: a }, { taskId: "B", baseCommit: base, resultCommit: b }];
  let repository;
  await assert.rejects(f.compose(base, tasks), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT"); repository = error.conflictRoot; return true;
  });
  const automatic = await readFile(path.join(repository, "selection.txt"), "utf8");
  assert.ok(automatic.startsWith("function provide() {}\n"));
  assert.ok(automatic.indexOf("\nuniqueCall(legacy)\n") > 0);
  assert.ok(automatic.indexOf("uniqueCall(legacy)") < automatic.indexOf("<<<<<<< HEAD\n"));
  await writeFile(path.join(repository, "selection.txt"), body("function provide() {}", "uniqueCall()", "selected A+B"));
  const head = await commit(repository, "combine selected API with its compatibility correction");
  const value = await f.compose(base, tasks);
  assert.equal(value.head, head);
  assert.equal(await gitAt(repository, ["show", "HEAD:selection.txt"]), body("function provide() {}", "uniqueCall()", "selected A+B").trim());
  assert.ok(value.merges[1].resolution.conflictPaths.includes("selection.txt"));
  const stateFile = path.join(f.root, "capture", "merge.json"), saved = await readFile(stateFile);
  assert.equal((await f.compose(base, tasks)).head, head);
  assert.deepEqual(await readFile(stateFile), saved);
  const foreignPath = path.join(repository, "foreign.txt");
  await writeFile(foreignPath, "unowned work must survive\n");
  await assert.rejects(f.compose(base, tasks), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  assert.equal(await readFile(foreignPath, "utf8"), "unowned work must survive\n");
  await rm(foreignPath);
  const input = { git: (args, options) => gitAt(repository, args, options), baseCommit: base, tasks,
    merges: value.merges, head, tree: value.tree, identity: { policy: NATIVE_RELEASE_POLICY, baseCommit: base, tasks } };
  await assertNativeMergedResults(input);
  const stale = structuredClone(value.merges); stale[1].resolution.binding.diffSha256 = "0".repeat(64);
  await assert.rejects(assertNativeMergedResults({ ...input, merges: stale }), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  const foreign = structuredClone(value.merges); foreign[1].commit = a;
  await assert.rejects(assertNativeMergedResults({ ...input, merges: foreign }), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  await assert.rejects(assertNativeMergedResults({ ...input, tasks: [tasks[0], { ...tasks[1], resultCommit: a }] }),
    /Prepared native result evidence changed/u);
  assert.deepEqual(await readFile(stateFile), saved);
});

for (const loss of ["delete", "restore-parent", "replace-novel", "shared-delete"]) test(`owned conflict compatibility cannot ${loss} unique clean selected code`, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, ".gitattributes"), "*.txt text eol=lf\n");
  const gap = Array.from({ length: 12 }, (_, i) => `stable context ${i}\n`).join("");
  const body = (clean, shared) => `${clean}${gap}${shared}\n`;
  await writeFile(path.join(f.sourceRoot, "selection.txt"), body("base clean\n", "base shared"));
  const base = await commit(f.sourceRoot, "loss base");
  const a = await f.create("A", body("unique selected implementation\n", "selected A"), base);
  const b = await f.create("B", body(loss === "shared-delete" ? "unique selected implementation\n" : "base clean\n", "selected B"), base);
  const tasks = [{ taskId: "A", baseCommit: base, resultCommit: a }, { taskId: "B", baseCommit: base, resultCommit: b }];
  let repository;
  await assert.rejects(f.compose(base, tasks), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT"); repository = error.conflictRoot; return true;
  });
  assert.match(await readFile(path.join(repository, "selection.txt"), "utf8"), /^unique selected implementation\n/u);
  const badClean = ["delete", "shared-delete"].includes(loss) ? "" : loss === "restore-parent" ? "base clean\n" : "novel unrelated compatibility code\n";
  await writeFile(path.join(repository, "selection.txt"), body(badClean, "selected A+B"));
  await commit(repository, "incorrect clean-context loss beside a real conflict resolution");
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(f.compose(base, tasks),
    error => error.code === "RELEASE_SELECTED_CONTENT_MISSING" && error.missingPaths.includes("selection.txt"));
});

test("an ordinary owned resolution may add a compatibility helper without a path approval", async t => {
  const f = await fixture(t);
  const a = await f.create("A", "selected A\n");
  const b = await f.create("B", "selected B\n");
  const tasks = [{ taskId: "A", baseCommit: f.base, resultCommit: a }, { taskId: "B", baseCommit: f.base, resultCommit: b }];
  let repository;
  await assert.rejects(f.compose(f.base, tasks), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT"); repository = error.conflictRoot; return true;
  });
  await writeFile(path.join(repository, "selection.txt"), "selected A+B\n");
  await writeFile(path.join(repository, "compatibility.mjs"), "export const combined = true;\n");
  const head = await commit(repository, "ordinary owned compatibility resolution");
  const value = await f.compose(f.base, tasks);
  assert.equal(value.head, head);
  assert.equal((await f.compose(f.base, tasks)).head, head);
  assert.equal(await gitAt(repository, ["show", "HEAD:compatibility.mjs"]), "export const combined = true;");
  await assertNativePreparedComposition({ git: (args, options) => gitAt(repository, args, options),
    baseCommit: f.base, tasks, merges: value.merges, head, tree: value.tree });
});

test("actual automatic context needs no signed replay-obligation waiver", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "registry.txt"), "base\n");
  const taskBase = await commit(f.sourceRoot, "Task base");
  const dependency = await f.create("dependency", "dependency context\n", taskBase);
  await f.create("dev context", "old selected\n", dependency);
  await writeFile(path.join(f.sourceRoot, "registry.txt"), "dev\n");
  const dev = await commit(f.sourceRoot, "dev context restoration");
  await gitAt(f.sourceRoot, ["checkout", "--detach", dependency]);
  await writeFile(path.join(f.sourceRoot, "feature.txt"), "own feature\n");
  await writeFile(path.join(f.sourceRoot, "registry.txt"), "selected\n");
  const result = await commit(f.sourceRoot, "selected feature");
  const tasks = [{ taskId: "selected", baseCommit: taskBase, resultCommit: result }];
  let repository;
  await assert.rejects(f.compose(dev, tasks), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT"); repository = error.conflictRoot; return true;
  });
  await writeFile(path.join(repository, "registry.txt"), "dev+selected\n");
  const head = await commit(repository, "ordinary registry union");
  const value = await f.compose(dev, tasks);
  assert.equal(value.head, head);
  assert.equal(await gitAt(repository, ["show", "HEAD:selection.txt"]), "old selected");
  assert.equal(await gitAt(repository, ["show", "HEAD:feature.txt"]), "own feature");
  await assertNativePreparedComposition({ git: (args, options) => gitAt(repository, args, options),
    baseCommit: dev, tasks, merges: value.merges, head, tree: value.tree });
  assert.equal((await f.compose(dev, tasks)).head, head);
});
