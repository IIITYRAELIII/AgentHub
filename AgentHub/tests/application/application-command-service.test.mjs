import assert from "node:assert/strict";
import test from "node:test";
import {
  commandClientContext,
  commandTaskTarget,
  createApplicationCommandService,
} from "../../src/application/application-command-service.mjs";

function service(calls) {
  const handlers = Object.fromEntries([
    "selectTask", "createTask", "rotateStream", "renameTask", "archiveTask",
    "updateSetting", "cancelRun", "resolveApproval",
    "renameWorkspace", "createWorkspaceFromStream", "mergeWorkspaces", "createStream",
    "renameStream", "updateStreamSettings", "moveStream",
  ].map((name) => [name, (...args) => { calls.push({ name, args }); return name; }]));
  return createApplicationCommandService({
    handlers,
    selectedTask: () => ({ streamId: "stream-1", provider: "codex", threadId: "thread-1" }),
  });
}

test("application command service keeps exact task address and client identity", async () => {
  const calls = [];
  const commands = service(calls);
  const target = commandTaskTarget({ streamId: " stream-1 ", provider: "codex", threadId: " thread-1 " });
  await commands.dispatch("task.select", { taskTitle: "Task" }, { source: "desktop", userId: "7" }, { target });
  assert.deepEqual(calls[0], {
    name: "selectTask",
    args: [{ taskTitle: "Task", ...target }, { source: "desktop", userId: "7", clientId: "desktop:7" }],
  });
});

test("task-scoped settings inherit the selected streamId", () => {
  const commands = service([]);
  assert.deepEqual(commands.settingTarget({ name: "model", model: "gpt" }), {
    streamId: "stream-1", provider: "codex", projectRoot: null, threadId: "thread-1",
  });
  assert.equal(commands.settingTarget({ name: "project" }), null);
  assert.equal(commandClientContext({ clientId: "explicit" }, "fallback").clientId, "explicit");
});

test("workspace and stream commands use the shared command path", async () => {
  const calls = [];
  const commands = service(calls);
  await commands.dispatch("workspace.rename", {
    workspaceId: "workspace-1",
    name: "Agent HUB",
  }, { source: "desktop", userId: "7" });
  await commands.dispatch("workspace.create-from-stream", {
    streamId: "stream-1",
    name: "New Workspace",
  }, { source: "desktop", userId: "7" });
  await commands.dispatch("stream.create", {
    workspaceId: "workspace-1",
    settings: { provider: "codex" },
  }, { source: "desktop", userId: "7" });
  await commands.dispatch("stream.settings.update", {
    streamId: "stream-1",
    settings: { model: "gpt-5" },
  }, { source: "desktop", userId: "7" });
  await commands.dispatch("stream.move", {
    streamId: "stream-1",
    workspaceId: "workspace-2",
  }, { source: "desktop", userId: "7" });
  assert.deepEqual(calls, [
    {
      name: "renameWorkspace",
      args: [{ workspaceId: "workspace-1", name: "Agent HUB" }],
    },
    {
      name: "createWorkspaceFromStream",
      args: [{ streamId: "stream-1", name: "New Workspace" }],
    },
    {
      name: "createStream",
      args: [{ workspaceId: "workspace-1", settings: { provider: "codex" } }],
    },
    {
      name: "updateStreamSettings",
      args: [{ streamId: "stream-1", settings: { model: "gpt-5" } }],
    },
    {
      name: "moveStream",
      args: [{ streamId: "stream-1", workspaceId: "workspace-2" }],
    },
  ]);
});

test("Stream rotation keeps an exact task-scoped command target", async () => {
  const calls = [];
  const commands = service(calls);
  const target = commandTaskTarget({ streamId: "stream-1", provider: "codex", threadId: "thread-1" });
  await commands.dispatch("stream.rotate", {}, { source: "desktop" }, { target });
  assert.deepEqual(calls[0], {
    name: "rotateStream",
    args: [{ ...target }],
  });
});
