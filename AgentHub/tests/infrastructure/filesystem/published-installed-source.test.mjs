import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { installedNativeHistoryBaseline } from "../../../src/infrastructure/filesystem/local-source-baseline.mjs";

const execute = promisify(execFile);
async function fixture(t, objectFormat = "sha1") {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-published-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async args => (await execute("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git(["init", "--initial-branch=main", `--object-format=${objectFormat}`]);
  await writeFile(path.join(root, "source.mjs"), "export const published = true;\n");
  await git(["add", "source.mjs"]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "published source"]);
  const publishedRevision = await git(["rev-parse", "HEAD"]);
  const runtimeRoot = path.join(root, "runtime"), releaseId = "published-runtime";
  const release = path.join(runtimeRoot, "releases", releaseId);
  await mkdir(release, { recursive: true });
  const currentFile = path.join(runtimeRoot, "current.json");
  const manifestFile = path.join(release, "runtime-manifest.json");
  const manifest = { releaseId, publicationRevision: publishedRevision,
    sourceRoot: path.join(root, "retired-generation", "AgentHub"), files: [] };
  await writeFile(currentFile, JSON.stringify({ current: releaseId }));
  await writeFile(manifestFile, JSON.stringify(manifest));
  let sourceReads = 0;
  const sourceGit = async () => { sourceReads += 1; throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); };
  const input = { git, sourceGit, repositoryRoot: root, primaryMainCommit: publishedRevision,
    publishedRevision, tasks: [{ taskId: "ordinary-task" }], runtimeRoot, planRevision: "same-plan" };
  return { root, git, input, currentFile, manifestFile, manifest, sourceReads: () => sourceReads };
}

test("published installed source needs no retired generation checkout and grants no carry", async t => {
  const f = await fixture(t);
  const before = await readFile(f.manifestFile);
  assert.equal(await installedNativeHistoryBaseline(f.input), null);
  assert.equal(f.sourceReads(), 0);
  assert.deepEqual(await readFile(f.manifestFile), before);
  assert.equal(await f.git(["status", "--porcelain", "--untracked-files=no"]), "");
});

test("SHA256 published installed source grants no carry after generation retirement", async t => {
  const f = await fixture(t, "sha256");
  assert.equal(f.input.publishedRevision.length, 64);
  const before = await readFile(f.manifestFile);
  assert.equal(await installedNativeHistoryBaseline(f.input), null);
  assert.equal(f.sourceReads(), 0);
  assert.deepEqual(await readFile(f.manifestFile), before);
  assert.equal(await f.git(["status", "--porcelain", "--untracked-files=no"]), "");
});

test("published source refuses foreign release identity or a missing immutable commit", async t => {
  const f = await fixture(t);
  await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, releaseId: "foreign" }));
  await assert.rejects(installedNativeHistoryBaseline(f.input), /installed identity/u);
  const absent = "a".repeat(40);
  await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, publicationRevision: absent }));
  await assert.rejects(installedNativeHistoryBaseline({ ...f.input, publishedRevision: absent }));
  assert.equal(f.sourceReads(), 0);
});

test("published source rechecks pointer and manifest after Git object verification", async t => {
  const f = await fixture(t);
  for (const which of ["pointer", "manifest"]) {
    await writeFile(f.currentFile, JSON.stringify({ current: f.manifest.releaseId }));
    await writeFile(f.manifestFile, JSON.stringify(f.manifest));
    const git = async args => {
      const value = await f.git(args);
      await writeFile(which === "pointer" ? f.currentFile : f.manifestFile,
        JSON.stringify(which === "pointer" ? { current: "replacement" } : { ...f.manifest, changed: true }));
      return value;
    };
    await assert.rejects(installedNativeHistoryBaseline({ ...f.input, git }), /installed.*changed/u);
  }
  assert.equal(f.sourceReads(), 0);
});

test("legacy or different publication still requires its original retained source proof", async t => {
  const f = await fixture(t);
  for (const publicationRevision of [undefined, "b".repeat(40)]) {
    await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, publicationRevision }));
    await assert.rejects(installedNativeHistoryBaseline(f.input), /spawn git ENOENT/u);
  }
  assert.equal(f.sourceReads(), 2);
});
