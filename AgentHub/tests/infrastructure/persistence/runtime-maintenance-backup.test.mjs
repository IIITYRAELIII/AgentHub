import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as owner from "../../../src/infrastructure/persistence/runtime-maintenance-backup.mjs";

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "hb380-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, "hub"), data = path.join(root, "data");
  await mkdir(data, { recursive: true });
  await writeFile(path.join(root, "config.json"), '{"auth":"private-fixture","cursor":17}');
  return { base, root, data, destination: path.join(base, "backup") };
}

test("declared backup preserves real Git WIP and dependency junctions in place while snapshotting custody and UNKNOWN", async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.data, "task-worktrees", "task", "repo");
  await mkdir(repo, { recursive: true });
  const git = async (...args) => (await promisify(execFile)("git", args, { cwd: repo, windowsHide: true })).stdout;
  await git("init", "-b", "task");
  await writeFile(path.join(repo, "tracked.txt"), "saved");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "owned fixture");
  await writeFile(path.join(repo, "tracked.txt"), "dirty");
  await writeFile(path.join(repo, "unfinished.txt"), "uncommitted WIP");
  const dependencies = path.join(f.base, "external-dependencies");
  await mkdir(dependencies); await writeFile(path.join(dependencies, "foreign.txt"), "must stay external");
  await symlink(dependencies, path.join(repo, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const beforeGit = [await git("rev-parse", "HEAD"), await git("status", "--porcelain=v1", "--untracked-files=all")];
  const epoch = "a".repeat(32), custody = path.join(f.data, "task-custody", epoch);
  await mkdir(custody, { recursive: true });
  await writeFile(path.join(custody, "intent.json"), '{"epoch":"original"}');
  await writeFile(path.join(custody, "snapshot.json"), '{"head":"saved","dirty":true}');
  await mkdir(path.join(custody, "repository"));
  await symlink(dependencies, path.join(custody, "repository", "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const db = new DatabaseSync(path.join(f.data, "journal.sqlite"));
  try {
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE receipt(id TEXT, outcome TEXT); INSERT INTO receipt VALUES('original','unknown')");
  let proofs = 0;
  const result = await owner.backupStoppedRuntime({ runtimeRoot: f.root, destination: f.destination,
    assertStopped: async () => { proofs++; } });
  assert.ok(proofs >= 2);
  assert.equal(result.scope, "runtime-durable-state-v1");
  assert.ok(result.retained.some(e => e.path === path.join("data", "task-worktrees")));
  assert.ok(result.retained.some(e => e.path === path.join("data", "task-custody", epoch, "repository")));
  assert.ok(!result.files.some(e => /node_modules|unfinished/u.test(e.path)));
  assert.equal(await readFile(path.join(repo, "unfinished.txt"), "utf8"), "uncommitted WIP");
  assert.equal(await readFile(path.join(repo, "node_modules", "foreign.txt"), "utf8"), "must stay external");
  assert.deepEqual([await git("rev-parse", "HEAD"), await git("status", "--porcelain=v1", "--untracked-files=all")], beforeGit);
  assert.equal(await readFile(path.join(f.destination, "data", "task-custody", epoch, "snapshot.json"), "utf8"), '{"head":"saved","dirty":true}');
  const copy = new DatabaseSync(path.join(f.destination, "data", "journal.sqlite"), { readOnly: true });
  try {
    assert.equal(copy.prepare("SELECT outcome FROM receipt WHERE id='original'").get().outcome, "unknown");
    assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { copy.close(); }
  assert.equal(db.prepare("SELECT outcome FROM receipt").get().outcome, "unknown");
  } finally { db.close(); }
});

test("pre-stop scope inspection is readonly, refuses selected links and reports unclassified retention", async (t) => {
  const f = await fixture(t), outside = path.join(f.base, "outside");
  await mkdir(outside); await writeFile(path.join(outside, "foreign"), "unchanged");
  await mkdir(path.join(f.data, "new-state"));
  await writeFile(path.join(f.data, "new-state", "receipt.json"), '{"status":"unknown"}');
  const inventory = await owner.inspectRuntimeBackupScope({ runtimeRoot: f.root });
  assert.ok(inventory.retained.some(e => e.path === path.join("data", "new-state") && e.reason === "unclassified-not-backed-up"));
  assert.deepEqual((await readdir(f.base)).sort(), ["hub", "outside"]);
  await mkdir(path.join(f.data, "background-jobs"));
  const link = path.join(f.data, "background-jobs", "linked");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(owner.inspectRuntimeBackupScope({ runtimeRoot: f.root }), /linked|plain/u);
  await assert.rejects(owner.backupStoppedRuntime({ runtimeRoot: f.root, destination: f.destination,
    assertStopped: async () => {} }), /linked|plain/u);
  assert.equal(await readFile(path.join(outside, "foreign"), "utf8"), "unchanged");
  assert.deepEqual((await readdir(f.base)).sort(), ["hub", "outside"]);
});

test("SQLite headers bind every selected database irrespective of suffix and a later busy database releases earlier reservations", async (t) => {
  const f = await fixture(t);
  const first = new DatabaseSync(path.join(f.data, "a.database"));
  const last = new DatabaseSync(path.join(f.data, "z.sqlite"));
  try {
    first.exec("CREATE TABLE receipt(v); INSERT INTO receipt VALUES('unknown')");
    last.exec("CREATE TABLE receipt(v); BEGIN IMMEDIATE; INSERT INTO receipt VALUES('uncommitted')");
    await assert.rejects(owner.backupStoppedRuntime({ runtimeRoot: f.root, destination: f.destination,
      assertStopped: async () => {} }), /locked|busy/u);
    first.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK");
    last.exec("ROLLBACK");
    const result = await owner.backupStoppedRuntime({ runtimeRoot: f.root,
      destination: path.join(f.base, "success"), assertStopped: async () => {} });
    assert.equal(result.files.find(e => e.path === path.join("data", "a.database")).integrity, "ok");
    const read = new DatabaseSync(path.join(result.directory, "data", "a.database"), { readOnly: true });
    try { assert.equal(read.prepare("SELECT v FROM receipt").get().v, "unknown"); }
    finally { read.close(); }
  } finally { last.close(); first.close(); }
});

test("stopped proof, retained-root replacement and exclusive backup failures never overwrite or mutate originals", async (t) => {
  const f = await fixture(t), retained = path.join(f.data, "task-worktrees");
  await mkdir(retained); await writeFile(path.join(retained, "wip"), "original");
  await assert.rejects(owner.backupStoppedRuntime({ runtimeRoot: f.root, destination: f.destination,
    assertStopped: async () => { throw new Error("actual original Job not zero"); } }), /Job not zero/u);
  assert.ok(!(await readdir(f.base)).includes("backup"));
  await mkdir(f.destination); await writeFile(path.join(f.destination, "foreign"), "do not overwrite");
  await assert.rejects(owner.backupStoppedRuntime({ runtimeRoot: f.root, destination: f.destination,
    assertStopped: async () => {} }), /EEXIST/u);
  assert.equal(await readFile(path.join(f.destination, "foreign"), "utf8"), "do not overwrite");
  const inspect = await owner.inspectRuntimeBackupScope({ runtimeRoot: f.root });
  await rename(retained, retained + "-saved"); await mkdir(retained);
  await assert.rejects(owner.assertRuntimeBackupScope(inspect), /changed/u);
  assert.equal(await readFile(path.join(retained + "-saved", "wip"), "utf8"), "original");
});

test("partial custody, linked retained roots and orphan SQLite companions fail support inspection", async (t) => {
  const f = await fixture(t), custody = path.join(f.data, "task-custody", "b".repeat(32));
  await mkdir(path.join(custody, "repository"), { recursive: true });
  await writeFile(path.join(custody, "intent.json"), "{}");
  await assert.rejects(owner.inspectRuntimeBackupScope({ runtimeRoot: f.root }), /incomplete/u);
  await writeFile(path.join(custody, "snapshot.json"), "{}");
  await owner.inspectRuntimeBackupScope({ runtimeRoot: f.root });
  const outside = path.join(f.base, "outside"); await mkdir(outside);
  const linkedRoot = path.join(f.data, "task-worktrees");
  await symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(owner.inspectRuntimeBackupScope({ runtimeRoot: f.root }), /linked/u);
  await rm(linkedRoot, { recursive: true });
  await writeFile(path.join(f.data, "lost.sqlite-wal"), "orphan evidence");
  await assert.rejects(owner.inspectRuntimeBackupScope({ runtimeRoot: f.root }), /orphan/u);
  assert.equal(await readFile(path.join(f.data, "lost.sqlite-wal"), "utf8"), "orphan evidence");
});

test("outside-volume destination reaches exclusive output refusal without touching an existing directory", async (t) => {
  const f = await fixture(t);
  const sourceDrive = path.parse(f.root).root;
  const repositoryDrive = path.parse(import.meta.dirname).root;
  const crossVolume = process.platform === "win32" && sourceDrive.toLowerCase() !== repositoryDrive.toLowerCase();
  const existingOutside = crossVolume ? import.meta.dirname : f.base;
  const before = await lstat(existingOutside, { bigint: true });
  assert.ok(before.isDirectory() && !before.isSymbolicLink());
  let proofs = 0;
  await assert.rejects(owner.backupStoppedRuntime({ runtimeRoot: f.root, destination: existingOutside,
    assertStopped: async () => { proofs++; } }), { code: "EEXIST" });
  const after = await lstat(existingOutside, { bigint: true });
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
  assert.equal(proofs, 1);
  t.diagnostic(`actualCrossVolume=${crossVolume}; existingOutputUnchanged=true`);
});

test("same-volume outside output remains exclusive while runtime root and child destinations refuse", async (t) => {
  const f = await fixture(t);
  for (const destination of [f.root, path.join(f.root, "new-backup")]) {
    await assert.rejects(owner.backupStoppedRuntime({ runtimeRoot: f.root, destination,
      assertStopped: async () => {} }), /outside runtime root/u);
  }
  assert.deepEqual((await readdir(f.root)).sort(), ["config.json", "data"]);
  await assert.rejects(owner.backupStoppedRuntime({ runtimeRoot: f.root, destination: f.base,
    assertStopped: async () => {} }), { code: "EEXIST" });
});

for (const scalar of ["intent.json", "snapshot.json"]) test(`custody mandatory ${scalar} must be a regular scalar before stop`, async (t) => {
  const f = await fixture(t), custody = path.join(f.data, "task-custody", "c".repeat(32));
  await mkdir(path.join(custody, "repository"), { recursive: true });
  await mkdir(path.join(custody, scalar));
  await writeFile(path.join(custody, scalar === "intent.json" ? "snapshot.json" : "intent.json"), "{}");
  await assert.rejects(owner.inspectRuntimeBackupScope({ runtimeRoot: f.root }), /plain|scalar/u);
  let stopped = 0;
  await assert.rejects(owner.backupStoppedRuntime({ runtimeRoot: f.root, destination: f.destination,
    assertStopped: async () => { stopped++; } }), /plain|scalar/u);
  assert.equal(stopped, 1);
  assert.ok(!(await readdir(f.base)).includes("backup"));
  assert.ok((await lstat(path.join(custody, scalar))).isDirectory());
});
