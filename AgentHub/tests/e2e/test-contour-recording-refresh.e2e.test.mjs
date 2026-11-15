import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { callDesktopControl } from "../../desktop-control.mjs";
import { PersistentDeliveryOutbox } from "../../src/infrastructure/persistence/delivery-outbox.mjs";
import { messageRequestFingerprint } from "../../src/infrastructure/persistence/message-receipts.mjs";
import { RuntimeStateStore, readRuntimeState } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { processIsAlive } from "../../src/infrastructure/process/process-liveness.mjs";
import { captureSqliteCohort } from "../../src/runtime/sqlite-cohort-snapshot.mjs";
import { prepareRecordingContourCohort } from "../../src/runtime/test-contour-cohort-preparation.mjs";
import { adoptRecordingTestContour, installTestContour, readyTestContourHealth, readTestContourStatus, serveTestContour, startTestContour,
  stopTestContour, testContourPaths, TEST_CONTOUR_FAKE_MODEL } from "../../src/runtime/test-contour-manager.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "../..");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) => writeFile(file, JSON.stringify(value), "utf8");
const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const messageId = "recording-manager-preserved-submission";
const threadId = "10000000-0000-4000-8000-000000000182";

async function fixture(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "hub-recording-refresh-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const dataDir = path.join(temporaryRoot, "source-data");
  const projectRoot = path.join(temporaryRoot, "source-project");
  await mkdir(dataDir); await mkdir(projectRoot);
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(dataDir, "journal.sqlite") });
  const runtime = new RuntimeStateStore({ dataDir });
  const text = "Literal paused command [hold:forever]";
  const fingerprint = await messageRequestFingerprint({ text, attachmentIdentities: [] });
  let item, receipt;
  try {
    await catalog.load(); await runtime.load();
    const workspace = catalog.createWorkspace({ name: "Owned synthetic cohort", settings: { workingDirectory: projectRoot } });
    const stream = catalog.createStream({ workspaceId: workspace.id, name: "Preserved Stream" });
    catalog.updateStreamSettings(stream.id, { project: projectRoot });
    const target = { workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId, projectRoot };
    catalog.bindThread(target);
    item = { ...target, id: "original-intake", clientUserMessageId: messageId, clientSource: "desktop-control",
      input: [{ type: "text", text }], paused: true, createdAt: new Date().toISOString(),
      conflictKind: "message-intake", telegramDeliveryRequested: false };
    receipt = { provider: "codex", threadId, clientUserMessageId: messageId, fingerprint,
      createdAt: item.createdAt, result: { accepted: true, queued: true, id: item.id } };
    await runtime.saveDeferredIntake({ item, destination: "queued", receipt });
    await runtime.save({ activeProvider: "codex", activeProjectRoot: projectRoot, streamId: stream.id,
      threadIds: { codex: threadId, claude: null }, activeRuns: [], pendingInputs: [],
      queuedInputs: [item], desktopMessageReceipts: [receipt] });
  } finally { await runtime.close(); await catalog.close(); }
  // A future-due captured outbox entry stays pending; no real transport is called.
  const outbox = new PersistentDeliveryOutbox({ directoryPath: path.join(dataDir, "delivery-outbox"),
    now: () => Date.now() + 3_600_000, deliver: async () => { throw new Error("not an execution fixture"); } });
  const delivery = await outbox.enqueue({ method: "sendMessage", body: { chat_id: 84, text: "Original delivery" } });
  const capture = await captureSqliteCohort({ sourceDataDirectory: dataDir,
    outputDirectory: path.join(temporaryRoot, "raw"), includeQueueFiles: true });
  const prepared = await prepareRecordingContourCohort({ captureManifestFile: capture.manifestFile,
    outputDirectory: path.join(temporaryRoot, "writable"), sourceConfig: { projectRoot, projects: [{ name: "Owned project", path: projectRoot }] } });
  // Exercise the real installer, replacing only its unrelated npm installation seam.
  await installTestContour({ root: prepared.root, run: async () => {} });
  receipt = (await readRuntimeState(path.join(prepared.root, "data"))).desktopMessageReceipts.find((entry) => entry.clientUserMessageId === messageId);
  const rawHashes = await Promise.all(capture.manifest.databases.map(async ({ name }) => [name, await hash(path.join(capture.dataDirectory, name))]));
  return { temporaryRoot, root: prepared.root, prepared, capture, rawHashes, item, receipt, delivery };
}

test("recording status accepts exact healthy runtime without legacy fake queue evidence", {  }, async (t) => {
  const f = await fixture(t);
  const paths = testContourPaths(f.root);
  const marker = await json(paths.markerFile);
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, live: true, ready: true, testContourRuntime: identity }));
  });
  let identity;
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  identity = { contourId: marker.id, releaseId: "synthetic-ready", operationId: "operation-ready",
    runtimeNonce: "nonce-ready", pid: process.pid, expectedPort: port, actualPort: port, model: TEST_CONTOUR_FAKE_MODEL };
  await save(path.join(paths.dataDir, "bot.lock"), { pid: process.pid, releaseId: identity.releaseId, ready: true });
  await save(paths.stateFile, { ...identity, port, managerPid: process.pid, runtimePid: process.pid });
  assert.equal((await readTestContourStatus({ root: f.root })).status, "ready");
  await assert.rejects(readyTestContourHealth(port, { root: f.root, requireFakeQueue: true }), /Fake Codex queue recovery/);
  // A mere recording directory or modified marker must not bypass the legacy check.
  await save(path.join(f.prepared.recording.root, "recording-projects.json"), {});
  await assert.rejects(readTestContourStatus({ root: f.root }), /identity mismatch/);
});

test("canonical adoption then recording refresh replace two release identities and preserve pending owners", {  }, async (t) => {
  const f = await fixture(t);
  const originalPreparedHashes = await Promise.all(["journal.sqlite", "runtime.sqlite", "message-command-ledger.sqlite"].map((name) => hash(path.join(f.prepared.root, "data", name))));
  f.root = path.join(f.temporaryRoot, "canonical-contour");
  await installTestContour({ root: f.root, run: async () => {} });
  await mkdir(path.join(f.root, "data"));
  await writeFile(path.join(f.root, "data", "legacy-sentinel"), "old contour survives preparation");
  const paths = testContourPaths(f.root);
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const marker = await json(paths.markerFile);
  let generation = 0;
  const states = [];
  // PID liveness alone cannot identify a terminated child after PID reuse.
  // Observe exact spawned child handles; retain all existing liveness assertions.
  const children = [], originalSpawn = childProcess.spawn, originalKill = process.kill, liveness = new Map();
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, childProcess, args);
    const rootIndex = Array.isArray(args[1]) ? args[1].indexOf("--root") : -1;
    const observation = { pid: child.pid, executable: path.basename(String(args[0])),
      ownedManager: rootIndex >= 0 && args[1][rootIndex + 1] === f.root, exit: null, closed: false };
    children.push(observation);
    child.once("exit", (code, signal) => { observation.exit = { code, signal }; });
    child.once("close", () => { observation.closed = true; });
    return child;
  };
  process.kill = function (pid, signal) {
    let observation;
    try {
      const result = Reflect.apply(originalKill, process, arguments);
      observation = { alive: true }; return result;
    } catch (error) {
      observation = { alive: error.code === "EPERM", code: error.code }; throw error;
    } finally {
      if (signal === 0 && states.some(state => state.managerPid === pid || state.runtimePid === pid)) {
        liveness.set(pid, { pid, queries: (liveness.get(pid)?.queries ?? 0) + 1, ...observation });
      }
    }
  };
  syncBuiltinESMExports();
  let primaryError = null;
  const identities = () => states.map(state => ({ releaseId: state.releaseId, operationId: state.operationId,
    managerPid: state.managerPid, runtimePid: state.runtimePid,
    managerAlive: processIsAlive(state.managerPid), runtimeAlive: processIsAlive(state.runtimePid) }));

  const assertOwners = async () => {
    const state = await readRuntimeState(paths.dataDir);
    const queued = state.queuedInputs.find((item) => item.clientUserMessageId === messageId);
    for (const key of ["id", "clientUserMessageId", "threadId", "streamId", "workspaceId", "projectRoot", "paused"]) {
      assert.equal(queued[key], f.item[key], key);
    }
    assert.deepEqual(queued.input, f.item.input);
    const receipt = state.desktopMessageReceipts.find((entry) => entry.clientUserMessageId === messageId);
    for (const key of ["provider", "threadId", "clientUserMessageId", "fingerprint", "createdAt"]) assert.equal(receipt[key], f.receipt[key], key);
    for (const key of ["id", "accepted", "queued", "pending", "deferred", "dispatching", "paused"]) assert.equal(receipt.result[key], f.receipt.result[key], key);
    const db = new DatabaseSync(path.join(paths.dataDir, "message-command-ledger.sqlite"), { readOnly: true });
    try {
      const command = db.prepare("SELECT client_user_message_id, fingerprint, state FROM message_commands WHERE client_user_message_id=?").get(messageId);
      assert.equal(command.fingerprint, f.receipt.fingerprint); assert.equal(command.state, "queued");
    } finally { db.close(); }
    const outboxFile = f.capture.manifest.queueFiles.directories.find((entry) => entry.name === "delivery-outbox").files[0].name;
    assert.deepEqual(await json(path.join(paths.dataDir, "delivery-outbox", outboxFile)), f.delivery);
  };
  const options = { root: f.root, entryFile: path.join(sourceRoot, "test-contour.mjs"), sourceRoot, port, refresh: true,
    prepareSource: async () => ({ sourceRoot, branch: "dev", headCommit: String(generation).repeat(40) }),
    // Packaging/Git/Windows compilation are outside this bounded acceptance. Each
    // distinct release entry executes the real Hub, manager, health and persistence.
    prepareCandidate: async ({ source }) => {
      const releaseId = `synthetic-recording-${generation}`;
      const releaseRoot = path.join(f.root, "releases", releaseId); await mkdir(releaseRoot, { recursive: true });
      await writeFile(path.join(releaseRoot, "agent-hub-main.mjs"),
        `// Owned synthetic release ${generation}\nawait import(${JSON.stringify(pathToFileURL(path.join(sourceRoot, "agent-hub-main.mjs")).href)});\n`);
      return { ...source, root: f.root, releaseId, releaseRoot, contourId: marker.id };
    },
    beforeCutover: async () => {
      if (generation === 1) assert.equal(await readFile(path.join(f.root, "data", "legacy-sentinel"), "utf8"), "old contour survives preparation");
      else await assertOwners();
      if (states.length) assert.equal((await json(path.join(f.root, "current.json"))).current, states[0].releaseId);
    },
  };
  try {
    for (generation = 1; generation <= 2; generation++) {
      const state = generation === 1
        ? await adoptRecordingTestContour({ ...options, preparedRoot: f.prepared.root })
        : await startTestContour(options);
      states.push(state);
      assert.equal(state.releaseId, `synthetic-recording-${generation}`);
      assert.equal(state.refreshOutcome, "refreshed");
      assert.equal(state.operation.status, "ready");
      assert.equal(state.health.testContourRuntime.pid, state.runtimePid);
      assert.equal(state.health.testContourRuntime.releaseId, state.releaseId);
      assert.equal(state.health.testContourRuntime.operationId, state.operationId);
      assert.equal(processIsAlive(state.runtimePid), true); assert.equal(processIsAlive(state.managerPid), true);
      const status = await readTestContourStatus({ root: f.root, expectedOperationId: state.operationId, expectedHeadCommit: String(generation).repeat(40) });
      assert.equal(status.status, "ready");
      const pointer = await json(path.join(f.root, "current.json"));
      assert.equal(pointer.current, state.releaseId); assert.equal(pointer.previous, states[generation - 2]?.releaseId ?? null);
      await callDesktopControl("snapshot", { compact: true }, { runtimeRoot: f.root, timeoutMs: 2000 });
      await assertOwners();
      if (generation === 1) {
        const adoption = await json(path.join(f.root, "test-contour-adoption.json"));
        assert.equal(adoption.phase, "committed");
        assert.equal(await readFile(path.join(f.root, "cohort-adoptions", adoption.id, "backup", "data", "legacy-sentinel"), "utf8"), "old contour survives preparation");
        // Reconcile a crash after exact ready but before the adoption receipt:
        // the following refresh must retain this newly written candidate data.
        await writeFile(path.join(f.root, "data", "after-ready-sentinel"), "candidate writes retained");
        adoption.phase = "activated";
        await save(path.join(f.root, "test-contour-adoption.json"), adoption);
      }
    }
    assert.notEqual(states[0].runtimePid, states[1].runtimePid);
    assert.notEqual(states[0].managerPid, states[1].managerPid);
    assert.notEqual(states[0].operationId, states[1].operationId);
    assert.equal(processIsAlive(states[0].runtimePid), false); assert.equal(processIsAlive(states[0].managerPid), false);
    for (const [name, expected] of f.rawHashes) assert.equal(await hash(path.join(f.capture.dataDirectory, name)), expected);
    assert.equal(await readFile(path.join(f.root, "data", "after-ready-sentinel"), "utf8"), "candidate writes retained");
    assert.equal((await json(path.join(f.root, "test-contour-adoption.json"))).phase, "committed");
    assert.deepEqual(await Promise.all(["journal.sqlite", "runtime.sqlite", "message-command-ledger.sqlite"].map((name) => hash(path.join(f.prepared.root, "data", name)))), originalPreparedHashes);
    await assert.rejects(readFile(paths.fakeCodexStateFile), { code: "ENOENT" });
  } catch (error) {
    primaryError = error; throw error;
  } finally {
    const beforeStop = identities();
    let afterStop = null, stopped = null;
    try {
      const result = await stopTestContour({ root: f.root });
      stopped = { stopped: result.stopped, reason: result.reason, recoveredFromLock: result.recoveredFromLock,
        runtimePid: result.runtimePid, state: result.state ? {
          releaseId: result.state.releaseId, operationId: result.state.operationId,
          managerPid: result.state.managerPid, runtimePid: result.state.runtimePid,
        } : null };
      afterStop = identities();
      for (const state of states) {
        assert.equal(processIsAlive(state.runtimePid), false);
        assert.equal(processIsAlive(state.managerPid), false);
      }
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], "Recording refresh and cleanup both failed");
      throw cleanupError;
    } finally {
      childProcess.spawn = originalSpawn;
      process.kill = originalKill;
      syncBuiltinESMExports();
      t.diagnostic(JSON.stringify({ stage: "recording-refresh-cleanup", primaryFailure: Boolean(primaryError),
        beforeStop, afterStop, stopped, children, lastLiveness: [...liveness.values()] }));
    }
  }
});

test("recording manager refuses missing, mismatched and overlapping protected launch identity", {  }, async (t) => {
  const f = await fixture(t);
  const keys = ["AGENT_HUB_RECORDING_MANAGER_ROOT", "AGENT_HUB_RECORDING_MANAGER_PRODUCTION_ROOT"];
  const previous = keys.map((key) => process.env[key]);
  let spawns = 0;
  const options = { root: f.root, spawnImpl: () => { spawns++; throw new Error("must not spawn"); } };
  try {
    process.env[keys[0]] = f.root;
    process.env[keys[1]] = path.join(f.temporaryRoot, "protected-production");
    await assert.rejects(serveTestContour(options), /identity is missing or mismatched/);
    await assert.rejects(serveTestContour({ ...options, protectedRuntimeRoot: "relative" }), /identity is missing or mismatched/);
    await assert.rejects(serveTestContour({ ...options, protectedRuntimeRoot: path.join(f.temporaryRoot, "wrong") }), /identity is missing or mismatched/);
    process.env[keys[1]] = f.root;
    await assert.rejects(serveTestContour({ ...options, protectedRuntimeRoot: f.root }), /overlaps protected path/);
    assert.equal(spawns, 0);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
