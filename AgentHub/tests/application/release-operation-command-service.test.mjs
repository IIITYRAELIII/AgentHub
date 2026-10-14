import assert from "node:assert/strict";
import test from "node:test";

import { ReleaseOperationCommandService } from "../../src/application/release-operation-command-service.mjs";

test("release command service binds the public request to a real initiating Thread", () => {
  const calls = [];
  const workspace = {
    id: "workspace-1",
    streams: [{ id: "stream-1", threads: [{ threadId: "thread-old" }] }],
  };
  const service = new ReleaseOperationCommandService({
    releaseOperations: {
      start: (input) => { calls.push(["start", input]); return { accepted: true, operationId: "operation-1" }; },
      get: (operationId) => { calls.push(["get", operationId]); return { operationId }; },
      continue: (operationId) => { calls.push(["continue", operationId]); return { operationId }; },
    },
    workspaceCatalog: {
      workspace: (workspaceId) => workspaceId === workspace.id ? workspace : null,
      hierarchy: () => [workspace],
      activeThread: (streamId) => streamId === "stream-1"
        ? { threadId: "thread-active" } : null,
    },
    taskBoard: {
      task: (taskId) => ({ id: taskId, workspaceId: workspace.id, streamId: "stream-1" }),
    },
  });

  const result = service.start({
    requestId: "release-request",
    workspaceId: workspace.id,
    streamId: "stream-1",
    threadId: "thread-old",
    taskIds: ["task-b", "task-a", "task-b"],
    validationMode: "full",
    approvedTargets: [{ targetId: "production", kind: "agent-hub-publication" }],
  });
  assert.equal(result.operationId, "operation-1");
  assert.deepEqual(calls[0], ["start", {
    requestId: "release-request",
    workspaceId: workspace.id,
    streamId: "stream-1",
    threadId: "thread-old",
    authorization: {
      taskIds: ["task-a", "task-b"],
      validationMode: "full",
      approvedTargets: [{ targetId: "production", kind: "agent-hub-publication" }],
    },
  }]);
  assert.deepEqual(service.get({ operationId: "operation-1" }), { operationId: "operation-1" });
  assert.deepEqual(service.continue({ operationId: "operation-1" }), { operationId: "operation-1" });
});

test("release command service fails before admission without a real Thread", () => {
  let starts = 0;
  const service = new ReleaseOperationCommandService({
    releaseOperations: {
      start: () => { starts += 1; }, get: () => null, continue: () => null,
    },
    workspaceCatalog: {
      workspace: () => ({ id: "workspace-1" }),
      hierarchy: () => [{ id: "workspace-1", streams: [] }],
      activeThread: () => null,
    },
    taskBoard: {
      task: (taskId) => ({ id: taskId, workspaceId: "workspace-1" }),
    },
  });
  assert.throws(() => service.start({
    requestId: "release-request",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    threadId: "thread-missing",
    taskIds: ["task-a"],
    validationMode: "full",
    approvedTargets: [{ targetId: "production", kind: "agent-hub-publication" }],
  }), /exact initiating Stream and Thread/u);
  assert.equal(starts, 0);
});
