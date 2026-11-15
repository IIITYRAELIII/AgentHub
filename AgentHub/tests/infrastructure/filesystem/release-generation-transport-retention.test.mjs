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
import { ReleaseOperationService } from "../../../src/application/release-operation-service.mjs";
import { ReleaseOperationStore } from "../../../src/infrastructure/persistence/release-operation-store.mjs";
import { resolveTestSelection } from "../../../src/domain/test-selection.mjs";
import { readBundleHeads } from "../../../src/infrastructure/filesystem/retained-bundle-heads.mjs";

const exec = promisify(execFile);
const sha = value => createHash("sha256").update(value).digest("hex");
async function git(cwd, args, { input } = {}) {
  args = ["-c", "core.longpaths=true", ...args];
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
  await git(repository, ["config", "core.longpaths", "true"]);
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

test("rewritten history or an ambient borrowed object store never supplies local retirement proof", async t => {
  const f = await fixture(t), before = sha(await readFile(f.bundle));
  const grafts = path.join(f.repository, ".git", "info", "grafts");
  await writeFile(grafts, f.commit + "\n");
  assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-rewritten-object-history");
  await rm(grafts);
  const prior = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(f.source, ".git", "objects");
  try { assert.equal((await f.retention.preview({ candidate: f.candidate })).status, "retained"); }
  finally {
    if (prior === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = prior;
  }
  assert.equal(sha(await readFile(f.bundle)), before);
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

test("an unanchored annotated tag is retained even when its peeled commit is published", async t => {
  const f = await fixture(t);
  await git(f.source, ["tag", "-a", "capture-tag", "-m", "unique tag metadata", f.commit]);
  const tag = await git(f.source, ["rev-parse", "refs/tags/capture-tag"]);
  await git(f.repository, ["fetch", "--no-tags", "--no-write-fetch-head", f.source, tag]);
  const metadata = await git(f.repository, ["cat-file", "tag", tag]);
  await rm(f.bundle); await git(f.source, ["bundle", "create", f.bundle, "--all"]);
  const before = sha(await readFile(f.bundle)), refs = await git(f.repository, ["show-ref"]);
  assert.equal(await git(f.repository, ["rev-parse", tag + "^{commit}"]), f.commit);
  assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-bundle-roots-unanchored");
  assert.equal(sha(await readFile(f.bundle)), before);
  assert.equal(await git(f.repository, ["cat-file", "tag", tag]), metadata);
  assert.equal(await git(f.repository, ["show-ref"]), refs);
  // A same-name lightweight tag still anchors only the commit, not the tag object.
  await git(f.repository, ["update-ref", "refs/tags/capture-tag", f.commit]);
  assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-bundle-roots-unanchored");
  assert.equal(sha(await readFile(f.bundle)), before);
});

test("retained annotated tags and a tag chain survive native bundle retirement and Git GC", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await git(f.source, ["tag", "-a", "inner", "-m", "inner metadata", f.commit]);
  await git(f.source, ["tag", "-a", "outer", "-m", "outer metadata", "refs/tags/inner"]);
  await git(f.repository, ["fetch", "--no-write-fetch-head", f.source, "refs/tags/inner:refs/tags/inner", "refs/tags/outer:refs/tags/outer"]);
  const inner = await git(f.repository, ["rev-parse", "refs/tags/inner"]), outer = await git(f.repository, ["rev-parse", "refs/tags/outer"]);
  const tags = await Promise.all([inner, outer].map(oid => git(f.repository, ["cat-file", "tag", oid])));
  const refs = await git(f.repository, ["show-ref"]);
  await rm(f.bundle); await git(f.source, ["bundle", "create", f.bundle, "--all"]);
  const preview = await f.retention.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  assert.equal((await f.retention.prune({ candidate: f.candidate, binding: preview.binding })).status, "removed");
  await assert.rejects(lstat(f.bundle), { code: "ENOENT" });
  await git(f.repository, ["gc", "--prune=now"]);
  assert.deepEqual(await Promise.all([inner, outer].map(oid => git(f.repository, ["cat-file", "tag", oid]))), tags);
  assert.equal(await git(f.repository, ["show-ref"]), refs);
  assert.equal(await git(f.repository, ["rev-parse", "HEAD"]), f.commit);
});

test("tag ref loss after the fresh preview refuses the before-effect original-root check", async t => {
  const f = await fixture(t);
  await git(f.source, ["tag", "-a", "capture-tag", "-m", "preserve tag metadata", f.commit]);
  await git(f.repository, ["fetch", "--no-write-fetch-head", f.source, "refs/tags/capture-tag:refs/tags/capture-tag"]);
  await rm(f.bundle); await git(f.source, ["bundle", "create", f.bundle, "--all"]);
  const before = sha(await readFile(f.bundle));
  const preview = await f.retention.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const gitAt = f.retention.gitAt;
  let removedRef = false, effects = 0;
  f.retention.gitAt = async (root, args, options) => {
    const result = await gitAt(root, args, options);
    if (!removedRef && args[0] === "show-ref") {
      removedRef = true;
      await git(f.repository, ["update-ref", "-d", "refs/tags/capture-tag"]);
    }
    return result;
  };
  f.retention.deleteTransport = async () => { effects++; throw new Error("unexpected delete"); };
  const result = await f.retention.prune({ candidate: f.candidate, binding: preview.binding });
  assert.equal(removedRef, true);
  assert.equal(result.reason, "release-bundle-roots-unanchored");
  assert.equal(effects, 0);
  assert.equal(sha(await readFile(f.bundle)), before);
});

test("generation lease serializes transport retirement with the existing generation owner", async t => {
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

test("a still-active release is retained without joining its held generation queue", async t => {
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

test("wide completed generation transport preserves every advertised head in its existing proof", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await git(f.source, ["update-ref", "--stdin"], { input: Array.from({ length: 700 }, (_, i) =>
    `update refs/agent-hub/retained/${String(i).padStart(5, "0")}/${"x".repeat(60)} ${f.commit}\n`).join("") });
  await rm(f.bundle); await git(f.source, ["bundle", "create", f.bundle, "--all"]);
  const heads = (await git(f.repository, ["bundle", "list-heads", f.bundle])).split(/\r?\n/u);
  assert.ok(Buffer.byteLength(JSON.stringify(heads)) > 32 * 1024);
  const refs = await git(f.repository, ["show-ref"]), checkpoint = await readFile(path.join(f.ownerRoot, "checkpoint.json"));
  const preview = await f.retention.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  assert.deepEqual(readBundleHeads(preview.binding), heads);
  assert.equal((await f.retention.prune({ candidate: f.candidate, binding: preview.binding })).status, "removed");
  assert.equal((await f.retention.reconcile({ candidate: f.candidate, binding: preview.binding })).status, "already-removed");
  assert.equal(await git(f.repository, ["show-ref"]), refs);
  assert.deepEqual(await readFile(path.join(f.ownerRoot, "checkpoint.json")), checkpoint);
  assert.equal(await git(f.repository, ["rev-parse", "HEAD"]), f.commit);
});

test("real SQLite completed successor retires only predecessor bundle through the existing Git owner", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), scheduled = [], store = new ReleaseOperationStore({ dataDir: f.dataDir, idFactory: () => "fixture-operation" });
  let validations = 0;
  const service = new ReleaseOperationService({ store, processAlive: () => false, schedule: fn => scheduled.push(fn),
    compose: async () => ({ repositoryBases: [{ repositoryRoot: f.source, baseCommit: f.commit }],
      selectedResults: [{ taskId: "fixture", resultCommit: f.commit, tree: await git(f.source, ["rev-parse", "HEAD^{tree}"]) }],
      candidates: [{ repositoryRoot: f.source, releaseRoot: f.repository, generationRoot: f.generationRoot,
        commit: f.commit, tree: await git(f.source, ["rev-parse", "HEAD^{tree}"]), manifestHash: f.checkpoint.manifestHash }] }),
    validate: async () => { if (++validations === 1) throw Object.assign(Error("old validation failed"), { code: "RELEASE_VALIDATION_FAILED" }); return { status: "passed" }; },
    resolveTestPlans: async (candidates, selection) => candidates.map(candidate => ({ repositoryRoot: candidate.repositoryRoot,
      plan: resolveTestSelection(selection, ["tests/fixture.test.mjs"]) })),
    publishTarget: async () => { await git(f.source, ["update-ref", "refs/heads/published", f.commit]); return { status: "applied", revision: f.commit }; },
    readTarget: async () => ({ status: await git(f.source, ["rev-parse", "--verify", "refs/heads/published"]).catch(() => null) === f.commit ? "applied" : "not_applied" }),
    finalize: async () => ({ closed: ["fixture"] }),
  });
  const ack = service.start({ requestId: "original-release", workspaceId: "fixture-workspace", streamId: "fixture-stream", threadId: "fixture-thread",
    authorization: { taskIds: ["fixture"], validationMode: "full", approvedTargets: [{ targetId: "git", kind: "git", repositoryRoot: f.source }] } });
  scheduled.shift()(); await service.drain(ack.operationId);
  f.retention.readGeneration = (id, n) => service.retentionGeneration(id, n);
  assert.equal((await f.retention.preview({ candidate: f.candidate })).reason, "release-not-completed-published");
  const waiting = store.get(ack.operationId);
  assert.equal((await service.continue(ack.operationId, { requestId: "explicit-new-generation", testSelection: { mode: "none", ids: [] },
    expectedRevision: waiting.revision, expectedGeneration: 1 })).accepted, true);
  scheduled.shift()(); await service.drain(ack.operationId);
  const before = store.snapshot(ack.operationId), refs = await git(f.repository, ["show-ref"]), manifest = await readFile(path.join(f.ownerRoot, "evidence", f.checkpoint.manifestHash + ".json"));
  assert.equal(before.operation.state, "done");
  const proof = service.retentionGeneration(ack.operationId, 1);
  assert.equal(proof.kind, "superseded-release-generation-retention-v1");
  assert.equal(proof.identitySha256, before.generations[0].identitySha256);
  assert.equal(proof.completedIdentitySha256, before.generations[1].identitySha256);
  const preview = await f.retention.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  assert.equal(preview.binding.generation, 1);
  const result = await f.retention.prune({ candidate: f.candidate, binding: preview.binding, operationId: "exact-predecessor-transport-child" });
  assert.equal(result.status, "removed");
  await assert.rejects(lstat(f.bundle), { code: "ENOENT" });
  assert.equal(await git(f.repository, ["rev-parse", "HEAD"]), f.commit);
  assert.equal(await git(f.repository, ["show-ref"]), refs);
  assert.deepEqual(await readFile(path.join(f.ownerRoot, "evidence", f.checkpoint.manifestHash + ".json")), manifest);
  assert.deepEqual(store.snapshot(ack.operationId), before);
  assert.equal((await f.retention.reconcile({ candidate: f.candidate, binding: preview.binding })).status, "already-removed");
});

test("external graft input refuses generation preview and a previously eligible transport effect", async t => {
  const f = await fixture(t), before = await readFile(f.bundle);
  const preview = await f.retention.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  const graft = path.join(f.root, "external-graft"); await writeFile(graft, f.commit + "\n");
  const previous = process.env.GIT_GRAFT_FILE;
  let deletes = 0; const remove = f.retention.deleteTransport;
  f.retention.deleteTransport = async (...args) => { deletes++; return remove(...args); };
  try {
    process.env.GIT_GRAFT_FILE = graft;
    assert.equal((await f.retention.preview({ candidate: f.candidate })).status, "retained");
    await assert.rejects(f.retention.prune({ candidate: f.candidate, binding: preview.binding }), /ordinary local Git/u);
    assert.equal(deletes, 0);
    assert.deepEqual(await readFile(f.bundle), before);
  } finally {
    if (previous === undefined) delete process.env.GIT_GRAFT_FILE; else process.env.GIT_GRAFT_FILE = previous;
  }
  assert.equal((await f.retention.preview({ candidate: f.candidate })).status, "eligible");
});
