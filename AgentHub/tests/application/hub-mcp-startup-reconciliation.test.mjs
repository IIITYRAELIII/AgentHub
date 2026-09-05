import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
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
    releasePreflight: { preflight: async () => ({}) },
    releaseCompleter: { completeRelease: async () => ({}) },
  });
}

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
