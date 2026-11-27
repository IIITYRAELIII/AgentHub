import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OwnedNativeObjectStore, nativeObjectStorageDescriptor, ownedPackIndexContains } from "../../../src/infrastructure/filesystem/owned-native-object-store.mjs";
import { mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { inventoryNativeCapture } from "../../../src/infrastructure/filesystem/native-capture-inventory.mjs";
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
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "hub-objects-")));
  t.after(async () => {
    assert.equal(await realpath(root), root);
    assert.ok(path.basename(root).startsWith("hub-objects-"));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
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

test("v2 pack membership agrees with Git for ordinary and extended indexes", async t => {
  const f = await fixture(t);
  await gitAt(f.source, ["gc", "--quiet"]);
  const packs = path.join(f.source, ".git/objects/pack");
  const file = (await readdir(packs)).find(name => name.endsWith(".idx"));
  assert.ok(file);
  const checksum = file.slice(5, -4);
  const original = await readFile(path.join(packs, file));
  const pack = path.join(packs, file.slice(0, -4) + ".pack");
  const extendedPath = path.join(f.root, "extended.idx");
  await gitAt(f.source, ["index-pack", "--index-version=2,1", "-o", extendedPath, pack]);
  const extended = await readFile(extendedPath);
  assert.ok(extended.length > original.length);
  for (const bytes of [original, extended]) {
    const ids = (await gitAt(f.source, ["show-index"], { input: bytes }))
      .split(/\r?\n/u).map(line => line.split(" ")[1]);
    assert.ok(ids.length > 1);
    for (const id of ids) assert.equal(ownedPackIndexContains(bytes, checksum, new Set([id])), true);
    assert.equal(ownedPackIndexContains(bytes, checksum, new Set(["0".repeat(40)])), false);
  }
  const damaged = Buffer.from(original);
  damaged.writeUInt32BE(0xffffffff, 8);
  createHash("sha1").update(damaged.subarray(0, -20)).digest().copy(damaged, damaged.length - 20);
  assert.throws(() => ownedPackIndexContains(damaged, checksum, new Set([f.result])), /malformed/u);
  assert.throws(() => ownedPackIndexContains(original, "0".repeat(40), new Set([f.result])), /malformed/u);
  const legacyPath = path.join(f.root, "legacy.idx");
  await gitAt(f.source, ["index-pack", "--index-version=1", "-o", legacyPath, pack]);
  const legacy = await readFile(legacyPath);
  assert.equal(ownedPackIndexContains(legacy, checksum, new Set([f.result])), null);
  assert.match(await gitAt(f.source, ["show-index"], { input: legacy }), new RegExp(f.result, "u"));
});

test("a fresh consumer stops before its native pack when ownership changes", async t => {
  const ownerLost = new Error("fixture owner changed after consumer configuration");
  let ready = false, startedPacks = 0;
  let consumer;
  const f = await fixture(t, {
    assertCurrent: async () => { if (ready) throw ownerLost; },
    async gitAt(cwd, args, options) {
      if (args.includes("pack-objects") && args.some(arg => arg === path.join(consumer, ".git", "objects", "pack", "pack"))) {
        startedPacks += 1;
      }
      const result = await gitAt(cwd, args, options);
      if (cwd === consumer && args.includes("config") && args.includes("gc.auto")) ready = true;
      return result;
    },
  });
  consumer = path.join(f.root, "one", "repository");
  await assert.rejects(compose(f, "one"), error => error === ownerLost);
  assert.equal(ready, true);
  assert.equal(startedPacks, 0);
  assert.deepEqual(await readdir(path.join(consumer, ".git", "objects", "pack")), []);
});

test("two native consumers own one exact pack each and retain independent metadata and history", async t => {
  let showIndexCalls = 0;
  const f = await fixture(t, { gitAt(cwd, args, options) {
    if (args.includes("show-index")) showIndexCalls += 1;
    return gitAt(cwd, args, options);
  } });
  const primaryHead = await gitAt(f.source, ["rev-parse", "HEAD"]), refs = await gitAt(f.source, ["show-ref"]);
  const first = await compose(f, "one"), second = await compose(f, "two");
  assert.equal(showIndexCalls, 0);
  assert.equal(first.tree, await gitAt(f.source, ["rev-parse", f.result + "^{tree}"]));
  assert.equal(second.tree, first.tree);
  const firstRepo = path.join(f.root, "one/repository"), secondRepo = path.join(f.root, "two/repository");
  const a = (await objectFiles(path.join(firstRepo, ".git/objects"))).filter(x => x.name.startsWith("pack/"));
  const b = (await objectFiles(path.join(secondRepo, ".git/objects"))).filter(x => x.name.startsWith("pack/"));
  assert.equal(await gitAt(firstRepo, ["show", "-s", "--format=%P", first.head]), f.base + " " + f.result);
  assert.equal(await gitAt(secondRepo, ["show", "-s", "--format=%P", second.head]), f.base + " " + f.result);
  for (const files of [a, b]) {
    assert.equal(files.filter(file => file.name.endsWith(".pack")).length, 1);
    assert.equal(files.filter(file => file.name.endsWith(".idx")).length, 1);
  }
  assert.ok(a.every(x => x.nlink === 1) && b.every(x => x.nlink === 1));
  const firstIndex = new Set(a.map(x => x.dev + ":" + x.ino));
  assert.ok(b.every(x => !firstIndex.has(x.dev + ":" + x.ino)));
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

test("a release consumer copies the exact owned prefix and packs only newly selected objects", async t => {
  const packSizes = [];
  const f = await fixture(t, {
    async gitAt(cwd, args, options) {
      if (args.includes("pack-objects") && !args.includes("--stdout")) {
        packSizes.push(options.input.trim().split("\n").length);
      }
      return gitAt(cwd, args, options);
    },
  });
  const inputs = [f.base, f.result];
  const donor = path.join(f.root, "donor");
  const identityHash = "a".repeat(64);
  const storage = await f.objects.provision({ sourceRoot: f.source, repository: donor, inputs, identityHash });
  const cold = path.join(f.root, "cold");
  await f.objects.provision({ sourceRoot: f.source, repository: cold, inputs, identityHash: "d".repeat(64),
    reuseCompleteImport: true });
  assert.equal(packSizes.length, 1, "the completed exact intake already holds the full cold pack");
  const reusableSource = { inputs, identityHash, storage };
  const exact = path.join(f.root, "exact");
  await f.objects.provision({ sourceRoot: donor, repository: exact, inputs, identityHash: "b".repeat(64), reusableSource });
  assert.equal(packSizes.length, 1, "an exact prefix requires no pack encoding");
  await writeFile(path.join(f.source, "later.txt"), "later selection\n");
  await gitAt(f.source, ["add", "."]);
  await gitAt(f.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "later"]);
  const later = await gitAt(f.source, ["rev-parse", "HEAD"]);
  await gitAt(donor, ["-c", "fetch.unpackLimit=1", "fetch", f.source, later]);
  const incremental = path.join(f.root, "incremental");
  const selected = [...inputs, later];
  await f.objects.provision({ sourceRoot: donor, repository: incremental, inputs: selected,
    identityHash: "c".repeat(64), reusableSource });
  assert.deepEqual(packSizes.slice(1), [3], "only the new commit, tree and blob enter the delta pack");
  const packs = root => objectFiles(path.join(root, ".git", "objects"));
  const [donorFiles, incrementalFiles] = await Promise.all([packs(donor), packs(incremental)]);
  const shared = donorFiles.filter(file => /\.(?:idx|pack)$/u.test(file.name));
  assert.ok(shared.length >= 2);
  const copied = shared.filter(file => incrementalFiles.some(copy => copy.name === file.name));
  assert.equal(copied.length, 2, "only the admitted pack and index were copied");
  for (const file of copied) {
    const copy = incrementalFiles.find(item => item.name === file.name);
    assert.equal(copy.bytes, file.bytes);
    assert.notEqual(copy.ino, file.ino);
  }
  await gitAt(incremental, ["fsck", "--full", ...selected]);
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

async function archiveSource(f) {
  return { sourceRoot: f.source, binding: { fixture: "archive intake lifetime" },
    inventory: await inventoryNativeCapture(f.source), assertCurrent: async () => {} };
}
const intakeAliases = async objects => (await readdir(objects.root)).filter(n => /^import-[a-f0-9]{64}\.(?:pack|idx)$/u.test(n)).sort();

test("archive retires intake aliases before leased GC without losing originals or live consumer links", async t => {
  const f = await fixture(t), input = await archiveSource(f);
  const archived = await f.objects.archive(input);
  assert.deepEqual(await intakeAliases(f.objects), []);
  const consumer = path.join(f.root, "live-consumer");
  await f.objects.provision({ sourceRoot: f.source, repository: consumer, inputs: [f.base, f.result], identityHash: "b".repeat(64) });
  const beforeLinks = await objectFiles(path.join(consumer, ".git/objects"));
  const before = process.platform === "win32" ? await measureNativeCaptureAllocation([f.objects.root]) : null;
  await f.objects.withArchiveLease(archived.archive, async () => gitAt(f.objects.repository, ["gc", "--prune=now"]));
  const verified = await f.objects.readArchive(archived.archive);
  assert.deepEqual(verified.manifest, archived.manifest);
  for (const object of archived.manifest.objects) await gitAt(f.objects.repository, ["cat-file", "-e", object.oid]);
  for (const file of archived.manifest.files) assert.equal(await gitAt(f.objects.repository, ["cat-file", "-t", file.blob]), "blob");
  const afterLinks = await objectFiles(path.join(consumer, ".git/objects"));
  assert.deepEqual(afterLinks.map(({nlink, ...x}) => x), beforeLinks.map(({nlink, ...x}) => x));
  await gitAt(consumer, ["fsck", "--full", "--no-dangling", f.result]);
  if (before) {
    const after = await measureNativeCaptureAllocation([f.objects.root]);
    assert.ok(after.uniqueAllocatedBytes <= before.uniqueAllocatedBytes + 128 * 1024, JSON.stringify({ before, after }));
    t.diagnostic("Archive intake FileStandardInfo allocation " + JSON.stringify({ before, after }));
  }
});

test("lost durable archive reply retires aliases on SAME successful original reentry", async t => {
  let once = true, original;
  const f = await fixture(t, { afterCheckpoint: async (phase, row) => {
    if (phase === "archived" && once) { once = false; original = row; throw Error("lost archived reply"); }
  } });
  const input = await archiveSource(f);
  await assert.rejects(f.objects.archive(input), /lost archived reply/u);
  assert.equal(f.store.getReadonly(original.operationId).status, "succeeded");
  assert.equal((await intakeAliases(f.objects)).length, 2);
  const archived = await f.objects.archive(input);
  assert.equal(archived.archive.operationId, original.operationId);
  assert.equal(f.store.getReadonly(original.operationId).revision, original.revision);
  assert.deepEqual(await intakeAliases(f.objects), []);
  await f.objects.withArchiveLease(archived.archive, async () => gitAt(f.objects.repository, ["gc", "--prune=now"]));
  await f.objects.readArchive(archived.archive);
});

test("lost durable import reply retires aliases on SAME successful import reentry", async t => {
  let once = true, original;
  const f = await fixture(t, { afterCheckpoint: async (phase, row) => {
    if (phase === "imported" && once) { once = false; original = row; throw Error("lost imported reply"); }
  } });
  await assert.rejects(compose(f, "one"), /lost imported reply/u);
  assert.equal((await intakeAliases(f.objects)).length, 2);
  await compose(f, "one");
  assert.equal(f.store.getReadonly(original.operationId).revision, original.revision);
  assert.deepEqual(await intakeAliases(f.objects), []);
});

test("foreign intake alias refuses before unlinking either original alias", async t => {
  let once = true;
  const f = await fixture(t, { afterCheckpoint: async phase => {
    if (phase === "archived" && once) { once = false; throw Error("lost archived reply"); }
  } });
  const input = await archiveSource(f);
  await assert.rejects(f.objects.archive(input), /lost archived reply/u);
  const aliases = await intakeAliases(f.objects), idx = path.join(f.objects.root, aliases.find(n => n.endsWith(".idx")));
  await rename(idx, idx + ".fixture-original"); await writeFile(idx, "foreign useful data");
  await assert.rejects(f.objects.archive(input), /alias|custody/u);
  assert.equal(await readFile(idx, "utf8"), "foreign useful data");
  assert.equal((await intakeAliases(f.objects)).length, 2);
  const row = f.store.getReadonly(f.objects.archiveIntent(input).operationId);
  await f.objects.readArchive(row.metadata.archive);
});

test("lost alias unlink reply completes only the remaining index on SAME archived original", async t => {
  let objects, once = true;
  const f = await fixture(t, { assertCurrent: async () => {
    if (!objects || !once) return;
    let names;
    try { names = await intakeAliases(objects); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    if (names.length === 1 && names[0].endsWith(".idx")) { once = false; throw Error("lost alias unlink reply"); }
  } });
  objects = f.objects;
  const input = await archiveSource(f), id = objects.archiveIntent(input).operationId;
  await assert.rejects(objects.archive(input), /lost alias unlink reply/u);
  const row = f.store.getReadonly(id);
  assert.equal(row.status, "succeeded");
  assert.equal((await intakeAliases(objects)).length, 1);
  await objects.withArchiveLease(row.metadata.archive, async stored => {
    assert.equal(stored.archive.operationId, id);
    assert.deepEqual(await intakeAliases(objects), []);
    await gitAt(objects.repository, ["gc", "--prune=now"]);
  });
  assert.equal(f.store.getReadonly(id).revision, row.revision);
  await objects.readArchive(row.metadata.archive);
});


test("native missing-object encoding shares delta history and preserves archive plus live consumers", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), history = await readFile(path.join(f.source, "history.bin"));
  for (let n = 0; n < 9; n++) {
    history[n] ^= 1;
    await writeFile(path.join(f.source, "history.bin"), history);
    await gitAt(f.source, ["add", "history.bin"]);
    await gitAt(f.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "bounded history delta " + n]);
  }
  f.result = await gitAt(f.source, ["rev-parse", "HEAD"]);
  await gitAt(f.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "tag", "-a", "original-encoding-tag", "-m", "preserve exact original tag", f.result]);
  const sourceRefs = await gitAt(f.source, ["show-ref"]), sourceIndex = await readFile(path.join(f.source, ".git/index"));
  const first = await compose(f, "encoding-one"), second = await compose(f, "encoding-two");
  assert.equal(first.tree, second.tree);
  const one = path.join(f.root, "encoding-one/repository"), two = path.join(f.root, "encoding-two/repository");
  const a = (await objectFiles(path.join(one, ".git/objects"))).filter(x => x.name.startsWith("pack/"));
  const b = (await objectFiles(path.join(two, ".git/objects"))).filter(x => x.name.startsWith("pack/"));
  for (const files of [a, b]) {
    assert.equal(files.filter(file => file.name.endsWith(".pack")).length, 1);
    assert.equal(files.filter(file => file.name.endsWith(".idx")).length, 1);
  }
  const firstPacks = new Set(a.map(x => x.dev + ":" + x.ino));
  assert.ok(b.every(x => !firstPacks.has(x.dev + ":" + x.ino)));
  assert.notEqual((await lstat(path.join(one, ".git/index"))).ino, (await lstat(path.join(two, ".git/index"))).ino);
  const measured = await measureNativeCaptureAllocation([f.objects.root]);
  t.diagnostic("Exact ten-revision pool encoding allocation " + JSON.stringify(measured));
  // The existing incremental pool still retains one delta encoding.
  assert.ok(measured.uniqueAllocatedBytes < history.length * 3, JSON.stringify(measured));
  const originalObjects = await gitAt(f.source, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]);
  const tag = await gitAt(f.source, ["rev-parse", "refs/tags/original-encoding-tag"]);
  const archived = await f.objects.archive(await archiveSource(f));
  assert.deepEqual(archived.manifest.objects, originalObjects.split(/\r?\n/u).filter(Boolean)
    .map(x => { const [oid, type] = x.split(" "); return { oid, type }; }).sort((a, b) => a.oid.localeCompare(b.oid)));
  assert.deepEqual(await intakeAliases(f.objects), []);
  await f.objects.withArchiveLease(archived.archive, () => gitAt(f.objects.repository, ["gc", "--prune=now"])); // Disposable fixture only.
  assert.deepEqual((await f.objects.readArchive(archived.archive)).manifest, archived.manifest);
  await gitAt(f.objects.repository, ["cat-file", "-e", tag]);
  await gitAt(one, ["fsck", "--full", "--no-dangling", f.result]);
  await gitAt(two, ["fsck", "--full", "--no-dangling", f.result]);
  assert.deepEqual(await readFile(path.join(one, "history.bin")), history);
  assert.deepEqual(await readFile(path.join(two, "history.bin")), history);
  assert.equal(await gitAt(f.source, ["show-ref"]), sourceRefs);
  assert.deepEqual(await readFile(path.join(f.source, ".git/index")), sourceIndex);
  const before = await objectFiles(path.join(f.objects.repository, "objects"));
  await writeFile(path.join(f.source, "later-encoding.txt"), "one later tiny selection\n"); await gitAt(f.source, ["add", "."]);
  await gitAt(f.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "later tiny selection"]);
  f.result = await gitAt(f.source, ["rev-parse", "HEAD"]);
  await compose(f, "encoding-three");
  const ids = new Set(before.map(x => x.dev + ":" + x.ino));
  const added = (await objectFiles(path.join(f.objects.repository, "objects"))).filter(x => !ids.has(x.dev + ":" + x.ino));
  assert.ok(added.reduce((n, x) => n + x.bytes, 0) < 128 * 1024, JSON.stringify(added));
  await gitAt(one, ["fsck", "--full", "--no-dangling"]);
  await gitAt(two, ["fsck", "--full", "--no-dangling"]);
});
