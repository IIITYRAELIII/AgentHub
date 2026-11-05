import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteSealedTransport } from "../../../src/infrastructure/filesystem/sealed-transport-delete.mjs";

async function fixture(t) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, "hub-transport-sealed-"));
  const rootInfo = await lstat(root, { bigint: true });
  t.after(async () => {
    const now = await lstat(root, { bigint: true });
    assert.equal(path.dirname(await realpath(root)), parent);
    assert.equal(now.isSymbolicLink(), false); assert.equal(now.dev, rootInfo.dev); assert.equal(now.ino, rootInfo.ino);
    await rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "source.bundle");
  await writeFile(file, "reproducible transport");
  const i = await lstat(file, { bigint: true });
  const binding = { dev: String(i.dev), ino: String(i.ino), size: String(i.size),
    sha256: createHash("sha256").update(await readFile(file)).digest("hex") };
  return { root, file, binding };
}

async function readonlyPack(t, { namedStream = false } = {}) {
  const f = await fixture(t), odb = path.join(f.root, "fixture.git");
  const run = (args, input) => execFileSync("git", args, { cwd: f.root, input,
    windowsHide: true, maxBuffer: 128 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  run(["init", "--bare", "--quiet", odb]);
  const oid = run(["--git-dir", odb, "hash-object", "-w", f.file]).toString("utf8").trim();
  const bytes = run(["--git-dir", odb, "pack-objects", "--stdout"], oid + "\n");
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "PACK");
  const file = path.join(f.root, "literal.pack"); await writeFile(file, bytes);
  if (namedStream) await writeFile(`${file}:useful`, "preserve named stream");
  await chmod(file, 0o444);
  const info = await lstat(file, { bigint: true });
  assert.equal(info.mode & 0o200n, 0n, "Windows read-only attribute is present");
  return { ...f, file, bytes, binding: { dev: String(info.dev), ino: String(info.ino), size: String(info.size),
    sha256: createHash("sha256").update(bytes).digest("hex") } };
}

test("sealed literal read-only Git pack deletes through its verified handle without clearing attributes", { skip: process.platform !== "win32" }, async t => {
  const f = await readonlyPack(t);
  await deleteSealedTransport(f.file, f.binding);
  await assert.rejects(lstat(f.file), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.root, "source.bundle"), "utf8"), "reproducible transport");
});

test("read-only literal pack native hash exit and same-path replacement preserve foreign bytes", { skip: process.platform !== "win32" }, async t => {
  const f = await readonlyPack(t);
  await assert.rejects(deleteSealedTransport(f.file, { ...f.binding, sha256: "0".repeat(64) }), error => {
    assert.match(error.message, /transport-hash-changed/u);
    assert.notEqual(error.code, 0); assert.equal(error.killed, false); return true;
  });
  assert.deepEqual(await readFile(f.file), f.bytes);
  assert.equal((await lstat(f.file)).mode & 0o200, 0);
  const kept = path.join(f.root, "retained-original.pack"); await rename(f.file, kept);
  await writeFile(f.file, f.bytes); await chmod(f.file, 0o444);
  await assert.rejects(deleteSealedTransport(f.file, f.binding), /transport-identity-changed/u);
  assert.deepEqual(await readFile(f.file), f.bytes); assert.deepEqual(await readFile(kept), f.bytes);
});

test("read-only pack named streams, hardlinks and reparse ancestors remain refused", { skip: process.platform !== "win32" }, async t => {
  for (const mode of ["ads", "hardlink", "junction"]) {
    const f = await readonlyPack(t, { namedStream: mode === "ads" }); let target = f.file;
    if (mode === "hardlink") await link(target, path.join(f.root, "retained-link.pack"));
    if (mode === "junction") {
      const alias = path.join(f.root, "alias"); await symlink(f.root, alias, "junction");
      target = path.join(alias, "literal.pack");
    }
    await assert.rejects(deleteSealedTransport(target, f.binding), /transport-/u);
    assert.deepEqual(await readFile(f.file), f.bytes);
    assert.equal((await lstat(f.file)).mode & 0o200, 0, "refusal must not clear read-only attributes");
    if (mode === "ads") assert.equal(await readFile(`${f.file}:useful`, "utf8"), "preserve named stream");
    if (mode === "hardlink") assert.deepEqual(await readFile(path.join(f.root, "retained-link.pack")), f.bytes);
  }
});

test("sealed transport deletes exact bytes and rejects same-size changed bytes", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await writeFile(f.file, "REPRODUCIBLE TRANSPORT");
  await assert.rejects(deleteSealedTransport(f.file, f.binding), /transport-hash-changed/u);
  assert.equal(await readFile(f.file, "utf8"), "REPRODUCIBLE TRANSPORT");
  await writeFile(f.file, "reproducible transport");
  await deleteSealedTransport(f.file, f.binding);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("named stream, hardlink, writer and substituted junction all preserve payload", { skip: process.platform !== "win32" }, async t => {
  for (const mode of ["ads", "hardlink", "writer", "junction", "same-object-junction"]) {
    const f = await fixture(t);
    let writer;
    if (mode === "ads") await writeFile(`${f.file}:useful`, "unique user data");
    if (mode === "hardlink") await link(f.file, path.join(f.root, "second"));
    if (mode === "writer") writer = await open(f.file, "r+");
    if (mode === "junction") {
      const foreign = path.join(f.root, "foreign"); await mkdir(foreign);
      await writeFile(path.join(foreign, "source.bundle"), "reproducible transport");
      const alias = path.join(f.root, "alias"); await symlink(foreign, alias, "junction");
      f.file = path.join(alias, "source.bundle");
    }
    if (mode === "same-object-junction") {
      const alias = path.join(f.root, "alias"); await symlink(f.root, alias, "junction");
      f.file = path.join(alias, "source.bundle");
    }
    try { await assert.rejects(deleteSealedTransport(f.file, f.binding), /transport-/u); }
    finally { await writer?.close(); }
    assert.equal(await readFile(f.file, "utf8"), "reproducible transport");
    if (mode === "ads") assert.equal(await readFile(`${f.file}:useful`, "utf8"), "unique user data");
  }
});
