"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const bootstrap = fs.readFileSync(path.join(__dirname, "vscode-bootstrap.js"), "utf8");
const bridge = fs.readFileSync(path.join(__dirname, "agent-hub-bridge.js"), "utf8");
const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
const sharedWebview = fs.readFileSync(path.join(__dirname, "shared-webview.js"), "utf8");
const client = fs.readFileSync(path.join(__dirname, "..", "assets", "web-app", "hub-client.js"), "utf8");

test("VS Code WebView prefers loopback HTTP and SSE with IPC fallback", () => {
  assert.match(bootstrap, /agenthub:session/u);
  assert.match(bootstrap, /Authorization.*webview/u);
  assert.match(bootstrap, /response\.body\.getReader\(\)/u);
  assert.match(bootstrap, /fallbackFetch/u);
  assert.match(client, /directTransport\.ready\(\)/u);
  assert.match(client, /directTransport\.warmup\?\.\(\)/u);
  assert.match(bootstrap, /ready:\s*\(\)\s*=>\s*Boolean\(activeDirectSession\(\)\)/u);
  assert.match(extension, /handleSessionMessage/u);
  assert.match(bridge, /createLocalWebviewSession/u);
  assert.match(sharedWebview, /connect-src http:\/\/127\.0\.0\.1:\*/u);
});

test("VS Code direct transport keeps permanent local credentials outside the WebView", () => {
  assert.doesNotMatch(bootstrap, /local-web\.secret/u);
  assert.match(bridge, /local-web\.secret/u);
  assert.match(bootstrap, /SESSION_REFRESH_MARGIN_MS/u);
});
