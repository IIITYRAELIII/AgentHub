import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { AGENT_HUB_VERSION } from "../../../src/infrastructure/filesystem/agent-hub-package.mjs";

import { HubMcpServer } from "../../../src/interfaces/mcp/hub-mcp-server.mjs";

test("HubMcpServer serves MCP only through its secret loopback URL", async (context) => {
  const server = new HubMcpServer({
    secret: "server-secret",
    service: {
      tools: () => [{ name: "example", inputSchema: { type: "object" } }],
      call: (_name, args) => ({ value: args.value }),
    },
    logger: { log() {}, error() {} },
  });
  await server.start();
  context.after(() => server.close());

  const initialized = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
  }).then((response) => response.json());
  assert.equal(initialized.result.serverInfo.name, "agent_hub");
  assert.equal(initialized.result.serverInfo.version, AGENT_HUB_VERSION);
  assert.match(initialized.result.instructions, /exact non-empty context_token/u);
  assert.match(initialized.result.instructions, /not an environment variable/u);

  const tools = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  }).then((response) => response.json());
  assert.equal(tools.result.tools[0].name, "example");

  const publicPath = await fetch(new URL("/mcp", server.url), { method: "POST", body: "{}" });
  assert.equal(publicPath.status, 404);
});

test("HubMcpServer closes active HTTP sockets during a runtime restart", async () => {
  const server = new HubMcpServer({
    secret: "server-secret",
    service: { tools: () => [], call: () => ({}) },
    logger: { log() {}, error() {} },
  });
  await server.start();
  const endpoint = new URL(server.url);
  const socket = connect(Number(endpoint.port), endpoint.hostname);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`POST ${endpoint.pathname} HTTP/1.1\r\nHost: ${endpoint.host}\r\nContent-Length: 100\r\n\r\n{`);
  await Promise.race([
    server.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("MCP close timed out")), 1_000)),
  ]);
  assert.equal(server.running, false);
  socket.destroy();
});

test("HubMcpServer reports an unexpected dispatch failure", async (context) => {
  const captured = [];
  const server = new HubMcpServer({
    secret: "server-secret",
    service: {
      tools: () => { throw new TypeError("broken tool registry"); },
      call: () => ({}),
    },
    captureUnexpectedException: (error, diagnosticContext) => {
      captured.push([error.message, diagnosticContext.action]);
    },
    logger: { log() {}, error() {} },
  });
  await server.start();
  context.after(() => server.close());

  const response = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }).then((value) => value.json());
  assert.equal(response.error.code, -32603);
  assert.deepEqual(captured, [["broken tool registry", "dispatch"]]);
});

test("HubMcpServer bounds an unresolved tool call and reports an unknown outcome", async (context) => {
  const captured = [];
  const server = new HubMcpServer({
    secret: "server-secret",
    requestTimeoutMs: 20,
    service: {
      tools: () => [{ name: "blocked", inputSchema: { type: "object" } }],
      call: () => new Promise(() => {}),
    },
    captureUnexpectedException: (error) => captured.push(error.message),
    logger: { log() {}, error() {} },
  });
  await server.start();
  context.after(() => server.close());

  const response = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "blocked", arguments: { request_id: "same-request" } },
    }),
    signal: AbortSignal.timeout(1_000),
  }).then((value) => value.json());

  assert.equal(response.error.code, -32001);
  assert.match(response.error.message, /timed out after 20 ms; outcome is unknown/u);
  assert.match(response.error.message, /Reuse the same request_id/u);
  assert.deepEqual(captured, []);
});

test("HubMcpServer records exact admission before an idempotent mutation runs", async (context) => {
  const events = [];
  const server = new HubMcpServer({
    secret: "server-secret",
    mcpAdmissionCoordinator: {
      admit: (event) => events.push(["admit", event]),
      observeOperation: (stage, event) => events.push([stage, event]),
    },
    service: {
      tools: () => [],
      call: (name, args) => {
        events.push(["call", { name, requestId: args.request_id }]);
        return { ok: true };
      },
    },
    logger: { log() {}, error() {} },
  });
  await server.start();
  context.after(() => server.close());

  const response = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "hub_task_claim", arguments: { request_id: "claim-1" } },
    }),
  }).then((value) => value.json());

  assert.equal(response.result.isError, false);
  assert.deepEqual(events.map(([stage]) => stage), [
    "admit", "tool-call-received", "call", "tool-call-completed",
  ]);
  assert.equal(events[0][1].requestId, "claim-1");
  assert.equal(events[0][1].rpcRequestId, 91);
  assert.equal(events[2][1].requestId, "claim-1");
});
