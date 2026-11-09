import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRuntimeRestartComposition } from "../../src/composition/runtime-restart-composition.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { RuntimeRestartController } from "../../src/runtime/runtime-restart-controller.mjs";
import { RuntimeResourceRegistry } from "../../src/runtime/runtime-resource-registry.mjs";
import { RestartRequestService } from "../../src/application/restart-request-service.mjs";
import { backupStoppedRuntime, inspectRuntimeBackupScope } from "../../src/infrastructure/persistence/runtime-maintenance-backup.mjs";
import { packageBindingDigest, packageDigest, packageFile, packageDirectory, verifyPublicPackageTarget } from "../../src/infrastructure/filesystem/runtime-package-target.mjs";
import { armPackageRestart, continuePackageRestart, packageCheckpoint, packageHandoffBinding,
  packageHostMain, startPackageBootstrap, preparePackageRestart,
  preflightPackageRestart } from "../../src/runtime/runtime-package-handoff.mjs";
import { packageBackupRecoveryRequest, recoverPackageBackup, assertPackageBackupRecovery } from "../../src/runtime/runtime-package-backup-recovery.mjs";
import { relativeModuleSpecifiers } from "../../src/infrastructure/filesystem/module-import-specifiers.mjs";
import { buildWindowsRuntimeHost } from "../../src/infrastructure/process/runtime-host-builder.mjs";

const noop = async () => {};
const quiet = { log() {}, error() {}, warn() {} };

async function versionedFixture(t, phase = "package-writers-closed") {
  const f = await fixture(t, phase);
  const host = await readFile(f.binding.hostCopy);
  await writeFile(path.join(f.root, "AgentHub.RuntimeHost.exe"), host);
  const manifest = build => ({ releaseId: "old", version: "2.1.3", publicVersion: "2.1.3",
    versionScheme: "semver-build-v1", releaseVersion: `2.1.3+build.${build}`, buildNumber: build,
    files: [{ path: "AgentHub.RuntimeHost.exe", bytes: host.length, sha256: packageDigest(host) }] });
  const oldRaw = JSON.stringify(manifest(29893517));
  await writeFile(path.join(f.root, "releases/old/AgentHub.RuntimeHost.exe"), host);
  await writeFile(path.join(f.root, "releases/old/package.json"), '{"name":"agent-hub","version":"2.1.3"}');
  await writeFile(path.join(f.root, "releases/old/runtime-manifest.json"), oldRaw);
  const publicFile = path.join(f.scratchRoot, "runtime-manifest.public.json");
  await writeFile(publicFile, JSON.stringify({ ...manifest(29892686), releaseId: "new", publicationRevision: "a".repeat(40) }));
  f.binding.old.manifestSha256 = packageDigest(oldRaw);
  f.binding.target.version = "2.1.3+build.29892686";
  f.binding.target.runtimeManifest = await packageFile(publicFile);
  f.envelope = { schema: 1, binding: f.binding, sha256: packageBindingDigest(f.binding) };
  f.store.transition(f.binding.operationId, { metadata: { packageHandoff: f.envelope } });
  return f;
}

test("actual 506/public213 build ordering refuses in controller preflight before stopping", async t => {
  const f = await versionedFixture(t, "running");
  let stops = 0, failure;
  const composition = createRuntimeRestartComposition({
    getRestartRequest: () => f.store.getReadonly(f.binding.operationId), setRestartRequest: noop,
    updateOffset: () => 99, hasBlockingWork: () => false, setWaiting: noop,
    beginStopping: () => { stops++; return false; },
    isStopping: () => false, setStopping: noop, saveState: noop, updateRestartMessage: noop,
    failRestartOperation: async error => { failure = error; }, startRuntimeTimers: noop,
    stopCodexAppServerTree: noop, stopRuntimeTimers: noop,
    maintenanceOperations: f.store,
  });
  const result = await composition.runtimeRestart.perform();
  assert.equal(result.status, "aborted");
  assert.match(failure?.message ?? "", /Version\/build downgrade or reuse refused/u);
  assert.equal(stops, 0);
  assert.equal(f.store.getReadonly(f.binding.operationId).metadata.packageNative, undefined);
});

test("definitive poststop installer failure restores verified same current and retains failed original", async t => {
  const f = await versionedFixture(t), prior = f.store.getReadonly(f.binding.operationId);
  let installs = 0, launches = 0;
  const config = await readFile(path.join(f.root, "config.json"));
  const result = await continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
    assertRetired: noop, install: async () => { installs++; throw Object.assign(Error("installer refused"), { code: 1 }); },
    launch: async binding => { launches++; assert.equal(binding.target.releaseId, "old");
      await packageCheckpoint(f.store, f.binding.operationId, "package-recovery-launching", { packageLaunchAdmission: { hostPid: 900 } });
      return { pid: 900 }; },
    ready: async binding => {
      assert.equal(binding.target.releaseId, "old");
      f.store.recoverInterrupted({ operationIds: [f.binding.operationId] });
      const service = new RestartRequestService({ operationStore: f.store, currentTarget: () => ({}) });
      const saved = process.env.AGENT_HUB_RELEASE_ID;
      try { process.env.AGENT_HUB_RELEASE_ID = "old"; await service.complete(f.binding.operationId); }
      finally { if (saved === undefined) delete process.env.AGENT_HUB_RELEASE_ID; else process.env.AGENT_HUB_RELEASE_ID = saved; }
      return { pid: 901 };
    },
  });
  assert.equal(result.status, "restored");
  assert.deepEqual([installs, launches], [1, 1]);
  const completed = f.store.getReadonly(f.binding.operationId);
  assert.equal(completed.status, "failed"); assert.equal(completed.outcome, "failed");
  assert.deepEqual(completed.metadata.packageHandoff, prior.metadata.packageHandoff);
  assert.match(completed.metadata.packageFailureMessage, /installer refused/u);
  assert.deepEqual(await readFile(path.join(f.root, "config.json")), config);
  assert.equal((await continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
    assertRetired: () => assert.fail("no replay"), install: () => assert.fail("no second install") })).status, "reconciliation-required");
});

for (const fault of ["pointer", "stable-host", "release-file", "unknown-installer", "installer-crash"]) {
  test(`poststop failure cannot recover changed or unknown current: ${fault}`, async t => {
    const f = await versionedFixture(t);
    await assert.rejects(continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
      assertRetired: noop, launch: () => assert.fail("no unsafe recovery launch"),
      install: async () => {
        if (fault === "pointer") await writeFile(path.join(f.root, "current.json"), '{"current":"foreign"}');
        if (fault === "stable-host") await writeFile(path.join(f.root, "AgentHub.RuntimeHost.exe"), "foreign");
        if (fault === "release-file") await writeFile(path.join(f.root, "releases/old/AgentHub.RuntimeHost.exe"), "foreign");
        throw Object.assign(Error("installer failed"), { code: fault === "unknown-installer" ? "ETIMEDOUT" : fault === "installer-crash" ? 3221225794 : 1 });
      },
    }), /installer failed/u);
    const unknown = f.store.getReadonly(f.binding.operationId);
    assert.equal(unknown.outcome, "unknown"); assert.equal(unknown.status, "reconciling");
    assert.equal(unknown.metadata.packageLaunchAdmission, undefined);
    const again = await continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
      assertRetired: () => assert.fail("no ambiguous replay") });
    assert.equal(again.status, "reconciliation-required");
  });
}
async function fixture(t, phase = "package-writers-closed") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub376-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(directory, "runtime"), dataDir = path.join(root, "data");
  const scratchRoot = path.join(directory, "scratch");
  await mkdir(path.join(root, "releases", "old"), { recursive: true });
  await mkdir(dataDir); await mkdir(scratchRoot);
  await writeFile(path.join(root, "config.json"), '{"auth":"fixture-private","cursor":17}');
  const pointer = '{"current":"old","previous":"older"}';
  const manifest = JSON.stringify({ releaseId: "old", version: "2.0.4", publicVersion: "2.0.4",
    releaseVersion: "2.0.4+build.17", versionScheme: "semver-build-v1", buildNumber: 17 });
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
    roots: { runtime: await packageDirectory(root), data: await packageDirectory(dataDir) },
    old: { releaseId: "old", currentSha256: packageDigest(pointer), manifestSha256: packageDigest(manifest),
      pid: process.pid, hostPid: 123, instanceSha256: packageDigest("old-instance"),
      launcher: await packageFile(hostCopy) }, target };
  const envelope = { schema: 1, binding, sha256: packageBindingDigest(binding) };
  const store = new MaintenanceOperationStore({ dataDir });
  store.create({ operationId: binding.operationId, kind: "restart", streamId: "agent-hub-runtime",
    threadId: "agent-hub-runtime", status: "running", phase, metadata: { packageHandoff: envelope } });
  return { root, dataDir, scratchRoot, store, binding, envelope };
}

test("real package preparation keeps backup outside runtime-local TEMP and binds its physical scratch", async t => {
  const f = await versionedFixture(t);
  const manifest = JSON.parse(await readFile(f.binding.target.runtimeManifest.file, "utf8"));
  manifest.releaseVersion = "2.1.4+build.29900000";
  manifest.publicVersion = manifest.version = "2.1.4";
  manifest.buildNumber = 29900000;
  const raw = Buffer.from(JSON.stringify(manifest));
  f.binding.target.version = manifest.releaseVersion;
  f.binding.target.packageManifestSha256 = "b".repeat(64);
  const temp = path.join(f.root, "temp"); await mkdir(temp);
  const priorTemp = process.env.TEMP, priorTmp = process.env.TMP;
  t.after(() => {
    if (priorTemp === undefined) delete process.env.TEMP; else process.env.TEMP = priorTemp;
    if (priorTmp === undefined) delete process.env.TMP; else process.env.TMP = priorTmp;
  });
  process.env.TEMP = process.env.TMP = temp;
  const target = structuredClone(f.binding.target);
  const envelope = await preparePackageRestart({ operationId: f.binding.operationId, tag: "2.1.4",
    archive: target.archive.file, descriptor: target.descriptor.file, installer: target.installer.file }, {
    dataDir: f.dataDir, environment: { AGENT_HUB_RUNTIME_ROOT: f.root, AGENT_HUB_HOST_PID: "123" },
    verifyTarget: async () => target,
    captureCurrent: async () => ({ runtimeRoot: f.root, dataDir: f.dataDir,
      roots: f.binding.roots, old: f.binding.old }),
    inspect: async () => ({ stdout: JSON.stringify({ schema: 1, kind: "verified-package-input",
      releaseId: target.releaseId, packageManifestSha256: target.packageManifestSha256,
      runtimeManifestSha256: packageDigest(raw), runtimeManifestBase64: raw.toString("base64") }) }),
  });
  assert.ok(!path.relative(f.root, envelope.binding.scratchRoot).startsWith(`temp${path.sep}`));
  assert.deepEqual(envelope.binding.scratch, await packageDirectory(envelope.binding.scratchRoot));
  f.store.transition(f.binding.operationId, { metadata: { packageHandoff: envelope } });
  await preflightPackageRestart(f.store.getReadonly(f.binding.operationId));
  let backedUp = false;
  await continuePackageRestart({ store: f.store, operationId: f.binding.operationId, assertRetired: noop,
    backup: async args => { const saved = await backupStoppedRuntime(args); backedUp = true; return saved; },
    install: async () => {
      assert.equal(backedUp, true);
      const db = new DatabaseSync(path.join(envelope.binding.scratchRoot, "backup/data/runtime.sqlite"), { readOnly: true });
      try { assert.ok(db.prepare("SELECT count(*) AS n FROM maintenance_operations").get().n > 0); }
      finally { db.close(); }
    }, verifyInstalled: noop, launch: async () => ({ pid: 900 }),
    ready: async () => { f.store.settle(f.binding.operationId, { succeeded: true, phase: "completed" }); },
  });
});

test("pre-stop package preflight refuses runtime-local, replaced and occupied backup destinations", async t => {
  const f = await versionedFixture(t);
  const raw = JSON.parse(await readFile(f.binding.target.runtimeManifest.file, "utf8"));
  raw.releaseVersion = "2.1.4+build.29900000"; raw.publicVersion = raw.version = "2.1.4"; raw.buildNumber = 29900000;
  const manifestFile = path.join(path.dirname(f.root), "external-manifest.json");
  await writeFile(manifestFile, JSON.stringify(raw));
  f.binding.target.runtimeManifest = await packageFile(manifestFile);
  f.binding.target.version = raw.releaseVersion;
  const originalScratch = f.binding.scratchRoot;
  const local = path.join(f.root, "temp"); await mkdir(local);
  for (const fault of ["inside", "replaced", "occupied"]) {
    const binding = structuredClone(f.binding);
    binding.scratchRoot = fault === "inside" ? local : originalScratch;
    binding.scratch = await packageDirectory(binding.scratchRoot);
    if (fault === "replaced") {
      await rename(originalScratch, `${originalScratch}-retained`); await mkdir(originalScratch);
    }
    if (fault === "occupied") await mkdir(path.join(originalScratch, "backup"));
    const request = { operationId: binding.operationId, kind: "restart",
      metadata: { packageHandoff: { schema: 1, binding, sha256: packageBindingDigest(binding) } } };
    await assert.rejects(preflightPackageRestart(request), /outside runtime|physical identity|occupied/u);
  }
});

async function recoveryHelper(t) {
  const source = path.resolve(import.meta.dirname, "../..");
  const base = path.join(source, "WIP"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "package-backup-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const pending = ["src/runtime/runtime-package-handoff.mjs"], included = new Set();
  while (pending.length) {
    const file = pending.shift();
    if (included.has(file)) continue;
    assert.ok(!file.startsWith("../") && !path.isAbsolute(file));
    const raw = await readFile(path.join(source, file));
    included.add(file);
    const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, raw);
    for (const relative of relativeModuleSpecifiers(raw.toString("utf8"))) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), relative)));
    }
  }
  included.add("src/infrastructure/filesystem/sealed-native-capture.cs");
  await cp(path.join(source, "src/infrastructure/filesystem/sealed-native-capture.cs"), path.join(root, "src/infrastructure/filesystem/sealed-native-capture.cs"));
  await buildWindowsRuntimeHost({ sourceRoot: source, outputFile: path.join(root, "AgentHub.RuntimeHost.exe") });
  await writeFile(path.join(root, "package.json"), '{"name":"agent-hub","version":"2.1.5"}');
  included.add("AgentHub.RuntimeHost.exe"); included.add("package.json");
  const files = [];
  for (const file of [...included].sort()) {
    const identity = await packageFile(path.join(root, file));
    files.push({ path: file, bytes: identity.bytes, sha256: identity.sha256 });
  }
  await writeFile(path.join(root, "runtime-manifest.json"), JSON.stringify({
    releaseId: "recovery-fixture", version: "2.1.5", files,
  }));
  t.diagnostic(`thinHelperFiles=${files.length}; bytes=${files.reduce((sum, file) => sum + file.bytes, 0)}`);
  return root;
}

async function backupRefusalFixture(t, helper) {
  const f = await versionedFixture(t);
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" });
  const deadPid = child.pid;
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(Error("fixture child failed"))); });
  f.binding.old.pid = deadPid;
  f.binding.scratchRoot = path.join(f.root, "temp"); await mkdir(f.binding.scratchRoot);
  const native = { oldNodePid: deadPid, oldHostPid: 123, hostPid: deadPid, launcherPid: deadPid,
    hostStarted: "1", oldNodeStarted: "1", oldHostStarted: "1" };
  // All recorded fixture owners are joined. The real native helper independently
  // checks process absence/root gate; these are controlled cohort receipt ports.
  f.binding.old.hostPid = deadPid; native.oldHostPid = deadPid;
  const handoff = { schema: 1, binding: f.binding, sha256: packageBindingDigest(f.binding) };
  f.store.transition(f.binding.operationId, { phase: "package-backup", metadata: { packageHandoff: handoff, packageNative: native } });
  const before = f.store.getReadonly(f.binding.operationId);
  f.store.transition(f.binding.operationId, { status: "reconciling", phase: "package-reconciling", outcome: "unknown",
    metadata: { packageFailurePhase: "package-backup", packageFailureCode: "MAINTENANCE_BACKUP_INSIDE_RUNTIME",
      packageFailureMessage: "Maintenance backup destination must be outside runtime root",
      packageBackupDestinationFailure: { schema: 1, bindingSha256: handoff.sha256, fromRevision: before.revision, reason: "inside-runtime" } } });
  await writeFile(path.join(f.root, ".agent-hub-release-acceptance.json"), JSON.stringify({ schemaVersion: 1, root: f.root, id: "backup-refusal-fixture" }));
  await writeFile(path.join(f.root, ".agent-hub-release-acceptance.closed"), Buffer.from([1]));
  const original = f.store.getReadonly(f.binding.operationId);
  const request = await packageBackupRecoveryRequest(f.root, original.operationId, original.revision, handoff.sha256, helper);
  const requestFile = path.join(path.dirname(f.root), "backup-recovery.json");
  await writeFile(requestFile, JSON.stringify(request));
  return { ...f, request, requestFile, original };
}

test("closed acceptance SAME backup original settles failed with history under real native root owner and never installs or launches", async t => {
  const helper = await recoveryHelper(t), f = await backupRefusalFixture(t, helper);
  const pointer = await readFile(path.join(f.root, "current.json")), config = await readFile(path.join(f.root, "config.json"));
  const result = await recoverPackageBackup(f.requestFile);
  assert.equal(result.status, "failed"); assert.equal(result.phase, "retained-stopped-current");
  const saved = f.store.getReadonly(f.binding.operationId), recovery = saved.metadata.packageBackupRecovery;
  assert.deepEqual(recovery.original, f.original);
  assert.deepEqual(saved.metadata.packageHandoff, f.original.metadata.packageHandoff);
  assert.deepEqual(saved.metadata.packageNative, f.original.metadata.packageNative);
  assert.equal(recovery.installInvoked, false); assert.equal(recovery.launchInvoked, false);
  assert.equal(recovery.priorOutcome, "unknown"); assert.equal(saved.outcome, "failed");
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), pointer);
  assert.deepEqual(await readFile(path.join(f.root, "config.json")), config);
  assert.deepEqual(await readFile(path.join(f.root, ".agent-hub-release-acceptance.closed")), Buffer.from([1]));
  assert.equal(saved.metadata.packageBackup, undefined); assert.equal(saved.metadata.packageLaunchSha256, undefined);
  await recoverPackageBackup(f.requestFile, { executeHost: () => assert.fail("no second native admission") });
  assert.deepEqual(f.store.getReadonly(f.binding.operationId), saved);
});

test("qualified backup disposition refuses changed input, custody, data, native-live and generic UNKNOWN", async t => {
  const helper = await recoveryHelper(t);
  for (const fault of ["revision", "pointer", "config", "fence", "asset", "native-live", "unknown",
    "late-config", "late-pointer", "late-fence", "old-payload"]) {
    const f = await backupRefusalFixture(t, helper);
    if (fault === "revision") f.store.transition(f.original.operationId, { metadata: { foreign: true } });
    if (fault === "pointer") await writeFile(path.join(f.root, "current.json"), '{"current":"foreign"}');
    if (fault === "config") await writeFile(path.join(f.root, "config.json"), '{"changed":true}');
    if (fault === "fence") await rm(path.join(f.root, ".agent-hub-release-acceptance.closed"));
    if (fault === "asset") await writeFile(f.binding.target.installer.file, "changed");
    if (fault === "old-payload") await writeFile(path.join(f.root, "releases/old/AgentHub.RuntimeHost.exe"), "changed");
    if (fault === "native-live") {
      const row = f.store.getReadonly(f.original.operationId);
      f.store.transition(row.operationId, { metadata: { packageNative: { ...row.metadata.packageNative, launcherPid: process.pid },
        packageBackupDestinationFailure: { ...row.metadata.packageBackupDestinationFailure, fromRevision: row.revision } } });
      const updated = f.store.getReadonly(row.operationId);
      f.request = await packageBackupRecoveryRequest(f.root, row.operationId, updated.revision,
        updated.metadata.packageHandoff.sha256, helper);
      await writeFile(f.requestFile, JSON.stringify(f.request));
    }
    if (fault === "unknown") {
      const row = f.store.getReadonly(f.original.operationId);
      f.store.transition(row.operationId, { metadata: { packageFailurePhase: "package-installing" } });
      await assert.rejects(assertPackageBackupRecovery(f.store.getReadonly(row.operationId)), /qualified/u);
    }
    await assert.rejects(recoverPackageBackup(f.requestFile, {
      executeHost: async (...args) => {
        if (fault === "late-config") await writeFile(path.join(f.root, "config.json"), '{"changed":true}');
        if (fault === "late-pointer") await writeFile(path.join(f.root, "current.json"), '{"current":"foreign"}');
        if (fault === "late-fence") await rm(path.join(f.root, ".agent-hub-release-acceptance.closed"));
        return promisify(execFile)(...args);
      },
    }));
    const saved = f.store.getReadonly(f.original.operationId);
    assert.equal(saved.status, "reconciling"); assert.equal(saved.outcome, "unknown");
    assert.equal(saved.metadata.packageBackup, undefined); assert.equal(saved.metadata.packageLaunchSha256, undefined);
    if (fault !== "native-live" && !fault.startsWith("late-")) assert.equal(saved.metadata.packageBackupRecovery, undefined);
  }
});

test("lost backup disposition reply reads the SAME terminal original without another native admission", async t => {
  const helper = await recoveryHelper(t), f = await backupRefusalFixture(t, helper);
  let admissions = 0;
  await assert.rejects(recoverPackageBackup(f.requestFile, { executeHost: async (...args) => {
    admissions++; await promisify(execFile)(...args); throw Error("controlled reply lost after native join");
  } }), /reply lost/u);
  const terminal = f.store.getReadonly(f.original.operationId);
  assert.equal(terminal.status, "failed");
  const result = await recoverPackageBackup(f.requestFile, { executeHost: () => assert.fail("no replay") });
  assert.equal(result.status, "failed"); assert.equal(admissions, 1);
  assert.deepEqual(f.store.getReadonly(f.original.operationId), terminal);
});

test("concurrent SAME backup disposition requests retain one native admission", async t => {
  const helper = await recoveryHelper(t), f = await backupRefusalFixture(t, helper);
  let admissions = 0;
  const executeHost = async (...args) => { admissions++; return promisify(execFile)(...args); };
  await Promise.all([recoverPackageBackup(f.requestFile, { executeHost }), recoverPackageBackup(f.requestFile, { executeHost })]);
  assert.equal(admissions, 1);
  assert.equal(f.store.getReadonly(f.original.operationId).status, "failed");
});

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
      const snapshot = f.store.getReadonly(actual.operationId).metadata.packageBackup;
      assert.ok(snapshot.retentionFiles.length >= snapshot.files.length);
      assert.ok(snapshot.retentionFiles.some(file => file.path.endsWith("journal.sqlite-shm")));
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

async function packageEntryFixture(t) {
  const f = await fixture(t);
  f.store.settle(f.binding.operationId, { succeeded: false, phase: "fixture-finished" });
  const packageRoot = path.join(f.scratchRoot, "verified"), payload = path.join(packageRoot, "runtime");
  await mkdir(payload, { recursive: true });
  const files = { "AgentHub.RuntimeHost.exe": "synthetic; never execute", "package.json": '{"name":"agent-hub","version":"2.0.5"}' };
  const manifest = { releaseId: "new", publicationRevision: "a".repeat(40), version: "2.0.5", releaseVersion: "2.0.5+build.18",
    versionScheme: "semver-build-v1", publicVersion: "2.0.5", buildNumber: 18, files: [] };
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(payload, name), body);
    manifest.files.push({ path: name, bytes: Buffer.byteLength(body), sha256: packageDigest(body) });
  }
  const manifestRaw = JSON.stringify(manifest);
  await writeFile(path.join(payload, "runtime-manifest.json"), manifestRaw);
  const inventory = JSON.stringify({ releaseId: "new", sourceCommit: "a".repeat(40), version: "2.0.5+build.18",
    files: [{ path: "runtime/runtime-manifest.json", bytes: Buffer.byteLength(manifestRaw), sha256: packageDigest(manifestRaw) }] });
  await writeFile(path.join(packageRoot, "package-manifest.json"), inventory);
  const descriptor = { schema: 1, repository: "IIITYRAELIII/AgentHub", platform: "win32-x64", asset: "AgentHub-win32-x64.zip",
    bytes: f.binding.target.archive.bytes, sha256: f.binding.target.archive.sha256,
    packageManifestSha256: packageDigest(inventory), sourceCommit: "a".repeat(40), releaseId: "new",
    version: "2.0.5+build.18", versionScheme: "semver-build-v1", publicVersion: "2.0.5", buildNumber: 18 };
  await writeFile(f.binding.target.descriptor.file, JSON.stringify(descriptor));
  const input = { schema: 1, operationId: "package-entry-original", runtimeRoot: f.root, packageRoot, tag: "2.0.5",
    archive: f.binding.target.archive.file, descriptor: f.binding.target.descriptor.file, installer: f.binding.target.installer.file };
  const requestFile = path.join(f.scratchRoot, "update-request.json"); await writeFile(requestFile, JSON.stringify(input));
  const metadata = { tag_name: input.tag, draft: false, prerelease: false, published_at: "2026-10-30", assets: [] };
  for (const [key, name] of [["archive", "AgentHub-win32-x64.zip"], ["descriptor", "AgentHub-win32-x64.zip.json"], ["installer", "install_release.py"]]) {
    const file = await packageFile(input[key]);
    metadata.assets.push({ name, state: "uploaded", size: file.bytes, digest: `sha256:${file.sha256}`,
      browser_download_url: `https://github.com/IIITYRAELIII/AgentHub/releases/download/${input.tag}/${name}` });
  }
  await writeFile(path.join(f.dataDir, "bot.lock"), JSON.stringify({ pid: process.pid, releaseId: "old", ready: true, instanceToken: "old-instance" }));
  return { ...f, input, requestFile, readMetadata: async () => metadata };
}

for (const lostReply of [false, true]) test(`public package entry uses one graceful original; lostReply=${lostReply} never starts a manual fallback`, async (t) => {
  const f = await packageEntryFixture(t); let request = null, saves = 0, dispatches = 0;
  const binding = { ...f.binding, operationId: f.input.operationId };
  const service = new RestartRequestService({ operationStore: f.store, currentTarget: () => ({}),
    getRequest: () => request, setRequest: (value) => { request = value; }, blockingWorkCount: () => 1,
    currentChatId: () => null, updateOffset: () => 0, processingUpdateId: () => null,
    saveState: async () => { saves++; assert.ok(f.store.getReadonly(f.input.operationId)); },
    announceDesktop: noop, sendTelegram: noop, performRestart: () => assert.fail("active work cannot stop"),
    scheduleRestart: () => assert.fail("active work cannot schedule"),
    preparePackage: async () => ({ schema: 1, binding, sha256: packageBindingDigest(binding) }) });
  const control = async (action, business) => {
    if (action === "runtime-health") return { live: true, ready: true, process: { pid: process.pid, releaseId: "old" }, packageHandoff: { protocol: 1 } };
    assert.equal(action, "restart-package"); dispatches++;
    const response = await service.fromPackage(business);
    if (lostReply) throw new Error("lost addressed reply");
    return response;
  };
  const invoke = () => startPackageBootstrap(f.requestFile, { readMetadata: f.readMetadata, control,
    confirmManualStop: () => assert.fail("no manual fallback"), spawnImpl: () => assert.fail("no external legacy launch") });
  if (lostReply) await assert.rejects(invoke(), /lost addressed reply/u);
  else assert.equal((await invoke()).status, "accepted-graceful");
  assert.equal(dispatches, 1); assert.equal(saves, 1);
  const replay = await startPackageBootstrap(f.requestFile, { readMetadata: () => assert.fail("readback must not prepare again"),
    control: () => assert.fail("no repeated dispatch"), spawnImpl: () => assert.fail("no repeated native launch") });
  assert.equal(replay.effectsReplayed, false); assert.equal(replay.status, "blocked");
});

test("legacy package entry requires explicit manual step; health and canonical payload drift cannot admit it", async (t) => {
  const f = await packageEntryFixture(t); let confirmations = 0;
  const options = { readMetadata: f.readMetadata,
    control: async () => ({ live: true, ready: true, process: { pid: process.pid, releaseId: "old" } }),
    confirmManualStop: async () => { confirmations++; throw new Error("user cancelled before admission"); },
    spawnImpl: () => assert.fail("no automatic stop or native launch") };
  await assert.rejects(startPackageBootstrap(f.requestFile, options), /user cancelled/u);
  assert.equal(confirmations, 1); assert.equal(f.store.getReadonly(f.input.operationId), null);
  await assert.rejects(startPackageBootstrap(f.requestFile, { ...options,
    control: async () => ({ live: true, ready: true, process: { pid: process.pid + 1, releaseId: "old" } }) }), /health does not match/u);
  await writeFile(path.join(f.input.packageRoot, "package-manifest.json"), "foreign inventory");
  await assert.rejects(startPackageBootstrap(f.requestFile, options), /canonical public descriptor/u);
  assert.equal(confirmations, 1); assert.equal(f.store.getReadonly(f.input.operationId), null);
});

test("equal original files in a replaced physical runtime root cannot authorize backup or install", async (t) => {
  const f = await fixture(t), oldRoot = `${f.root}-original`;
  await rename(f.root, oldRoot);
  await cp(oldRoot, f.root, { recursive: true, force: false, errorOnExist: true });
  await assert.rejects(continuePackageRestart({ store: f.store, operationId: f.binding.operationId,
    assertRetired: noop, backup: () => assert.fail("no backup after root replacement"),
    install: () => assert.fail("no install after root replacement") }), /old runtime identity changed/u);
  assert.equal(f.store.getReadonly(f.binding.operationId).outcome, "unknown");
  assert.deepEqual(await readFile(path.join(f.root, "config.json")), await readFile(path.join(oldRoot, "config.json")));
});

for (const modern of [true, false]) test(`backup scope refuses a selected junction before public update dispatch or legacy stop; modern=${modern}`, async (t) => {
  const f = await packageEntryFixture(t);
  const outside = path.join(f.scratchRoot, "outside");
  await mkdir(outside); await writeFile(path.join(outside, "foreign"), "keep");
  await mkdir(path.join(f.dataDir, "background-jobs"));
  await symlink(outside, path.join(f.dataDir, "background-jobs", "link"), process.platform === "win32" ? "junction" : "dir");
  let dispatches = 0, confirmations = 0, spawns = 0;
  await assert.rejects(startPackageBootstrap(f.requestFile, { readMetadata: f.readMetadata,
    control: async (action) => {
      if (action !== "runtime-health") { dispatches++; assert.fail("no dispatch"); }
      return { live: true, ready: true, process: { pid: process.pid, releaseId: "old" },
        ...(modern ? { packageHandoff: { protocol: 1 } } : {}) };
    }, confirmManualStop: async () => { confirmations++; }, spawnImpl: () => { spawns++; } }), /linked/u);
  assert.equal(dispatches + confirmations + spawns, 0);
  assert.equal(f.store.getReadonly(f.input.operationId), null);
  assert.equal(await readFile(path.join(outside, "foreign"), "utf8"), "keep");
});

test("package backup preflight refuses before stopping and rechecks newly admitted work without closing resources", async (t) => {
  const f = await fixture(t), events = [];
  let blocked = false, unsupported = true;
  const request = { operationId: "pre-stop", metadata: { packageHandoff: {} } };
  const controller = new RuntimeRestartController({ getRequest: () => request, updateOffset: () => 0,
    hasBlockingWork: () => blocked, setWaiting: async () => { events.push("waiting"); },
    updateMessage: noop, saveState: noop, resources: new RuntimeResourceRegistry({ logger: quiet,
      close: [{ name: "writer", run: () => events.push("close") }] }),
    beginStopping: () => { events.push("stop"); return true; }, stopTimers: noop, stopMedia: noop,
    launchReplacement: () => assert.fail("no launch"), recoverPrevious: noop,
    abortRestart: async () => { events.push("abort"); }, finishSuccessfulReplacement: noop, logger: quiet,
    packageHandoff: { preflight: async () => {
      if (unsupported) throw new Error("selected state linked");
      await inspectRuntimeBackupScope({ runtimeRoot: f.root }); blocked = true;
    }, arm: () => events.push("arm") },
  });
  const refusal = await controller.perform();
  assert.equal(refusal.status, "aborted"); assert.equal(refusal.phase, "package-backup-preflight");
  assert.deepEqual(events, ["abort"]);
  events.length = 0; unsupported = false;
  assert.equal((await controller.perform()).status, "waiting-for-work");
  assert.deepEqual(events, ["waiting"]);
});

test("overlapping retained scratch refuses before legacy stop or durable admission", async (t) => {
  const f = await packageEntryFixture(t);
  const requestFile = path.join(f.root, "overlapping-update.json");
  await writeFile(requestFile, JSON.stringify(f.input));
  await assert.rejects(startPackageBootstrap(requestFile, {
    readMetadata: () => assert.fail("scratch refusal precedes remote preparation"),
    control: () => assert.fail("no old runtime command"), confirmManualStop: () => assert.fail("no stopping"),
    spawnImpl: () => assert.fail("no Host admission"),
  }), /scratch roots must be separate/u);
  assert.equal(f.store.getReadonly(f.input.operationId), null);
});
