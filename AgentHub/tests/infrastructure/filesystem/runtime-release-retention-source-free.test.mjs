import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeReleaseRetention } from "../../../src/infrastructure/filesystem/runtime-release-retention.mjs";
import { readRuntimePointer, writeRuntimePointer } from "../../../src/infrastructure/filesystem/runtime-installation-custody.mjs";
import { installPreparedRuntime, verifyInstalledRuntime } from "../../../src/runtime/runtime-manager.mjs";
import { StorageRetentionService } from "../../../src/application/storage-retention-service.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function recipient(t) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "source-free-retention-"));
  const runtimeRoot = path.join(root, "runtime"), dataDir = path.join(root, "maintenance");
  let store;
  t.after(async () => {
    store?.close?.();
    assert.equal(path.dirname(root), parent);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true });
  });
  const prepare = async (n, count = 1) => {
    const releaseId = `zip-${n}`, releaseRoot = path.join(runtimeRoot, "releases", releaseId);
    await mkdir(path.join(releaseRoot, "assets"), { recursive: true });
    // Synthetic declared bytes: the real installer copies stable launchers but
    // this test never executes a launcher, host, provider or publication runner.
    const content = {
      "package.json": JSON.stringify({ name: "agent-hub", version: "2.0.3" }),
      "codex-stop-hook-launcher.mjs": "export const fixture = true;\n",
      "AgentHub.RuntimeHost.exe": "non-executable test host bytes",
      "AgentHub.RuntimeHost.source.sha256": `${hash("synthetic host source")}\n`,
      "AgentHub.RuntimeHost.exe.sha256": `${hash("non-executable test host bytes")}\n`,
    };
    for (let i = 0; i < count; i++) content[`assets/${String(i).padStart(3, "0")}.txt`] = `version ${n} asset ${i}`;
    const files = [];
    for (const [relative, text] of Object.entries(content)) {
      const bytes = Buffer.from(text);
      await writeFile(path.join(releaseRoot, relative), bytes);
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
    const manifest = { releaseId, version: "2.0.3", releaseVersion: `2.0.3+build.${n}`,
      versionScheme: "semver-build-v1", publicVersion: "2.0.3", buildNumber: n,
      publicationRevision: String(n).repeat(40), distributionSource: { preparedManifestSha256: hash(`prepared ${n}`) },
      directories: ["assets"], files };
    assert.equal(Object.hasOwn(manifest, "sourceRoot"), false);
    await writeFile(path.join(releaseRoot, "runtime-manifest.json"), `${JSON.stringify(manifest)}\n`);
    return { releaseId, releaseRoot };
  };
  const install = async (n, count) => {
    const prepared = await prepare(n, count);
    const result = await installPreparedRuntime({ runtimeRoot, ...prepared });
    assert.equal(await verifyInstalledRuntime({ runtimeRoot, ...prepared }), true);
    return { ...prepared, result };
  };
  const context = { ready: true, isolated: false, releaseId: "zip-3" };
  const open = async () => {
    store?.close?.();
    await mkdir(dataDir, { recursive: true });
    store = new MaintenanceOperationStore({ dataDir });
    const owner = new RuntimeReleaseRetention({ runtimeRoot });
    const service = new StorageRetentionService({ store, owners: [owner], maxUnits: 1,
      readContext: () => context, withLease: fn => fn({ assertOwned: async () => {} }) });
    return { owner, service, store };
  };
  return { root, runtimeRoot, prepare, install, context, open };
}

test("source-free recipient updates retire exact old versions through original bounded batches", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await recipient(t);
  const first = await f.install(1, 65);
  await f.install(2);
  await f.install(3);
  let { owner, service, store } = await f.open();
  const candidate = (await owner.list({ limit: 3, context: f.context })).items[0];
  assert.equal(candidate.releaseId, "zip-1");
  assert.equal((await owner.preview({ candidate, context: f.context })).status, "eligible");
  const original = await readFile(path.join(first.releaseRoot, "runtime-manifest.json"));
  const batch = await service.runOnce();
  assert.equal(batch.partialBatches, 1);
  assert.equal(batch.pending, 1);
  assert.deepEqual(await readFile(path.join(first.releaseRoot, "runtime-manifest.json")), original);
  const admitted = (await readRuntimePointer(f.runtimeRoot)).runtimeRetention.retired[0];
  assert.equal(admitted.phase, "pruning");
  assert.equal(store.get(admitted.operationId).status, "reconciling");
  const remaining = (await readdir(path.join(first.releaseRoot, "assets"))).length;
  assert.ok(remaining > 0 && remaining < 65);
  await service.close();
  await f.install(4);
  f.context.releaseId = "zip-4";
  ({ owner, service, store } = await f.open());
  const resumed = await service.runOnce();
  assert.equal(resumed.removed, 1);
  assert.equal(store.get(admitted.operationId).status, "succeeded");
  await assert.rejects(lstat(first.releaseRoot), { code: "ENOENT" });
  assert.equal((await service.runOnce()).removed, 2, "summary is cumulative within this release/cadence cycle");
  const pointer = await readRuntimePointer(f.runtimeRoot);
  assert.equal(pointer.current, "zip-4");
  assert.equal(pointer.previous, "zip-3");
  assert.deepEqual(pointer.runtimeRetention.retired, []);
  assert.deepEqual((await readdir(path.join(f.runtimeRoot, "releases"))).sort(), ["zip-3", "zip-4"]);
  for (const n of [3, 4]) {
    const manifest = JSON.parse(await readFile(path.join(f.runtimeRoot, `releases/zip-${n}/runtime-manifest.json`), "utf8"));
    assert.equal(Object.hasOwn(manifest, "sourceRoot"), false);
    assert.equal(manifest.buildNumber, n);
  }
  const pointerBytes = await readFile(path.join(f.runtimeRoot, "current.json"));
  const settledRevision = store.get(admitted.operationId).revision;
  assert.equal((await service.runOnce()).removed, 2);
  assert.equal(store.get(admitted.operationId).revision, settledRevision);
  assert.deepEqual(await readFile(path.join(f.runtimeRoot, "current.json")), pointerBytes);
  await service.close();
});

test("source-free classification refuses a manifest changed between classification and custody reads", async t => {
  if (process.platform !== "win32") return t.skip("Windows recipient custody");
  const f = await recipient(t);
  await f.install(1);
  const rollback = await f.prepare(2);
  const rollbackFile = path.join(rollback.releaseRoot, "runtime-manifest.json");
  const rollbackManifest = JSON.parse(await readFile(rollbackFile, "utf8"));
  rollbackManifest.sourceRoot = path.join(f.root, "independent-source");
  await mkdir(rollbackManifest.sourceRoot);
  await writeFile(rollbackFile, JSON.stringify(rollbackManifest));
  await installPreparedRuntime({ runtimeRoot: f.runtimeRoot, ...rollback });
  const current = await f.prepare(3);
  const currentFile = path.join(current.releaseRoot, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(currentFile, "utf8"));
  manifest.sourceRoot = path.join(f.runtimeRoot, "releases/zip-1");
  await writeFile(currentFile, JSON.stringify(manifest));
  await installPreparedRuntime({ runtimeRoot: f.runtimeRoot, ...current });
  assert.equal(await verifyInstalledRuntime({ runtimeRoot: f.runtimeRoot, ...current }), true);
  const original = await readFile(currentFile);
  const { owner, service } = await f.open();
  t.after(() => service.close());
  const candidate = (await owner.list({ limit: 3, context: f.context })).items[0];
  assert.deepEqual(await owner.preview({ candidate, context: f.context }),
    { status: "retained", reason: "runtime-source-pinned" });
  const sourceFree = JSON.parse(original);
  delete sourceFree.sourceRoot;
  const changed = Buffer.from(JSON.stringify(sourceFree));
  const pointer = await readRuntimePointer(f.runtimeRoot);
  assert.notEqual(hash(changed), pointer.runtimeRetention.current.manifestSha256);
  assert.equal(hash(original), pointer.runtimeRetention.current.manifestSha256);
  await writeFile(currentFile, changed);
  const actualOpen = fs.open;
  let firstOpened = false, restored = false;
  // Real handles/bytes/custody; restore the installed source dependency only
  // after the classification read closes, before the second capture opens it.
  fs.open = async (...args) => {
    const handle = await actualOpen(...args);
    if (firstOpened || path.resolve(String(args[0])) !== path.resolve(currentFile)) return handle;
    firstOpened = true;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      await writeFile(currentFile, original);
      restored = true;
    };
    return handle;
  };
  syncBuiltinESMExports();
  let observed;
  try { observed = await owner.preview({ candidate, context: f.context }); }
  finally {
    fs.open = actualOpen;
    syncBuiltinESMExports();
    await writeFile(currentFile, original);
  }
  assert.equal(restored, true);
  assert.deepEqual(await readFile(currentFile), original);
  assert.deepEqual(observed, { status: "retained", reason: "runtime-pin-manifest-unknown" });
  assert.deepEqual(await owner.preview({ candidate, context: f.context }),
    { status: "retained", reason: "runtime-source-pinned" });
  assert.ok(await readFile(path.join(f.runtimeRoot, "releases/zip-1/assets/000.txt")));
});

test("source-free pins reject changed custody, malformed manifests and unselected prepared bodies", async t => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const f = await recipient(t);
  for (let n = 1; n <= 3; n++) await f.install(n);
  const { owner, service } = await f.open();
  const candidate = (await owner.list({ limit: 3, context: f.context })).items[0];
  const preview = () => owner.preview({ candidate, context: f.context });
  assert.equal((await preview()).status, "eligible");
  const file = path.join(f.runtimeRoot, "releases/zip-3/runtime-manifest.json");
  const original = await readFile(file);
  for (const change of [m => { m.sourceRoot = null; }, m => { m.sourceRoot = ""; },
    m => { m.sourceRoot = "relative/source"; }, m => { m.releaseId = "foreign"; },
    m => { delete m.files; }, m => { m.distributionSource.preparedManifestSha256 = hash("foreign"); }]) {
    const manifest = JSON.parse(original);
    change(manifest);
    await writeFile(file, JSON.stringify(manifest));
    assert.deepEqual(await preview(), { status: "retained", reason: "runtime-pin-manifest-unknown" });
  }
  await writeFile(file, "{broken");
  assert.deepEqual(await preview(), { status: "retained", reason: "runtime-pin-manifest-unavailable" });
  await writeFile(file, original);
  const pointer = await readRuntimePointer(f.runtimeRoot);
  for (const change of [p => { p.runtimeRetention.current.manifestSha256 = hash("wrong"); },
    p => { p.runtimeRetention.previous.root.ino = String(BigInt(p.runtimeRetention.previous.root.ino) + 1n); }]) {
    const changed = structuredClone(pointer);
    change(changed);
    await writeRuntimePointer(f.runtimeRoot, changed);
    assert.deepEqual(await preview(), { status: "retained", reason: "runtime-pin-manifest-unknown" });
  }
  await writeRuntimePointer(f.runtimeRoot, pointer);
  assert.deepEqual((await owner.list({ limit: 3, context: { ...f.context, releaseId: "zip-1" } })).items, []);
  const prepared = await f.prepare(4);
  assert.deepEqual(await preview(), { status: "retained", reason: "runtime-pin-manifest-unknown" });
  const manifest = JSON.parse(await readFile(path.join(prepared.releaseRoot, "runtime-manifest.json"), "utf8"));
  manifest.sourceRoot = path.join(f.runtimeRoot, "releases/zip-1");
  await writeFile(path.join(prepared.releaseRoot, "runtime-manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await preview(), { status: "retained", reason: "runtime-source-pinned" });
  assert.equal((await service.runOnce()).removed, 0);
  assert.ok(await readFile(path.join(f.runtimeRoot, "releases/zip-1/assets/000.txt")));
  assert.ok(await readFile(file));
  await service.close();
});
