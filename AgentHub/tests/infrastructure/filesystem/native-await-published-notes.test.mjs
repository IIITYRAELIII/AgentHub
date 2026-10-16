import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { publicationStateFile } from "../../../src/infrastructure/persistence/publication-state.mjs";
import { archivePublishedNotesCheckout } from "../../../src/infrastructure/filesystem/native-await-published-notes-recovery.mjs";

const execute = promisify(execFile);
async function git(root, ...args) {
  return String((await execute("git", args, { cwd: root, windowsHide: true })).stdout).trim();
}
async function commit(root, message) {
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "await-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, ".gitignore"), "private.bin\n");
  await writeFile(path.join(primary, "CHANGELOG.md"), "old\n");
  const packages = version => ({
    "AgentHub/package.json": { name: "fixture", version },
    "AgentHub/package-lock.json": { version, lockfileVersion: 3, packages: { "": { name: "fixture", version } } },
  });
  for (const [file, value] of Object.entries(packages("1.0.0"))) await writeFile(path.join(primary, file), JSON.stringify(value));
  const base = await commit(primary, "main");
  await git(primary, "push", "origin", "main");
  const environment = { ...process.env, LOCALAPPDATA: root, XDG_STATE_HOME: root };
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "data"), environment });
  async function result(id) {
    const folder = path.join(root, id);
    await git(primary, "worktree", "add", "-b", id, folder, base);
    await writeFile(path.join(folder, id + ".txt"), id + "\n");
    return { taskId: id, taskRevision: 3, baseCommit: base, resultCommit: await commit(folder, id) };
  }
  const oldTask = await result("old"), selected = await result("selected");
  const request = task => ({ projectRoot: primary, workspaceId: "workspace", planRevision: task.taskId,
    approvedBaseCommit: base, frozenTasks: [task] });
  const prior = await service.prepareCandidate(request(oldTask));
  const publishedRoot = path.join(root, "publisher");
  await git(root, "clone", prior.releaseRoot, publishedRoot);
  await git(publishedRoot, "checkout", "--detach", prior.preReleaseHead);
  await writeFile(path.join(publishedRoot, "CHANGELOG.md"), "published\n");
  for (const [file, value] of Object.entries(packages("2.0.0"))) await writeFile(path.join(publishedRoot, file), JSON.stringify(value));
  const published = await commit(publishedRoot, "publish metadata");
  await git(publishedRoot, "push", origin, published + ":refs/heads/main");
  const stateFile = publicationStateFile(environment);
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ repositories: [{ root: primary, revision: published }] }));
  await git(prior.releaseRoot, "fetch", "origin", "main");
  await writeFile(path.join(prior.releaseRoot, "CHANGELOG.md"), "published\n");
  await git(prior.releaseRoot, "add", "CHANGELOG.md");
  const privateBytes = Buffer.from([0, 255, 7, 99]);
  await writeFile(path.join(prior.releaseRoot, "private.bin"), privateBytes);
  const ownerRoot = path.dirname(prior.releaseRoot), checkpointFile = path.join(ownerRoot, "checkpoint.json");
  const checkpoint = await readFile(checkpointFile), index = await readFile(path.join(prior.releaseRoot, ".git/index"));
  const original = { operationId: "original-await", taskId: selected.taskId, taskRevision: 8,
    workspaceId: "workspace", resultCommit: selected.resultCommit, argumentsHash: "a".repeat(64) };
  return { root, primary, origin, service, selected, request, prior, published, ownerRoot, checkpointFile,
    checkpoint, index, privateBytes, original, recovery: { ...request(selected), nativeAwaitRecovery: original } };
}

test("same original Await archives published notes and whole prior clone before ordinary sole-result composition", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.prepareCandidate(f.request(f.selected)), { code: "AWAIT_PREPARATION_UNKNOWN" });
  const retainedIndex = await readFile(path.join(f.prior.releaseRoot, ".git/index"));
  const inspected = await f.service.inspectNativeAwaitRecovery({ projectRoot: f.primary,
    original: f.original, frozenTasks: [f.selected] });
  await assert.rejects(f.service.prepareCandidate({ ...f.recovery, commitPrepared: async () => {
    throw new Error("definite Task CAS rejection");
  } }), /definite Task CAS rejection/u);
  assert.deepEqual(await readFile(path.join(inspected.archiveRoot, "repository/.git/index")), retainedIndex);
  const candidate = await f.service.prepareCandidate(f.recovery);
  assert.equal(candidate.manifest.cutover.originalOperationId, f.original.operationId);
  const archive = inspected.archiveRoot;
  assert.deepEqual(await readFile(path.join(archive, "repository/.git/index")), retainedIndex);
  assert.deepEqual(await readFile(path.join(archive, "checkpoint.json")), f.checkpoint);
  assert.deepEqual(await readFile(path.join(archive, "repository/private.bin")), f.privateBytes);
  assert.equal(await git(path.join(archive, "repository"), "rev-parse", "HEAD"), f.prior.preReleaseHead);
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:selected.txt"), "selected");
  await assert.rejects(git(candidate.releaseRoot, "show", "PreRelease:old.txt"));
  assert.equal(await git(f.primary, "rev-parse", "main"), f.selected.baseCommit);
  assert.equal(await git(f.primary, "status", "--porcelain"), "");
  assert.notEqual(candidate.releaseGitCommonDir, candidate.primaryGitCommonDir);
  assert.equal((await f.service.prepareCandidate(f.recovery)).preReleaseHead, candidate.preReleaseHead);
  assert.deepEqual(await readFile(path.join(archive, "repository/.git/index")), retainedIndex);
});

test("unpublished/staged/selection/original/publication drift refuse before archiving", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const inspect = original => f.service.inspectNativeAwaitRecovery({ projectRoot: f.primary,
    original, frozenTasks: [f.selected] });
  await writeFile(path.join(f.prior.releaseRoot, "CHANGELOG.md"), "foreign\n");
  await assert.rejects(inspect(f.original), /sole staged/u);
  await writeFile(path.join(f.prior.releaseRoot, "CHANGELOG.md"), "published\n");
  await writeFile(path.join(f.prior.releaseRoot, "foreign.txt"), "late\n");
  await assert.rejects(inspect(f.original), /sole staged/u);
  await rm(path.join(f.prior.releaseRoot, "foreign.txt"));
  await assert.rejects(inspect({ ...f.original, resultCommit: "b".repeat(40) }), /single original/u);
  await assert.rejects(f.service.inspectNativeAwaitRecovery({ projectRoot: f.primary,
    original: f.original, frozenTasks: [f.selected, f.selected] }), /single original/u);
  await git(f.primary, "push", "--force", "origin", f.selected.baseCommit + ":refs/heads/main");
  await assert.rejects(inspect(f.original), /publication or origin/u);
  assert.equal(await git(f.prior.releaseRoot, "rev-parse", "HEAD"), f.prior.preReleaseHead);
  assert.deepEqual(await readFile(f.checkpointFile), f.checkpoint);
});

test("durable archive intent resumes after checkpoint-move boundary and rejects another original", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  // Inject failure at the persisted intent boundary, retaining all real Git/filesystem evidence.
  const layout = { root: f.ownerRoot, primaryRoot: f.primary, releaseRoot: f.prior.releaseRoot,
    evidenceRoot: path.join(f.ownerRoot, "evidence"), checkpointFile: f.checkpointFile };
  const { assertReleaseCloneForPublication } = await import("../../../src/infrastructure/filesystem/release-git-workspace.mjs");
  const options = { layout, original: f.original, frozenTasks: [f.selected], publishedRevision: f.published,
    gitAt: async (cwd, args, options = {}) => {
      const response = await execute("git", args, { cwd, windowsHide: true, encoding: options.rawOutput ? "buffer" : "utf8" });
      return options.rawOutput ? response.stdout : response.stdout.trim();
    },
    assertClone: repositoryRoot => assertReleaseCloneForPublication({ repositoryRoot }),
    readJson: file => readFile(file, "utf8").then(JSON.parse),
    validate: async () => {},
    writeJson: async (file, value) => {
      await writeFile(file, JSON.stringify(value));
      if (value.phase === "published-notes-archived") throw new Error("crash after move");
    },
  };
  await assert.rejects(archivePublishedNotesCheckout(options), /crash after move/u);
  await assert.rejects(f.service.prepareCandidate({ ...f.recovery,
    nativeAwaitRecovery: { ...f.original, operationId: "another-await" } }), /original or publication/u);
  const candidate = await f.service.prepareCandidate(f.recovery);
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:selected.txt"), "selected");
});
