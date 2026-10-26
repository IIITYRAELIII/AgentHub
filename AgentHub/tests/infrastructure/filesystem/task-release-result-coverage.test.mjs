import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

const exec = promisify(execFile);
const taskId = "91000000-0000-0000-0000-000000000001";
const otherId = "91000000-0000-0000-0000-000000000002";

async function git(cwd, ...args) {
  return String((await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, windowsHide: true })).stdout).trim();
}

async function commit(root, name, { empty = false } = {}) {
  await git(root, "add", "--all");
  await git(root, "commit", ...(empty ? ["--allow-empty"] : []), "-m", name);
  return git(root, "rev-parse", "HEAD");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-result-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "repo");
  await mkdir(primary);
  await git(primary, "init", "-b", "main");
  await git(primary, "config", "core.autocrlf", "false");
  await writeFile(path.join(primary, "base.txt"), "published base\n");
  const base = await commit(primary, "base");
  const service = new TaskGitWorkspaceService({ dataDir: path.join(root, "data") });
  const task = await service.prepare({ taskId, projectRoot: primary });
  const dev = await service.prepareDev(primary);
  const reference = (resultCommit) => ({ taskId, taskRevision: 2, projectRoot: primary,
    branch: task.branch, resultCommit });
  const evidence = (resultCommit) => service.releaseIntegrationEvidence({ projectRoot: primary,
    tasks: [reference(resultCommit)] });
  const integrate = async (result) => {
    await git(dev.projectRoot, "merge", "--no-ff", "--no-edit", result);
    return git(dev.projectRoot, "rev-parse", "HEAD");
  };
  const nested = async (result) => {
    const other = await service.prepare({ taskId: otherId, projectRoot: primary });
    await writeFile(path.join(other.projectRoot, "other.txt"), "unselected\n");
    await commit(other.projectRoot, "other Task");
    await git(other.projectRoot, "merge", "--no-ff", "--no-edit", result);
    return integrate(await git(other.projectRoot, "rev-parse", "HEAD"));
  };
  return { primary, base, task, dev, service, evidence, integrate, nested };
}

test("release evidence rejects a late result present only through another Task's merge", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.task.projectRoot, "early.txt"), "early\n");
  const early = await commit(f.task.projectRoot, "early accepted result");
  await f.integrate(early);
  await writeFile(path.join(f.task.projectRoot, "late.txt"), "late selected fix\n");
  const late = await commit(f.task.projectRoot, "late accepted result");
  await f.nested(late);
  await git(f.primary, "merge-base", "--is-ancestor", late, "dev");
  const refs = await git(f.primary, "show-ref");
  await assert.rejects(f.evidence(late), (error) => {
    assert.equal(error.code, "TASK_RELEASE_RESULT_NOT_COVERED");
    assert.match(error.message, /latest result.*not covered.*owned.*integration/u);
    return true;
  });
  assert.equal(await git(f.primary, "show-ref"), refs);
});

test("direct repeated integrations and exact evidence retries retain the latest result", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.task.projectRoot, "early.txt"), "early\n");
  const early = await commit(f.task.projectRoot, "early");
  const first = await f.integrate(early);
  await writeFile(path.join(f.task.projectRoot, "late.txt"), "late\n");
  const late = await commit(f.task.projectRoot, "late");
  const second = await f.integrate(late);
  const result = await f.evidence(late);
  assert.deepEqual(result.tasks[0].integrations.map(({ commit: value }) => value), [first, second]);
  assert.equal(result.tasks[0].resultCommit, late);
  assert.deepEqual(await f.evidence(late), result);
  const noOp = await commit(f.task.projectRoot, "direct identity-only successor", { empty: true });
  const third = await f.integrate(noOp);
  const next = await f.evidence(noOp);
  assert.deepEqual(next.tasks[0].integrations.map(({ commit: value }) => value), [first, second, third]);
  assert.equal(next.tasks[0].resultCommit, noOp);
});

test("a no-op successor nested through another Task cannot borrow the previous result identity", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.task.projectRoot, "task.txt"), "selected\n");
  const early = await commit(f.task.projectRoot, "selected");
  await f.integrate(early);
  const noOp = await commit(f.task.projectRoot, "identity-only successor", { empty: true });
  await f.nested(noOp);
  assert.equal(await git(f.primary, "rev-parse", `${noOp}^{tree}`),
    await git(f.primary, "rev-parse", `${early}^{tree}`));
  await assert.rejects(f.evidence(noOp), { code: "TASK_RELEASE_RESULT_NOT_COVERED" });
});

test("an already accepted main result needs no invented dev integration", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.task.projectRoot, "task.txt"), "published\n");
  const resultCommit = await commit(f.task.projectRoot, "published result");
  await git(f.primary, "merge", "--ff-only", resultCommit);
  await git(f.dev.projectRoot, "merge", "--ff-only", resultCommit);
  const result = await f.evidence(resultCommit);
  assert.deepEqual(result.tasks[0].integrations, []);
  assert.equal(result.tasks[0].resultCommit, resultCommit);
});

test("shared early evidence is checked after its unique selected owner is assigned", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.task.projectRoot, "early.txt"), "early\n");
  const early = await commit(f.task.projectRoot, "shared early result");
  await f.integrate(early);
  const owner = await f.service.prepare({ taskId: otherId, projectRoot: f.primary });
  await git(owner.projectRoot, "merge", "--ff-only", early);
  await writeFile(path.join(f.task.projectRoot, "late.txt"), "late\n");
  const late = await commit(f.task.projectRoot, "selected later result");
  await f.nested(late);
  await assert.rejects(f.service.releaseIntegrationEvidence({ projectRoot: f.primary, tasks: [
    { taskId, taskRevision: 2, projectRoot: f.primary, branch: f.task.branch, resultCommit: late },
    { taskId: otherId, taskRevision: 1, projectRoot: f.primary, branch: owner.branch, resultCommit: early },
  ] }), { code: "TASK_RELEASE_RESULT_NOT_COVERED" });
});

test("a new result incorporating accepted main keeps its exact direct integration", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.task.projectRoot, "task.txt"), "selected\n");
  const early = await commit(f.task.projectRoot, "selected");
  const first = await f.integrate(early);
  await writeFile(path.join(f.primary, "upstream.txt"), "accepted upstream\n");
  const main = await commit(f.primary, "accepted main");
  await f.integrate(main);
  await git(f.task.projectRoot, "merge", "--no-ff", "--no-edit", main);
  const resultCommit = await git(f.task.projectRoot, "rev-parse", "HEAD");
  const latest = await f.integrate(resultCommit);
  const result = await f.evidence(resultCommit);
  assert.deepEqual(result.tasks[0].integrations.map(({ commit: value }) => value), [first, latest]);
});

test("equal bytes carried only by a second-parent Task do not grant first-parent ownership", async (t) => {
  const f = await fixture(t);
  const other = await f.service.prepare({ taskId: otherId, projectRoot: f.primary });
  await writeFile(path.join(other.projectRoot, "task.txt"), "same tree\n");
  const otherResult = await commit(other.projectRoot, "other Task result");
  await f.integrate(otherResult);
  await commit(f.task.projectRoot, "separate first-parent identity", { empty: true });
  await git(f.task.projectRoot, "merge", "--no-ff", "--no-edit", otherResult);
  const resultCommit = await git(f.task.projectRoot, "rev-parse", "HEAD");
  assert.equal(await git(f.primary, "rev-parse", `${resultCommit}^{tree}`),
    await git(f.primary, "rev-parse", `${otherResult}^{tree}`));
  await writeFile(path.join(other.projectRoot, "wrapper.txt"), "foreign wrapper\n");
  await commit(other.projectRoot, "other continues");
  await git(other.projectRoot, "merge", "--no-ff", "--no-edit", resultCommit);
  await f.integrate(await git(other.projectRoot, "rev-parse", "HEAD"));
  await assert.rejects(f.evidence(resultCommit), /no exact first-parent integration/u);
});

test("shared historical integrations do not compete with three separately owned current results", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.task.projectRoot, "shared.txt"), "shared historical context\n");
  const shared = await commit(f.task.projectRoot, "shared history");
  const historical = await f.integrate(shared);
  const second = await f.service.prepare({ taskId: otherId, projectRoot: f.primary });
  const thirdId = "91000000-0000-0000-0000-000000000003";
  const third = await f.service.prepare({ taskId: thirdId, projectRoot: f.primary });
  await git(second.projectRoot, "merge", "--ff-only", shared);
  await git(third.projectRoot, "merge", "--ff-only", shared);
  await writeFile(path.join(f.task.projectRoot, "first.txt"), "first selected change\n");
  const firstResult = await commit(f.task.projectRoot, "first current result");
  const firstIntegration = await f.integrate(firstResult);
  await git(second.projectRoot, "merge", "--ff-only", firstResult);
  await writeFile(path.join(second.projectRoot, "second.txt"), "second selected change\n");
  const secondResult = await commit(second.projectRoot, "second current result");
  const secondIntegration = await f.integrate(secondResult);
  await writeFile(path.join(third.projectRoot, "third.txt"), "third selected change\n");
  await commit(third.projectRoot, "third own change");
  await git(third.projectRoot, "merge", "--no-ff", "--no-edit", firstResult);
  const thirdResult = await git(third.projectRoot, "rev-parse", "HEAD");
  const thirdIntegration = await f.integrate(thirdResult);
  const tasks = [
    { taskId, taskRevision: 2, projectRoot: f.primary, branch: f.task.branch, resultCommit: firstResult },
    { taskId: otherId, taskRevision: 2, projectRoot: f.primary, branch: second.branch, resultCommit: secondResult },
    { taskId: thirdId, taskRevision: 2, projectRoot: f.primary, branch: third.branch, resultCommit: thirdResult },
  ];
  const refs = await git(f.primary, "show-ref");
  const evidence = await f.service.releaseIntegrationEvidence({ projectRoot: f.primary, tasks });
  assert.deepEqual(evidence.tasks.map(task => task.resultCommit), [firstResult, secondResult, thirdResult]);
  assert.deepEqual(evidence.tasks.map(task => task.integrations.map(entry => entry.commit)),
    [[firstIntegration], [secondIntegration], [thirdIntegration]]);
  assert.equal(evidence.tasks.some(task => task.integrations.some(entry => entry.commit === historical)), false);
  assert.deepEqual(await f.service.releaseIntegrationEvidence({ projectRoot: f.primary, tasks }), evidence);
  assert.equal(await git(f.primary, "show-ref"), refs);
});

test("shared history still refuses when one current result has only foreign integration coverage", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.task.projectRoot, "shared.txt"), "shared\n");
  const shared = await commit(f.task.projectRoot, "shared history");
  await f.integrate(shared);
  const second = await f.service.prepare({ taskId: otherId, projectRoot: f.primary });
  await git(second.projectRoot, "merge", "--ff-only", shared);
  await writeFile(path.join(f.task.projectRoot, "first.txt"), "first\n");
  const firstResult = await commit(f.task.projectRoot, "first current result");
  await f.integrate(firstResult);
  await writeFile(path.join(second.projectRoot, "second.txt"), "second\n");
  const secondResult = await commit(second.projectRoot, "second current result");
  const wrapper = await f.service.prepare({
    taskId: "91000000-0000-0000-0000-000000000004", projectRoot: f.primary,
  });
  await writeFile(path.join(wrapper.projectRoot, "foreign.txt"), "not selected\n");
  await commit(wrapper.projectRoot, "foreign wrapper");
  await git(wrapper.projectRoot, "merge", "--no-ff", "--no-edit", secondResult);
  await f.integrate(await git(wrapper.projectRoot, "rev-parse", "HEAD"));
  await git(f.primary, "merge-base", "--is-ancestor", secondResult, "dev");
  const refs = await git(f.primary, "show-ref");
  await assert.rejects(f.service.releaseIntegrationEvidence({ projectRoot: f.primary, tasks: [
    { taskId, taskRevision: 2, projectRoot: f.primary, branch: f.task.branch, resultCommit: firstResult },
    { taskId: otherId, taskRevision: 2, projectRoot: f.primary, branch: second.branch, resultCommit: secondResult },
  ] }), /ambiguously owned/u);
  assert.equal(await git(f.primary, "show-ref"), refs);
});

test("two Tasks cannot use the same current result as independent integration ownership", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.task.projectRoot, "shared.txt"), "same current result\n");
  const resultCommit = await commit(f.task.projectRoot, "same result");
  await f.integrate(resultCommit);
  const other = await f.service.prepare({ taskId: otherId, projectRoot: f.primary });
  await git(other.projectRoot, "merge", "--ff-only", resultCommit);
  const refs = await git(f.primary, "show-ref");
  await assert.rejects(f.service.releaseIntegrationEvidence({ projectRoot: f.primary, tasks: [
    { taskId, taskRevision: 2, projectRoot: f.primary, branch: f.task.branch, resultCommit },
    { taskId: otherId, taskRevision: 2, projectRoot: f.primary, branch: other.branch, resultCommit },
  ] }), /ambiguously owned/u);
  assert.equal(await git(f.primary, "show-ref"), refs);
});
