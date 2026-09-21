import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { taskBranchName } from "../../../src/domain/task-git-reference.mjs";
import { taskReleasePlanRevision } from "../../../src/domain/task-release-snapshot.mjs";
import {
  LATEST_TASK_SQUASH_TRANSFER_OUTCOME_SQL,
  TaskBoardStore,
} from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";

test("TaskBoardStore snapshot revision advances with the durable journal revision", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-journal-snapshot-revision-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); await journal.close(); await rm(directory, { recursive: true, force: true }); });
  const before = store.snapshotRevision;
  const beforeJournalRevision = Number(before.split(":", 1)[0]);
  await journal.upsertRecords([{
    provider: "codex", threadId: "snapshot-thread", taskThreadId: "snapshot-thread",
    turnId: "snapshot-turn", projectRoot: directory, title: "Journal changed",
    body: "not projected into the revision", completedAt: "2026-09-17T00:00:00Z",
    status: "completed", provisional: false,
  }]);
  const after = store.snapshotRevision;
  assert.notEqual(after, before);
  assert.equal(Number(after.split(":", 1)[0]), beforeJournalRevision + 1);
  assert.equal(Number(after.split(":", 1)[0]), store.revision);
});

test("Task history projects exact terminal journal turns without file evidence or backfill", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-journal-view-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  let store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); await journal.close(); await rm(directory, { recursive: true, force: true }); });
  const task = store.create({ text: "Review only" });
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace" });
  const binding = { workspaceId: "workspace", streamId: "stream", provider: "codex",
    threadId: "old-thread", turnId: "turn", operationId: "claim-a" };
  store.claim(task.id, binding);
  store.claim(task.id, { ...binding, operationId: "claim-b" });
  const record = { provider: "codex", threadId: "old-thread", taskThreadId: "old-thread",
    turnId: "turn", projectRoot: directory, title: "Review finished", body: "private body",
    completedAt: "2026-09-15T00:00:00Z", status: "completed", provisional: true };
  await journal.upsertRecords([record, { ...record, provider: "claude", provisional: false },
    { ...record, turnId: "unclaimed", provisional: false }]);
  assert.deepEqual(store.task(task.id).workLog, []);
  const revision = store.revision;
  await journal.upsertRecords([{ ...record, provisional: false }]);
  assert.ok(store.revision > revision);
  const log = store.task(task.id).workLog;
  assert.equal(log.length, 1);
  assert.equal(log[0].summary, record.title);
  assert.equal(log[0].threadId, "old-thread");
  assert.deepEqual(log[0].changedFiles, []);
  assert.equal(JSON.stringify(log).includes("private body"), false);
  assert.equal(store.list()[0].workLog.length, 1);
  await journal.upsertRecords([{ ...record, provisional: false, title: "Corrected title" }]);
  assert.equal(store.task(task.id).workLog.length, 1);
  assert.equal(store.task(task.id).workLog[0].summary, "Corrected title");
  await journal.upsertRecords([{ ...record, provisional: false, contextProbe: true }]);
  assert.deepEqual(store.task(task.id).workLog, log);
  assert.deepEqual(store.list()[0].workLog, log);
  await journal.upsertRecords([{ ...record, provisional: false, contextProbe: true, status: "interrupted" }]);
  store.close();
  store = new TaskBoardStore({ databaseFile });
  assert.equal(store.task(task.id).workLog.length, 1);
  assert.equal(store.task(task.id).workLog[0].status, "interrupted");
  const raw = new DatabaseSync(databaseFile);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM hub_task_work_log").get().n, 0);
  raw.close();
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-board-"));
  let sequence = 0;
  const store = new TaskBoardStore({
    databaseFile: path.join(directory, "journal.sqlite"),
    now: () => 1_700_000_000_000 + sequence,
    idFactory: () => `task-${++sequence}`,
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function admit(store, prepared, requestId, attemptId = `attempt-${requestId}`) {
  return store.admitPreparedStart(prepared.id, {
    requestId,
    attemptId,
    expectedRevision: prepared.revision,
  });
}

test("Task store revision changes on writes but not reads", async (t) => {
  const store = await fixture(t);
  const initial = store.revision;

  store.list();
  assert.equal(store.revision, initial);
  store.create({ text: "Revision boundary" });
  assert.equal(store.revision, initial + 1);
  store.list();
  assert.equal(store.revision, initial + 1);
});

test("Blocked persists its prerequisite and workflow rollback restores it", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Waiting for prerequisite" });
  const blockedBy = { taskId: "prerequisite", taskNumber: "HUB-800", resultCommit: "a".repeat(40) };
  store.beginLifecycleTransition(task.id, { operationId: "block", kind: "workflow",
    targetWorkflowStatus: "blocked", expectedRevision: task.revision });
  store.commitWorkflowTransition({ operationId: "block", replaceGitReferences: false, evidence: { blockedBy } });
  assert.equal(store.task(task.id).workflowStatus, "blocked");
  assert.deepEqual(store.task(task.id).blockedBy, blockedBy);
  store.beginLifecycleTransition(task.id, { operationId: "resume", kind: "workflow",
    targetWorkflowStatus: "in_progress", expectedRevision: store.task(task.id).revision });
  store.commitWorkflowTransition({ operationId: "resume", replaceGitReferences: false });
  assert.equal(store.task(task.id).blockedBy, undefined);
  store.rollbackWorkflowOutcome("resume");
  assert.equal(store.task(task.id).workflowStatus, "blocked");
  assert.deepEqual(store.task(task.id).blockedBy, blockedBy);
});

test("published duplicate absorption admits only an exact Done survivor and exact replay", async (t) => {
  const store = await fixture(t);
  const source = store.move(store.create({ text: "Published duplicate" }).id, {
    bucket: "workspace", workspaceId: "workspace",
  });
  let survivor = store.move(store.create({ text: "Published survivor" }).id, {
    bucket: "workspace", workspaceId: "workspace",
  });
  survivor = store.setWorkflowStatus(survivor.id, "done");
  survivor = store.complete(survivor.id);
  const absorbedInto = {
    version: 1,
    mode: "published_duplicate",
    taskId: survivor.id,
    taskRevision: survivor.revision,
    sourceTaskRevision: source.revision,
    source: { taskId: source.id, taskRevision: source.revision },
    survivor: { taskId: survivor.id, taskRevision: survivor.revision },
    publicationGeneration: "release-1",
    cleanupPlan: { strategy: "preserve_managed_source", deleting: [] },
    repositories: [],
  };
  const begun = store.beginLifecycleTransition(source.id, {
    operationId: "published-duplicate",
    kind: "complete",
    expectedRevision: source.revision,
    evidence: { absorbedInto },
  });
  assert.equal(begun.phase, "cleanup");
  assert.equal(store.beginLifecycleTransition(source.id, {
    operationId: "published-duplicate",
    kind: "complete",
    expectedRevision: source.revision,
    evidence: { absorbedInto },
  }).replayed, true);
  assert.throws(() => store.beginLifecycleTransition(source.id, {
    operationId: "published-duplicate",
    kind: "complete",
    expectedRevision: source.revision,
    evidence: { absorbedInto: { ...absorbedInto, publicationGeneration: "release-2" } },
  }), /another absorption/u);
  assert.equal(store.finalizeCleanupTransition("published-duplicate", {
    receiptEvidence: { absorbedInto },
  }).status, "done");
  assert.equal(store.lifecycleOutcome("published-duplicate").result.evidence.absorbedInto.mode,
    "published_duplicate");

  const ordinary = store.move(store.create({ text: "Ordinary absorption" }).id, {
    bucket: "workspace", workspaceId: "workspace",
  });
  assert.throws(() => store.beginLifecycleTransition(ordinary.id, {
    operationId: "ordinary-into-done",
    kind: "complete",
    expectedRevision: ordinary.revision,
    evidence: { absorbedInto: {
      taskId: survivor.id,
      taskRevision: survivor.revision,
      sourceTaskRevision: ordinary.revision,
    } },
  }), /Surviving Task changed/u);
});

test("squash transfer reserves and atomically updates both exact Task rows", async (t) => {
  const store = await fixture(t);
  const source = store.create({ text: "Source", bucket: "workspace", workspaceId: "workspace" });
  const survivor = store.create({ text: "Survivor", bucket: "workspace", workspaceId: "workspace" });
  const root = path.resolve("D:/repo");
  const enterTest = (task, resultCommit) => {
    store.beginLifecycleTransition(task.id, {
      operationId: `test-${task.id}`, kind: "workflow",
      targetWorkflowStatus: "testing", expectedRevision: task.revision,
    });
    return store.commitWorkflowTransition({
      operationId: `test-${task.id}`,
      gitReferences: [{ projectRoot: root, branch: `branch-${task.id}`, resultCommit }],
      evidence: { resultCommit },
    });
  };
  const testedSource = enterTest(source, "a".repeat(40));
  const testedSurvivor = enterTest(survivor, "b".repeat(40));
  const proof = {
    version: 1,
    kind: "task-squash-transfer-v1",
    survivor: {
      taskId: testedSurvivor.id, revision: testedSurvivor.revision,
      releaseRevision: testedSurvivor.releaseRevision, resultCommit: "c".repeat(40),
      baseCommit: "1".repeat(40), branch: `branch-${testedSurvivor.id}`,
    },
    source: {
      taskId: testedSource.id, revision: testedSource.revision,
      releaseRevision: testedSource.releaseRevision, resultCommit: "a".repeat(40),
      baseCommit: "2".repeat(40), branch: `branch-${testedSource.id}`,
    },
    projectRoot: root,
    previousResultCommit: testedSurvivor.gitReferences[0].resultCommit,
    baselineResultCommit: "b".repeat(40), devBeforeCommit: "d".repeat(40),
    devAfterTree: "e".repeat(40),
    sourceWitnesses: [{
      path: "source.mjs", source: { mode: "100644", object: "3".repeat(40) },
      survivor: { mode: "100644", object: "3".repeat(40) },
    }],
    ownerWitnesses: [{
      path: "new.mjs", baseline: null, beforeDev: null,
      newResult: { mode: "100644", object: "4".repeat(40) },
      afterDev: { mode: "100644", object: "4".repeat(40) },
    }],
    authority: {
      workspaceId: "workspace", streamId: "release", provider: "codex",
      threadId: "thread", proofRequestId: "squash-preview",
    },
  };
  store.beginLifecycleTransition(testedSurvivor.id, {
    operationId: "squash", kind: "workflow", targetWorkflowStatus: "testing",
    expectedRevision: testedSurvivor.revision, evidence: { squashTransfer: proof },
  });
  assert.equal(store.beginLifecycleTransition(testedSurvivor.id, {
    operationId: "squash", kind: "workflow", targetWorkflowStatus: "testing",
    expectedRevision: testedSurvivor.revision, evidence: { squashTransfer: proof },
  }).replayed, true);
  assert.throws(() => store.beginLifecycleTransition(testedSurvivor.id, {
    operationId: "squash", kind: "workflow", targetWorkflowStatus: "testing",
    expectedRevision: testedSurvivor.revision,
    evidence: { squashTransfer: { ...proof, authority: { ...proof.authority, proofRequestId: "foreign" } } },
  }), /another squash transfer/);
  assert.throws(() => store.beginLifecycleTransition(testedSource.id, {
    operationId: "source-conflict", kind: "workflow", targetWorkflowStatus: "blocked",
    expectedRevision: testedSource.revision,
  }), /already active/);
  const committed = store.commitSquashTransferTransition({
    operationId: "squash", squashTransfer: { ...proof, integrationCommit: "f".repeat(40) },
  });
  assert.equal(committed.task.workflowStatus, "testing");
  assert.equal(committed.sourceTask.workflowStatus, "in_progress");
  assert.equal(committed.task.revision, testedSurvivor.revision + 1);
  assert.equal(committed.sourceTask.revision, testedSource.revision + 1);
  assert.equal(store.task(testedSurvivor.id).gitReferences[0].resultCommit, "c".repeat(40));
  assert.equal(store.task(testedSurvivor.id).squashTransfer.integrationCommit, "f".repeat(40));
  assert.equal(store.task(testedSurvivor.id).resultReleaseRevision, committed.task.releaseRevision);
  assert.equal(store.task(testedSurvivor.id).resultReleaseRevision, proof.survivor.releaseRevision + 1);
  assert.equal(store.task(testedSource.id).squashAbsorbedBy.survivor.taskId, testedSurvivor.id);
  assert.equal(store.lifecycleTransition("squash"), null);
  assert.equal(store.lifecycleOutcome("squash").result.sourceTask.workflowStatus, "in_progress");

  const database = new DatabaseSync(store.databaseFile);
  const plan = database.prepare(
    `EXPLAIN QUERY PLAN ${LATEST_TASK_SQUASH_TRANSFER_OUTCOME_SQL}`,
  ).all(testedSurvivor.id, testedSurvivor.id).map((row) => row.detail);
  assert.ok(plan.some((detail) => detail.includes(
    "SEARCH hub_task_lifecycle_outcomes USING INDEX hub_task_lifecycle_outcome_squash_survivor_idx",
  )), plan.join("\n"));
  assert.ok(plan.some((detail) => detail.includes(
    "SEARCH hub_task_lifecycle_outcomes USING INDEX hub_task_lifecycle_outcome_squash_source_idx",
  )), plan.join("\n"));
  assert.equal(plan.some((detail) => detail.startsWith("SCAN hub_task_lifecycle_outcomes")), false,
    plan.join("\n"));

  const exactOutcome = database.prepare(
    "SELECT result_json FROM hub_task_lifecycle_outcomes WHERE operation_id = 'squash'",
  ).get().result_json;
  database.prepare(`
    INSERT INTO hub_task_lifecycle_outcomes (
      operation_id, task_id, kind, result_json, completed_at_ms
    ) VALUES (?, ?, 'workflow', ?, ?)
  `).run("latest-malformed-squash", testedSurvivor.id, JSON.stringify({
    evidence: { squashTransfer: {
      survivor: { taskId: testedSurvivor.id },
      source: { taskId: testedSource.id },
    } },
  }), 9_000_000_000_000);
  assert.equal(store.task(testedSurvivor.id).squashTransfer, undefined,
    "latest malformed survivor evidence must block older authority");
  assert.equal(store.task(testedSource.id).squashAbsorbedBy, undefined,
    "latest malformed source evidence must block older authority");
  database.prepare(
    "DELETE FROM hub_task_lifecycle_outcomes WHERE operation_id = 'latest-malformed-squash'",
  ).run();
  const corruptions = [
    ["missing proof", (result) => { delete result.evidence.squashTransfer; }],
    ["missing outcome Task", (result) => { delete result.task; }],
    ["stale outcome revision", (result) => { result.task.releaseRevision += 1; }],
    ["foreign reference", (result) => { result.task.gitReferences[0].projectRoot = "D:/foreign"; }],
    ["changed result", (result) => { result.task.gitReferences[0].resultCommit = "9".repeat(40); }],
  ];
  for (const [label, corrupt] of corruptions) {
    const result = JSON.parse(exactOutcome);
    corrupt(result);
    database.prepare(
      "UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = 'squash'",
    ).run(JSON.stringify(result));
    const projected = store.task(testedSurvivor.id);
    if (label === "missing proof") {
      assert.equal(projected.squashTransfer, undefined, label);
    } else {
      assert.equal(projected.squashTransfer.survivor.taskId, testedSurvivor.id, label);
    }
    assert.equal(projected.resultReleaseRevision, undefined, label);
  }
  database.prepare(
    "UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = 'squash'",
  ).run(exactOutcome);
  database.close();
  assert.equal(store.task(testedSurvivor.id).resultReleaseRevision, committed.task.releaseRevision);
});

test("squash cutover commits Test ownership only after exact Git readback", async (t) => {
  const store = await fixture(t);
  const source = store.create({ text: "Source", bucket: "workspace", workspaceId: "workspace" });
  const survivor = store.create({ text: "Survivor", bucket: "workspace", workspaceId: "workspace" });
  const root = path.resolve("D:/repo");
  const enterTest = (task, resultCommit) => {
    store.beginLifecycleTransition(task.id, { operationId: `test-${task.id}`, kind: "workflow",
      targetWorkflowStatus: "testing", expectedRevision: task.revision });
    return store.commitWorkflowTransition({ operationId: `test-${task.id}`,
      gitReferences: [{ projectRoot: root, branch: `branch-${task.id}`, resultCommit }],
      evidence: { resultCommit } });
  };
  const testedSource = enterTest(source, "a".repeat(40));
  const testedSurvivor = enterTest(survivor, "b".repeat(40));
  store.beginLifecycleTransition(testedSurvivor.id, { operationId: "resume-survivor", kind: "workflow",
    targetWorkflowStatus: "in_progress", expectedRevision: testedSurvivor.revision });
  const currentSurvivor = store.commitWorkflowTransition({
    operationId: "resume-survivor", replaceGitReferences: false,
  });
  const transfer = {
    version: 1, kind: "task-squash-transfer-v1",
    survivor: { taskId: currentSurvivor.id, revision: currentSurvivor.revision,
      releaseRevision: currentSurvivor.releaseRevision, resultCommit: "c".repeat(40),
      baseCommit: "1".repeat(40), branch: `branch-${currentSurvivor.id}` },
    source: { taskId: testedSource.id, revision: testedSource.revision,
      releaseRevision: testedSource.releaseRevision, resultCommit: "a".repeat(40),
      baseCommit: "2".repeat(40), branch: `branch-${testedSource.id}` },
    projectRoot: root, previousResultCommit: "b".repeat(40), baselineResultCommit: "3".repeat(40),
    devBeforeCommit: "4".repeat(40), devAfterTree: "5".repeat(40),
    sourceWitnesses: [{ path: "source.mjs", source: { mode: "100644", object: "6".repeat(40) },
      survivor: { mode: "100644", object: "6".repeat(40) } }],
    ownerWitnesses: [{ path: "new.mjs", baseline: null, beforeDev: null,
      newResult: { mode: "100644", object: "7".repeat(40) },
      afterDev: { mode: "100644", object: "7".repeat(40) } }],
    authority: { workspaceId: "workspace", streamId: "release", provider: "codex",
      threadId: "thread", proofRequestId: "preview" },
  };
  const cutover = {
    version: 1, kind: "task-squash-cutover-v1", expectedMainCommit: "8".repeat(40),
    expectedDevCommit: "4".repeat(40), expectedPreservedTree: "9".repeat(40),
    reviewedSourceCommit: "c".repeat(40), reviewedSourceTree: "a".repeat(40),
    projectorSha256: "b".repeat(64), artifacts: { sourceZipSha256: "c".repeat(64),
      bundleSha256: "d".repeat(64), manifestSha256: "e".repeat(64), filesSha256: "f".repeat(64) },
    squashTransfer: transfer,
  };
  store.beginLifecycleTransition(currentSurvivor.id, { operationId: "bootstrap", kind: "workflow",
    targetWorkflowStatus: "testing", expectedRevision: currentSurvivor.revision,
    evidence: { squashTransfer: transfer, squashCutover: cutover } });
  assert.equal(store.task(currentSurvivor.id).workflowStatus, "in_progress");
  assert.equal(store.task(testedSource.id).workflowStatus, "testing");
  assert.throws(() => store.commitSquashTransferTransition({ operationId: "bootstrap",
    squashTransfer: transfer, squashCutover: cutover }), /Git integration readback/u);
  const result = store.commitSquashTransferTransition({ operationId: "bootstrap",
    squashTransfer: { ...transfer, integrationCommit: "0".repeat(40) }, squashCutover: cutover });
  assert.equal(result.task.workflowStatus, "testing");
  assert.equal(result.sourceTask.workflowStatus, "in_progress");
  assert.equal(result.squashCutover.cutoverHash, store.lifecycleOutcome("bootstrap")
    .result.evidence.squashCutover.cutoverHash);
});

test("claim binds the turn without silently returning Test, Await or Blocked to work", async (t) => {
  const store = await fixture(t);
  for (const status of ["testing", "awaiting_implementation", "blocked"]) {
    const task = store.create({ text: status, bucket: "workspace", workspaceId: "workspace" });
    store.beginLifecycleTransition(task.id, { operationId: `status-${status}`, kind: "workflow",
      targetWorkflowStatus: status, expectedRevision: task.revision });
    store.commitWorkflowTransition({ operationId: `status-${status}`, replaceGitReferences: false });
    const claimed = store.claim(task.id, { workspaceId: "workspace", streamId: "new-stream", provider: "codex",
      threadId: "thread", turnId: status, operationId: `claim-${status}` });
    assert.equal(claimed.workflowStatus, status);
    assert.equal(claimed.streamId, "new-stream");
  }
});

test("workflow transition atomically CAS-commits status and exact Git references", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "Atomic transition" });
  const current = store.task(created.id);
  store.beginLifecycleTransition(created.id, {
    operationId: "workflow-1", kind: "workflow", targetWorkflowStatus: "testing",
    expectedRevision: current.revision,
  });
  assert.equal(store.task(created.id).workflowStatus, "new");

  const committed = store.commitWorkflowTransition({
    operationId: "workflow-1",
    gitReferences: [{ projectRoot: "D:/repo", branch: "HUB-159", resultCommit: "a".repeat(40) }],
    evidence: { outcome: "integrated" },
  });

  assert.equal(committed.workflowStatus, "testing");
  assert.deepEqual(committed.gitReferences, [{
    projectRoot: path.resolve("D:/repo"), branch: "HUB-159", resultCommit: "a".repeat(40),
  }]);
  assert.equal(committed.revision, current.revision + 1);
});

test("workflow transition readback exposes the exact immutable prior Task", async (t) => {
  const store = await fixture(t);
  const created = store.create({
    text: "Same-status transition evidence", workspaceId: "workspace-1", bucket: "workspace",
  });
  store.claim(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", provider: "codex", threadId: "thread-1",
    turnId: "turn-1", operationId: "claim-same-status-evidence",
  });
  const prior = store.recordTaskGitReference({
    taskId: created.id,
    projectRoot: "D:/repo",
    branch: "HUB-216",
    resultSnapshot: { repoRoot: "D:/repo", tree: "a".repeat(40) },
  });
  store.beginLifecycleTransition(created.id, {
    operationId: "same-status-evidence",
    kind: "workflow",
    targetWorkflowStatus: prior.workflowStatus,
    expectedRevision: prior.revision,
  });

  const transition = store.lifecycleTransition("same-status-evidence");
  assert.equal(transition.expectedRevision, prior.revision);
  assert.equal(transition.priorTask.id, prior.id);
  assert.equal(transition.priorTask.revision, prior.revision);
  assert.equal(transition.priorTask.workflowStatus, prior.workflowStatus);
  assert.equal(transition.priorTask.workspaceId, "workspace-1");
  assert.equal(transition.priorTask.streamId, "stream-1");
  assert.deepEqual(transition.priorTask.gitReferences, prior.gitReferences);
});

test("workflow outcome rollback restores the exact prior status and Git references", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "Await rollback" });
  const previous = store.recordTaskGitReference({
    taskId: created.id,
    projectRoot: "D:/repo",
    branch: "HUB-173",
    resultSnapshot: { repoRoot: "D:/repo", tree: "a".repeat(40) },
  });
  store.beginLifecycleTransition(created.id, {
    operationId: "workflow-rollback",
    kind: "workflow",
    targetWorkflowStatus: "awaiting_implementation",
    expectedRevision: previous.revision,
  });
  const committed = store.commitWorkflowTransition({
    operationId: "workflow-rollback",
    gitReferences: [{
      projectRoot: "D:/repo", branch: "HUB-174", resultCommit: "b".repeat(40),
    }],
    evidence: { outcome: "integrated" },
  });

  const restored = store.rollbackWorkflowOutcome(
    "workflow-rollback",
    new Error("injected Await rebuild failure"),
  );

  assert.equal(restored.workflowStatus, previous.workflowStatus);
  assert.equal(restored.revision, committed.revision + 1);
  assert.deepEqual(restored.gitReferences, previous.gitReferences);
  assert.equal(store.lifecycleOutcome("workflow-rollback").result.rollback.completed, true);
});

test("workflow CAS failure preserves the previous status and Git references", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "CAS transition" });
  const oldReference = store.recordTaskGitReference({
    taskId: created.id, projectRoot: "D:/repo", branch: "HUB-158",
    resultSnapshot: { repoRoot: "D:/repo", tree: "b".repeat(40) },
  });
  store.beginLifecycleTransition(created.id, {
    operationId: "workflow-cas", kind: "workflow", targetWorkflowStatus: "testing",
    expectedRevision: oldReference.revision,
  });
  store.updatePresentation(created.id, { title: "Concurrent edit", description: "" });

  assert.throws(() => store.commitWorkflowTransition({
    operationId: "workflow-cas",
    gitReferences: [{ projectRoot: "D:/repo", branch: "HUB-159", resultCommit: "c".repeat(40) }],
  }), /changed while Git evidence was prepared/u);
  const after = store.task(created.id);
  assert.equal(after.workflowStatus, "new");
  assert.equal(after.gitReferences[0].resultCommit, "b".repeat(40));
});

test("release transition atomically fences current Workspace and Stream settings", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-release-context-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => {
    store.close();
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  const repositoryRoot = path.join(directory, "repository");
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({
    name: "Agent HUB", settings: { releaseWorkflowEnabled: true, workingDirectory: repositoryRoot },
  }));
  const stream = await catalog.runMutation(() => catalog.createStream({
    workspaceId: workspace.id, name: "Release Manager", settings: {},
  }));
  const created = store.create({ text: "Release context fence", workspaceId: workspace.id, bucket: "workspace" });
  store.claim(created.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId: "thread-release-context",
    turnId: "turn-release-context", operationId: "claim-release-context",
  });
  const current = store.task(created.id);
  const releaseContext = { workspaceId: workspace.id, streamId: stream.id, projectRoot: repositoryRoot };

  await catalog.runMutation(() => catalog.updateStreamSettings(stream.id, {
    workingDirectory: path.join(directory, "moved-repository"),
  }));
  assert.throws(() => store.beginLifecycleTransition(created.id, {
    operationId: "release-context-root-race", kind: "workflow",
    targetWorkflowStatus: "awaiting_implementation", expectedRevision: current.revision, releaseContext,
  }), /release context changed/u);
  assert.equal(store.lifecycleTransition("release-context-root-race"), null);

  await catalog.runMutation(() => catalog.updateStreamSettings(stream.id, {}));
  await catalog.runMutation(() => catalog.updateWorkspaceSettings(workspace.id, {
    releaseWorkflowEnabled: false, workingDirectory: repositoryRoot,
  }));
  assert.throws(() => store.beginLifecycleTransition(created.id, {
    operationId: "release-context-disabled-race", kind: "workflow",
    targetWorkflowStatus: "awaiting_implementation", expectedRevision: current.revision, releaseContext,
  }), /release context changed/u);
  assert.equal(store.lifecycleTransition("release-context-disabled-race"), null);
  assert.equal(store.task(created.id).revision, current.revision);
});

test("prepare and cancel start enforce one exact owner and revision CAS", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "Concurrent launch" });
  const prepared = store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "owner-1",
    expectedRevision: created.revision,
  });
  assert.throws(() => store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-2", requestId: "owner-2",
  }), /already pending/u);
  assert.throws(
    () => store.fencePreparedStartCancellation(created.id, {
      requestId: "owner-2", cancellationRequestId: "cancel-owner-2",
      expectedRevision: prepared.revision,
    }),
    /owner does not match/u,
  );
  assert.throws(
    () => store.fencePreparedStartCancellation(created.id, {
      requestId: "owner-1", cancellationRequestId: "cancel-stale",
      expectedRevision: prepared.revision + 1,
    }),
    /revision conflict/u,
  );
  assert.throws(() => store.claim(created.id, {
    workspaceId: "workspace-1", streamId: "stream-existing", provider: "codex",
    threadId: "thread-existing", turnId: "turn-existing", operationId: "claim-before-cancel",
  }), /must be cancelled before claim/u);
  const fenced = store.fencePreparedStartCancellation(created.id, {
    requestId: "owner-1", cancellationRequestId: "cancel-owner-1",
    expectedRevision: prepared.revision,
  });
  const cancelled = store.completePreparedStartCancellation(created.id, {
    requestId: "owner-1", expectedRevision: fenced.revision,
  });
  assert.equal(cancelled.status, "open");
  assert.equal(cancelled.startRequestId, null);
  const claimed = store.claim(created.id, {
    workspaceId: "workspace-1", streamId: "stream-existing", provider: "codex",
    threadId: "thread-existing", turnId: "turn-existing", operationId: "claim-after-cancel",
  });
  assert.equal(claimed.streamId, "stream-existing");
  assert.throws(() => store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "owner-1",
  }), /уже запущена/u);
});

test("markStarted requires exact prepared owner state and revision", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "Exact launch completion" });
  const prepared = store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "exact-launch",
    expectedRevision: created.revision,
  });
  const admitted = admit(store, prepared, "exact-launch");
  assert.throws(() => store.markStarted(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "wrong-owner",
    attemptId: "attempt-exact-launch", expectedRevision: admitted.revision,
  }), /does not match/u);
  assert.throws(() => store.markStarted(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "exact-launch",
    attemptId: "wrong-attempt", expectedRevision: admitted.revision,
  }), /does not own effect admission/u);
  assert.throws(() => store.markStarted(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "exact-launch",
    attemptId: "attempt-exact-launch", expectedRevision: admitted.revision - 1,
  }), /revision CAS/u);
  const started = store.markStarted(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "exact-launch",
    attemptId: "attempt-exact-launch", expectedRevision: admitted.revision,
  });
  assert.equal(started.status, "started");
});

test("launch admission and cancellation fence serialize across SQLite connections", async (t) => {
  const first = await fixture(t);
  const second = new TaskBoardStore({ databaseFile: first.databaseFile });
  try {
  const cancelledTask = first.create({ text: "Cancel wins" });
  const preparedForCancel = first.prepareStart(cancelledTask.id, {
    workspaceId: "workspace-1", streamId: "stream-cancel",
    requestId: "cancel-wins", expectedRevision: cancelledTask.revision,
  });
  const fenced = second.fencePreparedStartCancellation(cancelledTask.id, {
    requestId: "cancel-wins", cancellationRequestId: "cancel-attempt",
    expectedRevision: preparedForCancel.revision,
  });
  assert.throws(() => first.admitPreparedStart(cancelledTask.id, {
    requestId: "cancel-wins", attemptId: "late-launch",
    expectedRevision: preparedForCancel.revision,
  }), /revision conflict|not available for admission/u);
  const cancelled = second.completePreparedStartCancellation(cancelledTask.id, {
    requestId: "cancel-wins", expectedRevision: fenced.revision,
  });
  assert.equal(cancelled.status, "open");

  const launchedTask = first.create({ text: "Launch wins" });
  const preparedForLaunch = first.prepareStart(launchedTask.id, {
    workspaceId: "workspace-1", streamId: "stream-launch",
    requestId: "launch-wins", expectedRevision: launchedTask.revision,
  });
  const admitted = first.admitPreparedStart(launchedTask.id, {
    requestId: "launch-wins", attemptId: "winning-launch",
    expectedRevision: preparedForLaunch.revision,
  });
  assert.equal(admitted.startEffectState, "admitted");
  assert.throws(() => second.fencePreparedStartCancellation(launchedTask.id, {
    requestId: "launch-wins", cancellationRequestId: "late-cancel",
    expectedRevision: admitted.revision,
  }), /already admitted/u);
  } finally {
    second.close();
  }
});

test("startup migration classifies a legacy unlaunched owner as prepared", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-launch-state-migration-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = new TaskBoardStore({ databaseFile });
  const created = store.create({ text: "Legacy prepared launch" });
  const prepared = store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "planned-legacy", requestId: "legacy-request",
    expectedRevision: created.revision,
  });
  store.close();
  const legacy = new DatabaseSync(databaseFile);
  legacy.prepare(
    "UPDATE hub_board_tasks SET start_effect_state = NULL, start_effect_owner_id = NULL WHERE id = ?",
  ).run(created.id);
  legacy.close();

  store = new TaskBoardStore({ databaseFile });
  const migrated = store.task(created.id);
  assert.ok(migrated.revision >= prepared.revision);
  assert.equal(migrated.startEffectState, "prepared");
  assert.equal(migrated.startEffectOwnerId, null);
  store.close();
});

test("Task mutation queue retries the owning transaction without blocking timers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-contention-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const store = new TaskBoardStore({ databaseFile });
  const created = store.create({ text: "Before contention" });
  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
    blocker.exec("COMMIT");
  }, 60);
  t.after(async () => {
    clearTimeout(timer);
    try { blocker.exec("ROLLBACK"); } catch {}
    blocker.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const updated = await store.runMutation(
    () => store.updatePresentation(created.id, { title: "After contention", description: "" }),
    { requestId: "task-contention", timeoutMs: 1_000 },
  );
  assert.equal(timerFired, true);
  assert.equal(updated.title, "After contention");
  assert.ok(store.mutationDiagnostics().retries > 0);
});

test("delete transition keeps the Task durable until cleanup is confirmed successful", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "Crash-safe delete" });
  store.beginLifecycleTransition(created.id, {
    operationId: "delete-1", kind: "delete", expectedRevision: created.revision,
  });
  assert.equal(store.task(created.id).id, created.id);
  store.failLifecycleTransition("delete-1", new Error("cleanup failed"));
  assert.equal(store.task(created.id).status, "open");

  store.beginLifecycleTransition(created.id, {
    operationId: "delete-2", kind: "delete", expectedRevision: store.task(created.id).revision,
  });
  assert.equal(store.finalizeCleanupTransition("delete-2", { deleteTask: true }).deleted, true);
  assert.equal(store.task(created.id), null);
});

test("status integration records a Git result without fabricating a provider turn", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Integrate Task status" });
  const projectRoot = path.resolve("D:/repo");
  const resultCommit = "b".repeat(40);

  const recorded = store.recordTaskGitReference({
    taskId: task.id,
    projectRoot,
    branch: taskBranchName(task.id, projectRoot),
    resultSnapshot: { repoRoot: projectRoot, tree: resultCommit },
  });

  assert.deepEqual(recorded.gitReferences, [{
    projectRoot,
    branch: taskBranchName(task.id, projectRoot),
    resultCommit,
  }]);
  assert.deepEqual(recorded.workLog, []);
});

test("legacy Git adoption is CAS-guarded and keeps an immutable audit", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "Legacy Await" });
  store.move(created.id, { bucket: "workspace", workspaceId: "workspace-1" });
  const prepared = store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "legacy-start",
  });
  const admitted = admit(store, prepared, "legacy-start");
  store.markStarted(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "legacy-start",
    attemptId: "attempt-legacy-start", expectedRevision: admitted.revision,
  });
  const awaiting = store.setWorkflowStatus(created.id, "awaiting_implementation");
  const projectRoot = path.resolve("D:/repo");
  const adopted = store.adoptLegacyGitReference({
    taskId: created.id,
    expectedRevision: awaiting.revision,
    projectRoot,
    branch: "HUB-98",
    reportedResultCommit: "a".repeat(40),
    mainResultCommit: "b".repeat(40),
    patchId: "c".repeat(40),
    evidenceStreamId: "stream-1",
    evidenceProvider: "codex",
    evidenceThreadId: "thread-1",
    evidenceTurnId: "turn-1",
    actorStreamId: "releaseManager-stream",
    actorProvider: "codex",
    actorThreadId: "releaseManager-thread",
    requestId: "adopt-1",
  });

  assert.deepEqual(adopted.gitReferences, [{
    projectRoot,
    branch: "HUB-98",
    resultCommit: "b".repeat(40),
  }]);
  assert.equal(adopted.gitAdoptions.length, 1);
  assert.equal(adopted.gitAdoptions[0].reportedResultCommit, "a".repeat(40));
  assert.equal(adopted.gitAdoptions[0].evidenceTurnId, "turn-1");
  assert.throws(() => store.adoptLegacyGitReference({
    taskId: created.id,
    expectedRevision: awaiting.revision,
    projectRoot,
  }), /revision changed|already has Git evidence/u);

  store.close();
  const inspected = new DatabaseSync(store.databaseFile);
  assert.throws(
    () => inspected.prepare("DELETE FROM hub_task_legacy_git_adoptions").run(),
    /legacy Git adoption audit is immutable/u,
  );
  inspected.close();
});

test("Task store deduplicates Telegram updates and persists capture mode", async (t) => {
  const store = await fixture(t);
  const first = store.create({ text: "  Купить молоко ", source: "telegram", sourceKey: "telegram:1:2" });
  const duplicate = store.create({ text: "Другой текст", source: "telegram", sourceKey: "telegram:1:2" });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.rawText, "Купить молоко");
  assert.equal(duplicate.title, "Купить молоко");
  assert.equal(duplicate.description, "");
  assert.equal(store.captureEnabled(1), false);
  store.setCaptureEnabled(1, true);
  assert.equal(store.captureEnabled(1), true);
});

test("Task store can persist disabled Spark triage", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Сохранить без Spark", triageStatus: "disabled" });
  assert.equal(task.triageStatus, "disabled");
  assert.equal(store.pendingTriage().length, 0);
});

test("restarting a closed Task clears its completion timestamp", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Исправить запуск" });
  const completed = store.complete(task.id);
  const prepared = store.prepareStart(task.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "restart-closed",
  });
  const admitted = admit(store, prepared, "restart-closed");
  const restarted = store.markStarted(task.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "restart-closed",
    attemptId: "attempt-restart-closed", expectedRevision: admitted.revision,
  });

  assert.equal(completed.status, "done");
  assert.equal(completed.workflowStatus, "new");
  assert.notEqual(completed.completedAt, null);
  assert.equal(restarted.status, "started");
  assert.equal(restarted.workflowStatus, "in_progress");
  assert.equal(restarted.completedAt, null);
});

test("generic Task statuses remain directly editable", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "Провести задачу по статусам" });
  assert.equal(created.workflowStatus, "new");

  const prepared = store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "editable-start",
  });
  const admitted = admit(store, prepared, "editable-start");
  const started = store.markStarted(created.id, {
    workspaceId: "workspace-1", streamId: "stream-1", requestId: "editable-start",
    attemptId: "attempt-editable-start", expectedRevision: admitted.revision,
  });
  assert.equal(started.workflowStatus, "in_progress");
  assert.equal(store.setWorkflowStatus(created.id, "testing").workflowStatus, "testing");
  assert.equal(
    store.setWorkflowStatus(created.id, "awaiting_implementation").workflowStatus,
    "awaiting_implementation",
  );

  const completed = store.complete(created.id);
  assert.equal(completed.status, "done");
  assert.equal(completed.workflowStatus, "awaiting_implementation");
  assert.notEqual(completed.completedAt, null);

  const reopened = store.setWorkflowStatus(created.id, "testing");
  assert.equal(reopened.status, "started");
  assert.equal(reopened.workflowStatus, "testing");
  assert.equal(reopened.completedAt, null);
  assert.throws(() => store.setWorkflowStatus(created.id, "unknown"), /Неизвестный статус/u);
});

test("durable reassignment keeps the old executor until the new launch succeeds", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "Переназначить Task" });
  const initialPrepared = store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-old", requestId: "initial-start",
  });
  const initialAdmitted = admit(store, initialPrepared, "initial-start");
  store.markStarted(created.id, {
    workspaceId: "workspace-1", streamId: "stream-old", requestId: "initial-start",
    attemptId: "attempt-initial-start", expectedRevision: initialAdmitted.revision,
  });

  const prepared = store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-new", requestId: "reassign-1", reassign: true,
  });
  assert.equal(prepared.status, "started");
  assert.equal(prepared.streamId, "stream-old");

  const admittedReassign = admit(store, prepared, "reassign-1");
  const cancelled = store.cancelPreparedStart(created.id, {
    requestId: "reassign-1", reassign: true,
    attemptId: "attempt-reassign-1", expectedRevision: admittedReassign.revision,
  });
  assert.equal(cancelled.status, "started");
  assert.equal(cancelled.streamId, "stream-old");

  const secondPrepared = store.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-new", requestId: "reassign-2", reassign: true,
  });
  const secondAdmitted = admit(store, secondPrepared, "reassign-2");
  const reassigned = store.markStarted(created.id, {
    workspaceId: "workspace-1", streamId: "stream-new", requestId: "reassign-2",
    attemptId: "attempt-reassign-2", expectedRevision: secondAdmitted.revision,
  });
  assert.equal(reassigned.status, "started");
  assert.equal(reassigned.streamId, "stream-new");
});

test("Task store attaches a screenshot to the Task addressed by a Telegram reply", async (t) => {
  const store = await fixture(t);
  const task = store.create({
    text: "FB Миллениум",
    source: "telegram",
    sourceDetails: { chatId: 42, userId: 42, messageId: 7 },
  });
  const attached = store.attachToSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 7,
    attachments: ["D:/attachments/screenshot.jpg", "D:/attachments/screenshot.jpg"],
  });
  assert.equal(attached.id, task.id);
  assert.deepEqual(attached.sourceDetails.attachments, ["D:/attachments/screenshot.jpg"]);
  assert.equal(store.list().length, 1);
});

test("Task store appends Telegram reply clarifications to one Task, including reply chains", async (t) => {
  const store = await fixture(t);
  const task = store.create({
    text: "ЭКЗАМЕНЫ",
    source: "telegram",
    sourceKey: "shared-dashboard:101",
    sourceDetails: { chatId: 42, userId: 42, messageId: 2 },
  });
  const firstReply = store.appendSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 2,
    text: "надо сдать..",
    sourceDetails: { chatId: 42, userId: 42, messageId: 3, replyToMessageId: 2 },
  });
  const secondReply = store.appendSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 3,
    text: "до пятницы",
    sourceDetails: { chatId: 42, userId: 42, messageId: 4, replyToMessageId: 3 },
  });

  assert.equal(firstReply.id, task.id);
  assert.equal(secondReply.id, task.id);
  assert.equal(store.list().length, 1);
  assert.match(secondReply.rawText, /Сообщение 1 · Вы[\s\S]*ЭКЗАМЕНЫ/u);
  assert.match(secondReply.rawText, /Сообщение 2 · Вы[\s\S]*надо сдать/u);
  assert.match(secondReply.rawText, /Сообщение 3 · Вы[\s\S]*до пятницы/u);
  assert.deepEqual(secondReply.sourceDetails.messageIds, [2, 3, 4]);
});

test("Task store merges a following forward into the preceding Telegram Task", async (t) => {
  const store = await fixture(t);
  const task = store.create({
    text: "КЭМЗ",
    source: "telegram",
    sourceKey: "shared-dashboard:798",
    sourceDetails: { updateId: 798, chatId: 42, userId: 42, messageId: 18 },
  });
  const text = "--- Сообщение 1 · Вы ---\nКЭМЗ\n\n--- Сообщение 2 · Переслано · Иван ---\nКонтекст";
  const merged = store.mergeSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 18,
    text,
    sourceDetails: { bundleId: "bundle-1", chatId: 42, userId: 42, messageCount: 2 },
  });
  assert.equal(merged.id, task.id);
  assert.equal(merged.rawText, text);
  assert.equal(merged.sourceKey, "shared-dashboard:798");
  assert.equal(merged.sourceDetails.messageId, 18);
  assert.equal(merged.sourceDetails.bundleId, "bundle-1");
  assert.equal(merged.triageStatus, "pending");
  assert.equal(store.list().length, 1);
});

test("manual Task placement is not overwritten by a late Spark result", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "посмотреть дюну" });
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-manual" });
  const triaged = store.applyTriage(task.id, {
    title: "Посмотреть «Дюну»",
    description: "",
    correctedText: "Посмотреть «Дюну»",
    category: "note",
    confidence: 0.98,
    bucket: "notes",
    autoPlace: true,
  });
  assert.equal(triaged.correctedText, "Посмотреть «Дюну»");
  assert.equal(triaged.title, "Посмотреть «Дюну»");
  assert.equal(triaged.description, "");
  assert.equal(triaged.bucket, "workspace");
  assert.equal(triaged.workspaceId, "workspace-manual");
  assert.equal(triaged.placementSource, "manual");
});

test("Task store removes legacy bundle instructions and schedules open Tasks for new triage", async (t) => {
  const store = await fixture(t);
  const prefix = [
    "Ниже пакет сообщений, собранный пользователем в Telegram.",
    "Сохраняй порядок и авторов. Пересланные реплики — контекст третьих лиц; не путай их с прямыми комментариями пользователя, отмеченными «Вы».",
    "",
  ].join("\n");
  const created = store.create({
    text: `${prefix}\n--- Сообщение 1 · Переслано · Клиент ---\nИсправить дату`,
    source: "telegram",
    sourceKey: "shared-dashboard:legacy",
    triageStatus: "disabled",
  });
  const migrated = store.task(created.id);
  assert.equal(migrated.rawText, "--- Сообщение 1 · Переслано · Клиент ---\nИсправить дату");
  assert.equal(migrated.title, "Исправить дату");
  assert.equal(migrated.triageStatus, "pending");
});

test("long Tasks persist a separate Spark title and description", async (t) => {
  const store = await fixture(t);
  const text = "Первая строка с контекстом\nВторая строка с подробностями задачи";
  const task = store.create({ text });
  assert.equal(task.title, "Первая строка с контекстом");
  assert.equal(task.description, text);
  const triaged = store.applyTriage(task.id, {
    title: "Проверить многострочную задачу",
    description: "Полное уточнённое описание задачи",
    correctedText: text,
    category: "task",
    confidence: 0.9,
  });
  assert.equal(triaged.rawText, text);
  assert.equal(triaged.title, "Проверить многострочную задачу");
  assert.equal(triaged.description, "Полное уточнённое описание задачи");
});

test("manual Task edits persist and win over a late Spark result", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "исходная задача" });
  const edited = store.updatePresentation(task.id, {
    title: "Исправить дату документа",
    description: "Дата должна совпадать с моментом проведения.",
  });
  assert.equal(edited.rawText, "исходная задача");
  assert.equal(edited.title, "Исправить дату документа");
  assert.equal(edited.description, "Дата должна совпадать с моментом проведения.");
  assert.equal(edited.correctedText, "Исправить дату документа\n\nДата должна совпадать с моментом проведения.");

  const triaged = store.applyTriage(task.id, {
    title: "Запоздалый заголовок Spark",
    description: "Запоздалое описание Spark",
    correctedText: "Запоздалый текст Spark",
    category: "task",
    confidence: 0.9,
  });
  assert.equal(triaged.rawText, "исходная задача");
  assert.equal(triaged.title, edited.title);
  assert.equal(triaged.description, edited.description);
  assert.equal(triaged.correctedText, edited.correctedText);
});

test("Workspace placement allocates stable sequential Task numbers", async (t) => {
  const store = await fixture(t);
  const direct = store.create({
    text: "Создана в Workspace", bucket: "workspace", workspaceId: "workspace-hub", taskPrefix: "HUB",
  });
  const backlog = store.create({ text: "Перемещена из Backlog" });
  const moved = store.move(backlog.id, {
    bucket: "workspace", workspaceId: "workspace-hub", taskPrefix: "HUB",
  });

  assert.equal(direct.taskNumber, "HUB-1");
  assert.equal(moved.taskNumber, "HUB-2");
  assert.equal(store.move(direct.id, {
    bucket: "workspace", workspaceId: "workspace-ops", taskPrefix: "OPS",
  }).taskNumber, "HUB-1");

  const edited = store.updatePresentation(moved.id, {
    title: moved.title, description: moved.description, taskNumber: "OPS-20",
  });
  assert.equal(edited.taskNumber, "OPS-20");
  assert.equal(store.create({
    text: "Следующая OPS", bucket: "workspace", workspaceId: "workspace-ops", taskPrefix: "OPS",
  }).taskNumber, "OPS-21");
  assert.throws(() => store.updatePresentation(direct.id, {
    title: direct.title, taskNumber: "OPS-20",
  }), /уже используется/u);
});

test("automatic placement, Workspace reassignment and backfill allocate numbers", async (t) => {
  const store = await fixture(t);
  const automatic = store.create({ text: "Автоматическая сортировка" });
  const triaged = store.applyTriage(automatic.id, {
    title: "Автоматическая сортировка",
    description: "",
    correctedText: "Автоматическая сортировка",
    category: "task",
    confidence: 0.95,
    bucket: "workspace",
    workspaceId: "workspace-auto",
    taskPrefix: "AUTO",
    autoPlace: true,
  });
  assert.equal(triaged.taskNumber, "AUTO-1");

  const reassigned = store.create({
    text: "Переезд Workspace", bucket: "workspace", workspaceId: "workspace-old",
  });
  assert.equal(reassigned.taskNumber, "");
  assert.equal(store.reassignWorkspace("workspace-old", "workspace-new", { taskPrefix: "NEW" }), 1);
  assert.equal(store.task(reassigned.id).taskNumber, "NEW-1");

  const firstLegacy = store.create({
    text: "Первая старая", bucket: "workspace", workspaceId: "workspace-legacy",
  });
  const secondLegacy = store.create({
    text: "Вторая старая", bucket: "workspace", workspaceId: "workspace-legacy",
  });
  assert.equal(store.assignWorkspaceTaskNumbers("workspace-legacy", "LEG"), 2);
  assert.equal(store.task(firstLegacy.id).taskNumber, "LEG-1");
  assert.equal(store.task(secondLegacy.id).taskNumber, "LEG-2");
});

test("Task card order persists within and between columns", async (t) => {
  const store = await fixture(t);
  const first = store.create({ text: "Первая" });
  const second = store.create({ text: "Вторая" });
  const third = store.create({ text: "Третья" });
  for (const task of [first, second, third]) {
    store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  }
  store.move(third.id, {
    bucket: "workspace", workspaceId: "workspace-1", beforeId: first.id,
  });
  store.move(second.id, { bucket: "notes" });

  const reopened = new TaskBoardStore({ databaseFile: store.databaseFile });
  const tasks = reopened.list({ includeDone: false });
  reopened.close();
  assert.deepEqual(
    tasks.filter((task) => task.workspaceId === "workspace-1").map((task) => task.id),
    [third.id, first.id],
  );
  assert.deepEqual(tasks.filter((task) => task.bucket === "notes").map((task) => task.id), [second.id]);
});

test("Workspace and Notes column order persists after reordering", async (t) => {
  const store = await fixture(t);
  assert.equal(store.notesComment(), "");
  assert.deepEqual(store.orderedColumnIds(["one", "two", "three"]), ["one", "two", "three", "notes"]);
  store.moveColumn(["one", "two", "three"], { columnId: "notes", beforeColumnId: "two" });
  store.setNotesComment("Книги и фильмы");

  const reopened = new TaskBoardStore({ databaseFile: store.databaseFile });
  const columnIds = reopened.orderedColumnIds(["one", "two", "three"]);
  const notesComment = reopened.notesComment();
  reopened.close();
  assert.deepEqual(columnIds, ["one", "notes", "two", "three"]);
  assert.equal(notesComment, "Книги и фильмы");
});

test("Workspace removal reassigns its cards and preserves their order", async (t) => {
  const store = await fixture(t);
  const target = store.create({ text: "Target" });
  const first = store.create({ text: "First" });
  const second = store.create({ text: "Second" });
  store.move(target.id, { bucket: "workspace", workspaceId: "workspace-2" });
  store.move(first.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.move(second.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.moveColumn(["workspace-1", "workspace-2"], {
    columnId: "workspace-1",
    beforeColumnId: "workspace-2",
  });

  assert.equal(store.reassignWorkspace("workspace-1", "workspace-2"), 2);
  assert.deepEqual(
    store.list({ includeDone: false })
      .filter((task) => task.workspaceId === "workspace-2")
      .map((task) => task.id),
    [target.id, first.id, second.id],
  );
  assert.deepEqual(store.orderedColumnIds(["workspace-2"]), ["workspace-2", "notes"]);
});

test("repeated Task claim backfills a baseline captured after the first claim", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Claim baseline" });
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  const claim = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1", operationId: "claim-1",
  };
  store.claim(task.id, claim);
  store.claim(task.id, {
    ...claim,
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
  });

  assert.deepEqual(store.claimedTaskForTurn(claim).gitBaseline, {
    repoRoot: projectRoot,
    tree: "a".repeat(40),
  });
});

test("terminal Task evidence backfills a claim baseline captured after claim", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Interrupted evidence" });
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.claim(task.id, {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1", operationId: "claim-1",
  });

  const recorded = store.recordTaskTurn({
    taskId: task.id, provider: "codex", threadId: "thread-1", turnId: "turn-1",
    operationId: "claim-1",
    projectRoot, summary: "Interrupted after edit", status: "interrupted",
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified", turnId: "turn-1" }],
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });

  assert.equal(recorded.workLog[0].changedFiles.length, 1);
  assert.deepEqual(recorded.gitReferences, [{
    projectRoot,
    branch: taskBranchName(task.id, projectRoot),
    resultCommit: "b".repeat(40),
  }]);
});

test("one provider turn switches Tasks with exact reorder-safe operation evidence", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const first = store.create({ text: "First operation" });
  const second = store.create({ text: "Second operation" });
  for (const task of [first, second]) {
    store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  }
  const turn = {
    workspaceId: "workspace-1",
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
  };

  store.claim(first.id, { ...turn, operationId: "claim-first" });
  assert.equal(store.claimBindingForOperation("missing-claim"), null);
  const firstBinding = store.claimBindingForOperation("claim-first");
  assert.deepEqual({ ...firstBinding, claimedAtMs: null }, {
    taskId: first.id,
    workspaceId: "workspace-1",
    provider: turn.provider,
    threadId: turn.threadId,
    turnId: turn.turnId,
    operationId: "claim-first",
    operationKind: "claim",
    claimedAtMs: null,
  });
  assert.equal(Number.isInteger(firstBinding.claimedAtMs), true);
  assert.throws(
    () => store.recordTaskTurn({
      taskId: first.id,
      provider: turn.provider,
      threadId: turn.threadId,
      turnId: turn.turnId,
      operationId: "unknown-operation",
      projectRoot,
    }),
    /exact durable provider operation binding/u,
  );

  store.claim(second.id, { ...turn, operationId: "claim-second" });
  assert.equal(store.claimedTaskForTurn(turn).id, second.id);

  store.recordTaskTurn({
    taskId: first.id,
    provider: turn.provider,
    threadId: turn.threadId,
    turnId: turn.turnId,
    operationId: "claim-first",
    projectRoot,
    changedFiles: [{ projectRoot, path: "src/first.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });
  assert.equal(store.claimedTaskForTurn(turn).id, second.id);

  store.claim(first.id, { ...turn, operationId: "claim-first-again" });
  store.recordTaskTurn({
    taskId: second.id,
    provider: turn.provider,
    threadId: turn.threadId,
    turnId: turn.turnId,
    operationId: "claim-second",
    projectRoot,
    changedFiles: [{ projectRoot, path: "src/second.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "c".repeat(40) },
  });
  assert.equal(store.claimedTaskForTurn(turn).id, first.id);

  store.recordTaskTurn({
    taskId: first.id,
    provider: turn.provider,
    threadId: turn.threadId,
    turnId: turn.turnId,
    operationId: "claim-first-again",
    projectRoot,
    changedFiles: [{ projectRoot, path: "src/follow-up.mjs", operation: "added" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "d".repeat(40) },
  });

  assert.deepEqual(store.task(first.id).workLog.map((entry) => entry.operationId), [
    "claim-first",
    "claim-first-again",
  ]);
  assert.equal(store.claimedTaskForTurn(turn).id, first.id);
  assert.equal(store.claimedTaskForTurn({ ...turn, operationId: "claim-second" }).id, second.id);
});

test("Await Tasks expose only their immutable Git references to the release planner", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const ready = store.create({ text: "Ready Task" });
  const blocked = store.create({ text: "Blocked Task" });
  for (const task of [ready, blocked]) {
    store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  }
  store.claim(ready.id, {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1", operationId: "claim-1",
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
  });
  store.recordTaskTurn({
    taskId: ready.id, provider: "codex", threadId: "thread-1", turnId: "turn-1",
    operationId: "claim-1",
    projectRoot, status: "completed",
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });
  store.setWorkflowStatus(ready.id, "awaiting_implementation");
  store.setWorkflowStatus(blocked.id, "awaiting_implementation");

  const releaseTasks = store.releaseTasks("workspace-1");
  assert.equal(releaseTasks.find((task) => task.id === ready.id).gitReferences.length, 1);
  assert.deepEqual(releaseTasks.find((task) => task.id === blocked.id).gitReferences, []);
});

test("a new Await request preserves accepted evidence until replacement integration succeeds", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Retry integration" });
  const identity = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1", operationId: "claim-1",
  };
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.claim(task.id, {
    ...identity,
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
  });
  store.recordTaskTurn({
    taskId: task.id, provider: identity.provider, threadId: identity.threadId, turnId: identity.turnId,
    operationId: identity.operationId,
    projectRoot, status: "completed",
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });
  store.setWorkflowStatus(task.id, "awaiting_implementation");
  const accepted = store.task(task.id).gitReferences;
  assert.equal(accepted.length, 1);

  store.requestWorkflowStatus(task.id, {
    status: "awaiting_implementation",
    provider: identity.provider,
    threadId: identity.threadId,
    turnId: identity.turnId,
    operationId: identity.operationId,
  });

  assert.deepEqual(store.task(task.id).gitReferences, accepted);
});

test("rolling a Task back clears its pending awaiting intent", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Rollback awaiting" });
  const identity = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1", operationId: "claim-1",
  };
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.claim(task.id, identity);
  assert.equal(store.requestWorkflowStatus(task.id, {
    status: "awaiting_implementation",
    provider: identity.provider,
    threadId: identity.threadId,
    turnId: identity.turnId,
    operationId: identity.operationId,
  }).workflowStatus, "awaiting_implementation");
  assert.equal(store.claimedTaskForTurn(identity).requestedWorkflowStatus, "awaiting_implementation");

  assert.equal(store.setWorkflowStatus(task.id, "testing").workflowStatus, "testing");
  assert.equal(store.claimedTaskForTurn(identity).requestedWorkflowStatus, null);
});

test("recording evidence never overrides a user-selected workflow status", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Preserve status" });
  const identity = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1", operationId: "claim-1",
  };
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.claim(task.id, {
    ...identity,
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
  });
  store.setWorkflowStatus(task.id, "done");
  const recorded = store.recordTaskTurn({
    taskId: task.id,
    provider: identity.provider,
    threadId: identity.threadId,
    turnId: identity.turnId,
    operationId: identity.operationId,
    projectRoot,
    summary: "Evidence captured",
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });

  assert.equal(recorded.workflowStatus, "done");
  assert.equal(recorded.workLog[0].changedFiles.length, 1);
  assert.equal(recorded.workLog.length, 1);
  assert.equal(recorded.gitReferences.length, 1);
});

test("legacy Task evidence tables migrate atomically to one Git reference", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-evidence-migration-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = new TaskBoardStore({ databaseFile });
  const task = initial.create({ text: "Migrate evidence" });
  initial.close();

  const projectRoot = path.resolve("D:/repo");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE hub_task_repository_revisions (
      task_id TEXT NOT NULL, project_root TEXT NOT NULL,
      baseline_revision TEXT NOT NULL, result_revision TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, project_root)
    ) WITHOUT ROWID;
    CREATE TABLE hub_task_changed_files (
      task_id TEXT NOT NULL, project_root TEXT NOT NULL, file_path TEXT NOT NULL,
      operation TEXT NOT NULL, turn_id TEXT, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, project_root, file_path)
    ) WITHOUT ROWID;
  `);
  database.prepare("INSERT INTO hub_task_repository_revisions VALUES (?, ?, ?, ?, ?)").run(
    task.id, projectRoot, "a".repeat(40), "b".repeat(40), 123,
  );
  database.prepare("INSERT INTO hub_task_changed_files VALUES (?, ?, ?, 'modified', NULL, ?)").run(
    task.id, projectRoot, "src/app.mjs", 123,
  );
  database.close();

  const migrated = new TaskBoardStore({ databaseFile });
  assert.deepEqual(migrated.task(task.id).gitReferences, [{
    projectRoot,
    branch: taskBranchName(task.id, projectRoot),
    resultCommit: "b".repeat(40),
  }]);
  migrated.close();

  const inspected = new DatabaseSync(databaseFile);
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS value FROM sqlite_master
    WHERE type = 'table' AND name IN ('hub_task_repository_revisions', 'hub_task_changed_files')
  `).get().value, 0);
  const history = inspected.prepare(`
    SELECT source_kind, payload_json, payload_sha256 FROM hub_release_registry_history
    WHERE source_kind IN ('task-repository-revision-v3', 'task-changed-file-v3')
    ORDER BY source_kind
  `).all();
  assert.equal(history.length, 2);
  for (const row of history) {
    assert.equal(row.payload_sha256, createHash("sha256").update(row.payload_json, "utf8").digest("hex"));
  }
  inspected.close();
});

test("turn-scoped Task bindings migrate to operation-scoped evidence", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-operation-migration-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = new TaskBoardStore({ databaseFile });
  const projectRoot = path.resolve("D:/repo");
  const first = initial.create({ text: "Legacy binding" });
  const second = initial.create({ text: "Next binding" });
  for (const task of [first, second]) {
    initial.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  }
  const turn = {
    workspaceId: "workspace-1",
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    operationId: "old-operation",
  };
  initial.claim(first.id, turn);
  initial.recordTaskTurn({
    taskId: first.id,
    provider: turn.provider,
    threadId: turn.threadId,
    turnId: turn.turnId,
    operationId: turn.operationId,
    projectRoot,
    changedFiles: [{ projectRoot, path: "src/legacy.mjs", operation: "modified" }],
  });
  initial.close();

  const database = new DatabaseSync(databaseFile);
  database.exec(`
    DROP INDEX IF EXISTS hub_task_turn_bindings_active_idx;
    DROP INDEX IF EXISTS hub_task_turn_bindings_task_idx;
    DROP INDEX IF EXISTS hub_task_work_log_task_idx;
    ALTER TABLE hub_task_turn_bindings RENAME TO hub_task_turn_bindings_operation_scope;
    CREATE TABLE hub_task_turn_bindings (
      task_id TEXT NOT NULL, provider TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, baseline_json TEXT NOT NULL DEFAULT '{}',
      requested_workflow_status TEXT, claimed_at_ms INTEGER NOT NULL, terminal_at_ms INTEGER,
      PRIMARY KEY (provider, provider_thread_id, turn_id),
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    INSERT INTO hub_task_turn_bindings
      SELECT task_id, provider, provider_thread_id, turn_id, baseline_json,
        requested_workflow_status, claimed_at_ms, terminal_at_ms
      FROM hub_task_turn_bindings_operation_scope;
    DROP TABLE hub_task_turn_bindings_operation_scope;
    ALTER TABLE hub_task_work_log RENAME TO hub_task_work_log_operation_scope;
    CREATE TABLE hub_task_work_log (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, project_root TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      changed_files_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE,
      UNIQUE (task_id, provider, provider_thread_id, turn_id)
    ) WITHOUT ROWID;
    INSERT INTO hub_task_work_log
      SELECT id, task_id, provider, provider_thread_id, turn_id, project_root,
        summary, status, changed_files_json, created_at_ms
      FROM hub_task_work_log_operation_scope;
    DROP TABLE hub_task_work_log_operation_scope;
  `);
  database.close();

  const migrated = new TaskBoardStore({ databaseFile });
  const legacyOperationId = `legacy:${first.id}`;
  assert.equal(migrated.claimedTaskForTurn({
    provider: turn.provider,
    threadId: turn.threadId,
    turnId: turn.turnId,
  }).operationId, legacyOperationId);
  assert.equal(migrated.task(first.id).workLog[0].operationId, legacyOperationId);
  assert.equal(migrated.claim(second.id, {
    ...turn,
    operationId: "next-operation",
  }).id, second.id);
  migrated.close();
});

test("release completion CAS-checks the exact Task Git reference", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Publish commit" });
  const identity = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1", operationId: "claim-1",
  };
  store.move(task.id, { bucket: "workspace", workspaceId: identity.workspaceId });
  store.claim(task.id, identity);
  store.recordTaskTurn({
    taskId: task.id,
    provider: identity.provider,
    threadId: identity.threadId,
    turnId: identity.turnId,
    operationId: identity.operationId,
    projectRoot,
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });
  store.setWorkflowStatus(task.id, "awaiting_implementation");
  const candidate = store.task(task.id);
  const plan = {
    revision: taskReleasePlanRevision(identity.workspaceId, [candidate]),
    candidates: [{
      ...candidate,
      changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    }],
  };

  const result = store.completeRelease(identity.workspaceId, {
    expectedPlanRevision: plan.revision,
    plan,
    verificationEvidence: { publishedRevision: "c".repeat(40) },
    awaitRebuild: {
      planRevision: plan.revision,
      fallbackProjectRoots: [projectRoot],
    },
  });
  assert.deepEqual(result.released[0].gitReferences, candidate.gitReferences);
  assert.equal(store.task(task.id).workflowStatus, "done");
  assert.deepEqual(store.awaitRebuildPending(identity.workspaceId), {
    planRevision: plan.revision,
    fallbackProjectRoots: [projectRoot],
  });
  assert.equal(store.clearAwaitRebuildPending(identity.workspaceId), true);
  assert.equal(store.awaitRebuildPending(identity.workspaceId), null);
});

function createLegacyReleaseSchema(database) {
  database.exec(`
    CREATE TABLE hub_release_changes (
      id TEXT PRIMARY KEY, workspace_id TEXT, stream_id TEXT, provider TEXT,
      provider_thread_id TEXT, turn_id TEXT, project_root TEXT, summary TEXT,
      status TEXT, files_json TEXT, observed_files_json TEXT, revision INTEGER, created_at_ms INTEGER
    );
    CREATE TABLE hub_release_batches (id TEXT PRIMARY KEY, status TEXT, created_at_ms INTEGER);
    CREATE TABLE hub_release_change_sets (
      id TEXT PRIMARY KEY, task_id TEXT, workspace_id TEXT, owner_stream_id TEXT,
      title TEXT, status TEXT, revision INTEGER, manifest_hash TEXT,
      repository_evidence_json TEXT, created_at_ms INTEGER
    );
    CREATE TABLE hub_release_turn_observations (
      id TEXT PRIMARY KEY, change_set_id TEXT, legacy_release_change_id TEXT,
      provider TEXT, provider_thread_id TEXT, turn_id TEXT, project_root TEXT,
      summary TEXT, files_json TEXT, created_at_ms INTEGER
    );
    CREATE TABLE hub_release_change_set_files (
      change_set_id TEXT, project_root TEXT, file_path TEXT, operation TEXT,
      base_blob TEXT, result_blob TEXT, patch_hash TEXT,
      PRIMARY KEY (change_set_id, project_root, file_path)
    );
    CREATE TABLE hub_release_change_set_bindings (stream_id TEXT PRIMARY KEY, change_set_id TEXT);
    CREATE TABLE hub_release_change_set_events (
      id TEXT PRIMARY KEY, change_set_id TEXT, event_type TEXT, payload_json TEXT, created_at_ms INTEGER
    );
  `);
}

function seedProductionShapeLegacyRelease(database) {
  createLegacyReleaseSchema(database);
  const insertChangeSet = database.prepare(`
    INSERT INTO hub_release_change_sets VALUES (?, NULL, 'workspace-1', ?, ?, ?, 2, ?, ?, ?)
  `);
  for (let index = 0; index < 11; index += 1) {
    const verified = index < 2;
    insertChangeSet.run(
      `changeset-${index}`, `stream-${index}`, `ChangeSet ${index}`,
      verified ? "ready" : "draft",
      verified ? String(index + 1).repeat(64).slice(0, 64) : "",
      verified ? JSON.stringify([{
        projectRoot: "D:/repo", baseRevision: "a".repeat(40), resultRevision: "b".repeat(40),
      }]) : "[]",
      100 + index,
    );
  }
  const insertLegacy = database.prepare(`
    INSERT INTO hub_release_changes VALUES (?, 'workspace-1', ?, 'codex', ?, ?, 'D:/repo', ?, ?, ?, ?, 1, ?)
  `);
  const insertObservation = database.prepare(`
    INSERT INTO hub_release_turn_observations VALUES (?, ?, ?, 'codex', ?, ?, 'D:/repo', ?, ?, ?)
  `);
  for (let index = 0; index < 13; index += 1) {
    const files = index < 3 ? JSON.stringify([`legacy/path-${index}.mjs`]) : "[]";
    insertLegacy.run(
      `legacy-${index}`, `stream-${index % 7}`, `thread-${index}`, `turn-${index}`,
      `Legacy ${index}`, index < 3 ? "ready" : "draft", files, files, 200 + index,
    );
    insertObservation.run(
      `observation-${index}`, `changeset-${index % 7}`, `legacy-${index}`,
      `thread-${index}`, `turn-${index}`, `Observed ${index}`,
      JSON.stringify([`observed/path-${index}.mjs`]), 300 + index,
    );
  }
  const insertFile = database.prepare("INSERT INTO hub_release_change_set_files VALUES (?, 'D:/repo', ?, ?, ?, ?, ?)");
  for (let index = 0; index < 2; index += 1) {
    insertFile.run(
      `changeset-${index}`, `src/verified-${index}.mjs`, "modified",
      "c".repeat(40), "d".repeat(40), "e".repeat(64),
    );
    database.prepare("INSERT INTO hub_release_change_set_events VALUES (?, ?, 'changeset.frozen', ?, ?)").run(
      `event-${index}`, `changeset-${index}`,
      JSON.stringify({ verification: { verifier: { name: "git", version: "1" } } }), 400 + index,
    );
  }
  insertFile.run("changeset-2", "src/observed-only.mjs", "observed", "", "", "");
  database.prepare("INSERT INTO hub_release_change_set_bindings VALUES ('stream-0', 'changeset-0')").run();
  database.prepare("INSERT INTO hub_release_batches VALUES ('batch-1', 'released', 500)").run();
}

test("Legacy cutover maps production union to Tasks and retains verified immutable history", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-release-migration-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databaseFile);
  seedProductionShapeLegacyRelease(database);
  database.close();

  const store = new TaskBoardStore({ databaseFile });
  const migrated = store.list().filter((task) => task.source === "release-registry-migration");
  assert.equal(migrated.length, 11);
  assert.equal(migrated.filter((task) => task.workflowStatus === "awaiting_implementation").length, 2);
  assert.equal(migrated.filter((task) => task.workflowStatus === "in_progress").length, 9);
  assert.deepEqual(
    migrated.find((task) => task.sourceKey === "release-migration:changeset:changeset-2").gitReferences,
    [],
  );
  assert.equal(
    migrated.find((task) => task.sourceKey === "release-migration:changeset:changeset-0").workLog.length,
    2,
  );
  store.close();

  const inspected = new DatabaseSync(databaseFile);
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS value FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'hub_release_changes', 'hub_release_batches', 'hub_release_change_sets',
      'hub_release_turn_observations', 'hub_release_change_set_files',
      'hub_release_change_set_bindings', 'hub_release_change_set_events',
      'hub_task_release_state', 'hub_task_release_revisions',
      'hub_task_release_revision_files', 'hub_task_release_completions'
    )
  `).get().value, 0);
  const history = inspected.prepare(`
    SELECT source_kind, source_id, payload_json, payload_sha256
    FROM hub_release_registry_history ORDER BY source_kind, source_id
  `).all();
  assert.equal(history.length, 59);
  for (const row of history) {
    assert.equal(
      row.payload_sha256,
      createHash("sha256").update(row.payload_json, "utf8").digest("hex"),
    );
  }
  inspected.close();

  const reopened = new TaskBoardStore({ databaseFile });
  assert.equal(reopened.list().filter((task) => task.source === "release-registry-migration").length, 11);
  reopened.close();

  const reinspected = new DatabaseSync(databaseFile);
  assert.equal(reinspected.prepare(`
    SELECT COUNT(*) AS value FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'hub_release_changes', 'hub_release_batches', 'hub_release_change_sets',
      'hub_release_turn_observations', 'hub_release_change_set_files',
      'hub_release_change_set_bindings', 'hub_release_change_set_events',
      'hub_task_release_state', 'hub_task_release_revisions',
      'hub_task_release_revision_files', 'hub_task_release_completions'
    )
  `).get().value, 0);
  assert.throws(
    () => reinspected.prepare("DELETE FROM hub_release_registry_history").run(),
    /release history is immutable/,
  );
  reinspected.close();
});

test("Completed cutover ignores retired Task state recreated by a previous runtime", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-release-recreated-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const initial = new TaskBoardStore({ databaseFile, now: () => 1_000, idFactory: () => "task-live" });
  const created = initial.create({
    text: "Preserve live Dashboard Task",
    bucket: "workspace",
    workspaceId: "workspace-1",
    taskPrefix: "HUB",
  });
  const initialPrepared = initial.prepareStart(created.id, {
    workspaceId: "workspace-1", streamId: "stream-live", requestId: "cutover-start",
  });
  const initialAdmitted = admit(initial, initialPrepared, "cutover-start");
  const expected = initial.markStarted(created.id, {
    workspaceId: "workspace-1", streamId: "stream-live", requestId: "cutover-start",
    attemptId: "attempt-cutover-start", expectedRevision: initialAdmitted.revision,
  });
  initial.close();

  const archivedPayload = JSON.stringify({
    task_id: created.id,
    revision: 1,
    frozen_revision: 1,
    manifest_hash: "a".repeat(64),
    updated_at_ms: 1_100,
  });
  const previousRuntime = new DatabaseSync(databaseFile);
  previousRuntime.prepare(`
    INSERT INTO hub_release_registry_history (
      source_kind, source_id, status, payload_json, payload_sha256, archived_at_ms
    ) VALUES ('task-state', ?, 'archived', ?, ?, ?)
  `).run(
    created.id,
    archivedPayload,
    createHash("sha256").update(archivedPayload, "utf8").digest("hex"),
    1_200,
  );
  previousRuntime.exec(`
    CREATE TABLE hub_task_release_state (
      task_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      frozen_revision INTEGER,
      manifest_hash TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
  `);
  previousRuntime.prepare(`
    INSERT INTO hub_task_release_state (
      task_id, revision, frozen_revision, manifest_hash, updated_at_ms
    ) VALUES (?, 2, 2, ?, 1_300)
  `).run(created.id, "b".repeat(64));
  previousRuntime.close();

  const reopened = new TaskBoardStore({ databaseFile, now: () => 1_400 });
  const preserved = reopened.task(created.id);
  assert.equal(preserved.title, expected.title);
  assert.equal(preserved.workflowStatus, expected.workflowStatus);
  assert.equal(preserved.workspaceId, expected.workspaceId);
  assert.equal(preserved.streamId, expected.streamId);
  reopened.close();

  const inspected = new DatabaseSync(databaseFile);
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS value FROM sqlite_master
    WHERE type = 'table' AND name = 'hub_task_release_state'
  `).get().value, 0);
  const archive = inspected.prepare(`
    SELECT payload_json, payload_sha256 FROM hub_release_registry_history
    WHERE source_kind = 'task-state' AND source_id = ?
  `).get(created.id);
  assert.equal(archive.payload_json, archivedPayload);
  assert.equal(
    archive.payload_sha256,
    createHash("sha256").update(archivedPayload, "utf8").digest("hex"),
  );
  inspected.close();

  const restarted = new TaskBoardStore({ databaseFile, now: () => 1_500 });
  assert.equal(restarted.task(created.id).workflowStatus, expected.workflowStatus);
  restarted.close();
});

test("Legacy archive checksum mismatch rolls back Task import", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-release-rollback-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databaseFile);
  seedProductionShapeLegacyRelease(database);
  database.exec(`
    CREATE TABLE hub_release_registry_history (
      source_kind TEXT NOT NULL, source_id TEXT NOT NULL, status TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL, migrated_task_id TEXT,
      archived_at_ms INTEGER NOT NULL, PRIMARY KEY (source_kind, source_id)
    ) WITHOUT ROWID;
  `);
  database.prepare("INSERT INTO hub_release_registry_history VALUES ('legacy', 'legacy-0', 'draft', '{}', ?, NULL, 1)")
    .run("0".repeat(64));
  database.close();

  assert.throws(() => new TaskBoardStore({ databaseFile }), /archive checksum mismatch/u);
  const inspected = new DatabaseSync(databaseFile);
  assert.equal(inspected.prepare("SELECT COUNT(*) AS value FROM hub_board_tasks").get().value, 0);
  assert.equal(inspected.prepare("SELECT COUNT(*) AS value FROM hub_board_settings WHERE key = 'task_release_registry_migrated_v1'").get().value, 0);
  inspected.close();
});
