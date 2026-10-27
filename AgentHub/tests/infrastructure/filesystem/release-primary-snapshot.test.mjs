import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";

const exec = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function git(root, args) {
  const { stdout } = await exec("git", args, { cwd: root, windowsHide: true, encoding: "utf8" });
  return stdout.trim();
}
async function fixture(t, format = "sha1") {
  const parent = await mkdtemp(path.join(os.tmpdir(), "h347s-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo space [unicode-Ж]");
  await mkdir(root);
  await git(root, ["init", "--initial-branch=main", `--object-format=${format}`]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "tracked.txt"), "original\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(parent, "data") });
  return { parent, root, service };
}

// Independent oracle for the existing public evidence, including the exact
// staged/index and physical dirty-byte semantics. No production parser reuse.
async function expected(root) {
  const unstaged = await git(root, ["diff", "--name-only", "-z", "--"]);
  const staged = await git(root, ["diff", "--cached", "--name-only", "-z", "--"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const index = await git(root, ["ls-files", "--stage", "-z"]);
  const paths = [...new Set([unstaged, staged, untracked].flatMap(s => s.split("\0").filter(Boolean)))].sort();
  const files = [];
  for (const file of paths) {
    const bytes = await readFile(path.join(root, file)).catch(error => {
      if (["ENOENT", "EISDIR"].includes(error.code)) return null;
      throw error;
    });
    files.push({ path: file, sha256: bytes === null ? null : hash(bytes) });
  }
  return { projectRoot: path.resolve(await git(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"])),
    gitCommonDir: path.resolve(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
    branch: await git(root, ["symbolic-ref", "--quiet", "HEAD"]),
    headCommit: await git(root, ["rev-parse", "HEAD^{commit}"]),
    mainCommit: await git(root, ["rev-parse", "refs/heads/main^{commit}"]),
    dirtyFingerprint: hash(JSON.stringify(files)), indexFingerprint: hash(index), dirtyPaths: paths,
    legacyLinkedHolders: [] };
}

test("primary snapshot batches fresh revisions without changing any public evidence", async t => {
  const f = await fixture(t);
  const trace = path.join(f.parent, "git-trace.jsonl");
  const previous = process.env.GIT_TRACE2_EVENT;
  let actual;
  try {
    process.env.GIT_TRACE2_EVENT = trace;
    actual = await f.service.assertPrimaryInvariant(f.root);
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
  assert.deepEqual(actual, await expected(f.root));
  const starts = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse)
    .filter(row => row.event === "start" && !row.sid.includes("/"));
  assert.equal(starts.length, 8);
  await git(f.root, ["commit", "--allow-empty", "-m", "fresh main"]);
  const next = await f.service.assertPrimaryInvariant(f.root);
  assert.notEqual(next.headCommit, actual.headCommit);
  assert.deepEqual(next, await expected(f.root));
});

test("primary snapshot preserves staged reversions, renames, deletions and odd dirty paths", async t => {
  const f = await fixture(t);
  const check = async () => assert.deepEqual(await f.service.assertPrimaryInvariant(f.root), await expected(f.root));
  await check();
  await writeFile(path.join(f.root, "tracked.txt"), "unstaged\n"); await check();
  await git(f.root, ["add", "."]); await check();
  // Index differs while the physical file is back at HEAD: net diff HEAD is insufficient.
  await writeFile(path.join(f.root, "tracked.txt"), "original\n"); await check();
  await git(f.root, ["restore", "--staged", "tracked.txt"]);
  const odd = "renamed [Ж] ' #$.txt";
  await rename(path.join(f.root, "tracked.txt"), path.join(f.root, odd)); await check();
  await git(f.root, ["add", "-A"]); await check();
  await writeFile(path.join(f.root, odd), "modified renamed\n"); await check();
  await git(f.root, ["config", "diff.renames", "false"]); await check();
  await writeFile(path.join(f.root, "untracked odd [Я].txt"), "untracked\n"); await check();
  await rm(path.join(f.root, odd)); await check();
  await git(f.root, ["add", "-A"]); await check();
});

test("primary snapshot retains detached, foreign branch, unborn and bare refusals", async t => {
  const f = await fixture(t);
  const initial = await git(f.root, ["rev-parse", "HEAD"]);
  await git(f.root, ["checkout", "--detach"]);
  await assert.rejects(f.service.assertPrimaryInvariant(f.root), /HEAD must remain attached/u);
  await git(f.root, ["checkout", "-b", "other"]);
  await git(f.root, ["branch", "-D", "main"]);
  await assert.rejects(f.service.assertPrimaryInvariant(f.root), /HEAD must remain attached/u);
  assert.equal(await git(f.root, ["rev-parse", "HEAD"]), initial);
  const bare = path.join(f.parent, "bare.git"), unborn = path.join(f.parent, "unborn");
  await git(f.root, ["init", "--bare", bare]);
  await git(f.root, ["init", "--initial-branch=main", unborn]);
  await assert.rejects(f.service.assertPrimaryInvariant(bare));
  await assert.rejects(f.service.assertPrimaryInvariant(unborn));
  assert.equal(await git(unborn, ["symbolic-ref", "HEAD"]), "refs/heads/main");
});

test("primary snapshot preserves recursive symbolic refs and SHA256 commit identity", async t => {
  const f = await fixture(t, "sha256");
  await git(f.root, ["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
  await git(f.root, ["symbolic-ref", "HEAD", "refs/heads/alias"]);
  const actual = await f.service.assertPrimaryInvariant(f.root);
  assert.equal(actual.headCommit.length, 64);
  assert.deepEqual(actual, await expected(f.root));
});

test("primary snapshot preserves legacy linked release holder evidence", async t => {
  const f = await fixture(t);
  const holder = path.join(f.parent, "legacy-release");
  await git(f.root, ["worktree", "add", "-b", "PreRelease", holder]);
  assert.deepEqual((await f.service.assertPrimaryInvariant(f.root)).legacyLinkedHolders,
    [{ path: holder, branchRef: "refs/heads/PreRelease", detached: false }]);
  assert.equal(await git(f.root, ["symbolic-ref", "HEAD"]), "refs/heads/main");
  assert.equal(await git(f.root, ["status", "--porcelain=v1"]), "");
});

test("primary snapshot preserves symbolic HEAD when a tag is also named HEAD", async t => {
  const f = await fixture(t);
  await git(f.root, ["tag", "HEAD"]);
  await git(f.root, ["commit", "--allow-empty", "-m", "new actual HEAD"]);
  assert.deepEqual(await f.service.assertPrimaryInvariant(f.root), await expected(f.root));
});
