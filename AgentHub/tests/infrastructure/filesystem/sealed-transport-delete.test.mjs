import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteSealedTransport } from "../../../src/infrastructure/filesystem/sealed-transport-delete.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-transport-sealed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.bundle");
  await writeFile(file, "reproducible transport");
  const i = await lstat(file, { bigint: true });
  const binding = { dev: String(i.dev), ino: String(i.ino), size: String(i.size),
    sha256: createHash("sha256").update(await readFile(file)).digest("hex") };
  return { root, file, binding };
}

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
