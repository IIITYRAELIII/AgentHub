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
  const vscode = {};
  Object.defineProperty(vscode, "postMessage", {
    configurable: false,
    enumerable: true,
    value: (message) => posted.push(message),
    writable: false,
  });
  Object.preventExtensions(vscode);
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

  window.__agentHubVscode.postMessage({
    type: "agenthub:control",
    id: "copy-text-correlation",
    action: "copy-text",
    params: { text: "copy me" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), {
    type: "agenthub:control",
    id: "copy-text-correlation",
    action: "copy-text",
    params: { text: "copy me" },
  });

  await window.fetch("/api/control/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandId: "outer-http-command" }),
  });
  assert.equal(JSON.parse(fetched[1].options.body).commandId, "client-message-1");
});

test("VS Code chunk upload preserves raw Blob and cancellation through authenticated loopback HTTP", async () => {
  const posted = [];
  const fetched = [];
  const listeners = new Map();
  const window = {
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
    addEventListener: (name, listener) => listeners.set(name, listener),
    clearTimeout, setTimeout,
    fetch: async (url, options) => { fetched.push({ url, options }); return new Response("{}"); },
    location: { href: "vscode-webview://agent-hub/index.html" },
    requestAnimationFrame: () => 1,
  };
  vm.runInNewContext(bootstrap, {
    AbortSignal, console, Headers, Proxy, Reflect, Response, URL, window,
    document: { addEventListener() {}, body: {}, getAnimations: () => [], hidden: false },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const session = posted.find((message) => message.type === "agenthub:session");
  listeners.get("message")({ data: {
    type: "agenthub:session-result", id: session.id, ok: true,
    result: { baseUrl: "http://127.0.0.1:8787", token: "fixture-session", expiresAt: Date.now() + 60_000 },
  } });
  assert.equal(await window.__agentHubDirectTransport.available(), true);
  const body = new Blob([new Uint8Array(1024 * 1024)]);
  const controller = new AbortController();
  await window.fetch("/api/attachment-upload?id=stable-id&index=0", {
    method: "PUT", body, signal: controller.signal,
    headers: { "X-Agent-Hub-Chunk-Sha256": "a".repeat(64) },
  });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "http://127.0.0.1:8787/api/attachment-upload?id=stable-id&index=0");
  assert.equal(fetched[0].options.body, body);
  assert.equal(fetched[0].options.signal, controller.signal);
  assert.equal(new Headers(fetched[0].options.headers).get("Authorization"), "webview fixture-session");
  assert.equal(new Headers(fetched[0].options.headers).get("X-Agent-Hub-Chunk-Sha256"), "a".repeat(64));
  controller.abort();
  assert.equal(fetched[0].options.signal.aborted, true);
  assert.equal(posted.some((message) => message.action === "upload-attachment"), false);
});

function bootstrapHarness(fetchImpl) {
  const posted = [];
  const listeners = new Map();
  const vscode = { postMessage: (message) => posted.push(message) };
  const window = {
    acquireVsCodeApi: () => vscode,
    addEventListener: (name, listener) => listeners.set(name, listener),
    clearTimeout,
    fetch: fetchImpl,
    location: { href: "vscode-webview://agent-hub/index.html" },
    requestAnimationFrame: () => 1,
    setTimeout,
  };
  const document = { addEventListener: () => {}, body: {}, getAnimations: () => [], hidden: false };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  vm.runInNewContext(bootstrap, {
    AbortSignal, console, document, Headers, MutationObserver, Proxy, Reflect, Response, URL, window,
  });
  const sessionRequests = () => posted.filter((message) => message.type === "agenthub:session");
  const answerSession = async (token) => {
    const request = sessionRequests().at(-1);
    listeners.get("message")({
      data: {
        type: "agenthub:session-result",
        id: request.id,
        ok: true,
        result: { baseUrl: "http://127.0.0.1:8787", token, expiresAt: Date.now() + 60_000 },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
  };
  return { window, posted, listeners, sessionRequests, answerSession };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true);
}

test("VS Code direct transport survives a transient loopback loss without a new session or IPC fallback", async () => {
  let online = true;
  const authorizations = [];
  const harness = bootstrapHarness(async (url, options = {}) => {
    authorizations.push(new Headers(options.headers).get("Authorization"));
    if (!online) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ ok: true, ready: true, status: "ready" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await harness.answerSession("session-a");

  assert.equal((await harness.window.fetch("/health")).status, 200);
  online = false;
  await assert.rejects(harness.window.fetch("/health"), /fetch failed/u);
  online = true;
  const recovered = await harness.window.fetch("/health");

  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).ready, true);
  assert.equal(harness.sessionRequests().length, 1, "a transport loss does not mint a new session");
  assert.deepEqual(authorizations, ["webview session-a", "webview session-a", "webview session-a"]);
  assert.equal(harness.posted.some((message) => message.action === "runtime-health"), false);
  assert.equal(harness.posted.some((message) => message.action === "restart-server"), false);
});

test("VS Code direct transport re-authenticates once when a replacement runtime rejects the session", async () => {
  const authorizations = [];
  const harness = bootstrapHarness(async (url, options = {}) => {
    const authorization = new Headers(options.headers).get("Authorization");
    authorizations.push(authorization);
    return authorization === "webview session-b"
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  });
  await harness.answerSession("session-a");

  const pending = harness.window.fetch("/api/snapshot");
  await waitFor(() => harness.sessionRequests().length === 2);
  await harness.answerSession("session-b");
  const response = await pending;

  assert.equal(response.status, 200);
  assert.deepEqual(authorizations, ["webview session-a", "webview session-b"]);
});

test("VS Code health falls back to IPC while no direct session is available", async () => {
  const harness = bootstrapHarness(async () => {
    throw new Error("direct transport must not be used without a session");
  });

  const pending = harness.window.fetch("/health");
  await waitFor(() => harness.posted.some((message) => message.action === "runtime-health"));
  const request = harness.posted.find((message) => message.action === "runtime-health");
  harness.listeners.get("message")({
    data: { type: "agenthub:control-result", id: request.id, ok: true, result: { ready: true, status: "ready" } },
  });
  const response = await pending;

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
});
