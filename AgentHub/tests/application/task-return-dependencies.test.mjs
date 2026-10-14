import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";

function fixture({ unknown = false } = {}) {
  const root = path.resolve("task-return-project");
  const tasks = new Map(["a", "b"].map((id) => [id, {
    id, title: id, taskNumber: `HUB-${id}`, workspaceId: "workspace", streamId: "stream",
    status: "started", workflowStatus: id === "a" ? "testing" : "awaiting_implementation", revision: 1,
    gitReferences: [{ projectRoot: root, branch: `HUB-${id}`, resultCommit: id.repeat(40) }],
  }]));
  const transitions = new Map();
  const outcomes = new Map();
  const locks = new Set();
  const calls = [];
  const taskBoard = {
    task: (id) => structuredClone(tasks.get(id)),
    releaseTasks: () => [...tasks.values()].map((task) => structuredClone(task)),
    lifecycleOutcome: (id) => outcomes.get(id) ?? null,
    lifecycleTransition: (id) => transitions.get(id) ?? null,
    beginLifecycleTransition: (request) => {
      if (!transitions.has(request.operationId)) transitions.set(request.operationId, { ...request, taskId: request.id, phase: "pending_git" });
      calls.push(`begin:${request.id}`);
    },
    commitWorkflowTransition: (request) => {
      const pending = transitions.get(request.operationId);
      const task = tasks.get(pending.id);
      task.workflowStatus = pending.targetWorkflowStatus;
      task.blockedBy = request.evidence?.blockedBy;
      task.revision += 1;
      const result = structuredClone(task);
      outcomes.set(request.operationId, { taskId: task.id, result: { task: result, evidence: request.evidence } });
      transitions.delete(request.operationId);
      calls.push(`commit:${task.id}`);
      return result;
    },
    failLifecycleTransition: (id, error) => {
      const transition = transitions.get(id);
      transition.phase = "failed";
      transition.error = error.message.slice(0, 4000);
      calls.push("fail");
    },
    rollbackWorkflowOutcome() {}, finalizeCleanupTransition() {},
  };
  const service = new TaskLifecycleService({
    taskBoard,
    workspaceCatalog: {
      workspace: () => ({ id: "workspace", settings: { workingDirectory: root, releaseWorkflowEnabled: true } }),
      stream: () => ({ id: "stream", workspaceId: "workspace", settings: {} }),
    },
    taskGitWorkspaces: {
      withTaskLock: async (id, operation) => {
        assert.equal(locks.size, 0, "dependent returns must release the preceding Task lock");
        locks.add(id);
        try { return await operation({ signal: null, async assertOwned() {} }); }
        finally { locks.delete(id); }
      },
      prepareOwned() {}, snapshotAndMergeOwned() {}, cleanupOwned() {}, cleanupPreview() {},
      withdrawResultOwned: async (request) => {
        calls.push(`withdraw:${request.taskId}`);
        if (unknown) throw Object.assign(new Error("dev commit outcome needs readback"), { code: "TASK_WITHDRAWAL_UNKNOWN" });
        if (request.taskId === "a" && tasks.get("b").workflowStatus === "awaiting_implementation") {
          throw Object.assign(new Error("B depends on A"), { code: "TASK_WITHDRAWAL_DEPENDENCY", blockedTaskIds: ["b"] });
        }
        const withdrawal = { outcome: "withdrawn", taskId: request.taskId, resultCommit: request.resultCommit };
        const workflow = await request.commitWorkflow(withdrawal);
        assert.deepEqual(await request.readWorkflowOutcome(), { status: "committed", result: workflow });
        return { workflow, withdrawal };
      },
    },
    releasePreflight: {
      withAwaitTransition: (_id, operation) => operation(),
      prepareAwaitSet: async () => {
        assert.equal(locks.size, 0);
        calls.push("candidate");
        return { releaseCandidates: [] };
      },
    },
  });
  return { service, tasks, transitions, calls, root };
}

test("returning A preserves its accepted integration without cascading into B", async () => {
  const { service, tasks, transitions, calls, root } = fixture();
  const result = await service.updateWorkflowStatus({ taskId: "a", status: "in_progress", operationId: "return-a", projectRoot: root });
  assert.equal(result.task.workflowStatus, "in_progress");
  assert.equal(result.acceptedResultPreserved, true);
  assert.equal(tasks.get("b").workflowStatus, "awaiting_implementation");
  assert.equal(transitions.has("return-a"), false);
  assert.deepEqual(calls, ["begin:a", "commit:a"]);
});

test("return does not enter the legacy ambiguous withdrawal path", async () => {
  const { service, tasks, transitions, calls, root } = fixture({ unknown: true });
  const result = await service.updateWorkflowStatus({ taskId: "a", status: "in_progress", operationId: "return-a", projectRoot: root });
  assert.equal(result.task.workflowStatus, "in_progress");
  assert.equal(tasks.get("a").workflowStatus, "in_progress");
  assert.equal(transitions.has("return-a"), false);
  assert.deepEqual(calls, ["begin:a", "commit:a"]);
});

test("ordinary correction returns leave no withdrawal intent to reconcile", async () => {
  const { service, calls, root } = fixture();
  const result = await service.updateWorkflowStatus({ taskId: "a", status: "in_progress", operationId: "return-a", projectRoot: root });
  assert.equal(result.task.workflowStatus, "in_progress");
  assert.equal(result.acceptedResultPreserved, true);
  assert.deepEqual(calls, ["begin:a", "commit:a"]);
});
