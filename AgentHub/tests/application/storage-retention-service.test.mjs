import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { StorageRetentionService } from "../../src/application/storage-retention-service.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { restartRequestProjection } from "../../src/domain/maintenance-operation.mjs";
import { runtimeDatabasePath } from "../../src/infrastructure/persistence/runtime-state-store.mjs";

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

test("SQLite contention waits for SAME retention intent without repeating artifact work", async t => {
  const f = await setup(t, { maxUnits: 1 });
  const writer = new DatabaseSync(runtimeDatabasePath(f.root));
  let held = false, timer;
  const attempts = [];
  const create = f.store.create.bind(f.store);
  f.store.create = input => {
    if (input.operationId !== "storage-retention:v1") attempts.push(input.operationId);
    return create(input);
  };
  const preview = f.owner.preview;
  f.owner.preview = async input => {
    const result = await preview(input);
    writer.exec("BEGIN IMMEDIATE"); held = true;
    timer = setTimeout(() => { writer.exec("COMMIT"); held = false; }, 50);
    return result;
  };
  const service = f.make();
  try {
    const result = await service.runApproved([{ ownerId: f.owner.id,
      candidate: { id: "a", cursor: "a" }, binding: { id: "a" } }]);
    assert.equal(result.removed, 1);
    assert.equal(f.calls.length, 1);
    assert.ok(attempts.length > 1);
    assert.ok(attempts.every(id => id === f.calls[0].operationId));
    const original = f.store.get(f.calls[0].operationId);
    assert.equal(original.status, "succeeded");
    assert.equal(original.metadata.result.status, "removed");
    assert.deepEqual(f.store.get("storage-retention:v1").metadata.pending, []);
  } finally {
    await service.close(); clearTimeout(timer);
    if (held) writer.exec("ROLLBACK");
    writer.close();
  }
});

test("SQLite settlement waits never replay effects and delayed admission rechecks release and lease", async t => {
  for (const mode of ["settlement", "release", "lease"]) {
    const f = await setup(t, { maxUnits: 1 });
    const writer = new DatabaseSync(runtimeDatabasePath(f.root));
    let held = false, timer, fenced = false, settlementAttempts = 0;
    const hold = () => {
      writer.exec("BEGIN IMMEDIATE"); held = true;
      timer = setTimeout(() => {
        writer.exec("COMMIT"); held = false;
        if (mode === "release") f.context.releaseId = "replacement";
        if (mode === "lease") fenced = true;
      }, 50);
    };
    const preview = f.owner.preview, prune = f.owner.prune;
    f.owner.preview = async input => {
      const result = await preview(input);
      if (mode !== "settlement") hold();
      return result;
    };
    f.owner.prune = async input => {
      const result = await prune(input);
      if (mode === "settlement") hold();
      return result;
    };
    const settle = f.store.settle.bind(f.store);
    f.store.settle = (...args) => { settlementAttempts++; return settle(...args); };
    f.lease.assertOwned = async () => { if (fenced) throw new Error("lost lease after SQL wait"); };
    const service = f.make();
    try {
      const attempt = service.runApproved([{ ownerId: f.owner.id,
        candidate: { id: "a", cursor: "a" }, binding: { id: "a" } }]);
      if (mode === "lease") {
        await assert.rejects(attempt, /lost lease after SQL wait/u);
        assert.equal(f.calls.length, 0);
      } else {
        const result = await attempt;
        assert.equal(f.calls.length, mode === "settlement" ? 1 : 0);
        if (mode === "settlement") {
          assert.equal(result.removed, 1);
          assert.ok(settlementAttempts > 1);
          assert.equal(f.store.get(f.calls[0].operationId).status, "succeeded");
        } else {
          assert.equal(result.removed, 0);
          const pending = f.store.get("storage-retention:v1").metadata.pending;
          assert.equal(pending.length, 1);
          const original = f.store.get(pending[0].operationId);
          assert.equal(original.metadata.admitted, true);
          assert.notEqual(original.status, "succeeded");
        }
      }
    } finally {
      await service.close().catch(() => {}); clearTimeout(timer);
      if (held) writer.exec("ROLLBACK");
      writer.close();
    }
  }
});

test("approved owner previews preserve discovery cursor and unrelated pending originals", async t => {
  const f = await setup(t, { maxUnits: 1 });
  f.owner.prune = async () => ({ status: "unknown", reason: "original-unknown" });
  await f.make().runOnce();
  const before = f.store.get("storage-retention:v1");
  const pending = before.metadata.pending[0].operationId;
  const original = f.store.get(pending);
  f.owner.list = async () => { throw new Error("approved cleanup must not discover more artifacts"); };
  f.owner.reconcile = async () => { throw new Error("unrelated original must remain untouched"); };
  f.owner.prune = async input => {
    assert.equal(input.candidate.id, "chosen");
    assert.ok(f.store.get("storage-retention:v1").metadata.pending.some(p => p.operationId === input.operationId));
    assert.equal(f.store.get(input.operationId).metadata.admitted, true);
    f.calls.push(input);
    return { status: "removed", logicalBytes: 23 };
  };
  await f.make().runApproved([{ ownerId: f.owner.id, candidate: { id: "chosen", cursor: "chosen" }, binding: { id: "chosen" } }]);
  assert.equal(f.calls.length, 1);
  const after = f.store.get("storage-retention:v1");
  assert.equal(after.metadata.cursor, before.metadata.cursor);
  assert.equal(after.metadata.ownerIndex, before.metadata.ownerIndex);
  assert.equal(after.metadata.cycle, before.metadata.cycle);
  assert.deepEqual(after.metadata.pending, before.metadata.pending);
  assert.deepEqual(f.store.get(pending), original);
});

test("approved cleanup refuses stale previews and preserves readiness and budget checks", async t => {
  const f = await setup(t, { maxUnits: 1 });
  const approval = { ownerId: f.owner.id, candidate: { id: "a", cursor: "a" }, binding: { id: "stale" } };
  const service = f.make();
  assert.throws(() => service.runApproved([]), /bounded nonempty/u);
  assert.throws(() => service.runApproved([approval, approval]), /bounded nonempty/u);
  assert.throws(() => service.runApproved([{ ...approval, ownerId: "foreign-owner" }]), /Invalid approved/u);
  await service.runApproved([approval]);
  assert.equal(f.calls.length, 0);
  assert.equal(service.status().reasons["approved-preview-changed"], 1);
  for (const blocked of [{ busy: true }, { isolated: true }, { ready: false }]) {
    const result = await f.make({ readContext: async () => ({ ...f.context, ...blocked }) }).runApproved([
      { ...approval, binding: { id: "a" } },
    ]);
    assert.equal(result.state, "deferred");
  }
  assert.equal(f.calls.length, 0);
});

test("approved lost reply reconciles SAME exact original and refuses a replacement binding", async t => {
  const f = await setup(t, { maxUnits: 1 });
  let effects = 0, reconciles = 0;
  f.owner.prune = async () => { effects++; return { status: "unknown", reason: "lost-reply" }; };
  const approval = { ownerId: f.owner.id, candidate: { id: "a", cursor: "a" }, binding: { id: "a" } };
  await f.make().runApproved([approval]);
  const original = f.store.get("storage-retention:v1").metadata.pending[0].operationId;
  f.owner.reconcile = async input => { reconciles++; assert.equal(input.operationId, original); return { status: "already-removed" }; };
  await f.make().runApproved([{ ...approval, binding: { id: "replacement" } }]);
  assert.equal(reconciles, 0);
  assert.equal(f.store.get(original).status, "reconciling");
  await f.make().runApproved([approval]);
  assert.equal(effects, 1);
  assert.equal(reconciles, 1);
  assert.equal(f.store.get(original).status, "succeeded");
  assert.equal(f.store.get(original).metadata.result.status, "already-removed");
  assert.deepEqual(f.store.get("storage-retention:v1").metadata.pending, []);
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

test("only explicit v1/v2 registry upgrades to v3 preserve pending original intents", async t => {
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
  const release = { ...other, id: "release-generation-transport", list: async () => ({ items: [], done: true }) };
  const upgraded = f.make({ owners: [f.owner, other, release] });
  assert.equal((await upgraded.runOnce()).removed, 1);
  const after = f.store.get("storage-retention:v1");
  assert.deepEqual(after.metadata.ownerIds, ["native-merge-transport", "runtime-release", "release-generation-transport"]);
  assert.equal(after.metadata.policyVersion, 3);
  assert.equal(after.metadata.pending[0].operationId, original);
  assert.equal(f.store.get(original).status, "reconciling");
  const rollback = await f.make().runOnce();
  assert.equal(rollback.reason, "retention-policy-incompatible");
  assert.equal(f.store.get("storage-retention:v1").revision, after.revision);
  f.store.transition(after.operationId, { metadata: { policyVersion: 99 } }, { expectedRevision: after.revision });
  assert.equal((await upgraded.runOnce()).reason, "retention-policy-incompatible");
});

test("a v2 runtime retirement in flight keeps its exact original child after the v3 append", async t => {
  const f = await setup(t);
  f.owner.id = "runtime-release";
  f.owner.prune = async () => ({ status: "unknown", reason: "still-original" });
  f.owner.reconcile = async () => ({ status: "unknown", reason: "still-original" });
  const native = { ...f.owner, id: "native-merge-transport", list: async () => ({ items: [], done: true }) };
  await f.make({ owners: [native, f.owner] }).runOnce();
  const parent = f.store.get("storage-retention:v1");
  f.store.transition(parent.operationId, { metadata: { policyVersion: 2 } }, { expectedRevision: parent.revision });
  const original = parent.metadata.pending[0].operationId;
  const release = { ...native, id: "release-generation-transport" };
  await f.make({ owners: [native, f.owner, release] }).runOnce();
  assert.equal(f.store.get("storage-retention:v1").metadata.policyVersion, 3);
  assert.ok(f.store.get("storage-retention:v1").metadata.pending.some(item => item.operationId === original));
  assert.equal(f.store.get(original).status, "reconciling");
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
