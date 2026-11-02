import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OwnedNativeObjectStore, nativeObjectStorageDescriptor } from "../../../src/infrastructure/filesystem/owned-native-object-store.mjs";
import { mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { measureNativeCaptureAllocation } from "../../../src/infrastructure/filesystem/sealed-native-capture.mjs";

function gitAt(cwd, args, { input = null, stdoutFd = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", stdoutFd ?? "pipe", "pipe"] });
    const stdout = [], stderr = [];
    child.stdout?.on("data", b => stdout.push(b)); child.stderr.on("data", b => stderr.push(b));
    child.on("error", reject); child.on("close", c => c === 0 ? resolve(Buffer.concat(stdout).toString("utf8").trim())
      : reject(new Error(Buffer.concat(stderr).toString("utf8")))); child.stdin.end(input);
  });
}
async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-objects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), dataDir = path.join(root, "data");
  await mkdir(source); await mkdir(dataDir);
  await gitAt(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, "history.bin"), randomBytes(1024 * 1024));
  await gitAt(source, ["add", "."]);
  await gitAt(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const base = await gitAt(source, ["rev-parse", "HEAD"]);
  await writeFile(path.join(source, "change.txt"), "selected result\n"); await gitAt(source, ["add", "."]);
  await gitAt(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "task"]);
  const result = await gitAt(source, ["rev-parse", "HEAD"]);
  const store = new MaintenanceOperationStore({ dataDir });
  return { root, source, dataDir, base, result, store,
    objects: new OwnedNativeObjectStore({ dataDir, gitAt, store, withLease: fn => fn(), ...extra }) };
}
async function compose(f, suffix) {
  const root = path.join(f.root, suffix); await mkdir(root, { recursive: true });
  const identity = { policy: "native-dev-merge-v1", taskId: suffix, resultCommit: f.result,
    before: f.base, mainCommit: f.base, objectStorage: nativeObjectStorageDescriptor() };
  return mergeSelectedResults({ root, sourceRoot: f.source, baseCommit: f.base,
    tasks: [{ taskId: suffix, baseCommit: f.base, resultCommit: f.result }], identity, gitAt,
    provisionNativeObjects: input => f.objects.provision(input),
    readJson: file => readFile(file, "utf8").then(JSON.parse, e => { if (e.code === "ENOENT") return null; throw e; }),
    writeJson: (file, value) => writeFile(file, JSON.stringify(value)) });
}
async function objectFiles(root) {
  const files = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!/^(?:[a-f0-9]{2}|pack)$/u.test(dir.name)) continue;
    for (const name of await readdir(path.join(root, dir.name))) {
      const p = path.join(root, dir.name, name), s = await lstat(p, { bigint: true });
      files.push({ path: p, name: dir.name + "/" + name, dev: String(s.dev), ino: String(s.ino), bytes: Number(s.size), nlink: Number(s.nlink) });
    }
  }
  return files;
}

test("two real native checks share immutable history once with independent metadata and survive pool removal/consumer GC", async t => {
  const f = await fixture(t), primaryHead = await gitAt(f.source, ["rev-parse", "HEAD"]), refs = await gitAt(f.source, ["show-ref"]);
  const first = await compose(f, "one"), second = await compose(f, "two");
  assert.equal(first.tree, await gitAt(f.source, ["rev-parse", f.result + "^{tree}"]));
  assert.equal(second.tree, first.tree);
  const firstRepo = path.join(f.root, "one/repository"), secondRepo = path.join(f.root, "two/repository");
  const a = (await objectFiles(path.join(firstRepo, ".git/objects"))).filter(x => x.name.startsWith("pack/"));
  const b = (await objectFiles(path.join(secondRepo, ".git/objects"))).filter(x => x.name.startsWith("pack/"));
  assert.equal(await gitAt(firstRepo, ["show", "-s", "--format=%P", first.head]), f.base + " " + f.result);
  assert.equal(await gitAt(secondRepo, ["show", "-s", "--format=%P", second.head]), f.base + " " + f.result);
  assert.ok(a.length >= 2); assert.deepEqual(a.map(x => [x.name, x.dev, x.ino]), b.map(x => [x.name, x.dev, x.ino]));
  assert.ok(a.every(x => x.nlink >= 3));
  if (process.platform === "win32") {
    const measured = await measureNativeCaptureAllocation([path.join(firstRepo, ".git/objects"),
      path.join(secondRepo, ".git/objects"), path.join(f.objects.repository, "objects")]);
    assert.ok(measured.uniqueAllocatedBytes < measured.logicalBytes / 2, JSON.stringify(measured));
    t.diagnostic("Three object views FileStandardInfo allocation " + JSON.stringify(measured));
  }
  const unique = new Map([...a, ...b].map(x => [x.dev + ":" + x.ino, x.bytes]));
  assert.equal([...unique.values()].reduce((x, y) => x + y, 0), a.reduce((x, y) => x + y.bytes, 0));
  assert.ok((await lstat(path.join(firstRepo, ".git/index"))).ino !== (await lstat(path.join(secondRepo, ".git/index"))).ino);
  await gitAt(firstRepo, ["update-ref", "refs/heads/private-one", f.base]);
  await assert.rejects(gitAt(secondRepo, ["rev-parse", "--verify", "refs/heads/private-one"]));
  await assert.rejects(readFile(path.join(firstRepo, ".git/objects/info/alternates")), { code: "ENOENT" });
  const expected = createHash("sha256").update(await readFile(path.join(secondRepo, "history.bin"))).digest("hex");
  await rm(f.objects.root, { recursive: true, force: true });
  await gitAt(firstRepo, ["gc", "--prune=now"]);
  await rm(path.join(f.root, "one"), { recursive: true, force: true });
  await gitAt(secondRepo, ["fsck", "--full"]);
  assert.equal(createHash("sha256").update(await readFile(path.join(secondRepo, "history.bin"))).digest("hex"), expected);
  assert.equal(await gitAt(f.source, ["rev-parse", "HEAD"]), primaryHead);
  assert.equal(await gitAt(f.source, ["show-ref"]), refs);
});

test("lost completed consumer reply recovers same SQLite original without another import or link effect", async t => {
  let injected = false;
  const f = await fixture(t, { afterCheckpoint: async phase => { if (phase === "linked" && !injected) { injected = true; throw Error("lost linked reply"); } } });
  await assert.rejects(compose(f, "one"), /lost linked reply/u);
  const repo = path.join(f.root, "one/repository"), before = await objectFiles(path.join(repo, ".git/objects"));
  const originalJournal = JSON.parse(await readFile(path.join(f.root, "one/merge.json"), "utf8"));
  const result = await mergeSelectedResults({ root: path.join(f.root, "one"), sourceRoot: f.source, baseCommit: f.base,
    tasks: [{ taskId: "one", baseCommit: f.base, resultCommit: f.result }], identity: originalJournal.identity, gitAt,
    provisionNativeObjects: input => f.objects.provision(input), readJson: file => readFile(file, "utf8").then(JSON.parse),
    writeJson: (file, value) => writeFile(file, JSON.stringify(value)) });
  assert.equal(result.tree, await gitAt(f.source, ["rev-parse", f.result + "^{tree}"]));
  const after = new Map((await objectFiles(path.join(repo, ".git/objects"))).map(x => [x.path, x]));
  for (const file of before) assert.deepEqual(after.get(file.path), file);
  const final = JSON.parse(await readFile(path.join(f.root, "one/merge.json"), "utf8"));
  const row = f.store.getReadonly(final.objectStorage.operationId);
  assert.equal(row.status, "succeeded"); assert.equal(row.revision, 2);
});

test("a later distinct selection imports only missing objects and preserves the first live consumer", async t => {
  const f = await fixture(t), first = await compose(f, "one");
  const packsBefore = await objectFiles(path.join(f.objects.repository, "objects"));
  await writeFile(path.join(f.source, "later.txt"), "later selected source\n");
  await gitAt(f.source, ["add", "."]);
  await gitAt(f.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "later"]);
  f.result = await gitAt(f.source, ["rev-parse", "HEAD"]);
  const second = await compose(f, "two");
  assert.equal(second.tree, await gitAt(f.source, ["rev-parse", f.result + "^{tree}"]));
  const prior = new Set(packsBefore.map(f => f.dev + ":" + f.ino));
  const added = (await objectFiles(path.join(f.objects.repository, "objects"))).filter(f => !prior.has(f.dev + ":" + f.ino));
  assert.ok(added.reduce((n, f) => n + f.bytes, 0) < 64 * 1024, JSON.stringify(added));
  await gitAt(path.join(f.root, "one/repository"), ["fsck", "--full"]);
  assert.equal(await gitAt(path.join(f.root, "one/repository"), ["rev-parse", "HEAD"]), first.head);
  await gitAt(f.objects.repository, ["gc", "--prune=now"]);
  const third = await compose(f, "three");
  assert.equal(third.tree, second.tree);
  await gitAt(path.join(f.root, "one/repository"), ["fsck", "--full"]);
  await gitAt(path.join(f.root, "two/repository"), ["fsck", "--full"]);
});

test("an interrupted import keeps and completes its SAME original after canonical UNKNOWN recovery", async t => {
  let injected = false, originalId;
  const f = await fixture(t, { afterCheckpoint: async (phase, row) => {
    if (phase === "import-intent" && !injected) { injected = true; originalId = row.operationId; throw Error("lost intake reply"); }
  } });
  await assert.rejects(compose(f, "one"), /lost intake reply/u);
  assert.equal(f.store.recoverInterrupted({ operationIds: [originalId] })[0].status, "reconciling");
  const result = await compose(f, "one");
  assert.equal(result.tree, await gitAt(f.source, ["rev-parse", f.result + "^{tree}"]));
  const journal = JSON.parse(await readFile(path.join(f.root, "one/merge.json"), "utf8"));
  assert.equal(journal.objectStorage.importOperationId, originalId);
  assert.equal(f.store.getReadonly(originalId).status, "succeeded");
});

test("foreign existing consumer, pool replacement and ambient graft refuse without replacing data", async t => {
  const f = await fixture(t);
  const first = await compose(f, "one"); assert.equal(first.tree, await gitAt(f.source, ["rev-parse", f.result + "^{tree}"]));
  const target = path.join(f.root, "foreign"); await mkdir(target); await writeFile(path.join(target, "useful"), "preserve");
  await assert.rejects(f.objects.provision({ sourceRoot: f.source, repository: target, inputs: [f.base, f.result], identityHash: "a".repeat(64) }), /original recovery/u);
  assert.equal(await readFile(path.join(target, "useful"), "utf8"), "preserve");
  const old = process.env.GIT_GRAFT_FILE; process.env.GIT_GRAFT_FILE = path.join(f.root, "external-graft");
  try { await assert.rejects(compose(f, "graft"), /Ambient Git/u); }
  finally { if (old === undefined) delete process.env.GIT_GRAFT_FILE; else process.env.GIT_GRAFT_FILE = old; }
  await rm(f.objects.repository, { recursive: true, force: true }); await mkdir(f.objects.repository);
  await assert.rejects(compose(f, "replaced"), /store replaced/u);
});
