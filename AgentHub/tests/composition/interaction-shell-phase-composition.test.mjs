import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardLaunchService } from "../../src/application/task-board-launch-service.mjs";
import {
  configureMcpTaskLauncher,
  requireDesktopTaskSyncStore,
} from "../../src/composition/interaction-shell-phase-composition.mjs";
import {
  interstreamAuditContentHash,
  interstreamMessageDetails,
} from "../../src/domain/interstream-message.mjs";
import { MessageReceiptRegistry } from "../../src/infrastructure/persistence/message-receipts.mjs";
import { createDesktopMessageController } from "../../src/interfaces/desktop/desktop-message-controller.mjs";
import { DesktopTaskService } from "../../src/interfaces/desktop/desktop-task-service.mjs";

const ROOT = new URL("../../src/composition/agent-hub-composition.mjs", import.meta.url);
const OWNER = new URL("../../src/composition/interaction-shell-phase-composition.mjs", import.meta.url);

test("interaction phase owns server, Desktop and run shell assembly", async () => {
  const [root, owner] = await Promise.all([readFile(ROOT, "utf8"), readFile(OWNER, "utf8")]);
  for (const factory of [
    "createServerControlComposition",
    "createDesktopShellComposition",
    "createRunShellComposition",
  ]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(owner.includes(factory), true, `${factory} is not owned by interaction phase`);
  }
  assert.equal(root.includes("createInteractionShellPhase"), true);
  assert.match(root, /infrastructure:\s*\{[\s\S]*workspaceCatalogStore,[\s\S]*\},\s*provider: providerApplication/u);
  // Trace dependency wiring is exercised by the real local-control startup E2E.
  assert.match(root, /rateLimitHistoryStore, commandTraceService, runJournal/u);
  assert.match(owner, /workspaceCatalogStore: infrastructure\.workspaceCatalogStore/u);
  assert.match(owner, /commandTraceService: infrastructure\.commandTraceService/u);
  assert.equal(owner.includes("desktopCommandsPort: ports.desktopCommands"), true);
  assert.equal(owner.includes("runShell: ports.runShell"), true);
  assert.equal(owner.includes("lastTaskMessageRevision: api.lastTaskMessageRevision"), true);
});

function mcpTaskLaunchFixture() {
  const workspaceId = "workspace-1";
  const workspaceName = "Agent HUB";
  const streams = new Map([
    ["stream-source", {
      id: "stream-source",
      workspaceId,
      displayName: "Architect",
      settings: { workingDirectory: "C:\\source" },
      threads: [{ provider: "codex", threadId: "thread-source", projectRoot: "C:\\source" }],
    }],
    ["stream-old", {
      id: "stream-old",
      workspaceId,
      displayName: "Old",
      settings: { workingDirectory: "C:\\old" },
      threads: [{ provider: "codex", threadId: "thread-old", projectRoot: "C:\\old" }],
    }],
    ["stream-target-a", {
      id: "stream-target-a",
      workspaceId,
      displayName: "Target A",
      settings: { workingDirectory: "C:\\target-a" },
      threads: [{ provider: "codex", threadId: "thread-target-a", projectRoot: "C:\\target-a" }],
    }],
    ["stream-target-b", {
      id: "stream-target-b",
      workspaceId,
      displayName: "Target B",
      settings: { workingDirectory: "C:\\target-b" },
      threads: [{ provider: "codex", threadId: "thread-target-b", projectRoot: "C:\\target-b" }],
    }],
  ]);
  const workspace = {
    id: workspaceId,
    name: workspaceName,
    settings: { releaseWorkflowEnabled: false, workingDirectory: "C:\\workspace" },
  };
  const tasks = new Map([
    ["task-start", {
      id: "task-start",
      taskNumber: "HUB-START",
      title: "Start task",
      description: "",
      bucket: "workspace",
      status: "open",
      workflowStatus: "new",
      workspaceId,
      streamId: null,
      boardOrder: 1,
    }],
    ["task-reassign", {
      id: "task-reassign",
      taskNumber: "HUB-REASSIGN",
      title: "Reassign task",
      description: "",
      bucket: "workspace",
      status: "started",
      workflowStatus: "in_progress",
      workspaceId,
      streamId: "stream-old",
      boardOrder: 2,
    }],
  ]);
  const operations = new Map();
  const sequence = [];
  const deliveries = [];
  const workspaceCatalog = {
    resolveThread: ({ provider, threadId }) => {
      const stream = [...streams.values()].find((candidate) => candidate.threads.some((thread) => (
        thread.provider === provider && thread.threadId === threadId
      )));
      if (!stream) return null;
      return {
        workspaceId,
        workspaceName,
        streamId: stream.id,
        streamDisplayName: stream.displayName,
        thread: stream.threads.find((thread) => thread.provider === provider && thread.threadId === threadId),
      };
    },
    workspace: (id) => id === workspaceId ? workspace : null,
    hierarchy: () => [{ ...workspace, streams: [...streams.values()] }],
    stream: (id) => streams.get(id) ?? null,
    activeThread: (streamId) => streams.get(streamId)?.threads[0] ?? null,
    workspaceEvents: () => [],
    developerRulesForStream: () => ({ workspace: null, stream: null }),
    updateWorkspaceDeveloperRules: () => ({}),
    updateStreamDeveloperRules: () => ({}),
    beginMcpOperation: (operation) => {
      const record = { ...operation, status: "pending", result: null, error: "" };
      operations.set(operation.requestId, record);
      return record;
    },
    bindMcpOperationInterstreamContentHash: (requestId, contentHash) => {
      const operation = operations.get(requestId);
      if (!operation) throw new Error("MCP operation is missing");
      if (operation.interstreamContentHash && operation.interstreamContentHash !== contentHash) {
        throw new Error("MCP interstream content changed after admission");
      }
      operation.interstreamContentHash = contentHash;
      sequence.push(["bind", requestId]);
      return operation;
    },
    completeMcpOperation: (requestId, result) => {
      const operation = operations.get(requestId);
      if (!operation?.interstreamContentHash) throw new Error("MCP audit content was not bound");
      Object.assign(operation, { status: "succeeded", result });
      sequence.push(["complete", requestId]);
    },
    failMcpOperation: (requestId, error) => {
      Object.assign(operations.get(requestId), { status: "failed", error: error.message });
    },
    mcpOperations: () => [...operations.values()],
    runMutation: async (operation) => operation(),
    mutationDiagnostics: () => ({ pending: 0 }),
  };
  const taskBoard = {
    snapshot: () => [...tasks.values()],
    task: (id) => tasks.get(id) ?? null,
    create: () => { throw new Error("not used"); },
    move: () => { throw new Error("not used"); },
    update: () => { throw new Error("not used"); },
    updateChecklist: () => { throw new Error("not used"); },
    checklistRequestResult: () => { throw new Error("not used"); },
    complete: () => { throw new Error("not used"); },
    addAttachment: () => { throw new Error("not used"); },
    claim: () => { throw new Error("not used"); },
    requestWorkflowStatus: () => { throw new Error("not used"); },
    releaseTasks: () => [],
    adoptLegacyGitReference: () => { throw new Error("not used"); },
    prepareStart: ({ id, workspaceId: taskWorkspaceId, streamId, streamName, requestId, reassign }) => {
      const task = tasks.get(id);
      Object.assign(task, reassign ? {
        startRequestId: requestId,
        startStreamName: streamName,
      } : {
        status: "starting",
        workspaceId: taskWorkspaceId,
        streamId,
        startRequestId: requestId,
        startStreamName: streamName,
      });
      return { ...task };
    },
    cancelPreparedStart: () => { throw new Error("not used"); },
    markStarted: ({ id, workspaceId: taskWorkspaceId, streamId, requestId }) => {
      const task = tasks.get(id);
      assert.equal(task.startRequestId, requestId);
      Object.assign(task, {
        status: "started",
        workflowStatus: "in_progress",
        workspaceId: taskWorkspaceId,
        streamId,
      });
      return { ...task };
    },
  };
  const entries = [...streams.values()].map((stream) => ({
    streamId: stream.id,
    workspaceName,
    streamName: stream.displayName,
    provider: stream.threads[0].provider,
    projectRoot: stream.threads[0].projectRoot,
    threadId: stream.threads[0].threadId,
    title: stream.displayName,
  }));
  const desktopTasks = new DesktopTaskService({
    catalog: () => entries,
    refreshCatalog: async () => entries,
    activateBinding: async () => ({ changed: false }),
    snapshot: async () => ({}),
    taskHistory: async () => ({}),
    dispatchCommand: async () => ({}),
    commandTaskTarget: (params) => params,
    readTurn: async () => null,
    threadsForStream: (streamId) => streams.get(streamId)?.threads ?? [],
    currentThread: (streamId) => workspaceCatalog.activeThread(streamId),
    streamSettings: (streamId) => streams.get(streamId)?.settings ?? null,
    samePath: (left, right) => left === right,
    chatId: () => null,
  });
  const messages = createDesktopMessageController({
    attachmentPaths: async () => [],
    resolveTaskReferences: async ([reference]) => {
      const task = tasks.get(reference.taskId);
      return [{
        kind: "task",
        taskId: task.id,
        title: task.title,
        workflowStatus: task.workflowStatus,
        workspaceId: task.workspaceId,
        intent: reference.intent,
      }];
    },
    resolveTarget: desktopTasks.resolveTarget.bind(desktopTasks),
    receipts: new MessageReceiptRegistry(),
    persistReceipts: async () => {},
    runCoordinator: {
      submitClientInput: async (request) => {
        deliveries.push(request);
        const requestId = request.clientUserMessageId.slice("mcp:".length);
        sequence.push(["deliver", requestId]);
        return {
          accepted: true,
          queued: false,
          id: `delivery-${requestId}`,
          runId: `run-${requestId}`,
          threadId: request.target.threadId,
          clientUserMessageId: request.clientUserMessageId,
        };
      },
      steer: async () => ({}),
    },
  });
  const taskBoardLauncher = new TaskBoardLaunchService({
    taskBoard,
    workspaceCatalog,
    dispatchCommand: async () => ({}),
    sendMessage: messages.sendMessage,
  });
  const hubMcpService = new HubMcpService({
    workspaceCatalog,
    taskBoard,
    workLog: { threadTurns: async () => [] },
    attachmentDirectory: ".",
    secret: "composition-test-secret",
    releasePlanner: { plan: async () => ({}) },
    releasePreflight: { preflight: async () => ({}) },
    releaseCompleter: { completeRelease: async () => ({}) },
    taskLifecycle: {},
  });
  hubMcpService.setActiveRuns(() => []);
  hubMcpService.setDeferredInputs(() => []);
  configureMcpTaskLauncher({ hubMcpService, taskBoardLauncher });
  hubMcpService.setStreamMessenger(async () => { throw new Error("direct Stream send is not part of this path"); });
  return {
    deliveries,
    hubMcpService,
    operations,
    sequence,
    token: hubMcpService.contextToken({ provider: "codex", threadId: "thread-source" }),
  };
}

test("production MCP task launcher preserves audited context for start and reassign", async () => {
  const fixture = mcpTaskLaunchFixture();
  const scenarios = [{
    tool: "hub_task_start",
    taskId: "task-start",
    streamId: "stream-target-a",
    requestId: "task-start-request",
    message: "Start through the production launcher",
  }, {
    tool: "hub_task_reassign",
    taskId: "task-reassign",
    streamId: "stream-target-b",
    requestId: "task-reassign-request",
    message: "Reassign through the production launcher",
  }];

  for (const [index, scenario] of scenarios.entries()) {
    const result = await fixture.hubMcpService.call(scenario.tool, {
      context_token: fixture.token,
      request_id: scenario.requestId,
      task_id: scenario.taskId,
      stream_id: scenario.streamId,
      message: scenario.message,
      confirm_launch: true,
    });
    const operation = fixture.operations.get(scenario.requestId);
    const delivery = fixture.deliveries[index];
    const details = interstreamMessageDetails(delivery.input);

    assert.equal(result.task.status, "started");
    assert.equal(result.task.streamId, scenario.streamId);
    assert.equal(delivery.clientUserMessageId, `mcp:${scenario.requestId}`);
    assert.deepEqual(details.origin, {
      kind: "interstream",
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-source",
      streamName: "Architect",
      provider: "codex",
      sourceThreadId: "thread-source",
      requestId: scenario.requestId,
    });
    assert.match(details.text, new RegExp(`agent-hub://task/${scenario.taskId}`, "u"));
    assert.match(details.text, /intent: start/u);
    assert.match(details.text, new RegExp(scenario.message, "u"));
    assert.equal(operation.status, "succeeded");
    assert.match(operation.interstreamContentHash, /^[a-f0-9]{64}$/u);
    assert.equal(operation.interstreamContentHash, interstreamAuditContentHash(delivery.input));
    assert.deepEqual(
      fixture.sequence.filter(([, requestId]) => requestId === scenario.requestId).map(([stage]) => stage),
      ["bind", "deliver", "complete"],
    );
  }
});

test("interaction phase routes the canonical task sync store to Desktop search", () => {
  const taskSyncStore = {
    searchMessages() {},
    messageSearchStatus() {
      return { completedThreads: 1, totalThreads: 1 };
    },
    markMessageSearchThread() {},
  };

  const selected = requireDesktopTaskSyncStore({ taskSyncStore });

  assert.equal(selected, taskSyncStore);
  assert.deepEqual(selected.messageSearchStatus(), {
    completedThreads: 1,
    totalThreads: 1,
  });
});

test("interaction phase rejects an incomplete Desktop search store during composition", () => {
  assert.throws(
    () => requireDesktopTaskSyncStore({ taskSyncStore: { searchMessages() {} } }),
    /provider\.taskSyncStore\.messageSearchStatus is required/u,
  );
});
