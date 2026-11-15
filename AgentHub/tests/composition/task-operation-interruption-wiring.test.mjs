import assert from "node:assert/strict";
import test from "node:test";
import { importCompositionWithPorts } from "../helpers/composition-ports.fixture.mjs";

test("actual interaction phase forwards the existing MCP owner to Desktop runtime", async () => {
  const owner = { exact: "existing HubMcpService" };
  const boundary = new Error("captured Desktop boundary"); let captured;
  const { createInteractionShellPhase } = await importCompositionWithPorts(
    new URL("../../src/composition/interaction-shell-phase-composition.mjs", import.meta.url), {
      "./server-control-composition.mjs": { createServerControlComposition: () => ({}) },
      "./desktop-shell-composition.mjs": { createDesktopShellComposition: options => { captured = options.runtime; throw boundary; } },
    });
  assert.throws(() => createInteractionShellPhase({ config: {}, root: "fixture", server: {}, settings: {}, selection: {},
    infrastructure: { hubMcpService: owner, runtimeStateStore: { saveDeferredIntake() {} } },
    provider: { taskSyncStore: { searchMessages() {}, messageSearchStatus() {}, markMessageSearchThread() {} } },
    clients: {}, deferred: { api: {}, ports: {} } }), error => error === boundary);
  assert.equal(captured.hubMcpService, owner);
});

test("actual Desktop router construction uses one existing cancellation owner for read and cancel", async () => {
  const calls = [];
  const owner = { taskOperationInterruption: {
    list(id) { calls.push(["list", id]); return [{ requestId: "original" }]; },
    async cancel(input) { calls.push(["cancel", input]); return { phase: "stopped" }; },
  } };
  const { createDesktopRunRouterWiring } = await importCompositionWithPorts(
    new URL("../../src/composition/desktop-run-router-wiring-composition.mjs", import.meta.url), {
      "./desktop-run-input-composition.mjs": { createDesktopRunInputComposition: () => ({ desktopMessageController: { sendMessage() {} } }) },
      "./desktop-router-composition.mjs": { createDesktopRouterComposition: options => ({ handlers: options.handlers }) },
      "../application/task-board-launch-service.mjs": { TaskBoardLaunchService: class {} },
    });
  const wiring = createDesktopRunRouterWiring({ config: { dataDir: "fixture" }, constants: {}, state: {},
    services: { hubMcpService: owner, workspaceCatalog: {}, taskBoard: {
      card: id => ({ id, workspaceId: "target" }), task: id => ({ id, workspaceId: "target" }),
    } }, desktop: {} });
  assert.equal(wiring.handlers.boardTaskRead({ id: "task" }).taskOperations[0].requestId, "original");
  const result = await wiring.handlers.boardTaskOperationCancel({ id: "task", operationRequestId: "original",
    requestId: "cancel", expectedRevision: 7, argumentsHash: "hash", confirmCancel: true });
  assert.equal(result.cancellation.phase, "stopped");
  assert.equal(calls[1][1].operationRequestId, "original");
  assert.deepEqual(calls[1][1].actor, { user: true, workspaceId: "target" });
});
