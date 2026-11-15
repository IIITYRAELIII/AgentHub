import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readInterprocessLockStatus, withInterprocessLocks } from "../../../src/infrastructure/process/interprocess-lock.mjs";
import { prepareWindowsLockDirectoryPublisher } from "../../../src/infrastructure/process/windows-lock-directory-publication.mjs";
import { measureTaskOperation, withTaskOperationTiming } from "../../../src/infrastructure/process/task-operation-timing.mjs";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };
const moduleUrl = new URL("../../../src/infrastructure/process/interprocess-lock.mjs", import.meta.url).href;
const childPath = fileURLToPath(new URL("../../fixtures/interprocess-lock-publication-child.mjs", import.meta.url));

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-lock-publication-"));
  // Every child registers a later after-hook and is joined before this cleanup.
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function child(context, mode, target) {
  const process = spawn(globalThis.process.execPath, [childPath, mode, target, moduleUrl], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  process.stderr.on("data", (bytes) => { stderr += bytes; });
  const messages = [];
  process.on("message", (message) => messages.push(message));
  const closed = once(process, "close");
  const stop = async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill();
    await closed;
  };
  // Explicit callers also join in finally: cleanup does not rely on hook order.
  context.after(stop);
  try {
    const checkpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("publication child did not reach its barrier")), 10_000);
      const finish = (action, value) => { clearTimeout(timer); action(value); };
      process.once("message", (message) => message.kind === "checkpoint"
        ? finish(resolve, message) : finish(reject, new Error(JSON.stringify(message))));
      process.once("error", (error) => finish(reject, error));
      process.once("exit", () => finish(reject, new Error(`publication child exited early: ${stderr}`)));
    });
    return { process, closed, checkpoint, messages, stop, stderr: () => stderr };
  } catch (error) {
    await stop();
    throw error;
  }
}

test("Windows complete-directory publication cannot replace an existing destination", windows, async (context) => {
  const root = await fixture(context);
  const publisher = await prepareWindowsLockDirectoryPublisher();
  for (const kind of ["absent", "empty", "occupied", "file", "junction"]) {
    const destination = path.join(root, `${kind}.lock`);
    const source = `${destination}.ready-${randomUUID()}`;
    await fs.mkdir(source);
    const token = `primitive-${kind}`;
    const ownerName = `owner-${createHash("sha256").update(token).digest("hex")}.json`;
    const payload = JSON.stringify({ token, pid: process.pid, processInstanceId: randomUUID(),
      createdAt: Date.now(), leaseExpiresAt: Date.now() + 60_000 });
    const handle = await fs.open(path.join(source, ownerName), "wx");
    try { await handle.writeFile(payload); await handle.sync(); }
    finally { await handle.close(); }
    // The source handle is CLOSED: refusal proves destination exclusivity,
    // rather than Windows refusal to move an open descendant handle.
    if (kind === "file") await fs.writeFile(destination, "foreign-file");
    else if (kind === "junction") {
      const target = path.join(root, "junction-target");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "foreign"), "safe");
      await fs.symlink(target, destination, "junction");
    } else if (kind !== "absent") {
      await fs.mkdir(destination);
      if (kind === "occupied") await fs.writeFile(path.join(destination, "foreign"), "safe");
    }
    try {
      if (kind === "absent") {
        const before = await fs.lstat(source, { bigint: true });
        await publisher.publish(source, destination);
        assert.equal((await fs.lstat(destination, { bigint: true })).ino, before.ino);
        assert.equal(await fs.readFile(path.join(destination, ownerName), "utf8"), payload);
        await assert.rejects(fs.lstat(source), { code: "ENOENT" });
        continue;
      }
      const before = await fs.lstat(destination, { bigint: true });
      await assert.rejects(publisher.publish(source, destination), { code: "EEXIST" });
      const after = await fs.lstat(destination, { bigint: true });
      assert.equal(after.ino, before.ino);
      assert.equal(after.dev, before.dev);
      assert.equal(await fs.readFile(path.join(source, ownerName), "utf8"), payload);
      if (kind === "file") assert.equal(await fs.readFile(destination, "utf8"), "foreign-file");
      if (["occupied", "junction"].includes(kind)) {
        assert.equal(await fs.readFile(path.join(destination, "foreign"), "utf8"), "safe");
      }
    } finally {
      if (kind === "junction") await fs.unlink(destination);
    }
  }
});

test("Windows owner crash exposes either no canonical owner or one complete recoverable owner", windows, async (context) => {
  const root = await fixture(context);
  for (const mode of ["before-write", "after-sync", "after-publish"]) {
    const target = path.join(root, mode);
    const canonical = `${target}.lock`;
    const owned = await child(context, mode, target);
    try {
      if (mode === "after-publish") {
        const names = await fs.readdir(canonical);
        assert.equal(names.length, 1);
        const owner = JSON.parse(await fs.readFile(path.join(canonical, names[0]), "utf8"));
        assert.equal(owner.pid, owned.process.pid);
        assert.equal(typeof owner.processInstanceId, "string");
        assert.ok(owner.processInstanceId);
      } else {
        await assert.rejects(fs.lstat(canonical), { code: "ENOENT" });
        assert.ok(path.dirname(owned.checkpoint.file).startsWith(`${canonical}.ready-`));
        assert.equal(owned.checkpoint.info.size === 0, mode === "before-write");
      }
      assert.equal(owned.process.kill(), true);
      await owned.closed;
      assert.equal(owned.stderr(), "");
      const status = await readInterprocessLockStatus(target);
      assert.equal(status.status, mode === "after-publish" ? "recoverable" : "available");
      let entered = 0;
      await withInterprocessLocks([target], async ({ assertOwned }) => { await assertOwned(); entered += 1; });
      assert.equal(entered, 1);
      assert.equal((await readInterprocessLockStatus(target)).status, "available");
      assert.equal(owned.messages.some((message) => message.kind === "entered"), false);
    } finally { await owned.stop(); }
  }
});

test("Windows competing canonical directories, file and junction are preserved at publication", windows, async (context) => {
  const root = await fixture(context);
  for (const kind of ["empty", "foreign", "file", "junction"]) {
    const target = path.join(root, kind);
    const canonical = `${target}.lock`;
    const owned = await child(context, "before-publish", target);
    try {
      if (kind === "file") await fs.writeFile(canonical, "foreign-file");
      else if (kind === "junction") {
        const target = path.join(root, "junction-target");
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, "foreign"), "untouched");
        await fs.symlink(target, canonical, "junction");
      } else {
        await fs.mkdir(canonical);
        if (kind === "foreign") await fs.writeFile(path.join(canonical, "foreign"), "untouched");
      }
      const before = await fs.lstat(canonical, { bigint: true });
      owned.process.send("publish");
      await owned.closed;
      assert.equal(owned.stderr(), "");
      assert.equal(owned.messages.some((message) => message.kind === "entered"), false);
      assert.equal((await fs.lstat(canonical, { bigint: true })).ino, before.ino);
      if (kind === "file") assert.equal(await fs.readFile(canonical, "utf8"), "foreign-file");
      else {
        assert.deepEqual(await fs.readdir(canonical), kind === "empty" ? [] : ["foreign"]);
        if (kind !== "empty") assert.equal(await fs.readFile(path.join(canonical, "foreign"), "utf8"), "untouched");
      }
    } finally {
      await owned.stop();
      if (kind === "junction" && (await fs.lstat(canonical).catch(() => null))?.isSymbolicLink()) {
        await fs.unlink(canonical);
      }
    }
  }
});

test("Windows publication preserves unknown zero-byte and multiple-owner canonical entries", windows, async (context) => {
  const root = await fixture(context);
  const name = (token) => `owner-${createHash("sha256").update(token).digest("hex")}.json`;
  for (const kind of ["zero", "multiple"]) {
    const target = path.join(root, kind);
    const canonical = `${target}.lock`;
    await fs.mkdir(canonical);
    await fs.writeFile(path.join(canonical, name("one")), kind === "zero" ? ""
      : JSON.stringify({ token: "one", pid: process.pid, processInstanceId: "synthetic-one", createdAt: 0 }));
    if (kind === "multiple") await fs.writeFile(path.join(canonical, name("two")),
      JSON.stringify({ token: "two", pid: process.pid, processInstanceId: "synthetic-two", createdAt: 0 }));
    const bytes = () => fs.readdir(canonical).then((names) => Promise.all(names.sort().map(async (file) =>
      [file, (await fs.readFile(path.join(canonical, file))).toString("hex")])));
    const before = await bytes();
    let entered = false;
    await assert.rejects(withInterprocessLocks([target], async () => { entered = true; }, {
      timeoutMs: 30, retryDelayMs: 2,
    }), { code: "INTERPROCESS_LOCK_ADMISSION_TIMEOUT" });
    assert.equal(entered, false);
    assert.equal((await readInterprocessLockStatus(target)).status, "unknown");
    assert.deepEqual(await bytes(), before);
  }
});

test("Windows exact-payload file and directory ABA are independently refused before protected work", windows, async (context) => {
  const root = await fixture(context);
  for (const kind of ["file", "directory"]) {
  const target = path.join(root, kind);
  const canonical = `${target}.lock`;
  const owned = await child(context, "after-publish-swap", target);
  try {
    const [name] = await fs.readdir(canonical);
    const bytes = await fs.readFile(path.join(canonical, name));
    const before = await fs.lstat(canonical, { bigint: true });
    const originalFile = await fs.lstat(path.join(canonical, name), { bigint: true });
    if (kind === "directory") {
      await fs.rename(canonical, `${canonical}.displaced`);
      await fs.mkdir(canonical);
      // Retain the exact file object, so only the directory identity differs.
      await fs.link(path.join(`${canonical}.displaced`, name), path.join(canonical, name));
      assert.equal((await fs.lstat(path.join(canonical, name), { bigint: true })).ino, originalFile.ino);
    } else {
      await fs.rename(path.join(canonical, name), path.join(root, "displaced-owner"));
      await fs.writeFile(path.join(canonical, name), bytes);
      assert.notEqual((await fs.lstat(path.join(canonical, name), { bigint: true })).ino, originalFile.ino);
    }
    const replacement = await fs.lstat(canonical, { bigint: true });
    assert.equal(replacement.ino === before.ino, kind === "file");
    owned.process.send("resume");
    await owned.closed;
    assert.equal(owned.stderr(), "");
    assert.equal(owned.messages.some((message) => message.kind === "entered"), false);
    assert.ok(owned.messages.some((message) => message.kind === "refused"
      && message.message === "Interprocess lock publication identity changed before ownership"));
    assert.deepEqual(await fs.readFile(path.join(canonical, name)), bytes);
    assert.equal((await fs.lstat(canonical, { bigint: true })).ino, replacement.ino);
  } finally { await owned.stop(); }
  }
});

test("Windows native publication lost reply is resolved once by exact owned-object readback", windows, async (context) => {
  const root = await fixture(context);
  const target = path.join(root, "lost-reply");
  const owned = await child(context, "lose-reply", target);
  try {
    assert.equal(owned.checkpoint.lostReply, true);
    await owned.closed;
    assert.equal(owned.stderr(), "");
    assert.equal(owned.process.exitCode, 0);
    assert.equal(owned.messages.filter((message) => message.kind === "entered").length, 1);
    assert.equal(owned.messages.find((message) => message.kind === "entered").nativeInvocations, 1);
    assert.equal(owned.messages.some((message) => message.kind === "refused"), false);
    assert.equal((await readInterprocessLockStatus(target)).status, "available");
  } finally { await owned.stop(); }
});

test("Windows replaced ready directory refuses before native mutation and preserves foreign staging bytes", windows, async (context) => {
  const root = await fixture(context);
  const target = path.join(root, "staging-aba");
  const owned = await child(context, "before-publish", target);
  try {
    const ready = owned.checkpoint.from;
    const [ownerName] = await fs.readdir(ready);
    const ownerBytes = await fs.readFile(path.join(ready, ownerName));
    await fs.rename(ready, `${ready}.displaced`);
    await fs.mkdir(ready);
    await fs.writeFile(path.join(ready, ownerName), ownerBytes);
    await fs.writeFile(path.join(ready, "foreign"), "untouched");
    const before = await fs.lstat(ready, { bigint: true });
    owned.process.send("publish");
    await owned.closed;
    assert.equal(owned.stderr(), "");
    assert.equal(owned.messages.some((message) => message.kind === "entered"), false);
    assert.ok(owned.messages.some((message) => message.kind === "refused"
      && message.message === "Interprocess lock staging identity changed before publication"
      && message.nativeInvocations === 0));
    assert.equal((await fs.lstat(ready, { bigint: true })).ino, before.ino);
    assert.deepEqual((await fs.readdir(ready)).sort(), ["foreign", ownerName].sort());
    assert.deepEqual(await fs.readFile(path.join(ready, ownerName)), ownerBytes);
    assert.equal(await fs.readFile(path.join(ready, "foreign"), "utf8"), "untouched");
    await assert.rejects(fs.lstat(`${target}.lock`), { code: "ENOENT" });
  } finally { await owned.stop(); }
});

test("Windows bootstrap and publication remain separate measured phases after detailed retention", windows, async (context) => {
  const root = await fixture(context);
  const events = [];
  let admission;
  await withTaskOperationTiming({ operationId: "native-lock-phases", record: (event) => events.push(event) }, async () => {
    for (let index = 0; index < 512; index += 1) {
      await measureTaskOperation("git-child", () => null, { detail: true, command: "rev-parse" });
    }
    await withInterprocessLocks([path.join(root, "measured")], async ({ assertOwned }) => assertOwned(), {
      onAcquired: (value) => { admission = value; },
    });
  });
  const summary = events.find((event) => event.stage === "trace-summary");
  const bootstrap = summary.stageAggregates.find((row) => row.stage === "lock-native-bootstrap");
  const publication = summary.stageAggregates.find((row) => row.stage === "lock-native-publish");
  for (const phase of [bootstrap, publication]) {
    assert.equal(phase.count, 1);
    assert.equal(phase.errorCount, 0);
    assert.equal(phase.suppressedCount, 1);
    assert.ok(phase.inclusiveMs >= 0);
  }
  assert.ok(admission.waitMs >= publication.inclusiveMs);
  assert.equal(JSON.stringify(summary).includes(root), false);
  context.diagnostic(JSON.stringify({ bootstrapMs: bootstrap.inclusiveMs,
    nativePublicationMs: publication.inclusiveMs, admissionMs: admission.waitMs }));
});
