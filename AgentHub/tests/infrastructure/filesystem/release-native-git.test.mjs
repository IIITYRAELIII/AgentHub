import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

const execute = promisify(execFile);
async function git(root, ...args) {
  return String((await execute("git", args, { cwd: root, windowsHide: true })).stdout).trim();
}
async function commit(root, message) {
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ng-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, ".gitignore"), "private.txt\nprivate-dir/\n");
  await writeFile(path.join(primary, "shared.txt"), "first\nsecond\nthird\n");
  const base = await commit(primary, "main");
  await git(primary, "push", "origin", "main");
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "data") });
  const branches = new Map();
  const result = async (id, file, text, start = base) => {
    let folder = branches.get(id);
    if (!folder) {
      folder = path.join(root, id);
      await git(primary, "worktree", "add", "-b", id, folder, start);
      branches.set(id, folder);
    }
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await writeFile(path.join(folder, file), text);
    return { taskId: id, taskRevision: 1, baseCommit: base, resultCommit: await commit(folder, id) };
  };
  const request = (tasks, plan = "selected") => ({ projectRoot: primary,
    workspaceId: "fixture", planRevision: plan, approvedBaseCommit: base, frozenTasks: tasks });
  return { root, primary, base, service, result, request, branches };
}

test("reopen rejects a forged completed native prefix even with exact merge parents", { timeout: 60000 }, async t => {
  const f = await fixture(t), a = await f.result("A", "a.txt", "a\n");
  const root = path.join(f.root, "native");
  const request = { root, sourceRoot: f.primary, baseCommit: f.base, tasks: [a],
    identity: { selected: a.resultCommit },
    gitAt: (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd }),
    readJson: pathname => readFile(pathname, "utf8").then(JSON.parse, error => {
      if (error.code === "ENOENT") return null; throw error;
    }),
    writeJson: (pathname, value) => writeFile(pathname, JSON.stringify(value)),
  };
  const original = await mergeSelectedResults(request);
  const stateFile = path.join(root, "merge.json"), bytes = await readFile(stateFile);
  await writeFile(path.join(original.root, "foreign.txt"), "not selected\n");
  await git(original.root, "add", "foreign.txt");
  const tree = await git(original.root, "write-tree");
  const forged = (await execute("git", ["commit-tree", tree, "-p", f.base, "-p", a.resultCommit, "-m", "forged"], {
    cwd: original.root, windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@local.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@local.invalid" },
  })).stdout.trim();
  await git(original.root, "checkout", "--detach", forged);
  const state = JSON.parse(bytes); state.head = forged; state.merges[0].commit = forged;
  await writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(mergeSelectedResults(request), { code: "RELEASE_NATIVE_REVIEW_REQUIRED" });
  assert.equal(await git(original.root, "rev-parse", "HEAD"), forged);
  assert.equal(await readFile(path.join(original.root, "foreign.txt"), "utf8"), "not selected\n");
  await git(original.root, "checkout", "--detach", original.head);
  await writeFile(stateFile, bytes);
  assert.equal((await mergeSelectedResults(request)).head, original.head);
});

test("native merge selects exact independent main branches and complete corrections", async (t) => {
  const f = await fixture(t);
  const a = await f.result("A", "a.txt", "a1\n");
  const b = await f.result("B", "b.txt", "b1\n");
  const testOnly = await f.result("TestOnly", "not-selected.txt", "preview only\n");
  const candidate = await f.service.prepareCandidate(f.request([a, b]));
  assert.equal(candidate.manifest.compositionPolicy, "main-selected-git-merge-v1");
  assert.equal(candidate.manifest.merges.length, 2);
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:a.txt`), "a1");
  await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:not-selected.txt`));
  assert.notEqual(testOnly.resultCommit, candidate.preReleaseHead);
  for (const item of [a, b]) await git(candidate.releaseRoot, "merge-base", "--is-ancestor", item.resultCommit, candidate.preReleaseHead);
  const correction = await f.result("A", "another.txt", "second commit\n");
  correction.taskRevision = 2;
  const next = await f.service.prepareCandidate(f.request([correction, b], "correction"));
  assert.equal(await git(next.releaseRoot, "show", `${next.preReleaseHead}:a.txt`), "a1");
  assert.equal(await git(next.releaseRoot, "show", `${next.preReleaseHead}:another.txt`), "second commit");
  const taskRoot = f.branches.get("A");
  await git(taskRoot, "rm", "a.txt");
  await git(taskRoot, "mv", "another.txt", "moved.txt");
  await git(taskRoot, "update-index", "--chmod=+x", "moved.txt");
  const renamed = { ...correction, taskRevision: 3, resultCommit: await commit(taskRoot, "delete rename and mode correction") };
  const full = await f.service.prepareCandidate(f.request([renamed, b], "full-correction"));
  await assert.rejects(git(full.releaseRoot, "show", "PreRelease:a.txt"));
  await assert.rejects(git(full.releaseRoot, "show", "PreRelease:another.txt"));
  assert.equal(await git(full.releaseRoot, "show", "PreRelease:moved.txt"), "second commit");
  assert.match(await git(full.releaseRoot, "ls-tree", "PreRelease", "moved.txt"), /^100755 blob /u);
  const remaining = await f.service.prepareCandidate(f.request([b], "remove-A"));
  await assert.rejects(git(remaining.releaseRoot, "show", `${remaining.preReleaseHead}:a.txt`));
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
});

test("native transport retains exact selected objects imported without intermediate refs", { timeout: 60000 }, async t => {
  const f = await fixture(t), selected = await f.result("A", "a.txt", "selected exact result\n");
  const retainedRef = "refs/agent-hub/task-results/A";
  await git(f.primary, "update-ref", retainedRef, selected.resultCommit);
  // Only this disposable fixture's own temporary branch/worktree is removed.
  const taskRoot = f.branches.get("A");
  const relative = path.relative(f.root, taskRoot);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  await git(f.primary, "worktree", "remove", taskRoot);
  await git(f.primary, "branch", "-D", "A");
  const candidate = await f.service.prepareCandidate(f.request([selected]));
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:a.txt"), "selected exact result");
  await git(candidate.releaseRoot, "merge-base", "--is-ancestor", selected.resultCommit, candidate.preReleaseHead);
  assert.equal(await git(f.primary, "rev-parse", retainedRef), selected.resultCommit);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
});

test("joint file uses Git merge; conflict retains last candidate and normal resolution commit resumes", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.result("A", "shared.txt", "A\nsecond\nthird\n");
  const b = await f.result("B", "shared.txt", "B\nsecond\nthird\n");
  const prior = await f.service.prepareCandidate(f.request([a], "prior"));
  const checkpointFile = path.join(path.dirname(prior.releaseRoot), "checkpoint.json");
  const oldCheckpoint = await readFile(checkpointFile);
  let conflict;
  await assert.rejects(f.service.prepareCandidate(f.request([a, b])), (error) => {
    conflict = error;
    return error.code === "RELEASE_NATIVE_MERGE_CONFLICT";
  });
  assert.equal(await git(prior.releaseRoot, "rev-parse", "PreRelease"), prior.preReleaseHead);
  assert.deepEqual(await readFile(checkpointFile), oldCheckpoint);
  assert.equal(await git(conflict.conflictRoot, "rev-parse", "MERGE_HEAD"), b.resultCommit);
  await writeFile(path.join(conflict.conflictRoot, "shared.txt"), "resolved A+B\nsecond\nthird\n");
  const resolution = await commit(conflict.conflictRoot, "reviewed native resolution");
  const candidate = await f.service.prepareCandidate(f.request([a, b]));
  assert.equal(candidate.preReleaseHead, resolution);
  assert.equal(candidate.manifest.merges[1].resolved, true);
  assert.equal((await git(candidate.releaseRoot, "show", "-s", "--format=%P", resolution)).split(" ")[1], b.resultCommit);
});

test("foreign merge side and release-owned metadata require explicit migration", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const foreign = await f.result("Foreign", "foreign.txt", "unselected\n");
  const task = await f.result("Task", "own.txt", "own\n");
  await git(f.branches.get("Task"), "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
    "merge", "--no-ff", "--no-edit", foreign.resultCommit);
  task.resultCommit = await git(f.branches.get("Task"), "rev-parse", "HEAD");
  await assert.rejects(f.service.prepareCandidate(f.request([task])), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  const metadata = await f.result("Metadata", "CHANGELOG.md", "unauthorized notes\n");
  await assert.rejects(f.service.prepareCandidate(f.request([metadata])), /release-owned CHANGELOG/u);
});

test("native candidate refuses existing package version changes but accepts dependency edits", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.primary, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await writeFile(path.join(f.primary, "package-lock.json"), JSON.stringify({ version: "1.0.0",
    lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }));
  const base = await commit(f.primary, "existing package version");
  await git(f.primary, "push", "origin", "main");
  const request = task => ({ ...f.request([task]), approvedBaseCommit: base,
    frozenTasks: [{ ...task, baseCommit: base }] });
  const version = await f.result("Version", "package.json", JSON.stringify({ name: "fixture", version: "2.0.0" }), base);
  await assert.rejects(f.service.prepareCandidate(request(version)), /release-owned package-version metadata/u);
  const lock = await f.result("Lock", "package-lock.json", JSON.stringify({ version: "1.0.0", lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "2.0.0" } } }), base);
  await assert.rejects(f.service.prepareCandidate(request(lock)), /release-owned package-version metadata/u);
  const dependencies = await f.result("Dependencies", "package.json", JSON.stringify({ name: "fixture",
    version: "1.0.0", devDependencies: { fixture: "1.2.3" } }), base);
  const candidate = await f.service.prepareCandidate(request(dependencies));
  assert.equal(JSON.parse(await git(candidate.releaseRoot, "show", "PreRelease:package.json")).version, "1.0.0");
  assert.equal(JSON.parse(await git(candidate.releaseRoot, "show", "PreRelease:package.json")).devDependencies.fixture, "1.2.3");
});

test("native checkout preserves ignored private bytes and uses Git EOL", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.result("A", "a.txt", "first\r\nsecond\r\n");
  const prior = await f.service.prepareCandidate(f.request([a], "prior"));
  const privateBytes = Buffer.from([0, 9, 255, 42]);
  await writeFile(path.join(prior.releaseRoot, "private.txt"), privateBytes);
  const b = await f.result("B", "b.txt", "b\n");
  const next = await f.service.prepareCandidate(f.request([a, b]));
  assert.deepEqual(await readFile(path.join(next.releaseRoot, "private.txt")), privateBytes);
  assert.equal((await readFile(path.join(next.releaseRoot, "a.txt"))).toString(), "first\nsecond\n");
});

test("proven Task CAS refusal restores candidate through Git; unknown outcome retains original target", async (t) => {
  const f = await fixture(t);
  const a = await f.result("A", "a.txt", "a\n");
  const prior = await f.service.prepareCandidate(f.request([a], "prior"));
  const b = await f.result("B", "b.txt", "b\n");
  await assert.rejects(f.service.prepareCandidate({ ...f.request([a, b]), commitPrepared: async () => {
    throw new Error("definitive SQLite CAS refusal");
  } }), /definitive SQLite CAS refusal/u);
  assert.equal(await git(prior.releaseRoot, "rev-parse", "HEAD"), prior.preReleaseHead);
  assert.equal(await git(prior.releaseRoot, "rev-parse", "PreRelease"), prior.preReleaseHead);
  await assert.rejects(f.service.prepareCandidate({ ...f.request([a, b]), commitPrepared: async () => {
    throw Object.assign(new Error("lost SQLite response"), { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
  } }), { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
  const target = await git(prior.releaseRoot, "rev-parse", "PreRelease");
  assert.notEqual(target, prior.preReleaseHead);
  let commits = 0;
  const resumed = await f.service.prepareCandidate({ ...f.request([a, b]), commitPrepared: async () => { commits += 1; } });
  assert.equal(resumed.preReleaseHead, target);
  assert.equal(resumed.reused, true);
  assert.equal(commits, 1);
});

test("one-time native cutover retains exact old snapshot and original results", { timeout: 60000 }, async t => {
  const f = await fixture(t), a = await f.result("A", "a.txt", "a\n");
  const prior = await f.service.prepareCandidate(f.request([a], "legacy"));
  const checkpointFile = path.join(path.dirname(prior.releaseRoot), "checkpoint.json");
  const manifest = { ...prior.manifest };
  delete manifest.compositionPolicy;
  delete manifest.merges;
  // A retained pre-cutover checkpoint has no native policy marker. Its original
  // content, exact Task identity and raw serialization are migration inputs.
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from(JSON.stringify(manifest) + "\n");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const manifestFile = path.join(path.dirname(prior.manifestFile), `${hash}.json`);
  await writeFile(manifestFile, bytes);
  const checkpoint = { ...(JSON.parse(await readFile(checkpointFile, "utf8"))), manifestHash: hash, manifestFile };
  delete checkpoint.compositionPolicy;
  const oldCheckpoint = Buffer.from(JSON.stringify(checkpoint) + "\n");
  await writeFile(checkpointFile, oldCheckpoint);
  const b = await f.result("B", "b.txt", "b\n");
  const next = await f.service.prepareCandidate(f.request([a, b], "native-cutover"));
  assert.deepEqual(Buffer.from(next.manifest.cutover.checkpointBytesBase64, "base64"), oldCheckpoint);
  assert.deepEqual(Buffer.from(next.manifest.cutover.manifestBytesBase64, "base64"), bytes);
  assert.deepEqual(next.manifest.cutover.originalTasks, manifest.tasks);
  assert.equal(await git(next.releaseRoot, "rev-parse", next.manifest.cutover.retainedRef), prior.preReleaseHead);
  const reused = await f.service.prepareCandidate(f.request([a, b], "native-cutover"));
  assert.equal(reused.preReleaseHead, next.preReleaseHead);
  assert.deepEqual(reused.manifest.cutover, next.manifest.cutover);
  assert.deepEqual(await readFile(manifestFile), bytes);
});

test("immutable generation promotion uses native checkout and preserves private collision", { timeout: 120000 }, async t => {
  const f = await fixture(t), a = await f.result("A", "a.txt", "a\n");
  const prior = await f.service.prepareCandidate(f.request([a], "prior"));
  await f.result("B", "b.txt", "b\n");
  const folder = f.branches.get("B");
  await writeFile(path.join(folder, "private.txt"), "selected bytes\n");
  await git(folder, "add", "-f", "private.txt");
  const b = { taskId: "B", taskRevision: 1, baseCommit: f.base, resultCommit: await commit(folder, "tracked private-name path") };
  const generation = await f.service.prepareGeneration({ ...f.request([a, b], "generation"),
    operationId: "release-original", generation: 1, freezePublication: false });
  const foreign = Buffer.from([0, 255, 7]);
  await writeFile(path.join(prior.releaseRoot, "private.txt"), foreign);
  const checkpointFile = path.join(path.dirname(prior.releaseRoot), "checkpoint.json");
  const checkpoint = await readFile(checkpointFile);
  await assert.rejects(f.service.promoteGenerationCandidate({ projectRoot: f.primary, candidate: generation }));
  assert.deepEqual(await readFile(path.join(prior.releaseRoot, "private.txt")), foreign);
  assert.equal(await git(prior.releaseRoot, "rev-parse", "PreRelease"), prior.preReleaseHead);
  assert.deepEqual(await readFile(checkpointFile), checkpoint);
  await rm(path.join(prior.releaseRoot, "private.txt"));
  const result = await f.service.promoteGenerationCandidate({ projectRoot: f.primary, candidate: generation });
  assert.equal(result.preReleaseHead, generation.preReleaseHead);
  assert.equal(await git(result.releaseRoot, "show", "PreRelease:private.txt"), "selected bytes");
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
});

test("generation promotion reopens its original target after lost SQLite response without another Git CAS", { timeout: 120000 }, async t => {
  const f = await fixture(t), a = await f.result("A", "a.txt", "a\n");
  const prior = await f.service.prepareCandidate(f.request([a], "prior"));
  const b = await f.result("B", "b.txt", "b\n");
  const candidate = await f.service.prepareGeneration({ ...f.request([a, b], "generation"),
    operationId: "release-original", generation: 1, freezePublication: false });
  await assert.rejects(f.service.promoteGenerationCandidate({ projectRoot: f.primary, candidate,
    commitPrepared: async () => { throw Object.assign(new Error("lost SQL response"), { code: "AWAIT_ACCEPTANCE_UNKNOWN" }); },
  }), { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
  const reflog = await git(prior.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  assert.equal(await git(prior.releaseRoot, "rev-parse", "PreRelease"), candidate.preReleaseHead);
  const reopened = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data") });
  let terminals = 0;
  const completed = await reopened.promoteGenerationCandidate({ projectRoot: f.primary, candidate,
    commitPrepared: async () => { terminals += 1; },
  });
  assert.equal(completed.preReleaseHead, candidate.preReleaseHead);
  assert.equal(terminals, 1);
  assert.equal(await git(prior.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
});

test("publication generation refuses stale prepared head result and base", { timeout: 120_000 }, async t => {
  const f = await fixture(t), a = await f.result("A", "a.txt", "accepted\n");
  const prepared = await f.service.prepareCandidate(f.request([a]));
  const checkpointFile = path.join(path.dirname(prepared.releaseRoot), "checkpoint.json");
  const checkpoint = await readFile(checkpointFile);
  const request = { ...f.request([a]), operationId: "prepared-original", generation: 1 };
  await assert.rejects(f.service.prepareGeneration({ ...request, planRevision: "stale" }),
    { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  const notes = path.join(prepared.releaseRoot, "CHANGELOG.md");
  await writeFile(notes, "prepared notes\n");
  await assert.rejects(f.service.prepareGeneration({ ...request, changelogContent: Buffer.from("foreign notes\n") }),
    { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  const foreign = path.join(prepared.releaseRoot, "foreign.txt");
  await writeFile(foreign, "unbound source bytes\n");
  await assert.rejects(f.service.prepareGeneration({ ...request, changelogContent: Buffer.from("prepared notes\n") }),
    { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  await rm(foreign); await rm(notes);
  const corrected = await f.result("A", "a.txt", "corrected\n");
  await assert.rejects(f.service.prepareGeneration({ ...request, frozenTasks: [corrected] }),
    { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  await git(prepared.releaseRoot, "update-ref", "refs/heads/PreRelease", a.resultCommit, prepared.preReleaseHead);
  await assert.rejects(f.service.prepareGeneration(request), { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  await git(prepared.releaseRoot, "update-ref", "refs/heads/PreRelease", prepared.preReleaseHead, a.resultCommit);
  await writeFile(path.join(f.primary, "new-main.txt"), "new agreed base\n");
  const newBase = await commit(f.primary, "advance main in private fixture");
  await assert.rejects(f.service.prepareGeneration({ ...request, approvedBaseCommit: newBase }),
    { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  assert.deepEqual(await readFile(checkpointFile), checkpoint);
  assert.equal(await git(prepared.releaseRoot, "rev-parse", "HEAD"), prepared.preReleaseHead);
  assert.equal(await git(prepared.releaseRoot, "show", "HEAD:a.txt"), "accepted");
});
