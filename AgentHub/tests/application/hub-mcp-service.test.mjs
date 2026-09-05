import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { incomingLedgerRecord } from "../../src/application/work-log-usage-projection.mjs";
import { createInterstreamMessage } from "../../src/domain/interstream-message.mjs";
import { AsyncSqliteMutationQueue } from "../../src/infrastructure/persistence/async-sqlite-mutation-queue.mjs";
import {
  initializeTaskGitRepository,
  unprovenProcessTaskGit,
} from "../helpers/task-git-unproven-process.mjs";

async function fixture(context, { releaseWorkflowEnabled = false, taskGitWorkspacesFactory = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project");
  const streamWorkingDirectory = path.join(directory, "stream-working-directory");
  const workspaceWorkingDirectory = path.join(directory, "workspace-working-directory");
  const targetWorkingDirectory = path.join(directory, "target-working-directory");
  const foreignWorkspaceWorkingDirectory = path.join(directory, "foreign-workspace-working-directory");
  const foreignStreamWorkingDirectory = path.join(directory, "foreign-stream-working-directory");
  const attachmentDirectory = path.join(directory, "attachments");
  await mkdir(projectRoot, { recursive: true });
  const tasks = new Map([
    ["task-current", {
      id: "task-current", title: "Current", description: "", bucket: "workspace",
      status: "open", workflowStatus: "new", workspaceId: "workspace-1", streamId: null, boardOrder: 0, revision: 1,
    }],
    ["task-foreign", {
      id: "task-foreign", title: "Foreign", description: "", bucket: "workspace",
      status: "open", workflowStatus: "new", workspaceId: "workspace-2", streamId: null, boardOrder: 0, revision: 1,
    }],
  ]);
  const workspaceCatalog = {
    resolveThread: ({ provider, threadId }) => {
      if (provider !== "codex" || !["thread-1", "thread-2", "thread-3"].includes(threadId)) return null;
      const streamId = threadId === "thread-1" ? "stream-1" : threadId === "thread-2" ? "stream-2" : "stream-3";
      const foreign = streamId === "stream-3";
      return {
        workspaceId: foreign ? "workspace-2" : "workspace-1",
        workspaceName: foreign ? "Foreign Workspace" : "Agent Hub",
        streamId,
        streamDisplayName: streamId === "stream-1" ? "MCP" : streamId === "stream-2" ? "Themes" : "Foreign Stream",
        thread: { projectRoot: foreign ? foreignStreamWorkingDirectory : projectRoot },
      };
    },
    stream: (id) => ({
      "stream-1": {
        id, workspaceId: "workspace-1", displayName: "MCP", settings: { project: projectRoot },
        threads: [{ provider: "codex", threadId: "thread-1" }],
      },
      "stream-2": {
        id, workspaceId: "workspace-1", displayName: "Themes", settings: { workingDirectory: targetWorkingDirectory },
        threads: [{ provider: "codex", threadId: "thread-2" }],
      },
      "stream-3": {
        id, workspaceId: "workspace-2", displayName: "Foreign Stream", settings: { workingDirectory: foreignStreamWorkingDirectory },
        threads: [{ provider: "codex", threadId: "thread-3" }],
      },
    }[id] ?? null),
    activeThread: () => null,
    workspace: (id) => ({
      "workspace-1": { id, name: "Agent Hub", settings: { releaseWorkflowEnabled, workingDirectory: workspaceWorkingDirectory } },
      "workspace-2": { id, name: "Foreign Workspace", settings: { releaseWorkflowEnabled, workingDirectory: foreignWorkspaceWorkingDirectory } },
    }[id] ?? null),
    hierarchy: () => [{
      id: "workspace-1", name: "Agent Hub",
      settings: { releaseWorkflowEnabled, workingDirectory: workspaceWorkingDirectory },
      streams: [
        { id: "stream-1", displayName: "MCP", settings: { architect: true, workingDirectory: streamWorkingDirectory }, threads: [{ provider: "codex", threadId: "thread-1" }] },
        { id: "stream-2", displayName: "Themes", settings: { workingDirectory: targetWorkingDirectory }, threads: [{ provider: "codex", threadId: "thread-2" }] },
      ],
    }, {
      id: "workspace-2", name: "Foreign Workspace",
      settings: { releaseWorkflowEnabled, workingDirectory: foreignWorkspaceWorkingDirectory },
      streams: [
        { id: "stream-3", displayName: "Foreign Stream", settings: { workingDirectory: foreignStreamWorkingDirectory }, threads: [{ provider: "codex", threadId: "thread-3" }] },
      ],
    }],
    workspaceEvents: (workspaceId, { afterSequence }) => [{
      sequence: afterSequence + 1, workspaceId, streamId: workspaceId === "workspace-2" ? "stream-3" : "stream-1",
      type: "run.completed", subjectId: "turn-1", payload: {}, createdAtMs: 1,
    }],
    developerRulesForStream: (streamId) => ({
      workspace: { revision: 1, content: streamId === "stream-3" ? "Foreign Workspace rule" : "Workspace rule" },
      stream: { revision: 2, content: streamId === "stream-3" ? "Foreign Stream rule" : "Stream rule" },
    }),
    updateWorkspaceDeveloperRules: (id, content) => ({ workspaceId: id, revision: 2, content }),
    updateStreamDeveloperRules: (id, content) => ({ streamId: id, revision: 3, content }),
  };
  const operations = new Map();
  const taskEvidenceCalls = [];
  const legacyAdoptionCalls = [];
  const taskClaimCalls = [];
  workspaceCatalog.beginMcpOperation = (operation) => {
    const existing = operations.get(operation.requestId);
    if (existing) {
      if (existing.argumentsHash !== operation.argumentsHash) {
        throw new Error("MCP request_id was already used for another operation");
      }
      return { ...existing, replayed: true };
    }
    const created = { ...operation, status: "pending", result: null, error: "", replayed: false };
    operations.set(operation.requestId, created);
    return created;
  };
  workspaceCatalog.bindMcpOperationInterstreamContentHash = (requestId, contentHash) => {
    const operation = operations.get(requestId);
    if (operation.interstreamContentHash && operation.interstreamContentHash !== contentHash) {
      throw new Error("MCP interstream content does not match the original admission");
    }
    operation.interstreamContentHash = contentHash;
    return operation;
  };
  workspaceCatalog.completeMcpOperation = (requestId, result) => {
    const operation = operations.get(requestId);
    if (["hub_stream_message_send", "hub_task_start", "hub_task_reassign"].includes(operation.toolName)
      && !operation.interstreamContentHash) {
      throw new Error("MCP interstream operation has no admitted content hash");
    }
    Object.assign(operations.get(requestId), { status: "succeeded", result });
  };
  workspaceCatalog.failMcpOperation = (requestId, error) => {
    Object.assign(operations.get(requestId), { status: "failed", error: error.message });
  };
  workspaceCatalog.markMcpOperationUnknown = (requestId, error) => {
    Object.assign(operations.get(requestId), { status: "unknown", error: error.message });
  };
  workspaceCatalog.mcpOperations = () => [...operations.values()];
  const workspaceMutations = new AsyncSqliteMutationQueue();
  workspaceCatalog.runMutation = (operation, options) => workspaceMutations.run(operation, options);
  workspaceCatalog.mutationDiagnostics = () => workspaceMutations.diagnostics();
  const taskBoard = {
    snapshot: () => [...tasks.values()].map((task) => ({ ...task, attachments: task.attachments ?? [] })),
    task: (id) => tasks.get(id) ?? null,
    create: ({ text, sourceDetails = {}, bucket = "backlog", workspaceId = null }) => {
      const task = {
        id: "created", title: text, description: "", bucket,
        status: "open", workflowStatus: "new", workspaceId, sourceDetails,
      };
      tasks.set(task.id, task);
      return task;
    },
    move: ({ id, bucket, workspaceId = null }) => Object.assign(tasks.get(id), { bucket, workspaceId }),
    update: ({ id, title, description }) => Object.assign(tasks.get(id), { title, description }),
    markStarted: ({ id, workspaceId, streamId }) => Object.assign(tasks.get(id), {
      status: "started", workflowStatus: "in_progress", workspaceId, streamId,
    }),
    claim: ({ id, streamId, turnId, operationId, operationKind, gitBaseline }) => {
      taskClaimCalls.push({ id, turnId, operationId, operationKind });
      return Object.assign(tasks.get(id), {
        status: "started", workflowStatus: "in_progress", streamId, claimedTurnId: turnId, gitBaseline,
      });
    },
    requestWorkflowStatus: ({ id, status, turnId }) => Object.assign(tasks.get(id), {
      workflowStatus: status, requestedWorkflowStatus: status, requestedTurnId: turnId,
    }),
    beginLifecycleTransition: ({ id, operationId, targetWorkflowStatus, expectedRevision, kind }) => {
      const task = tasks.get(id);
      if (task.revision !== expectedRevision) throw new Error("revision conflict");
      task.lifecycleOperation = { operationId, targetWorkflowStatus, kind };
      return { task, replayed: false };
    },
    lifecycleTransition: (operationId) => {
      const task = [...tasks.values()].find((item) => item.lifecycleOperation?.operationId === operationId);
      return task ? {
        operationId, taskId: task.id, kind: task.lifecycleOperation.kind,
        phase: task.lifecycleOperation.kind === "workflow" ? "pending_git" : "cleanup",
      } : null;
    },
    failLifecycleTransition: (operationId) => {
      for (const task of tasks.values()) {
        if (task.lifecycleOperation?.operationId === operationId) delete task.lifecycleOperation;
      }
    },
    commitWorkflowTransition: ({ operationId, gitReferences = [], replaceGitReferences = true }) => {
      const task = [...tasks.values()].find((item) => item.lifecycleOperation?.operationId === operationId);
      task.workflowStatus = task.lifecycleOperation.targetWorkflowStatus;
      if (replaceGitReferences) task.gitReferences = gitReferences;
      task.revision += 1;
      delete task.lifecycleOperation;
      return task;
    },
    finalizeCleanupTransition: (operationId, { deleteTask = false } = {}) => {
      const task = [...tasks.values()].find((item) => item.lifecycleOperation?.operationId === operationId);
      delete task.lifecycleOperation;
      if (deleteTask) {
        tasks.delete(task.id);
        return { deleted: true, task };
      }
      task.status = "done";
      return task;
    },
    recordTaskTurn: ({ taskId, operationId, changedFiles, branch, resultSnapshot }) => {
      taskEvidenceCalls.push({ taskId, operationId, changedFiles, branch, resultSnapshot });
      return Object.assign(tasks.get(taskId), {
        gitReferences: [{ projectRoot, branch, resultCommit: resultSnapshot.tree }],
      });
    },
    recordTaskGitReference: ({ taskId, projectRoot: root, branch, resultSnapshot }) => {
      taskEvidenceCalls.push({ taskId, projectRoot: root, branch, resultSnapshot });
      return Object.assign(tasks.get(taskId), {
        gitReferences: [{ projectRoot: root, branch, resultCommit: resultSnapshot.tree }],
      });
    },
    adoptLegacyGitReference: (options) => {
      legacyAdoptionCalls.push(options);
      const task = tasks.get(options.taskId);
      return Object.assign(task, {
        revision: Number(task.revision) + 1,
        gitReferences: [{
          projectRoot: options.projectRoot,
          branch: options.branch,
          resultCommit: options.mainResultCommit,
        }],
        gitAdoptions: [{ evidenceTurnId: options.evidenceTurnId, patchId: options.patchId }],
      });
    },
    releaseTasks: () => [],
    setWorkflowStatus: ({ id, status }) => Object.assign(tasks.get(id), {
      workflowStatus: status,
    }),
    complete: ({ id }) => Object.assign(tasks.get(id), { status: "done", workflowStatus: "done" }),
    remove: ({ id }) => tasks.delete(id),
    addAttachment: ({ id, attachment }) => {
      const task = tasks.get(id);
      task.attachments = [{ id: path.basename(attachment), name: "evidence.txt", type: "text/plain" }];
      return task;
    },
  };
  const historyRecordsByThread = new Map([["thread-1", [{
      provider: "codex", threadId: "thread-1", turnId: "turn-1", title: "Done",
      prompt: [{ type: "text", text: "Initial prompt" }], body: "Result", status: "completed",
    }]], ["thread-3", [{
      provider: "codex", threadId: "thread-3", turnId: "turn-foreign-done", title: "Foreign Done",
      prompt: "Foreign prompt", body: "Foreign result", status: "completed",
      completedAt: "2026-09-01T12:00:00.000Z",
    }]]]);
  const workLog = {
    threadTurns: async (identities, { limit = 20 } = {}) => identities
      .flatMap((identity) => historyRecordsByThread.get(identity.threadId) ?? [])
      .slice(0, limit),
  };
  const releaseCalls = [];
  const preflightCalls = [];
  const releasePlanWorkspaceIds = [];
  const taskGitPrepareCalls = [];
  const defaultTaskGitWorkspaces = {
    prepare: async ({ taskId, projectRoot: selectedProjectRoot }) => {
      taskGitPrepareCalls.push({ taskId, projectRoot: selectedProjectRoot });
      return {
        taskId,
        branch: `agenthub/task/${taskId}/repo`,
        projectRoot: path.join(directory, "task-worktree", taskId),
        repositoryRoot: selectedProjectRoot,
        baseCommit: "a".repeat(40),
        headCommit: "a".repeat(40),
        gitBaseline: { repoRoot: selectedProjectRoot, tree: "a".repeat(40) },
      };
    },
    prepareOwned: async (params) => defaultTaskGitWorkspaces.prepare(params),
    snapshotAndMerge: async ({ taskId }) => ({
      snapshot: {
        taskId,
        branch: `agenthub/task/${taskId}/repo`,
        projectRoot: path.join(directory, "task-worktree", taskId),
        repositoryRoot: projectRoot,
        baseCommit: "a".repeat(40),
        headCommit: "a".repeat(40),
        gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
        resultSnapshot: { repoRoot: projectRoot, tree: "a".repeat(40) },
        changedFiles: [{ projectRoot, path: "result.mjs", operation: "modified" }],
      },
      integration: {
        integrated: true,
        resultProved: true,
        outcome: "integrated",
        alreadyIntegrated: true,
        dev: { branch: "dev", headCommit: "a".repeat(40) },
      },
    }),
    adoptLegacyResult: async ({
      taskId, taskNumber, projectRoot: selectedProjectRoot, reportedResultCommit, mainResultCommit,
    }) => ({
      taskId,
      projectRoot: selectedProjectRoot,
      branch: taskNumber,
      baseCommit: "0".repeat(40),
      reportedResultCommit,
      resultCommit: mainResultCommit,
      mainCommit: mainResultCommit,
      patchId: "f".repeat(40),
      changedFiles: [{ projectRoot: selectedProjectRoot, path: "AgentHub/app.js", operation: "modified" }],
    }),
    snapshotAndMergeOwned: async (params) => defaultTaskGitWorkspaces.snapshotAndMerge(params),
    withTaskLock: async (_taskId, operation) => operation({
      signal: new AbortController().signal,
      async assertOwned() {},
    }),
    cleanupPreview: async (taskId, { gitReferences = [] } = {}) => ({
      taskId, workspaces: [], gitReferences, dirty: false,
      unpublished: gitReferences.filter((item) => item.published === false), deleting: [],
    }),
    cleanup: async () => ({ removed: 1 }),
    cleanupOwned: async (...args) => defaultTaskGitWorkspaces.cleanup(...args),
  };
  const taskGitWorkspaces = taskGitWorkspacesFactory
    ? await taskGitWorkspacesFactory({
        context, directory, projectRoot, streamWorkingDirectory, workspaceWorkingDirectory,
      })
    : defaultTaskGitWorkspaces;
  const service = new HubMcpService({
    workspaceCatalog, taskBoard, workLog, attachmentDirectory, secret: "secret",
    taskGitWorkspaces,
    releasePlanner: {
      plan: async (workspaceId) => {
        releasePlanWorkspaceIds.push(workspaceId);
        return { workspaceId, revision: "plan-1", candidates: [], ready: [], draft: [], blocked: [], conflicts: [] };
      },
    },
    releasePreflight: {
      preflight: async (options) => {
        preflightCalls.push(options);
        return { ...options, testContour: { running: true, headCommit: "dev-head" } };
      },
    },
    releaseCompleter: {
      completeRelease: async (options) => {
        releaseCalls.push(options);
        return { ...options, released: [] };
      },
    },
  });
  const taskLaunchCalls = [];
  service.setTaskLauncher(async ({ id, workspaceId, streamId, ...options }, launchContext) => {
    taskLaunchCalls.push({ id, workspaceId, streamId, ...options });
    await launchContext.bindInterstreamAuditContent(createInterstreamMessage({
      ...launchContext.messageOrigin,
      text: options.message || "Task launch",
    }));
    const selectedProjectRoot = streamId === "stream-3"
      ? foreignStreamWorkingDirectory
      : streamId === "stream-2" ? targetWorkingDirectory
      : streamId === null ? workspaceWorkingDirectory : streamWorkingDirectory;
    const gitWorkspace = await taskGitWorkspaces.prepare({ taskId: id, projectRoot: selectedProjectRoot });
    const task = taskBoard.markStarted({ id, workspaceId, streamId });
    return { task, target: { streamId, provider: "codex", threadId: "thread-1" }, gitWorkspace };
  });
  const sentMessages = [];
  service.setStreamMessenger(async (params, messageContext) => {
    sentMessages.push({ params, context: messageContext });
    return { accepted: false, queued: true, id: "queued-1" };
  });
  const activeRun = {
    id: "run-1", provider: "codex", threadId: "thread-1", turnId: "turn-live",
    projectRoot, status: "running", progressStage: "Editing files", model: "Sol",
    modelId: "gpt-5.6-sol", reasoningId: "high",
  };
  service.setActiveRuns(() => [activeRun]);
  service.setDeferredInputs(() => []);
  return {
    service,
    token: service.contextToken({ provider: "codex", threadId: "thread-1" }),
    attachmentDirectory,
    projectRoot,
    streamWorkingDirectory,
    workspaceWorkingDirectory,
    targetWorkingDirectory,
    foreignWorkspaceWorkingDirectory,
    foreignStreamWorkingDirectory,
    workspaceCatalog,
    taskBoard,
    tasks,
    operations,
    taskEvidenceCalls,
    legacyAdoptionCalls,
    taskClaimCalls,
    taskGitPrepareCalls,
    taskLaunchCalls,
    releaseCalls,
    preflightCalls,
    releasePlanWorkspaceIds,
    taskGitWorkspaces,
    sentMessages,
    historyRecordsByThread,
    activeRun,
  };
}

test("Architect adopts exact terminal legacy evidence without accepting arbitrary HEAD", async (context) => {
  const {
    service, token, tasks, historyRecordsByThread, targetWorkingDirectory, legacyAdoptionCalls,
  } = await fixture(context, { releaseWorkflowEnabled: true });
  const reportedResultCommit = "a".repeat(40);
  const mainResultCommit = "b".repeat(40);
  tasks.set("task-legacy", {
    id: "task-legacy", taskNumber: "HUB-98", title: "Legacy", description: "",
    bucket: "workspace", status: "open", workflowStatus: "awaiting_implementation",
    workspaceId: "workspace-1", streamId: "stream-2", boardOrder: 0, revision: 12,
    gitReferences: [],
  });
  historyRecordsByThread.set("thread-2", [{
    provider: "codex",
    threadId: "thread-2",
    turnId: "turn-legacy",
    title: "HUB-98 completion",
    prompt: "Finish HUB-98",
    body: `HUB-98 moved to Await. Exact result commit: ${reportedResultCommit}`,
    status: "completed",
  }]);

  const result = await service.call("hub_task_legacy_git_adopt", {
    context_token: token,
    request_id: "adopt-legacy-1",
    task_id: "task-legacy",
    expected_task_revision: 12,
    evidence_turn_id: "turn-legacy",
    reported_result_commit: reportedResultCommit,
    main_result_commit: mainResultCommit,
    confirm_adoption: true,
  });

  assert.equal(result.gitReferences[0].resultCommit, mainResultCommit);
  assert.equal(result.gitAdoption.projectRoot, targetWorkingDirectory);
  assert.equal(result.gitAdoption.patchId, "f".repeat(40));
  assert.equal(legacyAdoptionCalls[0].evidenceTurnId, "turn-legacy");

  await assert.rejects(() => service.call("hub_task_legacy_git_adopt", {
    context_token: service.contextToken({ provider: "codex", threadId: "thread-2" }),
    request_id: "adopt-legacy-non-architect",
    task_id: "task-legacy",
    expected_task_revision: 13,
    evidence_turn_id: "turn-legacy",
    reported_result_commit: reportedResultCommit,
    main_result_commit: mainResultCommit,
    confirm_adoption: true,
  }), /requires an Architect Stream/u);
});

test("HubMcpService lists and changes Dashboard Tasks across Workspaces", async (context) => {
  const { service, token } = await fixture(context);
  assert.equal((await service.call("hub_context_get", { context_token: token })).workspaceId, "workspace-1");
  assert.deepEqual(
    (await service.call("hub_tasks_list", { context_token: token })).tasks.map((task) => task.id),
    ["task-current", "task-foreign"],
  );
  assert.equal(
    (await service.call("hub_task_get", { context_token: token, task_id: "task-foreign" })).id,
    "task-foreign",
  );
  const updated = await service.call("hub_task_update", {
    context_token: token,
    request_id: "foreign-task-update",
    task_id: "task-foreign",
    title: "Updated from another Workspace",
  });
  assert.equal(updated.title, "Updated from another Workspace");
});

test("HubMcpService supports the first Stream turn before provider Thread assignment", async (context) => {
  const { service } = await fixture(context);
  const developerContext = service.developerContext({ provider: "claude", streamId: "stream-1" });
  const token = /Required MCP arguments: (\{.+\})/u.exec(developerContext)?.[1];
  const { context_token: contextToken } = JSON.parse(token);
  assert.match(developerContext, /pending first Thread/u);
  assert.match(developerContext, /Do not search environment variables/u);
  assert.equal((await service.call("hub_context_get", { context_token: contextToken })).streamId, "stream-1");
});

test("HubMcpService falls back to Stream context while a rotated Thread is not bound yet", async (context) => {
  const { service } = await fixture(context);
  const developerContext = service.developerContext({
    provider: "codex",
    threadId: "rotated-thread-not-bound-yet",
    streamId: "stream-1",
  });
  const token = /Required MCP arguments: (\{.+\})/u.exec(developerContext)?.[1];
  const { context_token: contextToken } = JSON.parse(token);

  assert.match(developerContext, /Workspace: Agent Hub \(workspace-1\)/u);
  assert.equal((await service.call("hub_context_get", { context_token: contextToken })).streamId, "stream-1");
});

test("HubMcpService starts the current Workspace task in the current Stream", async (context) => {
  const {
    service, token, operations, streamWorkingDirectory, taskGitPrepareCalls, taskLaunchCalls,
  } = await fixture(context);
  const task = await service.call("hub_task_start", {
    context_token: token, request_id: "start-task", task_id: "task-current", confirm_launch: true,
  });
  assert.equal(task.task.status, "started");
  assert.equal(task.task.workflowStatus, "in_progress");
  assert.equal(task.target.streamId, "stream-1");
  assert.equal(taskGitPrepareCalls[0].projectRoot, streamWorkingDirectory);
  assert.equal("workingDirectory" in taskLaunchCalls[0], false);
  assert.match(task.gitWorkspace.projectRoot, /task-worktree[\\/]task-current$/u);
  assert.equal(operations.get("start-task").status, "succeeded");
  assert.match(operations.get("start-task").interstreamContentHash, /^[a-f0-9]{64}$/u);
});

test("HubMcpService starts a Task from the target Stream working directory", async (context) => {
  const { service, token, targetWorkingDirectory, taskGitPrepareCalls } = await fixture(context);
  await service.call("hub_task_start", {
    context_token: token,
    request_id: "start-target-task",
    task_id: "task-current",
    stream_id: "stream-2",
    confirm_launch: true,
  });
  assert.equal(taskGitPrepareCalls[0].projectRoot, targetWorkingDirectory);
});

test("HubMcpService uses the Workspace working directory for a new Stream", async (context) => {
  const { service, token, workspaceWorkingDirectory, taskGitPrepareCalls, taskLaunchCalls } = await fixture(context);
  await service.call("hub_task_start", {
    context_token: token,
    request_id: "start-new-stream-task",
    task_id: "task-current",
    new_stream_name: "New Stream",
    confirm_launch: true,
  });
  assert.equal(taskGitPrepareCalls[0].projectRoot, workspaceWorkingDirectory);
  assert.deepEqual(taskLaunchCalls[0].settings, {
    provider: "codex", model: "gpt-5.6-sol", reasoning: "high",
  });
});

test("HubMcpService reports Stream availability from active turns and queued input", async (context) => {
  const { service, token } = await fixture(context);
  service.setDeferredInputs(() => [{
    id: "queued-1", provider: "codex", threadId: "thread-2",
    clientUserMessageId: "client-queued-1", state: "dispatching",
    conflictKind: "message-intake", dispatchingAt: "2026-09-03T15:29:50.062Z",
  }]);

  const result = await service.call("hub_parallel_streams_list", { context_token: token });
  const active = await service.call("hub_active_runs_list", { context_token: token });
  const current = result.streams.find((stream) => stream.id === "stream-1");
  const queued = result.streams.find((stream) => stream.id === "stream-2");
  assert.equal(current.activeRuns.length, 1);
  assert.equal(current.queuedInputCount, 0);
  assert.equal(current.available, false);
  assert.equal(queued.activeRuns.length, 0);
  assert.equal(queued.queuedInputCount, 1);
  assert.equal(queued.stalledDeferredInputCount, 1);
  assert.equal(queued.deferredInputs[0].state, "dispatching");
  assert.equal(queued.deferredInputs[0].clientUserMessageId, "client-queued-1");
  assert.equal(active.deferredInputs[0].stalled, true);
  assert.equal(queued.available, false);
});

test("HubMcpService reassigns a started Task and preserves assignment context", async (context) => {
  const { service, token, operations, tasks, taskLaunchCalls } = await fixture(context);
  Object.assign(tasks.get("task-current"), {
    status: "started", workflowStatus: "in_progress", streamId: "stream-1",
  });
  service.setActiveRuns(() => []);

  const result = await service.call("hub_task_reassign", {
    context_token: token,
    request_id: "reassign-task",
    task_id: "task-current",
    stream_id: "stream-2",
    message: "Пришли результат в Architect.",
    confirm_launch: true,
  });

  assert.equal(result.previousStreamId, "stream-1");
  assert.equal(result.task.streamId, "stream-2");
  assert.equal(taskLaunchCalls[0].reassign, true);
  assert.equal(taskLaunchCalls[0].message, "Пришли результат в Architect.");
  assert.equal(operations.get("reassign-task").status, "succeeded");
  assert.match(operations.get("reassign-task").interstreamContentHash, /^[a-f0-9]{64}$/u);
});

test("HubMcpService blocks reassignment while the current executor is busy", async (context) => {
  const { service, token, tasks, taskLaunchCalls } = await fixture(context);
  Object.assign(tasks.get("task-current"), {
    status: "started", workflowStatus: "in_progress", streamId: "stream-1",
  });

  await assert.rejects(() => service.call("hub_task_reassign", {
    context_token: token,
    request_id: "reassign-busy-task",
    task_id: "task-current",
    stream_id: "stream-2",
    confirm_launch: true,
  }), /active turn or queued input/u);
  assert.equal(taskLaunchCalls.length, 0);
});

test("HubMcpService blocks reassignment while the current executor has queued input", async (context) => {
  const { service, token, tasks, taskLaunchCalls } = await fixture(context);
  Object.assign(tasks.get("task-current"), {
    status: "started", workflowStatus: "in_progress", streamId: "stream-1",
  });
  service.setActiveRuns(() => []);
  service.setDeferredInputs(() => [{ id: "queued-current", streamId: "stream-1" }]);

  await assert.rejects(() => service.call("hub_task_reassign", {
    context_token: token,
    request_id: "reassign-queued-task",
    task_id: "task-current",
    stream_id: "stream-2",
    confirm_launch: true,
  }), /active turn or queued input/u);
  assert.equal(taskLaunchCalls.length, 0);
});

test("HubMcpService keeps workflow Done visible until explicit completion", async (context) => {
  const { service, token } = await fixture(context, { releaseWorkflowEnabled: true });
  const testing = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-testing",
    task_id: "task-current",
    status: "testing",
  });
  const done = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-done",
    task_id: "task-current",
    status: "done",
  });
  const completePreview = await service.call("hub_task_complete", {
    context_token: token,
    request_id: "task-complete",
    task_id: "task-current",
  });
  const completed = await service.call("hub_task_complete", {
    context_token: token,
    request_id: "task-complete-confirmed",
    task_id: "task-current",
    confirm_cleanup: true,
    expected_cleanup_token: completePreview.cleanupToken,
  });

  assert.equal(testing.workflowStatus, "testing");
  assert.equal(done.workflowStatus, "done");
  assert.notEqual(done.status, "done");
  assert.equal(completed.workflowStatus, "done");
  assert.equal(completed.status, "done");
});

test("release-enabled Task statuses can be changed and rolled back directly", async (context) => {
  const { service, token, workspaceCatalog } = await fixture(context);
  workspaceCatalog.workspace = (id) => id === "workspace-1" ? {
    id, name: "Agent Hub", settings: { releaseWorkflowEnabled: true },
  } : null;

  const awaiting = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-awaiting-direct",
    task_id: "task-current",
    status: "awaiting_implementation",
  });
  const testing = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-awaiting-rollback",
    task_id: "task-current",
    status: "testing",
  });
  const done = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-done-direct",
    task_id: "task-current",
    status: "done",
  });

  assert.equal(awaiting.workflowStatus, "awaiting_implementation");
  assert.equal(testing.workflowStatus, "testing");
  assert.equal(done.workflowStatus, "done");
});

test("Await status and old evidence remain unchanged when the Task branch conflicts with dev", async (context) => {
  const { service, token, tasks, taskGitWorkspaces, taskEvidenceCalls } = await fixture(context, { releaseWorkflowEnabled: true });
  taskGitWorkspaces.snapshotAndMerge = async ({ taskId }) => ({
    snapshot: {
      taskId,
      branch: `agenthub/task/${taskId}/repo`,
      projectRoot: "D:/task",
      repositoryRoot: "D:/repo",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      gitBaseline: { repoRoot: "D:/repo", tree: "a".repeat(40) },
      resultSnapshot: { repoRoot: "D:/repo", tree: "b".repeat(40) },
      changedFiles: [{ projectRoot: "D:/repo", path: "app.mjs", operation: "modified" }],
    },
    integration: {
      integrated: false,
      resultProved: false,
      outcome: "conflict",
      conflicts: ["app.mjs"],
      error: "merge conflict",
      dev: { branch: "dev", headCommit: "c".repeat(40) },
    },
  });

  await assert.rejects(() => service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-awaiting-conflict",
    task_id: "task-current",
    status: "awaiting_implementation",
  }), /merge conflict/u);

  assert.equal(tasks.get("task-current").workflowStatus, "new");
  assert.equal(taskEvidenceCalls.length, 0);
});

test("Test transition rejects an empty Task diff as no_result and preserves workflow state", async (context) => {
  const { service, token, tasks, taskGitWorkspaces } = await fixture(context);
  taskGitWorkspaces.snapshotAndMerge = async ({ taskId }) => ({
    snapshot: {
      taskId, branch: "HUB-empty", projectRoot: "D:/task", repositoryRoot: "D:/repo",
      baseCommit: "a".repeat(40), headCommit: "a".repeat(40), changedFiles: [],
    },
    integration: {
      integrated: false, alreadyIntegrated: true, resultProved: false,
      outcome: "no_result", error: "Task has no result relative to its immutable base",
    },
  });

  await assert.rejects(() => service.call("hub_task_status_update", {
    context_token: token, request_id: "empty-result", task_id: "task-current", status: "testing",
  }), /no result/u);
  assert.equal(tasks.get("task-current").workflowStatus, "new");
  assert.deepEqual(tasks.get("task-current").gitReferences ?? [], []);
});

test("Task status integration uses its executor Stream root without reassigning it", async (context) => {
  const {
    service, token, tasks, targetWorkingDirectory, taskGitPrepareCalls, taskGitWorkspaces, taskEvidenceCalls,
  } = await fixture(context, { releaseWorkflowEnabled: true });
  Object.assign(tasks.get("task-current"), { streamId: "stream-2", workflowStatus: "in_progress" });
  taskGitWorkspaces.snapshotAndMerge = async ({ taskId, projectRoot }) => ({
    snapshot: {
      taskId,
      branch: `agenthub/task/${taskId}/repo`,
      projectRoot,
      repositoryRoot: targetWorkingDirectory,
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      gitBaseline: { repoRoot: targetWorkingDirectory, tree: "a".repeat(40) },
      resultSnapshot: { repoRoot: targetWorkingDirectory, tree: "b".repeat(40) },
      changedFiles: [{ projectRoot: targetWorkingDirectory, path: "app.mjs", operation: "modified" }],
    },
    integration: {
      integrated: true,
      resultProved: true,
      outcome: "integrated",
      dev: { branch: "dev", headCommit: "b".repeat(40) },
    },
  });

  const result = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-testing-executor-root",
    task_id: "task-current",
    status: "testing",
  });

  assert.equal(taskGitPrepareCalls.at(-1).projectRoot, targetWorkingDirectory);
  assert.equal(tasks.get("task-current").streamId, "stream-2");
  assert.equal(result.gitIntegration.integrated, true);
  assert.equal(tasks.get("task-current").gitReferences[0].projectRoot, targetWorkingDirectory);
});

test("Task status integration resolves an executor root in another Workspace", async (context) => {
  const { service, token, tasks, foreignStreamWorkingDirectory, taskGitPrepareCalls } = await fixture(context);
  Object.assign(tasks.get("task-foreign"), {
    status: "started", workflowStatus: "in_progress", streamId: "stream-3",
  });

  const result = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "foreign-task-testing",
    task_id: "task-foreign",
    status: "testing",
  });

  assert.equal(taskGitPrepareCalls.at(-1).projectRoot, foreignStreamWorkingDirectory);
  assert.equal(result.workflowStatus, "testing");
  assert.equal(result.gitIntegration.integrated, true);
});

test("HubMcpService resumes an interrupted pending task start with the same request id", async (context) => {
  const { service, token, operations, tasks } = await fixture(context);
  let launches = 0;
  service.setTaskLauncher(async ({ id, workspaceId, streamId, launchRequestId }, launchContext) => {
    launches += 1;
    if (launches === 1) {
      Object.assign(tasks.get(id), { status: "starting", startRequestId: launchRequestId, streamId });
      throw new Error("interrupted before MCP receipt completion");
    }
    await launchContext.bindInterstreamAuditContent(createInterstreamMessage({
      ...launchContext.messageOrigin,
      text: "Task launch",
    }));
    return {
      task: { id, status: "started" },
      target: { streamId, provider: "codex", threadId: "thread-1", workspaceId },
    };
  });
  const input = {
    context_token: token,
    request_id: "interrupted-start",
    task_id: "task-current",
    confirm_launch: true,
  };

  await assert.rejects(() => service.call("hub_task_start", input), /interrupted before MCP receipt completion/u);
  assert.equal(operations.get("interrupted-start").status, "pending");

  const resumed = await service.call("hub_task_start", input);
  assert.equal(resumed.task.status, "started");
  assert.equal(launches, 2);
  assert.equal(operations.get("interrupted-start").status, "succeeded");
});

test("HubMcpService keeps ownership across global columns and deletes its task", async (context) => {
  const { service, token } = await fixture(context);
  const created = await service.call("hub_task_create", {
    context_token: token, request_id: "task-create", title: "Owned task",
  });
  const notes = await service.call("hub_task_move", {
    context_token: token, request_id: "task-notes", task_id: created.id, destination: "notes",
  });
  const backlog = await service.call("hub_task_move", {
    context_token: token, request_id: "task-backlog", task_id: created.id, destination: "backlog",
  });
  const preview = await service.call("hub_task_delete", {
    context_token: token, request_id: "task-delete", task_id: created.id,
  });
  const deleted = await service.call("hub_task_delete", {
    context_token: token, request_id: "task-delete-confirmed", task_id: created.id,
    confirm_cleanup: true, expected_cleanup_token: preview.cleanupToken,
  });

  assert.equal(notes.bucket, "notes");
  assert.equal(backlog.bucket, "backlog");
  assert.equal(deleted.deleted, true);
  await assert.rejects(
    () => service.call("hub_task_get", { context_token: token, task_id: created.id }),
    /task not found/u,
  );
});

test("confirmed Delete preserves the Task row when Git cleanup fails", async (context) => {
  const { service, token, tasks, taskGitWorkspaces } = await fixture(context);
  taskGitWorkspaces.cleanup = async () => { throw new Error("worktree removal failed"); };
  const preview = await service.call("hub_task_delete", {
    context_token: token, request_id: "delete-preview-failure", task_id: "task-current",
  });
  await assert.rejects(() => service.call("hub_task_delete", {
    context_token: token, request_id: "delete-confirm-failure", task_id: "task-current",
    confirm_cleanup: true, expected_cleanup_token: preview.cleanupToken,
  }), /worktree removal failed/u);
  assert.equal(tasks.get("task-current").id, "task-current");
});

test("SQLite contention retry yields to timers and preserves the original request identity", async (context) => {
  const { service, token, workspaceCatalog, operations } = await fixture(context);
  const begin = workspaceCatalog.beginMcpOperation;
  let attempts = 0;
  workspaceCatalog.beginMcpOperation = (operation) => {
    attempts += 1;
    if (attempts < 4) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return begin(operation);
  };
  let timerObserved = false;
  setTimeout(() => { timerObserved = true; }, 0);

  const result = await service.call("hub_task_update", {
    context_token: token, request_id: "busy-retry", task_id: "task-current", title: "Retried",
  });

  assert.equal(result.title, "Retried");
  assert.equal(attempts, 4);
  assert.equal(timerObserved, true);
  assert.equal(operations.size, 1);
  assert.equal(operations.get("busy-retry").status, "succeeded");
  assert.equal(service.databaseContentionDiagnostics().retries, 3);
  assert.ok(service.databaseContentionDiagnostics().lastWaitMs >= 20);
});

test("HubMcpService sends attributed messages to another current-Workspace Stream", async (context) => {
  const { service, token, sentMessages } = await fixture(context);
  const result = await service.call("hub_stream_message_send", {
    context_token: token,
    request_id: "message-themes-1",
    stream_id: "stream-2",
    text: "Finish the theme.",
    mode: "queue",
    confirm_send: true,
  });
  assert.equal(result.target.streamName, "Themes");
  assert.equal(result.delivery.queued, true);
  assert.equal(sentMessages[0].params.streamId, "stream-2");
  assert.match(sentMessages[0].params.text, /"workspaceName":"Agent Hub"/u);
  assert.match(sentMessages[0].params.text, /"streamName":"MCP"/u);
  assert.match(sentMessages[0].params.text, /"provider":"codex"/u);
  assert.match(sentMessages[0].params.text, /"model":"Sol"/u);
  assert.match(sentMessages[0].params.text, /Finish the theme\.$/u);
  assert.deepEqual(sentMessages[0].context.messageOrigin, {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent Hub",
    streamId: "stream-1",
    streamName: "MCP",
    provider: "codex",
    model: "Sol",
    sourceThreadId: "thread-1",
    requestId: "message-themes-1",
  });
  assert.equal(result.source.provider, "codex");
  assert.equal(result.source.model, "Sol");
});

test("HubMcpService exposes cursor events and publication-gated release completion", async (context) => {
  const { service, token, preflightCalls, releaseCalls } = await fixture(context);
  const events = await service.call("hub_events_list", { context_token: token, after_sequence: 4 });
  assert.equal(events.events[0].sequence, 5);
  assert.equal(events.nextSequence, 5);
  const preflight = await service.call("hub_release_preflight", {
    context_token: token, request_id: "preflight-1", expected_plan_revision: "plan-1",
  });
  assert.equal(preflight.testContour.headCommit, "dev-head");
  assert.deepEqual(preflightCalls[0], {
    workspaceId: "workspace-1", expectedPlanRevision: "plan-1", conflictsResolved: false,
  });
  const release = await service.call("hub_release_complete", {
    context_token: token, request_id: "release-1",
    expected_repositories: [{ projectRoot: "D:/repo", revision: "abc" }], expected_plan_revision: "plan-1",
    deployment_verified: true, verification_summary: "Published and smoke-tested", conflicts_resolved: true,
  });
  assert.equal(release.workspaceId, "workspace-1");
  assert.equal(release.expectedRepositories[0].revision, "abc");
  assert.equal(releaseCalls[0].conflictsResolved, true);
});

test("HubMcpService restricts release preflight to Architect Streams", async (context) => {
  const { service, token, workspaceCatalog } = await fixture(context);
  const hierarchy = workspaceCatalog.hierarchy;
  workspaceCatalog.hierarchy = () => hierarchy().map((workspace) => ({
    ...workspace,
    streams: workspace.streams.map((stream) => ({
      ...stream,
      settings: { ...stream.settings, architect: false },
    })),
  }));
  await assert.rejects(() => service.call("hub_release_preflight", {
    context_token: token,
    request_id: "preflight-forbidden",
    expected_plan_revision: "plan-1",
  }), /requires an Architect Stream/u);
});

test("HubMcpService binds the current turn to its dedicated Task worktree", async (context) => {
  const { service, token, tasks, streamWorkingDirectory, taskGitPrepareCalls, taskClaimCalls } = await fixture(context);
  const claimed = await service.call("hub_task_claim", {
    context_token: token,
    request_id: "claim-task-1",
    task_id: "task-current",
  });
  assert.equal(claimed.claimedTurnId, "turn-live");
  assert.equal(taskGitPrepareCalls[0].projectRoot, streamWorkingDirectory);
  assert.deepEqual(tasks.get("task-current").gitBaseline, {
    repoRoot: streamWorkingDirectory,
    tree: "a".repeat(40),
  });
  assert.match(claimed.gitWorkspace.branch, /^agenthub\/task\/task-current/u);
  assert.deepEqual(taskClaimCalls[0], {
    id: "task-current",
    turnId: "turn-live",
    operationId: "claim-task-1",
    operationKind: "claim",
  });

  const tools = service.tools();
  assert.equal(tools.some((tool) => tool.name === "hub_task_release_freeze"), false);
  assert.equal(tools.some((tool) => tool.name === "hub_release_preflight"), true);
});

test("HubMcpService claim keeps an unproven process-tree guard before every Task effect", {
  skip: process.platform !== "win32" ? "Windows taskkill contract" : false,
}, async (context) => {
  let guarded;
  const state = await fixture(context, {
    taskGitWorkspacesFactory: async ({ directory, streamWorkingDirectory }) => {
      await initializeTaskGitRepository(streamWorkingDirectory);
      guarded = await unprovenProcessTaskGit({
        context,
        root: streamWorkingDirectory,
        dataDir: path.join(directory, "git-data"),
        taskId: "task-current",
      });
      return guarded.service;
    },
  });
  await assert.rejects(() => state.service.call("hub_task_claim", {
    context_token: state.token,
    request_id: "claim-unproven-first",
    task_id: "task-current",
  }), /process tree stop is unproven/u);
  assert.equal(guarded.guardSeen(), true);
  await assert.rejects(() => state.service.call("hub_task_claim", {
    context_token: state.token,
    request_id: "claim-unproven-replacement",
    task_id: "task-current",
  }), /unresolved process-tree guard requires operator proof/u);
  assert.equal(state.taskClaimCalls.length, 0);
  assert.equal(state.tasks.get("task-current").status, "open");
  assert.equal(await guarded.waitForStaleMutation(), "stale mutation attempted");
  await guarded.proveAndRecover();
  const claimed = await state.service.call("hub_task_claim", {
    context_token: state.token,
    request_id: "claim-after-operator-proof",
    task_id: "task-current",
  });
  assert.equal(claimed.claimedTurnId, "turn-live");
  assert.equal(state.taskClaimCalls.length, 1);
});

test("HubMcpService claim falls back to the Workspace working directory", async (context) => {
  const { service, token, workspaceCatalog, workspaceWorkingDirectory, taskGitPrepareCalls } = await fixture(context);
  const hierarchy = workspaceCatalog.hierarchy;
  workspaceCatalog.hierarchy = () => hierarchy().map((workspace) => ({
    ...workspace,
    streams: workspace.streams.map((stream) => stream.id === "stream-1"
      ? { ...stream, settings: { ...stream.settings, workingDirectory: "" } }
      : stream),
  }));

  await service.call("hub_task_claim", {
    context_token: token,
    request_id: "claim-workspace-root",
    task_id: "task-current",
  });
  assert.equal(taskGitPrepareCalls[0].projectRoot, workspaceWorkingDirectory);
});

test("HubMcpService rejects forged context capabilities", async (context) => {
  const { service, token } = await fixture(context);
  await assert.rejects(
    () => service.call("hub_context_get", { context_token: `${token}x` }),
    /invalid Agent Hub context capability/u,
  );
});

test("HubMcpService recovers a registered capability when the model damages only its payload", async (context) => {
  const { service, token } = await fixture(context);
  const separator = token.lastIndexOf(".");
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const damagedToken = `${payload.slice(0, 40)}${payload.slice(43)}.${signature}`;

  const resolved = await service.call("hub_context_get", { context_token: damagedToken });

  assert.equal(resolved.workspaceId, "workspace-1");
  assert.equal(resolved.streamId, "stream-1");
  assert.equal(resolved.threadId, "thread-1");
});

test("HubMcpService explains how to recover from an empty context capability", async (context) => {
  const { service } = await fixture(context);
  await assert.rejects(
    () => service.call("hub_context_get", { context_token: "" }),
    /copy the exact value from the current <agent_hub_context>.*do not search environment variables/u,
  );
});

test("HubMcpService exposes bounded activity, history and effective rules", async (context) => {
  const { service, token } = await fixture(context);
  const active = await service.call("hub_active_runs_list", { context_token: token });
  const history = await service.call("hub_stream_history", { context_token: token });
  const rules = await service.call("hub_rules_get", { context_token: token });
  assert.equal(active.runs[0].streamId, "stream-1");
  assert.equal(history.state, "active");
  assert.equal(history.turns.some((turn) => turn.active === true), true);
  assert.match(history.turns.find((turn) => turn.turnId === "turn-1").prompt, /Initial prompt/u);
  assert.equal(rules.stream.content, "Stream rule");
});

test("HubMcpService performs standard reads and writes across Workspace boundaries", async (context) => {
  const {
    service, token, sentMessages, taskLaunchCalls, preflightCalls, releaseCalls,
    releasePlanWorkspaceIds, operations,
  } = await fixture(context);
  service.setActiveRuns(() => [{
    id: "run-foreign", provider: "codex", streamId: "stream-3", threadId: "thread-3",
    turnId: "turn-foreign-active", status: "running", progressStage: "Foreign active",
    startedAt: "2026-09-01T13:00:00.000Z",
  }]);

  const workspace = await service.call("hub_workspace_get", {
    context_token: token, workspace_id: "workspace-2",
  });
  const streams = await service.call("hub_parallel_streams_list", {
    context_token: token, workspace_id: "workspace-2",
  });
  const active = await service.call("hub_active_runs_list", {
    context_token: token, workspace_id: "workspace-2",
  });
  const history = await service.call("hub_stream_history", {
    context_token: token, workspace_id: "workspace-2", stream_id: "stream-3",
  });
  const rules = await service.call("hub_rules_get", {
    context_token: token, stream_id: "stream-3",
  });
  assert.equal(workspace.id, "workspace-2");
  assert.equal(workspace.currentStreamId, null);
  assert.deepEqual(streams.streams.map((stream) => stream.id), ["stream-3"]);
  assert.equal(active.runs[0].streamId, "stream-3");
  assert.equal(history.workspaceId, "workspace-2");
  assert.equal(history.turns[0].turnId, "turn-foreign-active");
  assert.equal(rules.stream.content, "Foreign Stream rule");

  const workspaceRules = await service.call("hub_workspace_rules_update", {
    context_token: token, request_id: "foreign-workspace-rules", workspace_id: "workspace-2",
    content: "Updated foreign Workspace rules",
  });
  const streamRules = await service.call("hub_stream_rules_update", {
    context_token: token, request_id: "foreign-stream-rules", stream_id: "stream-3",
    content: "Updated foreign Stream rules",
  });
  const created = await service.call("hub_task_create", {
    context_token: token, request_id: "foreign-task-create", workspace_id: "workspace-2",
    title: "Foreign task",
  });
  const moved = await service.call("hub_task_move", {
    context_token: token, request_id: "foreign-task-move", task_id: "task-current",
    destination: "workspace", workspace_id: "workspace-2",
  });
  const started = await service.call("hub_task_start", {
    context_token: token, request_id: "foreign-task-start", task_id: "task-foreign",
    workspace_id: "workspace-2", stream_id: "stream-3", confirm_launch: true,
  });
  const sent = await service.call("hub_stream_message_send", {
    context_token: token, request_id: "foreign-message", stream_id: "stream-3",
    text: "Cross Workspace message", mode: "steer", confirm_send: true,
  });
  const plan = await service.call("hub_release_plan_get", {
    context_token: token, workspace_id: "workspace-2",
  });
  await service.call("hub_release_preflight", {
    context_token: token, request_id: "foreign-preflight", workspace_id: "workspace-2",
    expected_plan_revision: "plan-1",
  });
  await service.call("hub_release_complete", {
    context_token: token, request_id: "foreign-release-complete", workspace_id: "workspace-2",
    expected_repositories: [{ projectRoot: "D:/repo", revision: "abc" }],
    expected_plan_revision: "plan-1", deployment_verified: true,
    verification_summary: "Foreign Workspace published",
  });
  const events = await service.call("hub_events_list", {
    context_token: token, workspace_id: "workspace-2", after_sequence: 2,
  });

  assert.equal(workspaceRules.workspaceId, "workspace-2");
  assert.equal(streamRules.streamId, "stream-3");
  assert.equal(created.workspaceId, "workspace-2");
  assert.equal(moved.workspaceId, "workspace-2");
  assert.equal(started.target.streamId, "stream-3");
  assert.equal(taskLaunchCalls.at(-1).workspaceId, "workspace-2");
  assert.equal(sent.target.workspaceId, "workspace-2");
  assert.equal(sentMessages.at(-1).params.streamId, "stream-3");
  assert.equal(plan.workspaceId, "workspace-2");
  assert.equal(releasePlanWorkspaceIds.at(-1), "workspace-2");
  assert.equal(preflightCalls.at(-1).workspaceId, "workspace-2");
  assert.equal(releaseCalls.at(-1).workspaceId, "workspace-2");
  assert.equal(events.workspaceId, "workspace-2");
  assert.equal(operations.get("foreign-workspace-rules").workspaceId, "workspace-1");
  assert.equal(operations.get("foreign-workspace-rules").streamId, "stream-1");

  await assert.rejects(() => service.call("hub_stream_history", {
    context_token: token, workspace_id: "workspace-1", stream_id: "stream-3",
  }), /outside the selected Workspace/u);
  await assert.rejects(() => service.call("hub_task_start", {
    context_token: token, request_id: "mismatched-target", task_id: "task-foreign",
    workspace_id: "workspace-1", stream_id: "stream-3", confirm_launch: true,
  }), /outside the selected Workspace/u);
});

test("hub_stream_history projects active content and deterministic lifecycle states", async (context) => {
  const { service, token, historyRecordsByThread } = await fixture(context);
  const visibleActivity = {
    id: "tool-1", type: "tool", label: "Используется инструмент",
    detail: "agent_hub/hub_task_get", status: "running", time: "2026-09-01T13:00:01.000Z",
  };
  const messageOrigin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    requestId: "foreign-live-1",
  };
  const firstRun = {
    id: "run-foreign-1", provider: "codex", streamId: "stream-3", threadId: "thread-3",
    turnId: "turn-foreign-1", status: "running", taskTitle: "Foreign live",
    promptPreview: createInterstreamMessage({
      ...messageOrigin,
      text: "Inspect foreign state",
    }),
    messageOrigin,
    clientUserMessageId: "mcp:foreign-live-1",
    progressStage: "Reading",
    progressReasoning: "Hub-visible progress summary", responseText: "Visible partial answer",
    activities: [visibleActivity, { ...visibleActivity, id: "tool-2", detail: "second" }],
    hiddenChainOfThought: "must never be exposed",
    startedAt: "2026-09-01T13:00:00.000Z",
  };
  service.setActiveRuns(() => [firstRun]);

  const first = await service.call("hub_stream_history", {
    context_token: token,
    workspace_id: "workspace-2",
    stream_id: "stream-3",
    limit: 2,
    include_body: true,
    max_activity_items: 1,
  });
  assert.equal(first.state, "active");
  assert.equal(first.activeRunCount, 1);
  assert.equal(first.turns[0].status, "active");
  assert.equal(first.turns[0].active, true);
  assert.equal(first.turns[0].prompt, "Inspect foreign state");
  assert.equal(first.turns[0].progress, "Hub-visible progress summary");
  assert.equal(first.turns[0].body, "Visible partial answer");
  assert.equal(first.turns[0].activities.length, 1);
  assert.equal(JSON.stringify(first).includes("must never be exposed"), false);
  assert.match(first.cursor, /^[A-Za-z0-9_-]+$/u);
  assert.match(first.revision, /^[a-f0-9]{64}$/u);

  const repeated = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: first.cursor,
    limit: 2, include_body: true, max_activity_items: 1,
  });
  assert.equal(repeated.state, "active");
  assert.equal(repeated.cursor, first.cursor);
  assert.equal(repeated.revision, first.revision);

  historyRecordsByThread.set("thread-3", [{
    provider: "codex", threadId: "thread-3", turnId: "turn-foreign-1",
    title: "Persisted too early", prompt: "Inspect foreign state", body: "Persisted partial",
    status: "completed", completedAt: "2026-09-01T13:00:02.000Z",
  }]);
  const deduplicated = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: first.cursor, limit: 5,
  });
  assert.equal(deduplicated.turns.filter((turn) => turn.turnId === "turn-foreign-1").length, 1);
  assert.equal(deduplicated.turns[0].active, false);

  const replacementRun = {
    ...firstRun,
    id: "run-foreign-2",
    turnId: "turn-foreign-2",
    promptPreview: "Replacement turn",
    responseText: "Replacement partial",
    startedAt: "2026-09-01T13:05:00.000Z",
  };
  service.setActiveRuns(() => [replacementRun]);
  const replaced = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: first.cursor, limit: 2,
  });
  assert.equal(replaced.state, "replaced");
  assert.notEqual(replaced.cursor, first.cursor);
  assert.equal(replaced.turns[0].turnId, "turn-foreign-2");

  historyRecordsByThread.set("thread-3", [{
    provider: "codex", threadId: "thread-3", turnId: "turn-foreign-2",
    title: "Replacement turn", prompt: "Replacement turn", body: "Replacement final",
    status: "completed", completedAt: "2026-09-01T13:06:00.000Z",
  }]);
  service.setActiveRuns(() => []);
  const terminal = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: replaced.cursor, limit: 2,
  });
  assert.equal(terminal.state, "terminal");
  assert.equal(terminal.turns[0].turnId, "turn-foreign-2");
  assert.equal(terminal.turns[0].status, "completed");
  assert.equal(terminal.turns[0].active, false);

  const preTurnRun = {
    ...firstRun,
    id: "run-before-turn-id",
    turnId: null,
  };
  historyRecordsByThread.set("thread-3", []);
  service.setActiveRuns(() => [preTurnRun]);
  const beforeTurnId = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3",
  });
  historyRecordsByThread.set("thread-3", [incomingLedgerRecord({
    provider: "codex", threadId: "thread-3", turnId: "turn-assigned-at-terminal",
    runId: "run-before-turn-id", title: "Pre-turn", prompt: "Pre-turn", body: "Final",
    status: "completed", completedAt: "2026-09-01T13:07:00.000Z",
  })]);
  service.setActiveRuns(() => []);
  const terminalAfterPreTurn = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: beforeTurnId.cursor,
  });
  assert.equal(terminalAfterPreTurn.state, "terminal");
  assert.equal(terminalAfterPreTurn.turns[0].turnId, "turn-assigned-at-terminal");
  assert.equal(terminalAfterPreTurn.turns[0].runId, "run-before-turn-id");

  historyRecordsByThread.set("thread-3", []);
  const unknownCursor = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: first.cursor,
  });
  const idle = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", limit: 1,
  });
  await assert.rejects(() => service.call("hub_stream_history", {
    context_token: token, stream_id: "missing-stream", limit: 1,
  }), /Stream not found/u);
  assert.equal(unknownCursor.state, "not_found");
  assert.equal(idle.state, "idle");

  const schema = service.tools().find((tool) => tool.name === "hub_stream_history").inputSchema.properties;
  assert.equal("wait" in schema, false);
  assert.equal("timeout" in schema, false);
  assert.equal(service.tools().some((tool) => tool.name === "hub_stream_turn_snapshot"), false);
});

test("hub_stream_history merge-sorts active and terminal turns before applying limit", async (context) => {
  const { service, token, historyRecordsByThread } = await fixture(context);
  historyRecordsByThread.set("thread-3", [{
    provider: "codex", threadId: "thread-3", turnId: "turn-terminal-new",
    title: "Newest terminal", status: "completed", completedAt: "2026-09-01T13:06:00.000Z",
  }, {
    provider: "codex", threadId: "thread-3", turnId: "turn-terminal-old",
    title: "Older terminal", status: "completed", completedAt: "2026-09-01T13:04:00.000Z",
  }]);
  service.setActiveRuns(() => [{
    id: "run-b", provider: "codex", streamId: "stream-3", threadId: "thread-3",
    turnId: "turn-b", status: "running", startedAt: "2026-09-01T13:05:00.000Z",
  }, {
    id: "run-a", provider: "codex", streamId: "stream-3", threadId: "thread-3",
    turnId: "turn-a", status: "running", startedAt: "2026-09-01T13:05:00.000Z",
  }]);

  const result = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", limit: 3,
  });

  assert.deepEqual(result.turns.map((turn) => turn.turnId), [
    "turn-terminal-new", "turn-a", "turn-b",
  ]);
  assert.equal(result.truncated, true);
  const cursor = JSON.parse(Buffer.from(result.cursor, "base64url").toString("utf8"));
  assert.equal(cursor.turnId, "turn-a");
});

test("HubMcpService replays successful mutations by request id", async (context) => {
  const { service, token, operations } = await fixture(context);
  const input = { context_token: token, request_id: "rules-1", content: "Updated" };
  const first = await service.call("hub_stream_rules_update", input);
  const second = await service.call("hub_stream_rules_update", input);
  assert.deepEqual(second, first);
  assert.equal(operations.get("rules-1").status, "succeeded");
});

test("HubMcpService coalesces concurrent mutations with the same request identity", async (context) => {
  const { service, token, operations } = await fixture(context);
  let effects = 0;
  let releaseEffect;
  const effectGate = new Promise((resolve) => { releaseEffect = resolve; });
  service.setStreamMessenger(async () => {
    effects += 1;
    await effectGate;
    return { accepted: false, queued: true, id: "queued-concurrent" };
  });
  const input = {
    context_token: token,
    request_id: "message-concurrent-1",
    stream_id: "stream-2",
    text: "One durable effect.",
    mode: "queue",
    confirm_send: true,
  };

  const first = service.call("hub_stream_message_send", input);
  const second = service.call("hub_stream_message_send", input);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(effects, 1);
  releaseEffect();

  assert.deepEqual(await second, await first);
  assert.equal(effects, 1);
  assert.equal(operations.get("message-concurrent-1").status, "succeeded");
});

test("receipt failure after a completed effect becomes unknown and cannot replay the effect", async (context) => {
  const { service, token, workspaceCatalog, operations } = await fixture(context);
  let effects = 0;
  service.setStreamMessenger(async () => {
    effects += 1;
    return { accepted: false, queued: true, id: "queued-before-receipt-crash" };
  });
  workspaceCatalog.completeMcpOperation = () => {
    throw new Error("simulated durable receipt failure after effect");
  };
  const input = {
    context_token: token,
    request_id: "message-effect-receipt-crash",
    stream_id: "stream-2",
    text: "Do not replay me.",
    mode: "queue",
    confirm_send: true,
  };

  await assert.rejects(
    service.call("hub_stream_message_send", input),
    /effect completed.*receipt reconciliation is required/u,
  );
  assert.equal(effects, 1);
  assert.equal(operations.get("message-effect-receipt-crash").status, "unknown");
  await assert.rejects(
    service.call("hub_stream_message_send", input),
    /outcome is unknown.*reconcile authoritatively/u,
  );
  assert.equal(effects, 1);
});

test("mutation throw after a possible partial effect is terminal unknown", async (context) => {
  const { service, token, taskBoard, tasks, operations } = await fixture(context);
  let effects = 0;
  taskBoard.update = ({ id, title }) => {
    effects += 1;
    tasks.get(id).title = title;
    throw new Error("crash after task row effect");
  };
  const input = {
    context_token: token,
    request_id: "task-update-partial-effect",
    task_id: "task-current",
    title: "Possibly committed",
  };
  await assert.rejects(service.call("hub_task_update", input), /crash after task row effect/u);
  assert.equal(effects, 1);
  assert.equal(operations.get(input.request_id).status, "unknown");
  await assert.rejects(service.call("hub_task_update", input), /outcome is unknown/u);
  assert.equal(effects, 1);
});

test("startup receipt reconciliation terminalizes incomplete durable lifecycle receipts", async (context) => {
  const { service, workspaceCatalog, tasks, operations } = await fixture(context);
  operations.set("orphan-pending", {
    requestId: "orphan-pending", toolName: "hub_task_update", status: "pending",
  });
  operations.set("workflow-pending", {
    requestId: "workflow-pending", toolName: "hub_task_status_update", status: "pending",
  });
  tasks.get("task-current").lifecycleOperation = {
    operationId: "workflow-pending", kind: "workflow", targetWorkflowStatus: "testing",
  };
  workspaceCatalog.pendingMcpOperations = () => [...operations.values()].filter((item) => item.status === "pending");

  await service.reconcilePendingMcpOperations();

  assert.equal(operations.get("orphan-pending").status, "unknown");
  assert.equal(operations.get("workflow-pending").status, "unknown");
});

test("HubMcpService copies project files into task attachments", async (context) => {
  const { service, token, projectRoot } = await fixture(context);
  const source = path.join(path.dirname(projectRoot), "outside.txt");
  await writeFile(source, "outside", "utf8");
  await assert.rejects(
    () => service.call("hub_task_attachment_add", {
      context_token: token, request_id: "outside-file", task_id: "task-current", local_path: source,
    }),
    /outside the current project/u,
  );

  const projectFile = path.join(projectRoot, "evidence.txt");
  await writeFile(projectFile, "evidence", "utf8");
  const added = await service.call("hub_task_attachment_add", {
    context_token: token, request_id: "project-file", task_id: "task-current", local_path: projectFile,
  });
  const read = await service.call("hub_task_attachment_read", {
    context_token: token, task_id: "task-current", attachment_id: added.attachment.id,
  });
  assert.equal(read.text, "evidence");
  assert.equal(read.name, "evidence.txt");
});

test("HubMcpService reads attachments of an exact Task reference after it leaves the Workspace", async (context) => {
  const { service, token, projectRoot, tasks } = await fixture(context);
  const projectFile = path.join(projectRoot, "foreign-evidence.txt");
  await writeFile(projectFile, "foreign evidence", "utf8");
  const added = await service.call("hub_task_attachment_add", {
    context_token: token,
    request_id: "foreign-attachment-add",
    task_id: "task-current",
    local_path: projectFile,
  });
  tasks.get("task-current").workspaceId = "workspace-2";

  const read = await service.call("hub_task_attachment_read", {
    context_token: token,
    task_id: "task-current",
    attachment_id: added.attachment.id,
  });

  assert.equal(read.text, "foreign evidence");
});

test("HubMcpService rejects attachment paths that escape through a link", async (context) => {
  const { service, token, attachmentDirectory, projectRoot } = await fixture(context);
  const outsideDirectory = path.join(path.dirname(projectRoot), "outside-link-target");
  const linkedDirectory = path.join(projectRoot, "linked-outside");
  await mkdir(outsideDirectory);
  await writeFile(path.join(outsideDirectory, "secret.txt"), "secret", "utf8");
  try {
    await symlink(outsideDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code)) {
      context.skip("creating a filesystem link is not permitted on this host");
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => service.call("hub_task_attachment_add", {
      context_token: token,
      request_id: "linked-outside-file",
      task_id: "task-current",
      local_path: path.join(linkedDirectory, "secret.txt"),
    }),
    /outside the current project|symlink|reparse/iu,
  );
  assert.deepEqual(await readdir(attachmentDirectory), []);
  assert.deepEqual(
    (await service.call("hub_task_get", { context_token: token, task_id: "task-current" })).attachments,
    [],
  );
});

test("HubMcpService rejects linked attachment paths that stay inside the project", async (context) => {
  const { service, token, projectRoot } = await fixture(context);
  const sourceDirectory = path.join(projectRoot, "source-directory");
  const linkedDirectory = path.join(projectRoot, "linked-inside");
  await mkdir(sourceDirectory);
  await writeFile(path.join(sourceDirectory, "evidence.txt"), "evidence", "utf8");
  try {
    await symlink(sourceDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code)) {
      context.skip("creating a filesystem link is not permitted on this host");
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => service.call("hub_task_attachment_add", {
      context_token: token,
      request_id: "linked-inside-file",
      task_id: "task-current",
      local_path: path.join(linkedDirectory, "evidence.txt"),
    }),
    /symlink|reparse/iu,
  );
});

test("HubMcpService rejects non-file attachment sources", async (context) => {
  const { service, token, projectRoot } = await fixture(context);
  const sourceDirectory = path.join(projectRoot, "not-a-file");
  await mkdir(sourceDirectory);

  await assert.rejects(
    () => service.call("hub_task_attachment_add", {
      context_token: token,
      request_id: "directory-source",
      task_id: "task-current",
      local_path: sourceDirectory,
    }),
    /regular file/u,
  );
});
