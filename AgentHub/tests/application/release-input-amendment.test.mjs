import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { resolveTestSelection } from "../../src/domain/test-selection.mjs";

const taskIds = Array.from({ length: 5 }, (_, i) => `task-${i}`);
const inventory = ["tests/failed.mjs", "tests/affected.mjs", "tests/new-runtime.mjs"];
const oldSelection = { mode: "include", ids: inventory.slice(0, 2) };
const newSelection = { mode: "include", ids: inventory };
const notes = suffix => ({ sourcePath: `whole-${suffix}.md`, byteLength: 42,
  rawSha256: suffix === "five" ? "a".repeat(64) : "c".repeat(64), canonicalSha256: "b".repeat(64) });

async function fixture(t, phase) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-input-amendment-"));
  const store = new ReleaseOperationStore({ dataDir: root, idFactory: () => "original" });
  const scheduled = [], composed = [], publications = [];
  let release, entered, active;
  const gate = new Promise(resolve => { release = resolve; });
  const blocked = new Promise(resolve => { entered = resolve; });
  let selected = taskIds.map(taskId => ({ taskId, resultCommit: `${taskId}-r1`, acceptanceRevision: 1 }));
  const service = new ReleaseOperationService({ store, processAlive: pid => pid === process.pid,
    schedule: callback => scheduled.push(callback),
    compose: async ({ generation }) => {
      composed.push(generation);
      const results = structuredClone(selected);
      if (generation === 2 && phase.startsWith("compose")) {
        entered(); await gate;
        if (phase === "compose-unknown") throw Object.assign(new Error("original compose outcome is unresolved"), { code: "AWAIT_PREPARATION_UNKNOWN" });
      }
      return { repositoryBases: [{ repositoryRoot: "repo", baseCommit: "base" }], selectedResults: results,
        authorizedTaskIds: results.map(item => item.taskId),
        candidates: [{ repositoryRoot: "repo", releaseRoot: "candidate", commit: "commit", tree: "tree", manifestHash: "manifest" }] };
    },
    resolveTestPlans: async (candidates, selection) => candidates.map(candidate => ({
      repositoryRoot: candidate.repositoryRoot, plan: resolveTestSelection(selection, inventory),
    })),
    validate: async ({ generation }) => {
      if (generation.generation === 2 && phase === "validate") { entered(); await gate; }
      return { status: "passed" };
    },
    reservePublication: async ({ generation, reserve, recompose }) => {
      if (generation.generation === 2 && phase === "reservation") {
        entered(); await gate; return recompose();
      }
      return reserve();
    },
    publishTarget: async ({ operation, generation }) => {
      publications.push({ generation: generation.generation, selected: generation.selectedResults,
        ids: generation.testPlans[0].plan.selectedIds,
        metadata: operation.testSelectionAmendments?.at(-1)?.releaseMetadata });
      if (generation.generation === 1) {
        await writeFile(path.join(root, "g1-checkpoints.json"), JSON.stringify({ passed: 15, failed: 1 }), { flag: "wx" });
        throw Object.assign(new Error("controlled original failure"), { code: "RELEASE_VALIDATION_FAILED" });
      }
      return { status: "applied", revision: "published-once" };
    },
    readTarget: async () => ({ status: "not_applied" }),
    withTaskSelection: async ({ taskIds: ids, commit }) => {
      assert.deepEqual(ids, [...new Set(selected.map(item => item.taskId))].sort());
      const before = structuredClone(selected);
      return commit(before, async () => assert.deepEqual(selected, before));
    },
    finalize: async () => ({ closed: selected.map(item => item.taskId) }),
  });
  t.after(async () => { release(); if (active) await active; while (scheduled.length) await scheduled.shift()();
    if (store.get("original")) await service.drain("original");
    await rm(root, { recursive: true, force: true }); });
  service.start({ requestId: "original-request", workspaceId: "workspace", streamId: "stream", threadId: "thread",
    authorization: { taskIds, validationMode: "full", testSelection: { mode: "all", ids: [] },
      approvedTargets: [{ targetId: "public", kind: "git" }] } });
  await scheduled.shift()(); await service.drain("original");
  const first = store.snapshot("original");
  const amendment = { requestId: "first-exact-five-inputs", expectedRevision: first.operation.revision,
    expectedGeneration: 1, taskIds, testSelection: oldSelection, releaseMetadata: notes("five") };
  assert.equal((await service.continue("original", amendment)).accepted, true);
  active = scheduled.shift()();
  await blocked;
  return { root, store, service, scheduled, composed, publications, active, release, amendment, first,
    changeResult: () => { selected[0] = { ...selected[0], resultCommit: "corrected-r2", acceptanceRevision: 2 }; },
    addTask: () => { selected.push({ taskId: "new-unrelated", resultCommit: "new-runtime", acceptanceRevision: 1 }); },
    selected: () => structuredClone(selected) };
}

for (const phase of ["compose", "validate"]) {
  test(`pre-effect ${phase} acceptance invalidates exact amended inputs before another attempt`, async t => {
    const f = await fixture(t, phase);
    const originalBytes = await readFile(path.join(f.root, "g1-checkpoints.json"));
    const activeOwner = f.store.get("original").owner;
    f.service.prepareForTaskAcceptance("task-0");
    f.changeResult();
    f.service.prepareForTaskAcceptance("task-0");
    f.service.wakeForTask("task-0");
    const held = f.store.get("original");
    assert.equal(held.owner.ownerId, activeOwner.ownerId);
    assert.equal(held.owner.epoch, activeOwner.epoch, "the same owner settles before idle amendment");
    assert.equal((await f.service.continue("original", { requestId: "while-owner-is-joining",
      expectedRevision: held.revision, expectedGeneration: held.currentGeneration,
      taskIds, testSelection: newSelection, releaseMetadata: notes("fresh") })).reason, "ineligible");
    f.release(); await f.active;
    while (f.scheduled.length) await f.scheduled.shift()();
    await f.service.drain("original");
    const idle = f.store.snapshot("original");
    t.diagnostic(JSON.stringify({ phase, state: idle.operation.state, composed: f.composed,
      publications: f.publications.map(item => ({ generation: item.generation, count: item.selected.length, ids: item.ids, metadata: item.metadata })) }));
    assert.equal(idle.operation.state, "waiting");
    assert.equal(idle.operation.waitReason.code, "release_inputs_changed");
    assert.equal(idle.operation.owner, null);
    assert.equal(idle.operation.waitReason.retryAt, undefined);
    assert.deepEqual(f.composed, [1, 2], "duplicate pre/post acceptance cannot create stale G3");
    assert.deepEqual(f.publications.map(item => item.generation), [1]);
    assert.equal(f.store.pendingEvents().filter(item => item.eventKind === "operation.selection-changed").length, 1);
    assert.deepEqual(idle.generations[0], f.first.generations[0]);
    assert.deepEqual(idle.receipts.filter(item => item.generation === 1), f.first.receipts);
    assert.deepEqual(await readFile(path.join(f.root, "g1-checkpoints.json")), originalBytes);
    assert.equal(f.service.continue("original").reason, "test-selection-required");
    assert.equal((await f.service.continue("original", f.amendment)).duplicate, true, "saved replay is still dispatched first");
    assert.deepEqual(f.store.snapshot("original"), idle);
    for (const omit of ["taskIds", "testSelection", "releaseMetadata"]) {
      const incomplete = { requestId: `incomplete-${omit}`, expectedRevision: idle.operation.revision,
        expectedGeneration: idle.operation.currentGeneration, taskIds, testSelection: newSelection, releaseMetadata: notes("fresh") };
      delete incomplete[omit];
      const refused = await f.service.continue("original", incomplete);
      assert.equal(refused.accepted, false);
      assert.equal(refused.reason, "release-inputs-required");
      assert.deepEqual(f.store.snapshot("original"), idle);
    }
    const fresh = { requestId: "fresh-whole-inputs", expectedRevision: idle.operation.revision,
      expectedGeneration: idle.operation.currentGeneration, taskIds, testSelection: newSelection, releaseMetadata: notes("fresh") };
    assert.equal((await f.service.continue("original", fresh)).accepted, true);
    await f.scheduled.shift()(); await f.service.drain("original");
    const done = f.store.snapshot("original");
    assert.equal(done.operation.state, "done");
    assert.deepEqual(f.publications.map(item => item.generation), [1, idle.operation.currentGeneration + 1]);
    assert.deepEqual(f.publications[1].ids, [...inventory].sort());
    assert.deepEqual(f.publications[1].metadata, notes("fresh"));
    assert.deepEqual(f.publications[1].selected, f.selected().sort((a, b) => a.taskId.localeCompare(b.taskId)));
    assert.deepEqual(done.operation.testSelectionAmendments[0], idle.operation.testSelectionAmendments[0]);
    assert.equal((await f.service.continue("original", fresh)).duplicate, true);
    assert.equal(f.scheduled.length, 0);
    assert.deepEqual(await readFile(path.join(f.root, "g1-checkpoints.json")), originalBytes);
  });
}

test("publication selection readback cannot recompose stale amended inputs without acceptance callbacks", async t => {
  const f = await fixture(t, "reservation");
  f.changeResult(); f.release(); await f.active;
  while (f.scheduled.length) await f.scheduled.shift()();
  await f.service.drain("original");
  const idle = f.store.snapshot("original");
  assert.equal(idle.operation.state, "waiting");
  assert.equal(idle.operation.waitReason.code, "release_inputs_changed");
  assert.equal(idle.operation.owner, null);
  assert.deepEqual(f.composed, [1, 2]);
  assert.deepEqual(f.publications.map(item => item.generation), [1]);
  assert.equal(idle.operation.publicationEffects.publishStarted, undefined);
  assert.equal(idle.receipts.filter(item => item.generation === 2 && item.stepId.startsWith("publish:")).length, 0,
    "waiting reservation returns before a first target intent as well as its effect");
});

test("unresolved in-flight composition remains original evidence and cannot be amended over", async t => {
  const f = await fixture(t, "compose-unknown");
  f.service.prepareForTaskAcceptance("task-0");
  f.changeResult(); f.release(); await f.active;
  while (f.scheduled.length) await f.scheduled.shift()();
  await f.service.drain("original");
  const idle = f.store.snapshot("original");
  assert.equal(idle.operation.state, "waiting");
  assert.equal(idle.operation.waitReason.code, "release_inputs_changed");
  assert.equal(idle.operation.owner, null);
  assert.equal(f.store.latestStep("original", 2, "compose").status, "unknown");
  const refused = await f.service.continue("original", { requestId: "cannot-overwrite-unknown-compose",
    expectedRevision: idle.operation.revision, expectedGeneration: idle.operation.currentGeneration,
    taskIds, testSelection: newSelection, releaseMetadata: notes("fresh") });
  assert.equal(refused.accepted, false);
  assert.equal(refused.reason, "preparation-effect-unknown");
  assert.deepEqual(f.store.snapshot("original"), idle);
  assert.deepEqual(f.composed, [1, 2]);
  assert.deepEqual(f.publications.map(item => item.generation), [1]);
});
