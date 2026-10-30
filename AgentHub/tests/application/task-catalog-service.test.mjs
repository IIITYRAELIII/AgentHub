import assert from "node:assert/strict";
import test from "node:test";
import { TaskCommandService } from "../../src/application/task-command-service.mjs";
import { TaskMetadataStore } from "../../src/application/task-metadata-store.mjs";
import { TaskCatalogService } from "../../src/application/task-catalog-service.mjs";

test("task catalog service preserves array identity and advances revision", async () => {
  let now = 100;
  const service = new TaskCatalogService({
    initialEntries: [{ id: "cached" }],
    cacheMs: 10,
    now: () => now,
    build: async () => [{ id: "live" }],
  });
  const reference = service.entries;
  service.invalidate();
  await service.refresh();
  assert.equal(service.entries, reference);
  assert.deepEqual(reference, [{ id: "live" }]);
  assert.equal(service.revision, 1);
  assert.equal(service.refreshedAt, 100);
});

test("task catalog service reports cache freshness and invalidation", async () => {
  let now = 100;
  const service = new TaskCatalogService({
    initialEntries: [{ id: "cached" }],
    cacheMs: 1_000,
    now: () => now,
    build: async () => [{ id: "live" }],
  });

  await service.refresh();
  assert.equal(service.stale, false);
  now = 1_100;
  assert.equal(service.stale, true);
  await service.refresh();
  service.invalidate();
  assert.equal(service.stale, true);
});

test("task catalog service caches and coalesces concurrent refreshes", async () => {
  let builds = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const service = new TaskCatalogService({
    cacheMs: 1_000,
    build: async () => {
      builds += 1;
      await blocked;
      return [{ builds }];
    },
  });
  const first = service.refresh();
  const second = service.refresh();
  assert.equal(service.refreshing, true);
  release();
  assert.equal(await first, await second);
  assert.equal(builds, 1);
  await service.refresh();
  assert.equal(builds, 1);
});

test("task catalog snapshot revision advances before and after a refresh", async () => {
  const service = new TaskCatalogService({
    initialEntries: [{ id: "cached" }],
    build: async () => [{ id: "fresh" }],
  });

  assert.equal(service.snapshotRevision, "0:0");
  service.invalidate();
  assert.equal(service.snapshotRevision, "0:1");
  await service.refresh();
  assert.equal(service.snapshotRevision, "1:1");
});

test("task catalog service rebuilds when invalidated during an in-flight refresh", async () => {
  let catalogSize = 1;
  let builds = 0;
  let releaseFirstBuild;
  let firstBuildStarted;
  const firstBuildBlocked = new Promise((resolve) => { releaseFirstBuild = resolve; });
  const firstBuildObserved = new Promise((resolve) => { firstBuildStarted = resolve; });
  const service = new TaskCatalogService({
    cacheMs: 10_000,
    build: async () => {
      builds += 1;
      const capturedSize = catalogSize;
      if (builds === 1) {
        firstBuildStarted();
        await firstBuildBlocked;
      }
      return Array.from({ length: capturedSize }, (_, index) => ({ id: index + 1 }));
    },
  });

  const first = service.refresh();
  await firstBuildObserved;
  catalogSize = 2;
  service.invalidate();
  const second = service.refresh();
  releaseFirstBuild();

  assert.deepEqual(await second, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await first, [{ id: 1 }, { id: 2 }]);
  assert.equal(builds, 2);
});

test("task catalog service force refresh bypasses cache and recovers after failure", async () => {
  let builds = 0;
  const service = new TaskCatalogService({
    initialEntries: [{ id: "cached" }],
    cacheMs: 10_000,
    build: async () => {
      builds += 1;
      if (builds === 1) throw new Error("provider unavailable");
      return [{ id: "recovered" }];
    },
  });
  await assert.rejects(() => service.refresh({ force: true }), /unavailable/u);
  assert.equal(service.refreshing, false);
  assert.deepEqual(service.entries, [{ id: "cached" }]);
  await service.refresh({ force: true });
  assert.deepEqual(service.entries, [{ id: "recovered" }]);
  assert.equal(service.revision, 1);
});


test("invalidated catalog refresh cannot revert an acknowledged exact Thread rename", async () => {
  const gate = () => Promise.withResolvers();
  const firstStarted = gate(), releaseFirst = gate(), nextStarted = gate(), releaseNext = gate();
  const target = { provider: "codex", threadId: "thread-second", projectRoot: "D:/fixture" };
  const selected = { ...target, threadId: "thread-first" };
  const metadata = new TaskMetadataStore();
  const initial = [{ ...selected, title: "First" }, { ...target, title: "New Workspace - Поток 1 1" }];
  let builds = 0, providerTitle = initial[1].title;
  const catalog = new TaskCatalogService({ initialEntries: structuredClone(initial), build: async () => {
    builds++;
    if (builds === 1) {
      const oldSnapshot = structuredClone(initial);
      firstStarted.resolve();
      await releaseFirst.promise;
      return oldSnapshot;
    }
    nextStarted.resolve();
    await releaseNext.promise;
    return initial.map(entry => entry.threadId === target.threadId
      ? { ...entry, title: metadata.pinnedTitle(target) } : { ...entry });
  } });
  const reference = catalog.entries;
  const same = (left, right) => left.provider === right.provider && left.threadId === right.threadId;
  const commands = new TaskCommandService({
    resolveTarget: async () => target,
    pinTitle: (provider, threadId, title) => metadata.pinTitle({ provider, threadId }, title),
    expectTitleConfirmation: (provider, threadId, title) => metadata.expectTitle({ provider, threadId }, title),
    renameCodexTask: async (threadId, title) => { assert.equal(threadId, target.threadId); providerTitle = title; },
    invalidateCatalog: () => catalog.invalidate(), runForTask: () => null,
    catalogEntries: () => catalog.entries, catalogEntryIsSelected: same,
    selection: { current: () => selected, setTitle: () => assert.fail("other selected Thread must not be renamed") },
    saveTitles: async () => {},
    saveState: async () => { releaseFirst.resolve(); await nextStarted.promise; },
    snapshot: async () => ({ selected, tasks: catalog.entries.map(entry => ({ ...entry, threadTitle: entry.title })) }),
  });
  const refreshing = catalog.refresh({ force: true });
  await firstStarted.promise;
  try {
    const renamed = await commands.rename({ ...target, title: "Desktop second exact" });
    assert.equal(providerTitle, "Desktop second exact");
    assert.equal(metadata.pinnedTitle(target), "Desktop second exact");
    assert.equal(metadata.pendingTitle(target), "Desktop second exact");
    assert.equal(renamed.renamedTitle, "Desktop second exact");
    assert.equal(renamed.selected.threadId, selected.threadId);
    assert.equal(renamed.tasks.find(entry => same(entry, target)).threadTitle, "Desktop second exact");
    assert.equal(catalog.entries, reference);
    assert.equal(catalog.entries.find(entry => same(entry, selected)).title, "First");
    assert.equal(catalog.revision, 0, "invalidated provider result must not be published while its replacement is pending");
  } finally {
    releaseFirst.resolve(); releaseNext.resolve(); await refreshing;
  }
  assert.equal(builds, 2);
  assert.equal(catalog.entries, reference);
  assert.equal(catalog.entries.find(entry => same(entry, target)).title, "Desktop second exact");
});
