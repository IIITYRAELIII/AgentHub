import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { taskGitIdentityHash } from "../../../src/domain/task-git-reference.mjs";
import { assertNativePreparedComposition, mergeSelectedResults, NATIVE_RELEASE_POLICY }
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
  await assert.rejects(f.compose(base, tasks), error => error.code === "RELEASE_NATIVE_REVIEW_REQUIRED"
    && error.extraPaths.includes("selection.txt"));
  await writeFile(path.join(capture, "selection.txt"), body("header A", "shared A+B", "footer B"));
  await gitAt(capture, ["add", "."]);
  await gitAt(capture, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit"]);
  const correct = await f.compose(base, tasks);
  assert.equal(await gitAt(correct.root, ["show", "HEAD:selection.txt"]), body("header A", "shared A+B", "footer B").trim());
});

test("exact authenticated compatibility cleanup remains valid", async t => {
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
  const identity = { policy: NATIVE_RELEASE_POLICY, baseCommit: base, tasks };
  const binding = { identityHash: taskGitIdentityHash(identity),
    parents: (await gitAt(automatic.root, ["show", "-s", "--format=%P", target])).split(" "),
    commit: target, tree: await gitAt(automatic.root, ["rev-parse", "HEAD^{tree}"]), automaticTree: automatic.tree,
    diffSha256: createHash("sha256").update(await gitAt(automatic.root,
      ["diff", "--binary", "--full-index", "--no-renames", automatic.tree, "HEAD^{tree}"], { rawOutput: true })).digest("hex") };
  const review = { requestId: "independent", text: `<native-merge-review>${JSON.stringify({kind:"native-merge-review-v1",verdict:"ACCEPT",binding})}</native-merge-review>` };
  let verified = 0;
  const verifyReview = async (input, actual) => { assert.deepEqual(input, review); assert.deepEqual(actual, binding); verified++; };
  const value = await f.compose(base, tasks, { resolutionReview: review, verifyReview });
  assert.equal(value.head, target); assert.ok(verified > 0);
  await assertNativePreparedComposition({ git: (args, options) => gitAt(value.root, args, options),
    baseCommit: base, tasks, merges: value.merges, head: target, tree: binding.tree, identity, verifyReview });
});
