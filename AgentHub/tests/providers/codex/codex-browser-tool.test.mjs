import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_BROWSER_TOOL_CONTRACT,
  CodexBrowserToolMonitor,
  codexBrowserToolArgs,
} from "../../../src/providers/codex/codex-browser-tool.mjs";

function browserInventory(overrides = {}) {
  return {
    data: [{
      name: CODEX_BROWSER_TOOL_CONTRACT.server,
      pluginId: CODEX_BROWSER_TOOL_CONTRACT.pluginId,
      runtimeStatus: "connected",
      tools: Object.fromEntries(CODEX_BROWSER_TOOL_CONTRACT.tools.map((name) => [name, { name }])),
      ...overrides,
    }],
    nextCursor: null,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("Hub-owned Codex explicitly enables the official browser tool plugin", () => {
  assert.deepEqual(codexBrowserToolArgs(), [
    "-c",
    'plugins."unified-computer-use@openai-bundled".enabled=true',
  ]);
});

test("browser monitor accepts the authoritative CUA inventory with bounded background lookup", async () => {
  const calls = [];
  const monitor = new CodexBrowserToolMonitor();

  const result = await monitor.refresh(async (...args) => {
    calls.push(args);
    return browserInventory();
  });

  assert.deepEqual(calls, [[
    "mcpServerStatus/list",
    { limit: 100, detail: "toolsAndAuthOnly" },
    { timeoutMs: 10_000, priority: "background" },
  ]]);
  assert.deepEqual(result, {
    status: "ready",
    provider: "codex",
    pluginId: "unified-computer-use@openai-bundled",
    server: "cua_repl",
    runtimeStatus: "connected",
    tools: ["js", "js_reset", "turn_ended"],
  });
});

test("browser monitor fails closed for another plugin owner or incomplete tools", async () => {
  const owner = new CodexBrowserToolMonitor();
  assert.equal((await owner.refresh(async () => browserInventory({
    pluginId: "untrusted@example",
  }))).reason, "unexpected-plugin-owner");

  const tools = new CodexBrowserToolMonitor();
  assert.deepEqual((await tools.refresh(async () => browserInventory({
    tools: { js: { name: "js" } },
  }))).missingTools, ["js_reset", "turn_ended"]);
});

test("browser monitor ignores a stale inventory result after replacement", async () => {
  const first = deferred();
  const monitor = new CodexBrowserToolMonitor();
  const stale = monitor.refresh(() => first.promise);
  const current = await monitor.refresh(async () => browserInventory());
  first.resolve({ data: [], nextCursor: null });
  await stale;

  assert.equal(current.status, "ready");
  assert.equal(monitor.diagnostics().status, "ready");
  monitor.disconnected();
  assert.deepEqual(monitor.diagnostics(), {
    status: "unavailable",
    provider: "codex",
    pluginId: "unified-computer-use@openai-bundled",
    server: "cua_repl",
    reason: "app-server-disconnected",
  });
});

test("browser startup events cannot claim readiness before verified tool inventory", () => {
  const monitor = new CodexBrowserToolMonitor();
  monitor.observe({
    method: "mcpServer/startupStatus/updated",
    params: { name: "cua_repl", status: "ready" },
  });
  assert.equal(monitor.diagnostics().status, "checking");

  monitor.observe({
    method: "mcpServer/startupStatus/updated",
    params: { name: "cua_repl", status: "failed", failureReason: "startupFailed" },
  });
  assert.deepEqual(monitor.diagnostics(), {
    status: "unavailable",
    provider: "codex",
    pluginId: "unified-computer-use@openai-bundled",
    server: "cua_repl",
    reason: "startup-failed",
    failureReason: "startupFailed",
  });
});

test("verified starting inventory becomes ready only after the exact CUA startup event", async () => {
  const monitor = new CodexBrowserToolMonitor();
  const checking = await monitor.refresh(async () => browserInventory({ runtimeStatus: "starting" }));
  assert.equal(checking.status, "checking");
  assert.deepEqual(checking.tools, ["js", "js_reset", "turn_ended"]);

  monitor.observe({
    method: "mcpServer/startupStatus/updated",
    params: { name: "another_server", status: "ready" },
  });
  assert.equal(monitor.diagnostics().status, "checking");

  monitor.observe({
    method: "mcpServer/startupStatus/updated",
    params: { name: "cua_repl", status: "ready" },
  });
  assert.equal(monitor.diagnostics().status, "ready");
  assert.equal(monitor.diagnostics().runtimeStatus, "connected");
});

test("browser monitor cleans the exact fallback Thread on terminal and all sessions on replacement", async () => {
  const calls = [];
  const fallback = {
    closeForThread: async (threadId) => calls.push(["thread", threadId]),
    reset: async () => calls.push(["reset"]),
  };
  const monitor = new CodexBrowserToolMonitor({ fallback });

  monitor.observe({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await monitor.disconnected();

  assert.deepEqual(calls, [["thread", "thread-1"], ["reset"]]);
  assert.equal(monitor.diagnostics().reason, "app-server-disconnected");
});
