import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RestartRequestService } from "../../src/application/restart-request-service.mjs";
import { createRuntimeRestartComposition } from "../../src/composition/runtime-restart-composition.mjs";
import { restartRequestProjection, restartUiProjection } from "../../src/domain/maintenance-operation.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { TaskDiffStore } from "../../src/infrastructure/persistence/task-diff-store.mjs";
import { createCommandTraceComposition } from "../../src/composition/command-trace-composition.mjs";
import { createRuntimeRestartWiring } from "../../src/composition/runtime-restart-wiring-composition.mjs";
import { CommandTraceWorkerStore } from "../../src/infrastructure/persistence/command-trace-worker-store.mjs";
import { packageBindingDigest, packageDigest, packageDirectory, packageFile } from "../../src/infrastructure/filesystem/runtime-package-target.mjs";

test("restart composition records the original through its trace service and closes the composition worker", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "hub398-restart-trace-")));
  const databaseFile = path.join(root, "data", "traces.sqlite");
  const noop = async () => {};
  let reopened;
  let closed = false;
  const trace = createCommandTraceComposition({ databaseFile });
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "config.json"), "{}");
    await trace.initialize();
    const operationId = "exact-package-original";
    const dataDir = path.join(root, "data");
    const oldManifest = {
      releaseId: "trace-old", version: "2.0.4", publicVersion: "2.0.4",
      versionScheme: "semver-build-v1", releaseVersion: "2.0.4+build.17", buildNumber: 17,
    };
    const nextManifest = {
      ...oldManifest, releaseId: "trace-new", version: "2.0.5", publicVersion: "2.0.5",
      releaseVersion: "2.0.5+build.18", buildNumber: 18, publicationRevision: "a".repeat(40),
    };
    const pointerRaw = JSON.stringify({ current: oldManifest.releaseId });
    const oldRaw = JSON.stringify(oldManifest);
    await mkdir(path.join(root, "releases", oldManifest.releaseId), { recursive: true });
    await writeFile(path.join(root, "current.json"), pointerRaw);
    await writeFile(path.join(root, "releases", oldManifest.releaseId, "runtime-manifest.json"), oldRaw);
    const inputs = {};
    for (const [key, contents] of Object.entries({
      archive: "fixture-archive", descriptor: "{}", installer: "fixture-installer",
      runtimeManifest: JSON.stringify(nextManifest),
    })) {
      const file = path.join(root, `package-${key}`);
      await writeFile(file, contents);
      inputs[key] = await packageFile(file);
    }
    const binding = {
      operationId, runtimeRoot: root, dataDir,
      roots: { runtime: await packageDirectory(root), data: await packageDirectory(dataDir) },
      old: { releaseId: oldManifest.releaseId,
        currentSha256: packageDigest(pointerRaw), manifestSha256: packageDigest(oldRaw) },
      target: { releaseId: nextManifest.releaseId, version: nextManifest.releaseVersion,
        sourceCommit: nextManifest.publicationRevision, ...inputs },
    };
    const store = new MaintenanceOperationStore({ dataDir });
    const request = store.create({ operationId, kind: "restart",
      streamId: "agent-hub-runtime", threadId: "agent-hub-runtime",
      status: "running", phase: "running",
      metadata: { packageHandoff: { schema: 1, binding, sha256: packageBindingDigest(binding) } },
    });
    let blocked = true;
    const wiring = createRuntimeRestartWiring({
      taskRuns: { values: () => [] }, agentProviders: {},
      runCoordinator: { hasPendingAdmission: () => blocked },
      backgroundJobs: { activeSize: 0 }, streamMaintenance: { activeCount: () => 0 },
      getRestartRequest: () => request, isStopping: () => false,
      restartRequestService: { canPerform: () => true },
      runtimeRestart: {
        getRestartRequest: () => request, updateOffset: () => 0,
        isStopping: () => false, beginStopping: () => false,
        setWaiting: noop, setStopping: noop, updateRestartMessage: noop, saveState: noop,
        stopRuntimeTimers: noop, stopCodexAppServerTree: noop,
        maintenanceOperations: store,
        commandTrace: { ...trace, close: async () => { await trace.close(); closed = true; } },
        workLogUsageStore: { close: noop }, rateLimitHistoryStore: { close: noop },
        taskSyncStore: { close: noop }, workspaceCatalogStore: { close: noop },
        taskReadStateStore: { close: noop }, runtimeStateStore: { close: noop },
      },
    });
    assert.equal(wiring.restartBlockingWorkCount(), 1);
    blocked = false;
    assert.equal(wiring.restartBlockingWorkCount(), 0);
    assert.equal((await wiring.performRestart()).status, "ignored");
    assert.equal((await wiring.runtimeResources.finalize()).ok, true);
    assert.equal(closed, true);
    assert.equal(trace.store.stats().workerRunning, false);
    reopened = new CommandTraceWorkerStore({ databaseFile });
    const spans = await reopened.readCommandTimeline(request.operationId);
    assert.deepEqual(spans.filter(span => span.stage === "restart-readiness").map(span => span.outcome), ["waiting", "ready"]);
    assert.deepEqual(spans.filter(span => span.stage === "restart-package-backup-preflight").map(span => span.outcome), ["started", "succeeded"]);
    assert.ok(spans.find(span => span.stage === "restart-package-backup-preflight" && span.outcome === "succeeded").monotonicDurationMs >= 0);
  } finally {
    await trace.close(); await reopened?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the existing restart drain persists the latest remembered diff before replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"hub315-drain-"));
  const filePath = path.join(root,"diffs.json");
  const noop = async()=>{};
  const taskDiffs = new TaskDiffStore({filePath});
  try {
    await taskDiffs.set("one","old");
    taskDiffs.remember("one","last");
    taskDiffs.remember("two","independent");
    const {runtimeResources} = createRuntimeRestartComposition({
      taskDiffs,journalStartupReady:Promise.resolve(),
      stopCodexAppServerTree:noop,
      getRestartRequest:()=>null,updateOffset:()=>0,hasBlockingWork:()=>false,
      setWaiting:noop,updateRestartMessage:noop,saveState:noop,
      beginStopping:()=>true,stopRuntimeTimers:noop,
      runtimeStateCoordinator:{flush:noop},
      telegramDeliveryService:{waitForBindingWrites:noop},
      mediaController:{waitForWrites:noop}, taskSyncStore:{save:noop},
      deliveryOutbox:{waitForIdle:noop}, backgroundJobStore:{waitForWrites:noop},
      failedUpdateStore:{waitForWrites:noop},
    });
    await runtimeResources.drain();
    const reopened = new TaskDiffStore({filePath}); await reopened.load();
    assert.equal(reopened.get("one"),"last");
    assert.equal(reopened.get("two"),"independent");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("deferred restart recovery settles durable cutover before readiness and permits a new request", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-restart-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new MaintenanceOperationStore({ dataDir: directory });
  const target = { streamId: "stream-exact", threadId: "thread-exact" };
  const operation = store.create({
    kind: "restart", ...target, status: "running", phase: "cutover",
  });
  let request = restartRequestProjection(operation);
  const getRequest = () => request;
  const setRequest = (value) => { request = value; };
  const noop = async () => {};
  const events = [];
  const service = new RestartRequestService({
    operationStore: store,
    currentTarget: () => target,
    getRequest, setRequest,
    blockingWorkCount: () => 0,
    currentChatId: () => null,
    updateOffset: () => 0,
    processingUpdateId: () => null,
    saveState: noop,
    announceDesktop: noop,
    sendTelegram: noop,
    performRestart: noop,
    scheduleRestart: () => {},
  });
  const { runtimeRestart } = createRuntimeRestartComposition({
    getRestartRequest: getRequest,
    setRestartRequest: setRequest,
    failRestartOperation: (error) => service.fail(undefined, error),
    saveState: noop,
    updateOffset: () => 0,
    hasBlockingWork: () => false,
    setWaiting: (value) => service.setWaiting(value),
    isStopping: () => false,
    setStopping: () => {},
    beginStopping: () => true,
    stopRuntimeTimers: () => {},
    stopCodexAppServerTree: noop,
    runtimeCommandServer: { start: noop },
    hubMcpServer: { start: noop },
    desktopControlServer: () => ({ start: noop }),
    miniAppLifecycle: { start: noop },
    instanceGuard: {
      acquire: async () => events.push("lock"),
      markReady: async () => {
        assert.equal(store.get(operation.operationId).status, "failed");
        assert.equal(request, null);
        events.push("ready");
      },
    },
    isCodex: () => false,
    taskRuns: { values: () => [] },
    runRecovery: { recoverAll: noop },
    updateRestartMessage: async () => {
      assert.equal(request.operationId, operation.operationId);
      events.push("message");
    },
    startRuntimeTimers: () => {
      assert.equal(events.at(-1), "ready");
      events.push("timers");
    },
  });

  // Deferred cutover bypasses RestartRequestService.#perform; recovery must own settlement.
  await runtimeRestart.recoverPrevious(new Error("replacement did not acquire lock"), { lockReleased: true });

  const reopenedStore = new MaintenanceOperationStore({ dataDir: directory });
  const recovered = reopenedStore.get(operation.operationId);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.outcome, "failed");
  assert.equal(recovered.metadata.error, "replacement did not acquire lock");
  assert.deepEqual(recovered.blockers, []);
  assert.equal(restartUiProjection(recovered).pending, false);
  assert.equal(reopenedStore.activeFor({ kind: "restart", ...target }), null);
  assert.deepEqual(events, ["lock", "message", "ready", "timers"]);
  const next = await service.fromDesktop();
  assert.equal(next.accepted, true);
  assert.notEqual(next.operationId, operation.operationId);
  assert.equal(reopenedStore.get(operation.operationId).revision, recovered.revision);
});
