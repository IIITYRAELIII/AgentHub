import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nextRuntimeReleaseVersion } from "../../../src/infrastructure/filesystem/runtime-release-version.mjs";
import { captureRuntimeReleaseBinding, readRuntimePointer, writeRuntimePointer } from "../../../src/infrastructure/filesystem/runtime-installation-custody.mjs";
import { runtimePointerTransition } from "../../../src/infrastructure/filesystem/runtime-release-retention-policy.mjs";
import { RuntimeReleaseRetention } from "../../../src/infrastructure/filesystem/runtime-release-retention.mjs";
import { StorageRetentionService } from "../../../src/application/storage-retention-service.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { buildArtifact } from "../../../src/infrastructure/process/publication-artifacts.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const native = { skip: process.platform !== "win32" };

async function fixture(t) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "retired-allocation-"));
  const originalRoot = await lstat(root, { bigint: true });
  t.after(async () => {
    const actual = await lstat(root, { bigint: true });
    assert.equal(path.dirname(root), parent);
    assert.equal(actual.isSymbolicLink(), false);
    assert.equal(actual.ino, originalRoot.ino);
    assert.equal(actual.dev, originalRoot.dev);
    await rm(root, { recursive: true });
  });
  const runtimeRoot = path.join(root, "runtime"), sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot);
  const identity = { revision: "1".repeat(40), sourceRoot, runtimeRoot, protocol: 1,
    runtimePublication: { operationId: randomUUID(), generation: 1, sourceCommit: "1".repeat(40), version: "2.0.1+build.50" } };
  const key = hash(JSON.stringify(identity)).slice(0, 32), releaseId = `publication-${key}`;
  const releaseRoot = path.join(runtimeRoot, "releases", releaseId);
  await mkdir(path.join(releaseRoot, "assets/mobile"), { recursive: true });
  const mobile = Buffer.from(JSON.stringify({ versionName: "2.0.1", versionCode: 50 }));
  const files = [{ path: "assets/mobile/update.json", bytes: mobile.length, sha256: hash(mobile) }];
  await writeFile(path.join(releaseRoot, files[0].path), mobile);
  for (let n = 0; n < 64; n++) {
    const relative = `assets/z${String(n).padStart(3, "0")}.txt`, bytes = Buffer.from(`declared ${n}`);
    await writeFile(path.join(releaseRoot, relative), bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifestFile = path.join(releaseRoot, "runtime-manifest.json");
  const manifest = { releaseId, sourceRoot, publicationRevision: identity.revision,
    version: "2.0.1", publicVersion: "2.0.1", releaseVersion: identity.runtimePublication.version,
    versionScheme: "semver-build-v1", buildNumber: 50, directories: ["assets", "assets/mobile"], files };
  await writeFile(manifestFile, JSON.stringify(manifest));
  const binding = await captureRuntimeReleaseBinding(releaseRoot, releaseId);
  const archiveRoot = path.join(runtimeRoot, "publication-artifacts", key);
  await buildArtifact(path.join(archiveRoot, "android"), identity, async output => {
    await writeFile(path.join(output, "update.json"), mobile);
    await writeFile(path.join(output, "AgentHub-Mobile.apk"), "fixture, never executed");
    return {};
  });
  await buildArtifact(path.join(archiveRoot, "runtime"), identity, async output => {
    await writeFile(path.join(output, "prepared-runtime.json"), JSON.stringify({ schema: 1, phase: "PREPARED",
      ...identity.runtimePublication, sourceCommit: identity.revision, releaseId,
      releaseRoot, manifestSha256: binding.manifestSha256 }));
    return { releaseId, manifestHash: binding.manifestSha256 };
  });
  let pointer = runtimePointerTransition({ installed: binding }).pointer;
  for (const number of [2, 3]) {
    const id = `current-${number}`, body = path.join(runtimeRoot, "releases", id);
    await mkdir(body);
    await writeFile(path.join(body, "runtime-manifest.json"), JSON.stringify({ releaseId: id, sourceRoot,
      version: "2.0.1", releaseVersion: `2.0.1.${number}`, files: [] }));
    pointer = runtimePointerTransition({ pointer, installed: await captureRuntimeReleaseBinding(body, id) }).pointer;
  }
  await writeRuntimePointer(runtimeRoot, pointer);
  await mkdir(path.join(runtimeRoot, "data"));
  const store = new MaintenanceOperationStore({ dataDir: path.join(runtimeRoot, "data") });
  const owner = new RuntimeReleaseRetention({ runtimeRoot });
  const context = { ready: true, isolated: false, releaseId: pointer.current };
  const service = new StorageRetentionService({ store, owners: [owner], maxUnits: 1,
    readContext: () => context, withLease: fn => fn({ assertOwned: async () => {} }) });
  const first = await service.runOnce();
  assert.equal(first.partialBatches, 1);
  await assert.rejects(readFile(path.join(releaseRoot, files[0].path)), { code: "ENOENT" });
  pointer = await readRuntimePointer(runtimeRoot);
  const record = pointer.runtimeRetention.retired[0];
  assert.equal(record.phase, "pruning");
  assert.equal(store.get(record.operationId).status, "reconciling");
  const allocate = options => nextRuntimeReleaseVersion({ releasesDir: path.join(runtimeRoot, "releases"),
    packageVersion: "2.0.4", allocationFloor: 0, ...options });
  return { runtimeRoot, releaseRoot, manifestFile, manifest, binding, pointer, record, store,
    archiveRoot, identity, mobile, allocate };
}

test("partial retirement preserves original allocation through canonical artifact custody", native, async t => {
  const f = await fixture(t);
  const pointer = await readFile(path.join(f.runtimeRoot, "current.json"));
  const operation = f.store.get(f.record.operationId);
  const manifest = await readFile(f.manifestFile);
  assert.equal(await f.allocate(), "2.0.4+build.51");
  assert.deepEqual(await readFile(path.join(f.runtimeRoot, "current.json")), pointer);
  assert.deepEqual(f.store.get(operation.operationId), operation);
  assert.deepEqual(await readFile(f.manifestFile), manifest);
  await assert.rejects(readFile(path.join(f.releaseRoot, "assets/mobile/update.json")), { code: "ENOENT" });
});

test("partial retirement allocation refuses changed or foreign evidence and active missing bodies", native, async t => {
  for (const mode of ["missing archive", "foreign archive", "changed payload", "changed manifest", "changed root custody",
    "changed original", "not admitted", "unretired", "current", "running"]) await t.test(mode, async t => {
    const f = await fixture(t);
    if (mode === "missing archive") await rm(path.join(f.archiveRoot, "android/payload/update.json"));
    if (mode === "changed payload") await writeFile(path.join(f.archiveRoot, "android/payload/update.json"), "foreign");
    if (mode === "foreign archive") {
      const file = path.join(f.archiveRoot, "runtime/artifact.json"), value = JSON.parse(await readFile(file));
      value.identity.revision = "2".repeat(40);
      await writeFile(file, JSON.stringify(value));
    }
    if (mode === "changed manifest") await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, createdAt: "changed" }));
    if (mode === "changed root custody") f.record.root.ino = String(BigInt(f.record.root.ino) + 1n);
    if (mode === "changed original") f.record.operationId = randomUUID();
    if (mode === "not admitted") f.store.transition(f.record.operationId, { metadata: { admitted: false } });
    if (mode === "unretired") f.pointer.runtimeRetention.retired = [];
    if (mode === "current") {
      f.pointer.previous = f.pointer.current;
      f.pointer.current = f.record.releaseId;
      f.pointer.runtimeRetention.previous = f.pointer.runtimeRetention.current;
      f.pointer.runtimeRetention.current = f.binding;
      f.pointer.runtimeRetention.retired = [];
    }
    if (mode === "running") await writeFile(path.join(f.runtimeRoot, "data/bot.lock"), JSON.stringify({ pid: process.pid, releaseId: f.record.releaseId }));
    await writeRuntimePointer(f.runtimeRoot, f.pointer);
    await assert.rejects(f.allocate());
    assert.equal((await lstat(f.releaseRoot)).isDirectory(), true);
  });
});

test("partial retirement allocation rejects custody changing during the archived read", native, async t => {
  const f = await fixture(t);
  let changed = false;
  await assert.rejects(f.allocate({ readFileImpl: async (file, ...args) => {
    const raw = await readFile(file, ...args);
    if (!changed && file === path.join(f.archiveRoot, "android/payload/update.json")) {
      changed = true;
      f.pointer.runtimeRetention.retired[0].operationId = randomUUID();
      await writeRuntimePointer(f.runtimeRoot, f.pointer);
    }
    return raw;
  } }));
  assert.equal(changed, true);
});

test("allocation evidence cannot initialize a missing maintenance database", async t => {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "allocation-readonly-"));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true });
  });
  const store = new MaintenanceOperationStore({ dataDir: root });
  assert.throws(() => store.getReadonly(randomUUID()));
  await assert.rejects(lstat(path.join(root, "runtime.sqlite")), { code: "ENOENT" });
});
