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

function dynamicItem(source, overrides = {}) {
  return {
    id: "call-composed",
    type: "dynamicToolCall",
    tool: "functions.exec",
    arguments: { input: source },
    status: "failed",
    success: false,
    error: { message: "MCP tool transport timed out" },
    ...overrides,
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

test("bridge parser positionally maps exact ids for two composed mutations", () => {
  const item = dynamicItem(`
    const claim = await tools.mcp__agent_hub__hub_task_claim({
      context_token: "sensitive",
      request_id: "claim-exact",
      task_id: "task-1",
    });
    const sent = await tools.mcp__agent_hub__hub_stream_message_send({
      context_token: "sensitive",
      request_id: "send-exact",
      text: "request_id: not-an-identity",
    });
  `);

  assert.deepEqual(hubMcpCallsFromDynamicItem(item), [
    { toolName: "hub_task_claim", mutating: true, requestId: "claim-exact" },
    { toolName: "hub_stream_message_send", mutating: true, requestId: "send-exact" },
  ]);
});

test("bridge parser reads a JSON-encoded functions.exec input without evaluating it", () => {
  const item = dynamicItem("unused");
  item.arguments = JSON.stringify({
    input: `await tools.mcp__agent_hub__hub_task_claim({ request_id: "json-exact" });`,
  });

  assert.deepEqual(hubMcpCallsFromDynamicItem(item), [
    { toolName: "hub_task_claim", mutating: true, requestId: "json-exact" },
  ]);
});

test("bridge parser keeps a read separate from its composed mutation identity", () => {
  const item = dynamicItem(`
    const task = await tools.mcp__agent_hub__hub_task_get({ context_token: "sensitive", task_id: "task-1" });
    const claim = await tools.mcp__agent_hub__hub_task_claim({ context_token: "sensitive", request_id: "claim-exact" });
  `);

  assert.deepEqual(hubMcpCallsFromDynamicItem(item), [
    { toolName: "hub_task_get", mutating: false, requestId: null },
    { toolName: "hub_task_claim", mutating: true, requestId: "claim-exact" },
  ]);
});

test("bridge parser fails closed for duplicate and missing mutation identities", () => {
  const duplicateAcrossCalls = dynamicItem(`
    await tools.mcp__agent_hub__hub_task_claim({ request_id: "same-id" });
    await tools.mcp__agent_hub__hub_stream_message_send({ request_id: "same-id" });
  `);
  const duplicateProperty = dynamicItem(`
    await tools.mcp__agent_hub__hub_task_claim({ request_id: "first", request_id: "second" });
  `);
  const missing = dynamicItem(`await tools.mcp__agent_hub__hub_task_claim({ task_id: "task-1" });`);

  assert.deepEqual(hubMcpCallsFromDynamicItem(duplicateAcrossCalls).map((call) => ({
    requestId: call.requestId,
    issue: call.requestIdIssue,
  })), [
    { requestId: null, issue: "duplicate-across-calls" },
    { requestId: null, issue: "duplicate-across-calls" },
  ]);
  assert.equal(hubMcpCallsFromDynamicItem(duplicateProperty)[0].requestIdIssue, "duplicate-property");
  assert.equal(hubMcpCallsFromDynamicItem(missing)[0].requestIdIssue, "missing");
});

test("explicit successful completion ignores failure vocabulary in normal payloads", async () => {
  const state = fixture();
  const item = dynamicItem(
    `await tools.mcp__agent_hub__hub_task_get({ context_token: "sensitive", task_id: "task-1" });`,
    {
      status: "completed",
      success: true,
      error: null,
      result: { text: "server timeout is 60 seconds; a closed socket is recoverable" },
      output: "transport aborted and connection reset are documentation terms",
      contentItems: [{ type: "text", text: "broken pipe" }],
    },
  );

  assert.equal(dynamicHubMcpCallFailed(item), false);
  assert.equal(await state.service.observe({ method: "item/completed", item, run: { id: "run-1" } }), null);
  assert.deepEqual(state.reloads, []);
  assert.deepEqual(state.wakes, []);
  assert.deepEqual(state.stages, []);
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

test("composed mutation failures reconcile each exact audit without replaying an effect", async () => {
  const operations = new Map([
    ["claim-exact", { status: "succeeded", result: { claimed: true } }],
    ["send-exact", { status: "failed", error: "delivery rejected" }],
  ]);
  const readbacks = [];
  const reloads = [];
  const wakes = [];
  let repeatedEffects = 0;
  const service = new CodexHubMcpBridgeRecovery({
    reloadMcp: async () => reloads.push("reload"),
    readOperation: (requestId) => {
      readbacks.push(requestId);
      return operations.get(requestId) ?? null;
    },
    wakeDeferredInputs: () => wakes.push("wake"),
    setStage: () => {},
    logger: { log: () => {}, error: () => {} },
  });
  const item = dynamicItem(`
    await tools.mcp__agent_hub__hub_task_claim({ request_id: "claim-exact" });
    await tools.mcp__agent_hub__hub_stream_message_send({ request_id: "send-exact" });
  `);

  const result = await service.observe({ method: "item/completed", item });

  assert.deepEqual(readbacks, ["claim-exact", "send-exact"]);
  assert.deepEqual(result.calls.map((call) => call.outcome), [
    "authoritative-succeeded",
    "authoritative-failed",
  ]);
  assert.deepEqual(reloads, ["reload"]);
  assert.deepEqual(wakes, ["wake"]);
  assert.equal(repeatedEffects, 0);
});

test("ambiguous composed mutation identities never perform authoritative readback", async () => {
  const readbacks = [];
  const service = new CodexHubMcpBridgeRecovery({
    reloadMcp: async () => {},
    readOperation: (requestId) => {
      readbacks.push(requestId);
      return { status: "succeeded" };
    },
    logger: { log: () => {}, error: () => {} },
  });
  const item = dynamicItem(`
    await tools.mcp__agent_hub__hub_task_claim({ request_id: "same-id" });
    await tools.mcp__agent_hub__hub_stream_message_send({ request_id: "same-id" });
    await tools.mcp__agent_hub__hub_task_status_update({ status: "testing" });
  `);

  const result = await service.observe({ method: "item/completed", item });

  assert.deepEqual(readbacks, []);
  assert.deepEqual(result.calls.map((call) => call.outcome), [
    "mutation-identity-missing",
    "mutation-identity-missing",
    "mutation-identity-missing",
  ]);
  assert.equal(result.aggregateOutcome, "replay-blocked-identity");
  assert.match(result.stage, /entire composed call is blocked/u);
});

test("one missing identity blocks replay of an exact pre-dispatch composed mutation", async () => {
  const readbacks = [];
  const service = new CodexHubMcpBridgeRecovery({
    reloadMcp: async () => {},
    readOperation: (requestId) => {
      readbacks.push(requestId);
      return null;
    },
    logger: { log: () => {}, error: () => {} },
  });
  const item = dynamicItem(`
    await tools.mcp__agent_hub__hub_task_claim({ request_id: "claim-exact" });
    await tools.mcp__agent_hub__hub_stream_message_send({ text: "missing identity" });
  `);

  const result = await service.observe({ method: "item/completed", item });

  assert.deepEqual(readbacks, ["claim-exact"]);
  assert.deepEqual(result.calls.map((call) => call.outcome), [
    "pre-dispatch",
    "mutation-identity-missing",
  ]);
  assert.equal(result.aggregateOutcome, "replay-blocked-identity");
  assert.match(result.stage, /entire composed call is blocked/u);
  assert.doesNotMatch(result.stage, /may be retried with the same request_id/u);
});

test("one duplicate identity blocks replay of an exact pre-dispatch composed mutation", async () => {
  const service = new CodexHubMcpBridgeRecovery({
    reloadMcp: async () => {},
    readOperation: () => null,
    logger: { log: () => {}, error: () => {} },
  });
  const item = dynamicItem(`
    await tools.mcp__agent_hub__hub_task_claim({ request_id: "claim-exact" });
    await tools.mcp__agent_hub__hub_stream_message_send({ request_id: "send-a", request_id: "send-b" });
  `);

  const result = await service.observe({ method: "item/completed", item });

  assert.deepEqual(result.calls.map((call) => call.outcome), [
    "pre-dispatch",
    "mutation-identity-missing",
  ]);
  assert.equal(result.calls[1].requestIdIssue, "duplicate-property");
  assert.equal(result.aggregateOutcome, "replay-blocked-identity");
  assert.match(result.stage, /entire composed call is blocked/u);
});

test("unavailable operation reconciliation never becomes pre-dispatch", async (t) => {
  for (const failure of [
    new Error("audit store unavailable"),
    Object.assign(new Error("audit read timed out"), { code: "ETIMEDOUT" }),
  ]) {
    await t.test(failure.code === "ETIMEDOUT" ? "timeout" : "throw", async () => {
      const service = new CodexHubMcpBridgeRecovery({
        reloadMcp: async () => {},
        readOperation: () => { throw failure; },
        logger: { log: () => {}, error: () => {} },
      });

      const result = await service.observe({
        method: "item/completed",
        item: failedItem("hub_task_claim", "claim-exact"),
      });

      assert.equal(result.calls[0].readbackAvailable, false);
      assert.equal(result.calls[0].outcome, "reconciliation-unavailable");
      assert.equal(result.aggregateOutcome, "replay-blocked-reconciliation");
      assert.match(result.stage, /replay is blocked until authoritative readback succeeds/u);
      assert.doesNotMatch(result.stage, /did not reach admission/u);
    });
  }
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

test("failed transport rebind reports deferred recovery and keeps aggregate replay blocked", async () => {
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
    item: dynamicItem(`
      await tools.mcp__agent_hub__hub_task_claim({ request_id: "claim-exact" });
      await tools.mcp__agent_hub__hub_stream_message_send({ text: "missing identity" });
    `),
    run: { id: "run-1" },
  });

  assert.equal(result.recovered, false);
  assert.equal(result.aggregateOutcome, "replay-blocked-identity");
  assert.deepEqual(wakes, ["wake"]);
  assert.match(stages[0], /rebind failed/u);
  assert.match(stages[0], /transport recovery is deferred/u);
  assert.match(stages[0], /entire composed call is blocked/u);
  assert.doesNotMatch(stages[0], /transport recovered/u);
  assert.equal(logs.some((entry) => entry.includes("bridge-reload-failed")), true);
});
