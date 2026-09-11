import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardLaunchService } from "../../src/application/task-board-launch-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";
import { createInterstreamMessage } from "../../src/domain/interstream-message.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";

async function stores(databaseFile) {
  const workspaceCatalog = new WorkspaceCatalogStore({ databaseFile });
  await workspaceCatalog.load();
  const taskStore = new TaskBoardStore({ databaseFile });
  const taskBoard = new TaskBoardService({ store: taskStore, workspaceCatalog });
  return { workspaceCatalog, taskStore, taskBoard };
}

function hub({ workspaceCatalog, taskBoard, attachmentDirectory }) {
  return new HubMcpService({
    workspaceCatalog,
    taskBoard,
    workLog: { threadTurns: async () => [] },
    attachmentDirectory,
    secret: "startup-reconciliation-secret",
    releasePlanner: { plan: async () => ({ ready: [] }) },
    releasePreflight: {
      preflight: async () => ({}),
      prepareAwaitSet: async () => ({}),
      withAwaitTransition: async (_workspaceId, operation) => operation(),
    },
    releaseCompleter: { completeRelease: async () => ({}) },
  });
}

async function launchStores(databaseFile, { rejectStartingEvent = false } = {}) {
  const rawWorkspaceCatalog = new WorkspaceCatalogStore({ databaseFile });
  await rawWorkspaceCatalog.load();
  const rawTaskStore = new TaskBoardStore({ databaseFile });
  const originalRecordEvent = rawWorkspaceCatalog.recordWorkspaceEvent.bind(rawWorkspaceCatalog);
  let rejectNextStartingEvent = rejectStartingEvent;
  rawWorkspaceCatalog.recordWorkspaceEvent = (event) => {
    if (rejectNextStartingEvent && event.type === "task.starting") {
      rejectNextStartingEvent = false;
      throw new Error("controlled task.starting event rejection");
    }
    return originalRecordEvent(event);
  };
  const { workspaceCatalogStore: workspaceCatalog, taskBoardStore: taskStore } = createPersistenceMutationCapabilities({
    rawWorkspaceCatalogStore: rawWorkspaceCatalog,
    rawTaskBoardStore: rawTaskStore,
  });
  const taskBoard = new TaskBoardService({
    store: taskStore,
    workspaceCatalog,
    recordEvent: (event) => workspaceCatalog.recordWorkspaceEvent(event),
    logger: { warn() {}, error() {} },
  });
  return { rawWorkspaceCatalog, rawTaskStore, workspaceCatalog, taskBoard };
}

function attachRealLauncher(service, current, evidence) {
  const launcher = new TaskBoardLaunchService({
    taskBoard: current.taskBoard,
    workspaceCatalog: current.workspaceCatalog,
    dispatchCommand: async (type, payload) => {
      if (type === "task.select") {
        evidence.selects.push(payload);
        return {};
      }
      assert.equal(type, "task.create");
      const threadId = `thread-launched-${evidence.threadCreates.length + 1}`;
      evidence.threadCreates.push({ streamId: payload.streamId, threadId });
      await current.workspaceCatalog.bindThread({
        streamId: payload.streamId,
        provider: "codex",
        threadId,
        projectRoot: evidence.projectRoot,
      });
      return { createdTask: {
        streamId: payload.streamId,
        provider: "codex",
        threadId,
        projectRoot: evidence.projectRoot,
      } };
    },
    sendMessage: async (params, launchContext) => {
      evidence.deliveries.push(params.clientUserMessageId);
      await launchContext.bindInterstreamAuditContent(createInterstreamMessage({
        ...launchContext.messageOrigin,
        text: params.text || "Task launch",
      }));
      return { accepted: true, id: `delivery-${evidence.deliveries.length}` };
    },
  });
  service.setTaskLauncher((params, context) => launcher.start(params, context));
}

test("real launch recovery cancels an unknown prepared owner before existing-Stream start", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-launch-recovery-"));
  const databaseFile = path.join(root, "hub.sqlite");
  const attachmentDirectory = path.join(root, "attachments");
  await mkdir(attachmentDirectory);
  let current = await launchStores(databaseFile, { rejectStartingEvent: true });
  context.after(async () => {
    current?.rawTaskStore.close();
    current?.rawWorkspaceCatalog.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await current.workspaceCatalog.createWorkspace({ name: "Agent HUB" });
  const architect = await current.workspaceCatalog.createStream({
    workspaceId: workspace.id, name: "Architect", settings: { architect: true },
  });
  await current.workspaceCatalog.bindThread({
    streamId: architect.id, provider: "codex", threadId: "thread-architect", projectRoot: root,
  });
  const existingExecutor = await current.workspaceCatalog.createStream({
    workspaceId: workspace.id, name: "Existing executor",
  });
  await current.workspaceCatalog.bindThread({
    streamId: existingExecutor.id, provider: "codex", threadId: "thread-existing", projectRoot: root,
  });
  const foreignWorkspace = await current.workspaceCatalog.createWorkspace({ name: "Foreign" });
  const foreignStream = await current.workspaceCatalog.createStream({
    workspaceId: foreignWorkspace.id, name: "Foreign source", settings: { architect: true },
  });
  await current.workspaceCatalog.bindThread({
    streamId: foreignStream.id, provider: "codex", threadId: "thread-foreign", projectRoot: root,
  });
  const task = await current.taskBoard.create({
    text: "Recover exact launch", source: "hub", bucket: "workspace", workspaceId: workspace.id,
  });
  const evidence = { projectRoot: root, threadCreates: [], selects: [], deliveries: [] };
  let service = hub({ ...current, attachmentDirectory });
  attachRealLauncher(service, current, evidence);
  const input = {
    context_token: service.contextToken({ provider: "codex", threadId: "thread-architect" }),
    request_id: "architect-hub106-single-owner-launch-20260911-01",
    task_id: task.id,
    workspace_id: workspace.id,
    new_stream_name: "Recovered HUB-106",
    provider: "codex",
    message: "Recover this exact launch.",
    confirm_launch: true,
  };

  await assert.rejects(
    service.call("hub_task_start", input),
    /controlled task\.starting event rejection/u,
  );
  const prepared = current.taskBoard.task(task.id);
  assert.equal(prepared.status, "starting");
  assert.equal(prepared.startRequestId, input.request_id);
  assert.equal(current.workspaceCatalog.stream(prepared.startDestinationStreamId), null);
  assert.equal(current.rawWorkspaceCatalog.mcpOperation(input.request_id).status, "pending");
  assert.deepEqual(evidence.threadCreates, []);
  assert.deepEqual(evidence.deliveries, []);
  current.rawTaskStore.close();
  current.rawWorkspaceCatalog.close();

  current = await launchStores(databaseFile);
  service = hub({ ...current, attachmentDirectory });
  attachRealLauncher(service, current, evidence);
  const exactToken = service.contextToken({ provider: "codex", threadId: "thread-architect" });
  const foreignToken = service.contextToken({ provider: "codex", threadId: "thread-foreign" });
  await service.call("hub_tasks_list", { context_token: exactToken });
  assert.equal(current.rawWorkspaceCatalog.mcpOperation(input.request_id).status, "unknown");

  await assert.rejects(
    service.call("hub_task_launch_cancel", {
      context_token: foreignToken,
      request_id: "cancel-from-foreign",
      task_id: task.id,
      launch_request_id: input.request_id,
      expected_task_revision: prepared.revision,
      confirm_cancel: true,
    }),
    /does not retain the exact prepared launch owner/u,
  );
  await assert.rejects(
    service.call("hub_task_launch_cancel", {
      context_token: exactToken,
      request_id: "cancel-stale-revision",
      task_id: task.id,
      launch_request_id: input.request_id,
      expected_task_revision: prepared.revision + 1,
      confirm_cancel: true,
    }),
    /revision changed/u,
  );
  assert.deepEqual(evidence.threadCreates, []);
  assert.deepEqual(evidence.deliveries, []);

  const cancelled = await service.call("hub_task_launch_cancel", {
    context_token: exactToken,
    request_id: "cancel-original-launch",
    task_id: task.id,
    launch_request_id: input.request_id,
    expected_task_revision: prepared.revision,
    confirm_cancel: true,
  });
  assert.equal(cancelled.task.status, "open");
  assert.equal(cancelled.task.streamId, null);
  assert.equal(cancelled.cancelledLaunch.receiptStatus, "failed");
  assert.match(cancelled.cancelledLaunch.argumentsHash, /^[a-f0-9]{64}$/u);
  assert.equal(current.rawWorkspaceCatalog.mcpOperation(input.request_id).result.cancelled, true);
  await assert.rejects(
    service.call("hub_task_start", { ...input, context_token: exactToken }),
    /Task launch cancelled by exact reconciliation/u,
  );

  const existingInput = {
    context_token: exactToken,
    request_id: "hub106-existing-stream-launch",
    task_id: task.id,
    workspace_id: workspace.id,
    stream_id: existingExecutor.id,
    provider: "codex",
    message: "Continue in the existing executor.",
    confirm_launch: true,
  };
  const recovered = await service.call("hub_task_start", existingInput);
  const replay = await service.call("hub_task_start", existingInput);
  assert.deepEqual(replay, JSON.parse(JSON.stringify(recovered)));
  assert.equal(recovered.task.status, "started");
  assert.equal(recovered.task.streamId, existingExecutor.id);
  assert.deepEqual(evidence.threadCreates, []);
  assert.equal(evidence.selects.length, 1);
  assert.deepEqual(evidence.deliveries, [`mcp:${existingInput.request_id}`]);
  assert.equal(current.workspaceCatalog.threadsForStream(existingExecutor.id).length, 1);
  const events = current.workspaceCatalog.workspaceEvents(workspace.id, { limit: 20 });
  const startingEvents = events.filter((event) => event.type === "task.starting");
  assert.equal(startingEvents.length, 1);
  assert.equal(startingEvents[0].streamId, existingExecutor.id);
  assert.equal(startingEvents[0].payload.requestId, existingInput.request_id);
  assert.equal(startingEvents[0].payload.destinationStreamId, existingExecutor.id);
  assert.equal(current.rawWorkspaceCatalog.mcpOperation(existingInput.request_id).status, "succeeded");
  current.rawTaskStore.close();
  current.rawWorkspaceCatalog.close();
});

test("real-store startup terminalizes begin transition and completed-effect receipt crash boundaries", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-startup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databaseFile = path.join(root, "hub.sqlite");
  const attachmentDirectory = path.join(root, "attachments");
  await mkdir(attachmentDirectory);
  let current = await stores(databaseFile);
  const workspace = await current.workspaceCatalog.runMutation(
    () => current.workspaceCatalog.createWorkspace({ name: "Agent HUB" }),
  );
  const stream = await current.workspaceCatalog.runMutation(
    () => current.workspaceCatalog.createStream({ workspaceId: workspace.id, name: "Architect" }),
  );
  await current.workspaceCatalog.runMutation(() => current.workspaceCatalog.bindThread({
    streamId: stream.id, provider: "codex", threadId: "thread-startup", projectRoot: root,
  }));
  const firstTask = await current.taskBoard.create({
    text: "Crash after transition", source: "hub", bucket: "workspace", workspaceId: workspace.id,
  });
  const secondTask = await current.taskBoard.create({
    text: "Crash after effect", source: "hub", bucket: "workspace", workspaceId: workspace.id,
  });
  const receipt = (requestId) => ({
    requestId,
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-startup",
    toolName: "hub_task_status_update",
    argumentsHash: `hash-${requestId}`,
  });

  await current.workspaceCatalog.runMutation(() => current.workspaceCatalog.beginMcpOperation(receipt("begin-only")));
  await current.workspaceCatalog.runMutation(() => current.workspaceCatalog.beginMcpOperation(receipt("transition-only")));
  await current.taskBoard.beginLifecycleTransition({
    id: firstTask.id,
    operationId: "transition-only",
    kind: "workflow",
    targetWorkflowStatus: "testing",
    expectedRevision: firstTask.revision,
  });
  await current.workspaceCatalog.runMutation(() => current.workspaceCatalog.beginMcpOperation(receipt("effect-complete")));
  await current.taskBoard.beginLifecycleTransition({
    id: secondTask.id,
    operationId: "effect-complete",
    kind: "workflow",
    targetWorkflowStatus: "testing",
    expectedRevision: secondTask.revision,
  });
  await current.taskBoard.commitWorkflowTransition({
    operationId: "effect-complete",
    replaceGitReferences: false,
    evidence: { outcome: "not_required" },
  });
  current.taskStore.close();
  current.workspaceCatalog.close();

  current = await stores(databaseFile);
  const service = hub({ ...current, attachmentDirectory });
  const contextToken = service.contextToken({ provider: "codex", threadId: "thread-startup" });
  await service.call("hub_tasks_list", { context_token: contextToken });

  assert.equal(current.workspaceCatalog.mcpOperation("begin-only").status, "unknown");
  assert.equal(current.workspaceCatalog.mcpOperation("transition-only").status, "unknown");
  const completed = current.workspaceCatalog.mcpOperation("effect-complete");
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result.id, secondTask.id);
  assert.equal(completed.result.workflowStatus, "testing");
  assert.deepEqual(current.workspaceCatalog.pendingMcpOperations(), []);
  current.taskStore.close();
  current.workspaceCatalog.close();
});

test("real MCP Workspace mutation retries one exact request under SQLite contention", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-contention-"));
  const databaseFile = path.join(root, "hub.sqlite");
  const attachmentDirectory = path.join(root, "attachments");
  await mkdir(attachmentDirectory);
  const current = await stores(databaseFile);
  const workspace = await current.workspaceCatalog.runMutation(
    () => current.workspaceCatalog.createWorkspace({ name: "Agent HUB" }),
  );
  const stream = await current.workspaceCatalog.runMutation(
    () => current.workspaceCatalog.createStream({ workspaceId: workspace.id, name: "Architect" }),
  );
  await current.workspaceCatalog.runMutation(() => current.workspaceCatalog.bindThread({
    streamId: stream.id, provider: "codex", threadId: "thread-contention", projectRoot: root,
  }));
  const service = hub({ ...current, attachmentDirectory });
  const contextToken = service.contextToken({ provider: "codex", threadId: "thread-contention" });
  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  let timerFired = false;
  const release = setTimeout(() => {
    timerFired = true;
    blocker.exec("COMMIT");
  }, 80);
  context.after(async () => {
    clearTimeout(release);
    try { blocker.close(); } catch {}
    current.taskStore.close();
    current.workspaceCatalog.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    context_token: contextToken,
    request_id: "workspace-rules-contention",
    workspace_id: workspace.id,
    content: "exact rule",
  };

  const first = await service.call("hub_workspace_rules_update", input);
  const second = await service.call("hub_workspace_rules_update", input);

  assert.equal(timerFired, true);
  assert.deepEqual(second, first);
  assert.equal(current.workspaceCatalog.workspaceDeveloperRules(workspace.id).revision, first.revision);
  assert.ok(current.workspaceCatalog.mutationDiagnostics().retries > 0);
});
