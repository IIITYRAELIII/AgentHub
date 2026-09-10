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
