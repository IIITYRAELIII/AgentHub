import assert from "node:assert/strict";
import test from "node:test";

import { createTaskCatalogFinalizationComposition } from "../../src/composition/task-catalog-finalization-composition.mjs";

function fixture({ synchronize, recordCatalog, saveCatalog } = {}) {
  const events = [];
  const warnings = [];
  const requests = [];
  const entry = {
    provider: "codex", threadId: "thread-exact", projectRoot: "D:/catalog-fixture",
    title: "Current provider title", running: false,
  };
  const owner = createTaskCatalogFinalizationComposition({
    projects: [{ path: entry.projectRoot }],
    titleReconcileIntervalMs: 60_000,
    projectionProjectRoots: [entry.projectRoot],
    workLogUsageStore: {
      async synchronizeTaskTitlesAndProject(request) {
        requests.push(request);
        return synchronize?.(request);
      },
    },
    taskRuns: { bindStream() {}, forTask() { return null; }, values() { return []; } },
    savedLastTaskMessageRecord: () => null,
    deferredTaskMessageAtMs: () => 0,
    selectedTask: () => ({}),
    taskSyncStore: {
      async recordCatalog(catalog) { events.push(["record", catalog]); await recordCatalog?.(catalog); },
      async save() { events.push(["save"]); await saveCatalog?.(); },
    },
    logger: { warn(message) { warnings.push(message); } },
  });
  return { ...owner, events, warnings, requests, entries: () => [{ ...entry }] };
}

test("catalog persists after a delayed journal conflict and retries unchanged titles on the next refresh", async () => {
  let rejectProjection;
  const projection = new Promise((_resolve, reject) => { rejectProjection = reject; });
  let attempts = 0;
  const state = fixture({ synchronize: () => ++attempts === 1 ? projection : { projected: true } });
  const pending = state.finalize(state.entries());
  assert.equal(state.requests.length, 1);
  assert.deepEqual(state.events, []);
  rejectProjection(Object.assign(new Error("stale journal revision"), { code: "JOURNAL_PROJECTION_CONFLICT" }));
  const catalog = await pending;
  assert.equal(catalog[0].title, "Current provider title");
  assert.equal(state.events[0][1], catalog);
  assert.deepEqual(state.events.map(([kind]) => kind), ["record", "save"]);
  assert.equal(state.warnings.length, 1);

  await state.finalize(state.entries());
  assert.equal(attempts, 2, "deferred projection must keep unchanged titles dirty");
  assert.deepEqual(state.requests[1], state.requests[0]);
  await state.finalize(state.entries());
  assert.equal(attempts, 2, "successful projection clears the existing reconciliation marker");
  assert.equal(state.events.filter(([kind]) => kind === "record").length, 3);
});

test("catalog does not mask a non-projection failure in journal title persistence", async () => {
  const failure = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  const state = fixture({ synchronize: async () => { throw failure; } });
  await assert.rejects(state.finalize(state.entries()), (error) => error === failure);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.warnings, []);
});

test("deferred title projection remains dirty when the provider restores an earlier title", async () => {
  let attempts = 0;
  const state = fixture({ synchronize: async () => {
    if (++attempts === 2) throw Object.assign(new Error("conflict"), { code: "JOURNAL_PROJECTION_CONFLICT" });
    return { projected: true };
  } });
  await state.finalize(state.entries());
  await state.finalize([{ ...state.entries()[0], title: "Temporary renamed title" }]);
  await state.finalize(state.entries());
  assert.equal(attempts, 3);
  assert.deepEqual(state.requests[2].titles, state.requests[0].titles);
});

for (const boundary of ["recordCatalog", "saveCatalog"]) {
  test(`catalog ${boundary} failure still propagates after a deferred journal projection`, async () => {
    const failure = new Error("catalog persistence failed");
    const state = fixture({
      synchronize: async () => { throw Object.assign(new Error("conflict"), { code: "JOURNAL_PROJECTION_CONFLICT" }); },
      [boundary]: async () => { throw failure; },
    });
    await assert.rejects(state.finalize(state.entries()), (error) => error === failure);
    assert.equal(state.warnings.length, 1);
  });
}
