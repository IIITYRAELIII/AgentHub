import assert from "node:assert/strict";
import test from "node:test";

import { TaskReleasePlanService } from "../../src/application/task-release-plan-service.mjs";
import { taskReleasePlan } from "../../src/domain/task-release-snapshot.mjs";

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

test("release planner reads Git only for the prospective Await set, independent of archive size", async () => {
  const archive = Array.from({ length: 364 }, (_, index) => task({
    id: `archived-${index}`, status: "done",
    workflowStatus: index % 2 ? "done" : "awaiting_implementation",
  }));
  const draft = task({ id: "draft", workflowStatus: "testing" });
  const audit = task({ id: "done-audit", workflowStatus: "done" });
  const awaiting = task();
  const rows = [...archive, draft, audit, awaiting];
  const calls = [];
  const changedFiles = [{ projectRoot: reference.projectRoot, path: "app.txt", operation: "modified" }];
  const service = new TaskReleasePlanService({
    taskBoard: { releaseTasks: () => rows },
    taskGitWorkspaces: { releaseEvidence: async ({ taskId }) => {
      calls.push(taskId);
      if (!["task-1", "draft"].includes(taskId)) throw new Error("archive Git must not be read");
      return { changedFiles };
    } },
  });
  const plan = await service.plan("workspace-1");
  assert.deepEqual(calls, ["task-1"]);
  const prior = taskReleasePlan("workspace-1", rows.map((row) => ({ ...row, changedFiles })));
  for (const key of ["revision", "legacyRevision", "ready", "blocked", "conflicts"]) {
    assert.deepEqual(plan[key], prior[key], key);
  }
  calls.length = 0;
  const prospective = await service.plan("workspace-1", { acceptingTask: draft });
  assert.deepEqual(calls, ["draft", "task-1"]);
  assert.equal(prospective.ready.length, 2);
  calls.length = 0;
  const selected = await service.plan("workspace-1", { selectedTaskIds: ["task-1"] });
  assert.deepEqual(calls, ["task-1"]);
  assert.deepEqual(selected.ready, plan.ready);
  rows.splice(rows.indexOf(awaiting), 1);
  calls.length = 0;
  assert.deepEqual((await service.plan("workspace-1")).ready, []);
  assert.deepEqual(calls, []);
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

test("prospective Await plan predicts only the accepting Task CAS without mutating stored status", async () => {
  const current = task({ workflowStatus: "testing", revision: 20, releaseRevision: 3 });
  const service = new TaskReleasePlanService({
    taskBoard: { releaseTasks: () => [current] },
    taskGitWorkspaces: { releaseEvidence: async () => ({
      changedFiles: [{ projectRoot: reference.projectRoot, path: "app.txt", operation: "modified" }],
    }) },
  });
  const prospective = await service.plan("workspace-1", { acceptingTask: { id: current.id, revision: current.revision } });
  assert.equal(current.workflowStatus, "testing");
  assert.equal(prospective.ready[0].taskRevision, current.releaseRevision + 1);
  await assert.rejects(service.plan("workspace-1", { acceptingTask: { id: current.id, revision: current.revision - 1 } }), /Task changed/u);
  current.workflowStatus = "awaiting_implementation";
  current.revision += 1;
  current.releaseRevision += 1;
  assert.equal((await service.plan("workspace-1")).revision, prospective.revision);
});
