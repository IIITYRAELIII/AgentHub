import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { releaseTaskNetProjections } from "../../../src/infrastructure/filesystem/release-task-net-projection.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";

const exec = promisify(execFile);
async function fixture(t, revisions = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-release-net-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary");
  const rawGit = async (cwd, args) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
  await rawGit(root, ["init", "--bare", "--initial-branch=main", "origin.git"]);
  await rawGit(root, ["clone", "origin.git", primary]);
  const git = (args) => rawGit(primary, args);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  const put = (name, content) => writeFile(path.join(primary, name), content, "utf8");
  const commit = async (message) => { await git(["add", "-A"]); await git(["commit", "-m", message]); return git(["rev-parse", "HEAD"]); };
  const merge = (ref) => git(["merge", "--no-ff", "--no-edit", ref]);
  await put("app.txt", "function render() {\n  return 0;\n}\n");
  await put("README.md", "base\n");
  await put("CHANGELOG.md", "published notes\n");
  await put(".gitattributes", "* text eol=lf\n");
  const base = await commit("base");
  await git(["branch", "task"]);
  await git(["branch", "dev"]);
  const integrations = [];
  const integrate = async (result) => {
    await git(["checkout", "dev"]);
    const parent = await git(["rev-parse", "HEAD"]);
    await merge(result);
    integrations.push({ parent, commit: await git(["rev-parse", "HEAD"]), order: integrations.length });
  };
  // A published main import in dev must remain context, not become a Task deletion.
  await put("README.md", "published context\nbase\n");
  const published = await commit("published context");
  await git(["checkout", "dev"]);
  await merge(published);
  for (let i = 1; i <= revisions; i += 1) {
    await git(["checkout", "task"]);
    await put("app.txt", `function render() {\n  return ${i};\n}\n`);
    const result = await commit(`Task revision ${i}`);
    await integrate(result);
  }
  await git(["checkout", "main"]);
  await put("app.txt", "function render() {\n  return trace(renderContent);\n}\nfunction renderContent() {\n  return 0;\n}\n");
  const main = await commit("main adds adjacent trace wrapper");
  await git(["push", "origin", "main"]);
  await git(["checkout", "task"]);
  await merge("dev");
  await assert.rejects(merge(main));
  const accepted = `function render() {\n  return trace(renderContent);\n}\nfunction renderContent() {\n  return ${revisions};\n}\n`;
  await put("app.txt", accepted);
  await put("README.md", "published context\nbase\nTask documentation\n");
  // Task results retain release-owned metadata; publication supplies its notes.
  const resultCommit = await commit("Task resolves current main");
  await integrate(resultCommit);
  await git(["checkout", "main"]);
  return { root, primary, rawGit, git, put, commit, merge, integrate, base, main, accepted,
    task: { taskId: "task", taskRevision: 16, baseCommit: base, resultCommit, integrations } };
}

test("retained 16-integration projection proof does not admit its historical dev wrapper to native release", async (t) => {
  const f = await fixture(t, 15);
  const proofs = await releaseTaskNetProjections({ tasks: [f.task], baseCommit: f.main, git: f.git });
  assert.equal(proofs.get("task")?.parent, f.main);
  assert.deepEqual(proofs.get("task").paths, ["README.md", "app.txt"]);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data") });
  await assert.rejects(service.prepareCandidate({
    projectRoot: f.primary, approvedBaseCommit: f.main, planRevision: "net-16", frozenTasks: [f.task],
  }), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await f.git(["rev-parse", "HEAD"]), f.main);
  assert.equal(await f.git(["status", "--porcelain"]), "");
});

test("historical sibling-base proof does not authorize a non-descendant native Task result", async (t) => {
  const f = await fixture(t, 1);
  await f.git(["checkout", "-b", "equivalent-base", f.base]);
  await f.put("approved-base-only.txt", "approved base context\n");
  const equivalentBase = await f.commit("approved sibling Task base");
  await f.git(["checkout", "main"]);
  await f.merge(equivalentBase);
  const approved = await f.git(["rev-parse", "HEAD"]);
  await f.git(["push", "origin", "main"]);
  const task = { ...f.task, baseCommit: equivalentBase };
  const proofs = await releaseTaskNetProjections({ tasks: [task], baseCommit: approved, git: f.git });
  assert.equal(proofs.get(task.taskId)?.orderPreserving, true);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data-equivalent-base") });
  await assert.rejects(service.prepareCandidate({
    projectRoot: f.primary, approvedBaseCommit: approved,
    planRevision: "path-equivalent-base", frozenTasks: [task],
  }), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await f.git(["rev-parse", "HEAD"]), approved);
  assert.equal(await f.git(["status", "--porcelain"]), "");
});

test("foreign unpublished same-file ancestry cannot enter net projection or bypass conflicting effective replay", async (t) => {
  const f = await fixture(t);
  await f.git(["checkout", "-b", "foreign", f.main]);
  await f.put("README.md", "FOREIGN unpublished\npublished context\nbase\n");
  const foreign = await f.commit("foreign Task");
  await f.git(["checkout", "task"]);
  await f.merge(foreign);
  f.task.resultCommit = await f.git(["rev-parse", "HEAD"]);
  await f.integrate(f.task.resultCommit);
  await f.git(["checkout", "main"]);
  assert.equal((await releaseTaskNetProjections({ tasks: [f.task], baseCommit: f.main, git: f.git })).size, 0);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data") });
  await assert.rejects(service.prepareCandidate({
    projectRoot: f.primary, approvedBaseCommit: f.main, planRevision: "foreign", frozenTasks: [f.task],
  }), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await f.git(["show", "main:README.md"]), "published context\nbase");
});

test("manual dev merge baggage cannot masquerade as an automatic approved-main wrapper", async (t) => {
  const f = await fixture(t);
  await f.git(["checkout", "main"]);
  await f.put("other.txt", "main advance\n");
  const approved = await f.commit("another approved main change");
  await f.git(["checkout", "dev"]);
  await f.git(["merge", "--no-ff", "--no-commit", approved]);
  await f.put("README.md", "MANUAL baggage\npublished context\nbase\nTask documentation\n");
  await f.commit("unregistered merge resolution");
  await f.git(["checkout", "task"]);
  await f.merge("dev");
  f.task.resultCommit = await f.git(["rev-parse", "HEAD"]);
  await f.integrate(f.task.resultCommit);
  assert.equal((await releaseTaskNetProjections({ tasks: [f.task], baseCommit: approved, git: f.git })).size, 0);
});

test("overlapping selected Task paths retain chronological effective dev resolution", async (t) => {
  const f = await fixture(t);
  const other = { ...f.task, taskId: "other", integrations: [f.task.integrations[0]] };
  assert.equal((await releaseTaskNetProjections({ tasks: [f.task, other], baseCommit: f.main, git: f.git })).size, 0);
});

async function reopenPublishedTask(f, { manualIntegration = false, foreignDev = false } = {}) {
  await f.git(["checkout", "-b", "maintenance", f.main]);
  await f.put("README.md", "published maintenance\npublished context\nbase\n");
  await f.put("fix.txt", "before\n");
  const publishedResult = await f.commit("maintenance first result");
  const integrations = [];
  const integrate = async (result, manual = false) => {
    await f.git(["checkout", "dev"]);
    const parent = await f.git(["rev-parse", "HEAD"]);
    if (manual) {
      await f.git(["merge", "--no-ff", "--no-commit", result]);
      await f.put("baggage.txt", "unpublished integration edit\n");
      await f.commit("manual integration baggage");
    } else await f.merge(result);
    integrations.push({ parent, commit: await f.git(["rev-parse", "HEAD"]), order: f.task.integrations.length + integrations.length });
  };
  await integrate(publishedResult, manualIntegration);
  await f.git(["checkout", "main"]);
  await f.merge(publishedResult);
  const approved = await f.git(["rev-parse", "HEAD"]);
  await f.git(["push", "origin", "main"]);
  await f.git(["checkout", "maintenance"]);
  if (foreignDev) {
    await f.git(["checkout", "-b", "foreign", approved]);
    await f.put("foreign.txt", "not selected\n");
    const foreign = await f.commit("foreign unpublished Task");
    await f.git(["checkout", "dev"]);
    await f.merge(foreign);
    await f.git(["checkout", "maintenance"]);
    await f.merge("dev");
  } else await f.merge(approved);
  await f.put("fix.txt", "after\n");
  const resultCommit = await f.commit("reopened maintenance fix");
  await integrate(resultCommit);
  await f.git(["checkout", "main"]);
  return { approved, task: {
    taskId: "maintenance", taskRevision: 2, baseCommit: f.main, resultCommit, integrations,
  } };
}

test("retained reopened projection proofs cannot grant fresh native admission to historical dev sides", async (t) => {
  const f = await fixture(t);
  const reopened = await reopenPublishedTask(f);
  const tasks = [f.task, reopened.task];
  const proofs = await releaseTaskNetProjections({ tasks, baseCommit: reopened.approved, git: f.git });
  assert.deepEqual([...proofs.keys()], ["task", "maintenance"]);
  assert.deepEqual(proofs.get("maintenance").paths, ["fix.txt"]);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data") });
  await assert.rejects(service.prepareCandidate({
    projectRoot: f.primary, approvedBaseCommit: reopened.approved, planRevision: "reopened", frozenTasks: tasks,
  }), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await f.git(["rev-parse", "HEAD"]), reopened.approved);
  assert.equal(await f.git(["status", "--porcelain"]), "");
});

test("published Task ancestry does not authorize manual integration baggage", async (t) => {
  const f = await fixture(t);
  const reopened = await reopenPublishedTask(f, { manualIntegration: true });
  const proofs = await releaseTaskNetProjections({ tasks: [reopened.task], baseCommit: reopened.approved, git: f.git });
  assert.equal(proofs.size, 0);
});

test("published integration metadata cannot strip unselected ancestry from a native Task result", async (t) => {
  const f = await fixture(t);
  const reopened = await reopenPublishedTask(f, { foreignDev: true });
  assert.equal((await releaseTaskNetProjections({
    tasks: [reopened.task], baseCommit: reopened.approved, git: f.git,
  })).size, 0);
  const expectedMain = await f.git(["show", `${reopened.approved}:app.txt`]);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data") });
  await assert.rejects(service.prepareCandidate({
    projectRoot: f.primary, approvedBaseCommit: reopened.approved,
    planRevision: "published-integration", frozenTasks: [reopened.task],
  }), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await f.git(["show", `${reopened.approved}:app.txt`]), expectedMain);
  assert.equal(await f.git(["rev-parse", "HEAD"]), reopened.approved);
});

test("a later shared overlap rejects its own projections without invalidating an earlier interval-safe fold", async (t) => {
  const f = await fixture(t);
  const reopened = await reopenPublishedTask(f);
  const blocker = { ...reopened.task, taskId: "blocker", integrations: [reopened.task.integrations.at(-1)] };
  for (const tasks of [[f.task, reopened.task, blocker], [blocker, reopened.task, f.task]]) {
    const proofs = await releaseTaskNetProjections({ tasks, baseCommit: reopened.approved, git: f.git });
    assert.deepEqual([...proofs.keys()], ["task"]);
    assert.equal(proofs.get("task").orderPreserving, true);
  }
});

test("retained interval-safe projection cannot authorize a combined native result with unselected ancestry", async (t) => {
  const f = await fixture(t, 1);
  f.task.integrations[0].order = 1;
  f.task.integrations[1].order = 3;
  const addTask = async ({ id, name, content, order }) => {
    await f.git(["checkout", "-b", id, "dev"]);
    await f.put(name, content);
    const resultCommit = await f.commit(`${id} result`);
    await f.git(["checkout", "dev"]);
    const parent = await f.git(["rev-parse", "HEAD"]);
    await f.git(["merge", "--no-ff", "--no-edit", resultCommit]);
    return {
      taskId: id,
      taskRevision: 1,
      baseCommit: f.base,
      resultCommit,
      integrations: [{ parent, commit: await f.git(["rev-parse", "HEAD"]), order }],
    };
  };
  const disjoint = await addTask({ id: "disjoint", name: "side.txt", content: "side\n", order: 2 });
  const later = await addTask({
    id: "later-overlap", name: "app.txt", content: `${f.accepted}// later selected change\n`, order: 4,
  });
  await f.git(["checkout", "main"]);
  const interveningThenLater = {
    ...later,
    taskId: "intervening-then-later",
    integrations: [...disjoint.integrations, ...later.integrations],
  };
  const tasks = [f.task, interveningThenLater];
  const proofs = await releaseTaskNetProjections({ tasks, baseCommit: f.main, git: f.git });
  assert.equal(proofs.get("task")?.orderPreserving, true);
  assert.equal(Math.max(...f.task.integrations.map(({ order }) => order)), 3);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data-interval") });
  await assert.rejects(service.prepareCandidate({
    projectRoot: f.primary, approvedBaseCommit: f.main, planRevision: "interval-safe", frozenTasks: tasks,
  }), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await f.git(["rev-parse", "HEAD"]), f.main);
  assert.equal(await f.git(["status", "--porcelain"]), "");
});

test("intervening overlap blocks a multi-revision fold even when the net delta reverted that path", async (t) => {
  const f = await fixture(t, 1);
  await f.git(["checkout", "main"]);
  await f.put("transient.txt", "first=base\nsecond=base\nthird=base\n");
  const approved = await f.commit("approved transient base");
  await f.git(["push", "origin", "main"]);
  await f.git(["checkout", "dev"]);
  await f.git(["merge", "--no-ff", "--no-edit", approved]);
  await f.git(["checkout", "-b", "interval-task", approved]);
  await f.put("transient.txt", "first=task\nsecond=base\nthird=base\n");
  const firstResult = await f.commit("interval Task first revision");
  await f.git(["checkout", "dev"]);
  const firstParent = await f.git(["rev-parse", "HEAD"]);
  await f.git(["merge", "--no-ff", "--no-edit", firstResult]);
  const firstIntegration = await f.git(["rev-parse", "HEAD"]);
  await f.git(["checkout", "-b", "intervening", "dev"]);
  await f.put("transient.txt", "first=task\nsecond=base\nthird=other\n");
  const blockerResult = await f.commit("intervening selected change");
  await f.git(["checkout", "dev"]);
  const blockerParent = await f.git(["rev-parse", "HEAD"]);
  await f.git(["merge", "--no-ff", "--no-edit", blockerResult]);
  const blockerIntegration = await f.git(["rev-parse", "HEAD"]);
  await f.git(["checkout", "interval-task"]);
  await f.put("transient.txt", "first=base\nsecond=base\nthird=base\n");
  await f.put("interval-owned.txt", "final\n");
  const resultCommit = await f.commit("interval Task final revision");
  await f.git(["checkout", "dev"]);
  const lastParent = await f.git(["rev-parse", "HEAD"]);
  await f.git(["merge", "--no-ff", "--no-edit", resultCommit]);
  const lastIntegration = await f.git(["rev-parse", "HEAD"]);
  const blocker = {
    taskId: "intervening-overlap",
    taskRevision: 1,
    baseCommit: approved,
    resultCommit: blockerResult,
    integrations: [{ parent: blockerParent, commit: blockerIntegration, order: 2 }],
  };
  const intervalTask = {
    taskId: "interval-task", taskRevision: 2, baseCommit: approved, resultCommit,
    integrations: [
      { parent: firstParent, commit: firstIntegration, order: 1 },
      { parent: lastParent, commit: lastIntegration, order: 3 },
    ],
  };
  assert.deepEqual(await f.git(["diff", "--name-only", approved, resultCommit]), "interval-owned.txt");
  assert.equal((await releaseTaskNetProjections({
    tasks: [intervalTask, blocker], baseCommit: approved, git: f.git,
  })).has("interval-task"), false);
});

test("interval proof rejects a non-final result parent and duplicate exact evidence", async (t) => {
  const f = await fixture(t, 1);
  f.task.integrations[0].order = 1;
  f.task.integrations[1].order = 3;
  const nonFinal = { ...f.task, resultCommit: await f.git(["rev-parse", `${f.task.resultCommit}^1`]) };
  assert.equal((await releaseTaskNetProjections({ tasks: [nonFinal], baseCommit: f.main, git: f.git })).size, 0);
  const duplicate = { ...f.task, integrations: [...f.task.integrations, { ...f.task.integrations[1] }] };
  assert.equal((await releaseTaskNetProjections({ tasks: [duplicate], baseCommit: f.main, git: f.git })).size, 0);
  const repeatedCommitAtAnotherOrder = {
    ...f.task,
    integrations: [...f.task.integrations, { ...f.task.integrations[1], order: 5 }],
  };
  assert.equal((await releaseTaskNetProjections({
    tasks: [repeatedCommitAtAnotherOrder], baseCommit: f.main, git: f.git,
  })).size, 0);
});

test("rename source overlap inside the interval keeps chronological replay", async (t) => {
  const f = await fixture(t, 1);
  await f.git(["checkout", "main"]);
  await f.put("old.txt", "base\n");
  const approved = await f.commit("approved rename base");
  await f.git(["push", "origin", "main"]);
  await f.git(["checkout", "dev"]);
  await f.git(["merge", "--no-ff", "--no-edit", approved]);
  await f.git(["checkout", "-b", "rename-task", approved]);
  await f.git(["mv", "old.txt", "new.txt"]);
  const firstResult = await f.commit("rename first revision");
  await f.git(["checkout", "dev"]);
  const firstParent = await f.git(["rev-parse", "HEAD"]);
  await f.git(["merge", "--no-ff", "--no-edit", firstResult]);
  const firstIntegration = await f.git(["rev-parse", "HEAD"]);
  await f.git(["checkout", "-b", "old-path-task", approved]);
  await f.put("old.txt", "intervening\n");
  const blockerResult = await f.commit("intervening old path edit");
  await f.git(["checkout", "dev"]);
  const blockerParent = await f.git(["rev-parse", "HEAD"]);
  await f.put("old.txt", "intervening\n");
  await f.commit("prepare exact manual integration tree");
  const blockerTree = await f.git(["rev-parse", "HEAD^{tree}"]);
  await f.git(["reset", "--hard", blockerParent]);
  const blockerIntegration = await f.git([
    "commit-tree", blockerTree, "-p", blockerParent, "-p", blockerResult, "-m", "manual old path integration",
  ]);
  await f.git(["reset", "--hard", blockerIntegration]);
  await f.git(["checkout", "rename-task"]);
  await f.put("rename-owned.txt", "final\n");
  const resultCommit = await f.commit("rename final revision");
  await f.git(["checkout", "dev"]);
  const lastParent = await f.git(["rev-parse", "HEAD"]);
  await f.git(["merge", "--no-ff", "--no-edit", resultCommit]);
  const lastIntegration = await f.git(["rev-parse", "HEAD"]);
  const task = {
    taskId: "rename-task", taskRevision: 2, baseCommit: approved, resultCommit,
    integrations: [
      { parent: firstParent, commit: firstIntegration, order: 1 },
      { parent: lastParent, commit: lastIntegration, order: 3 },
    ],
  };
  const blocker = {
    taskId: "old-path-task", taskRevision: 1, baseCommit: approved, resultCommit: blockerResult,
    integrations: [{ parent: blockerParent, commit: blockerIntegration, order: 2 }],
  };
  assert.equal((await releaseTaskNetProjections({ tasks: [task, blocker], baseCommit: approved, git: f.git }))
    .has("rename-task"), false);
});

test("native release rejects unselected dev baggage and accepts the exact owned Task base resolution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-release-stale-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary");
  const rawGit = async (cwd, args) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
  await rawGit(root, ["init", "--bare", "--initial-branch=main", "origin.git"]);
  await rawGit(root, ["clone", "origin.git", primary]);
  const git = (args) => rawGit(primary, args);
  const put = (name, content) => writeFile(path.join(primary, name), content, "utf8");
  const commit = async (message) => {
    await git(["add", "-A"]);
    await git(["commit", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  await put("shared.txt", "setting=base\n");
  await put("CHANGELOG.md", "published\n");
  await put(".gitattributes", "* text eol=lf\n");
  const base = await commit("base");
  await git(["branch", "dev"]);
  await git(["checkout", "-b", "task"]);
  await put("owned.txt", "first revision\n");
  const firstResult = await commit("first Task revision");
  await git(["checkout", "dev"]);
  const firstParent = await git(["rev-parse", "HEAD"]);
  await git(["merge", "--no-ff", "--no-edit", firstResult]);
  const firstIntegration = await git(["rev-parse", "HEAD"]);
  await git(["checkout", "main"]);
  await put("shared.txt", "setting=approved-main\n");
  const approved = await commit("approved main changes same setting");
  await git(["push", "origin", "main"]);
  await git(["checkout", "task"]);
  await put("shared.txt", "setting=task\n");
  await commit("reopened Task changes same setting");
  await assert.rejects(git(["merge", "--no-ff", "--no-commit", approved]));
  await put("shared.txt", "setting=task+approved-main\n");
  await git(["add", "shared.txt"]);
  await git(["commit", "--no-edit"]);
  const taskBaseMerge = await git(["rev-parse", "HEAD"]);
  await git(["checkout", "dev"]);
  await put("foreign.txt", "unselected dev context\n");
  const integrationParent = await commit("unselected dev context");
  await git(["checkout", "task"]);
  await git(["merge", "--no-ff", "--no-edit", integrationParent]);
  const resultCommit = await git(["rev-parse", "HEAD"]);
  await git(["checkout", "dev"]);
  await git(["merge", "--no-ff", "--no-edit", resultCommit]);
  const integrationCommit = await git(["rev-parse", "HEAD"]);
  await git(["checkout", "main"]);
  const task = {
    taskId: "reopened-task",
    taskRevision: 3,
    baseCommit: base,
    resultCommit,
    integrations: [
      { parent: firstParent, commit: firstIntegration, order: 1 },
      { parent: integrationParent, commit: integrationCommit, order: 2 },
    ],
  };
  assert.equal((await releaseTaskNetProjections({ tasks: [task], baseCommit: approved, git })).size, 0);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "data") });
  await assert.rejects(service.prepareCandidate({
    projectRoot: primary, approvedBaseCommit: approved, planRevision: "unselected-dev-side", frozenTasks: [task],
  }), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  const candidate = await service.prepareCandidate({
    projectRoot: primary,
    approvedBaseCommit: approved,
    planRevision: "task-base-merge-fallback",
    frozenTasks: [{ ...task, resultCommit: taskBaseMerge }],
  });
  assert.equal(await readFile(path.join(candidate.releaseRoot, "shared.txt"), "utf8"),
    "setting=task+approved-main\n");
  assert.equal(await readFile(path.join(candidate.releaseRoot, "owned.txt"), "utf8"), "first revision\n");
  await assert.rejects(readFile(path.join(candidate.releaseRoot, "foreign.txt"), "utf8"), /ENOENT/u);
  assert.equal(await git(["rev-parse", "HEAD"]), approved);
  assert.equal(await git(["status", "--porcelain"]), "");
  assert.notEqual(base, taskBaseMerge);
});
