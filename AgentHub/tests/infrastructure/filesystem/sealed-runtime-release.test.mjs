import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { retireSealedRuntimeRelease } from "../../../src/infrastructure/filesystem/sealed-runtime-release.mjs";
import { trustedWindowsPowerShellPath } from "../../../src/infrastructure/process/system-boot-identity.mjs";

const native = { skip: process.platform !== "win32" || !process.env.AGENT_HUB_TEST_TMP };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const source = fileURLToPath(new URL("../../../src/infrastructure/filesystem/sealed-runtime-release.cs", import.meta.url));

async function removeOwnedFixture(root) {
  const item = await lstat(root);
  if (item.isSymbolicLink()) {
    try { await unlink(root); } catch (error) { if (error.code !== "EPERM") throw error; await rmdir(root); }
  } else if (item.isDirectory()) {
    for (const child of await readdir(root)) await removeOwnedFixture(path.join(root, child));
    await rmdir(root);
  } else await unlink(root);
}

async function fixture(t, { count = 2, declared = true, empty = [] } = {}) {
  const parent = await lstat(process.env.AGENT_HUB_TEST_TMP);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink());
  const area = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TMP, "hub-runtime-sealed-"));
  const areaId = await lstat(area, { bigint: true });
  t.after(async () => {
    assert.equal(path.dirname(area), process.env.AGENT_HUB_TEST_TMP);
    const current = await lstat(area, { bigint: true });
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.ino, areaId.ino);
    assert.equal(current.dev, areaId.dev);
    await removeOwnedFixture(area);
  });
  const root = path.join(area, "runtime"), files = [];
  await mkdir(path.join(root, "assets"), { recursive: true });
  for (let n = 0; n < count; n++) {
    const relative = `assets/${String(n).padStart(3, "0")}.txt`, bytes = Buffer.from(`saved asset ${n}`);
    await writeFile(path.join(root, relative), bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const directory of empty) await mkdir(path.join(root, directory), { recursive: true });
  const document = { releaseId: "fixture-runtime", files, ...(declared ? { directories: ["assets", ...empty] } : {}) };
  const manifest = path.join(root, "runtime-manifest.json");
  await writeFile(manifest, JSON.stringify(document));
  const identity = await lstat(root, { bigint: true });
  const binding = { releaseId: document.releaseId, manifestSha256: hash(await readFile(manifest)),
    root: { dev: String(identity.dev), ino: String(identity.ino),
      birthFileTime: String(identity.birthtimeNs / 100n + 116444736000000000n) } };
  return { area, root, files, document, binding, manifest,
    async updateManifest() { await writeFile(manifest, JSON.stringify(document)); binding.manifestSha256 = hash(await readFile(manifest)); } };
}

async function assertIntact(f) {
  assert.equal((await lstat(f.root)).isDirectory(), true);
  assert.equal((await readdir(path.join(f.root, "assets"))).length, f.files.length);
  assert.equal(hash(await readFile(f.manifest)), f.binding.manifestSha256);
}

test("binding validation refuses before launching any helper", () => {
  const good = { releaseId: "fixture-runtime", manifestSha256: "a".repeat(64), root: { dev: "1", ino: "2", birthFileTime: "3" } };
  for (const [target, binding, options] of [
    ["relative", good], ["X:\\", good], ["X:\\fixture", { ...good, manifestSha256: "bad" }],
    ["X:\\fixture", { ...good, root: { ...good.root, ino: "18446744073709551616" } }],
    ["X:\\fixture", { ...good, root: { ...good.root, birthFileTime: 3 } }],
    ["X:\\fixture", good, { allowPartial: "true" }],
  ]) assert.throws(() => retireSealedRuntimeRelease(target, binding, options), TypeError);
});

test("actual compiled owner removes exact tree, declared empty directories and manifest last", native, async t => {
  const f = await fixture(t, { empty: ["empty/nested"] });
  const result = await retireSealedRuntimeRelease(f.root, f.binding);
  assert.deepEqual(result, { status: "complete", files: 2, logicalBytes: f.files.reduce((sum, item) => sum + item.bytes, 0) });
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
});

test("64-file partial outcome requires original partial authority to resume", native, async t => {
  const f = await fixture(t, { count: 65 });
  const manifest = await readFile(f.manifest);
  const partial = await retireSealedRuntimeRelease(f.root, f.binding);
  assert.equal(partial.status, "partial"); assert.equal(partial.files, 64);
  assert.equal((await readdir(path.join(f.root, "assets"))).length, 1);
  assert.deepEqual(await readFile(f.manifest), manifest);
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-missing-unadmitted-data/u);
  assert.equal((await readdir(path.join(f.root, "assets"))).length, 1);
  assert.deepEqual(await retireSealedRuntimeRelease(f.root, f.binding, { allowPartial: true }),
    { status: "complete", files: 1, logicalBytes: f.files[64].bytes });
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
});

test("actual byte budget stops before a second 129MiB asset and resumes the same binding", native, async t => {
  const f = await fixture(t, { count: 0 }), bytes = 129 * 1024 * 1024;
  const chunk = Buffer.alloc(1024 * 1024, 0x2a), digest = createHash("sha256");
  for (let n = 0; n < 129; n++) digest.update(chunk);
  const sha256 = digest.digest("hex");
  for (const name of ["a.bin", "b.bin"]) {
    const relative = `assets/${name}`, file = await open(path.join(f.root, relative), "wx");
    try { for (let n = 0; n < 129; n++) await file.write(chunk); }
    finally { await file.close(); }
    f.document.files.push({ path: relative, bytes, sha256 });
  }
  await f.updateManifest();
  assert.deepEqual(await retireSealedRuntimeRelease(f.root, f.binding), { status: "partial", files: 1, logicalBytes: bytes });
  assert.equal((await readdir(path.join(f.root, "assets"))).length, 1);
  assert.deepEqual(await retireSealedRuntimeRelease(f.root, f.binding, { allowPartial: true }),
    { status: "complete", files: 1, logicalBytes: bytes });
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
});

test("exact native root creation and file ID are independently required", native, async t => {
  const f = await fixture(t);
  for (const key of ["birthFileTime", "ino"]) {
    const changed = { ...f.binding, root: { ...f.binding.root, [key]: String(BigInt(f.binding.root[key]) + 1n) } };
    await assert.rejects(retireSealedRuntimeRelease(f.root, changed), /runtime-root-changed/u);
    await assertIntact(f);
  }
});

test("unknown names, root/dir/file streams, hardlinks and writer locks refuse before effects", native, async t => {
  for (const mode of ["unknown-file", "unknown-dir", "root-ads", "directory-ads", "asset-ads", "manifest-ads", "hardlink", "writer"]) {
    const f = await fixture(t), asset = path.join(f.root, f.files[0].path);
    let writer;
    const stream = mode === "root-ads" ? `${f.root}:useful`
      : mode === "directory-ads" ? `${path.join(f.root, "assets")}:useful`
        : mode === "asset-ads" ? `${asset}:useful` : mode === "manifest-ads" ? `${f.manifest}:useful` : null;
    if (mode === "unknown-file") await writeFile(path.join(f.root, "useful-WIP"), "preserve me");
    if (mode === "unknown-dir") await mkdir(path.join(f.root, "useful-empty"));
    if (stream) await writeFile(stream, "valuable stream");
    if (mode === "hardlink") await link(asset, path.join(f.area, "external-link"));
    if (mode === "writer") writer = await open(asset, "r+");
    try { await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-/u, mode); }
    finally { await writer?.close(); }
    await assertIntact(f);
    if (stream) assert.equal(await readFile(stream, "utf8"), "valuable stream");
    if (mode === "unknown-file") assert.equal(await readFile(path.join(f.root, "useful-WIP"), "utf8"), "preserve me");
    if (mode === "hardlink") assert.equal(hash(await readFile(path.join(f.area, "external-link"))), f.files[0].sha256);
  }
});

test("same-path plain replacement and reparse ancestors preserve foreign data", native, async t => {
  const f = await fixture(t), held = path.join(f.area, "saved-original");
  await rename(f.root, held);
  await mkdir(f.root);
  await writeFile(path.join(f.root, "foreign-evidence.txt"), "foreign replacement");
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-root-changed/u);
  assert.equal(await readFile(path.join(f.root, "foreign-evidence.txt"), "utf8"), "foreign replacement");
  await removeOwnedFixture(f.root);
  await symlink(held, f.root, "junction");
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-reparse-refused/u);
  const alias = path.join(f.area, "alias");
  await symlink(f.area, alias, "junction");
  await assert.rejects(retireSealedRuntimeRelease(path.join(alias, "saved-original"), f.binding), /runtime-reparse-refused/u);
  assert.equal(hash(await readFile(path.join(held, f.files[0].path))), f.files[0].sha256);
});

test("manifest hash and release identity never adopt changed metadata", native, async t => {
  const f = await fixture(t);
  f.document.releaseId = "different-release";
  await writeFile(f.manifest, JSON.stringify(f.document));
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-manifest-changed/u);
  f.binding.manifestSha256 = hash(await readFile(f.manifest));
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-release-changed/u);
  assert.equal((await readdir(path.join(f.root, "assets"))).length, 2);
});

test("legacy derived parents work; unknown empty directory is never age-adopted", native, async t => {
  const f = await fixture(t, { declared: false });
  await mkdir(path.join(f.root, "empty-unknown"));
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-unexpected-directory/u);
  await assertIntact(f);
  await rmdir(path.join(f.root, "empty-unknown"));
  assert.equal((await retireSealedRuntimeRelease(f.root, f.binding)).status, "complete");
});

test("same-size late asset drift preserves changed bytes after an earlier valid batch", native, async t => {
  const f = await fixture(t, { count: 65 });
  assert.equal((await retireSealedRuntimeRelease(f.root, f.binding)).files, 64);
  const last = path.join(f.root, f.files[64].path), changed = Buffer.from("SAVED ASSET 64");
  assert.equal(changed.length, f.files[64].bytes);
  await writeFile(last, changed);
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding, { allowPartial: true }), /runtime-asset-hash-changed/u);
  assert.deepEqual(await readFile(last), changed);
  assert.equal((await readdir(path.join(f.root, "assets"))).length, 1);
  assert.equal(hash(await readFile(f.manifest)), f.binding.manifestSha256);
});

test("missing final manifest accepts only admitted same empty default-stream root", native, async t => {
  const f = await fixture(t, { count: 0 });
  await rmdir(path.join(f.root, "assets"));
  await unlink(f.manifest); // Model a crash after the owner's last manifest disposition.
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-manifest-unavailable/u);
  await writeFile(path.join(f.root, "foreign-WIP"), "retain");
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding, { allowPartial: true }), /runtime-manifest-unavailable/u);
  assert.equal(await readFile(path.join(f.root, "foreign-WIP"), "utf8"), "retain");
  await unlink(path.join(f.root, "foreign-WIP"));
  await writeFile(`${f.root}:useful`, "retain root stream");
  await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding, { allowPartial: true }), /runtime-extra-stream/u);
  assert.equal(await readFile(`${f.root}:useful`, "utf8"), "retain root stream");
  await unlink(`${f.root}:useful`);
  assert.deepEqual(await retireSealedRuntimeRelease(f.root, f.binding, { allowPartial: true }),
    { status: "complete", files: 0, logicalBytes: 0 });
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
});

test("path ambiguity, directory collision and excessive asset budget refuse metadata before effects", native, async t => {
  for (const mode of ["traversal", "duplicate-case", "trailing-dot", "file-directory", "byte-budget"]) {
    const f = await fixture(t);
    if (mode === "traversal") f.document.files[0].path = "../foreign";
    if (mode === "duplicate-case") f.document.files.push({ ...f.document.files[0], path: f.document.files[0].path.toUpperCase() });
    if (mode === "trailing-dot") f.document.files[0].path = "assets/000.txt.";
    if (mode === "file-directory") f.document.directories.push(f.document.files[0].path);
    if (mode === "byte-budget") f.document.files[0].bytes = 256 * 1024 * 1024 + 1;
    await f.updateManifest();
    await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-/u, mode);
    assert.equal((await readdir(path.join(f.root, "assets"))).length, 2);
    assert.equal(hash(await readFile(f.manifest)), f.binding.manifestSha256);
  }
});

test("an existing exact native root holder blocks overlapping helper and root replacement", native, async t => {
  const f = await fixture(t);
  const script = ["$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'", "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$net=[System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()",
    "Add-Type -Path $env:FIXTURE_SOURCE -ReferencedAssemblies @((Join-Path $net 'System.Web.Extensions.dll'),(Join-Path $net 'System.dll'))",
    "$m=[AgentHubSealedRuntimeRelease].GetMethod('Open',[System.Reflection.BindingFlags]'NonPublic,Static')",
    "$h=$m.Invoke($null,@($env:FIXTURE_ROOT,$true,$false))",
    "try { [Console]::WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $h.Dispose() }"].join("\n");
  const child = spawn(trustedWindowsPowerShellPath(process.env), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      FIXTURE_SOURCE: source, FIXTURE_ROOT: f.root }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(errors || `holder exit ${code}`)));
  });
  try {
    await Promise.race([
      new Promise(resolve => { if (output.includes("ready")) resolve(); else child.stdout.on("data", () => { if (output.includes("ready")) resolve(); }); }),
      ended.then(() => { throw new Error("holder exited before custody"); }),
    ]);
    await assert.rejects(retireSealedRuntimeRelease(f.root, f.binding), /runtime-/u);
    await assert.rejects(rename(f.root, path.join(f.area, "moved")));
    await assertIntact(f);
  } finally { child.stdin.end("done\n"); await ended; }
  assert.equal((await retireSealedRuntimeRelease(f.root, f.binding)).status, "complete");
});
