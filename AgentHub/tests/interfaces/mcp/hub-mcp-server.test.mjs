import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";

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
