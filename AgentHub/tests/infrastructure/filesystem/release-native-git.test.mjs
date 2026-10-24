import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
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
async function fixture(t, { versioned = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ng-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, ".gitignore"), "private.txt\nprivate-dir/\n");
  await writeFile(path.join(primary, "shared.txt"), "first\nsecond\nthird\n");
  if (versioned) {
    await mkdir(path.join(primary, "AgentHub"));
    await writeFile(path.join(primary, "AgentHub/package.json"), JSON.stringify({ name: "agent-hub", version: "2026.10.12" }));
    await writeFile(path.join(primary, "AgentHub/package-lock.json"), JSON.stringify({ name: "agent-hub", version: "2026.10.12", packages: { "": { name: "agent-hub", version: "2026.10.12" } } }));
  }
  const base = await commit(primary, "main");
  await git(primary, "push", "origin", "main");
  const environment = { ...process.env, LOCALAPPDATA: path.join(root, "state"), XDG_STATE_HOME: path.join(root, "state") };
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "data"), environment });
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
  return { root, primary, base, service, result, request, branches, environment };
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

test("native runtime closure does not impose Agent Hub readiness on an unrelated repository", async t => {
  const f = await fixture(t);
  const selected = await f.result("OtherProduct", "AgentHub/other.mjs", 'import "./not-a-runtime-module.mjs";\n');
  const candidate = await f.service.prepareCandidate(f.request([selected]));
  assert.equal(await git(candidate.releaseRoot, "show", "HEAD:AgentHub/other.mjs"),
    'import "./not-a-runtime-module.mjs";');
  assert.equal(candidate.manifest.tasks[0].resultCommit, selected.resultCommit);
  assert.equal(await git(f.primary, "rev-parse", "HEAD"), f.base);
  assert.equal(await git(f.primary, "status", "--porcelain=v1"), "");
});

test("one native sequencer call consumes reviewed resolutions and reopens a lost journal reply", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const a = await f.result("A", "shared.txt", "selected A\n");
  const b = await f.result("B", "shared.txt", "selected B\n");
  await writeFile(path.join(f.primary, "shared.txt"), "new accepted main\n");
  const baseCommit = await commit(f.primary, "new main");
  const tasks = [a, b], identity = { baseCommit, tasks };
  const proofRoot = path.join(f.root, "proof"), bindings = new Map();
  const readJson = pathname => readFile(pathname, "utf8").then(JSON.parse, error => {
    if (error.code === "ENOENT") return null; throw error;
  });
  const writeJson = (pathname, value) => writeFile(pathname, JSON.stringify(value));
  const request = { root: proofRoot, sourceRoot: f.primary, baseCommit, tasks, identity,
    gitAt: (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd }), readJson, writeJson,
    verifyReview: async (review, binding) => bindings.set(review.requestId, binding) };
  await assert.rejects(mergeSelectedResults(request), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  for (const [index, task] of tasks.entries()) {
    await writeFile(path.join(proofRoot, "repository", "shared.txt"), `reviewed ${task.taskId}\n`);
    await commit(path.join(proofRoot, "repository"), `resolve ${task.taskId}`);
    const result = mergeSelectedResults({ ...request,
      resolutionReview: { requestId: `review-${task.taskId}`, text: "reviewed exact result" } });
    if (index === 0) await assert.rejects(result, { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
    else await result;
  }
  const proof = await readJson(path.join(proofRoot, "merge.json"));
  const bundlePath = path.join(f.root, "reviewed.bundle");
  await git(path.join(proofRoot, "repository"), "update-ref", "refs/heads/accepted", proof.head);
  await git(path.join(proofRoot, "repository"), "bundle", "create", bundlePath, "refs/heads/accepted");
  const reviews = [...bindings].map(([requestId, binding]) => ({ requestId,
    text: `<native-merge-review>${JSON.stringify({ kind: "native-merge-review-v1", verdict: "ACCEPT", binding })}</native-merge-review>` }));
  const resolutionReview = { bundlePath,
    bundleSha256: createHash("sha256").update(await readFile(bundlePath)).digest("hex"), reviews };
  let loseReply = true, loseAbortReply = true;
  const actual = { ...request, root: path.join(f.root, "actual"), resolutionReview,
    gitAt: async (cwd, args, options = {}) => {
      const result = await runTaskGitCommand(args, { ...options, cwd });
      if (loseAbortReply && args[0] === "merge" && args[1] === "--abort") {
        loseAbortReply = false;
        throw new Error("lost conflict abort reply");
      }
      return result;
    },
    verifyReview: async (review, binding) => {
      const declaration = JSON.parse(/<native-merge-review>([^]*?)<\/native-merge-review>/u.exec(review.text)[1]);
      assert.deepEqual(declaration.binding, binding);
    },
    writeJson: async (pathname, value) => {
      if (loseReply && value.next === 1 && value.merging === false) {
        loseReply = false;
        throw new Error("lost journal reply after reviewed checkout");
      }
      await writeJson(pathname, value);
    } };
  await assert.rejects(mergeSelectedResults({ ...actual, resolutionReview: null }), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  const issued = path.join(actual.root, "repository", "shared.txt");
  const untouched = await readFile(issued);
  await writeFile(issued, "executor unfinished resolution\n");
  await assert.rejects(mergeSelectedResults(actual), /unsaved executor resolution/u);
  assert.equal(await readFile(issued, "utf8"), "executor unfinished resolution\n");
  await writeFile(issued, untouched);
  await assert.rejects(mergeSelectedResults(actual), /lost conflict abort reply/u);
  assert.equal(await git(path.join(actual.root, "repository"), "rev-parse", "HEAD"), baseCommit);
  assert.equal((await readJson(path.join(actual.root, "merge.json"))).conflict.reviewedResolution.binding.commit, proof.merges[0].commit);
  await assert.rejects(mergeSelectedResults(actual), /lost journal reply/u);
  const interrupted = await readJson(path.join(actual.root, "merge.json"));
  assert.equal(interrupted.next, 0);
  assert.equal(interrupted.merging, true);
  assert.equal(await git(path.join(actual.root, "repository"), "rev-parse", "HEAD"), proof.merges[0].commit);
  const completed = await mergeSelectedResults(actual);
  assert.equal(completed.head, proof.head);
  assert.equal(completed.tree, await git(path.join(proofRoot, "repository"), "rev-parse", "HEAD^{tree}"));
  assert.equal(completed.merges.length, 2);
  const reflog = await git(completed.root, "reflog", "--format=%H");
  assert.equal((await mergeSelectedResults(actual)).head, completed.head);
  assert.equal(await git(completed.root, "reflog", "--format=%H"), reflog);
  const tampered = { ...actual, resolutionReview: { ...resolutionReview, bundleSha256: "0".repeat(64) } };
  await assert.rejects(mergeSelectedResults(tampered), /digest changed/u);
  assert.equal(await git(completed.root, "reflog", "--format=%H"), reflog);
  assert.equal(await git(f.primary, "rev-parse", "HEAD"), baseCommit);
});

test("normal publication generation prepares its candidate without a separate prepare command", { timeout: 120000 }, async t => {
  const f = await fixture(t, { versioned: true }), a = await f.result("A", "a.txt", "accepted\n");
  const request = { ...f.request([a]), operationId: "one-command", generation: 1 };
  const generated = await f.service.prepareGeneration(request);
  assert.equal(generated.manifest.tasks[0].resultCommit, a.resultCommit);
  const reflog = await git(generated.releaseRoot, "reflog", "show", "PreRelease");
  const reopened = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data"), environment: f.environment });
  assert.equal((await reopened.prepareGeneration(request)).preReleaseHead, generated.preReleaseHead);
  assert.equal(await git(generated.releaseRoot, "reflog", "show", "PreRelease"), reflog);
  assert.equal(await git(f.primary, "rev-parse", "HEAD"), f.base);
});

test("native merge selects exact independent main branches and complete corrections", { timeout: 60000 }, async (t) => {
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

test("proven Task CAS refusal restores candidate through Git; unknown outcome retains original target", { timeout: 60000 }, async (t) => {
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

test("publication generation resumes its exact materialized notes before freeze intent", { timeout: 120_000 }, async t => {
  const f = await fixture(t, { versioned: true }), a = await f.result("A", "a.txt", "accepted\n");
  const prepared = await f.service.prepareCandidate(f.request([a]));
  const notes = Buffer.from("exact consolidated release notes\n");
  const operationId = "original-materialized-notes";
  const key = createHash("sha256").update(`${operationId}:1:${f.primary}`).digest("hex").slice(0, 24);
  const generationRoot = path.join(f.root, "data", "release-gens", key);
  const repositoryKey = path.basename(path.dirname(prepared.releaseRoot));
  const repository = path.join(generationRoot, "release-repositories", repositoryKey, "repository");
  const notesFile = path.join(repository, "CHANGELOG.md");
  const checkpointFile = path.join(path.dirname(repository), "checkpoint.json");
  const request = { ...f.request([a]), operationId, generation: 1, changelogContent: notes };
  await assert.rejects(f.service.prepareGeneration({ ...request, validateBeforeCommit: async () => {
    const content = await readFile(notesFile).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (content?.equals(notes)) throw new Error("controlled refusal after notes materialization before freeze intent");
  } }), /controlled refusal after notes materialization/u);
  const checkpoint = await readFile(checkpointFile);
  assert.equal(JSON.parse(checkpoint).phase, "prepared");
  assert.equal(JSON.parse(checkpoint).publicationFreeze, undefined);
  assert.deepEqual(await readFile(notesFile), notes);
  const beforeHead = await git(repository, "rev-parse", "HEAD");
  const beforeReflog = await git(repository, "reflog", "show", "--format=%H", "PreRelease");
  const reopened = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data"), environment: f.environment });
  await assert.rejects(reopened.prepareGeneration({ ...request, changelogContent: Buffer.from("different request\n") }),
    { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  const foreign = Buffer.from("foreign physical notes\n");
  await writeFile(notesFile, foreign);
  await assert.rejects(reopened.prepareGeneration(request), /exact clean PreRelease/u);
  assert.deepEqual(await readFile(notesFile), foreign);
  assert.deepEqual(await readFile(checkpointFile), checkpoint);
  await writeFile(notesFile, notes);
  const extra = path.join(repository, "foreign.txt");
  await writeFile(extra, "unbound bytes\n");
  await assert.rejects(reopened.prepareGeneration(request), /exact clean PreRelease/u);
  assert.equal(await readFile(extra, "utf8"), "unbound bytes\n");
  assert.equal(await git(repository, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(repository, "reflog", "show", "--format=%H", "PreRelease"), beforeReflog);
  await rm(extra);
  const result = await reopened.prepareGeneration(request);
  assert.deepEqual(await readFile(notesFile), notes);
  assert.equal(result.checkpointPhase, "frozen");
  const finalReflog = await git(repository, "reflog", "show", "--format=%H", "PreRelease");
  assert.equal((await reopened.prepareGeneration(request)).preReleaseHead, result.preReleaseHead);
  assert.equal(await git(repository, "reflog", "show", "--format=%H", "PreRelease"), finalReflog);
  assert.equal(await git(f.primary, "rev-parse", "HEAD"), f.base);
  assert.equal(await git(prepared.releaseRoot, "rev-parse", "HEAD"), prepared.preReleaseHead);
});

test("publication generation retains dirty preparation and binds its immutable input after correction", { timeout: 120_000 }, async t => {
  const f = await fixture(t, { versioned: true }), a = await f.result("A", "a.txt", "accepted\n");
  const prepared = await f.service.prepareCandidate(f.request([a]));
  const checkpointFile = path.join(path.dirname(prepared.releaseRoot), "checkpoint.json");
  const checkpoint = await readFile(checkpointFile);
  const request = { ...f.request([a]), operationId: "prepared-original", generation: 1 };
  const foreign = path.join(prepared.releaseRoot, "foreign.txt");
  await writeFile(foreign, "unbound source bytes\n");
  await assert.rejects(f.service.prepareGeneration(request), /Native release checkout changed; foreign bytes retained/u);
  assert.equal(await readFile(foreign, "utf8"), "unbound source bytes\n");
  assert.deepEqual(await readFile(checkpointFile), checkpoint);
  await rm(foreign);
  const frozen = await f.service.prepareGeneration(request);
  const frozenReflog = await git(frozen.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  for (const changed of [{ planRevision: "stale" }, { changelogContent: Buffer.from("foreign notes\n") },
    { approvedBaseCommit: a.resultCommit }]) {
    await assert.rejects(f.service.prepareGeneration({ ...request, ...changed }), { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  }
  const corrected = await f.result("A", "a.txt", "corrected\n");
  await assert.rejects(f.service.prepareGeneration({ ...request, frozenTasks: [corrected] }),
    { code: "RELEASE_PREPARED_CANDIDATE_STALE" });
  // A frozen generation owns its own bytes, independently of later preparation.
  await writeFile(foreign, "later preparation WIP\n");
  assert.equal((await f.service.prepareGeneration(request)).preReleaseHead, frozen.preReleaseHead);
  assert.equal(await readFile(foreign, "utf8"), "later preparation WIP\n");
  assert.equal(await git(frozen.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), frozenReflog);
  assert.equal(await git(f.primary, "rev-parse", "HEAD"), f.base);
});
