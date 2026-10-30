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

test("old outside-marker native-v1 review never authorizes a new identity with equal conflict stages", async t => {
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
  const reviewedBytes = `${prefix.replace("automatic header", "reviewed outside-marker header")}A\nB\n${suffix}`;
  await writeFile(path.join(repository, "shared.txt"), reviewedBytes);
  const oldResolution = await commit(repository, "resolve marker and intentional independently reviewed clean-context change");
  const refusal = await run(original, "RELEASE_NATIVE_REVIEW_REQUIRED");
  assert.ok(refusal.extraPaths.includes("shared.txt"));
  assert.equal(refusal.binding.commit, oldResolution);
  const envelope = { kind: "native-merge-review-v1", verdict: "ACCEPT", binding: refusal.binding };
  const review = { requestId: "controlled-old-review", text: `<native-merge-review>\n${JSON.stringify(envelope)}\n</native-merge-review>` };
  let oldReviewCalls = 0;
  const verifier = async (supplied, actual, identity) => {
    // Controlled verification port: proves exact binding/identity propagation,
    // not authentication by a production catalog or a genuine review receipt.
    oldReviewCalls++;
    assert.deepEqual(supplied, review); assert.deepEqual(actual, envelope.binding);
    assert.deepEqual(identity, original.identity);
  };
  const accepted = await run({ ...original, resolutionReview: review, verifyReview: verifier });
  assert.ok(oldReviewCalls > 0);
  assert.equal(accepted.head, oldResolution);
  const oldJournal = await readFile(path.join(original.root, "merge.json"));
  assert.deepEqual(JSON.parse(oldJournal).merges[1].reviewedResolution.binding, envelope.binding);

  await writeFile(path.join(b.folder, "automatic.txt"), "new B automatic contribution\n");
  const corrected = { ...b.entry, taskRevision: 2, resultCommit: await commit(b.folder, "correct B outside conflicted file") };
  const next = request([a.entry, corrected], "new-no-review");
  assert.notDeepEqual(next.identity, original.identity);
  let leakedReviewCalls = 0;
  await run({ ...next, verifyReview: async () => { leakedReviewCalls++; throw new Error("old authority was forwarded"); } },
    "RELEASE_NATIVE_MERGE_CONFLICT");
  assert.equal(leakedReviewCalls, 0);
  const current = await jsonRead(path.join(next.root, "merge.json"));
  assert.deepEqual(conflictStages(current), conflictStages(oldState), "same exact stages make the reuse candidate eligible for this negative boundary");
  assert.equal(current.next, 1); assert.equal(current.conflict.retainedResolution, undefined);
  assert.equal(current.merges.some(step => step.reviewedResolution), false);
  const currentRepo = path.join(next.root, "repository");
  assert.equal(await gitAt(currentRepo, ["rev-parse", "MERGE_HEAD"]), corrected.resultCommit);
  assert.equal(await gitAt(currentRepo, ["show", "HEAD:shared.txt"]), `${prefix}A\n${suffix}`.trim());
  const workBytes = await readFile(path.join(currentRepo, "shared.txt"), "utf8");
  assert.ok(workBytes.includes("<<<<<<< HEAD\n"));
  assert.ok(!workBytes.includes("reviewed outside-marker header"));
  assert.equal(await readFile(path.join(currentRepo, "automatic.txt"), "utf8"), "new B automatic contribution\n");
  const automaticTree = (await gitAt(currentRepo, ["merge-tree", "--write-tree", "-z", current.head, corrected.resultCommit],
    { rawOutput: true, acceptableExitCodes: [1] })).split("\0")[0];
  const automaticEntries = await treeEntries(currentRepo, automaticTree);
  for (const [file, entry] of current.conflict.automatic) {
    assert.equal(`${entry.slice(0, -2).split(" ")[0]} blob ${entry.split(" ")[1]}`, automaticEntries.get(file));
    assert.equal(await gitAt(currentRepo, ["hash-object", `--path=${file}`, file]), entry.split(" ")[1]);
  }
  assert.deepEqual(await readFile(path.join(original.root, "merge.json")), oldJournal);
  assert.equal(await git(["status", "--porcelain=v1"]), "");
  t.diagnostic(JSON.stringify({ variant, observations, oldReviewCalls, leakedReviewCalls }));
});
