import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executeTaskAwaitCutover,
  openTaskAwaitCutoverRuntime,
  parseTaskAwaitCutoverArguments,
} from "../../../src/interfaces/cli/task-await-cutover.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

const sha = "a".repeat(40);
const projectorSha = "b".repeat(64);

function argumentsFixture() {
  return [
    "--workspace", "workspace-1",
    "--stream", "stream-1",
    "--provider", "codex",
    "--thread", "thread-1",
    "--task", "task-1",
    "--request", "cutover-1",
    "--repository", process.cwd(),
    "--expected-task-revision", "18",
    "--expected-source-commit", sha,
    "--expected-projector-sha256", projectorSha,
    "--confirm-cutover",
  ];
}

test("Await cutover requires immutable source, Task CAS and explicit confirmation", () => {
  const parsed = parseTaskAwaitCutoverArguments(argumentsFixture());
  assert.equal(parsed.expectedTaskRevision, 18);
  assert.equal(parsed.expectedSourceCommit, sha);
  assert.equal(parsed.expectedProjectorSha256, projectorSha);
  assert.equal(parsed.confirm, true);
  assert.throws(
    () => parseTaskAwaitCutoverArguments(argumentsFixture().slice(0, -1)),
    /confirm-cutover is required/u,
  );
});

test("Await cutover executes one canonical status mutation without startup replay", async () => {
  const input = parseTaskAwaitCutoverArguments(argumentsFixture());
  const calls = [];
  let closed = 0;
  const task = {
    id: input.taskId,
    workspaceId: input.workspaceId,
    streamId: input.streamId,
    revision: input.expectedTaskRevision,
    workflowStatus: "testing",
    gitReferences: [{ projectRoot: input.repositoryRoot, resultCommit: sha }],
  };
  const service = {
    contextToken(identity) { calls.push(["token", identity]); return "token"; },
    async call(name, args) {
      calls.push([name, args]);
      if (name === "hub_context_get") return { workspaceId: input.workspaceId, streamId: input.streamId };
      return { id: input.taskId, revision: 19, workflowStatus: "awaiting_implementation" };
    },
  };
  const result = await executeTaskAwaitCutover(input, {
    inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
    openRuntime: async () => ({
      service,
      taskBoard: { task: () => task },
      workspaceCatalog: {
        workspace: () => ({ id: input.workspaceId, settings: { workingDirectory: input.repositoryRoot } }),
        stream: () => ({ id: input.streamId, workspaceId: input.workspaceId, settings: {} }),
      },
      close() { closed += 1; },
    }),
  });
  assert.equal(result.result.workflowStatus, "awaiting_implementation");
  assert.deepEqual(calls.at(-1), ["hub_task_status_update", {
    context_token: "token",
    request_id: input.requestId,
    task_id: input.taskId,
    status: "awaiting_implementation",
    expected_task_revision: 18,
    expected_workflow_status: "testing",
    cutover_source_commit: sha,
    cutover_projector_sha256: projectorSha,
  }]);
  assert.equal(closed, 1);
});

test("Await cutover closes stores and performs no mutation after stale Task readback", async () => {
  const input = parseTaskAwaitCutoverArguments(argumentsFixture());
  const calls = [];
  let closed = 0;
  await assert.rejects(executeTaskAwaitCutover(input, {
    inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
    openRuntime: async () => ({
      service: {
        contextToken: () => "token",
        async call(name) { calls.push(name); return { workspaceId: input.workspaceId, streamId: input.streamId }; },
      },
      taskBoard: { task: () => ({
        id: input.taskId, workspaceId: input.workspaceId, streamId: input.streamId,
        revision: 19, workflowStatus: "testing",
      }) },
      workspaceCatalog: {},
      close() { closed += 1; },
    }),
  }), /revision or status changed/u);
  assert.deepEqual(calls, ["hub_context_get"]);
  assert.equal(closed, 1);
});

test("Await cutover rejects missing, mismatched or ambiguous Task result authority before mutation", async () => {
  const input = parseTaskAwaitCutoverArguments(argumentsFixture());
  for (const gitReferences of [
    [],
    [{ projectRoot: input.repositoryRoot, resultCommit: "c".repeat(40) }],
    [
      { projectRoot: input.repositoryRoot, resultCommit: sha },
      { projectRoot: input.repositoryRoot, resultCommit: sha },
    ],
  ]) {
    const calls = [];
    await assert.rejects(executeTaskAwaitCutover(input, {
      inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
      openRuntime: async () => ({
        service: {
          contextToken: () => "token",
          async call(name) {
            calls.push(name);
            return { workspaceId: input.workspaceId, streamId: input.streamId };
          },
        },
        taskBoard: { task: () => ({
          id: input.taskId, workspaceId: input.workspaceId, streamId: input.streamId,
          revision: input.expectedTaskRevision, workflowStatus: "testing", gitReferences,
        }) },
        workspaceCatalog: {
          workspace: () => ({ id: input.workspaceId, settings: { workingDirectory: input.repositoryRoot } }),
          stream: () => ({ id: input.streamId, workspaceId: input.workspaceId, settings: {} }),
        },
        close() {},
      }),
    }), /unique authoritative Task result/u);
    assert.deepEqual(calls, ["hub_context_get"]);
  }
});

test("production cutover composer writes the canonical receipt and leaves unrelated pending work untouched", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-await-cutover-"));
  const repositoryRoot = path.join(root, "repository");
  const databaseFile = path.join(root, "journal.sqlite");
  const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
  await rawCatalog.load();
  const rawTasks = new TaskBoardStore({ databaseFile });
  let readCatalog = null;
  let readTasks = null;
  t.after(async () => {
    readTasks?.close();
    readCatalog?.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await rawCatalog.runMutation(() => rawCatalog.createWorkspace({
    name: "Agent HUB",
    settings: { releaseWorkflowEnabled: true, workingDirectory: repositoryRoot },
  }));
  const stream = await rawCatalog.runMutation(() => rawCatalog.createStream({
    workspaceId: workspace.id, name: "Release owner",
  }));
  await rawCatalog.runMutation(() => rawCatalog.bindThread({
    streamId: stream.id, provider: "codex", threadId: "thread-cutover", projectRoot: repositoryRoot,
  }));
  const created = rawTasks.create({
    text: "Release cutover", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  rawTasks.claim(created.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "thread-cutover", turnId: "turn-cutover", operationId: "claim-cutover",
  });
  const referenced = rawTasks.recordTaskGitReference({
    taskId: created.id,
    projectRoot: repositoryRoot,
    branch: "HUB-216",
    resultSnapshot: { repoRoot: repositoryRoot, tree: sha },
  });
  const testing = rawTasks.setWorkflowStatus(referenced.id, "testing");
  rawCatalog.beginMcpOperation({
    requestId: "unrelated-pending",
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-cutover",
    toolName: "hub_task_update",
    argumentsHash: "d".repeat(64),
  });
  rawTasks.close();
  rawCatalog.close();

  const lease = { signal: null, async assertOwned() {} };
  const taskGitWorkspaces = {
    releaseEvidence: async () => [],
    withTaskLock: async (_taskId, operation) => operation(lease),
    withTaskRecoveryLock: async (_taskId, operation) => operation(lease),
    withTaskRepositoryRecoveryLock: async (_taskId, _projectRoot, _taskLease, operation) => operation(lease),
    prepareOwned: async () => ({ projectRoot: repositoryRoot }),
    snapshotAndMergeOwned: async () => ({
      snapshot: {
        branch: "HUB-216", projectRoot: repositoryRoot,
        repositoryRoot, baseCommit: "e".repeat(40), headCommit: sha,
      },
      integration: {
        outcome: "integrated", resultProved: true, integrated: true,
        dev: { branch: "dev", headCommit: "f".repeat(40) },
      },
    }),
    cleanupOwned: async () => {},
    cleanupPreview: async () => ({ workspaces: [], gitReferences: [], deleting: [] }),
  };
  const releasePreflight = {
    preflight: async () => ({}),
    withAwaitTransition: async (_workspaceId, operation) => operation(),
    prepareAwaitSet: async () => ({
      workspaceId: workspace.id, planRevision: "plan-after-cutover", taskIds: [created.id], releaseCandidates: [],
    }),
  };
  const input = {
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-cutover",
    taskId: created.id,
    requestId: "exact-await-cutover",
    repositoryRoot,
    expectedSourceCommit: sha,
    expectedProjectorSha256: projectorSha,
    expectedTaskRevision: testing.revision,
    confirm: true,
  };
  const result = await executeTaskAwaitCutover(input, {
    inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
    openRuntime: () => openTaskAwaitCutoverRuntime({
      config: { dataDir: root, projectRoot: repositoryRoot, taskBoard: { autoPlaceConfidence: 0.82 } },
      taskGitWorkspaces,
      releasePreflight,
    }),
  });
  assert.equal(result.result.workflowStatus, "awaiting_implementation");
  assert.equal(result.result.preReleaseIntegration.planRevision, "plan-after-cutover");

  readCatalog = new WorkspaceCatalogStore({ databaseFile });
  await readCatalog.load();
  readTasks = new TaskBoardStore({ databaseFile });
  assert.equal(readCatalog.mcpOperation("unrelated-pending").status, "pending");
  const receipt = readCatalog.mcpOperation(input.requestId);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.receiptState, "succeeded");
  assert.equal(receipt.toolName, "hub_task_status_update");
  assert.equal(readTasks.task(created.id).workflowStatus, "awaiting_implementation");
  assert.equal(readTasks.lifecycleOutcome(input.requestId).result.task.workflowStatus, "awaiting_implementation");
});

test("production cutover rollback reopens and settles its exact extended receipt without replay", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-await-cutover-rollback-"));
  const repositoryRoot = path.join(root, "repository");
  const databaseFile = path.join(root, "journal.sqlite");
  const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
  await rawCatalog.load();
  const rawTasks = new TaskBoardStore({ databaseFile });
  let runtime = null;
  t.after(async () => {
    runtime?.close();
    rawTasks.close();
    rawCatalog.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await rawCatalog.runMutation(() => rawCatalog.createWorkspace({
    name: "Agent HUB",
    settings: { releaseWorkflowEnabled: true, workingDirectory: repositoryRoot },
  }));
  const stream = await rawCatalog.runMutation(() => rawCatalog.createStream({
    workspaceId: workspace.id, name: "Architect", settings: { architect: true },
  }));
  await rawCatalog.runMutation(() => rawCatalog.bindThread({
    streamId: stream.id, provider: "codex", threadId: "thread-cutover-rollback", projectRoot: repositoryRoot,
  }));
  const created = rawTasks.create({
    text: "Release cutover rollback", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  rawTasks.claim(created.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "thread-cutover-rollback", turnId: "turn-cutover-rollback", operationId: "claim-cutover-rollback",
  });
  const referenced = rawTasks.recordTaskGitReference({
    taskId: created.id,
    projectRoot: repositoryRoot,
    branch: "HUB-217",
    resultSnapshot: { repoRoot: repositoryRoot, tree: sha },
  });
  const testing = rawTasks.setWorkflowStatus(referenced.id, "testing");
  rawTasks.close();
  rawCatalog.close();

  let snapshotCalls = 0;
  const lease = { signal: null, async assertOwned() {} };
  const taskGitWorkspaces = {
    releaseEvidence: async () => [],
    withTaskLock: async (_taskId, operation) => operation(lease),
    withTaskRecoveryLock: async (_taskId, operation) => operation(lease),
    withTaskRepositoryRecoveryLock: async (_taskId, _projectRoot, _taskLease, operation) => operation(lease),
    prepareOwned: async () => ({ projectRoot: repositoryRoot }),
    snapshotAndMergeOwned: async () => {
      snapshotCalls += 1;
      return {
        snapshot: {
          branch: "HUB-217", projectRoot: repositoryRoot,
          repositoryRoot, baseCommit: "e".repeat(40), headCommit: sha,
        },
        integration: {
          outcome: "integrated", resultProved: true, integrated: true,
          dev: { branch: "dev", headCommit: "f".repeat(40) },
        },
      };
    },
    cleanupOwned: async () => {},
    cleanupPreview: async () => ({ workspaces: [], gitReferences: [], deleting: [] }),
  };
  const releasePreflight = {
    preflight: async () => ({}),
    withAwaitTransition: async (_workspaceId, operation) => operation(),
    prepareAwaitSet: async () => { throw new Error("injected PreRelease rebuild failure"); },
  };
  const openRuntime = () => openTaskAwaitCutoverRuntime({
    config: { dataDir: root, projectRoot: repositoryRoot, taskBoard: { autoPlaceConfidence: 0.82 } },
    taskGitWorkspaces,
    releasePreflight,
  });
  const requestId = "exact-await-cutover-rollback";
  const input = {
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-cutover-rollback",
    taskId: created.id,
    requestId,
    repositoryRoot,
    expectedSourceCommit: sha,
    expectedProjectorSha256: projectorSha,
    expectedTaskRevision: testing.revision,
    confirm: true,
  };
  await assert.rejects(executeTaskAwaitCutover(input, {
    inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
    openRuntime,
  }), /injected PreRelease rebuild failure/u);

  runtime = await openRuntime();
  const token = runtime.service.contextToken({
    provider: input.provider, threadId: input.threadId, streamId: input.streamId,
  });
  const before = runtime.taskBoard.task(input.taskId);
  assert.equal(before.workflowStatus, "testing");
  assert.equal(runtime.workspaceCatalog.mcpOperation(requestId).receiptState, "unknown");
  assert.equal(runtime.taskBoard.lifecycleTransition(requestId), null);
  assert.equal(runtime.taskBoard.lifecycleOutcome(requestId).result.rollback.completed, true);
  const reconciled = await runtime.service.call("hub_task_operation_reconcile", {
    context_token: token,
    request_id: "reconcile-cutover-rollback",
    task_id: input.taskId,
    operation_request_id: requestId,
    project_root: repositoryRoot,
    expected_task_revision: input.expectedTaskRevision,
    expected_workflow_status: "testing",
    cutover_source_commit: sha,
    cutover_projector_sha256: projectorSha,
    confirm_reconcile: true,
  });
  assert.equal(reconciled.outcome, "failed");
  assert.equal(reconciled.reconciliation.durableState, "workflow_rollback");
  assert.equal(runtime.workspaceCatalog.mcpOperation(requestId).receiptState, "failed");
  assert.equal(runtime.taskBoard.task(input.taskId).workflowStatus, "testing");
  assert.equal(snapshotCalls, 1);
});
