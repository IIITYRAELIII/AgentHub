import assert from "node:assert/strict";
import test from "node:test";

import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { createInterstreamMessage } from "../../src/domain/interstream-message.mjs";

function methodStub(result = null) {
  return () => result;
}

test("hub_task_start carries the audited source Stream into message intake", async () => {
  const task = {
    id: "task-1",
    title: "Исправить автора",
    description: "",
    bucket: "workspace",
    status: "open",
    workflowStatus: "new",
    workspaceId: "workspace-1",
    streamId: null,
    boardOrder: 0,
  };
  const operations = new Map();
  const workspace = {
    id: "workspace-1",
    name: "Agent HUB",
    streams: [{
      id: "stream-release-manager",
      displayName: "Release Manager",
      settings: { workingDirectory: "D:/work" },
      threads: [{ provider: "codex", threadId: "thread-release-manager" }],
    }],
  };
  const workspaceCatalog = {
    resolveThread: ({ provider, threadId }) => provider === "codex" && threadId === "thread-release-manager"
      ? {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        streamId: "stream-release-manager",
        streamDisplayName: "Release Manager",
        thread: { projectRoot: "D:/work" },
      }
      : null,
    workspace: (id) => id === workspace.id ? workspace : null,
    hierarchy: () => [workspace],
    stream: (id) => workspace.streams.find((candidate) => candidate.id === id) ?? null,
    activeThread: methodStub(null),
    developerRulesForStream: methodStub({}),
    updateWorkspaceDeveloperRules: methodStub({}),
    updateStreamDeveloperRules: methodStub({}),
    workspaceEvents: methodStub([]),
    mcpOperations: () => [...operations.values()],
    beginMcpOperation: (operation) => {
      const value = { ...operation, status: "pending", result: null, replayed: false };
      operations.set(operation.requestId, value);
      return value;
    },
    bindMcpOperationInterstreamContentHash: (requestId, contentHash) => {
      Object.assign(operations.get(requestId), { interstreamContentHash: contentHash });
    },
    completeMcpOperation: (requestId, result) => {
      Object.assign(operations.get(requestId), { status: "succeeded", result });
    },
    failMcpOperation: (requestId, error) => {
      Object.assign(operations.get(requestId), { status: "failed", error: error.message });
    },
  };
  const taskBoard = {
    snapshot: () => [task],
    task: () => task,
    create: methodStub(task),
    move: methodStub(task),
    update: methodStub(task),
    updateChecklist: methodStub({ task, createdTask: null, itemId: null, replayed: false }),
    checklistRequestResult: () => null,
    markStarted: methodStub(task),
    complete: methodStub(task),
    addAttachment: methodStub(task),
    claim: methodStub(task),
    requestWorkflowStatus: methodStub(task),
    beginLifecycleTransition: methodStub(task),
    commitWorkflowTransition: methodStub(task),
    rollbackWorkflowOutcome: methodStub(task),
    failLifecycleTransition: methodStub(task),
    finalizeCleanupTransition: methodStub(task),
    releaseTasks: methodStub([]),
    adoptLegacyGitReference: methodStub(task),
  };
  const service = new HubMcpService({
    workspaceCatalog,
    taskBoard,
    workLog: { threadTurns: async () => [] },
    attachmentDirectory: "D:/attachments",
    secret: "test-secret",
    releasePlanner: { plan: async () => ({}) },
    releasePreflight: {
      preflight: async () => ({}),
      prepareAwaitSet: async () => ({}),
      withAwaitTransition: async (_workspaceId, operation) => operation(),
    },
    releaseCompleter: { completeRelease: async () => ({}) },
  });
  service.setActiveRuns(() => [{
    provider: "codex",
    threadId: "thread-release-manager",
    model: "Sol",
  }]);
  let launch = null;
  service.setTaskLauncher(async (params, context) => {
    launch = { params, context };
    context.bindInterstreamAuditContent(createInterstreamMessage({
      ...context.messageOrigin,
      text: params.message,
    }));
    return {
      task: { ...task, status: "started", workflowStatus: "in_progress", streamId: "stream-release-manager" },
      target: { streamId: "stream-release-manager", provider: "codex", threadId: "thread-target" },
    };
  });

  await service.call("hub_task_start", {
    context_token: service.contextToken({ provider: "codex", threadId: "thread-release-manager" }),
    request_id: "task-start-origin-1",
    task_id: task.id,
    message: "Исправь дефект полностью.",
    confirm_launch: true,
  });

  assert.equal(launch.params.message, "Исправь дефект полностью.");
  assert.equal(launch.params.clientUserMessageId, "mcp:task-start-origin-1");
  assert.deepEqual(launch.context.messageOrigin, {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-release-manager",
    streamName: "Release Manager",
    provider: "codex",
    model: "Sol",
    sourceThreadId: "thread-release-manager",
    requestId: "task-start-origin-1",
  });
});
