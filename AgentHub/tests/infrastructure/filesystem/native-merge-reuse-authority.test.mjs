import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
const variant = "candidate";

// This is only a real Git process/JSON storage adapter. No Task, SQL, review
// receipt authentication, release runner or shared Git refs are supplied.
function gitAt(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true,
      stdio: ["pipe", options.stdoutFd ?? "pipe", "pipe"] });
    const out = [], err = [];
    child.stdout?.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      const stdout = Buffer.concat(out).toString("utf8"), stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0 && !options.acceptableExitCodes?.includes(code)) {
        reject(Object.assign(new Error(`git ${args[0]} exited ${code}: ${stderr}`), { code, stdout, stderr }));
      } else resolve(options.rawOutput ? stdout : stdout.trim());
    });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(options.input ?? "");
  });
}
const digest = value => createHash("sha256").update(value).digest("hex");
const jsonRead = file => readFile(file, "utf8").then(JSON.parse, error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const jsonWrite = (file, value) => writeFile(file, JSON.stringify(value));
const conflictStages = state => state.conflict.stages.filter(([, entry]) => !entry.endsWith(" 0"));
const treeEntries = async (repository, tree) => new Map((await gitAt(repository,
  ["ls-tree", "-r", "-z", tree], { rawOutput: true })).split("\0").filter(Boolean).map(row => {
  const i = row.indexOf("\t"); return [row.slice(i + 1), row.slice(0, i)];
}));

test("retained compatibility context needs no message approval under a new selected identity", async t => {
  const scratchParent = await mkdtemp(path.join(os.tmpdir(), "native-authority-"));
  const root = await mkdtemp(path.join(scratchParent, `${variant}-`));
  t.after(async () => {
    const info = await lstat(root);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(path.dirname(root), scratchParent);
    await rm(scratchParent, { recursive: true });
  });
  const source = path.join(root, "source"); await mkdir(source);
  const git = (args, options) => gitAt(source, args, options);
  const commit = async (cwd, message) => {
    await gitAt(cwd, ["add", "-A"]);
    await gitAt(cwd, ["-c", "user.name=Oracle", "-c", "user.email=oracle@local.invalid", "commit", "-m", message]);
    return gitAt(cwd, ["rev-parse", "HEAD"]);
  };
  await git(["init", "--initial-branch=main"]);
  await writeFile(path.join(source, ".gitattributes"), "* text eol=lf\n");
  const prefix = "automatic header\n" + Array.from({ length: 12 }, (_, i) => `stable-${i}\n`).join("");
  const suffix = Array.from({ length: 12 }, (_, i) => `tail-${i}\n`).join("");
  await writeFile(path.join(source, "shared.txt"), `${prefix}original\n${suffix}`);
  await writeFile(path.join(source, "automatic.txt"), "base automatic\n");
  const base = await commit(source, "base");
  const makeTask = async (id, content) => {
    const folder = path.join(root, id);
    await git(["worktree", "add", "-b", id, folder, base]);
    await writeFile(path.join(folder, "shared.txt"), `${prefix}${content}\n${suffix}`);
    return { folder, entry: { taskId: id, taskRevision: 1, baseCommit: base, resultCommit: await commit(folder, id) } };
  };
  const a = await makeTask("A", "A"), b = await makeTask("B", "B");
  const captures = path.join(root, "captures"); await mkdir(captures);
  const context = { repositoryRoot: source, primaryGitCommonDir: path.join(source, ".git"),
    baseProvenance: { schemaVersion: 1, kind: "agreed-main-native-git-v1", agreedMainCommit: base, publishedBaseCommit: base } };
  const request = (tasks, revision) => {
    const identity = { policy: "main-selected-git-merge-v1", workspaceId: "fixture", planRevision: revision, baseCommit: base, tasks };
    return { root: path.join(captures, digest(JSON.stringify(identity)).slice(0, 24)), sourceRoot: source,
      baseCommit: base, tasks, identity, reuseContext: context, gitAt, readJson: jsonRead, writeJson: jsonWrite };
  };
  const observations = [], run = async (input, expectedCode = null) => {
    const started = performance.now(); let outcome;
    try {
      const result = await mergeSelectedResults(input);
      assert.equal(expectedCode, null, "expected refusal must not silently succeed");
      outcome = "success"; return result;
    } catch (error) {
      outcome = error.code ?? error.message;
      if (!expectedCode) throw error;
      assert.equal(error.code, expectedCode); return error;
    } finally { observations.push({ revision: input.identity.planRevision, outcome, durationMs: performance.now() - started }); }
  };
  const original = request([a.entry, b.entry], "old-reviewed");
  await run(original, "RELEASE_NATIVE_MERGE_CONFLICT");
  const oldState = await jsonRead(path.join(original.root, "merge.json"));
  const repository = path.join(original.root, "repository");
  const resolvedBytes = `${prefix.replace("automatic header", "owned outside-marker header")}A\nB\n${suffix}`;
  await writeFile(path.join(repository, "shared.txt"), resolvedBytes);
  const oldResolution = await commit(repository, "resolve marker and intentional independently reviewed clean-context change");
  const accepted = await run(original);
  assert.equal(accepted.head, oldResolution);
  const oldJournal = await readFile(path.join(original.root, "merge.json"));
  assert.equal(JSON.parse(oldJournal).merges[1].resolution.binding.commit, oldResolution);

  await writeFile(path.join(b.folder, "automatic.txt"), "new B automatic contribution\n");
  const corrected = { ...b.entry, taskRevision: 2, resultCommit: await commit(b.folder, "correct B outside conflicted file") };
  const next = request([a.entry, corrected], "new-no-review");
  assert.notDeepEqual(next.identity, original.identity);
  const result = await run(next);
  const current = await jsonRead(path.join(next.root, "merge.json"));
  assert.equal(current.next, 2);
  assert.equal(current.conflict, null);
  assert.equal(current.merges.some(step => step.reviewedResolution), false);
  const currentRepo = path.join(next.root, "repository");
  assert.equal(await gitAt(currentRepo, ["show", "HEAD:shared.txt"]), resolvedBytes.trim());
  assert.equal(await readFile(path.join(currentRepo, "automatic.txt"), "utf8"), "new B automatic contribution\n");
  assert.deepEqual((await gitAt(currentRepo, ["show", "-s", "--format=%P", result.head])).split(" "),
    [current.merges[0].commit, corrected.resultCommit]);
  const automaticTree = (await gitAt(currentRepo, ["merge-tree", "--write-tree", "-z", current.merges[0].commit, corrected.resultCommit],
    { rawOutput: true, acceptableExitCodes: [1] })).split("\0")[0];
  const automaticEntries = await treeEntries(currentRepo, automaticTree);
  const actualEntries = await treeEntries(currentRepo, result.head);
  for (const file of new Set([...automaticEntries.keys(), ...actualEntries.keys()])) {
    if (file !== "shared.txt") assert.equal(actualEntries.get(file), automaticEntries.get(file));
  }
  assert.deepEqual(await readFile(path.join(original.root, "merge.json")), oldJournal);
  assert.equal(await git(["status", "--porcelain=v1"]), "");
  t.diagnostic(JSON.stringify({ variant, observations }));
});
