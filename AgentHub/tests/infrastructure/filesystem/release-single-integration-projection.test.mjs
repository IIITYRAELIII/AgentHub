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
  const commit = async (message) => {
    await git(["add", "-A"]);
    await git(["commit", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
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
    { taskId: "selected", taskRevision: 2, baseCommit: base, resultCommit: selectedResult, integrations: selectedIntegrations },
    { taskId: "task", taskRevision: 1, baseCommit: base, resultCommit: taskResult, integrations: [taskIntegration] },
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
