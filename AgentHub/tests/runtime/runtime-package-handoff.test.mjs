import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { RuntimeRestartController } from "../../src/runtime/runtime-restart-controller.mjs";
import { RuntimeResourceRegistry } from "../../src/runtime/runtime-resource-registry.mjs";
import { RestartRequestService } from "../../src/application/restart-request-service.mjs";
import { backupStoppedRuntime } from "../../src/infrastructure/persistence/runtime-maintenance-backup.mjs";
import { packageBindingDigest, packageDigest, packageFile, verifyPublicPackageTarget } from "../../src/infrastructure/filesystem/runtime-package-target.mjs";
import { armPackageRestart, continuePackageRestart, packageCheckpoint, packageHandoffBinding,
  packageHostMain } from "../../src/runtime/runtime-package-handoff.mjs";

const noop = async () => {};
const quiet = { log() {}, error() {}, warn() {} };
async function fixture(t, phase = "package-writers-closed") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub376-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(directory, "runtime"), dataDir = path.join(root, "data");
  const scratchRoot = path.join(directory, "scratch");
  await mkdir(path.join(root, "releases", "old"), { recursive: true });
  await mkdir(dataDir); await mkdir(scratchRoot);
  await writeFile(path.join(root, "config.json"), '{"auth":"fixture-private","cursor":17}');
  const pointer = '{"current":"old","previous":"older"}';
  const manifest = '{"releaseId":"old"}';
  await writeFile(path.join(root, "current.json"), pointer);
  await writeFile(path.join(root, "releases", "old", "runtime-manifest.json"), manifest);
  const target = { releaseId: "new", sourceCommit: "a".repeat(40), version: "2.0.5+build.18" };
  for (const key of ["archive", "installer", "descriptor"]) {
    const file = path.join(directory, key);
    await writeFile(file, `fixture-${key}`);
    target[key] = await packageFile(file);
  }
  const hostCopy = path.join(scratchRoot, "AgentHub.RuntimeHost.exe");
  await writeFile(hostCopy, "fixture-host");
  const binding = { operationId: "original-package", runtimeRoot: root, dataDir, scratchRoot, hostCopy,
    old: { releaseId: "old", currentSha256: packageDigest(pointer), manifestSha256: packageDigest(manifest),
      pid: process.pid, hostPid: 123, instanceSha256: packageDigest("old-instance"),
      launcher: await packageFile(hostCopy) }, target };
  const envelope = { schema: 1, binding, sha256: packageBindingDigest(binding) };
  const store = new MaintenanceOperationStore({ dataDir });
  store.create({ operationId: binding.operationId, kind: "restart", streamId: "agent-hub-runtime",
    threadId: "agent-hub-runtime", status: "running", phase, metadata: { packageHandoff: envelope } });
  return { root, dataDir, scratchRoot, store, binding, envelope };
}

test("package continuation backs up original UNKNOWN receipts before its exact install and launch ports", async (t) => {
  const f = await fixture(t), events = [];
  const originalConfig = await readFile(path.join(f.root, "config.json"));
  const db = new DatabaseSync(path.join(f.dataDir, "journal.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE receipt(id TEXT PRIMARY KEY, outcome TEXT); INSERT INTO receipt VALUES('unknown-original','unknown');");
  db.close();
  const result = await continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
    assertRetired: async () => { events.push("retired"); },
    backup: async (args) => { events.push("backup"); return backupStoppedRuntime(args); },
    install: async (actual) => {
      assert.deepEqual(actual, f.store.getReadonly(f.binding.operationId).metadata.packageHandoff.binding);
      const saved = new DatabaseSync(path.join(f.scratchRoot, "backup", "data", "journal.sqlite"), { readOnly: true });
      try { assert.equal(saved.prepare("SELECT outcome FROM receipt WHERE id='unknown-original'").get().outcome, "unknown"); }
      finally { saved.close(); }
      events.push("install");
    },
    verifyInstalled: async () => events.push("installed"),
    launch: async () => { events.push("launch"); return { pid: 900 }; },
    ready: async () => {
      events.push("ready"); f.store.settle(f.binding.operationId, { succeeded: true, phase: "completed" });
      return { pid: 901 };
    },
  });
  assert.equal(result.status, "replaced");
  assert.deepEqual(events.filter((event) => event !== "retired"), ["backup", "install", "installed", "launch", "ready"]);
  assert.equal(f.store.getReadonly(f.binding.operationId).outcome, "succeeded");
  assert.deepEqual(await readFile(path.join(f.root, "config.json")), originalConfig);
});

test("whole admitted binding and original durable completion join exact ready result", async (t) => {
  const f = await fixture(t), events = [];
  const result = await continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
    assertRetired: async () => { events.push("retired"); },
    backup: async ({ destination }) => { events.push("backup"); return { directory: destination, files: [] }; },
    install: async (binding) => {
      assert.deepEqual(binding, f.binding);
      assert.equal(f.store.getReadonly(binding.operationId).phase, "package-installing");
      events.push("install");
    },
    verifyInstalled: async () => { events.push("verify-installed"); },
    launch: async () => { assert.equal(f.store.getReadonly(f.binding.operationId).phase, "package-launching"); events.push("launch"); return { pid: 900 }; },
    ready: async () => { events.push("ready"); f.store.settle(f.binding.operationId, { succeeded: true, phase: "completed" }); return { pid: 901, instanceSha256: "b".repeat(64) }; },
  });
  assert.equal(result.status, "replaced"); assert.equal(result.operationId, f.binding.operationId);
  assert.deepEqual(events.filter((e) => e !== "retired"), ["backup", "install", "verify-installed", "launch", "ready"]);
  assert.equal(events.filter((e) => e === "launch").length, 1);
  const again = await continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
    assertRetired: () => assert.fail("no terminal replay"), install: () => assert.fail("no install replay") });
  assert.equal(again.status, "reconciliation-required");
  const readback = await packageHostMain(["read", f.root, f.binding.operationId]);
  assert.equal(readback.status, "succeeded"); assert.equal(readback.effectsReplayed, false);
});

for (const fault of ["foreign-writer", "tampered-asset", "old-pointer-drift", "install-lost-reply", "start-lost-reply", "foreign-ready"]) {
  test(`package ${fault} refuses and a retry cannot repeat an ambiguous effect`, async (t) => {
    const f = await fixture(t); let installs = 0, launches = 0;
    if (fault === "tampered-asset") await writeFile(f.binding.target.archive.file, "tampered");
    if (fault === "old-pointer-drift") await writeFile(path.join(f.root, "current.json"), '{"current":"foreign"}');
    await assert.rejects(continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
      assertRetired: async () => { if (fault === "foreign-writer") throw new Error("foreign writer remains"); },
      backup: async () => ({ files: [] }), verifyInstalled: noop,
      install: async () => { installs++; if (fault === "install-lost-reply") throw new Error("lost install reply"); },
      launch: async () => { launches++; if (fault === "start-lost-reply") throw new Error("lost start reply"); return { pid: 1 }; },
      ready: async () => { throw new Error("foreign ready operation/release"); },
    }));
    const original = f.store.getReadonly(f.binding.operationId);
    assert.equal(original.status, "reconciling"); assert.equal(original.outcome, "unknown");
    assert.equal(installs, ["install-lost-reply", "start-lost-reply", "foreign-ready"].includes(fault) ? 1 : 0);
    const counts = [installs, launches];
    const result = await continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
      assertRetired: () => assert.fail("unknown cannot gain retirement authority"), install: () => installs++, launch: () => launches++ });
    assert.equal(result.status, "reconciliation-required"); assert.deepEqual([installs, launches], counts);
    assert.equal((await readFile(path.join(f.root, "config.json"), "utf8")), '{"auth":"fixture-private","cursor":17}');
  });
}

test("package restart waits for actual work, closes preserved resources and finalizes writers before release", async () => {
  const events = []; let blocked = true, stopping = false, writerClosed = false;
  const request = { operationId: "original", metadata: { packageHandoff: { schema: 1 } } };
  const resources = new RuntimeResourceRegistry({ logger: quiet,
    quiesce: [{ name: "fence", run: () => events.push("quiesce") }],
    drain: [{ name: "flush", run: () => events.push("drain") }],
    close: [{ name: "gateway", preserveOnRestart: true, run: () => events.push("gateway-close") }],
    finalize: [{ name: "writer", run: () => { writerClosed = true; events.push("writer-close"); } }],
    releaseLock: [{ name: "instance", run: () => { assert.equal(writerClosed, true); events.push("release"); } }],
  });
  const controller = new RuntimeRestartController({ getRequest: () => request, updateOffset: () => 0,
    hasBlockingWork: () => blocked, setWaiting: noop, updateMessage: noop, saveState: noop,
    beginStopping: () => { assert.equal(blocked, false); stopping = true; events.push("stopping"); return true; },
    isStopping: () => stopping, stopTimers() {}, stopMedia() {}, resources, logger: quiet,
    launchReplacement: () => assert.fail("ordinary launch must not run"), recoverPrevious: () => assert.fail("closed stores must not reopen"),
    abortRestart: noop, finishSuccessfulReplacement: () => events.push("exit-old"),
    packageHandoff: { arm: () => events.push("arm-native"), writersClosed: () => events.push("durable-closed") },
  });
  assert.equal((await controller.perform()).status, "waiting-for-work"); assert.equal(stopping, false);
  blocked = false;
  assert.equal((await controller.perform()).status, "handed-off");
  assert.deepEqual(events, ["stopping", "quiesce", "drain", "arm-native", "gateway-close", "writer-close", "durable-closed", "release", "exit-old"]);
});

test("failed package finalization retains original stopping and never releases or recovers closed stores", async () => {
  let released = false;
  const controller = new RuntimeRestartController({ getRequest: () => ({ metadata: { packageHandoff: {} } }),
    updateOffset: () => 0, hasBlockingWork: () => false, setWaiting: noop, updateMessage: noop, saveState: noop,
    beginStopping: () => true, stopTimers() {}, stopMedia() {}, logger: quiet,
    resources: { quiesce: noop, drain: noop, close: noop,
      finalize: async () => ({ ok: false, failures: [{ name: "writer", error: new Error("unknown close") }] }),
      releaseLock: () => { released = true; } },
    packageHandoff: { arm: noop, writersClosed: () => assert.fail("not closed") },
    launchReplacement: () => assert.fail(), recoverPrevious: () => assert.fail("no recovery of closed stores"),
    abortRestart: () => assert.fail(), finishSuccessfulReplacement: () => assert.fail(),
  });
  assert.equal((await controller.perform()).status, "failed"); assert.equal(released, false);
});

test("native arm lost reply preserves one Host admission under the original identity", async (t) => {
  const f = await fixture(t, "running");
  await writeFile(path.join(f.dataDir, "bot.lock"), JSON.stringify({ pid: process.pid, releaseId: "old", instanceToken: "old-instance" }));
  let calls = 0, time = 0;
  const spawnImpl = () => { calls++; const child = new EventEmitter(); child.pid = 1234; child.unref = () => {}; return child; };
  await assert.rejects(armPackageRestart({ request: f.store.getReadonly(f.binding.operationId), store: f.store,
    spawnImpl, ownershipTimeoutMs: 1, now: () => time++, wait: noop }), /unknown/u);
  assert.equal(f.store.getReadonly(f.binding.operationId).phase, "package-arming");
  await assert.rejects(armPackageRestart({ request: f.store.getReadonly(f.binding.operationId), store: f.store, spawnImpl }), /readback/u);
  assert.equal(calls, 1);
});

test("package intake persists original before scheduling, returns while work remains, and rejects changed replay", async (t) => {
  const f = await fixture(t); // Separate store for intake; no preexisting original.
  const store = new MaintenanceOperationStore({ dataDir: path.join(f.root, "intake") });
  await mkdir(store.dataDir);
  let request = null, scheduled = 0, saved = 0;
  const input = { operationId: "intake-original", tag: "2.0.5", archive: f.binding.target.archive.file,
    descriptor: f.binding.target.descriptor.file, installer: f.binding.target.installer.file };
  const service = new RestartRequestService({ operationStore: store, currentTarget: () => ({}),
    getRequest: () => request, setRequest: (value) => { request = value; }, blockingWorkCount: () => 1,
    currentChatId: () => null, updateOffset: () => 0, processingUpdateId: () => null,
    saveState: async () => { saved++; assert.ok(store.getReadonly(input.operationId)); },
    announceDesktop: noop, sendTelegram: noop, performRestart: () => assert.fail("active work"),
    scheduleRestart: () => { scheduled++; }, preparePackage: async () => f.envelope,
  });
  assert.deepEqual(await service.fromPackage(input), { accepted: true, waiting: true, operationId: input.operationId });
  assert.equal(saved, 1); assert.equal(scheduled, 0);
  assert.equal((await service.fromPackage({ installer: input.installer, archive: input.archive,
    descriptor: input.descriptor, tag: input.tag, operationId: input.operationId })).accepted, false);
  await assert.rejects(service.fromPackage({ ...input, tag: "2.0.6" }), /input changed/u);
});

test("canonical published asset joins refuse foreign URLs, digest drift and a conflicting descriptor", async (t) => {
  const f = await fixture(t);
  const descriptor = { schema: 1, repository: "IIITYRAELIII/AgentHub", platform: "win32-x64",
    asset: "AgentHub-win32-x64.zip", bytes: f.binding.target.archive.bytes,
    sha256: f.binding.target.archive.sha256, packageManifestSha256: "c".repeat(64),
    sourceCommit: "a".repeat(40), releaseId: "new", version: "2.0.5+build.18",
    versionScheme: "semver-build-v1", publicVersion: "2.0.5", buildNumber: 18 };
  await writeFile(f.binding.target.descriptor.file, JSON.stringify(descriptor));
  const input = { tag: "2.0.5", archive: f.binding.target.archive.file,
    descriptor: f.binding.target.descriptor.file, installer: f.binding.target.installer.file };
  const metadata = { tag_name: input.tag, draft: false, prerelease: false, published_at: "2026-10-30", assets: [] };
  for (const [key, name] of [["archive", "AgentHub-win32-x64.zip"], ["descriptor", "AgentHub-win32-x64.zip.json"], ["installer", "install_release.py"]]) {
    const file = await packageFile(input[key]);
    metadata.assets.push({ name, state: "uploaded", size: file.bytes, digest: `sha256:${file.sha256}`,
      browser_download_url: `https://github.com/IIITYRAELIII/AgentHub/releases/download/${input.tag}/${name}` });
  }
  const readMetadata = async () => metadata;
  assert.equal((await verifyPublicPackageTarget(input, { readMetadata })).releaseId, "new");
  const url = metadata.assets[0].browser_download_url;
  metadata.assets[0].browser_download_url = "https://foreign.invalid/archive.zip";
  await assert.rejects(verifyPublicPackageTarget(input, { readMetadata }), /identity/u);
  metadata.assets[0].browser_download_url = url;
  await writeFile(input.archive, "foreign bytes");
  await assert.rejects(verifyPublicPackageTarget(input, { readMetadata }), /published asset/u);
});

test("SQLite backup includes committed WAL, refuses a foreign reservation and preserves UNKNOWN receipts", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dataDir, "journal.sqlite");
  const db = new DatabaseSync(file);
  try {
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE receipt(id TEXT, outcome TEXT); INSERT INTO receipt VALUES('original','unknown');");
  const result = await backupStoppedRuntime({ runtimeRoot: f.root,
    destination: path.join(f.scratchRoot, "success-backup"), assertStopped: noop });
  assert.ok(result.files.some((entry) => entry.path === path.join("data", "journal.sqlite")));
  const read = new DatabaseSync(path.join(result.directory, "data", "journal.sqlite"), { readOnly: true });
  assert.deepEqual({ ...read.prepare("SELECT * FROM receipt").get() }, { id: "original", outcome: "unknown" });
  read.close();
  db.exec("BEGIN IMMEDIATE; UPDATE receipt SET outcome='not-committed';");
  await assert.rejects(backupStoppedRuntime({ runtimeRoot: f.root,
    destination: path.join(f.scratchRoot, "foreign-backup"), assertStopped: noop }), /locked|busy/u);
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT outcome FROM receipt").get().outcome, "unknown");
  } finally { db.close(); }
});

test("a later foreign SQLite reservation preserves its busy error and releases earlier reservations", async (t) => {
  const f = await fixture(t);
  const first = new DatabaseSync(path.join(f.dataDir, "a.sqlite"));
  const last = new DatabaseSync(path.join(f.dataDir, "z.sqlite"));
  try {
    first.exec("CREATE TABLE t(v);INSERT INTO t VALUES(17)");
    last.exec("CREATE TABLE t(v);BEGIN IMMEDIATE;INSERT INTO t VALUES(29)");
    await assert.rejects(backupStoppedRuntime({ runtimeRoot: f.root,
      destination: path.join(f.scratchRoot, "foreign-last"), assertStopped: noop }), /locked|busy/u);
    first.exec("PRAGMA busy_timeout=0;BEGIN IMMEDIATE;UPDATE t SET v=18;COMMIT");
    assert.equal(first.prepare("SELECT v FROM t").get().v, 18);
    last.exec("ROLLBACK");
    assert.equal(last.prepare("SELECT count(*) AS n FROM t").get().n, 0);
  } finally { last.close(); first.close(); }
});
