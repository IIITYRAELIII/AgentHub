import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import * as backupOwner from "../../../src/infrastructure/persistence/runtime-maintenance-backup.mjs";
import { withInterprocessLocks } from "../../../src/infrastructure/process/interprocess-lock.mjs";
import { prepareWindowsLockDirectoryPublisher } from "../../../src/infrastructure/process/windows-lock-directory-publication.mjs";
import { RuntimeRestartController } from "../../../src/runtime/runtime-restart-controller.mjs";

const deferred = () => Promise.withResolvers();
// The unchanged parent executes its actual live-inspection entry point.
const preflight = backupOwner.preflightRuntimeBackupScope ?? backupOwner.inspectRuntimeBackupScope;

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "hb398-"));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, "runtime"), data = path.join(root, "data");
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(root, "config.json"), '{"fixture":true}');
  const target = path.join(data, "journal.sqlite");
  const db = new DatabaseSync(target);
  try { db.exec("CREATE TABLE receipt(outcome); INSERT INTO receipt VALUES('unknown')"); }
  finally { db.close(); }
  return { base, root, data, target };
}

function interceptRead(t, directory, action) {
  const original = fs.readdir;
  let used = false;
  t.mock.method(fs, "readdir", async (...args) => {
    const names = await original(...args);
    if (!used && args[0] === directory) {
      used = true;
      await action(names);
    }
    return names;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => assert.equal(used, true, "actual enumeration boundary exercised");
}

async function churn(t, f, stage, replacement = false) {
  const published = deferred(), allowPublish = deferred(), acquired = deferred(), allowRelease = deferred();
  const publisher = await prepareWindowsLockDirectoryPublisher();
  const original = publisher.publish.bind(publisher);
  const publish = t.mock.method(publisher, "publish", async (ready, canonical) => {
    if (canonical === `${f.target}.lock`) {
      published.resolve(ready);
      await allowPublish.promise;
    }
    return original(ready, canonical); // Actual fixed native no-replace owner.
  });
  const work = withInterprocessLocks([f.target], async () => {
    acquired.resolve();
    await allowRelease.promise;
  });
  // Capture failures without an unhandled rejection while the inspection joins.
  const joined = work.then(() => null, error => error);
  const ready = await Promise.race([published.promise, joined.then(error => { throw error; })]);
  if (stage === "canonical") { allowPublish.resolve(); await acquired.promise; }
  const selected = stage === "canonical" ? `${f.target}.lock` : ready;
  const used = interceptRead(t, f.data, async names => {
    assert.ok(names.includes(path.basename(selected)));
    allowPublish.resolve();
    await acquired.promise;
    allowRelease.resolve();
    assert.equal(await joined, null);
    if (replacement) await fs.mkdir(selected);
    else await assert.rejects(fs.lstat(selected), { code: "ENOENT" });
  });
  return { selected, used, async close() {
    allowPublish.resolve(); allowRelease.resolve();
    const error = await joined;
    publish.mock.restore();
    if (error) throw error;
  } };
}

for (const stage of ["ready", "canonical"]) test(`live package preflight survives exact native ${stage} directory retirement after enumeration`,
  { skip: process.platform !== "win32" }, async t => {
    const f = await fixture(t), control = await churn(t, f, stage);
    try {
      let stopped = 0, aborted = 0, inventory;
      const noop = async () => {};
      const controller = new RuntimeRestartController({
        getRequest: () => ({ operationId: "original", metadata: { packageHandoff: {} } }),
        updateOffset: () => 1, hasBlockingWork: () => false, setWaiting: noop,
        updateMessage: noop, saveState: noop, resources: { recover: noop },
        beginStopping: () => { stopped++; return false; }, stopTimers: noop, stopMedia: noop,
        launchReplacement: noop, recoverPrevious: noop,
        abortRestart: () => { aborted++; }, finishSuccessfulReplacement: noop,
        packageHandoff: { preflight: async () => { inventory = await preflight({ runtimeRoot: f.root }); } },
        logger: { log() {}, error() {} },
      });
      const result = await controller.perform();
      assert.equal(result.status, "ignored", result.error?.stack);
      assert.equal(stopped, 1); assert.equal(aborted, 0); control.used();
      assert.ok(inventory.files.some(entry => entry.sqlite && entry.source === f.target));
      assert.ok(!inventory.retained.some(entry => entry.path.endsWith(path.basename(control.selected))));
      const strict = await backupOwner.inspectRuntimeBackupScope({ runtimeRoot: f.root });
      await backupOwner.assertRuntimeBackupScope(strict);
      assert.equal(await fs.readFile(path.join(f.root, "config.json"), "utf8"), '{"fixture":true}');
      const db = new DatabaseSync(f.target, { readOnly: true });
      try { assert.equal(db.prepare("SELECT outcome FROM receipt").get().outcome, "unknown"); }
      finally { db.close(); }
    } finally { await control.close(); }
  });

test("live preflight refuses replacement of an actually observed ready directory", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), control = await churn(t, f, "ready", true);
  try { await assert.rejects(preflight({ runtimeRoot: f.root }), /identity changed/u); control.used(); }
  finally { await control.close(); }
});

for (const name of ["receipt.json", "journal.sqlite.lock.ready-3aedb5da-6ed2-4e77-9420-07179cb20411"]) {
  test(`live preflight never infers ownership of disappearing ${name}`, async t => {
    const f = await fixture(t), selected = path.join(f.data, name);
    if (name.endsWith("json")) await fs.writeFile(selected, "durable");
    else await fs.mkdir(selected);
    const used = interceptRead(t, f.data, async names => {
      assert.ok(names.includes(name));
      await fs.rm(selected, { recursive: true });
    });
    await assert.rejects(preflight({ runtimeRoot: f.root }), { code: "ENOENT" }); used();
  });
}

test("strict stopped inventory still binds a live canonical lock and refuses its later disappearance", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const work = withInterprocessLocks([f.target], async () => { entered.resolve(); await release.promise; });
  try {
    await entered.promise;
    const inventory = await backupOwner.inspectRuntimeBackupScope({ runtimeRoot: f.root });
    assert.ok(inventory.retained.some(entry => entry.path === path.join("data", "journal.sqlite.lock")));
    release.resolve(); await work;
    await assert.rejects(backupOwner.assertRuntimeBackupScope(inventory), { code: "ENOENT" });
  } finally { release.resolve(); await work; }
});
