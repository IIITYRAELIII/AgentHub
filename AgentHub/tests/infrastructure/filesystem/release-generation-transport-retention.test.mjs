import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import { withInterprocessLocks } from "../../../src/infrastructure/process/interprocess-lock.mjs";

const exec = promisify(execFile);
const sha = value => createHash("sha256").update(value).digest("hex");
async function git(cwd, args, { input } = {}) {
  if (input == null) return String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = [];
    child.stdout.on("data", chunk => out.push(chunk)); child.stderr.on("data", chunk => err.push(chunk));
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(Buffer.concat(out).toString("utf8").trim()) : reject(new Error(Buffer.concat(err).toString("utf8"))));
    child.stdin.end(input);
  });
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "release-transport-")));
  await writeFile(path.join(root, "OWN-TEST-FIXTURE"), "release transport test only");
  t.after(async () => {
    assert.equal(await realpath(root), root);
    assert.ok(path.basename(root).startsWith("release-transport-"));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(root, "OWN-TEST-FIXTURE"), "utf8"), "release transport test only");
    await rm(root, { recursive: true });
  });
  const source = path.join(root, "source");
  await git(root, ["init", "--initial-branch=main", source]);
  await git(source, ["config", "core.autocrlf", "false"]);
  await git(source, ["config", "user.name", "Fixture"]); await git(source, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(source, "app.txt"), "published\n");
  await writeFile(path.join(source, ".gitignore"), "WIP/\n");
  await writeFile(path.join(source, ".gitattributes"), "* text eol=lf\n");
  await git(source, ["add", "."]); await git(source, ["commit", "-m", "published fixture"]);
  const commit = await git(source, ["rev-parse", "HEAD"]), tree = await git(source, ["rev-parse", "HEAD^{tree}"]);
  const dataDir = path.join(root, "data"), identity = { schemaVersion: 1, operationId: "fixture-operation", generation: 1, repositoryRoot: source };
  identity.identitySha256 = sha(`${identity.operationId}:${identity.generation}:${source}`);
  const id = identity.identitySha256.slice(0, 24), generationRoot = path.join(dataDir, "release-gens", id);
  const ownerRoot = path.join(generationRoot, "release-repositories", taskRepositoryKey(source));
  const repository = path.join(ownerRoot, "repository");
  await mkdir(path.join(ownerRoot, "evidence"), { recursive: true });
  await git(root, ["clone", "--no-local", "--no-hardlinks", source, repository]);
  await git(repository, ["config", "core.autocrlf", "false"]);
  await mkdir(path.join(repository, ".git", "objects", "info"), { recursive: true });
  await writeFile(path.join(generationRoot, "identity.json"), JSON.stringify(identity));
  await writeFile(path.join(repository, ".git", "agent-hub-release-clone.json"), JSON.stringify({
    kind: "agent-hub-owned-release-clone", primaryRoot: source, releaseRoot: repository }));
  const manifest = Buffer.from(JSON.stringify({ source: "immutable release evidence", tasks: ["fixture"] }));
  const manifestHash = sha(manifest);
  await writeFile(path.join(ownerRoot, "evidence", manifestHash + ".json"), manifest);
  const checkpoint = { phase: "frozen", preReleaseHead: commit, manifestHash };
  await writeFile(path.join(ownerRoot, "checkpoint.json"), JSON.stringify(checkpoint));
  const bundle = path.join(generationRoot, "source.bundle");
  await git(source, ["bundle", "create", bundle, "--all"]);
  let proof = { operationId: identity.operationId, generation: 1, operationRevision: 9,
    completedAt: "2026-10-21T00:00:00Z", identitySha256: "a".repeat(64),
    candidates: [{ repositoryRoot: source, releaseRoot: repository, generationRoot, commit, tree, manifestHash }] };
  const service = new ReleaseGitWorkspaceService({ dataDir });
  const retention = service.storageRetentionOwner({ readGeneration: () => proof });
  // Exercise eligibility on all platforms; actual native effects below remain
  // Windows-only and use the unchanged production deletion port.
  retention.platform = "win32";
  return { root, dataDir, generationRoot, repository, source, bundle, ownerRoot, commit, checkpoint,
    retention, candidate: { id, cursor: id }, setProof: next => { proof = next; }, proof };
}

test("completed release transport retires only the exact bundle and preserves repository/evidence/ignored WIP", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.repository, "WIP"));
  await writeFile(path.join(f.repository, "WIP", "useful.txt"), "preserve private unfinished work");
  const refs = await git(f.repository, ["show-ref"]);
  const bytes = (await lstat(f.bundle)).size;
  const page = await f.retention.list({ after: null, limit: 1 });
  assert.deepEqual(page, { items: [f.candidate], done: true });
  const preview = await f.retention.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const result = await f.retention.prune({ candidate: f.candidate, binding: preview.binding, operationId: "original-child" });
  assert.equal(result.status, "removed"); assert.equal(result.logicalBytes, bytes);
  await assert.rejects(lstat(f.bundle), { code: "ENOENT" });
  assert.equal(await git(f.repository, ["rev-parse", "HEAD"]), f.commit);
  assert.equal(await git(f.repository, ["show-ref"]), refs);
  assert.equal(await readFile(path.join(f.repository, "WIP", "useful.txt"), "utf8"), "preserve private unfinished work");
  assert.deepEqual(JSON.parse(await readFile(path.join(f.ownerRoot, "checkpoint.json"))), f.checkpoint);
  assert.equal((await f.retention.reconcile({ candidate: f.candidate, binding: preview.binding })).status, "already-removed");
  assert.equal((await f.retention.preview({ candidate: f.candidate })).status, "retained");
});

test("unknown publication, dirty work and borrowed or partial objects never acquire bundle deletion", async t => {
  const f = await fixture(t);
  const before = sha(await readFile(f.bundle));
  f.setProof(null);
  assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-not-completed-published");
  f.setProof(f.proof);
  await writeFile(path.join(f.repository, "untracked.txt"), "useful");
  assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-capture-work-pinned");
  await rm(path.join(f.repository, "untracked.txt"));
  const alternates = path.join(f.repository, ".git", "objects", "info", "alternates");
  await writeFile(alternates, path.join(f.source, ".git", "objects"));
  assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-borrowed-objects");
  await rm(alternates);
  await git(f.repository, ["config", "remote.origin.promisor", "true"]);
  assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-borrowed-objects");
  assert.equal(sha(await readFile(f.bundle)), before);
});

test("a changed advertised root missing from the independent clone is retained", async t => {
  const f = await fixture(t);
  await git(f.source, ["checkout", "-b", "unpublished-extra"]);
  await writeFile(path.join(f.source, "extra.txt"), "not in independent clone");
  await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "extra"]);
  await rm(f.bundle); await git(f.source, ["bundle", "create", f.bundle, "--all"]);
  const preview = await f.retention.preview({ candidate: f.candidate });
  assert.equal(preview.reason, "release-bundle-objects-unavailable", JSON.stringify(preview));
  assert.ok((await lstat(f.bundle)).isFile());
});

test("locally present but unanchored advertised history is retained across future Git GC", async t => {
  const f = await fixture(t);
  await git(f.source, ["checkout", "-b", "unpublished-extra"]);
  await writeFile(path.join(f.source, "extra.txt"), "unanchored history");
  await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "extra"]);
  const extra = await git(f.source, ["rev-parse", "HEAD"]);
  await git(f.source, ["checkout", "main"]);
  await git(f.repository, ["fetch", "--no-write-fetch-head", f.source, extra]);
  await git(f.repository, ["cat-file", "-e", extra]);
  await rm(f.bundle); await git(f.source, ["bundle", "create", f.bundle, "--all"]);
  assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-bundle-roots-unanchored");
  assert.ok((await lstat(f.bundle)).isFile());
});

test("generation lease serializes transport retirement with the existing generation owner", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const flight = withInterprocessLocks([path.join(f.dataDir, "locks", "release-generation-" + f.candidate.id)], async () => { enter(); await wait; });
  await entered;
  let settled = false;
  const preview = f.retention.preview({ candidate: f.candidate }).finally(() => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false, "the same resource's process-local lease queues instead of racing its owner");
  } finally { release(); await flight; }
  assert.equal((await preview).status, "eligible");
  assert.ok((await lstat(f.bundle)).isFile());
});

test("a still-active release is retained without joining its held generation queue", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.setProof(null);
  await withInterprocessLocks([path.join(f.dataDir, "locks", "release-generation-" + f.candidate.id)], async () => {
    assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-not-completed-published");
  });
  assert.ok((await lstat(f.bundle)).isFile());
});

test("a lost native delete reply reconciles the original absence and never submits another effect", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const preview = await f.retention.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const effect = f.retention.deleteTransport;
  let calls = 0;
  f.retention.deleteTransport = async (...args) => { calls++; await effect(...args); throw new Error("fixture lost reply"); };
  await assert.rejects(f.retention.prune({ candidate: f.candidate, binding: preview.binding }), /lost reply/);
  assert.equal((await f.retention.reconcile({ candidate: f.candidate, binding: preview.binding })).status, "already-removed");
  assert.equal(calls, 1);
});

test("same-name changed bundle or changed release proof cannot reuse an old preview", async t => {
  const f = await fixture(t);
  const preview = await f.retention.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  f.setProof({ ...f.proof, operationRevision: 10 });
  const result = await f.retention.prune({ candidate: f.candidate, binding: preview.binding });
  assert.equal(result.reason, "release-preview-changed");
  assert.equal((await f.retention.reconcile({ candidate: f.candidate, binding: preview.binding })).status, "unknown");
  f.setProof(f.proof);
  await writeFile(f.bundle, Buffer.from("foreign late bytes"));
  assert.equal((await f.retention.preview({ candidate: f.candidate })).status, "retained");
  assert.equal(await readFile(f.bundle, "utf8"), "foreign late bytes");
});

test("a hardlinked transport and substituted generation junction retain every foreign byte", async t => {
  const f = await fixture(t);
  const copy = path.join(f.root, "keep.bundle"), before = sha(await readFile(f.bundle));
  await link(f.bundle, copy);
  assert.equal((await f.retention.preview({ candidate: f.candidate })).status, "retained");
  await rm(copy);
  const foreign = path.join(f.root, "foreign"), saved = f.generationRoot + "-saved";
  await mkdir(foreign); await writeFile(path.join(foreign, "sentinel.txt"), "keep foreign bytes");
  await rename(f.generationRoot, saved);
  await symlink(foreign, f.generationRoot, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.equal((await f.retention.preview({ candidate: f.candidate })).status, "retained");
    assert.equal(await readFile(path.join(foreign, "sentinel.txt"), "utf8"), "keep foreign bytes");
  } finally {
    assert.equal((await lstat(f.generationRoot)).isSymbolicLink(), true);
    if (process.platform === "win32") await rmdir(f.generationRoot); else await rm(f.generationRoot);
    await rename(saved, f.generationRoot);
  }
  assert.equal(sha(await readFile(f.bundle)), before);
});
