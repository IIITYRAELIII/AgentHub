import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveExactOrderPreservingUnion } from "../../../src/infrastructure/filesystem/release-order-preserving-union.mjs";

const exec = promisify(execFile);

test("order-preserving conflict accepts only the exact dev union of both index sides", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-release-union-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (args) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  const file = path.join(root, "shared.txt");
  const commit = async (message) => {
    await git(["add", "-A"]);
    await git(["commit", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  await writeFile(file, "anchor\nend\n", "utf8");
  const base = await commit("base");
  await git(["checkout", "-b", "task"]);
  await writeFile(file, "anchor\ntask\nend\n", "utf8");
  const task = await commit("task");
  await git(["checkout", "main"]);
  await writeFile(file, "anchor\nmain\nend\n", "utf8");
  await commit("main");
  await git(["checkout", "-b", "dev"]);
  await writeFile(file, "anchor\nmain\ntask\nend\n", "utf8");
  const exact = await commit("exact union");
  await git(["checkout", "-b", "foreign", "main"]);
  await writeFile(file, "anchor\nmain\nforeign\ntask\nend\n", "utf8");
  const foreign = await commit("union with foreign baggage");
  await git(["checkout", "main"]);
  await assert.rejects(git(["merge", "--no-commit", task]));
  assert.match(await git(["diff", "--name-only", "--diff-filter=U"]), /shared\.txt/u);
  assert.equal(await resolveExactOrderPreservingUnion({
    candidateRoot: root, conflicts: ["shared.txt"], devRef: foreign,
  }), false);
  assert.equal(await resolveExactOrderPreservingUnion({
    candidateRoot: root, conflicts: ["shared.txt"], devRef: exact,
  }), true);
  assert.equal(await readFile(file, "utf8"), "anchor\nmain\ntask\nend\n");
  assert.equal(await git(["diff", "--name-only", "--diff-filter=U"]), "");
  assert.equal(await git(["rev-parse", "HEAD"]), await git(["rev-parse", "main"]));
  assert.notEqual(base, task);
});
