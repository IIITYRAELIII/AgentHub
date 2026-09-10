import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskBoardMutationOwner } from "../../../src/application/sqlite-mutation-owner.mjs";
import { WorkspaceReleaseService } from "../../../src/application/workspace-release-service.mjs";
import { taskReleasePlanRevision } from "../../../src/domain/task-release-snapshot.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t, interruption) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-finalization-recovery-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let raw = new TaskBoardStore({ databaseFile });
  t.after(async () => { raw.close(); await rm(directory, { recursive: true, force: true }); });
  const workspaceId = "workspace-1";
  const projectRoot = path.resolve(directory, "repository");
  const publishedRevision = "a".repeat(40);
  const task = raw.create({ text: "Release exact result", bucket: "workspace", workspaceId });
  raw.recordTaskGitReference({ taskId: task.id, projectRoot, branch: "HUB-182",
    resultSnapshot: { repoRoot: projectRoot, tree: publishedRevision } });
  raw.setWorkflowStatus(task.id, "awaiting_implementation");
  const candidate = raw.task(task.id);
  const plan = { revision: taskReleasePlanRevision(workspaceId, [candidate]), candidates: [candidate],
    ready: [candidate], blocked: [] };
  const request = { workspaceId, expectedPlanRevision: plan.revision, deploymentVerified: true,
    expectedRepositories: [{ projectRoot, revision: publishedRevision }], verificationSummary: "Exact release verified" };
  const calls = { complete: 0, verify: 0, primary: 0, dev: 0, await: 0 };
  const effects = new Set();
  let armed = true;
  const interrupt = (point) => {
    if (armed && point === interruption) { armed = false; throw new Error(`interrupted ${point}`); }
  };
  function createService() {
    const complete = raw.completeRelease.bind(raw);
    raw.completeRelease = (...args) => {
      calls.complete += 1;
      if (interruption === "legacy") args[1].awaitRebuild = {
        planRevision: plan.revision, fallbackProjectRoots: [projectRoot],
      };
      const result = complete(...args);
      interrupt(interruption === "legacy" ? "legacy" : "closed");
      return result;
    };
    const record = raw.recordReleaseFinalizationStage.bind(raw);
    raw.recordReleaseFinalizationStage = (workspace, payload) => {
      interrupt(`before-${payload.stage}`);
      const result = record(workspace, payload);
      interrupt(`after-${payload.stage}`);
      return result;
    };
    return new WorkspaceReleaseService({
      store: createTaskBoardMutationOwner(raw),
      releasePlanner: { plan: async () => plan },
      releaseGitWorkspaces: {
        frozenCandidate: async () => ({ repositoryRoot: projectRoot, planRevision: plan.revision,
          manifestHash: "manifest", baseCommit: "base", preReleaseHead: publishedRevision }),
        synchronizePublishedPrimary: async (args) => {
          assert.deepEqual(args, { projectRoot, publishedRevision, planRevision: plan.revision });
          calls.primary += 1;
          const present = effects.has("primary");
          effects.add("primary");
          return { status: present ? "already_current" : "fast_forwarded", publishedRevision };
        },
      },
      taskGitWorkspaces: { synchronizeMainIntoDev: async (args) => {
        assert.deepEqual(args, { projectRoot, publishedRevision });
        calls.dev += 1;
        const present = effects.has("dev");
        effects.add("dev");
        return { status: present ? "already_current" : "merged", integrated: true };
      } },
      releasePreflight: {
        withAwaitTransition: async (_workspace, operation) => operation(),
        prepareAwaitSet: async (args) => {
          assert.deepEqual(args, { workspaceId, fallbackProjectRoots: [projectRoot] });
          calls.await += 1;
          effects.add("await");
          return { rebuilt: true };
        },
      },
      verifyPublication: async () => {
        calls.verify += 1;
        return { repositories: [{ root: projectRoot, revision: publishedRevision, planRevision: plan.revision,
          manifestHash: "manifest", baseCommit: "base", preReleaseHead: publishedRevision }],
        agentHubPublication: { generation: "generation-1" } };
      },
    });
  }
  return { request, calls, effects, createService, get raw() { return raw; },
    reopen() { raw.close(); raw = new TaskBoardStore({ databaseFile }); return createService(); } };
}

for (const interruption of ["closed", "before-primary", "after-primary", "before-dev", "after-dev", "before-await", "after-await"]) {
  test(`release resumes persisted finalization after ${interruption}`, async (t) => {
    const f = await fixture(t, interruption);
    const stopped = await f.createService().completeRelease(f.request);
    assert.equal(stopped.finalization.status, "retry_required");
    assert.match(stopped.finalization.reason, /interrupted/u);
    assert.equal(f.raw.releaseTasks(f.request.workspaceId)[0].status, "done");
    const pending = f.raw.awaitRebuildPending(f.request.workspaceId);
    assert.equal(pending.version, 2);
    assert.throws(() => f.raw.clearAwaitRebuildPending(f.request.workspaceId, "other-plan"), /revision conflict/u);
    if (interruption !== "after-await") {
      assert.throws(() => f.raw.clearAwaitRebuildPending(f.request.workspaceId, f.request.expectedPlanRevision), /unfinished stages/u);
    }
    // Late Test work is independent of the already closed release membership.
    const later = f.raw.create({ text: "Later Test", bucket: "workspace", workspaceId: f.request.workspaceId });
    f.raw.setWorkflowStatus(later.id, "testing");
    const laterBefore = f.raw.task(later.id);
    const before = { ...f.calls };
    const result = await f.reopen().completeRelease(f.request);
    assert.equal(result.releaseAlreadyCompleted, true);
    assert.equal(result.finalization.status, "completed");
    assert.equal(f.raw.awaitRebuildPending(f.request.workspaceId), null);
    assert.deepEqual(f.raw.task(later.id), laterBefore);
    assert.equal(f.calls.complete, 1);
    assert.equal(f.calls.verify, 2);
    for (const stage of ["primary", "dev", "await"]) {
      const saved = stage === "await" ? pending.awaitResult : pending.repositories[0][stage];
      assert.equal(f.calls[stage] - before[stage], saved?.completed ? 0 : 1);
    }
    assert.deepEqual([...f.effects].sort(), ["await", "dev", "primary"]);
  });
}

test("legacy finalization recovers Await without inventing published synchronization evidence", async (t) => {
  const f = await fixture(t, "legacy");
  await assert.rejects(f.createService().completeRelease(f.request), /interrupted legacy/u);
  const result = await f.reopen().completeRelease(f.request);
  assert.equal(result.finalization.synchronization, "legacy_evidence_unavailable");
  assert.equal(f.calls.primary, 0);
  assert.equal(f.calls.dev, 0);
  assert.equal(f.calls.await, 1);
  assert.equal(f.calls.complete, 1);
});


test("finalization receipts are exact, monotonic and cannot be replaced by a new closure", async (t) => {
  const f = await fixture(t, "after-primary");
  const stopped = await f.createService().completeRelease(f.request);
  assert.equal(stopped.finalization.status, "retry_required");
  const pending = f.raw.awaitRebuildPending(f.request.workspaceId);
  const receipt = { completed: false, result: { status: "manual_required" } };
  assert.equal(f.raw.recordReleaseFinalizationStage(f.request.workspaceId, {
    planRevision: pending.planRevision, stage: "primary", projectRoot: pending.repositories[0].projectRoot, receipt,
  }), false);
  assert.deepEqual(f.raw.awaitRebuildPending(f.request.workspaceId), pending);
  assert.throws(() => f.raw.recordReleaseFinalizationStage(f.request.workspaceId, {
    planRevision: "other-plan", stage: "dev", projectRoot: pending.repositories[0].projectRoot, receipt,
  }), /revision conflict/u);
  assert.throws(() => f.raw.recordReleaseFinalizationStage(f.request.workspaceId, {
    planRevision: pending.planRevision, stage: "dev", projectRoot: "another-repository", receipt,
  }), /unknown release finalization/u);
  assert.throws(() => f.raw.completeRelease(f.request.workspaceId, {}), /still pending/u);
});


test("completed outcome survives marker retirement and validates exact repository identity", async (t) => {
  const f = await fixture(t, "none");
  const first = await f.createService().completeRelease(f.request);
  assert.equal(first.finalization.status, "completed");
  assert.equal(f.raw.awaitRebuildPending(f.request.workspaceId), null);
  const callsBefore = { ...f.calls };
  const resumed = f.reopen();
  assert.equal((await resumed.completeRelease(f.request)).finalization.status, "completed");
  assert.deepEqual(f.calls, callsBefore);
  await assert.rejects(resumed.completeRelease({ ...f.request,
    expectedRepositories: [{ ...f.request.expectedRepositories[0], revision: "b".repeat(40) }],
  }), /repository identity mismatch/u);
  assert.deepEqual(f.calls, callsBefore);
});

test("reconciliation without canonical pending or completed evidence cannot start a new closure", async (t) => {
  const f = await fixture(t, "none");
  await assert.rejects(f.createService().completeRelease({ ...f.request, reconcileOnly: true }), /no durable release/u);
  assert.equal(f.calls.complete, 0);
  assert.equal(f.calls.verify, 0);
});

test("canonical completed outcome history stays bounded to sixteen exact plans", async (t) => {
  const f = await fixture(t, "none");
  await f.createService().completeRelease(f.request);
  const firstPlan = f.request.expectedPlanRevision;
  const workspaceId = f.request.workspaceId;
  const [{ projectRoot, revision }] = f.request.expectedRepositories;
  const completedPlans = [firstPlan];
  for (let index = 0; index < 16; index += 1) {
    const task = f.raw.create({ text: `Release ${index}`, bucket: "workspace", workspaceId });
    f.raw.recordTaskGitReference({ taskId: task.id, projectRoot, branch: `HUB-${index + 1}`,
      resultSnapshot: { repoRoot: projectRoot, tree: revision } });
    f.raw.setWorkflowStatus(task.id, "awaiting_implementation");
    const candidate = f.raw.task(task.id);
    const plan = { revision: taskReleasePlanRevision(workspaceId, [candidate]), candidates: [candidate] };
    completedPlans.push(plan.revision);
    f.raw.completeRelease(workspaceId, { expectedPlanRevision: plan.revision, plan,
      verificationEvidence: { publication: { repositories: [{ root: projectRoot, revision }] } },
      awaitRebuild: { version: 2, planRevision: plan.revision, fallbackProjectRoots: [projectRoot],
        repositories: [{ projectRoot, publishedRevision: revision }] },
    });
    for (const stage of ["primary", "dev", "await"]) f.raw.recordReleaseFinalizationStage(workspaceId, {
      planRevision: plan.revision, projectRoot, stage, receipt: { completed: true, result: { status: "completed" } },
    });
    f.raw.clearAwaitRebuildPending(workspaceId, plan.revision);
  }
  assert.equal(f.raw.releaseFinalizationOutcome(workspaceId, firstPlan), null);
  for (const plan of completedPlans.slice(1)) assert.equal(f.raw.releaseFinalizationOutcome(workspaceId, plan).planRevision, plan);
  assert.equal(f.raw.awaitRebuildPending(workspaceId), null);
});
