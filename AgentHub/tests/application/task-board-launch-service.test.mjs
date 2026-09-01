import assert from "node:assert/strict";
import test from "node:test";

import { TaskBoardLaunchService } from "../../src/application/task-board-launch-service.mjs";

function fixture({ interruptAfterCreate = false, gitWorktree = false, started = false, activeRuns = [], deferredInputs = [] } = {}) {
  const calls = [];
  const streams = new Map();
  const threads = new Map();
  const task = {
    id: "board-1",
    taskNumber: "AH-42",
    rawText: "Проверить crash recovery",
    correctedText: "",
    bucket: "workspace",
    status: started ? "started" : "open",
    workspaceId: "workspace-1",
    streamId: started ? "stream-old" : null,
    sourceDetails: {},
  };
  const taskBoard = {
    task: () => ({ ...task, sourceDetails: { ...task.sourceDetails } }),
    prepareStart: ({ workspaceId, streamId, streamName, requestId, reassign = false }) => {
      if (task.startRequestId && task.startRequestId !== requestId && !reassign) {
        throw new Error("Task launch is already pending; retry it with the original request_id");
      }
      Object.assign(task, reassign ? {
        startRequestId: requestId,
        startStreamName: streamName,
      } : {
        bucket: "workspace", status: "starting", workspaceId, streamId,
        startRequestId: requestId, startStreamName: streamName,
      });
      calls.push(["prepare", requestId, streamId, reassign, task.streamId]);
      return { ...task, sourceDetails: { ...task.sourceDetails } };
    },
    cancelPreparedStart: ({ requestId, reassign = false }) => {
      if (reassign && task.status === "started" && task.startRequestId === requestId) {
        Object.assign(task, { startRequestId: null, startStreamName: null });
      } else if (task.status === "starting" && task.startRequestId === requestId) {
        Object.assign(task, { status: "open", streamId: null, startRequestId: null, startStreamName: null });
      }
      calls.push(["cancel", requestId, reassign]);
      return { ...task };
    },
    markStarted: ({ workspaceId, streamId, requestId }) => {
      assert.equal(task.startRequestId, requestId);
      Object.assign(task, { status: "started", workspaceId, streamId });
      calls.push(["started", requestId, streamId]);
      return { ...task, sourceDetails: { ...task.sourceDetails } };
    },
  };
  if (started) streams.set("stream-old", {
    id: "stream-old", workspaceId: "workspace-1", name: "Old", threads: [{ provider: "codex", threadId: "thread-old" }],
  });
  const workspaceCatalog = {
    workspace: (id) => id === "workspace-1" ? {
      id, name: "Agent HUB", settings: { workingDirectory: "D:/workspace" },
    } : null,
    stream: (id) => streams.get(id) ?? null,
    createStream: ({ id, workspaceId, name, settings = {} }) => {
      const stream = { id, workspaceId, name, settings };
      streams.set(id, stream);
      calls.push(["create-stream", id, settings]);
      return stream;
    },
    activeThread: (streamId) => threads.get(streamId) ?? null,
  };
  let shouldInterrupt = interruptAfterCreate;
  const launch = new TaskBoardLaunchService({
    taskBoard,
    workspaceCatalog,
    taskGitWorkspaces: gitWorktree ? {
      prepare: async ({ taskId, projectRoot }) => {
        calls.push(["git-worktree", taskId, projectRoot]);
        return { projectRoot: "D:/task-worktree" };
      },
    } : null,
    dispatchCommand: async (type, payload) => {
      calls.push(["command", type, payload]);
      if (type === "task.select") return {};
      const target = {
        streamId: payload.streamId,
        provider: "codex",
        threadId: "thread-1",
        projectRoot: "D:/work",
      };
      threads.set(payload.streamId, target);
      if (shouldInterrupt) {
        shouldInterrupt = false;
        throw new Error("interrupted after task creation");
      }
      return { createdTask: target };
    },
    sendMessage: async (params) => {
      calls.push(["send", params]);
      return { accepted: true };
    },
    activeRuns: () => activeRuns,
    deferredInputs: () => deferredInputs,
  });
  return { launch, task, calls, streams, threads };
}

test("TaskBoardLaunchService starts a Task in its dedicated Git worktree", async () => {
  const { launch, calls } = fixture({ gitWorktree: true });
  await launch.start({
    id: "board-1",
    workspaceId: "workspace-1",
    streamName: "Git Task",
    provider: "codex",
    launchRequestId: "mcp-git-task",
  });

  assert.deepEqual(calls.find(([kind]) => kind === "git-worktree"), [
    "git-worktree", "board-1", "D:/workspace",
  ]);
  const create = calls.find(([, type]) => type === "task.create");
  assert.equal(create[2].workingDirectory, "D:/task-worktree");
  assert.equal(create[2].taskId, "board-1");
  assert.equal(create[2].taskNumber, "AH-42");
});

test("TaskBoardLaunchService ignores a historical Thread root for an existing Stream", async () => {
  const { launch, calls, streams, threads } = fixture({ gitWorktree: true });
  streams.set("stream-1", {
    id: "stream-1", workspaceId: "workspace-1", settings: { workingDirectory: "D:/stream" },
  });
  threads.set("stream-1", {
    streamId: "stream-1", provider: "codex", threadId: "old-thread", projectRoot: "D:/historical",
  });

  await launch.start({
    id: "board-1",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    provider: "codex",
    launchRequestId: "mcp-existing-stream",
  });

  assert.deepEqual(calls.find(([kind]) => kind === "git-worktree"), [
    "git-worktree", "board-1", "D:/stream",
  ]);
});

test("TaskBoardLaunchService falls back from an empty Stream root to the Workspace root", async () => {
  const { launch, calls, streams } = fixture({ gitWorktree: true });
  streams.set("stream-1", {
    id: "stream-1", workspaceId: "workspace-1", settings: { workingDirectory: "" },
  });

  await launch.start({
    id: "board-1",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    provider: "codex",
    launchRequestId: "mcp-workspace-fallback",
  });

  assert.deepEqual(calls.find(([kind]) => kind === "git-worktree"), [
    "git-worktree", "board-1", "D:/workspace",
  ]);
});

test("TaskBoardLaunchService reconciles a crashed MCP start without creating another Stream or Task", async () => {
  const { launch, task, calls, streams } = fixture({ interruptAfterCreate: true });
  const params = {
    id: "board-1",
    workspaceId: "workspace-1",
    streamName: "Recovery",
    provider: "codex",
    launchRequestId: "mcp-start-1",
    clientUserMessageId: "mcp:mcp-start-1",
    followUpMode: "queue",
  };

  await assert.rejects(() => launch.start(params), /interrupted after task creation/u);
  assert.equal(task.status, "starting");
  assert.equal(streams.size, 1);
  assert.equal(calls.filter(([kind]) => kind === "command").length, 1);

  const resumed = await launch.start(params);
  assert.equal(resumed.task.status, "started");
  assert.equal(streams.size, 1);
  assert.equal(calls.filter(([kind]) => kind === "create-stream").length, 1);
  assert.equal(calls.filter(([, type]) => type === "task.create").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "send").length, 1);
  const sent = calls.find(([kind]) => kind === "send")[1];
  assert.equal(sent.clientUserMessageId, "mcp:mcp-start-1");
  assert.equal(sent.text, "");
  assert.deepEqual(sent.taskReferences, [{ taskId: "board-1", intent: "start" }]);
  assert.equal("attachments" in sent, false);
});

test("TaskBoardLaunchService compensates a failed planned Stream before any Task is created", async () => {
  const { task, calls } = fixture();
  const broken = new TaskBoardLaunchService({
    taskBoard: {
      task: () => task,
      prepareStart: ({ workspaceId, streamId, streamName, requestId }) => {
        Object.assign(task, { status: "starting", workspaceId, streamId, startStreamName: streamName, startRequestId: requestId });
        return { ...task };
      },
      cancelPreparedStart: () => {
        Object.assign(task, { status: "open", streamId: null, startStreamName: null, startRequestId: null });
        return { ...task };
      },
      markStarted: () => { throw new Error("must not mark a failed launch as started"); },
    },
    workspaceCatalog: {
      workspace: (id) => id === "workspace-1" ? { id, name: "Agent HUB" } : null,
      stream: () => null,
      activeThread: () => null,
      createStream: () => { throw new Error("cannot persist planned Stream"); },
    },
    dispatchCommand: async () => { throw new Error("must not create a Task without a Stream"); },
    sendMessage: async () => { throw new Error("must not send without a Task"); },
  });

  await assert.rejects(() => broken.start({
    id: "board-1",
    workspaceId: "workspace-1",
    streamName: "Recovery",
    launchRequestId: "mcp-start-2",
  }), /cannot persist planned Stream/u);
  assert.equal(task.status, "open");
  assert.equal(task.streamId, null);
  assert.equal(calls.filter(([kind]) => kind === "command").length, 0);
});

test("TaskBoardLaunchService preserves the executor until durable reassignment succeeds", async () => {
  const { launch, task, calls, streams } = fixture({ started: true });
  streams.set("stream-new", { id: "stream-new", workspaceId: "workspace-1", name: "New" });

  const result = await launch.start({
    id: "board-1",
    workspaceId: "workspace-1",
    streamId: "stream-new",
    reassign: true,
    message: "Пришли результат в Architect.",
    launchRequestId: "reassign-1",
  });

  assert.deepEqual(calls.find(([kind]) => kind === "prepare"), [
    "prepare", "reassign-1", "stream-new", true, "stream-old",
  ]);
  assert.equal(calls.find(([kind]) => kind === "send")[1].text, "Пришли результат в Architect.");
  assert.equal(task.streamId, "stream-new");
  assert.equal(result.task.streamId, "stream-new");
});

test("TaskBoardLaunchService rejects reassignment while the executor has work in progress", async () => {
  for (const busy of [
    { activeRuns: [{ streamId: "stream-old" }] },
    { deferredInputs: [{ provider: "codex", threadId: "thread-old" }] },
  ]) {
    const { launch, calls, streams } = fixture({ started: true, ...busy });
    streams.set("stream-new", { id: "stream-new", workspaceId: "workspace-1", name: "New" });
    await assert.rejects(() => launch.start({
      id: "board-1", workspaceId: "workspace-1", streamId: "stream-new", reassign: true,
      launchRequestId: "reassign-busy",
    }), /активный ход или очередь/u);
    assert.equal(calls.length, 0);
  }
});

test("TaskBoardLaunchService applies only explicit settings to a new Stream", async () => {
  const { launch, calls } = fixture();
  await launch.start({
    id: "board-1",
    workspaceId: "workspace-1",
    streamName: "S2",
    provider: "codex",
    settings: { provider: "codex", model: "gpt-5.6", reasoning: "high" },
    launchRequestId: "new-stream-settings",
  });

  assert.deepEqual(calls.find(([kind]) => kind === "create-stream")[2], {
    provider: "codex", model: "gpt-5.6", reasoning: "high",
  });
});

test("TaskBoardLaunchService creates a distinct target for new-Stream reassignment", async () => {
  const { launch, task, calls } = fixture({ started: true });
  await launch.start({
    id: "board-1",
    workspaceId: "workspace-1",
    streamName: "S2",
    provider: "codex",
    reassign: true,
    launchRequestId: "reassign-new-stream",
  });

  const createdStreamId = calls.find(([kind]) => kind === "create-stream")[1];
  assert.notEqual(createdStreamId, "stream-old");
  assert.equal(task.streamId, createdStreamId);
});
