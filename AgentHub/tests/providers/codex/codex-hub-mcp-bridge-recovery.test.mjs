import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexHubMcpBridgeRecovery,
  dynamicHubMcpCallFailed,
  hubMcpCallsFromDynamicItem,
} from "../../../src/providers/codex/codex-hub-mcp-bridge-recovery.mjs";

function failedItem(toolName, requestId = null) {
  const request = requestId ? `, request_id: "${requestId}"` : "";
  return {
    id: `call-${toolName}`,
    type: "dynamicToolCall",
    tool: "exec",
    arguments: {
      input: `const result = await tools.mcp__agent_hub__${toolName}({ context_token: "sensitive"${request} });`,
    },
    status: "failed",
    success: false,
    error: { message: "MCP tool timed out before dispatch" },
  };
}

function fixture(operations = new Map()) {
  const reloads = [];
  const wakes = [];
  const stages = [];
  const logs = [];
  const service = new CodexHubMcpBridgeRecovery({
    reloadMcp: async () => reloads.push("reload"),
    readOperation: (requestId) => operations.get(requestId) ?? null,
    wakeDeferredInputs: () => wakes.push("wake"),
    setStage: (_run, stage) => stages.push(stage),
    logger: { log: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
  });
  return { service, reloads, wakes, stages, logs };
}

test("bridge parser recognizes only nested Agent Hub calls without exposing arguments", () => {
  const item = failedItem("hub_task_claim", "claim-1");
  assert.deepEqual(hubMcpCallsFromDynamicItem(item), [{
    toolName: "hub_task_claim",
    mutating: true,
    requestId: "claim-1",
  }]);
  assert.equal(dynamicHubMcpCallFailed(item), true);
  assert.deepEqual(hubMcpCallsFromDynamicItem({
    ...item,
    arguments: "await tools.mcp__other__long_task({})",
  }), []);
});

test("no-server-admission mutation reloads the bridge and permits only same-id retry", async () => {
  const state = fixture();
  const result = await state.service.observe({
    method: "item/completed",
    item: failedItem("hub_task_claim", "claim-1"),
    run: { id: "run-1" },
  });

  assert.equal(result.calls[0].outcome, "pre-dispatch");
  assert.deepEqual(state.reloads, ["reload"]);
  assert.deepEqual(state.wakes, ["wake"]);
  assert.match(state.stages[0], /same request_id/u);
  assert.equal(state.logs.some((entry) => entry.includes("sensitive")), false);
});

test("lost mutation response reconciles authoritative success without replay", async () => {
  const operations = new Map([["claim-1", { status: "succeeded", result: { claimed: true } }]]);
  const state = fixture(operations);
  const result = await state.service.observe({
    method: "item/completed",
    item: failedItem("hub_task_claim", "claim-1"),
    run: { id: "run-1" },
  });

  assert.equal(result.calls[0].outcome, "authoritative-succeeded");
  assert.equal(result.calls[0].operationStatus, "succeeded");
  assert.match(state.stages[0], /must not be repeated/u);
});

test("pending mutation remains unknown and read-only retry is safe after rebind", async () => {
  const operations = new Map([["claim-1", { status: "pending" }]]);
  const state = fixture(operations);
  const pending = await state.service.observe({
    method: "item/completed",
    item: failedItem("hub_task_claim", "claim-1"),
  });
  const read = await state.service.observe({
    method: "item/completed",
    item: failedItem("hub_task_get"),
  });

  assert.equal(pending.calls[0].outcome, "unknown-pending");
  assert.equal(read.calls[0].outcome, "read-retry-safe");
  assert.deepEqual(state.reloads, ["reload", "reload"]);
});

test("same Thread success after recovery does not trigger another rebind", async () => {
  const state = fixture();
  await state.service.observe({
    method: "item/completed",
    item: failedItem("hub_task_get"),
  });
  const completed = {
    ...failedItem("hub_task_get"),
    status: "completed",
    success: true,
    error: null,
  };
  const result = await state.service.observe({ method: "item/completed", item: completed });

  assert.equal(result, null);
  assert.deepEqual(state.reloads, ["reload"]);
});

test("failed transport rebind still wakes the queued lane with a bounded recovery state", async () => {
  const wakes = [];
  const stages = [];
  const logs = [];
  const service = new CodexHubMcpBridgeRecovery({
    reloadMcp: async () => { throw new Error("reload unavailable"); },
    readOperation: () => null,
    wakeDeferredInputs: () => wakes.push("wake"),
    setStage: (_run, stage) => stages.push(stage),
    logger: { log: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
  });

  const result = await service.observe({
    method: "item/completed",
    item: failedItem("hub_task_get"),
    run: { id: "run-1" },
  });

  assert.equal(result.recovered, false);
  assert.deepEqual(wakes, ["wake"]);
  assert.match(stages[0], /rebind failed/u);
  assert.equal(logs.some((entry) => entry.includes("bridge-reload-failed")), true);
});
