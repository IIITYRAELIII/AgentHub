"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const bootstrap = fs.readFileSync(path.join(__dirname, "vscode-bootstrap.js"), "utf8");
const bridge = fs.readFileSync(path.join(__dirname, "agent-hub-bridge.js"), "utf8");
const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const sharedWebview = fs.readFileSync(path.join(__dirname, "shared-webview.js"), "utf8");
const client = fs.readFileSync(path.join(__dirname, "..", "assets", "web-app", "hub-client.js"), "utf8");

test("VS Code WebView prefers loopback HTTP with IPC fallback", () => {
  assert.match(bootstrap, /agenthub:session/u);
  assert.match(bootstrap, /Authorization.*webview/u);
  assert.match(bootstrap, /fallbackFetch/u);
  assert.match(client, /directTransport\.ready\(\)/u);
  assert.match(client, /directTransport\.warmup\?\.\(\)/u);
  assert.doesNotMatch(client, /await directTransport\.available\(\)/u);
  assert.match(bootstrap, /ready:\s*\(\)\s*=>\s*Boolean\(activeDirectSession\(\)\)/u);
  assert.match(extension, /handleSessionMessage/u);
  assert.match(extension, /subscribeJournal/u);
  assert.doesNotMatch(bootstrap, /streamDirectEvents|\/events/u);
  assert.match(bridge, /createLocalWebviewSession/u);
  assert.match(sharedWebview, /connect-src http:\/\/127\.0\.0\.1:\*/u);
});

test("VS Code direct transport keeps permanent local credentials outside the WebView", () => {
  assert.doesNotMatch(bootstrap, /local-web\.secret/u);
  assert.match(bridge, /local-web\.secret/u);
  assert.match(bootstrap, /SESSION_REFRESH_MARGIN_MS/u);
});

test("VS Code HTTP and IPC hedges share clientUserMessageId while keeping correlation ids", async () => {
  const posted = [];
  const fetched = [];
  const listeners = new Map();
  const vscode = { postMessage: (message) => posted.push(message) };
  const window = {
    acquireVsCodeApi: () => vscode,
    addEventListener: (name, listener) => listeners.set(name, listener),
    clearTimeout,
    fetch: async (url, options) => {
      fetched.push({ url: String(url), options });
      const request = JSON.parse(String(options.body ?? "{}"));
      return new Response(JSON.stringify(
        String(url).endsWith("/api/control/ack")
          ? { ok: true, retired: true }
          : { ok: true, receiptId: request.commandId, result: { accepted: true } },
      ), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    location: { href: "vscode-webview://agent-hub/index.html" },
    requestAnimationFrame: () => 1,
    setTimeout,
  };
  const document = {
    addEventListener: () => {},
    body: {},
    getAnimations: () => [],
    hidden: false,
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  vm.runInNewContext(bootstrap, {
    AbortSignal,
    console,
    document,
    Headers,
    MutationObserver,
    Proxy,
    Reflect,
    Response,
    URL,
    window,
  });
  const sessionRequest = posted.find((message) => message.type === "agenthub:session");
  listeners.get("message")({
    data: {
      type: "agenthub:session-result",
      id: sessionRequest.id,
      ok: true,
      result: {
        baseUrl: "http://127.0.0.1:8787",
        token: "session-token",
        expiresAt: Date.now() + 60_000,
      },
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  const response = await window.fetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "send-message",
      commandId: "outer-http-command",
      params: { clientUserMessageId: "client-message-1", text: "hello" },
    }),
  });
  assert.equal(JSON.parse(fetched[0].options.body).commandId, "client-message-1");
  assert.equal((await response.json()).receiptId, "outer-http-command");

  window.__agentHubVscode.postMessage({
    type: "agenthub:control",
    id: "outer-ipc-correlation",
    action: "send-message",
    params: { clientUserMessageId: "client-message-1", text: "hello" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), {
    type: "agenthub:control",
    id: "outer-ipc-correlation",
    action: "send-message",
    commandId: "client-message-1",
    params: { clientUserMessageId: "client-message-1", text: "hello" },
  });

  await window.fetch("/api/control/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandId: "outer-http-command" }),
  });
  assert.equal(JSON.parse(fetched[1].options.body).commandId, "client-message-1");
});
