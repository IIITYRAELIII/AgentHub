import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { createCandidateGeneration } from "../../src/domain/release-operation.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";

const taskIds = ["task-a", "task-b"];
const targets = [
  { targetId: "git", kind: "git", repositoryRoot: "D:/repo" },
  { targetId: "runtime", kind: "runtime", environment: "production" },
];

function generation(results = taskIds.map((taskId) => ({ taskId, resultCommit: `${taskId}-r1`, tree: `${taskId}-tree`, acceptanceRevision: 2 }))) {
  return {
    repositoryBases: [{ repositoryRoot: "D:/repo", baseCommit: "base" }],
    selectedResults: results,
    candidates: [{
      repositoryRoot: "D:/repo", releaseRoot: "D:/owned/release", commit: "candidate", tree: "candidate-tree", manifestHash: "manifest",
    }],
    sourceFingerprint: "source",
  };
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-operation-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const now = overrides.now ?? (() => new Date(Date.UTC(2026, 8, 22, 0, 0, sequence++)).toISOString());
  const store = new ReleaseOperationStore({ dataDir: root, idFactory: () => "operation-1", now });
  const calls = [];
  const effects = new Map();
  const service = new ReleaseOperationService({
    store,
    ownerId: "worker-1",
    now,
    compose: async (input) => { calls.push(["compose", input.generation]); return generation(); },
    validate: async ({ generation: value }) => { calls.push(["validate", value.generation]); return { status: "passed" }; },
    publishTarget: async ({ target }) => {
      calls.push(["publish", target.targetId]);
      const effect = { status: "applied", revision: `${target.targetId}-revision` };
      effects.set(target.targetId, effect);
      return effect;
    },
    readTarget: async ({ target }) => effects.get(target.targetId) ?? { status: "not_applied" },
    finalize: async ({ generation: value }) => { calls.push(["finalize", value.generation]); return { closed: taskIds }; },
    ...overrides,
  });
  return { calls, effects, root, service, store };
}

function start(service, requestId = "request-1") {
  return service.start({
    requestId,
    workspaceId: "workspace-1",
    streamId: "stream-1",
    threadId: "thread-1",
    authorization: { taskIds, approvedTargets: targets, validationMode: "full" },
  });
}

async function waitUntil(predicate, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for release operation test condition");
}

test("release operation acknowledges before work and finishes one exact generation", async (t) => {
  const scheduled = [];
  const cleaned = [];
  const f = await fixture(t, {
    schedule: (operation) => scheduled.push(operation),
    cleanupGeneration: async ({ operation, generation: value }) => cleaned.push([
      operation.state, value.generation, value.identitySha256,
    ]),
  });
  const ack = start(f.service);
  assert.deepEqual(ack, { accepted: true, created: true, operationId: "operation-1", state: "compose", revision: 1 });
  assert.deepEqual(f.calls, []);
  scheduled.shift()();
  const snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(snapshot.generations.length, 1);
  assert.deepEqual(f.calls, [["compose", 1], ["validate", 1], ["publish", "git"], ["publish", "runtime"], ["finalize", 1]]);
  assert.deepEqual(Object.keys(snapshot.operation.publicationEffects.targets), ["git", "runtime"]);
  assert.deepEqual(cleaned, [["done", 1, snapshot.generations[0].identitySha256]]);
});

test("validation failure waits for a correction and continues as generation two", async (t) => {
  let validation = 0;
  let resultVersion = 1;
  const f = await fixture(t, {
    compose: async () => generation(taskIds.map((taskId) => ({
      taskId, resultCommit: `${taskId}-r${resultVersion}`, tree: `${taskId}-tree-${resultVersion}`, acceptanceRevision: resultVersion + 1,
    }))),
    validate: async () => {
      validation += 1;
      if (validation === 1) throw new Error("contract failed");
      return { status: "passed" };
    },
  });
  const ack = start(f.service);
  let snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "waiting");
  assert.equal(snapshot.operation.waitReason.code, "validation_failed");
  assert.equal(snapshot.operation.currentGeneration, 1);
  resultVersion = 2;
  assert.deepEqual(f.service.wakeForTask("task-a"), [ack.operationId]);
  snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(snapshot.operation.currentGeneration, 2);
  assert.equal(snapshot.generations[0].selectedResults[0].resultCommit, "task-a-r1");
  assert.equal(snapshot.generations[1].selectedResults[0].resultCommit, "task-a-r2");
});

test("lineage mismatch creates one automatic correction request and waits on the same operation", async (t) => {
  const correctionRequests = [];
  let corrected = false;
  const f = await fixture(t, {
    compose: async () => {
      if (corrected) return generation();
      const error = new Error("selected result is unrelated");
      error.code = "RELEASE_RESULT_LINEAGE_MISMATCH";
      error.taskId = "task-a";
      error.priorResultCommit = "task-a-r1";
      error.resultCommit = "task-a-unrelated";
      throw error;
    },
    requestCorrection: async ({ operation, error }) => {
      correctionRequests.push({ operationId: operation.operationId, taskId: error.taskId });
      return { operationId: "correction-task-a" };
    },
  });
  const ack = start(f.service);
  let snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "waiting");
  assert.equal(snapshot.operation.waitReason.code, "correction_required");
  assert.equal(snapshot.operation.waitReason.details.taskId, "task-a");
  assert.equal(snapshot.operation.waitReason.details.correctionOperationId, "correction-task-a");
  assert.deepEqual(correctionRequests, [{ operationId: ack.operationId, taskId: "task-a" }]);
  corrected = true;
  assert.deepEqual(f.service.wakeForTask("task-a"), [ack.operationId]);
  snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(correctionRequests.length, 1);
});

test("unknown publish effect is read back after recovery and never blindly repeated", async (t) => {
  let publishCalls = 0;
  let readback = { status: "not_applied" };
  const f = await fixture(t, {
    publishTarget: async ({ target }) => {
      publishCalls += 1;
      if (target.targetId === "git") {
        readback = { status: "unknown", cursor: "push-1" };
        const error = new Error("connection lost after push");
        error.code = "ECONNRESET";
        throw error;
      }
      return { status: "applied", revision: "runtime" };
    },
    readTarget: async ({ target }) => target.targetId === "git" ? readback : { status: "not_applied" },
  });
  const ack = start(f.service);
  let snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "waiting");
  assert.equal(snapshot.operation.waitReason.code, "external_effect_readback");
  assert.equal(publishCalls, 1);
  readback = { status: "applied", revision: "git" };
  f.service.continue(ack.operationId);
  snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(publishCalls, 2, "only the untouched runtime target is published after git readback");
  assert.equal(snapshot.operation.publicationEffects.targets.git.revision, "git");
});

test("partial target publication survives restart and only the missing target runs", async (t) => {
  const f = await fixture(t, {
    publishTarget: async ({ target }) => {
      f.calls.push(["publish", target.targetId]);
      if (target.targetId === "runtime" && !f.effects.has("unblocked")) {
        const error = new Error("runtime endpoint unavailable");
        error.code = "RELEASE_EXTERNAL_CONDITION";
        throw error;
      }
      const effect = { status: "applied", revision: target.targetId };
      f.effects.set(target.targetId, effect);
      return effect;
    },
  });
  const ack = start(f.service);
  let snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "waiting");
  assert.equal(snapshot.operation.publicationEffects.targets.git.revision, "git");
  f.effects.set("unblocked", true);
  const replacement = new ReleaseOperationService({
    store: f.store,
    ownerId: "worker-2",
    now: () => new Date(Date.now() + 60_000).toISOString(),
    compose: async () => assert.fail("composition must not repeat"),
    validate: async () => assert.fail("validation must not repeat"),
    publishTarget: async ({ target }) => {
      assert.equal(target.targetId, "runtime");
      f.calls.push(["replacement-publish", target.targetId]);
      return { status: "applied", revision: "runtime" };
    },
    readTarget: async ({ target }) => target.targetId === "git"
      ? { status: "applied", revision: "git" }
      : { status: "not_applied" },
    finalize: async () => ({ status: "completed" }),
  });
  replacement.continue(ack.operationId);
  snapshot = await replacement.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(f.calls.filter(([name, targetId]) => name === "publish" && targetId === "git").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "replacement-publish").length, 1);
});

test("outbox delivery is at-least-once with a stable operation revision key", async (t) => {
  const delivered = [];
  let fail = true;
  const f = await fixture(t, {
    deliveryRetryMs: 100,
    deliverEvent: async (event) => {
      delivered.push(`${event.operationId}:${event.revision}:${event.eventKind}`);
      if (fail) throw new Error("stream unavailable");
    },
  });
  const ack = start(f.service);
  await f.service.drain(ack.operationId);
  const pending = f.store.pendingEvents();
  assert.ok(pending.length > 0);
  fail = false;
  await waitUntil(() => f.store.pendingEvents().length === 0);
  assert.equal(new Set(delivered).size, pending.length);
  assert.equal(f.store.pendingEvents().length, 0);
});

test("outbox drains an event written while delivery is already running", async (t) => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let entered;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const delivered = [];
  const f = await fixture(t, {
    schedule: () => {},
    deliverEvent: async (event) => {
      delivered.push(`${event.revision}:${event.eventKind}`);
      if (delivered.length === 1) {
        entered();
        await firstBlocked;
      }
    },
  });
  const ack = start(f.service);
  const draining = f.service.deliverPendingEvents();
  await firstEntered;
  const current = f.store.get(ack.operationId);
  const transitioned = f.store.transition(ack.operationId, { nextAction: "second event" }, {
    expectedRevision: current.revision,
    eventKind: "operation.test-second-event",
  });
  assert.equal(transitioned.applied, true);
  assert.equal((await f.service.deliverPendingEvents()).skipped, true);
  releaseFirst();
  await draining;
  assert.equal(f.store.pendingEvents().length, 0);
  assert.ok(delivered.some((entry) => entry.endsWith(":operation.test-second-event")));
});

test("external condition retries automatically at its durable retry time", async (t) => {
  let available = false;
  const f = await fixture(t, {
    retryDelayMs: 20,
    publishTarget: async ({ target }) => {
      if (!available) {
        available = true;
        const error = new Error("temporary outage");
        error.code = "RELEASE_EXTERNAL_CONDITION";
        error.retryAfterMs = 20;
        throw error;
      }
      return { status: "applied", revision: target.targetId };
    },
    readTarget: async () => ({ status: "not_applied" }),
  });
  const ack = start(f.service);
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  const snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
});

test("lease heartbeat prevents a replacement worker from entering a long validation", async (t) => {
  let releaseValidation;
  const validation = new Promise((resolve) => { releaseValidation = resolve; });
  const f = await fixture(t, {
    leaseMs: 150,
    now: () => new Date().toISOString(),
    validate: async () => validation,
  });
  const ack = start(f.service);
  await new Promise((resolve) => setTimeout(resolve, 240));
  const replacement = new ReleaseOperationService({
    store: f.store,
    ownerId: "worker-2",
    leaseMs: 150,
    compose: async () => assert.fail("replacement must not compose"),
    validate: async () => assert.fail("replacement must not validate"),
    publishTarget: async () => assert.fail("replacement must not publish"),
    readTarget: async () => ({ status: "not_applied" }),
    finalize: async () => assert.fail("replacement must not finalize"),
  });
  assert.deepEqual(replacement.recover().scheduled, [ack.operationId]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseValidation({ status: "passed" });
  const snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
});

test("lease heartbeat cannot race publication effect persistence", async (t) => {
  const f = await fixture(t, {
    leaseMs: 120,
    now: () => new Date().toISOString(),
    publishTarget: async ({ target }) => {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return { status: "applied", revision: target.targetId };
    },
  });
  const ack = start(f.service);
  const snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.deepEqual(Object.keys(snapshot.operation.publicationEffects.targets), ["git", "runtime"]);
});

test("recovery adopts a durable generation written before its compose receipt", async (t) => {
  const scheduled = [];
  const f = await fixture(t, {
    schedule: (operation) => scheduled.push(operation),
    compose: async () => assert.fail("durable generation must prevent repeated composition"),
  });
  const ack = start(f.service);
  const operation = f.store.get(ack.operationId);
  const receipt = f.store.beginStep({
    operationId: operation.operationId,
    generation: 1,
    stepId: "compose",
    input: { authorization: operation.authorization, priorGeneration: 0 },
  }).receipt;
  const value = generation();
  const durable = createCandidateGeneration({
    ...value,
    operationId: operation.operationId,
    generation: 1,
    runnerVersion: operation.runnerVersion,
    createdAt: receipt.createdAt,
  });
  f.store.putGeneration(durable);
  scheduled.shift()();
  const snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(snapshot.generations[0].identitySha256, durable.identitySha256);
  assert.equal(snapshot.receipts.find((item) => item.stepId === "compose").status, "applied");
});

test("recovery reuses an applied compose receipt without composing a second generation", async (t) => {
  const scheduled = [];
  const f = await fixture(t, {
    schedule: (operation) => scheduled.push(operation),
    compose: async () => assert.fail("applied composition must not repeat"),
  });
  const ack = start(f.service);
  const operation = f.store.get(ack.operationId);
  const receipt = f.store.beginStep({
    operationId: operation.operationId,
    generation: 1,
    stepId: "compose",
    input: { authorization: operation.authorization, priorGeneration: 0 },
  }).receipt;
  const durable = createCandidateGeneration({
    ...generation(),
    operationId: operation.operationId,
    generation: 1,
    runnerVersion: operation.runnerVersion,
    createdAt: receipt.createdAt,
  });
  f.store.putGeneration(durable);
  f.store.finishStep(receipt, {
    status: "applied",
    effect: { identitySha256: durable.identitySha256 },
  });
  scheduled.shift()();
  const snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(snapshot.generations.length, 1);
  assert.equal(snapshot.generations[0].identitySha256, durable.identitySha256);
  assert.equal(snapshot.receipts.filter((item) => item.stepId === "compose").length, 1);
});

test("N-1 applied compose receipt recovers its exact stored generation without an identity field", async (t) => {
  const scheduled = [];
  let composeCalls = 0;
  const f = await fixture(t, {
    schedule: (operation) => scheduled.push(operation),
    compose: async () => { composeCalls += 1; return generation(); },
  });
  const ack = start(f.service, "n-1-compose-receipt");
  const receipt = f.store.beginStep({
    operationId: ack.operationId,
    generation: 1,
    stepId: "compose",
    input: { authorization: f.store.get(ack.operationId).authorization, priorGeneration: 0 },
  }).receipt;
  const durable = createCandidateGeneration({
    ...generation(), operationId: ack.operationId, generation: 1,
    supersedesGeneration: null, runnerVersion: "release-operation-v1", createdAt: receipt.createdAt,
  });
  f.store.putGeneration(durable);
  f.store.finishStep(receipt, { status: "applied", effect: {} });
  scheduled.shift()();
  const snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(composeCalls, 0);
  assert.equal(snapshot.generations[0].identitySha256, durable.identitySha256);
  assert.equal(snapshot.receipts.filter((item) => item.stepId === "compose").length, 1);
});

test("a correction accepted during validation fences G1 and publishes G2", async (t) => {
  let resultVersion = 1;
  let validationCalls = 0;
  let releaseValidation;
  const firstValidation = new Promise((resolve) => { releaseValidation = resolve; });
  const published = [];
  const f = await fixture(t, {
    now: () => new Date().toISOString(),
    compose: async () => generation(taskIds.map((taskId) => ({
      taskId,
      resultCommit: `${taskId}-r${resultVersion}`,
      tree: `${taskId}-tree-${resultVersion}`,
      acceptanceRevision: resultVersion + 1,
    }))),
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 1) await firstValidation;
      return { status: "passed" };
    },
    publishTarget: async ({ generation: value, target }) => {
      published.push({ generation: value.generation, targetId: target.targetId });
      return { status: "applied", revision: `${target.targetId}-g${value.generation}` };
    },
  });
  const ack = start(f.service);
  await waitUntil(() => validationCalls === 1);
  resultVersion = 2;
  assert.deepEqual(f.service.prepareForTaskAcceptance("task-a"), [{
    operationId: ack.operationId, generation: 2, recomposed: true,
  }]);
  releaseValidation();
  const snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(snapshot.operation.currentGeneration, 2);
  assert.equal(snapshot.generations.length, 2);
  assert.equal(snapshot.generations[1].selectedResults[0].resultCommit, "task-a-r2");
  assert.deepEqual(new Set(published.map((item) => item.generation)), new Set([2]));
});

test("post-acceptance wake fences an active generation before its first publication effect", async (t) => {
  const f = await fixture(t);
  let releaseValidation;
  const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
  let validationStarted;
  const started = new Promise((resolve) => { validationStarted = resolve; });
  const published = [];
  const originalCompose = f.service.compose;
  let selectedResult = "result-1";
  f.service.compose = async (input) => {
    const generation = await originalCompose(input);
    return {
      ...generation,
      selectedResults: generation.selectedResults.map((item) => ({ ...item, resultCommit: selectedResult })),
    };
  };
  f.service.validate = async () => {
    validationStarted();
    await validationGate;
    return { status: "passed" };
  };
  f.service.publishTarget = async ({ generation }) => {
    published.push(generation.selectedResults[0].resultCommit);
    return { status: "applied", revision: generation.candidates[0].commit };
  };
  const ack = start(f.service);
  await started;
  selectedResult = "result-2";
  f.service.wakeForTask("task-a");
  releaseValidation({ status: "passed" });
  const result = await f.service.drain(ack.operationId);
  assert.equal(result.operation.state, "done");
  assert.deepEqual(published, ["result-2", "result-2"]);
  assert.equal(result.generations.length, 2);
});

test("publish-start reservation preserves G1 and leaves a later result for another release", async (t) => {
  let resultVersion = 1;
  let publishCalls = 0;
  let releasePublish;
  const publication = new Promise((resolve) => { releasePublish = resolve; });
  const f = await fixture(t, {
    now: () => new Date().toISOString(),
    compose: async () => generation(taskIds.map((taskId) => ({
      taskId,
      resultCommit: `${taskId}-r${resultVersion}`,
      tree: `${taskId}-tree-${resultVersion}`,
      acceptanceRevision: resultVersion + 1,
    }))),
    publishTarget: async ({ target }) => {
      publishCalls += 1;
      if (publishCalls === 1) await publication;
      return { status: "applied", revision: `${target.targetId}-g1` };
    },
  });
  const ack = start(f.service);
  await waitUntil(() => publishCalls === 1);
  resultVersion = 2;
  assert.deepEqual(f.service.prepareForTaskAcceptance("task-a"), [{
    operationId: ack.operationId, generation: 1, preserved: true,
  }]);
  releasePublish();
  const snapshot = await f.service.drain(ack.operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(snapshot.operation.currentGeneration, 1);
  assert.equal(snapshot.generations.length, 1);
  assert.equal(snapshot.generations[0].selectedResults[0].resultCommit, "task-a-r1");
});

test("evidence-only legacy operation rejects manual continuation without scheduling work", async (t) => {
  const scheduled = [];
  const f = await fixture(t, { schedule: (operation) => scheduled.push(operation) });
  const imported = f.store.importLegacy({
    workspaceId: "workspace-1",
    streamId: "stream-1",
    threadId: "thread-1",
    sourceKind: "release-checkpoint-v2",
    sourceIdentity: "checkpoint-1",
    evidence: { phase: "frozen" },
    evidenceOnly: true,
    authorization: { taskIds, approvedTargets: targets, validationMode: "full" },
    runnerVersion: "runner-1",
  });
  const result = f.service.continue(imported.operation.operationId);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "external-condition");
  assert.equal(result.operation.waitReason.code, "legacy_snapshot_evidence");
  assert.equal(scheduled.length, 0);
});
