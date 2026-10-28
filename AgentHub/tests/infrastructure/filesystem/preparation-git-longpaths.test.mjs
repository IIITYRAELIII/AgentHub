import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskGitWorkspaceService, runOwnedGit } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { mergeSelectedResults, NATIVE_RELEASE_POLICY } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { guardedPreparationGit, preparationGitInvocation, withPreparationGitIsolation }
  from "../../../src/infrastructure/filesystem/preparation-git-isolation.mjs";

test("isolated native preparation transports real pack descendants beyond Windows MAX_PATH", {
  skip: process.platform !== "win32",
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-preparation-longpath-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const source = path.join(root, "source"), dataDir = path.join(root, "owner");
  const isolated = path.join(root, "isolation");
  await mkdir(source);
  await mkdir(path.join(isolated, "empty-hooks"), { recursive: true });
  await writeFile(path.join(isolated, "empty-gitconfig"), "");
  let mergeRoot = path.join(isolated, "native-merges");
  const packName = `pack-${"0".repeat(40)}.pack`;
  // Keep the Git directory below Git's separate setup.c root-length guard;
  // exercise the intended long descendant, not that independent tool limit.
  const padding = 280 - path.join(mergeRoot, "repository", ".git", "objects", "pack", packName).length - 1;
  if (padding > 0) mergeRoot = path.join(mergeRoot, "x".repeat(padding));
  const taskGit = new TaskGitWorkspaceService({ dataDir, recordTiming: () => {} });
  // Poison only this test process's inherited command-config input. The real
  // isolation owner must keep it out of every local Git child, including clone.
  const inherited = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const prior = new Map(inherited.map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "fixture.untrusted", GIT_CONFIG_VALUE_0: "inherited" });
  try {
    await taskGit.withTaskLock("longpath-regression", lease => withPreparationGitIsolation(isolated, async () => {
      // This is the same existing owner route used by ReleaseGitWorkspaceService:
      // scoped preparation queue -> sanitized invocation -> real guarded Git.
      const gitAt = (cwd, args, options = {}) => guardedPreparationGit(owner => {
        const invocation = preparationGitInvocation(args, cwd);
        const env = { ...Object.fromEntries(Object.keys(process.env).filter(key => /^GIT_/iu.test(key))
          .map(key => [key, undefined])), ...invocation.env };
        return runOwnedGit(invocation.args, { ...options, lease: owner, cwd, env });
      });
      await gitAt(source, ["init", "--initial-branch=main"]);
      await writeFile(path.join(source, "base.txt"), "synthetic native transport\n");
      await gitAt(source, ["add", "base.txt"]);
      await gitAt(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "base"]);
      const base = await gitAt(source, ["rev-parse", "HEAD"]);
      const sourceRefs = await gitAt(source, ["show-ref"]);
      const result = await mergeSelectedResults({ root: mergeRoot, sourceRoot: source, baseCommit: base,
        tasks: [], identity: { policy: NATIVE_RELEASE_POLICY, baseCommit: base, tasks: [] }, gitAt,
        readJson: async file => {
          try { return JSON.parse(await readFile(file, "utf8")); }
          catch (error) { if (error.code === "ENOENT") return null; throw error; }
        },
        writeJson: (file, value) => writeFile(file, `${JSON.stringify(value)}\n`),
      });
      const packDirectory = path.join(result.root, ".git", "objects", "pack");
      const packs = (await readdir(packDirectory)).filter(name => /^pack-[a-f0-9]{40}\.(?:pack|idx)$/u.test(name));
      assert.ok(packs.some(name => name.endsWith(".pack")) && packs.some(name => name.endsWith(".idx")),
        "the actual native bundle consumer must create a real pack and index");
      const descendants = await Promise.all(packs.map(async name => {
        const file = path.join(packDirectory, name);
        const info = await stat(file);
        assert.ok(file.length > 260 && info.isFile() && info.size > 0);
        return { pathLength: file.length, bytes: info.size, extension: path.extname(name) };
      }));
      assert.equal(result.head, base);
      assert.equal(await readFile(path.join(result.root, "base.txt"), "utf8"), "synthetic native transport\n");
      assert.equal(await gitAt(source, ["show-ref"]), sourceRefs, "transport must not change source refs");
      assert.equal(await gitAt(result.root, ["config", "--get", "core.longpaths"]), "true");
      assert.equal(await gitAt(result.root, ["config", "--local", "--get", "core.longpaths"], { acceptableExitCodes: [1] }), "",
        "long-path support is invocation-local, not a repository configuration write");
      assert.equal(await gitAt(result.root, ["config", "--get", "fixture.untrusted"], { acceptableExitCodes: [1] }), "");
      assert.equal(path.resolve(await gitAt(result.root, ["config", "--get", "core.hooksPath"])), path.join(isolated, "empty-hooks"));
      assert.equal(await gitAt(result.root, ["config", "--get", "core.fsmonitor"]), "false");
      assert.equal(await gitAt(result.root, ["config", "--get", "maintenance.auto"]), "false");
      assert.equal(await gitAt(result.root, ["fsck", "--strict"]), "");
      t.diagnostic(JSON.stringify({ realPackDescendants: descendants, nativeHead: result.head, sourceRefsPreserved: true,
        inheritedGitConfigAbsent: true, existingGuardedOwner: true }));
    }, lease));
  } finally {
    for (const key of inherited) {
      if (prior.get(key) === undefined) delete process.env[key]; else process.env[key] = prior.get(key);
    }
  }
});
