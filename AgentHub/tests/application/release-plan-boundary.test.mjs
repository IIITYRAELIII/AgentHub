import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { TaskCompositionPlanService } from "../../src/application/task-composition-plan-service.mjs";
import { TaskIntegrationService } from "../../src/application/task-integration-service.mjs";
import { measureTaskOperation, withTaskOperationTiming } from "../../src/infrastructure/process/task-operation-timing.mjs";

const projectRoot = path.resolve("planner-boundary-fixture");
const base = "a".repeat(40);
function fixture() {
  let published = base;
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: `selected-${index}`, title: `Selected ${index}`, workspaceId: "workspace",
    status: "started", workflowStatus: index === 19 ? "testing" : "awaiting_implementation",
    revision: 5, releaseRevision: 3, streamId: "owner",
    gitReferences: [{ projectRoot, branch: `agenthub/task/selected-${index}/fixture`,
      resultCommit: (index + 1).toString(16).padStart(40, "0") }],
  }));
  const counts = { evidence: [], reads: 0, selected: 0, boundaries: [], commits: 0 };
  const board = {
    releaseTasks: () => { counts.reads++; return structuredClone(rows); },
    selectedCompositionForRelease: () => { counts.selected++; return null; },
  };
  const taskGit = {
    releaseEvidence: async ({ taskId }) => {
      counts.evidence.push(taskId);
      return { changedFiles: [{ projectRoot, path: `${taskId}.txt`, operation: "added" }] };
    },
    assertExplicitUpstreamAdoption: async () => assert.fail("No adoption"),
    releaseBaseEvidence: async ({ publishedBaseCommit }) => ({ baseCommit: base, publishedBaseCommit }),
    releaseIntegrationEvidence: async ({ tasks }) => ({ tasks: tasks.map(task => ({ ...task, baseCommit: base })) }),
  };
  const spans = [];
  const planner = new TaskCompositionPlanService({ taskBoard: board, taskGitWorkspaces: taskGit,
    measureOperation: async (stage, run) => { spans.push(stage); return run(); } });
  let mutate = async () => {};
  const service = new TaskIntegrationService({
    releasePlanner: planner, taskGitWorkspaces: taskGit,
    releaseGitWorkspaces: {
      withAwaitTransition: (_workspace, run) => run(),
      assertPrimaryInvariant: async () => ({ projectRoot }),
      inspectMainChanges: async () => assert.fail("No main adoption"),
      prepareCandidate: async input => {
        for (let phase = 0; phase < 4; phase++) {
          counts.boundaries.push(phase);
          await mutate(phase);
          await input.validateBeforeCommit();
        }
        const candidate = { repositoryRoot: projectRoot, frozenTasks: input.frozenTasks,
          preReleaseHead: "b".repeat(40), tree: "c".repeat(40) };
        await mutate(4);
        await input.commitPrepared(candidate);
        return candidate;
      },
    },
    readPublicationState: async () => ({ repositories: [{ root: projectRoot, revision: published }] }),
  });
  const run = () => service.prepareAwaitAcceptance({ workspaceId: "workspace", projectRoot,
    acceptingTask: { id: rows[19].id, revision: 5 }, operationId: "same-original",
    commitPrepared: async value => { counts.commits++; return value; } });
  return { rows, counts, planner, board, taskGit, service, run, spans,
    setMutation: value => { mutate = value; }, setPublished: revision => { published = revision; } };
}

test("paired plans preserve every field of the existing separate public plans", async () => {
  const f = fixture();
  f.rows.push({ ...structuredClone(f.rows[0]), id: "archive", status: "done", description: "archived" });
  f.rows.push({ ...structuredClone(f.rows[0]), id: "draft", workflowStatus: "in_progress", checklist: [] });
  const input = { acceptingTask: { id: f.rows[19].id, revision: 5 } };
  const baseline = await f.planner.plan("workspace");
  const prospective = await f.planner.plan("workspace", input);
  const pair = await f.planner.planAcceptance("workspace", input);
  assert.deepEqual(pair, { baseline, prospective });
  for (const stage of ["canonical-read", "selected-authority", "git-evidence", "projection"]) {
    assert.ok(f.spans.includes(`release:planner:${stage}`));
  }
});

function selectedProof(task, proofTree = base) {
  const value = { kind: "selected-task-composition-v1", taskId: task.id,
    repositoryRoot: projectRoot, taskBaseCommit: base, taskCommit: task.gitReferences[0].resultCommit,
    devCommit: base, proofCommit: base, publishedCommit: base, remoteCommit: base,
    proofTree, releaseParent: base, selectedReleaseTree: base, proofHash: "c".repeat(64) };
  value.previewHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { selectedCompositionRequired: true, selectedComposition: value };
}

for (const mutation of ["releaseRevision", "result", "branch", "taskNumber", "targetRevision", "membership", "selectedProof"]) {
  test(`union pass rereads canonical ${mutation} after awaiting Git`, async () => {
    const f = fixture();
    let proofTree = base, changed = false;
    f.board.selectedCompositionForRelease = ({ taskId }) => selectedProof(f.rows.find(row => row.id === taskId), proofTree);
    const original = f.taskGit.releaseEvidence;
    f.taskGit.releaseEvidence = async input => {
      const result = await original(input);
      if (!changed) {
        changed = true;
        if (mutation === "releaseRevision") f.rows[0].releaseRevision++;
        if (mutation === "result") f.rows[0].gitReferences[0].resultCommit = "d".repeat(40);
        if (mutation === "branch") f.rows[0].gitReferences[0].branch = "agenthub/task/foreign/fixture";
        if (mutation === "taskNumber") f.rows[0].taskNumber = "HUB-111";
        if (mutation === "targetRevision") f.rows[19].revision++;
        if (mutation === "membership") f.rows[0].workflowStatus = "testing";
        if (mutation === "selectedProof") proofTree = "e".repeat(40);
      }
      return result;
    };
    await assert.rejects(f.run(), /changed/u);
    assert.equal(f.counts.commits, 0);
  });
}

test("unrelated metadata on an earlier result does not replace release authority", async () => {
  const f = fixture(), original = f.taskGit.releaseEvidence;
  f.taskGit.releaseEvidence = async input => {
    f.rows[0].title = "metadata edit";
    f.rows[0].revision++;
    return original(input);
  };
  assert.equal((await f.run()).taskIds.length, 20);
  assert.equal(f.counts.commits, 1);
});

test("new nested timing preserves original correlation and flushes a canonical reread failure without payload", async () => {
  const f = fixture(), records = [], error = new Error("controlled canonical reread failure");
  f.rows[0].description = "synthetic-private-payload";
  f.planner.measureOperation = measureTaskOperation;
  const original = f.board.releaseTasks;
  let reads = 0;
  f.board.releaseTasks = (...args) => { if (++reads === 2) throw error; return original(...args); };
  await assert.rejects(withTaskOperationTiming({ operationId: "same-original", taskId: f.rows[19].id,
    releaseOperationId: "separate-release", generation: 1, ownerEpoch: 3,
    record: value => records.push(value) }, f.run), value => value === error);
  for (const stage of ["canonical-read", "selected-authority", "git-evidence", "projection"]) {
    assert.ok(records.some(row => row.stage === `release:planner:${stage}` && row.phase === "start"));
    assert.ok(records.some(row => row.stage === `release:planner:${stage}` && row.phase === "end"));
  }
  assert.ok(records.some(row => row.stage === "release:planner:canonical-read" && row.outcome === "error"));
  assert.ok(records.some(row => row.stage === "trace-summary"));
  assert.ok(records.every(row => row.operationId === "same-original" && row.releaseOperationId === "separate-release"
    && row.processId === process.pid && row.generation === 1 && row.ownerEpoch === 3));
  assert.equal(JSON.stringify(records).includes("synthetic-private-payload"), false);
});

test("bounded nested aggregates retain all union reads after detailed spans are suppressed", async () => {
  const f = fixture(), records = [];
  f.planner.measureOperation = measureTaskOperation;
  await withTaskOperationTiming({ operationId: "same-counted-original", taskId: f.rows[19].id,
    record: value => records.push(value) }, async () => {
    for (let index = 0; index < 512; index++) await measureTaskOperation("git-child", async () => {}, { detail: true });
    await f.run();
  });
  const summary = records.find(row => row.stage === "trace-summary");
  assert.ok(summary.suppressedDetailSpans > 0);
  for (const [stage, count] of [["canonical-read", 12], ["selected-authority", 240], ["git-evidence", 120], ["projection", 12]]) {
    assert.equal(summary.stageAggregates.find(row => row.stage === `release:planner:${stage}`)?.count, count);
  }
});

for (const phase of [0, 1, 2, 3, 4]) {
  test(`a fresh Git evidence refusal with unchanged SQL identity cannot pass boundary ${phase}`, async () => {
    const f = fixture(), original = f.taskGit.releaseEvidence;
    let refused = false;
    f.taskGit.releaseEvidence = async input => {
      if (refused && input.taskId === f.rows[0].id) throw new Error("controlled missing live result");
      return original(input);
    };
    f.setMutation(async current => { if (current === phase) refused = true; });
    await assert.rejects(f.run(), /blocked Task results/u);
    assert.equal(f.counts.commits, 0);
  });
}

test("Await rechecks all four promotions and final CAS with one live union evidence pass per boundary", async () => {
  const f = fixture();
  const expected = await f.planner.plan("workspace", { acceptingTask: { id: f.rows[19].id, revision: 5 } });
  f.counts.evidence.length = 0;
  f.counts.reads = 0;
  f.counts.selected = 0;
  const result = await f.run();
  assert.equal(result.planRevision, expected.revision);
  assert.equal(result.taskIds.length, 20);
  assert.deepEqual(f.counts.boundaries, [0, 1, 2, 3]);
  assert.equal(f.counts.commits, 1);
  assert.equal(f.counts.evidence.length, 120, "20 results at initial + four promotions + final CAS, never baseline/prospective duplication");
  for (const task of f.rows) assert.equal(f.counts.evidence.filter(id => id === task.id).length, 6);
});

test("Await rereads publication after the last plan finishes and before Task CAS", async () => {
  const f = fixture(), original = f.taskGit.releaseEvidence;
  let final = false, switched = false;
  f.setMutation(async phase => { final = phase === 4; });
  f.taskGit.releaseEvidence = async input => {
    if (final && !switched) {
      switched = true;
      await new Promise(resolve => setImmediate(resolve));
      f.setPublished("b".repeat(40));
    }
    return original(input);
  };
  await assert.rejects(f.run(), /accepted release base changed/u);
  assert.equal(f.counts.commits, 0);
});

for (const phase of [0, 1, 2, 3, 4]) {
  for (const mutation of ["membership", "releaseRevision", "result", "branch", "targetRevision", "selectedProof"]) {
  test(`fresh union recheck refuses ${mutation} at ${phase === 4 ? "final CAS" : `promotion ${phase}`}`, async () => {
    const f = fixture();
    let proofTree = base;
    f.board.selectedCompositionForRelease = ({ taskId }) => selectedProof(f.rows.find(row => row.id === taskId), proofTree);
    f.setMutation(async current => {
      if (current !== phase) return;
      if (mutation === "membership") f.rows[0].workflowStatus = "testing";
      if (mutation === "releaseRevision") f.rows[0].releaseRevision++;
      if (mutation === "result") f.rows[0].gitReferences[0].resultCommit = "d".repeat(40);
      if (mutation === "branch") f.rows[0].gitReferences[0].branch = "agenthub/task/foreign/fixture";
      if (mutation === "targetRevision") f.rows[19].revision++;
      if (mutation === "selectedProof") proofTree = "e".repeat(40);
    });
    await assert.rejects(f.run(), /changed/u);
    assert.equal(f.counts.commits, 0);
  });
  }
}

for (const phase of [0, 4]) {
  for (const [scope, message] of [
    ["baseline and accepting Task", "release plan revision changed during PreRelease rebuild"],
    ["baseline only", "release plan revision changed during PreRelease rebuild"],
    ["accepting Task only", "Task changed before PreRelease acceptance preparation"],
  ]) {
    test(`${scope} drift at ${phase === 4 ? "final CAS" : "promotion"} preserves refusal priority`, async () => {
      const f = fixture();
      f.setMutation(async current => {
        if (current !== phase) return;
        if (scope !== "accepting Task only") f.rows[0].releaseRevision++;
        if (scope !== "baseline only") f.rows[19].revision++;
      });
      await assert.rejects(f.run(), { message });
      assert.equal(f.counts.commits, 0);
      const passes = phase + 2;
      assert.equal(f.counts.evidence.length, 20 * passes - Number(scope !== "baseline only"));
    });
  }
}
