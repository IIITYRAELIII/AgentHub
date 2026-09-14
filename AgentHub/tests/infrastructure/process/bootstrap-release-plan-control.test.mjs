import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBootstrapReleasePlanControl } from "../../../src/infrastructure/process/bootstrap-release-plan-control.mjs";
import { parseChangedArguments } from "../../../publish-changed.mjs";

const revision = "a".repeat(40);
const workspaceId = "workspace-1";
const missing = () => { throw new Error("Task release plan is unavailable"); };
const livePlan = (n = 1) => ({ workspaceId, revision: `plan-${n}`, candidates: [] });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-bootstrap-mcp-"));
  const contextFile = path.join(root, "context.json");
  const calls = [];
  let respond = (request, response) => response.end(JSON.stringify({
    jsonrpc: "2.0", id: request.id,
    result: { isError: false, structuredContent: livePlan(calls.length) },
  }));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const envelope = JSON.parse(body);
    calls.push({ path: request.url, envelope });
    response.setHeader("content-type", "application/json");
    respond(envelope, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const configuration = {
    url: `http://127.0.0.1:${server.address().port}/mcp/test-capability`,
    context_token: "private-context-token", workspaceId, runtimeRevision: revision,
  };
  const save = (updates = {}) => writeFile(contextFile, JSON.stringify({ ...configuration, ...updates }), "utf8");
  await save();
  return {
    calls, configuration, save, setResponse: (value) => { respond = value; },
    bridge: (options = {}) => createBootstrapReleasePlanControl({
      contextFile, control: missing, readState: async () => ({ revision }), ...options,
    }),
  };
}

test("explicit bootstrap reads fresh canonical MCP plans over local HTTP for every old Desktop plan call", async (t) => {
  const f = await fixture(t);
  const control = f.bridge();
  assert.deepEqual(await control("read-workspace-release-plan", { workspaceId }), livePlan(1));
  assert.deepEqual(await control("read-workspace-release-plan", { workspaceId }), livePlan(2));
  for (const call of f.calls) {
    assert.equal(call.path, "/mcp/test-capability");
    assert.equal(call.envelope.method, "tools/call");
    assert.deepEqual(call.envelope.params, {
      name: "hub_release_plan_get", arguments: { context_token: "private-context-token", workspace_id: workspaceId },
    });
  }
  assert.equal(parseChangedArguments(["--bootstrap-mcp-context", "local.json"]).bootstrapMcpContext, "local.json");
  assert.throws(() => parseChangedArguments(["--bootstrap-mcp-context", "--resume"]), /Неизвестный аргумент/u);
});

test("the flag never falls back for mutations, different errors, or a working replacement Desktop", async (t) => {
  const f = await fixture(t);
  const exact = new Error("Task release plan is unavailable");
  const received = [];
  const parameters = { workspaceId }, options = { commandId: "same-command" };
  const control = f.bridge({ control: async (...args) => { received.push(args); throw exact; } });
  await assert.rejects(control("complete-workspace-release", parameters, options), (error) => error === exact);
  assert.deepEqual(received, [["complete-workspace-release", parameters, options]]);
  const other = new Error("Task release plan is unavailable: timeout");
  await assert.rejects(f.bridge({ control: () => { throw other; } })("read-workspace-release-plan", parameters), (error) => error === other);
  assert.deepEqual(await f.bridge({ control: async () => livePlan(42), read: () => { throw Error("must not read context"); } })("read-workspace-release-plan", parameters), livePlan(42));
  assert.equal(createBootstrapReleasePlanControl({ control: missing }), missing);
  assert.equal(f.calls.length, 0);
});

test("bootstrap fences config Workspace, pre/post runtime revisions, and response identity", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.bridge()("read-workspace-release-plan", { workspaceId: "wrong" }), /Workspace mismatch/u);
  await assert.rejects(f.bridge({ readState: async () => ({ revision: "b".repeat(40) }) })("read-workspace-release-plan", { workspaceId }), /runtime revision changed/u);
  assert.equal(f.calls.length, 0);
  let reads = 0;
  await assert.rejects(f.bridge({ readState: async () => ({ revision: ++reads === 1 ? revision : "b".repeat(40) }) })("read-workspace-release-plan", { workspaceId }), /runtime revision changed/u);
  f.setResponse((request, response) => response.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
    isError: false, structuredContent: { ...livePlan(), workspaceId: "foreign" },
  } })));
  await assert.rejects(f.bridge()("read-workspace-release-plan", { workspaceId }), /plan identity mismatch/u);
  f.setResponse((_request, response) => response.end(JSON.stringify({ jsonrpc: "2.0", id: "another-request", result: { isError: false, structuredContent: livePlan() } })));
  await assert.rejects(f.bridge()("read-workspace-release-plan", { workspaceId }), /plan response failed/u);
});

test("remote endpoints, redirects and MCP errors fail closed without exposing context credentials", async (t) => {
  const f = await fixture(t);
  for (const url of [
    "https://127.0.0.1/mcp/test", "http://localhost/mcp/test", "http://127.0.0.1.evil.invalid/mcp/test",
    "http://user:secret@127.0.0.1/mcp/test", "http://127.0.0.1/mcp/test?token=secret", "http://127.0.0.1/mcp/test#fragment",
    "http://127.0.0.1/not-mcp", "http://127.1/mcp/test",
  ]) {
    await f.save({ url });
    await assert.rejects(f.bridge()("read-workspace-release-plan", { workspaceId }), /Invalid bootstrap MCP/u);
  }
  assert.equal(f.calls.length, 0);
  await f.save();
  f.setResponse((_request, response) => {
    response.writeHead(302, { location: f.configuration.url }); response.end();
  });
  await assert.rejects(f.bridge()("read-workspace-release-plan", { workspaceId }), /plan request failed/u);
  assert.equal(f.calls.length, 1);
  f.setResponse((request, response) => response.end(JSON.stringify({ jsonrpc: "2.0", id: request.id,
    result: { isError: true, content: [{ type: "text", text: `${f.configuration.context_token} ${f.configuration.url}` }] },
  })));
  await assert.rejects(f.bridge()("read-workspace-release-plan", { workspaceId }), (error) => {
    assert.equal(error.message, "Bootstrap MCP plan response failed");
    return true;
  });
});
