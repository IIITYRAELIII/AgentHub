import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskIntegrationGitService } from "../../../src/infrastructure/filesystem/task-integration-git.mjs";
import { assertNativePreparedComposition, mergeSelectedResults, NATIVE_RELEASE_POLICY }
  from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";


import { withTaskOperationTiming, measureTaskOperation, createTaskOperationTimingBatchRecorder }
  from "../../../src/infrastructure/process/task-operation-timing.mjs";

const execute = promisify(execFile);
async function git(root, ...args) {
  return measureTaskOperation("fixture:git", async () => String((await execute("git", args, { cwd: root, windowsHide: true })).stdout).trim(), { detail: true });
}
async function commit(root, message) {
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
async function fixture(t, { versioned = false, publicVersion = "2026.10.12", joinOwnedWork = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ng-"));
  t.after(async () => {
    await joinOwnedWork?.();
    await rm(root, { recursive: true, force: true });
  });
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, ".gitignore"), "private.txt\nprivate-dir/\n");
  await writeFile(path.join(primary, "shared.txt"), "first\nsecond\nthird\n");
  if (versioned) {
    await mkdir(path.join(primary, "AgentHub"));
    await writeFile(path.join(primary, "AgentHub/package.json"), JSON.stringify({ name: "agent-hub", version: publicVersion }));
    await writeFile(path.join(primary, "AgentHub/package-lock.json"), JSON.stringify({ name: "agent-hub", version: publicVersion, packages: { "": { name: "agent-hub", version: publicVersion } } }));
  }
  const base = await commit(primary, "main");
  await git(primary, "push", "origin", "main");
  const environment = { ...process.env, LOCALAPPDATA: path.join(root, "state"), XDG_STATE_HOME: path.join(root, "state") };
  const service = new TaskIntegrationGitService({ dataDir: path.join(root, "data"), environment });
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

test("reopen rejects a forged completed native prefix even with exact merge parents", async t => {
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
  await assert.rejects(mergeSelectedResults(request), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
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

test("ordinary issued resolutions survive a lost journal reply without review inputs", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "shared.txt", "selected A\n");
  const b = await f.result("B", "shared.txt", "selected B\n");
  const root = path.join(f.root, "issued");
  const request = { root, sourceRoot: f.primary, baseCommit: f.base, tasks: [a, b], identity: { tasks: [a, b] },
    gitAt: (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd }),
    readJson: pathname => readFile(pathname, "utf8").then(JSON.parse, error => {
      if (error.code === "ENOENT") return null; throw error;
    }), writeJson: (pathname, value) => writeFile(pathname, JSON.stringify(value)) };
  await assert.rejects(mergeSelectedResults(request), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  const repository = path.join(root, "repository");
  await writeFile(path.join(repository, "shared.txt"), "selected A+B\n");
  const head = await commit(repository, "owned union");
  let lost = false;
  const interrupt = { ...request, writeJson: async (pathname, value) => {
    if (!lost && value.next === 2) { lost = true; throw Error("lost journal reply"); }
    return request.writeJson(pathname, value);
  } };
  await assert.rejects(mergeSelectedResults(interrupt), /lost journal reply/u);
  const value = await mergeSelectedResults(request);
  assert.equal(value.head, head);
  assert.equal((await mergeSelectedResults(request)).head, head);
  assert.equal(await git(repository, "show", "HEAD:shared.txt"), "selected A+B");
  const before = await readFile(path.join(root, "merge.json"));
  await assert.rejects(mergeSelectedResults({ ...request, identity: { foreign: true } }),
    { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  assert.deepEqual(await readFile(path.join(root, "merge.json")), before);
});







test("native merge selects exact independent main branches and complete corrections", { timeout: 60000 }, async (t) => {
  let ownedWork;
  ownedWork = withTaskOperationTiming({ operationId: "native-independent-corrections", taskId: "fixture",
    record: createTaskOperationTimingBatchRecorder(events => console.info(JSON.stringify(events))) }, async () => {
    const f = await measureTaskOperation("fixture:setup", () => fixture(t, { joinOwnedWork: () => ownedWork.catch(() => {}) }));
    const a = await measureTaskOperation("fixture:branch-A", () => f.result("A", "a.txt", "a1\n"));
    const b = await measureTaskOperation("fixture:branch-B", () => f.result("B", "b.txt", "b1\n"));
    const testOnly = await measureTaskOperation("fixture:branch-TestOnly", () => f.result("TestOnly", "not-selected.txt", "preview only\n"));
    const candidate = await measureTaskOperation("fixture:prepare-initial", () => f.service.prepareCandidate(f.request([a, b])));
    assert.equal(candidate.manifest.compositionPolicy, "main-selected-git-merge-v1");
    assert.equal(candidate.manifest.merges.length, 2);
    assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:a.txt`), "a1");
    await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:not-selected.txt`));
    assert.notEqual(testOnly.resultCommit, candidate.preReleaseHead);
    for (const item of [a, b]) await git(candidate.releaseRoot, "merge-base", "--is-ancestor", item.resultCommit, candidate.preReleaseHead);
    const correction = await measureTaskOperation("fixture:correct-A", () => f.result("A", "another.txt", "second commit\n"));
    correction.taskRevision = 2;
    const next = await measureTaskOperation("fixture:prepare-correction", () => f.service.prepareCandidate(f.request([correction, b], "correction")));
    assert.equal(await git(next.releaseRoot, "show", `${next.preReleaseHead}:a.txt`), "a1");
    assert.equal(await git(next.releaseRoot, "show", `${next.preReleaseHead}:another.txt`), "second commit");
    const taskRoot = f.branches.get("A");
    await git(taskRoot, "rm", "a.txt");
    await git(taskRoot, "mv", "another.txt", "moved.txt");
    await git(taskRoot, "update-index", "--chmod=+x", "moved.txt");
    const renamed = { ...correction, taskRevision: 3, resultCommit: await commit(taskRoot, "delete rename and mode correction") };
    const full = await measureTaskOperation("fixture:prepare-rename-delete-mode", () => f.service.prepareCandidate(f.request([renamed, b], "full-correction")));
    await assert.rejects(git(full.releaseRoot, "show", "PreRelease:a.txt"));
    await assert.rejects(git(full.releaseRoot, "show", "PreRelease:another.txt"));
    assert.equal(await git(full.releaseRoot, "show", "PreRelease:moved.txt"), "second commit");
    assert.match(await git(full.releaseRoot, "ls-tree", "PreRelease", "moved.txt"), /^100755 blob /u);
    const remaining = await measureTaskOperation("fixture:prepare-removal", () => f.service.prepareCandidate(f.request([b], "remove-A")));
    await assert.rejects(git(remaining.releaseRoot, "show", `${remaining.preReleaseHead}:a.txt`));
    assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
  });
  return await ownedWork;
});

test("native transport retains exact selected objects imported without intermediate refs", async t => {
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

test("joint file uses Git merge; conflict retains last candidate and normal resolution commit resumes", async (t) => {
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

test("a foreign merge side still requires explicit migration", async (t) => {
  const f = await fixture(t);
  const foreign = await f.result("Foreign", "foreign.txt", "unselected\n");
  const task = await f.result("Task", "own.txt", "own\n");
  await git(f.branches.get("Task"), "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
    "merge", "--no-ff", "--no-edit", foreign.resultCommit);
  task.resultCommit = await git(f.branches.get("Task"), "rev-parse", "HEAD");
  await assert.rejects(f.service.prepareCandidate(f.request([task])), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
});

test("PreRelease keeps the destination changelog on edit, deletion and addition", async t => {
  const f = await fixture(t);
  const added = await f.result("Added", "CHANGELOG.md", "task notes without an existing file\n");
  const withoutNotes = await f.service.prepareCandidate(f.request([added], "without-notes"));
  assert.equal(await git(withoutNotes.releaseRoot, "ls-tree", "PreRelease", "--", "CHANGELOG.md"), "");
  await writeFile(path.join(f.primary, "CHANGELOG.md"), "old published notes\n");
  const old = await commit(f.primary, "old publication");
  const edit = await f.result("Edited", "CHANGELOG.md", "task notes from the old base\n", old);
  edit.resultCommit = (await f.result("Edited", "selected.txt", "selected work\n", old)).resultCommit;
  const deletion = await f.result("Deleted", "other.txt", "other work\n", old);
  const deletionRoot = f.branches.get("Deleted");
  await git(deletionRoot, "rm", "--", "CHANGELOG.md");
  deletion.resultCommit = await commit(deletionRoot, "remove old notes in task");
  await writeFile(path.join(f.primary, "CHANGELOG.md"), "current release notes\n");
  const published = await commit(f.primary, "current publication");
  await git(f.primary, "push", "origin", "main");

  const request = { ...f.request([edit, deletion], "current-notes"), approvedBaseCommit: published };
  const result = await f.service.prepareCandidate(request);
  assert.equal(await git(result.releaseRoot, "show", "PreRelease:CHANGELOG.md"), "current release notes");
  assert.equal(await git(result.releaseRoot, "show", "PreRelease:selected.txt"), "selected work");
  assert.equal(await git(result.releaseRoot, "show", "PreRelease:other.txt"), "other work");
  assert.deepEqual(Object.fromEntries(result.manifest.tasks.map(task => [task.taskId, task.resultCommit])),
    { [edit.taskId]: edit.resultCommit, [deletion.taskId]: deletion.resultCommit });
  assert.equal((await f.service.prepareCandidate(request)).preReleaseHead, result.preReleaseHead);
  assert.equal(await git(f.branches.get("Edited"), "show", "HEAD:CHANGELOG.md"), "task notes from the old base");
});

test("native Task merges retain destination notes after interruption and keep real conflicts", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.primary, "CHANGELOG.md"), "initial\n");
  const old = await commit(f.primary, "original notes");
  const task = await f.result("OwnNotes", "CHANGELOG.md", "task change\n", old);
  task.resultCommit = (await f.result("OwnNotes", "selected.txt", "accepted content\n", old)).resultCommit;
  const conflicting = await f.result("OtherConflict", "CHANGELOG.md", "other task notes\n", old);
  conflicting.resultCommit = (await f.result("OtherConflict", "shared.txt", "task conflict\n", old)).resultCommit;
  await writeFile(path.join(f.primary, "CHANGELOG.md"), "published\n");
  await writeFile(path.join(f.primary, "shared.txt"), "published content\n");
  const baseCommit = await commit(f.primary, "published notes and code");
  const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });
  const readJson = pathname => readFile(pathname, "utf8").then(JSON.parse, error => {
    if (error.code === "ENOENT") return null; throw error;
  });
  const writeJson = (pathname, value) => writeFile(pathname, JSON.stringify(value));
  const request = (policy, tasks) => ({ root: path.join(f.root, policy), sourceRoot: f.primary,
    baseCommit, tasks, identity: { policy, baseCommit, tasks }, gitAt, readJson, writeJson });

  const dev = request("native-dev-merge-v1", [task]);
  let interrupted = false;
  await assert.rejects(mergeSelectedResults({ ...dev, gitAt: async (cwd, args, options) => {
    if (!interrupted && args.includes("commit") && args.includes("--no-edit")) {
      interrupted = true;
      throw new Error("interrupted before integration commit");
    }
    return gitAt(cwd, args, options);
  } }), /interrupted before integration commit/u);
  const result = await mergeSelectedResults(dev);
  await assertNativePreparedComposition({ ...dev, ...result, git: (args, options) => gitAt(result.root, args, options) });
  assert.equal(await git(result.root, "show", "HEAD:CHANGELOG.md"), "published");
  assert.equal(await git(result.root, "show", "HEAD:selected.txt"), "accepted content");
  assert.equal(await git(result.root, "show", "-s", "--format=%P", result.head), `${baseCommit} ${task.resultCommit}`);
  assert.equal((await mergeSelectedResults(dev)).head, result.head);

  const release = request(NATIVE_RELEASE_POLICY, [conflicting]);
  await assert.rejects(mergeSelectedResults(release), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT");
    assert.deepEqual(error.conflicts, ["shared.txt"]);
    return true;
  });
  const checkout = path.join(release.root, "repository");
  assert.equal(await readFile(path.join(checkout, "CHANGELOG.md"), "utf8"), "published\n");
  assert.equal(await git(checkout, "rev-parse", "MERGE_HEAD"), conflicting.resultCommit);
  await writeFile(path.join(checkout, "shared.txt"), "published + task content\n");
  await commit(checkout, "resolve actual conflict");
  const released = await mergeSelectedResults(release);
  await assertNativePreparedComposition({ ...release, ...released, git: (args, options) => gitAt(released.root, args, options) });
  assert.equal(await git(checkout, "show", "HEAD:CHANGELOG.md"), "published");
  assert.equal(await git(checkout, "show", "HEAD:shared.txt"), "published + task content");
});

test("native candidate refuses existing package version changes but accepts dependency edits", async t => {
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

test("native checkout preserves ignored private bytes and uses Git EOL", async (t) => {
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

test("one-time native cutover retains exact old snapshot and original results", async t => {
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
