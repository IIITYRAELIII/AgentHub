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
    "renameWorkspace", "updateWorkspaceSettings", "updateWorkspaceDeveloperRules", "readWorkspaceReleaseRegistry", "readWorkspaceReleasePlan", "updateReleaseChangeStatus", "completeWorkspaceRelease", "createWorkspace", "createWorkspaceFromStream", "mergeWorkspaces", "createStream",
    "renameStream", "archiveStream", "updateStreamSettings", "updateStreamDeveloperRules", "moveStream",
  ].map((name) => [name, (...args) => { calls.push({ name, args }); return name; }]));
  return createApplicationCommandService({ handlers });
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

test("task-scoped settings require their own exact task identity", () => {
  const commands = service([]);
  assert.deepEqual(commands.settingTarget({
    name: "model",
    model: "gpt",
    streamId: "stream-client",
    provider: "claude",
    projectRoot: "D:/client",
    threadId: "thread-client",
  }), {
    streamId: "stream-client", provider: "claude", projectRoot: "D:/client", threadId: "thread-client",
  });
  assert.throws(() => commands.settingTarget({ name: "model", model: "gpt" }), /exact task identity/u);
  assert.throws(() => commands.settingTarget({ name: "project", value: "D:/client" }), /exact task identity/u);
  assert.equal(commands.settingTarget({ name: "approvalMode" }), null);
  assert.equal(commandClientContext({ clientId: "explicit" }, "fallback").clientId, "explicit");
});

test("workspace and stream commands use the shared command path", async () => {
  const calls = [];
  const commands = service(calls);
  await commands.dispatch("workspace.rename", {
    workspaceId: "workspace-1",
    name: "Agent HUB",
  }, { source: "desktop", userId: "7" });
  await commands.dispatch("workspace.create", {
    name: "New Workspace",
    comment: "Описание",
  }, { source: "desktop", userId: "7" });
  await commands.dispatch("workspace.settings.update", {
    workspaceId: "workspace-1",
    settings: { workingDirectory: "D:/work/AgentHub" },
  }, { source: "desktop", userId: "7" });
  await commands.dispatch("workspace.developer-rules.update", {
    workspaceId: "workspace-1",
    content: "Workspace rule",
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
  await commands.dispatch("stream.archive", {
    streamId: "stream-1",
  }, { source: "desktop", userId: "7" });
  await commands.dispatch("stream.developer-rules.update", {
    streamId: "stream-1",
    content: "Stream rule",
  }, { source: "desktop", userId: "7" });
  await commands.dispatch("stream.move", {
    streamId: "stream-1",
    workspaceId: "workspace-2",
    beforeStreamId: "stream-2",
  }, { source: "desktop", userId: "7" });
  assert.deepEqual(calls, [
    {
      name: "renameWorkspace",
      args: [{ workspaceId: "workspace-1", name: "Agent HUB" }],
    },
    {
      name: "createWorkspace",
      args: [{ name: "New Workspace", comment: "Описание" }],
    },
    {
      name: "updateWorkspaceSettings",
      args: [{ workspaceId: "workspace-1", settings: { workingDirectory: "D:/work/AgentHub" } }],
    },
    {
      name: "updateWorkspaceDeveloperRules",
      args: [{ workspaceId: "workspace-1", content: "Workspace rule" }],
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
      name: "archiveStream",
      args: [{ streamId: "stream-1" }],
    },
    {
      name: "updateStreamDeveloperRules",
      args: [{ streamId: "stream-1", content: "Stream rule" }],
    },
    {
      name: "moveStream",
      args: [{ streamId: "stream-1", workspaceId: "workspace-2", beforeStreamId: "stream-2" }],
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
