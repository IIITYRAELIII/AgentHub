import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySelectedCompositionFiles,
  prepareSelectedCompositionFiles,
  readSelectedCompositionFiles,
  rollbackSelectedCompositionFiles,
  selectedCompositionFilePlan,
} from "../../../src/infrastructure/filesystem/selected-composition-materializer.mjs";

function blob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "selected-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "docs"));
  const old = Buffer.from("tracked-old\n");
  const next = Buffer.from("tracked-next\n");
  const added = Buffer.from("reviewed-addition\n");
  await writeFile(path.join(root, "tracked.txt"), old);
  const blobs = new Map([[blob(old), old], [blob(next), next], [blob(added), added]]);
  const raw = `:100644 100644 ${blob(old)} ${blob(next)} M\0tracked.txt\0`
    + `:000000 100644 ${"0".repeat(40)} ${blob(added)} A\0docs/new.txt\0`;
  const journalRoot = path.join(root, ".git", "selected-operation");
  return { root, old, next, added, journalRoot,
    plan: selectedCompositionFilePlan(raw), readBlob: async (sha) => blobs.get(sha) };
}

test("selected materialization admits exact edits and additions, then replays after restart", async (t) => {
  const f = await fixture(t);
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  await applySelectedCompositionFiles(record);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.next);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), f.added);
  const restarted = await readSelectedCompositionFiles(f.journalRoot, record);
  await applySelectedCompositionFiles(restarted);
  await rollbackSelectedCompositionFiles(restarted);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.old);
  await assert.rejects(readFile(path.join(f.root, "docs/new.txt")), { code: "ENOENT" });
});

test("pre-CAS restart discards only incomplete private staging, then publishes a complete record", async (t) => {
  const f = await fixture(t);
  await mkdir(f.journalRoot);
  await writeFile(path.join(f.journalRoot, "new-0"), "partial staged bytes");
  await writeFile(path.join(f.journalRoot,
    "record.json.tmp-00000000-0000-4000-8000-000000000000"), "{partial");
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  assert.equal((await readSelectedCompositionFiles(f.journalRoot)).files.length, 2);
  await applySelectedCompositionFiles(record);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.next);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), f.added);
});

test("incomplete preparation refuses an unexpected backup without deleting it", async (t) => {
  const f = await fixture(t);
  await mkdir(f.journalRoot);
  await writeFile(path.join(f.journalRoot, "old-0"), "private backup");
  await assert.rejects(prepareSelectedCompositionFiles({ ...f, files: f.plan }),
    /unexpected entry/u);
  assert.equal(await readFile(path.join(f.journalRoot, "old-0"), "utf8"), "private backup");
});

test("late ignored collision never loses private bytes, and original rollback restores edits", async (t) => {
  const f = await fixture(t);
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  const privateBytes = Buffer.from("private ignored content\n");
  await writeFile(path.join(f.root, "docs/new.txt"), privateBytes);
  await assert.rejects(applySelectedCompositionFiles(record), /foreign bytes/u);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
  await rollbackSelectedCompositionFiles(record);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.old);
});

test("a replaced owned addition remains foreign during restart recovery", async (t) => {
  const f = await fixture(t);
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  await applySelectedCompositionFiles(record);
  await unlink(path.join(f.root, "docs/new.txt"));
  const privateBytes = Buffer.from("replacement-private\n");
  await writeFile(path.join(f.root, "docs/new.txt"), privateBytes);
  const restarted = await readSelectedCompositionFiles(f.journalRoot, record);
  await rollbackSelectedCompositionFiles(restarted);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
});

test("exclusive link refuses a collision injected exactly after the last absence check", async (t) => {
  const f = await fixture(t);
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  const privateBytes = Buffer.from("late-private\n");
  await assert.rejects(applySelectedCompositionFiles(record, {
    beforeLink: async (file, target) => {
      if (file.kind === "A") await writeFile(target, privateBytes, { flag: "wx" });
    },
  }), { code: "EEXIST" });
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
  await rollbackSelectedCompositionFiles(await readSelectedCompositionFiles(f.journalRoot, record));
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.old);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
});

test("a late private replacement of a tracked path retains its old backup", async (t) => {
  const f = await fixture(t);
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  const privateBytes = Buffer.from("late-tracked-private\n");
  await assert.rejects(applySelectedCompositionFiles(record, {
    beforeLink: async (file, target) => {
      if (file.kind === "M") await writeFile(target, privateBytes, { flag: "wx" });
    },
  }), { code: "EEXIST" });
  await assert.rejects(rollbackSelectedCompositionFiles(record), /preserves foreign target/u);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), privateBytes);
  assert.deepEqual(await readFile(record.files[0].backup), f.old);
});

test("unsupported deleted, symlink, directory and mode changes refuse before an effect", () => {
  const zero = "0".repeat(40);
  const one = "1".repeat(40);
  const two = "2".repeat(40);
  for (const raw of [
    `:100644 000000 ${one} ${zero} D\0old.txt\0`,
    `:000000 120000 ${zero} ${one} A\0link.txt\0`,
    `:040000 100644 ${one} ${two} T\0dir\0`,
    `:100644 100755 ${one} ${two} M\0mode.txt\0`,
  ]) assert.throws(() => selectedCompositionFilePlan(raw), /cannot materialize/u);
});
