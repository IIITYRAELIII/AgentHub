import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertNativeTaskHistories } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { readNativeUpstreamAdoptions } from "../../../src/infrastructure/filesystem/native-upstream-adoption.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";

const exec = promisify(execFile);
async function fixture(t, directory = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-queries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const git = async (args, options = {}) => {
    calls.push(args);
    const pending = exec("git", args, { cwd: root, encoding: "buffer", windowsHide: true });
    pending.child.stdin.end(options.input ?? "");
    const { stdout } = await pending;
    return options.rawOutput ? stdout : stdout.toString("utf8").trim();
  };
  await git(["init", "--initial-branch=main"]);
  const save = async (file, body) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  const commit = async () => {
    await git(["add", "-A"]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "query fixture"]);
    return git(["rev-parse", "HEAD"]);
  };
  await save(directory ? `${directory}/entry.json` : "CHANGELOG.md",
    directory === "CHANGELOG.md" ? "agreed notes\n" : JSON.stringify({ version: "2.0.0" }));
  await save("nested/package.json", JSON.stringify({ version: "2.0.0", name: "fixture" }));
  const base = await commit();
  await save("code.txt", "selected result\n");
  const result = await commit();
  return { root, calls, git, save, commit, base, result };
}

test("adoption namespace is read once per boundary and selected malformed refs never become cached absence", async t => {
  const f = await fixture(t), key = taskRepositoryKey(f.root);
  const tasks = Array.from({ length: 13 }, (_, i) => ({ taskId: `selected-${i}`, baseCommit: f.base, resultCommit: f.result }));
  const read = () => readNativeUpstreamAdoptions({ git: f.git, tasks, repositoryRoot: f.root, localMainCommit: f.base });
  const blob = await f.git(["hash-object", "-w", "--stdin"], { input: "{}\n" });
  await f.git(["update-ref", `refs/agent-hub/upstream-adoptions/unselected/${key}/${f.result}/${f.base}`, blob]);
  f.calls.length = 0;
  assert.deepEqual(await read(), []);
  assert.equal(f.calls.filter(args => args[0] === "for-each-ref").length, 1);
  const ref = `refs/agent-hub/upstream-adoptions/${tasks[0].taskId}/${key}/${f.result}/${f.base}/nested-invalid`;
  await f.git(["update-ref", ref, blob]);
  await assert.rejects(read(), /identity changed/u);
  await f.git(["update-ref", "-d", ref]);
  assert.deepEqual(await read(), []);
  tasks[0] = { ...tasks[0], resultCommit: f.base };
  const current = `refs/agent-hub/upstream-adoptions/${tasks[0].taskId}/${key}/${f.base}/${f.result}`;
  await f.git(["update-ref", current, blob]);
  await assert.rejects(read(), /identity changed/u);
});

test("history uses one metadata diff and retains equal-base object validation and fresh plan checks", async t => {
  const f = await fixture(t);
  const tasks = [{ taskId: "selected", baseCommit: f.base, resultCommit: f.result }];
  const check = () => assertNativeTaskHistories({ git: f.git, baseCommit: f.base, tasks });
  f.calls.length = 0;
  await check();
  assert.equal(f.calls.filter(args => args[0] === "diff").length, 1);
  assert.deepEqual(f.calls.filter(args => args[0] === "merge-base"), [["merge-base", "--is-ancestor", f.base, f.result]]);
  await f.save("nested/package.json", JSON.stringify({ version: "9.9.9" }));
  tasks[0] = { ...tasks[0], resultCommit: await f.commit() };
  await assert.rejects(check(), /package-version metadata/u);
  tasks[0] = { ...tasks[0], resultCommit: f.base };
  await check(); // Empty result still checks its commit object, never literal true.
  const missing = "a".repeat(40);
  await assert.rejects(assertNativeTaskHistories({ git: f.git, baseCommit: missing,
    tasks: [{ taskId: "missing", baseCommit: missing, resultCommit: missing }] }), /main-based result/u);
});

for (const directory of ["CHANGELOG.md", "package.json", "package-lock.json"]) {
  test(`combined diff retains literal root-directory ownership for ${directory}`, async t => {
    const f = await fixture(t, directory);
    await f.save(`${directory}/entry.json`, directory === "CHANGELOG.md" ? "invented Task notes\n" : JSON.stringify({ version: "9.9.9" }));
    const result = await f.commit();
    await assert.rejects(assertNativeTaskHistories({ git: f.git, baseCommit: f.base,
      tasks: [{ taskId: "directory", baseCommit: f.base, resultCommit: result }] }), /release-owned/u);
  });
}
