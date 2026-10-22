import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RestartRequestService } from "../../src/application/restart-request-service.mjs";
import { createRuntimeRestartComposition } from "../../src/composition/runtime-restart-composition.mjs";
import { restartRequestProjection, restartUiProjection } from "../../src/domain/maintenance-operation.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { TaskDiffStore } from "../../src/infrastructure/persistence/task-diff-store.mjs";

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
