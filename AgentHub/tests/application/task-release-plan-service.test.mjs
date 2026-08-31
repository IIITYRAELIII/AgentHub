import assert from "node:assert/strict";
import test from "node:test";

import { TaskReleasePlanService } from "../../src/application/task-release-plan-service.mjs";

const reference = {
  projectRoot: "D:/repo",
  branch: "agenthub/task/task-1/repository",
  resultCommit: "b".repeat(40),
};

function task(overrides = {}) {
  return {
    id: "task-1",
    title: "Ready",
    revision: 3,
    status: "open",
    workflowStatus: "awaiting_implementation",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    gitReferences: [reference],
    ...overrides,
  };
}

test("release planner derives ready files from the accepted Git result commit", async () => {
  const calls = [];
  const service = new TaskReleasePlanService({
    taskBoard: { releaseTasks: () => [task()] },
    taskGitWorkspaces: {
      releaseEvidence: async (value) => {
        calls.push(value);
        return {
          ...reference,
          changedFiles: [{ projectRoot: "D:/repo", path: "src/app.mjs", operation: "modified" }],
        };
      },
    },
  });

  const plan = await service.plan("workspace-1");
  assert.deepEqual(calls, [{ taskId: "task-1", ...reference }]);
  assert.deepEqual(plan.ready.map((entry) => entry.files), [["src/app.mjs"]]);
  assert.deepEqual(plan.blocked, []);
});

test("release planner keeps an invalid or missing Git result visible as blocked", async () => {
  const service = new TaskReleasePlanService({
    taskBoard: { releaseTasks: () => [task()] },
    taskGitWorkspaces: { releaseEvidence: async () => { throw new Error("result commit is missing"); } },
  });

  const plan = await service.plan("workspace-1");
  assert.deepEqual(plan.ready, []);
  assert.equal(plan.blocked[0].reason, "result commit is missing");
});
