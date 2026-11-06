import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubClient, HubReplyUnknown, executeRelease } from "../src/hub-client.mjs";

async function server(t, dispatch) {
  const calls = [];
  const http = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw); calls.push(message.params);
    const value = await dispatch(message.params, req, res);
    if (res.destroyed) return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
      structuredContent: value, content: [], isError: false,
    } }));
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return { calls, client: new HubClient({ url: `http://127.0.0.1:${http.address().port}/mcp/test`, contextToken: "caller-fixture" }) };
}

test("one mutation and read-only original polling preserve CAS and acknowledgement ordering", async t => {
  const events = [], original = { task_id: "task", request_id: "same-original", status: "awaiting_implementation",
    expected_task_revision: 12, expected_workflow_status: "testing" };
  const f = await server(t, ({ name, arguments: args }) => {
    assert.equal(args.context_token, "caller-fixture"); events.push(name);
    if (name === "hub_task_status_update") {
      assert.deepEqual(args, { ...original, context_token: "caller-fixture" });
      return { taskOperation: { requestId: original.request_id, active: true, terminal: false, status: "pending" } };
    }
    assert.equal(name, "hub_task_operation_get");
    assert.equal(args.operation_request_id, original.request_id);
    assert.deepEqual(args.original_arguments, original);
    return { taskOperation: { requestId: original.request_id, active: false, terminal: true, status: "succeeded" }, result: { id: "task" } };
  });
  const result = await executeRelease(f.client, "accept", original, {
    sleep: async () => {}, onAccepted: () => events.push("acknowledged"),
  });
  assert.equal(result.taskOperation.status, "succeeded");
  assert.deepEqual(events, ["hub_task_status_update", "acknowledged", "hub_task_operation_get"]);
});

test("lost HTTP acknowledgement reads the same original and preserves unknown without replay", async t => {
  const original = { task_id: "task", request_id: "lost-ack", status: "awaiting_implementation" };
  const f = await server(t, ({ name, arguments: args }, req, res) => {
    if (name === "hub_task_status_update") { res.destroy(); return null; }
    assert.equal(name, "hub_task_operation_get"); assert.equal(args.operation_request_id, "lost-ack");
    return { taskOperation: { status: "unknown", active: false, terminal: false, requestId: "lost-ack" } };
  });
  await assert.rejects(executeRelease(f.client, "accept", original), error => {
    assert.ok(error instanceof HubReplyUnknown);
    assert.equal(error.originalReceipt.taskOperation.status, "unknown"); return true;
  });
  assert.deepEqual(f.calls.map(x => x.name), ["hub_task_status_update", "hub_task_operation_get"]);
});

test("lost stdout joins addressed readback, then retains the original delivery failure", async t => {
  const f = await server(t, ({ name }) => ({ taskOperation: { requestId: "stdout", status: name === "hub_task_status_update" ? "pending" : "succeeded",
    active: name === "hub_task_status_update", terminal: name !== "hub_task_status_update" } }));
  const delivery = new Error("closed output");
  await assert.rejects(executeRelease(f.client, "accept", { request_id: "stdout", task_id: "task", status: "awaiting_implementation" }, {
    onAccepted: () => { throw delivery; }, sleep: async () => {},
  }), error => error === delivery && error.originalReceipt.taskOperation.status === "succeeded");
  assert.equal(f.calls.filter(x => x.name === "hub_task_status_update").length, 1);
});

test("lost reply waits for its admitted live original using reads only", async t => {
  let reads = 0;
  const original = { task_id: "task", request_id: "lost-live", status: "awaiting_implementation" };
  const f = await server(t, ({ name }, _req, res) => {
    if (name === "hub_task_status_update") { res.destroy(); return null; }
    reads++;
    return { taskOperation: { requestId: original.request_id, status: reads === 1 ? "pending" : "succeeded",
      active: reads === 1, terminal: reads !== 1 } };
  });
  await assert.rejects(executeRelease(f.client, "accept", original, { sleep: async () => {} }), error =>
    error instanceof HubReplyUnknown && error.originalReceipt.taskOperation.status === "succeeded");
  assert.equal(reads, 2); assert.equal(f.calls.filter(row => row.name === "hub_task_status_update").length, 1);
});

test("lost release admission resolves the original request without replacing its unknown command", async t => {
  const original = { request_id: "lost-release", validation_mode: "full", approved_targets: [] };
  const f = await server(t, ({ name, arguments: args }, _req, res) => {
    if (name === "hub_release_run") { res.destroy(); return null; }
    assert.equal(name, "hub_release_get"); assert.equal(args.operation_request_id, original.request_id);
    assert.deepEqual(args.original_arguments, original);
    return { operation: { operationId: "original-release", state: "waiting" },
      originalCommand: { requestId: original.request_id, status: "unknown" } };
  });
  await assert.rejects(executeRelease(f.client, "run", original), error => {
    assert.equal(error.originalReceipt.operation.operationId, "original-release");
    assert.equal(error.originalReceipt.originalCommand.status, "unknown"); return true;
  });
  assert.deepEqual(f.calls.map(row => row.name), ["hub_release_run", "hub_release_get"]);
});

test("waiting release is a boundary, never an automatic continue or a new release", async t => {
  const f = await server(t, ({ name, arguments: args }) => {
    if (name === "hub_release_run") return { accepted: true, operationId: "release-original" };
    assert.equal(name, "hub_release_get"); assert.equal(args.operation_id, "release-original");
    return { operation: { operationId: "release-original", state: "waiting", generation: 3, candidate: "frozen" } };
  });
  const result = await executeRelease(f.client, "run", { request_id: "authorized-run" });
  assert.equal(result.operation.state, "waiting");
  assert.deepEqual(f.calls.map(x => x.name), ["hub_release_run", "hub_release_get"]);
});

test("release wait joins the addressed local owner instead of inferring completion from its state", async t => {
  let reads = 0;
  const f = await server(t, ({ name }) => {
    if (name === "hub_release_run") return { accepted: true, operationId: "locally-running" };
    reads++;
    return { operation: { operationId: "locally-running", state: "waiting" }, execution: { localActive: reads === 1 } };
  });
  const result = await executeRelease(f.client, "run", { request_id: "addressed-live-release" }, { sleep: async () => {} });
  assert.equal(reads, 2); assert.equal(result.execution.localActive, false);
  assert.equal(result.operation.state, "waiting");
  assert.equal(f.calls.filter(row => row.name === "hub_release_run").length, 1);
  assert.equal(f.calls.some(row => row.name === "hub_release_continue"), false);
});

test("credentials in business JSON and redirects refuse before leaking caller capability", async t => {
  let calls = 0;
  const client = new HubClient({ url: "http://127.0.0.1/mcp/fixture", contextToken: "secret" }, {
    fetchImpl: async (_url, options) => { calls++; assert.equal(options.redirect, "error"); throw new Error("redirect refused"); },
  });
  await assert.rejects(client.call("accept", { context_token: "wrong" }), /business arguments/);
  assert.equal(calls, 0);
  await assert.rejects(client.call("get", { operation_id: "original" }), error => !error.message.includes("secret"));
  assert.equal(calls, 1);
});

test("executable release outcomes preserve failed, waiting and done originals for run, continue and get", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-tool-cli-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "release-tool-cli-"));
    await rm(root, { recursive: true, force: true });
  });
  let state;
  const f = await server(t, ({ name, arguments: args }) => {
    if (name !== "hub_release_get") return { accepted: true, operationId: "same-original" };
    assert.equal(args.operation_id, "same-original");
    return { operation: { operationId: "same-original", state,
      lastError: state === "failed" ? { code: "BUILD_FAILED", message: "original build failure" } : null },
    execution: { localActive: false } };
  });
  const connection = path.join(root, "connection.json"), request = path.join(root, "request.json");
  await writeFile(connection, JSON.stringify({ url: f.client.url, contextToken: "caller-fixture" }));
  const outcomes = [];
  for (const action of ["run", "continue", "get"]) {
    for (state of ["failed", "waiting", "done"]) {
      const business = action === "run" ? { request_id: "original-run", validation_mode: "full" }
        : action === "continue" ? { operation_id: "same-original", request_id: "original-continuation" }
          : { operation_id: "same-original" };
      await writeFile(request, JSON.stringify(business));
      const before = f.calls.length;
      const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/release.mjs", import.meta.url)),
        action, "--connection-file", connection, "--request-file", request], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      const records = stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.at(-1).result.operation.operationId, "same-original");
      assert.equal(records.at(-1).result.operation.state, state);
      assert.deepEqual(records.at(-1).result.operation.lastError,
        state === "failed" ? { code: "BUILD_FAILED", message: "original build failure" } : null);
      assert.equal(stderr, "");
      assert.ok(!stdout.includes("caller-fixture"));
      const names = f.calls.slice(before).map(row => row.name);
      assert.deepEqual(names, action === "get" ? ["hub_release_get"] : [`hub_release_${action}`, "hub_release_get"]);
      if (action !== "get") assert.equal(records[0].accepted.operationId, "same-original");
      outcomes.push({ action, state, code });
    }
  }
  t.diagnostic(JSON.stringify(outcomes));
  for (const outcome of outcomes) {
    assert.equal(outcome.code, outcome.state === "failed" ? 1 : 0, `${outcome.action}: ${outcome.state}`);
  }
});
