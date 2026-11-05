import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-persistence-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const observations = [], counts = { compose: 0, validate: 0, publish: 0, finalize: 0 };
  const store = new ReleaseOperationStore({ dataDir: root, recordPersistence: value => observations.push(value) });
  const generation = (ids = ["task-a"]) => ({ repositoryBases: [{ repositoryRoot: root, baseCommit: "base" }],
    selectedResults: ids.map(taskId => ({ taskId, resultCommit: `${taskId}-result`, acceptanceRevision: 2 })),
    candidates: [{ repositoryRoot: root, releaseRoot: path.join(root, "candidate"),
      commit: "candidate", tree: "tree", manifestHash: "manifest" }] });
  const service = new ReleaseOperationService({ store, processAlive: pid => pid === process.pid,
    ownerId: "persistence-owner", retryDelayMs: 1000,
    compose: async () => { counts.compose++; return generation(); },
    validate: async () => { counts.validate++; return { status: "passed" }; },
    publishTarget: async () => { counts.publish++; return { status: "applied" }; },
    readTarget: async () => ({ status: "not_applied" }),
    finalize: async () => { counts.finalize++; return { status: "completed" }; }, ...options });
  const start = () => service.start({ requestId: "same-original", workspaceId: "workspace", streamId: "stream",
    threadId: "thread", authorization: { taskIds: ["task-a"], validationMode: "full",
      approvedTargets: [{ targetId: "target", kind: "git", repositoryRoot: root }] } });
  return { root, store, service, start, generation, observations, counts };
}

test("stage persistence retries real SQLite busy without repeating validation", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  const f = await fixture(t);
  const ack = f.start();
  const blocker = new DatabaseSync(path.join(f.root, "runtime.sqlite"));
  let unlock;
  f.service.validate = async () => {
    f.counts.validate++;
    blocker.exec("BEGIN IMMEDIATE");
    unlock = setTimeout(() => blocker.exec("ROLLBACK"), 80);
    return { status: "passed", evidence: "same validation" };
  };
  try {
    const snapshot = await f.service.drain(ack.operationId);
    assert.equal(snapshot.operation.state, "done");
    assert.deepEqual(f.counts, { compose: 1, validate: 1, publish: 1, finalize: 1 });
    assert.equal(snapshot.generations.length, 1);
    const validation = snapshot.receipts.filter(r => r.stepId === "validate");
    assert.equal(validation.length, 1);
    assert.equal(validation[0].status, "applied");
    assert.equal(snapshot.operation.requestId, "same-original");
    assert.equal(warnings.mock.callCount(), 0);
    const trace = f.observations.find(value => value.method === "finish-step" && value.step === "validate");
    assert.equal(trace.sqlitePrimaryCode, 5);
    assert.equal(trace.phase, "begin");
    assert.equal(trace.outcome, "succeeded");
    assert.ok(trace.attempts > 1);
  } finally {
    clearTimeout(unlock);
    try { blocker.exec("ROLLBACK"); } catch {}
    blocker.close();
  }
});

test("owned contention retry remains addressed work after queue exhaustion", async t => {
  t.mock.method(console, "warn", () => {});
  const f = await fixture(t);
  const mutate = f.store.runOperationMutation.bind(f.store);
  f.store.runOperationMutation = (id, callback, options) => mutate(id, callback, { ...options, timeoutMs: 30 });
  const ack = f.start();
  const blocker = new DatabaseSync(path.join(f.root, "runtime.sqlite"));
  let unlock;
  f.service.validate = async () => {
    f.counts.validate++;
    blocker.exec("BEGIN IMMEDIATE");
    unlock = setTimeout(() => blocker.exec("ROLLBACK"), 180);
    return { status: "passed" };
  };
  let resolved = false;
  try {
    const pending = f.service.drain(ack.operationId).then(value => { resolved = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(resolved, false);
    assert.equal(f.counts.publish, 0);
    const snapshot = await pending;
    assert.equal(snapshot.operation.state, "done");
    assert.equal(f.counts.validate, 1);
    assert.equal(snapshot.generations.length, 1);
    assert.deepEqual(new ReleaseOperationStore({ dataDir: f.root }).snapshot(ack.operationId), snapshot);
  } finally {
    clearTimeout(unlock);
    try { blocker.exec("ROLLBACK"); } catch {}
    blocker.close();
  }
});

test("drain retains an owned acquisition retry after the original worker unwinds", async t => {
  t.mock.method(console, "warn", () => {});
  const f = await fixture(t);
  const mutate = f.store.runOperationMutation.bind(f.store);
  f.store.runOperationMutation = (id, callback, options) => mutate(id, callback, { ...options, timeoutMs: 30 });
  const ack = f.start(), blocker = new DatabaseSync(path.join(f.root, "runtime.sqlite"));
  blocker.exec("BEGIN IMMEDIATE");
  const unlock = setTimeout(() => blocker.exec("ROLLBACK"), 160);
  let settled = false;
  try {
    const pending = f.service.drain(ack.operationId).then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false);
    assert.deepEqual(f.counts, { compose: 0, validate: 0, publish: 0, finalize: 0 });
    assert.equal((await pending).operation.state, "done");
    assert.deepEqual(f.counts, { compose: 1, validate: 1, publish: 1, finalize: 1 });
  } finally {
    clearTimeout(unlock); try { blocker.exec("ROLLBACK"); } catch {} blocker.close();
  }
});

for (const boundary of ["heartbeat", "reservation", "begin-step", "advance"]) {
  test(`publication ${boundary} retries only its real short SQLite closure`, async t => {
    t.mock.method(console, "warn", () => {});
    const f = await fixture(t), ack = f.start();
    const blocker = new DatabaseSync(path.join(f.root, "runtime.sqlite"));
    let held = false, unlock;
    const lock = () => {
      if (held) return;
      held = true; blocker.exec("BEGIN IMMEDIATE");
      unlock = setTimeout(() => blocker.exec("ROLLBACK"), 60);
    };
    if (boundary === "reservation") f.service.reservePublication = async ({ reserve }) => { lock(); return reserve(); };
    if (boundary === "heartbeat") {
      const heartbeat = f.store.heartbeat.bind(f.store);
      f.store.heartbeat = (id, ...args) => {
        if (f.store.get(id).state === "publish") lock();
        return heartbeat(id, ...args);
      };
    }
    if (boundary === "begin-step") {
      const begin = f.store.beginStep.bind(f.store);
      f.store.beginStep = input => { if (input.stepId.startsWith("publish:")) lock(); return begin(input); };
    }
    if (boundary === "advance") {
      const transition = f.store.transition.bind(f.store);
      f.store.transition = (id, patch, options) => { if (patch.state === "publish") lock(); return transition(id, patch, options); };
    }
    try {
      const snapshot = await f.service.drain(ack.operationId);
      assert.equal(held, true);
      assert.equal(snapshot.operation.state, "done");
      assert.deepEqual(f.counts, { compose: 1, validate: 1, publish: 1, finalize: 1 });
      assert.equal(snapshot.generations.length, 1);
      assert.equal(snapshot.receipts.filter(r => r.stepId.startsWith("publish:")).length, 1);
      assert.ok(f.observations.some(value => value.sqlitePrimaryCode === 5 && value.attempts > 1));
    } finally {
      clearTimeout(unlock); try { blocker.exec("ROLLBACK"); } catch {} blocker.close();
    }
  });
}

test("a changed owner epoch fences the delayed validation completion", async t => {
  t.mock.method(console, "warn", () => {});
  const f = await fixture(t), ack = f.start();
  const blocker = new DatabaseSync(path.join(f.root, "runtime.sqlite"));
  let unlock, foreign;
  f.service.validate = async () => {
    f.counts.validate++; blocker.exec("BEGIN IMMEDIATE");
    unlock = setTimeout(() => {
      blocker.exec("ROLLBACK");
      const old = f.store.get(ack.operationId).owner;
      f.store.release(ack.operationId, old);
      foreign = f.store.acquire(ack.operationId, "new-owner", { processId: process.pid }).operation.owner;
    }, 60);
    return { status: "passed" };
  };
  try {
    const snapshot = await f.service.drain(ack.operationId);
    assert.equal(snapshot.operation.state, "validate");
    assert.deepEqual(snapshot.operation.owner, foreign);
    assert.equal(snapshot.receipts.find(r => r.stepId === "validate").status, "intent");
    assert.equal(f.counts.validate, 1);
    assert.equal(f.counts.publish, 0);
  } finally {
    clearTimeout(unlock); try { blocker.exec("ROLLBACK"); } catch {} blocker.close();
  }
});

test("validator and failed receipt-settlement causes both survive", async t => {
  const f = await fixture(t);
  f.service.validate = async () => { throw Object.assign(new Error("original validator cause"), { code: "VALIDATOR_CAUSE" }); };
  const finish = f.store.finishStep.bind(f.store);
  f.store.finishStep = (receipt, options) => {
    if (receipt.stepId === "validate" && options.status === "failed") {
      throw Object.assign(new Error("separate settlement cause"), { code: "SETTLEMENT_CAUSE" });
    }
    return finish(receipt, options);
  };
  const ack = f.start(), snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "failed");
  assert.match(snapshot.operation.lastError.message, /original validator cause/u);
  assert.match(snapshot.operation.lastError.message, /separate settlement cause/u);
  assert.equal(snapshot.receipts.find(r => r.stepId === "validate").status, "intent");
  assert.equal(f.counts.publish, 0);
  const diagnostic = f.observations.find(value => value.method === "finish-step" && value.step === "validate");
  assert.equal(diagnostic.causeCode, "VALIDATOR_CAUSE");
  assert.equal(diagnostic.errorCode, "SETTLEMENT_CAUSE");
});

test("addressed drain uses effective amended membership and ignores removed membership", async t => {
  const f = await fixture(t);
  f.service.validate = async () => { throw Object.assign(new Error("correct before publishing"), { code: "RELEASE_VALIDATION_FAILED" }); };
  const ack = f.start();
  const waiting = await f.service.drain(ack.operationId);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.service.compose = async () => f.generation(["task-b"]);
  f.service.validate = async () => { entered(); await gate; return { status: "passed" }; };
  f.service.withTaskSelection = async ({ taskIds, commit }) => commit(f.generation(taskIds).selectedResults, async () => {});
  const amended = await f.service.continue(ack.operationId, { requestId: "explicit-amended-membership",
    taskIds: ["task-b"], expectedRevision: waiting.operation.revision, expectedGeneration: 1 });
  assert.equal(amended.accepted, true);
  await ready;
  let addedSettled = false;
  const pending = f.service.drainAddressed({ taskId: "task-b" }).then(() => { addedSettled = true; });
  try {
    await f.service.drainAddressed({ taskId: "task-a" });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(addedSettled, false);
  } finally { release(); }
  await pending;
  assert.equal(f.store.get(ack.operationId).state, "done");
});

test("persistence diagnostics exclude exception messages and malformed codes", async t => {
  const f = await fixture(t), marker = "private-token-and-file-content";
  await assert.rejects(f.store.runOperationMutation("diagnostic-original", () => {
    throw Object.assign(new Error(marker), { code: "C:/secret/path" });
  }));
  assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].errorCode, "RELEASE_PERSISTENCE_ERROR");
  assert.equal(JSON.stringify(f.observations).includes(marker), false);
  assert.equal(JSON.stringify(f.observations).includes("C:/"), false);
});

for (const boundary of ["publish", "done", "reservation", "target-effect"]) {
  test(`lost committed ${boundary} reply reads the same transition without duplicate outbox`, async t => {
    const f = await fixture(t), transition = f.store.transition.bind(f.store);
    let lost = false;
    f.store.transition = (id, patch, options) => {
      const result = transition(id, patch, options);
      const matches = boundary === "reservation" ? Boolean(patch.publicationEffects?.publishStarted)
        : boundary === "target-effect" ? options?.eventKind === "operation.target-published"
        : patch.state === boundary;
      if (!lost && result.applied && matches) {
        lost = true;
        throw Object.assign(new Error("controlled lost commit reply"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      }
      return result;
    };
    const ack = f.start(), snapshot = await f.service.drain(ack.operationId);
    assert.equal(lost, true);
    assert.equal(snapshot.operation.state, "done");
    assert.deepEqual(f.counts, { compose: 1, validate: 1, publish: 1, finalize: 1 });
    assert.equal(snapshot.events.filter(e => e.eventKind === "operation.completed").length, 1);
    assert.equal(snapshot.events.filter(e => e.eventKind === "operation.target-published").length, 1);
    assert.equal(snapshot.events.filter(e => e.eventKind === "operation.progress" && e.payload.state === "publish").length, 1);
  });
}
