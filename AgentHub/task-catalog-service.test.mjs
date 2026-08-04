import assert from "node:assert/strict";
import test from "node:test";
import { TaskCatalogService } from "./task-catalog-service.mjs";

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
