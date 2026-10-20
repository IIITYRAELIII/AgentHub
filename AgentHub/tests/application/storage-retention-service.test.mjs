import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageRetentionService } from "../../src/application/storage-retention-service.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { restartRequestProjection } from "../../src/domain/maintenance-operation.mjs";

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-retention-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MaintenanceOperationStore({ dataDir: root });
  const lease = { assertOwned: async () => {} };
  const context = { ready: true, releaseId: "new-release", isolated: false };
  const calls = [];
  const owner = {
    id: "fixture-owner",
    list: async ({ after, limit }) => ({ items: ["a", "b", "c", "d"].filter(id => !after || id > after)
      .slice(0, limit).map(id => ({ id, cursor: id })), done: false }),
    preview: async ({ candidate }) => ({ status: "eligible", binding: { id: candidate.id } }),
    prune: async input => {
      const child = store.get(input.operationId);
      const parent = store.get("storage-retention:v1");
      assert.equal(child.metadata.admitted, true);
      assert.ok(parent.metadata.pending.some(p => p.operationId === input.operationId));
      assert.equal(restartRequestProjection(child), null);
      calls.push(input);
      return { status: "removed", logicalBytes: 17 };
    },
    reconcile: async () => ({ status: "already-removed" }),
  };
  const make = extra => new StorageRetentionService({ store, owners: [owner], readContext: async () => context,
    withLease: async fn => fn(lease), ...options, ...extra });
  return { root, store, context, owner, calls, make, lease };
}

test("after-ready work is bounded, durable before effect, and has no restart projection", async t => {
  const f = await setup(t);
  const service = f.make();
  const result = await service.runOnce();
  assert.equal(f.calls.length, 3);
  assert.equal(result.removed, 3);
  assert.equal(result.logicalBytes, 51);
  assert.equal(result.more, true);
  assert.deepEqual(f.store.get("storage-retention:v1").metadata.pending, []);
  assert.equal(service.status().removed, 3);
  assert.equal(f.store.activeFor({ kind: "restart", streamId: "agent-hub-runtime", threadId: "agent-hub-runtime" }), null);
});

test("known partial batches continue SAME admitted child and keep observations distinct from completion", async t => {
  const f = await setup(t, { maxUnits: 1 });
  let original, effects = 0;
  f.owner.prune = async input => { original = input.operationId; effects++; return { status: "partial", files: 64, logicalBytes: 100 }; };
  f.owner.reconcile = async input => {
    assert.equal(input.operationId, original);
    return { status: "removed", logicalBytes: 3 };
  };
  const service = f.make();
  const partial = await service.runOnce();
  assert.equal(partial.partialBatches, 1);
  assert.equal(partial.removed, 0);
  assert.equal(partial.pending, 1);
  assert.equal(f.store.get(original).phase, "partial");
  assert.equal(f.store.get(original).metadata.lastObservation.files, 64);
  const complete = await service.runOnce();
  assert.equal(complete.removed, 1);
  assert.equal(complete.logicalBytes, 103);
  assert.equal(effects, 1);
  assert.equal(f.store.get(original).status, "succeeded");
});

test("only the explicit v1 native-transport to v2 runtime-owner append preserves pending original intents", async t => {
  const f = await setup(t);
  f.owner.id = "native-merge-transport";
  f.owner.list = async () => ({ items: [{ id: "a", cursor: "a" }], done: true });
  f.owner.prune = async () => ({ status: "unknown", reason: "pending-original" });
  f.owner.reconcile = async () => ({ status: "unknown", reason: "pending-original" });
  await f.make().runOnce();
  const before = f.store.get("storage-retention:v1");
  const original = before.metadata.pending[0].operationId;
  f.owner.list = async () => ({ items: [], done: true });
  const other = { ...f.owner, id: "runtime-release",
    list: async () => ({ items: [{ id: "runtime", cursor: "runtime" }], done: true }),
    prune: async () => ({ status: "removed" }) };
  const upgraded = f.make({ owners: [f.owner, other] });
  assert.equal((await upgraded.runOnce()).removed, 1);
  const after = f.store.get("storage-retention:v1");
  assert.deepEqual(after.metadata.ownerIds, ["native-merge-transport", "runtime-release"]);
  assert.equal(after.metadata.policyVersion, 2);
  assert.equal(after.metadata.pending[0].operationId, original);
  assert.equal(f.store.get(original).status, "reconciling");
  const rollback = await f.make().runOnce();
  assert.equal(rollback.reason, "retention-policy-incompatible");
  assert.equal(f.store.get("storage-retention:v1").revision, after.revision);
  f.store.transition(after.operationId, { metadata: { policyVersion: 99 } }, { expectedRevision: after.revision });
  assert.equal((await upgraded.runOnce()).reason, "retention-policy-incompatible");
});

test("unready, isolated and stopping contexts never initialize retention state", async t => {
  const f = await setup(t);
  for (const context of [{ ready: false }, { isolated: true }, { releaseId: null }]) {
    await f.make({ readContext: async () => ({ ...f.context, ...context }) }).runOnce();
    assert.equal(f.store.get("storage-retention:v1"), null);
  }
  await f.make({ isStopping: () => true }).runOnce();
  assert.equal(f.store.get("storage-retention:v1"), null);
  assert.equal(f.calls.length, 0);
});

test("crash after artifact effect reconciles SAME operation while other owners progress", async t => {
  const f = await setup(t, { maxUnits: 2 });
  let original;
  f.owner.prune = async input => {
    if (input.candidate.id === "a") { original = input.operationId; throw new Error("lost after effect"); }
    f.calls.push(input); return { status: "retained", reason: "active-artifact" };
  };
  await f.make().runOnce();
  assert.equal(f.store.get(original).status, "reconciling");
  const reconcile = [];
  f.owner.reconcile = async input => { reconcile.push(input.operationId); return { status: "already-removed" }; };
  const restored = new MaintenanceOperationStore({ dataDir: f.root });
  await f.make({ store: restored }).runOnce();
  assert.deepEqual(reconcile, [original]);
  assert.equal(restored.get(original).status, "succeeded");
  assert.deepEqual(f.calls.map(c => c.candidate.id), ["b", "c"]);
  assert.deepEqual(restored.get("storage-retention:v1").metadata.pending, []);
});

test("one unknown result cannot starve another artifact owner", async t => {
  const f = await setup(t, { maxUnits: 2 });
  f.owner.list = async () => ({ items: [{ id: "a", cursor: "a" }], done: true });
  f.owner.prune = async () => ({ status: "unknown", reason: "lost-receipt" });
  f.owner.reconcile = async () => { throw new Error("still unknown"); };
  const other = { ...f.owner, id: "other", prune: async input => { f.calls.push(input); return { status: "removed" }; } };
  const service = f.make({ owners: [f.owner, other] });
  await service.runOnce();
  assert.equal(f.calls.length, 1);
  await service.runOnce();
  assert.equal(f.calls.length, 1, "an admitted unknown is reconciled, never replayed");
  assert.equal(service.status().pending, 1);
});

test("update and periodic cycles repeat preview but do not repeat a removed artifact effect", async t => {
  const f = await setup(t);
  let time = Date.parse("2026-10-21T00:00:00Z");
  const removed = new Set();
  f.owner.list = async () => ({ items: [{ id: "a", cursor: "a" }], done: true });
  const prune = f.owner.prune;
  f.owner.prune = async input => { removed.add(input.candidate.id); return prune(input); };
  f.owner.preview = async ({ candidate }) => removed.has(candidate.id)
    ? { status: "retained", reason: "absent" } : { status: "eligible", binding: { id: candidate.id } };
  const make = () => f.make({ now: () => new Date(time) });
  await make().runOnce();
  await make().runOnce();
  f.context.releaseId = "updated-release";
  await make().runOnce();
  time += 7 * 60 * 60_000;
  await make().runOnce();
  assert.equal(f.calls.length, 1);
});

test("release drift during preview, elapsed budget and lost lease prevent artifact effect", async t => {
  for (const mode of ["release", "budget", "lease"]) {
    const f = await setup(t);
    let clock = 0, fenced = false;
    f.owner.preview = async () => {
      if (mode === "release") f.context.releaseId = "replacement";
      if (mode === "budget") clock = 30_000;
      if (mode === "lease") fenced = true;
      return { status: "eligible", binding: { exact: true } };
    };
    f.lease.assertOwned = async () => { if (fenced) throw new Error("lost lease"); };
    await f.make({ clock: () => clock }).runOnce().catch(error => assert.match(error.message, /lost lease/u));
    assert.equal(f.calls.length, 0);
  }
});

test("coalesced run and shutdown wait for in-flight owner; stop admits no next artifact", async t => {
  const f = await setup(t);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.owner.prune = async input => { f.calls.push(input); entered(); await gate; return { status: "removed" }; };
  const service = f.make();
  const first = service.runOnce();
  assert.equal(service.runOnce(), first);
  await ready;
  let closed = false;
  const close = service.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  release(); await close; await first;
  assert.equal(f.calls.length, 1);
});
