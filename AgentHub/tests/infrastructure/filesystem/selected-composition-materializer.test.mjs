import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  selectedCompositionFilePlan, readSelectedCheckoutAuthority, verifySelectedCompositionFiles,
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
    readCheckout: async (paths) => ({ version: 1, platform: process.platform,
      config: { autocrlf: "false", eol: null, safecrlf: null },
      attributes: paths.map((name) => ({ path: name, text: "unspecified", eol: "unspecified",
        filter: "unspecified", "working-tree-encoding": "unspecified", ident: "unspecified" })) }),
    files: selectedCompositionFilePlan(raw), plan: selectedCompositionFilePlan(raw), readBlob: async (sha) => blobs.get(sha) };
}

test("selected materialization admits exact edits and additions, then replays after restart", async (t) => {
  const f = await fixture(t);
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  await applySelectedCompositionFiles(record, f);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.next);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), f.added);
  const restarted = await readSelectedCompositionFiles(f.journalRoot, record, f);
  await applySelectedCompositionFiles(restarted, f);
  await rollbackSelectedCompositionFiles(restarted, f);
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
  assert.equal((await readSelectedCompositionFiles(f.journalRoot, null, f)).files.length, 2);
  await applySelectedCompositionFiles(record, f);
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
  await assert.rejects(applySelectedCompositionFiles(record, f), /foreign bytes/u);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
  await rollbackSelectedCompositionFiles(record, f);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.old);
});

test("a replaced owned addition remains foreign during restart recovery", async (t) => {
  const f = await fixture(t);
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  await applySelectedCompositionFiles(record, f);
  await unlink(path.join(f.root, "docs/new.txt"));
  const privateBytes = Buffer.from("replacement-private\n");
  await writeFile(path.join(f.root, "docs/new.txt"), privateBytes);
  const restarted = await readSelectedCompositionFiles(f.journalRoot, record, f);
  await rollbackSelectedCompositionFiles(restarted, f);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
});

test("exclusive link refuses a collision injected exactly after the last absence check", async (t) => {
  const f = await fixture(t);
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  const privateBytes = Buffer.from("late-private\n");
  await assert.rejects(applySelectedCompositionFiles(record, {
    ...f, beforeLink: async (file, target) => {
      if (file.kind === "A") await writeFile(target, privateBytes, { flag: "wx" });
    },
  }), { code: "EEXIST" });
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
  await rollbackSelectedCompositionFiles(await readSelectedCompositionFiles(f.journalRoot, record, f), f);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.old);
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), privateBytes);
});

test("a late private replacement of a tracked path retains its old backup", async (t) => {
  const f = await fixture(t);
  const record = await prepareSelectedCompositionFiles({ ...f, files: f.plan });
  const privateBytes = Buffer.from("late-tracked-private\n");
  await assert.rejects(applySelectedCompositionFiles(record, {
    ...f, beforeLink: async (file, target) => {
      if (file.kind === "M") await writeFile(target, privateBytes, { flag: "wx" });
    },
  }), { code: "EEXIST" });
  await assert.rejects(rollbackSelectedCompositionFiles(record, f), /preserves foreign target/u);
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

const gitExec = promisify(execFile);
async function realEolFixture(t) {
  const f = await fixture(t);
  const git = async (args, options = {}) => {
    try { return (await gitExec("git", args, { cwd: f.root, windowsHide: true })).stdout; }
    catch (error) { if (options.acceptableExitCodes?.includes(error.code)) return error.stdout; throw error; }
  };
  await git(["init", "-q"]);
  await git(["config", "core.autocrlf", "true"]);
  await git(["add", "tracked.txt"]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "old"]);
  await git(["config", "core.autocrlf", "true"]);
  const physicalOld = Buffer.from(f.old.toString().replace(/\n/gu, "\r\n"));
  await unlink(path.join(f.root, "tracked.txt"));
  await git(["checkout-index", "--index", "--force", "--all"]);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), physicalOld,
    await git(["config", "--show-origin", "--get", "core.autocrlf"]) + await git(["check-attr", "--all", "--", "tracked.txt"]));
  assert.equal((await git(["status", "--porcelain"])).trim(), "");
  return { ...f, git, physicalOld,
    readCheckout: (paths) => readSelectedCheckoutAuthority(git, paths) };
}

test("real Git CRLF checkout stages CRLF, reopens, and rolls back exact physical bytes", async (t) => {
  const f = await realEolFixture(t);
  const record = await prepareSelectedCompositionFiles(f);
  assert.equal(record.version, 2);
  assert.equal(record.files[0].oldSerialization, "checkout");
  await applySelectedCompositionFiles(record, f);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), Buffer.from("tracked-next\r\n"));
  assert.deepEqual(await readFile(path.join(f.root, "docs/new.txt")), Buffer.from("reviewed-addition\r\n"));
  const reopened = await readSelectedCompositionFiles(f.journalRoot, record, f);
  await verifySelectedCompositionFiles(reopened, { ...f, phase: "applied" });
  await rollbackSelectedCompositionFiles(reopened, f);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.physicalOld);
  assert.equal((await f.git(["status", "--porcelain"])).trim(), "");
});

for (const kind of ["config", "attributes", "filter", "encoding"]) test(`real Git EOL ${kind} drift refuses and preserves exact journal and checkout`, async (t) => {
  const f = await realEolFixture(t);
  const record = await prepareSelectedCompositionFiles(f);
  if (kind === "config") await f.git(["config", "core.autocrlf", "false"]);
  else await writeFile(path.join(f.root, ".git", "info", "attributes"),
    `tracked.txt ${kind === "attributes" ? "eol=lf" : kind === "filter" ? "filter=never-run" : "working-tree-encoding=UTF-16"}\n`);
  const before = await readFile(path.join(f.journalRoot, "record.json"));
  await assert.rejects(readSelectedCompositionFiles(f.journalRoot, record, f), /checkout authority changed/u);
  await assert.rejects(applySelectedCompositionFiles(record, f), /checkout authority changed/u);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.physicalOld);
  assert.deepEqual(await readFile(path.join(f.journalRoot, "record.json")), before);
});

test("real Git clean-equivalent physical drift and real dirty content both refuse after preparation", async (t) => {
  const f = await realEolFixture(t);
  const record = await prepareSelectedCompositionFiles(f);
  await writeFile(path.join(f.root, "tracked.txt"), f.old);
  assert.equal((await f.git(["hash-object", "--path=tracked.txt", "tracked.txt"])).trim(), blob(f.old));
  await assert.rejects(verifySelectedCompositionFiles(record, { ...f, phase: "before_cas" }), /old tracked bytes changed/u);
  await assert.rejects(applySelectedCompositionFiles(record, f), /old tracked bytes changed/u);
  const dirty = Buffer.from("private genuine content\r\n");
  await writeFile(path.join(f.root, "tracked.txt"), dirty);
  await assert.rejects(applySelectedCompositionFiles(record, f), /old tracked bytes changed/u);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), dirty);
});

test("real CRLF late collision preserves foreign bytes and exact old physical backup", async (t) => {
  const f = await realEolFixture(t);
  const record = await prepareSelectedCompositionFiles(f);
  await assert.rejects(applySelectedCompositionFiles(record, { ...f, beforeLink: async (file, target) => {
    if (file.kind === "A") await writeFile(target, "private\r\n", { flag: "wx" });
  } }), { code: "EEXIST" });
  await rollbackSelectedCompositionFiles(await readSelectedCompositionFiles(f.journalRoot, record, f), f);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.physicalOld);
  assert.equal(await readFile(path.join(f.root, "docs/new.txt"), "utf8"), "private\r\n");
});

test("old materialization journal refuses without reinterpretation or byte loss", async (t) => {
  const f = await realEolFixture(t);
  const record = await prepareSelectedCompositionFiles(f);
  const legacy = { ...record, version: 1 };
  await writeFile(path.join(f.journalRoot, "record.json"), JSON.stringify(legacy));
  const before = await readFile(path.join(f.journalRoot, "record.json"));
  await assert.rejects(readSelectedCompositionFiles(f.journalRoot, null, f), /identity changed/u);
  assert.deepEqual(await readFile(path.join(f.journalRoot, "record.json")), before);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.physicalOld);
});

test("arbitrary filter is rejected during preparation without executing it", async (t) => {
  const f = await realEolFixture(t);
  await writeFile(path.join(f.root, ".git", "info", "attributes"), "tracked.txt filter=never-run\n");
  await f.git(["config", "filter.never-run.smudge", "this-command-must-never-run"]);
  await assert.rejects(prepareSelectedCompositionFiles(f), /unsupported transformation/u);
  assert.deepEqual(await readFile(path.join(f.root, "tracked.txt")), f.physicalOld);
});
