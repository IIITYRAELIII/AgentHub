import assert from "node:assert/strict";
import test from "node:test";

import { createReleaseCorrectionRequester } from "../../src/composition/infrastructure-composition.mjs";

test("release lineage mismatch returns the same selected Task through canonical lifecycle once", async () => {
  let task = {
    id: "task-a",
    revision: 7,
    workflowStatus: "awaiting_implementation",
    gitReferences: [{ resultCommit: "result-r1" }],
    assignedStreamId: "executor-stream",
  };
  const transitions = [];
  const requestCorrection = createReleaseCorrectionRequester({
    taskBoard: { task: (taskId) => taskId === task.id ? task : null },
    taskLifecycle: {
      updateWorkflowStatus: async (input) => {
        transitions.push(input);
        task = { ...task, workflowStatus: input.status };
        return { task };
      },
    },
  });
  const input = {
    operation: { operationId: "operation-1", authorization: { taskIds: ["task-a"] } },
    error: { taskId: "task-a", priorResultCommit: "result-r1", resultCommit: "result-unrelated" },
  };
  const first = await requestCorrection(input);
  const replay = await requestCorrection(input);
  assert.equal(first.operationId, "release-operation-1-correction-task-a-result-unrel");
  assert.equal(replay.operationId, first.operationId);
  assert.deepEqual(transitions, [{
    taskId: "task-a",
    status: "in_progress",
    operationId: first.operationId,
    expectedRevision: 7,
    expectedWorkflowStatus: "awaiting_implementation",
    operationEvidence: {
      releaseCorrection: {
        releaseOperationId: "operation-1",
        priorResultCommit: "result-r1",
        rejectedResultCommit: "result-unrelated",
      },
    },
  }]);
  assert.deepEqual(first.task.gitReferences, [{ resultCommit: "result-r1" }]);
  assert.equal(first.task.assignedStreamId, "executor-stream");
  await assert.rejects(requestCorrection({
    operation: { operationId: "operation-1", authorization: { taskIds: ["task-b"] } },
    error: input.error,
  }), /authorized selected Task/u);
});
