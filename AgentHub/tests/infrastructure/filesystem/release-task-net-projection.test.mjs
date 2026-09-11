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
  await put("CHANGELOG.md", "unreleased task notes\n");
  const resultCommit = await commit("Task resolves current main");
  await integrate(resultCommit);
  await git(["checkout", "main"]);
  return { root, primary, rawGit, git, put, commit, merge, integrate, base, main, accepted,
    task: { taskId: "task", taskRevision: 16, resultCommit, integrations } };
}

test("16 Task integrations project the accepted resolution over current main without losing published context", async (t) => {
  const f = await fixture(t, 15);
  const proofs = await releaseTaskNetProjections({ tasks: [f.task], baseCommit: f.main, git: f.git });
  assert.equal(proofs.get("task")?.parent, f.main);
  assert.deepEqual(proofs.get("task").paths, ["README.md", "app.txt"]);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data") });
  const candidate = await service.prepareCandidate({
    projectRoot: f.primary, approvedBaseCommit: f.main, planRevision: "net-16", frozenTasks: [f.task],
  });
  assert.equal(await readFile(path.join(candidate.releaseRoot, "app.txt"), "utf8"), f.accepted);
  assert.equal(await readFile(path.join(candidate.releaseRoot, "README.md"), "utf8"), "published context\nbase\nTask documentation\n");
  assert.equal(await readFile(path.join(candidate.releaseRoot, "CHANGELOG.md"), "utf8"), "published notes\n");
  assert.equal(await f.git(["rev-parse", "HEAD"]), f.main);
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
  }), /PreRelease delta/u);
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

test("one exact automatic integration keeps its order without first-parent baggage", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-release-single-net-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary");
  const git = async (args) => (await exec("git", args, { cwd: primary, windowsHide: true })).stdout.trim();
  await exec("git", ["init", "--bare", "--initial-branch=main", "origin.git"], { cwd: root, windowsHide: true });
  await exec("git", ["clone", "origin.git", primary], { cwd: root, windowsHide: true });
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  const put = (name, content) => writeFile(path.join(primary, name), content, "utf8");
  const commit = async (message) => { await git(["add", "-A"]); await git(["commit", "-m", message]); return git(["rev-parse", "HEAD"]); };
  const integrate = async (result, order) => {
    await git(["checkout", "dev"]);
    const parent = await git(["rev-parse", "HEAD"]);
    await git(["merge", "--no-ff", "--no-edit", result]);
    return { parent, commit: await git(["rev-parse", "HEAD"]), order };
  };
  const baseShared = "top\nslot1=base\ngap1\ngap2\nslot2=base\ngap3\nbottom\n";
  await put("shared.txt", baseShared);
  await put("README.md", "base\n");
  await put(".gitattributes", "* text eol=lf\n");
  const base = await commit("base");
  for (const branch of ["dev", "selected", "task", "foreign"]) await git(["branch", branch]);
  await git(["checkout", "foreign"]);
  await put("foreign.txt", "must not ship\n");
  const foreign = await commit("unselected foreign change");
  await integrate(foreign, 0);
  await git(["checkout", "selected"]);
  await put("shared.txt", "top\nslot1=selected intermediate\ngap1\ngap2\nslot2=base\ngap3\nbottom\n");
  const selectedFirst = await commit("selected intermediate revision");
  const selectedIntegrations = [await integrate(selectedFirst, 1)];
  await git(["checkout", "task"]);
  await put("shared.txt", "top\nslot1=base\ngap1\ngap2\nslot2=task\ngap3\nbottom\n");
  const taskResult = await commit("owned Task result");
  const taskIntegration = await integrate(taskResult, 2);
  assert.match(await git(["diff", taskIntegration.parent, taskIntegration.commit, "--", "shared.txt"]),
    /slot1=selected intermediate/u);
  await git(["checkout", "selected"]);
  await put("shared.txt", baseShared);
  await put("selected.txt", "selected final\n");
  const selectedResult = await commit("selected final revision");
  selectedIntegrations.push(await integrate(selectedResult, 3));
  await git(["checkout", "main"]);
  await git(["push", "origin", "main"]);
  const tasks = [
    { taskId: "selected", taskRevision: 2, resultCommit: selectedResult, integrations: selectedIntegrations },
    { taskId: "task", taskRevision: 1, resultCommit: taskResult, integrations: [taskIntegration] },
  ];
  const proofs = await releaseTaskNetProjections({ tasks, baseCommit: base, git });
  assert.equal(proofs.get("task")?.orderPreserving, true);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "data") });
  const candidate = await service.prepareCandidate({
    projectRoot: primary, approvedBaseCommit: base, planRevision: "single-net", frozenTasks: tasks,
  });
  assert.equal(await readFile(path.join(candidate.releaseRoot, "shared.txt"), "utf8"),
    "top\nslot1=base\ngap1\ngap2\nslot2=task\ngap3\nbottom\n");
  assert.equal(await readFile(path.join(candidate.releaseRoot, "selected.txt"), "utf8"), "selected final\n");
  await assert.rejects(readFile(path.join(candidate.releaseRoot, "foreign.txt"), "utf8"), /ENOENT/u);
});

async function reopenPublishedTask(f, { manualIntegration = false } = {}) {
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
  await f.merge(approved);
  await f.put("fix.txt", "after\n");
  const resultCommit = await f.commit("reopened maintenance fix");
  await integrate(resultCommit);
  await f.git(["checkout", "main"]);
  return { approved, task: { taskId: "maintenance", taskRevision: 2, resultCommit, integrations } };
}

test("reopened published Task composes its remaining delta beside another Task sharing only historical paths", async (t) => {
  const f = await fixture(t);
  const reopened = await reopenPublishedTask(f);
  const tasks = [f.task, reopened.task];
  const proofs = await releaseTaskNetProjections({ tasks, baseCommit: reopened.approved, git: f.git });
  assert.deepEqual([...proofs.keys()], ["task", "maintenance"]);
  assert.deepEqual(proofs.get("maintenance").paths, ["fix.txt"]);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data") });
  const candidate = await service.prepareCandidate({
    projectRoot: f.primary, approvedBaseCommit: reopened.approved, planRevision: "reopened", frozenTasks: tasks,
  });
  assert.equal(await readFile(path.join(candidate.releaseRoot, "app.txt"), "utf8"), f.accepted);
  assert.equal(await readFile(path.join(candidate.releaseRoot, "fix.txt"), "utf8"), "after\n");
  assert.equal(await readFile(path.join(candidate.releaseRoot, "README.md"), "utf8"),
    "published maintenance\npublished context\nbase\nTask documentation\n");
  assert.equal(await f.git(["rev-parse", "HEAD"]), reopened.approved);
  assert.equal(await f.git(["status", "--porcelain"]), "");
});

test("published Task ancestry does not authorize manual integration baggage", async (t) => {
  const f = await fixture(t);
  const reopened = await reopenPublishedTask(f, { manualIntegration: true });
  const proofs = await releaseTaskNetProjections({ tasks: [reopened.task], baseCommit: reopened.approved, git: f.git });
  assert.equal(proofs.size, 0);
});

test("an overlap restores historical paths and rejects dependent projections regardless of Task order", async (t) => {
  const f = await fixture(t);
  const reopened = await reopenPublishedTask(f);
  const blocker = { ...reopened.task, taskId: "blocker", integrations: [reopened.task.integrations.at(-1)] };
  for (const tasks of [[f.task, reopened.task, blocker], [blocker, reopened.task, f.task]]) {
    assert.equal((await releaseTaskNetProjections({ tasks, baseCommit: reopened.approved, git: f.git })).size, 0);
  }
});
