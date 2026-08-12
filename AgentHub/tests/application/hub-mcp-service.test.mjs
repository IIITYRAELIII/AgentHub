import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project");
  const attachmentDirectory = path.join(directory, "attachments");
  await mkdir(projectRoot, { recursive: true });
  const tasks = new Map([
    ["task-current", {
      id: "task-current", title: "Current", description: "", bucket: "workspace",
      status: "open", workspaceId: "workspace-1", streamId: null, boardOrder: 0,
    }],
    ["task-foreign", {
      id: "task-foreign", title: "Foreign", description: "", bucket: "workspace",
      status: "open", workspaceId: "workspace-2", streamId: null, boardOrder: 0,
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
    workspace: (id) => id === "workspace-1" ? { id, name: "Agent Hub" } : null,
    hierarchy: () => [{
      id: "workspace-1",
      name: "Agent Hub",
      streams: [
        { id: "stream-1", displayName: "MCP", threads: [{ provider: "codex", threadId: "thread-1" }] },
        { id: "stream-2", displayName: "Themes", threads: [{ provider: "codex", threadId: "thread-2" }] },
      ],
    }],
    releaseRegistry: () => ({ changes: [] }),
    releaseChanges: () => [],
    releasePlan: () => ({ ready: [], draft: [], blocked: [], conflicts: [] }),
    updateReleaseChangeStatus: () => null,
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
    create: ({ text }) => {
      const task = { id: "created", title: text, description: "", bucket: "backlog", status: "open", workspaceId: null };
      tasks.set(task.id, task);
      return task;
    },
    move: ({ id, bucket, workspaceId = null }) => Object.assign(tasks.get(id), { bucket, workspaceId }),
    update: ({ id, title, description }) => Object.assign(tasks.get(id), { title, description }),
    markStarted: ({ id, streamId }) => Object.assign(tasks.get(id), { status: "started", streamId }),
    complete: ({ id }) => Object.assign(tasks.get(id), { status: "done" }),
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
  const service = new HubMcpService({
    workspaceCatalog, taskBoard, workLog, attachmentDirectory, secret: "secret",
    releaseCompleter: {
      completeRelease: async ({ workspaceId, expectedRevision }) => ({ workspaceId, expectedRevision, released: [] }),
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
  service.setActiveRuns(() => [{
    id: "run-1", provider: "codex", threadId: "thread-1", turnId: "turn-live",
    status: "running", progressStage: "Editing files",
  }]);
  return {
    service,
    token: service.contextToken({ provider: "codex", threadId: "thread-1" }),
    projectRoot,
    operations,
    sentMessages,
  };
}

test("HubMcpService scopes tools to the capability Workspace", async (context) => {
  const { service, token } = await fixture(context);
  assert.equal((await service.call("hub_context_get", { context_token: token })).workspaceId, "workspace-1");
  assert.deepEqual(
    (await service.call("hub_tasks_list", { context_token: token })).tasks.map((task) => task.id),
    ["task-current"],
  );
  await assert.rejects(
    () => service.call("hub_task_get", { context_token: token, task_id: "task-foreign" }),
    /outside the current Workspace/u,
  );
});

test("HubMcpService supports the first Stream turn before provider Thread assignment", async (context) => {
  const { service } = await fixture(context);
  const developerContext = service.developerContext({ provider: "claude", streamId: "stream-1" });
  const token = /Context capability: (\S+)/u.exec(developerContext)?.[1];
  assert.match(developerContext, /pending first Thread/u);
  assert.equal((await service.call("hub_context_get", { context_token: token })).streamId, "stream-1");
});

test("HubMcpService falls back to Stream context while a rotated Thread is not bound yet", async (context) => {
  const { service } = await fixture(context);
  const developerContext = service.developerContext({
    provider: "codex",
    threadId: "rotated-thread-not-bound-yet",
    streamId: "stream-1",
  });
  const token = /Context capability: (\S+)/u.exec(developerContext)?.[1];

  assert.match(developerContext, /Workspace: Agent Hub \(workspace-1\)/u);
  assert.equal((await service.call("hub_context_get", { context_token: token })).streamId, "stream-1");
});

test("HubMcpService starts the current Workspace task in the current Stream", async (context) => {
  const { service, token } = await fixture(context);
  const task = await service.call("hub_task_start", {
    context_token: token, request_id: "start-task", task_id: "task-current", confirm_launch: true,
  });
  assert.equal(task.task.status, "started");
  assert.equal(task.target.streamId, "stream-1");
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
  assert.match(sentMessages[0].params.text, /Finish the theme\.$/u);
});

test("HubMcpService exposes cursor events and publication-gated release completion", async (context) => {
  const { service, token } = await fixture(context);
  const events = await service.call("hub_events_list", { context_token: token, after_sequence: 4 });
  assert.equal(events.events[0].sequence, 5);
  assert.equal(events.nextSequence, 5);
  const release = await service.call("hub_release_complete", {
    context_token: token, request_id: "release-1", expected_revision: "abc",
    deployment_verified: true, verification_summary: "Published and smoke-tested",
  });
  assert.equal(release.workspaceId, "workspace-1");
  assert.equal(release.expectedRevision, "abc");
});

test("HubMcpService rejects forged context capabilities", async (context) => {
  const { service, token } = await fixture(context);
  await assert.rejects(
    () => service.call("hub_context_get", { context_token: `${token}x` }),
    /invalid Agent Hub context capability/u,
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
