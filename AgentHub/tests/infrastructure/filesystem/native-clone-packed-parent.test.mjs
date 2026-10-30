import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskGitWorkspaceService, runOwnedGit } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { mergeSelectedResults, NATIVE_RELEASE_POLICY } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { guardedPreparationGit, preparationGitInvocation, withPreparationGitIsolation }
  from "../../../src/infrastructure/filesystem/preparation-git-isolation.mjs";

test("native clone keeps packed parents readable by its own upload-pack across Windows long paths", {
  skip: process.platform !== "win32",
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-packed-parent-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const source = path.join(root, "source"), isolated = path.join(root, "isolation");
  await mkdir(source); await mkdir(path.join(isolated, "empty-hooks"), { recursive: true });
  await writeFile(path.join(isolated, "empty-gitconfig"), "");
  let mergeRoot = path.join(isolated, "native-merges");
  const padding = 270 - path.join(mergeRoot, "repository", ".git", "objects", "pack", `pack-${"0".repeat(40)}.pack`).length - 1;
  assert.ok(padding > 0);
  mergeRoot = path.join(mergeRoot, "x".repeat(padding));
  const taskGit = new TaskGitWorkspaceService({ dataDir: path.join(root, "owner"), recordTiming: () => {} });
  await taskGit.withTaskLock("packed-parent-regression", lease => withPreparationGitIsolation(isolated, async () => {
    const gitAt = (cwd, args, options = {}) => guardedPreparationGit(owner => {
      const invocation = preparationGitInvocation(args, cwd);
      const env = { ...Object.fromEntries(Object.keys(process.env).filter(key => /^GIT_/iu.test(key)).map(key => [key, undefined])), ...invocation.env };
      return runOwnedGit(invocation.args, { ...options, lease: owner, cwd, env });
    });
    await gitAt(source, ["init", "--initial-branch=main"]);
    await writeFile(path.join(source, "base.txt"), "packed parent\n");
    await gitAt(source, ["add", "base.txt"]);
    const commit = cwd => gitAt(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "synthetic"]);
    await commit(source);
    const base = await gitAt(source, ["rev-parse", "HEAD"]), sourceRefs = await gitAt(source, ["show-ref"]);
    const result = await mergeSelectedResults({ root: mergeRoot, sourceRoot: source, baseCommit: base, tasks: [],
      identity: { policy: NATIVE_RELEASE_POLICY, baseCommit: base, tasks: [] }, gitAt,
      readJson: async file => { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
      writeJson: (file, value) => writeFile(file, JSON.stringify(value) + "\n") });
    const objectPath = oid => path.join(result.root, ".git", "objects", oid.slice(0, 2), oid.slice(2));
    await assert.rejects(readFile(objectPath(base)), { code: "ENOENT" });
    const packDir = path.join(result.root, ".git", "objects", "pack");
    const packFile = path.join(packDir, (await readdir(packDir)).find(name => name.endsWith(".pack")));
    assert.equal(packFile.length, 270);
    assert.ok((await stat(packFile)).size > 0);
    assert.equal(await gitAt(result.root, ["show", `${base}:base.txt`]), "packed parent");
    await writeFile(path.join(result.root, "promoted.txt"), "new loose child\n");
    await gitAt(result.root, ["add", "promoted.txt"]); await commit(result.root);
    const promoted = await gitAt(result.root, ["rev-parse", "HEAD"]);
    assert.ok((await stat(objectPath(promoted))).isFile());
    assert.ok(objectPath(promoted).length <= 260);
    assert.equal(await gitAt(result.root, ["rev-parse", `${promoted}^`]), base);
    const consumer = path.join(root, "consumer"); await mkdir(consumer);
    await gitAt(consumer, ["init", "--initial-branch=main"]);
    // Same post-composition directory-fetch boundary as ReleaseGitWorkspaceService.
    // Client -c is deliberately not a substitute for server repository policy.
    await gitAt(consumer, ["fetch", "--no-tags", result.root, promoted]);
    assert.equal(await gitAt(consumer, ["show", `${promoted}:promoted.txt`]), "new loose child");
    assert.equal(await gitAt(consumer, ["show", `${base}:base.txt`]), "packed parent");
    assert.equal(await gitAt(consumer, ["fsck", "--strict", "--no-reflogs", promoted]), "");
    assert.equal(await gitAt(result.root, ["config", "--local", "--get", "core.longpaths"]), "true");
    assert.equal(await gitAt(source, ["show-ref"]), sourceRefs);
    t.diagnostic(JSON.stringify({ packPathLength: packFile.length, looseChildPathLength: objectPath(promoted).length,
      packedParentPhysicallyPresent: true, directClientReadBeforeFetch: true, downstreamFetchAndFullGraph: true,
      sourceRefsPreserved: true }));
  }, lease));
});
