import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStorageRetentionComposition } from "../../src/composition/storage-retention-composition.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";

test("dev/Contour/recording startup never constructs production cleanup owners", () => {
  const forbidden = new Proxy({}, { get() { throw new Error("production access forbidden"); } });
  for (const [environment, recording] of [[{}, false], [{ AGENT_HUB_RELEASE_ID: "r", AGENT_HUB_TEST_CONTOUR: "1" }, false],
    [{ AGENT_HUB_RELEASE_ID: "r" }, true]]) {
    assert.equal(createStorageRetentionComposition({ config: { testContourRecording: recording }, environment,
      taskGitWorkspaces: forbidden, health: forbidden, timers: forbidden, store: forbidden }), null);
  }
});

test("every installed user's startup schedules deferred ready work and periodic bounded cleanup", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-retention-composition-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new MaintenanceOperationStore({ dataDir });
  const schedules = [], sources = new Map();
  let ready = false, busy = false, listed = 0;
  const service = createStorageRetentionComposition({ config: { dataDir }, store,
    taskBoard: {}, taskGitWorkspaces: { storageRetentionOwner: () => ({ id: "test-owner",
      list: async () => { listed++; return { items: [], done: true }; },
      preview: async () => { throw new Error("no candidate"); }, prune: async () => { throw new Error("no candidate"); },
      reconcile: async () => { throw new Error("no intent"); } }) },
    releaseGitWorkspaces: { storageRetentionOwner: () => ({ id: "release-generation-transport",
      list: async () => ({ items: [], done: true }), preview: async () => { throw new Error("no candidate"); },
      prune: async () => { throw new Error("no candidate"); }, reconcile: async () => { throw new Error("no intent"); } }) },
    releaseOperations: {},
    timers: { schedule: (name, run, delay) => schedules.push({ name, run, delay }), clear: name => sources.set("cleared", name) },
    readReady: () => ready, readBusy: () => busy, isStopping: () => false,
    health: { setDiagnosticSource: (name, read) => sources.set(name, read) }, environment: {
      AGENT_HUB_RELEASE_ID: "updated-runtime", LOCALAPPDATA: path.join(dataDir, "local"), XDG_STATE_HOME: path.join(dataDir, "state") },
  });
  assert.equal(listed, 0, "constructing the installed runtime does no discovery");
  service.scheduleInitial();
  assert.equal(schedules[0].delay, 5000);
  await service.runOnce(); assert.equal(listed, 0);
  ready = true; busy = true;
  await service.runOnce(); assert.equal(listed, 0);
  busy = false;
  schedules[0].run(); await service.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listed, 1);
  assert.equal(sources.get("storageRetention")().state, "idle");
  assert.equal(schedules.at(-1).delay, 6 * 60 * 60_000);
  await service.close();
  assert.equal(sources.get("cleared"), "storage-retention");
});
