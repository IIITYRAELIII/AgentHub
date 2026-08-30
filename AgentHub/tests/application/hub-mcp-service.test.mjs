import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";

async function fixture(context, { releaseWorkflowEnabled = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project");
  const attachmentDirectory = path.join(directory, "attachments");
  await mkdir(projectRoot, { recursive: true });
  const tasks = new Map([
    ["task-current", {
      id: "task-current", title: "Current", description: "", bucket: "workspace",
      status: "open", workflowStatus: "new", workspaceId: "workspace-1", streamId: null, boardOrder: 0,
    }],
    ["task-foreign", {
      id: "task-foreign", title: "Foreign", description: "", bucket: "workspace",
      status: "open", workflowStatus: "new", workspaceId: "workspace-2", streamId: null, boardOrder: 0,
    }],
  ]);
  const workspaceCatalog = {
    resolveThread: ({ provider, threadId }) => provider === "codex" && threadId === "thread-1" ? {
      workspaceId: "workspace-1",
      workspaceName: "Agent Hub",
      streamId: "stream-1",
      streamDisplayName: "MCP",
      thread: { projectRoot },
    } : null,
    stream: (id) => id === "stream-1" ? {
      id, workspaceId: "workspace-1", displayName: "MCP", settings: { project: projectRoot },
    } : null,
    activeThread: () => null,
    workspace: (id) => id === "workspace-1" ? {
      id, name: "Agent Hub", settings: { releaseWorkflowEnabled },
    } : null,
    hierarchy: () => [{
      id: "workspace-1",
      name: "Agent Hub",
      streams: [
        { id: "stream-1", displayName: "MCP", settings: { architect: true }, threads: [{ provider: "codex", threadId: "thread-1" }] },
        { id: "stream-2", displayName: "Themes", threads: [{ provider: "codex", threadId: "thread-2" }] },
      ],
    }],
    workspaceEvents: (_workspaceId, { afterSequence }) => [{
      sequence: afterSequence + 1, workspaceId: "workspace-1", streamId: "stream-1",
      type: "run.completed", subjectId: "turn-1", payload: {}, createdAtMs: 1,
    }],
    developerRulesForStream: () => ({
      workspace: { revision: 1, content: "Workspace rule" },
      stream: { revision: 2, content: "Stream rule" },
    }),
    updateWorkspaceDeveloperRules: (_id, content) => ({ revision: 2, content }),
    updateStreamDeveloperRules: (_id, content) => ({ revision: 3, content }),
  };
  const operations = new Map();
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
  workspaceCatalog.completeMcpOperation = (requestId, result) => {
    Object.assign(operations.get(requestId), { status: "succeeded", result });
  };
  workspaceCatalog.failMcpOperation = (requestId, error) => {
    Object.assign(operations.get(requestId), { status: "failed", error: error.message });
  };
  workspaceCatalog.mcpOperations = () => [...operations.values()];
  const taskBoard = {
    snapshot: () => [...tasks.values()].map((task) => ({ ...task, attachments: task.attachments ?? [] })),
    task: (id) => tasks.get(id) ?? null,
    create: ({ text, sourceDetails = {} }) => {
      const task = {
        id: "created", title: text, description: "", bucket: "backlog",
        status: "open", workflowStatus: "new", workspaceId: null, sourceDetails,
      };
      tasks.set(task.id, task);
      return task;
    },
    move: ({ id, bucket, workspaceId = null }) => Object.assign(tasks.get(id), { bucket, workspaceId }),
    update: ({ id, title, description }) => Object.assign(tasks.get(id), { title, description }),
    markStarted: ({ id, streamId }) => Object.assign(tasks.get(id), {
      status: "started", workflowStatus: "in_progress", streamId,
    }),
    claim: ({ id, streamId, turnId, gitBaseline }) => Object.assign(tasks.get(id), {
      status: "started", workflowStatus: "in_progress", streamId, claimedTurnId: turnId, gitBaseline,
    }),
    requestWorkflowStatus: ({ id, status, turnId }) => Object.assign(tasks.get(id), {
      workflowStatus: status, requestedWorkflowStatus: status, requestedTurnId: turnId,
    }),
    recordTaskTurn: ({ taskId, changedFiles }) => Object.assign(tasks.get(taskId), { changedFiles }),
    releasePlan: () => ({ revision: "plan-1", candidates: [], ready: [], draft: [], blocked: [], conflicts: [] }),
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
  const workLog = {
    threadTurns: async () => [{
      provider: "codex", threadId: "thread-1", turnId: "turn-1", title: "Done",
      prompt: [{ type: "text", text: "Initial prompt" }], body: "Result", status: "completed",
    }],
  };
  const releaseCalls = [];
  const taskReleaseCalls = [];
  const taskReleases = {
    freeze: async (options) => {
      taskReleaseCalls.push(options);
      return { ...tasks.get(options.taskId), frozenRevision: options.expectedTaskRevision + 1 };
    },
    freezeRecorded: async () => null,
  };
  const taskGitWorkspaces = {
    prepare: async ({ taskId }) => ({
      taskId,
      branch: `agenthub/task/${taskId}/repo`,
      projectRoot: path.join(directory, "task-worktree", taskId),
      repositoryRoot: projectRoot,
      baseCommit: "a".repeat(40),
      headCommit: "a".repeat(40),
      gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
    }),
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
        changedFiles: [],
      },
      integration: {
        integrated: true,
        alreadyIntegrated: true,
        dev: { branch: "dev", headCommit: "a".repeat(40) },
      },
    }),
    cleanup: async () => ({ removed: 1 }),
  };
  const service = new HubMcpService({
    workspaceCatalog, taskBoard, workLog, attachmentDirectory, secret: "secret",
    taskReleases,
    taskGitWorkspaces,
    releaseCompleter: {
      completeRelease: async (options) => {
        releaseCalls.push(options);
        return { ...options, released: [] };
      },
    },
  });
  service.setTaskLauncher(async ({ id, workspaceId, streamId }) => {
    const task = taskBoard.markStarted({ id, workspaceId, streamId });
    return { task, target: { streamId, provider: "codex", threadId: "thread-1" } };
  });
  const sentMessages = [];
  service.setStreamMessenger(async (params, messageContext) => {
    sentMessages.push({ params, context: messageContext });
    return { accepted: false, queued: true, id: "queued-1" };
  });
  const activeRun = {
    id: "run-1", provider: "codex", threadId: "thread-1", turnId: "turn-live",
    projectRoot, status: "running", progressStage: "Editing files", model: "Sol",
  };
  service.setActiveRuns(() => [activeRun]);
  return {
    service,
    token: service.contextToken({ provider: "codex", threadId: "thread-1" }),
    attachmentDirectory,
    projectRoot,
    workspaceCatalog,
    tasks,
    operations,
    releaseCalls,
    taskReleaseCalls,
    taskGitWorkspaces,
    sentMessages,
  };
}

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
  const { service, token } = await fixture(context);
  const task = await service.call("hub_task_start", {
    context_token: token, request_id: "start-task", task_id: "task-current", confirm_launch: true,
  });
  assert.equal(task.task.status, "started");
  assert.equal(task.task.workflowStatus, "in_progress");
  assert.equal(task.target.streamId, "stream-1");
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
  const completed = await service.call("hub_task_complete", {
    context_token: token,
    request_id: "task-complete",
    task_id: "task-current",
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

test("Await status remains selected when the Task branch conflicts with dev", async (context) => {
  const { service, token, taskGitWorkspaces } = await fixture(context, { releaseWorkflowEnabled: true });
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
      conflicts: ["app.mjs"],
      error: "merge conflict",
      dev: { branch: "dev", headCommit: "c".repeat(40) },
    },
  });

  const result = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-awaiting-conflict",
    task_id: "task-current",
    status: "awaiting_implementation",
  });

  assert.equal(result.workflowStatus, "awaiting_implementation");
  assert.equal(result.gitIntegration.integrated, false);
  assert.deepEqual(result.gitIntegration.conflicts, ["app.mjs"]);
});

test("HubMcpService resumes an interrupted pending task start with the same request id", async (context) => {
  const { service, token, operations, tasks } = await fixture(context);
  let launches = 0;
  service.setTaskLauncher(async ({ id, workspaceId, streamId, launchRequestId }) => {
    launches += 1;
    if (launches === 1) {
      Object.assign(tasks.get(id), { status: "starting", startRequestId: launchRequestId, streamId });
      throw new Error("interrupted before MCP receipt completion");
    }
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
  const deleted = await service.call("hub_task_delete", {
    context_token: token, request_id: "task-delete", task_id: created.id,
  });

  assert.equal(notes.bucket, "notes");
  assert.equal(backlog.bucket, "backlog");
  assert.equal(deleted.deleted, true);
  await assert.rejects(
    () => service.call("hub_task_get", { context_token: token, task_id: created.id }),
    /task not found/u,
  );
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
  const { service, token, releaseCalls } = await fixture(context);
  const events = await service.call("hub_events_list", { context_token: token, after_sequence: 4 });
  assert.equal(events.events[0].sequence, 5);
  assert.equal(events.nextSequence, 5);
  const release = await service.call("hub_release_complete", {
    context_token: token, request_id: "release-1", expected_revision: "abc", expected_plan_revision: "plan-1",
    deployment_verified: true, verification_summary: "Published and smoke-tested", conflicts_resolved: true,
  });
  assert.equal(release.workspaceId, "workspace-1");
  assert.equal(release.expectedRevision, "abc");
  assert.equal(releaseCalls[0].conflictsResolved, true);
});

test("HubMcpService binds the current turn to its dedicated Task worktree", async (context) => {
  const { service, token, taskReleaseCalls, tasks, projectRoot } = await fixture(context);
  const claimed = await service.call("hub_task_claim", {
    context_token: token,
    request_id: "claim-task-1",
    task_id: "task-current",
  });
  assert.equal(claimed.claimedTurnId, "turn-live");
  assert.deepEqual(tasks.get("task-current").gitBaseline, {
    repoRoot: projectRoot,
    tree: "a".repeat(40),
  });
  assert.match(claimed.gitWorkspace.branch, /^agenthub\/task\/task-current/u);

  const frozen = await service.call("hub_task_release_freeze", {
    context_token: token,
    request_id: "freeze-1",
    task_id: "task-current",
    expected_task_revision: 1,
    repositories: [{
      project_root: "D:/repo",
      base_revision: "a".repeat(40),
      result_revision: "b".repeat(40),
    }],
    files: [{
      project_root: "D:/repo",
      path: "src/app.mjs",
      operation: "modified",
      base_blob: "c".repeat(40),
      result_blob: "d".repeat(40),
    }],
  });
  assert.equal(frozen.frozenRevision, 2);
  assert.equal(taskReleaseCalls[0].actorStreamId, "stream-1");
  assert.equal(taskReleaseCalls[0].taskId, "task-current");
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
  assert.match(history.turns[0].prompt, /Initial prompt/u);
  assert.equal(rules.stream.content, "Stream rule");
});

test("HubMcpService replays successful mutations by request id", async (context) => {
  const { service, token, operations } = await fixture(context);
  const input = { context_token: token, request_id: "rules-1", content: "Updated" };
  const first = await service.call("hub_stream_rules_update", input);
  const second = await service.call("hub_stream_rules_update", input);
  assert.deepEqual(second, first);
  assert.equal(operations.get("rules-1").status, "succeeded");
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
