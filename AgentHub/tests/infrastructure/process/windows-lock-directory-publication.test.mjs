import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relativeModuleSpecifiers } from "../../../src/infrastructure/filesystem/module-import-specifiers.mjs";
import { RUNTIME_HOST_SOURCE_INPUTS } from "../../../src/infrastructure/process/runtime-host-builder.mjs";

const source = fileURLToPath(new URL("../../../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);

for (const mode of ["idle-then-work", "natural-exit", "natural-exit-replaced"]) test(`source lock publisher lifetime: ${mode}`, {
  skip: process.platform !== "win32", timeout: 30_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-lock-lifetime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = fileURLToPath(new URL("../../fixtures/windows-lock-publisher-lifetime-child.mjs", import.meta.url));
  const moduleUrl = new URL("../../../src/infrastructure/process/windows-lock-directory-publication.mjs", import.meta.url).href;
  let result;
  try { result = await execute(process.execPath, [child, moduleUrl, root, mode], { windowsHide: true, encoding: "utf8" }); }
  catch (error) { result = error; }
  const observed = JSON.parse(result.stdout.trim());
  if (mode === "natural-exit-replaced") t.after(async () => {
    for (const owned of [observed.nativeRoot, observed.retainedNativeRoot]) {
      assert.equal(path.dirname(owned), os.tmpdir());
      assert.equal((await fs.lstat(owned)).isSymbolicLink(), false);
      await fs.rm(owned, { recursive: true, force: true });
    }
  });
  assert.equal(observed.errorCode, undefined, JSON.stringify(observed));
  assert.equal(result.stderr, "");
  assert.equal(observed.firstPublished, true);
  if (mode === "idle-then-work") {
    assert.equal(observed.resumedAfterIdle, true);
    assert.equal(observed.secondPublished, true);
    assert.equal(observed.explicitShutdownFencedAndDrained, true);
  }
  // Joined natural child exit retires its exact bootstrap body. Parent/source
  // directories and unrelated fixture bytes are not cleanup authority.
  if (mode === "natural-exit-replaced") {
    assert.equal(await fs.readFile(path.join(observed.nativeRoot, "foreign"), "utf8"), "retained foreign bytes");
    assert.ok((await fs.lstat(observed.retainedNativeRoot)).isDirectory());
  } else await assert.rejects(fs.lstat(observed.nativeRoot), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(root), mode !== "idle-then-work" ? ["first.lock"]
    : ["after-idle.lock", "first.lock", "in-flight.lock"]);
});

async function copyClosure(destination) {
  const pending = ["src/runtime/runtime-manager.mjs", "src/infrastructure/process/windows-lock-directory-publication.mjs"];
  const copied = new Set();
  while (pending.length) {
    const relative = pending.pop();
    if (copied.has(relative)) continue;
    copied.add(relative);
    const bytes = await fs.readFile(path.join(source, relative));
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    if (relative.endsWith(".mjs")) for (const specifier of relativeModuleSpecifiers(bytes.toString("utf8"))) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
    }
  }
  for (const relative of RUNTIME_HOST_SOURCE_INPUTS) {
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, relative), target);
  }
  const pkg = { name: "agent-hub", version: "2.0.4", type: "module" };
  await fs.writeFile(path.join(destination, "package.json"), JSON.stringify(pkg));
  await fs.writeFile(path.join(destination, "package-lock.json"), JSON.stringify({ name: pkg.name,
    version: pkg.version, lockfileVersion: 3, packages: { "": { name: pkg.name, version: pkg.version } } }));
}

async function ready(canonical) {
  const root = `${canonical}.ready-${randomUUID()}`;
  await fs.mkdir(root, { recursive: true });
  const token = randomUUID();
  const file = `owner-${sha(token)}.json`;
  const bytes = Buffer.from(JSON.stringify({ token, pid: process.pid, processInstanceId: randomUUID(),
    createdAt: Date.now(), leaseExpiresAt: Date.now() + 60_000 }));
  const handle = await fs.open(path.join(root, file), "wx");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return { root, file, bytes };
}

test("fixed lock publisher bootstraps from source and ships through the canonical prepared consumer", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-lock-consumer-"));
  const input = path.join(root, "source"), runtime = path.join(root, "runtime");
  let publisher, preparedPublisher;
  try {
    await copyClosure(input);
    const api = await import(pathToFileURL(path.join(input, "src/infrastructure/process/windows-lock-directory-publication.mjs")));
    const [first, second] = await Promise.all([api.prepareWindowsLockDirectoryPublisher(), api.prepareWindowsLockDirectoryPublisher()]);
    publisher = first;
    assert.equal(first, second);
    assert.equal(publisher.provenance.mode, "source");
    assert.equal(publisher.provenance.compilerExecutions.length, 3);
    assert.equal(publisher.provenance.sourceInputs.length, 4);
    const compiledRoot = path.dirname(publisher.provenance.executable);

    const longParent = path.join(root, "a".repeat(100), "b".repeat(100), "c".repeat(80));
    const canonical = path.join(longParent, "long.lock");
    const long = await ready(canonical);
    assert.ok(canonical.length > 300);
    await publisher.publish(long.root, canonical);
    assert.deepEqual(await fs.readFile(path.join(canonical, long.file)), long.bytes);
    for (const name of ["data", "launcher-error.log"]) {
      await assert.rejects(fs.lstat(path.join(compiledRoot, name)), { code: "ENOENT" });
    }

    // Seed ONLY the ordinary cache of this private runtime with the exact
    // builder output. The canonical producer still owns manifest/copy checks.
    await fs.mkdir(runtime);
    await fs.copyFile(publisher.provenance.executable, path.join(runtime, "AgentHub.RuntimeHost.exe"));
    await fs.writeFile(path.join(runtime, "AgentHub.RuntimeHost.source.sha256"), publisher.provenance.sourceHash);
    await fs.writeFile(path.join(runtime, "AgentHub.RuntimeHost.exe.sha256"), publisher.provenance.binaryHash);
    const { prepareRuntime } = await import(pathToFileURL(path.join(input, "src/runtime/runtime-manager.mjs")));
    const prepared = await prepareRuntime({ sourceRoot: input, runtimeRoot: runtime, releaseId: "lock-consumer",
      installProductionDependencies: () => assert.fail("dependency-free fixture cannot install dependencies") });
    const manifest = JSON.parse(await fs.readFile(path.join(prepared.releaseRoot, "runtime-manifest.json"), "utf8"));
    for (const name of RUNTIME_HOST_SOURCE_INPUTS) {
      const bytes = await fs.readFile(path.join(input, name));
      assert.deepEqual(await fs.readFile(path.join(prepared.releaseRoot, name)), bytes);
      assert.equal(manifest.files.find((entry) => entry.path === name)?.sha256, sha(bytes));
    }
    const preparedApi = await import(pathToFileURL(path.join(prepared.releaseRoot, "src/infrastructure/process/windows-lock-directory-publication.mjs")));
    preparedPublisher = await preparedApi.prepareWindowsLockDirectoryPublisher();
    assert.equal(preparedPublisher.provenance.mode, "prepared");
    assert.equal(preparedPublisher.provenance.compilerExecutions.length, 0);
    assert.equal(preparedPublisher.provenance.binaryHash, publisher.provenance.binaryHash);
    const target = path.join(root, "prepared.lock"), own = await ready(target);
    await preparedPublisher.publish(own.root, target);
    assert.deepEqual(await fs.readFile(path.join(target, own.file)), own.bytes);

    const required = path.join(input, RUNTIME_HOST_SOURCE_INPUTS[0]);
    const retained = await fs.readFile(required);
    await fs.unlink(required);
    try {
      await assert.rejects(prepareRuntime({ sourceRoot: input, runtimeRoot: runtime, releaseId: "missing-lock-input",
        installProductionDependencies: () => assert.fail("missing native asset must refuse before dependencies") }), /Runtime module asset is missing/u);
    } finally { await fs.writeFile(required, retained); }

    await preparedPublisher.shutdown();
    preparedPublisher = null;
    const binary = path.join(prepared.releaseRoot, "AgentHub.RuntimeHost.exe");
    await fs.appendFile(binary, "drift");
    const corrupt = await import(pathToFileURL(path.join(prepared.releaseRoot, "src/infrastructure/process/windows-lock-directory-publication.mjs")).href + "?corrupt");
    await assert.rejects(corrupt.prepareWindowsLockDirectoryPublisher(), /size mismatch|hash mismatch/u);
    await publisher.shutdown();
    publisher = null;
    await assert.rejects(fs.lstat(compiledRoot), { code: "ENOENT" });
  } finally {
    await preparedPublisher?.shutdown();
    await publisher?.shutdown();
    // The copied source owns its own process-local bootstrap, including the
    // canonical producer's interprocess-lock import. Drain that exact owner too.
    await fs.rm(root, { recursive: true, force: true });
  }
});
