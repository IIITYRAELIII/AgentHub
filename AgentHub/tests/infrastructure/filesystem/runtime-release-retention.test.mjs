import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeReleaseRetention } from "../../../src/infrastructure/filesystem/runtime-release-retention.mjs";
import { captureRuntimeReleaseBinding, readRuntimePointer, withRuntimeInstallationLease,
  writeRuntimePointer } from "../../../src/infrastructure/filesystem/runtime-installation-custody.mjs";
import { runtimePointerTransition } from "../../../src/infrastructure/filesystem/runtime-release-retention-policy.mjs";
import { retireSealedRuntimeRelease } from "../../../src/infrastructure/filesystem/sealed-runtime-release.mjs";
import { StorageRetentionService } from "../../../src/application/storage-retention-service.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, count = 2) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "runtime-retirement-"));
  const runtimeRoot = path.join(root, "runtime"), sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot);
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    const alias = path.join(root, "logical-runtime");
    const aliasInfo = await lstat(alias).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (aliasInfo) {
      assert.equal(aliasInfo.isSymbolicLink(), true);
      assert.equal(await realpath(alias), await realpath(runtimeRoot));
      await rm(alias);
    }
    await rm(root, { recursive: true });
  });
  const release = async (number, filesCount = 1) => {
    const releaseId = `runtime-${number}`, body = path.join(runtimeRoot, "releases", releaseId);
    await mkdir(path.join(body, "assets"), { recursive: true });
    const files = [];
    for (let n = 0; n < filesCount; n++) {
      const relative = `assets/${String(n).padStart(3, "0")}.txt`, bytes = Buffer.from(`known fixture ${n}`);
      await writeFile(path.join(body, relative), bytes);
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
    await writeFile(path.join(body, "runtime-manifest.json"), JSON.stringify({ releaseId, sourceRoot, directories: ["assets"], files }));
    return { body, binding: await captureRuntimeReleaseBinding(body, releaseId) };
  };
  let pointer = {};
  for (let n = 1; n <= 3; n++) {
    const entry = await release(n, n === 1 ? count : 1);
    pointer = runtimePointerTransition({ pointer, installed: entry.binding }).pointer;
  }
  await writeRuntimePointer(runtimeRoot, pointer);
  const context = { ready: true, isolated: false, releaseId: "runtime-3" };
  const owner = new RuntimeReleaseRetention({ runtimeRoot });
  const candidate = (await owner.list({ limit: 3, context })).items[0];
  assert.equal(candidate.releaseId, "runtime-1");
  await mkdir(path.join(root, "maintenance"));
  const store = new MaintenanceOperationStore({ dataDir: path.join(root, "maintenance") });
  t.after(() => store.close?.());
  const service = new StorageRetentionService({ store, owners: [owner], maxUnits: 1,
    readContext: () => context, withLease: fn => fn({ assertOwned: async () => {} }) });
  return { root, runtimeRoot, sourceRoot, release, owner, context, candidate, store, service,
    body: path.join(runtimeRoot, "releases/runtime-1") };
}

test("actual bounded batches retain SAME original operation, manifest and current/rollback bodies", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t, 65);
  const original = await readFile(path.join(f.body, "runtime-manifest.json"));
  const first = await f.service.runOnce();
  assert.equal(first.pending, 1);
  assert.equal(first.partialBatches, 1);
  assert.equal((await readdir(path.join(f.body, "assets"))).length, 1);
  assert.deepEqual(await readFile(path.join(f.body, "runtime-manifest.json")), original);
  const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0];
  assert.equal(record.phase, "pruning");
  const child = f.store.get(record.operationId);
  assert.equal(child.status, "reconciling");
  assert.equal(child.metadata.lastObservation.status, "partial");
  const second = await f.service.runOnce();
  assert.equal(second.pending, 0);
  assert.equal(second.removed, 1);
  assert.equal(f.store.get(record.operationId).status, "succeeded");
  await assert.rejects(lstat(f.body), { code: "ENOENT" });
  const pointer = await readRuntimePointer(f.runtimeRoot);
  assert.equal(pointer.current, "runtime-3");
  assert.equal(pointer.previous, "runtime-2");
  assert.deepEqual(pointer.runtimeRetention.retired, []);
  for (const id of [2, 3]) assert.ok(await readFile(path.join(f.runtimeRoot, `releases/runtime-${id}/runtime-manifest.json`)));
  const revision = f.store.get(record.operationId).revision;
  await f.service.runOnce();
  assert.equal(f.store.get(record.operationId).revision, revision);
});

test("lost native completion reply reconciles exact absence without a second deletion", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t);
  let calls = 0;
  f.owner.retire = async (...args) => { calls++; await retireSealedRuntimeRelease(...args); throw new Error("lost native response"); };
  await f.service.runOnce();
  const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0];
  assert.equal(f.store.get(record.operationId).status, "reconciling");
  await assert.rejects(lstat(f.body), { code: "ENOENT" });
  const result = await f.service.runOnce();
  assert.equal(calls, 1);
  assert.equal(result.alreadyRemoved, 1);
  assert.equal(result.logicalBytes, 0, "unknown old effects do not become measured reclaimed bytes");
  assert.equal(f.store.get(record.operationId).status, "succeeded");
});

test("running and prepared-source pins preserve retired bodies; unknown legacy bodies are not discovered", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.owner.list({ limit: 3, context: { ...f.context, releaseId: "runtime-1" } })).items, []);
  const prepared = await f.release(99);
  const file = path.join(prepared.body, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.sourceRoot = f.body;
  await writeFile(file, JSON.stringify(manifest));
  const before = await readFile(path.join(f.body, "assets/000.txt"));
  assert.deepEqual(await f.owner.preview({ candidate: f.candidate, context: f.context }),
    { status: "retained", reason: "runtime-source-pinned" });
  assert.deepEqual(await readFile(path.join(f.body, "assets/000.txt")), before);
  assert.deepEqual((await f.owner.list({ limit: 3, context: f.context })).items.map(c => c.releaseId), ["runtime-1"]);
  assert.ok(await readFile(file));
});

test("foreign data refuses actual batch and remains unknown under original intent", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t);
  const foreign = path.join(f.body, "useful-WIP.txt");
  await writeFile(foreign, "unpublished useful bytes");
  await f.service.runOnce();
  const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0];
  const id = record.operationId;
  assert.equal(f.store.get(id).status, "reconciling");
  assert.equal(await readFile(foreign, "utf8"), "unpublished useful bytes");
  assert.ok(await readFile(path.join(f.body, "assets/000.txt")));
  await f.service.runOnce();
  assert.equal((await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0].operationId, id);
  assert.equal(f.store.get(id).status, "reconciling");
  assert.equal(await readFile(foreign, "utf8"), "unpublished useful bytes");
});

test("logical alias and native path share one installation lease", async t => {
  if (process.platform !== "win32") return t.skip("Windows junction");
  const f = await fixture(t);
  const alias = path.join(f.root, "logical-runtime");
  await symlink(f.runtimeRoot, alias, "junction");
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = withRuntimeInstallationLease(alias, async () => { enter(); await gate; });
  await entered;
  let secondEntered = false;
  const second = withRuntimeInstallationLease(f.runtimeRoot, async () => { secondEntered = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(secondEntered, false);
  release();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});
