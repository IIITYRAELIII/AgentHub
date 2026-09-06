import assert from "node:assert/strict";
import test from "node:test";

import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { WorkspaceCatalogService } from "../../src/application/workspace-catalog-service.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";

function fixture({ taskBoard = null, blockingRunForWorkspace = () => null } = {}) {
  const calls = [];
  const store = {
    hierarchy: () => [{ id: "workspace-1" }],
    transaction: (run) => run(),
    createWorkspace: (value) => (calls.push(["createWorkspace", value]), { id: "workspace-1", ...value }),
    createStream: (value) => (calls.push(["createStream", value]), { id: "stream-1", ...value }),
    renameWorkspace: (...args) => calls.push(["renameWorkspace", ...args]),
    updateWorkspaceSettings: (...args) => (calls.push(["updateWorkspaceSettings", ...args]), { settings: args[1] }),
    moveWorkspaceToFolder: (...args) => (calls.push(["moveWorkspaceToFolder", ...args]), {
      id: args[0], settings: { catalogFolder: args[1] },
    }),
    renameWorkspaceFolder: (...args) => (calls.push(["renameWorkspaceFolder", ...args]), {
      fromFolderName: args[0], toFolderName: args[1], workspaceCount: 2,
    }),
    archiveWorkspace: (...args) => (calls.push(["archiveWorkspace", ...args]), { id: args[0], archivedAtMs: 1 }),
    restoreWorkspace: (...args) => (calls.push(["restoreWorkspace", ...args]), { id: args[0], archivedAtMs: null }),
    deleteArchivedWorkspace: (...args) => (calls.push(["deleteArchivedWorkspace", ...args]), { id: args[0], deleted: true }),
    archivedWorkspaces: () => [{ id: "workspace-archived" }],
    workspaceDeveloperRules: (...args) => (calls.push(["workspaceDeveloperRules", ...args]), { content: "workspace" }),
    updateWorkspaceDeveloperRules: (...args) => (calls.push(["updateWorkspaceDeveloperRules", ...args]), { content: args[1] }),
    workspace: (id) => ({ id, settings: { releaseWorkflowEnabled: true } }),
    mergeWorkspaces: (...args) => calls.push(["mergeWorkspaces", ...args]),
    renameStream: (...args) => calls.push(["renameStream", ...args]),
    archiveStream: (...args) => (calls.push(["archiveStream", ...args]), { id: args[0] }),
    updateStreamSettings: (...args) => (calls.push(["updateStreamSettings", ...args]), { settings: args[1] }),
    streamDeveloperRules: (...args) => (calls.push(["streamDeveloperRules", ...args]), { content: "stream" }),
    updateStreamDeveloperRules: (...args) => (calls.push(["updateStreamDeveloperRules", ...args]), { content: args[1] }),
    moveStream: (...args) => (calls.push(["moveStream", ...args]), { id: args[0] }),
    reorderStream: (...args) => (calls.push(["reorderStream", ...args]), { id: args[0] }),
    bindThread: (value) => (calls.push(["bindThread", value]), value),
    activeThread: (streamId) => ({ streamId }),
    resolveThread: (value) => value,
    developerRulesForThread: (value) => (calls.push(["developerRulesForThread", value]), value),
    developerRulesForStream: (value) => (calls.push(["developerRulesForStream", value]), value),
  };
  const releasePlanner = {
    plan: (workspaceId) => (calls.push(["releasePlan", workspaceId]), { workspaceId }),
  };
  const releaseCompleter = {
    completeRelease: (params) => (calls.push(["completeRelease", params]), params),
  };
  return {
    calls,
    service: new WorkspaceCatalogService({
      store, taskBoard, releasePlanner, releaseCompleter, blockingRunForWorkspace,
    }),
  };
}

test("createWorkspace creates its first empty Stream and comment atomically", () => {
  const { service, calls } = fixture();
  const result = service.createWorkspace({
    name: "Agent HUB", comment: "Локальный Hub", streamName: "Themes",
  });
  assert.equal(result.workspace.id, "workspace-1");
  assert.equal(result.stream.id, "stream-1");
  assert.deepEqual(calls, [
    ["createWorkspace", { name: "Agent HUB", comment: "Локальный Hub", settings: {} }],
    ["createStream", { workspaceId: "workspace-1", name: "Themes" }],
  ]);
});

test("createWorkspaceFromStream creates the destination and moves the existing Stream atomically", () => {
  const { service, calls } = fixture();
  const result = service.createWorkspaceFromStream({ streamId: "stream-old", name: "Destination" });
  assert.equal(result.workspace.id, "workspace-1");
  assert.deepEqual(calls, [
    ["createWorkspace", { name: "Destination" }],
    ["moveStream", "stream-old", "workspace-1"],
  ]);
});

test("bindThread links a replacement provider Thread to an existing Stream", () => {
  const { service } = fixture();
  assert.deepEqual(service.bindThread({
    streamId: "stream-1", provider: "codex", threadId: "thread-2",
  }), {
    streamId: "stream-1", provider: "codex", threadId: "thread-2",
    projectRoot: "", source: "rebirth",
  });
});

test("Stream settings are stored independently from its future Thread", () => {
  const { service, calls } = fixture();
  const settings = { provider: "claude", model: "sonnet", project: "D:/later" };
  service.createStream({ workspaceId: "workspace-1", name: "Draft", settings });
  assert.deepEqual(service.updateStreamSettings({ streamId: "stream-1", settings }), { settings });
  assert.deepEqual(calls.slice(-2), [
    ["createStream", { workspaceId: "workspace-1", name: "Draft", settings }],
    ["updateStreamSettings", "stream-1", settings],
  ]);
});

test("archiveStream delegates the stable Stream identity to the catalog", () => {
  const { service, calls } = fixture();
  assert.deepEqual(service.archiveStream({ streamId: "stream-1" }), { id: "stream-1" });
  assert.deepEqual(calls.at(-1), ["archiveStream", "stream-1"]);
});

test("Workspace settings provide an inherited working directory", async () => {
  const { service, calls } = fixture();
  const settings = { workingDirectory: "D:/work/AgentHub" };
  assert.deepEqual(await service.updateWorkspaceSettings({
    workspaceId: "workspace-1", settings,
  }), { settings });
  assert.deepEqual(calls.at(-1), [
    "updateWorkspaceSettings",
    "workspace-1",
    settings,
  ]);
});

test("Workspace folder rename delegates one atomic catalog mutation", () => {
  const { service, calls } = fixture();
  assert.deepEqual(service.renameWorkspaceFolder({
    fromFolderName: "Клиенты",
    toFolderName: "Заказчики",
  }), {
    fromFolderName: "Клиенты",
    toFolderName: "Заказчики",
    workspaceCount: 2,
  });
  assert.deepEqual(calls.at(-1), ["renameWorkspaceFolder", "Клиенты", "Заказчики"]);
});

test("permanent delete checks the production active-run owner immediately before persistence", () => {
  const { service, calls } = fixture({
    blockingRunForWorkspace: (workspaceId) => (workspaceId === "workspace-running" ? { id: "run-1" } : null),
  });
  assert.throws(
    () => service.deleteArchivedWorkspace({
      workspaceId: "workspace-running", confirmationName: "Running",
    }),
    /завершите активные ходы/u,
  );
  assert.equal(calls.some(([name]) => name === "deleteArchivedWorkspace"), false);
});

test("queued permanent delete exposes an admission fence until persistence settles", async () => {
  let settleDeletion;
  const deletion = new Promise((resolve) => { settleDeletion = resolve; });
  const service = new WorkspaceCatalogService({
    store: {
      hierarchy: () => [],
      deleteArchivedWorkspace: () => deletion,
    },
  });
  const pending = service.deleteArchivedWorkspace({
    workspaceId: "workspace-1",
    confirmationName: "Workspace",
  });
  assert.equal(service.permanentDeletionPending("workspace-1"), true);
  settleDeletion({ id: "workspace-1", deleted: true });
  assert.deepEqual(await pending, { id: "workspace-1", deleted: true });
  assert.equal(service.permanentDeletionPending("workspace-1"), false);
});

test("pending direct and deferred admissions block permanent delete before begin", async () => {
  for (const entry of ["direct", "deferred"]) {
    let enterPreflight;
    let releasePreflight;
    const preflightEntered = new Promise((resolve) => { enterPreflight = resolve; });
    const preflight = new Promise((resolve) => { releasePreflight = resolve; });
    const taskRuns = new TaskRunRegistry();
    let launchCount = 0;
    let deleteCount = 0;
    const coordinator = new RunCoordinator({
      taskRuns,
      providers: { call: async () => null },
      externalActivity: async () => {
        enterPreflight();
        return preflight;
      },
      repositoryConflict: async () => null,
      deferInput: async (input, temporaryFiles, options) => ({
        deferred: true,
        id: `deferred-${entry}`,
        item: {
          ...options.target,
          input,
          temporaryFiles,
          clientUserMessageId: options.clientUserMessageId,
        },
      }),
      beginRun: async () => { throw new Error("held admission cancelled before begin"); },
      rollbackAdmission: async () => {},
      launchTurn: async () => { launchCount += 1; },
      rekeyDeferredOccupancy: entry !== "direct" ? async () => {
        enterPreflight();
        await preflight;
        return { changed: false };
      } : null,
    });
    const service = new WorkspaceCatalogService({
      store: {
        hierarchy: () => [],
        deleteArchivedWorkspace: () => {
          deleteCount += 1;
          return { id: "workspace-1", deleted: true };
        },
      },
      blockingRunForWorkspace: (workspaceId) => (
        workspaceId === "workspace-1" && coordinator.hasPendingAdmission((target) => (
          target.streamId === "stream-1"
        )) ? { status: "admitting" } : null
      ),
    });
    const target = {
      provider: "codex",
      projectRoot: "C:\\Project",
      streamId: "stream-1",
      threadId: "thread-1",
    };
    let admission;
    if (entry === "direct") {
      admission = coordinator.start("message", [], { target });
    } else if (entry === "deferred") {
      admission = coordinator.startDeferred({
        ...target,
        input: "message",
        clientUserMessageId: "message-1",
      });
    }

    await preflightEntered;
    assert.equal(coordinator.hasPendingAdmission((candidate) => candidate.streamId === target.streamId), true);
    assert.throws(
      () => service.deleteArchivedWorkspace({
        workspaceId: "workspace-1",
        confirmationName: "Workspace",
      }),
      /завершите активные ходы/u,
    );
    releasePreflight(entry === "direct"
      ? { state: "active", executionOwner: "external" }
      : null);
    const result = await admission.catch((error) => error);
    if (entry !== "direct") assert.match(result.message, /cancelled before begin/u);
    else assert.equal(result.started, undefined);
    assert.equal(coordinator.hasPendingAdmission(() => true), false);
    assert.equal(taskRuns.size, 0);
    assert.equal(launchCount, 0);
    assert.equal(deleteCount, 0);
  }
});

test("durable client intake blocks delete until its one scheduled run is admitted", async () => {
  let enterPersistence;
  let releasePersistence;
  const persistenceEntered = new Promise((resolve) => { enterPersistence = resolve; });
  const persistence = new Promise((resolve) => { releasePersistence = resolve; });
  const taskRuns = new TaskRunRegistry();
  let launchCount = 0;
  let deleteCount = 0;
  let workspaceExists = true;
  let scheduledAdmission = null;
  let coordinator;
  coordinator = new RunCoordinator({
    taskRuns,
    providers: { call: async () => null },
    externalActivity: async () => ({ state: "inactive", executionOwner: null }),
    repositoryConflict: async () => null,
    deferInput: async (input, temporaryFiles, options) => {
      enterPersistence();
      await persistence;
      return {
        deferred: true,
        id: "deferred-client",
        item: {
          ...options.target,
          input,
          temporaryFiles,
          clientUserMessageId: options.clientUserMessageId,
        },
      };
    },
    beginRun: async (input, target) => taskRuns.add({
      id: "run-client",
      ...target,
      input,
      status: "running",
    }),
    rollbackAdmission: async (run) => { taskRuns.remove(run); },
    launchTurn: async () => {
      assert.equal(workspaceExists, true);
      launchCount += 1;
    },
    scheduleDeferred: (item) => {
      scheduledAdmission = coordinator.startDeferred(item);
    },
    rekeyDeferredOccupancy: async () => ({ changed: false }),
  });
  const service = new WorkspaceCatalogService({
    store: {
      hierarchy: () => [],
      deleteArchivedWorkspace: () => {
        workspaceExists = false;
        deleteCount += 1;
        return { id: "workspace-1", deleted: true };
      },
    },
    blockingRunForWorkspace: (workspaceId) => (
      workspaceId === "workspace-1" && (
        taskRuns.values().some((run) => run.streamId === "stream-1")
        || coordinator.hasPendingAdmission((target) => target.streamId === "stream-1")
      ) ? { status: "admitting" } : null
    ),
  });
  const target = {
    provider: "codex",
    projectRoot: "C:\\Project",
    streamId: "stream-1",
    threadId: "thread-1",
  };

  const intake = coordinator.acceptClientInput({
    input: "message",
    target,
    clientUserMessageId: "message-1",
  });
  await persistenceEntered;
  assert.equal(coordinator.hasPendingAdmission((candidate) => candidate.streamId === target.streamId), true);
  assert.throws(
    () => service.deleteArchivedWorkspace({
      workspaceId: "workspace-1",
      confirmationName: "Workspace",
    }),
    /завершите активные ходы/u,
  );

  releasePersistence();
  const accepted = await intake;
  assert.equal(accepted.accepted, true);
  assert.ok(scheduledAdmission);
  await scheduledAdmission;
  assert.equal(coordinator.hasPendingAdmission(() => true), false);
  assert.equal(taskRuns.size, 1);
  assert.equal(launchCount, 1);
  assert.equal(deleteCount, 0);
  assert.equal(workspaceExists, true);
});

test("a queued client item cannot launch after permanent delete wins before scheduling", async () => {
  let scheduledItem = null;
  let launchCount = 0;
  let workspaceExists = true;
  const taskRuns = new TaskRunRegistry();
  const coordinator = new RunCoordinator({
    taskRuns,
    providers: { call: async () => null },
    externalActivity: async () => ({ state: "inactive", executionOwner: null }),
    repositoryConflict: async () => null,
    deferInput: async (input, temporaryFiles, options) => ({
      deferred: true,
      id: "deferred-client",
      item: {
        ...options.target,
        input,
        temporaryFiles,
        clientUserMessageId: options.clientUserMessageId,
      },
    }),
    beginRun: async () => {
      if (!workspaceExists) {
        const error = new Error("Run target Workspace or Stream no longer exists");
        error.code = "RUN_TARGET_NOT_FOUND";
        throw error;
      }
      return assert.fail("deleted Stream must fail before run registration");
    },
    rollbackAdmission: async () => {},
    launchTurn: async () => { launchCount += 1; },
    scheduleDeferred: (item) => { scheduledItem = item; },
    rekeyDeferredOccupancy: async () => ({ changed: false }),
  });
  const service = new WorkspaceCatalogService({
    store: {
      hierarchy: () => [],
      deleteArchivedWorkspace: () => {
        workspaceExists = false;
        return { id: "workspace-1", deleted: true };
      },
    },
    blockingRunForWorkspace: () => (
      coordinator.hasPendingAdmission(() => true) ? { status: "admitting" } : null
    ),
  });
  const target = {
    provider: "codex",
    projectRoot: "C:\\Project",
    streamId: "stream-1",
    threadId: "thread-1",
  };

  await coordinator.acceptClientInput({
    input: "message",
    target,
    clientUserMessageId: "message-1",
  });
  assert.ok(scheduledItem);
  assert.equal(coordinator.hasPendingAdmission(() => true), false);
  assert.equal(service.deleteArchivedWorkspace({
    workspaceId: "workspace-1",
    confirmationName: "Workspace",
  }).deleted, true);
  await assert.rejects(
    coordinator.startDeferred(scheduledItem),
    (error) => error?.code === "RUN_TARGET_NOT_FOUND",
  );
  assert.equal(taskRuns.size, 0);
  assert.equal(launchCount, 0);
});

test("Workspace archive and restore keep the stable Workspace identity", () => {
  const { service, calls } = fixture();
  assert.equal(service.archiveWorkspace({ workspaceId: "workspace-1" }).archivedAtMs, 1);
  assert.equal(service.restoreWorkspace({ workspaceId: "workspace-1" }).archivedAtMs, null);
  assert.equal(service.deleteArchivedWorkspace({
    workspaceId: "workspace-1", confirmationName: "Agent HUB",
  }).deleted, true);
  assert.deepEqual(service.archivedWorkspaces(), [{ id: "workspace-archived" }]);
  assert.deepEqual(calls.slice(-3), [
    ["archiveWorkspace", "workspace-1"],
    ["restoreWorkspace", "workspace-1"],
    ["deleteArchivedWorkspace", "workspace-1", "Agent HUB"],
  ]);
});

test("Workspace folder move delegates only stable identity and folder name", () => {
  const { service, calls } = fixture();
  assert.deepEqual(service.moveWorkspaceToFolder({
    workspaceId: "workspace-1",
    folderName: "Клиенты",
  }), {
    id: "workspace-1",
    settings: { catalogFolder: "Клиенты" },
  });
  assert.deepEqual(calls.at(-1), ["moveWorkspaceToFolder", "workspace-1", "Клиенты"]);
});

test("adding a Workspace Task prefix backfills its unnumbered Tasks", async () => {
  const assigned = [];
  const { service } = fixture({
    taskBoard: { assignWorkspaceTaskNumbers: (workspaceId) => assigned.push(workspaceId) },
  });
  await service.updateWorkspaceSettings({
    workspaceId: "workspace-1", settings: { taskPrefix: "HUB" },
  });
  assert.deepEqual(assigned, ["workspace-1"]);
});

test("release workflow disable never blocks on Task state", async () => {
  const { calls, service } = fixture();
  const result = await service.updateWorkspaceSettings({
    workspaceId: "workspace-1", settings: { releaseWorkflowEnabled: false },
  });
  assert.deepEqual(result, { settings: { releaseWorkflowEnabled: false } });
  assert.equal(calls.some(([name]) => name === "updateWorkspaceSettings"), true);
});

test("Workspace and Stream developer rules use dedicated store methods", () => {
  const { service, calls } = fixture();
  assert.deepEqual(service.updateWorkspaceDeveloperRules({
    workspaceId: "workspace-1", content: "Workspace rule",
  }), { content: "Workspace rule" });
  assert.deepEqual(service.updateStreamDeveloperRules({
    streamId: "stream-1", content: "Stream rule",
  }), { content: "Stream rule" });
  assert.deepEqual(service.developerRulesForThread({
    provider: "codex", threadId: "thread-1",
  }), { provider: "codex", threadId: "thread-1" });
  assert.equal(service.developerRulesForStream({ streamId: "stream-1" }), "stream-1");
  assert.deepEqual(calls.slice(-4), [
    ["updateWorkspaceDeveloperRules", "workspace-1", "Workspace rule"],
    ["updateStreamDeveloperRules", "stream-1", "Stream rule"],
    ["developerRulesForThread", { provider: "codex", threadId: "thread-1" }],
    ["developerRulesForStream", "stream-1"],
  ]);
});

test("moving a Stream can place it before a sibling in the same transaction", () => {
  const { service, calls } = fixture();
  assert.deepEqual(service.moveStream({
    streamId: "stream-2",
    workspaceId: "workspace-1",
    beforeStreamId: "stream-1",
  }), { id: "stream-2" });
  assert.deepEqual(calls.slice(-2), [
    ["moveStream", "stream-2", "workspace-1"],
    ["reorderStream", "stream-2", "stream-1"],
  ]);
});
