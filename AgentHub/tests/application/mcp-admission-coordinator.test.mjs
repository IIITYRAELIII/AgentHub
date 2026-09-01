import assert from "node:assert/strict";
import test from "node:test";

import {
  McpAdmissionCoordinator,
  mcpOperationIdentity,
} from "../../src/application/mcp-admission-coordinator.mjs";

function manualTimers() {
  const timers = [];
  return {
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clear(timer) { timer.cleared = true; },
    runNext() {
      const timer = timers.find((candidate) => !candidate.cleared);
      if (!timer) throw new Error("No pending timer");
      timer.cleared = true;
      timer.callback();
    },
    pending: () => timers.filter((timer) => !timer.cleared).length,
  };
}

test("MCP admission retry reuses the exact elicitation and operation identities", () => {
  const timers = manualTimers();
  const responses = [];
  const logs = [];
  const coordinator = new McpAdmissionCoordinator({
    timeoutMs: 25,
    schedule: timers.schedule,
    clear: timers.clear,
    logger: { log: (value) => logs.push(value), error: (value) => logs.push(value) },
  });
  const params = {
    serverName: "agent_hub",
    threadId: "thread-1",
    turnId: "turn-1",
    toolCall: {
      toolName: "hub_task_claim",
      arguments: { request_id: "claim-1" },
    },
  };
  const response = { action: "accept", content: { accept: true } };

  coordinator.begin({
    rpcId: 41,
    params,
    response,
    respond: (...args) => responses.push(args),
    runId: "run-1",
  });
  timers.runNext();

  assert.deepEqual(responses, [[41, response], [41, response]]);
  assert.equal(coordinator.diagnostics()[0].requestId, "claim-1");
  assert.equal(coordinator.diagnostics()[0].attempts, 2);
  assert.equal(coordinator.admit({
    serverName: "agent_hub",
    requestId: "claim-1",
    toolName: "hub_task_claim",
    rpcRequestId: 73,
  }), true);
  assert.equal(timers.pending(), 0);
  assert.deepEqual(coordinator.diagnostics(), []);
  assert.ok(logs.some((line) => line.includes('"stage":"operation-admission-timeout"')));
  assert.ok(logs.some((line) => line.includes('"rpcRequestId":"73"')));
});

test("MCP admission never settles another operation with a different request_id", () => {
  const timers = manualTimers();
  const coordinator = new McpAdmissionCoordinator({
    schedule: timers.schedule,
    clear: timers.clear,
    logger: { log() {}, error() {} },
  });
  coordinator.begin({
    rpcId: "rpc-1",
    params: { serverName: "agent_hub", arguments: { request_id: "request-1" } },
    response: { action: "accept" },
    respond() {},
  });

  assert.equal(coordinator.admit({ serverName: "agent_hub", requestId: "request-2" }), false);
  assert.equal(coordinator.diagnostics().length, 1);
  assert.equal(coordinator.admit({ serverName: "agent_hub", requestId: "request-1" }), true);
  assert.equal(coordinator.diagnostics().length, 0);
});

test("MCP operation identity reads request_id defaults without logging arguments", () => {
  assert.deepEqual(mcpOperationIdentity({
    toolCall: { toolName: "hub_task_claim" },
    requestedSchema: {
      properties: { request_id: { type: "string", default: "claim-default" } },
    },
  }), {
    requestId: "claim-default",
    toolName: "hub_task_claim",
  });
});

test("uncorrelated MCP elicitation is answered once without a speculative retry", () => {
  const timers = manualTimers();
  const responses = [];
  const coordinator = new McpAdmissionCoordinator({
    schedule: timers.schedule,
    clear: timers.clear,
    logger: { log() {}, error() {} },
  });
  coordinator.begin({
    rpcId: "url-rpc",
    params: { serverName: "external", mode: "url" },
    response: { action: "accept" },
    respond: (...args) => responses.push(args),
  });

  assert.deepEqual(responses, [["url-rpc", { action: "accept" }]]);
  assert.equal(timers.pending(), 0);
  assert.deepEqual(coordinator.diagnostics(), []);
});

test("provider continuation settles a standard elicitation by exact thread and turn", () => {
  const timers = manualTimers();
  const responses = [];
  const coordinator = new McpAdmissionCoordinator({
    schedule: timers.schedule,
    clear: timers.clear,
    logger: { log() {}, error() {} },
  });
  coordinator.begin({
    rpcId: "standard-rpc",
    params: {
      serverName: "fake-permission-mcp",
      threadId: "thread-1",
      turnId: "turn-1",
    },
    response: { action: "accept", content: { approved: true } },
    respond: (...args) => responses.push(args),
  });

  assert.equal(timers.pending(), 1);
  assert.equal(coordinator.progress({
    threadId: "thread-1",
    turnId: "other-turn",
    method: "item/completed",
  }), false);
  assert.equal(coordinator.progress({
    threadId: "thread-1",
    turnId: "turn-1",
    method: "item/completed",
  }), true);
  assert.equal(timers.pending(), 0);
  assert.equal(responses.length, 1);
});

test("MCP admission timeout stays unknown and stops after one bounded retry", () => {
  const timers = manualTimers();
  const responses = [];
  const logs = [];
  const coordinator = new McpAdmissionCoordinator({
    timeoutMs: 25,
    schedule: timers.schedule,
    clear: timers.clear,
    logger: { log: (value) => logs.push(value), error: (value) => logs.push(value) },
  });
  coordinator.begin({
    rpcId: "rpc-timeout",
    params: { threadId: "thread-1", turnId: "turn-1" },
    response: { action: "accept" },
    respond: (...args) => responses.push(args),
  });

  timers.runNext();
  timers.runNext();

  assert.equal(responses.length, 2);
  assert.equal(timers.pending(), 0);
  assert.deepEqual(coordinator.diagnostics(), []);
  assert.ok(logs.some((line) => (
    line.includes('"stage":"operation-admission-unresolved"')
      && line.includes('"outcome":"unknown"')
  )));
});
