import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceReleaseOperationAdapter } from "../../src/application/workspace-release-operation-adapter.mjs";

function fixture(selection) {
  const calls = [];
  const adapter = new WorkspaceReleaseOperationAdapter({
    releasePreflight: {
      prepareOperationGeneration: async () => ({ releaseCandidates: [], planRevision: "plan" }),
      validateOperationGeneration: async () => ({ status: "ready" }),
      operationSelection: async (input) => { calls.push(["selection", input]); return selection; },
      withAwaitTransition: async (workspaceId, operation) => {
        calls.push(["lock", workspaceId]);
        return operation();
      },
    },
    publication: { publish: async () => null, readback: async () => null },
    finalization: { finalize: async () => null },
  });
  return { adapter, calls };
}

test("publication reservation uses the Workspace Await boundary for the exact generation", async () => {
  const selectedResults = [
    { taskId: "task-b", resultCommit: "result-b", acceptanceRevision: 3 },
    { taskId: "task-a", resultCommit: "result-a", acceptanceRevision: 2 },
  ];
  const f = fixture(selectedResults.toReversed());
  const effects = [];
  const result = await f.adapter.reservePublication({
    operation: {
      workspaceId: "workspace-1",
      authorization: { taskIds: ["task-a", "task-b"] },
    },
    generation: { selectedResults },
    reserve: () => { effects.push("reserve"); return { applied: true }; },
    recompose: () => { effects.push("recompose"); return { applied: true }; },
  });
  assert.equal(result.applied, true);
  assert.deepEqual(effects, ["reserve"]);
  assert.deepEqual(f.calls, [
    ["lock", "workspace-1"],
    ["selection", { workspaceId: "workspace-1", taskIds: ["task-a", "task-b"] }],
  ]);
});

test("publication reservation recomposes when accepted result identity changed", async () => {
  const f = fixture([{ taskId: "task-a", resultCommit: "result-2", acceptanceRevision: 3 }]);
  const effects = [];
  await f.adapter.reservePublication({
    operation: { workspaceId: "workspace-1", authorization: { taskIds: ["task-a"] } },
    generation: {
      selectedResults: [{ taskId: "task-a", resultCommit: "result-1", acceptanceRevision: 2 }],
    },
    reserve: () => { effects.push("reserve"); return { applied: true }; },
    recompose: () => { effects.push("recompose"); return { applied: true }; },
  });
  assert.deepEqual(effects, ["recompose"]);
});
