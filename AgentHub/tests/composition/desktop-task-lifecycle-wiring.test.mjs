import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { WorkspaceCatalogService } from "../../src/application/workspace-catalog-service.mjs";
import { createWorkspaceActions } from "../../src/composition/desktop-command-wiring-composition.mjs";

async function loadComposition(filename, overrides = {}) {
  const url = new URL(`../../src/composition/${filename}`, import.meta.url);
  const source = await readFile(url, "utf8");
  const imports = /^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/gm;
  const scope = {};
  for (const [, bindings, specifier] of source.matchAll(imports)) {
    const namespace = await import(new URL(specifier, url).href);
    if (bindings.startsWith("* as ")) {
      scope[bindings.slice(5).trim()] = namespace;
    } else if (bindings.startsWith("{")) {
      for (const binding of bindings.slice(1, -1).split(",").map((value) => value.trim()).filter(Boolean)) {
        const [name, alias = name] = binding.split(/\s+as\s+/u);
        scope[alias] = namespace[name];
      }
    } else {
      scope[bindings.trim()] = namespace.default;
    }
  }
  Object.assign(scope, overrides);
  vm.runInNewContext(source.replace(imports, "").replace(/^export /gm, ""), scope, { filename: url.pathname });
  return scope;
}

async function fixture(taskLifecycle, releaseServices = {}) {
  const snapshot = { boardTasks: [{ id: "task-test", status: "done" }] };
  const runRouter = await loadComposition("desktop-run-router-wiring-composition.mjs", {
    createDesktopRunInputComposition: () => ({ desktopMessageController: { sendMessage() {} } }),
    TaskBoardLaunchService: class {},
    createDesktopRouterComposition: ({ handlers }) => ({
      handleDesktopControl: ({ action, params, context }) => {
        assert.equal(action, "board-task-complete");
        return handlers.boardTaskComplete(params, context);
      },
    }),
  });
  const desktop = await loadComposition("desktop-shell-composition.mjs", {
    createDesktopReadSystemWiring: () => ({ desktopSnapshot: async () => snapshot }),
    createDesktopCommandWiring: ({ services }) => ({ desktopSnapshotActions: {}, ...createWorkspaceActions(services) }),
    createDesktopRunRouterWiring: runRouter.createDesktopRunRouterWiring,
    createDesktopTaskCreationPreparation: () => () => {},
    WorkspaceCatalogService,
    ClientTaskSelectionService: class {},
    StreamMessagePinService: class {},
  });
  const interaction = await loadComposition("interaction-shell-phase-composition.mjs", {
    createDesktopShellComposition: desktop.createDesktopShellComposition,
    createRunShellComposition: () => ({}),
    createServerControlComposition: () => ({}),
  });
  let boundCommands;
  const composition = interaction.createInteractionShellPhase({
    config: { dataDir: "." },
    root: ".",
    server: {},
    settings: {},
    selection: { hostState: {} },
    infrastructure: {
      taskLifecycle,
      ...releaseServices,
      workspaceCatalogStore: { hierarchy: () => [] },
      runtimeStateStore: { saveDeferredIntake() {} },
    },
    provider: {
      taskSyncStore: { searchMessages() {}, messageSearchStatus() {}, markMessageSearchThread() {} },
    },
    clients: { approvalController: {} },
    deferred: {
      api: {},
      ports: {
        desktopCommands: { api: {}, bind(commands) { boundCommands = commands; } },
      },
    },
  });
  return { composition, boundCommands, snapshot };
}

test("Task completion crosses interaction and Desktop composition using the shared lifecycle owner", async () => {
  const calls = [];
  const lifecycleResult = { taskId: "task-test", status: "completed" };
  const taskLifecycle = {
    async complete(params) {
      assert.equal(this, taskLifecycle);
      calls.push(params);
      return lifecycleResult;
    },
  };
  const { composition, boundCommands, snapshot } = await fixture(taskLifecycle);
  assert.equal(boundCommands.handleDesktopControl, composition.handleDesktopControl);
  const result = await boundCommands.handleDesktopControl({
    action: "board-task-complete",
    params: { id: "task-test", confirmCleanup: true, expectedCleanupToken: "cleanup-test" },
    context: { commandId: "complete-test" },
  });
  assert.deepEqual(calls, [{
    taskId: "task-test",
    operationId: "complete-test",
    confirmCleanup: true,
    expectedCleanupToken: "cleanup-test",
  }]);
  assert.deepEqual(result, { ...snapshot, lifecycleResult });
});

test("Task lifecycle rejection propagates through the composed completion route", async () => {
  const rejection = new Error("Task cleanup confirmation is stale");
  const { boundCommands } = await fixture({ complete: async () => { throw rejection; } });
  await assert.rejects(boundCommands.handleDesktopControl({
    action: "board-task-complete",
    params: { id: "task-test" },
    context: { commandId: "complete-test" },
  }), (error) => error === rejection);
});

test("Workspace release actions cross interaction and Desktop composition with the canonical owners", async () => {
  const calls = [];
  const plan = { revision: "exact-plan", ready: [{ taskId: "task" }] };
  const completion = { finalization: { status: "completed" } };
  const taskReleasePlanner = { async plan(workspaceId) { assert.equal(this, taskReleasePlanner); calls.push(["plan", workspaceId]); return plan; } };
  const workspaceReleaseService = { async completeRelease(params) { assert.equal(this, workspaceReleaseService); calls.push(["complete", params]); return completion; } };
  const { composition } = await fixture({}, { taskReleasePlanner, workspaceReleaseService });
  assert.equal(await composition.readWorkspaceReleasePlan({ workspaceId: "workspace" }), plan);
  const params = { workspaceId: "workspace", expectedPlanRevision: "exact-plan", deploymentVerified: true };
  assert.equal(await composition.completeWorkspaceRelease(params), completion);
  assert.deepEqual(calls, [["plan", "workspace"], ["complete", params]]);
});
