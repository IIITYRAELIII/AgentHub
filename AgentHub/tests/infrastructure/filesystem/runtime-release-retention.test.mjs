import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
const execute = promisify(execFile);
async function generatedCache(f) {
  const python = (await execute("python", ["-I", "-S", "-B", "-c", "import sys; print(sys.executable)"])).stdout.trim();
  const source = Buffer.from("def transcribe():\n    return 'fixture only'\n");
  const file = path.join(f.body, "whisper_runtime.py"), manifestFile = path.join(f.body, "runtime-manifest.json");
  await writeFile(file, source);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.files.push({ path: "whisper_runtime.py", bytes: source.length, sha256: hash(source) });
  await writeFile(manifestFile, JSON.stringify(manifest));
  const binding = await captureRuntimeReleaseBinding(f.body, "runtime-1");
  const pointer = await readRuntimePointer(f.runtimeRoot);
  pointer.runtimeRetention.retired = [{ ...pointer.runtimeRetention.retired[0], ...binding }];
  await writeRuntimePointer(f.runtimeRoot, pointer);
  f.candidate = (await f.owner.list({ limit: 3, context: f.context })).items[0];
  f.owner.pythonExe = python;
  const cache = (await execute(python, ["-I", "-S", "-B", "-c",
    "import py_compile,sys; print(py_compile.compile(sys.argv[1], doraise=True))", file])).stdout.trim();
  return { file, cache, manifest: await readFile(manifestFile) };
}
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

test("verified generated Python cache retires first within SAME bounded original", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t, 65), generated = await generatedCache(f);
  const first = await f.service.runOnce();
  assert.equal(first.partialBatches, 1);
  await assert.rejects(lstat(generated.cache), { code: "ENOENT" });
  assert.ok(await readFile(generated.file), "cache retires while its proven source still exists");
  assert.deepEqual(await readFile(path.join(f.body, "runtime-manifest.json")), generated.manifest);
  const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0];
  assert.equal(f.store.get(record.operationId).metadata.lastObservation.files, 64);
  assert.equal((await f.service.runOnce()).removed, 1);
  assert.equal(f.store.get(record.operationId).status, "succeeded");
  await assert.rejects(lstat(f.body), { code: "ENOENT" });
  assert.equal((await readRuntimePointer(f.runtimeRoot)).current, "runtime-3");
});

test("foreign bytecode and late source drift preserve SAME UNKNOWN runtime original", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t), generated = await generatedCache(f);
  const correct = await readFile(generated.cache);
  await writeFile(generated.cache, Buffer.concat([correct, Buffer.from("foreign")]));
  await f.service.runOnce();
  const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0], id = record.operationId;
  assert.equal(f.store.get(id).status, "reconciling");
  assert.ok(await readFile(path.join(f.body, "assets/000.txt")));
  await writeFile(generated.cache, correct);
  f.owner.retire = async (...args) => {
    await writeFile(generated.file, "foreign source after proof");
    return retireSealedRuntimeRelease(...args);
  };
  await f.service.runOnce();
  assert.equal(f.store.get(id).status, "reconciling");
  assert.equal((await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0].operationId, id);
  assert.deepEqual(await readFile(generated.cache), correct);
  assert.ok(await readFile(path.join(f.body, "assets/000.txt")));
});

test("lost cache-first batch reply resumes SAME original without a persistent cache waiver", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t, 65), generated = await generatedCache(f);
  let calls = 0;
  f.owner.retire = async (...args) => {
    const result = await retireSealedRuntimeRelease(...args);
    if (++calls === 1) throw new Error("lost cache-first batch reply");
    return result;
  };
  await f.service.runOnce();
  const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0];
  await assert.rejects(lstat(generated.cache), { code: "ENOENT" });
  assert.equal(f.store.get(record.operationId).status, "reconciling");
  await f.service.runOnce();
  assert.equal(f.store.get(record.operationId).status, "succeeded");
  assert.equal(calls, 2);
});

test("generated cache requires configured compiler and refuses extra useful data or forged proof", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t), generated = await generatedCache(f);
  const python = f.owner.pythonExe;
  f.owner.pythonExe = "";
  await f.service.runOnce();
  const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0], id = record.operationId;
  assert.equal(f.store.get(id).status, "reconciling");
  const bytes = await readFile(generated.cache);
  f.owner.pythonExe = python;
  await writeFile(path.join(f.body, "useful-WIP.txt"), "retained unique bytes");
  await f.service.runOnce();
  assert.equal(f.store.get(id).status, "reconciling");
  assert.deepEqual(await readFile(generated.cache), bytes);
  assert.equal(await readFile(path.join(f.body, "useful-WIP.txt"), "utf8"), "retained unique bytes");
  assert.throws(() => retireSealedRuntimeRelease(f.body, record, { allowPartial: true,
    verifiedCache: { path: path.relative(f.body, generated.cache), bytes: bytes.length, sha256: hash(bytes) } }),
  /runtime-generated-cache-proof-required/u);
});

test("native asset failure after cache unlink recovers SAME original after exact asset restore", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t), generated = await generatedCache(f);
  const asset = path.join(f.body, "assets/000.txt"), bytes = await readFile(asset);
  await writeFile(asset, Buffer.alloc(bytes.length, 120));
  await f.service.runOnce();
  const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0], id = record.operationId;
  assert.equal(f.store.get(id).status, "reconciling");
  await assert.rejects(lstat(generated.cache), { code: "ENOENT" });
  assert.ok(await readFile(generated.file));
  await writeFile(asset, bytes);
  await f.service.runOnce();
  assert.equal(f.store.get(id).status, "succeeded");
  await assert.rejects(lstat(f.body), { code: "ENOENT" });
});

test("lost reply between cache and directory unlink resumes exact persisted directory custody", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t), generated = await generatedCache(f);
  f.owner.retire = async () => {
    const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0];
    assert.equal(record.generatedCache.empty, false);
    assert.equal(record.generatedCache.directoryIno, String((await lstat(path.dirname(generated.cache), { bigint: true })).ino));
    await unlink(generated.cache); // Fixture's precise crash boundary after the owned cache unlink.
    throw Error("lost reply before directory unlink");
  };
  await f.service.runOnce();
  const record = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0], id = record.operationId;
  assert.deepEqual(await readdir(path.dirname(generated.cache)), []);
  assert.equal(f.store.get(id).status, "reconciling");
  f.owner.retire = retireSealedRuntimeRelease;
  await f.service.runOnce();
  assert.equal(f.store.get(id).status, "succeeded");
  await assert.rejects(lstat(f.body), { code: "ENOENT" });
});

test("empty cache directory requires original custody and refuses a same-path replacement", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await fixture(t), generated = await generatedCache(f), directory = path.dirname(generated.cache);
  const cacheBytes = await readFile(generated.cache);
  await unlink(generated.cache);
  let calls = 0;
  f.owner.retire = async () => { calls++; throw Error("must never reach native without custody"); };
  await f.service.runOnce();
  const id = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0].operationId;
  assert.equal(calls, 0);
  assert.equal(f.store.get(id).status, "reconciling");
  await writeFile(generated.cache, cacheBytes);
  f.owner.retire = async () => {
    calls++;
    await unlink(generated.cache);
    await rename(directory, path.join(f.root, "retained-original-cache-directory"));
    await mkdir(directory);
    throw Error("foreign directory after lost reply");
  };
  await f.service.runOnce();
  assert.equal(calls, 1);
  f.owner.retire = async () => { calls++; throw Error("replacement must refuse before native"); };
  await f.service.runOnce();
  assert.equal(calls, 1);
  assert.equal(f.store.get(id).status, "reconciling");
  assert.deepEqual(await readdir(directory), []);
  assert.ok(await readFile(generated.file));
  assert.ok(await readFile(path.join(f.body, "assets/000.txt")));
});
