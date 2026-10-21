import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RETIRED_RUNTIMES, runtimePointerTransition, runtimeRetirementCandidates, runtimeRollbackPointer } from "../../../src/infrastructure/filesystem/runtime-release-retention-policy.mjs";

const identity = n => ({ releaseId: `runtime-${n}`, manifestSha256: "a".repeat(64),
  root: { dev: "1", ino: String(n), birthFileTime: String(10000 + n) } });
const select = (pointer, n) => runtimePointerTransition({ pointer, installed: identity(n), now: "2026-10-21T00:00:00Z" }).pointer;

test("legacy IDs do not become deletion authority; first selected and rollback bindings are retained", () => {
  const first = select({ current: "legacy-current", previous: "legacy-rollback" }, 1);
  assert.equal(first.previous, "legacy-current");
  assert.deepEqual(first.runtimeRetention.retired, []);
  assert.equal(first.runtimeRetention.previous, null);
  const second = select(first, 2);
  assert.equal(second.runtimeRetention.previous.releaseId, "runtime-1");
  assert.deepEqual(second.runtimeRetention.retired, []);
  const third = select(second, 3);
  assert.deepEqual(third.runtimeRetention.retired.map(r => r.releaseId), ["runtime-1"]);
});

test("reinstall preserves rollback; rollback swaps exact known bindings", () => {
  const pointer = select(select({}, 1), 2);
  const repair = select(pointer, 2);
  assert.equal(repair.previous, "runtime-1");
  assert.deepEqual(repair.runtimeRetention.retired, []);
  const rollback = runtimeRollbackPointer({ pointer: repair });
  assert.equal(rollback.current, "runtime-1");
  assert.equal(rollback.runtimeRetention.current.releaseId, "runtime-1");
  assert.equal(rollback.runtimeRetention.previous.releaseId, "runtime-2");
});

test("rollback to an unbound legacy version preserves it without disabling future known custody", () => {
  const first = select({ current: "legacy", previous: "older" }, 1);
  const rollback = runtimeRollbackPointer({ pointer: first });
  assert.equal(rollback.current, "legacy");
  assert.equal(rollback.runtimeRetention.current, null);
  assert.equal(rollback.runtimeRetention.previous.releaseId, "runtime-1");
  const second = select(rollback, 2);
  assert.equal(second.previous, "legacy");
  assert.deepEqual(second.runtimeRetention.retired.map(r => r.releaseId), ["runtime-1"]);
  assert.equal(second.runtimeRetention.retired.some(r => r.releaseId === "legacy"), false);
  assert.deepEqual(runtimeRetirementCandidates({ pointer: second }).candidates.map(r => r.releaseId), ["runtime-1"]);
});

test("current, rollback, running and prepared/source pins exclude retired candidates", () => {
  let pointer = {};
  for (let i = 1; i <= 5; i++) pointer = select(pointer, i);
  const result = runtimeRetirementCandidates({ pointer, runningReleaseId: "runtime-1", pinnedReleaseIds: ["runtime-2"] });
  assert.deepEqual(result.candidates.map(r => r.releaseId), ["runtime-3"]);
  assert.deepEqual(result.kept.sort(), ["runtime-1", "runtime-2", "runtime-4", "runtime-5"]);
});

test("unfamiliar/corrupt custody is preserved and never authorizes cleanup", () => {
  const pointer = { current: "old", previous: "older", futureOwner: { original: "must remain" }, runtimeRetention: { version: 99, useful: "original custody" } };
  const transition = runtimePointerTransition({ pointer, installed: identity(1) });
  assert.equal(transition.deferred, "unknown-runtime-retention");
  assert.deepEqual(transition.pointer.runtimeRetention, pointer.runtimeRetention);
  assert.deepEqual(transition.pointer.futureOwner, pointer.futureOwner);
  assert.deepEqual(runtimeRetirementCandidates({ pointer: transition.pointer }).candidates, []);
});

test("reselecting a retired exact release preserves it and does not duplicate authority", () => {
  let pointer = {};
  for (let i = 1; i <= 4; i++) pointer = select(pointer, i);
  pointer = select(pointer, 1);
  assert.equal(pointer.current, "runtime-1");
  assert.equal(pointer.previous, "runtime-4");
  assert.equal(pointer.runtimeRetention.retired.some(r => r.releaseId === "runtime-1"), false);
});

test("queue capacity defers new retirement without deleting legacy/unproven payload", () => {
  let pointer = {};
  for (let i = 1; i <= MAX_RETIRED_RUNTIMES + 2; i++) pointer = select(pointer, i);
  const next = runtimePointerTransition({ pointer, installed: identity(1000), now: "2026-10-21T00:00:00Z" });
  assert.equal(next.deferred, "runtime-retirement-queue-full");
  assert.equal(next.pointer.runtimeRetention.retired.length, MAX_RETIRED_RUNTIMES);
});

test("reselecting a retired ID cannot replace custody or revive partial deletion", () => {
  let pointer = {};
  for (let i = 1; i <= 4; i++) pointer = select(pointer, i);
  const original = structuredClone(pointer);
  assert.throws(() => runtimePointerTransition({ pointer,
    installed: { ...identity(1), root: { ...identity(1).root, ino: "999999" } } }), /identity changed/u);
  pointer.runtimeRetention.retired[0].operationId = "original-maintenance-intent";
  pointer.runtimeRetention.retired[0].phase = "pruning";
  assert.throws(() => select(pointer, 1), /Partially retired/u);
  assert.deepEqual(pointer.runtimeRetention.retired[0].root, original.runtimeRetention.retired[0].root);
});
