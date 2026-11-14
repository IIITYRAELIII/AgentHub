import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
}
async function commit(cwd, name) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}
async function fixture(t, { parent = os.tmpdir() } = {}) {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "ah-comp-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, "app.txt"), "base\n");
  const base = await commit(primary, "base");
  await git(primary, "push", "origin", "main");
  const dataDir = path.join(root, "data");
  const service = new ReleaseGitWorkspaceService({ dataDir });
  async function result(branch, content) {
    const worktree = path.join(root, branch);
    await git(primary, "worktree", "add", "-b", branch, worktree, base);
    await writeFile(path.join(worktree, "app.txt"), content);
    return commit(worktree, branch);
  }
  const left = await result("left", "left\n");
  const request = {
    workspaceId: "workspace", projectRoot: primary, approvedBaseCommit: base, planRevision: "plan-left",
    frozenTasks: [{ taskId: "left", taskRevision: 1, baseCommit: base, resultCommit: left }],
  };
  return { root, primary, dataDir, service, result, request, left };
}
async function snapshot(directory) {
  const files = {};
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(directory, file)] = (await readFile(file)).toString("base64");
    }
  }
  await visit(directory);
  return files;
}

test("composition scratch follows native object storage independently of system TEMP", async t => {
  // On a C: TEMP / D: checkout this exercises the actual EXDEV topology. On a
  // single-volume runner it still verifies placement, isolation and cleanup.
  const parent = fileURLToPath(new URL("../../../WIP/", import.meta.url));
  const f = await fixture(t, { parent });
  const systemTemp = os.tmpdir(), tempEnvironment = [process.env.TMP, process.env.TEMP];
  t.diagnostic(`system TEMP device=${(await stat(systemTemp)).dev}; data device=${(await stat(f.root)).dev}`);
  const refs = await git(f.primary, "show-ref");
  const candidateRoot = path.join(f.dataDir, "release-repositories");
  const scratch = async () => (await readdir(f.dataDir)).filter(name => name.startsWith("ah-composition-"));
  for (const phase of ["fresh", "prepared", "frozen"]) {
    if (phase === "prepared") await f.service.prepareCandidate(f.request);
    if (phase === "frozen") {
      const file = path.join(candidateRoot, taskRepositoryKey(f.primary), "checkpoint.json");
      const checkpoint = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...checkpoint, phase }));
    }
    const before = await snapshot(candidateRoot);
    let checks = 0;
    const validateBeforeCommit = async () => {
      const roots = await scratch();
      assert.equal(roots.length, 1);
      assert.equal(os.tmpdir(), systemTemp);
      assert.deepEqual([process.env.TMP, process.env.TEMP], tempEnvironment);
      if (phase !== "prepared") {
        const repository = path.join(f.dataDir, roots[0], "release-repositories", taskRepositoryKey(f.primary), "repository");
        const objects = path.join(repository, ".git", "objects", "pack");
        const index = (await readdir(objects)).find(name => name.endsWith(".idx"));
        assert.ok(index);
        const consumer = await stat(path.join(objects, index));
        const donor = await stat(path.join(f.dataDir, "native-git-objects", "sha1", "objects.git", "objects", "pack", index));
        assert.deepEqual([consumer.dev, consumer.ino, consumer.size], [donor.dev, donor.ino, donor.size]);
        const isolatedConfig = await stat(path.join(repository, ".git", "config"));
        const primaryConfig = await stat(path.join(f.primary, ".git", "config"));
        assert.notDeepEqual([isolatedConfig.dev, isolatedConfig.ino], [primaryConfig.dev, primaryConfig.ino]);
      }
      checks++;
    };
    const proof = await f.service.validateCandidate({ ...f.request, validateBeforeCommit });
    assert.equal(proof.tree, await git(f.primary, "rev-parse", `${f.left}^{tree}`));
    assert.ok(checks > 0);
    assert.deepEqual(await scratch(), []);
    assert.deepEqual(await snapshot(candidateRoot), before);
    await assert.rejects(f.service.validateCandidate({ ...f.request, validateBeforeCommit: async () => {
      await validateBeforeCommit();
      throw new Error("fresh authority revoked");
    } }), /fresh authority revoked/u);
    assert.deepEqual(await scratch(), []);
    assert.deepEqual(await snapshot(candidateRoot), before);
    assert.equal(await git(f.primary, "show-ref"), refs);
    assert.equal(await git(f.primary, "status", "--porcelain"), "");
  }
});
