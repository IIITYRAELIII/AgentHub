import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { createDesktopControlRouter } from "../../../src/interfaces/desktop/desktop-control-router.mjs";
import { createLocalWebviewSession } from "../../../src/interfaces/web/local-webview-session.mjs";
import { MiniAppServer } from "../../../src/interfaces/web/mini-app-server.mjs";

const BOOTSTRAP = new URL("../../../VSCodeExtension/vscode-bootstrap.js", import.meta.url);

// Runs the real VS Code webview bootstrap with the real fetch as its native
// transport, so /api/control leaves through the same direct webview session the
// local VS Code panel uses.
async function loadWebviewTransport(session) {
  const source = await readFile(BOOTSTRAP, "utf8");
  const listeners = new Map();
  const messages = [];
  const window = {
    location: { href: "https://agent-hub.vscode-webview.test/" },
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    fetch: (...args) => fetch(...args),
    addEventListener: (type, listener) => listeners.set(type, listener),
    requestAnimationFrame: () => 0,
    clearTimeout,
    setTimeout,
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  vm.runInNewContext(source, {
    AbortController, Headers, MutationObserver, Response, URL, clearTimeout, setTimeout, window,
    document: { body: {}, hidden: false, addEventListener() {}, getAnimations: () => [] },
  });
  const available = window.__agentHubDirectTransport.available();
  const request = messages.find((message) => message.type === "agenthub:session");
  listeners.get("message")({ data: { type: "agenthub:session-result", id: request.id, ok: true, result: session } });
  assert.equal(await available, true, "the webview direct transport is ready");
  return window;
}

async function signInThroughWebview(privilegedSources) {
  const secret = "v".repeat(43);
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-webview-control-"));
  const handled = [];
  const sources = [];
  const router = createDesktopControlRouter({
    handlers: {
      "start-provider-login": async (params) => { handled.push(["start", params.provider]); return { accepted: true }; },
      "cancel-provider-login": async (params) => { handled.push(["cancel", params.provider]); return { accepted: true }; },
    },
    mutationActions: [],
    localOnlyActions: ["start-provider-login", "cancel-provider-login"],
    ...(privilegedSources ? { privilegedSources } : {}),
  });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabaseFile: path.join(directory, "journal.sqlite"),
    localAccessSecret: secret,
    controlHandler: (request) => {
      sources.push(request.context?.source);
      return router.handleDesktopControl(request);
    },
  });
  try {
    const address = await server.start();
    const window = await loadWebviewTransport({
      baseUrl: address.url.replace(/\/$/u, ""),
      ...createLocalWebviewSession(secret),
    });
    const results = [];
    for (const action of ["start-provider-login", "cancel-provider-login"]) {
      const response = await window.fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, params: { provider: "claude" } }),
      });
      results.push({ action, status: response.status, body: await response.json() });
    }
    return { results, handled, sources };
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("baseline: the local VS Code webview transport was refused for local-only sign-in", async () => {
  const { results, handled, sources } = await signInThroughWebview(["desktop-control", "local-mini-app"]);
  assert.deepEqual(sources, ["local-vscode-webview", "local-vscode-webview"]);
  assert.deepEqual(results.map(({ status }) => status), [400, 400]);
  assert.match(results[0].body.error, /только локальному Agent Hub/u);
  assert.deepEqual(handled, []);
});

test("the local VS Code webview transport starts and cancels provider sign-in", async () => {
  const { results, handled, sources } = await signInThroughWebview();
  assert.deepEqual(sources, ["local-vscode-webview", "local-vscode-webview"], "the source comes from the webview session");
  assert.deepEqual(results.map(({ status, body }) => [status, body.ok]), [[200, true], [200, true]]);
  assert.deepEqual(handled, [["start", "claude"], ["cancel", "claude"]]);
});
