import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const SOURCE = await readFile(
  path.join(import.meta.dirname, "..", "..", "assets", "web-app", "web-diagnostics.js"),
  "utf8",
);

function fixture() {
  const listeners = new Map();
  const documentListeners = new Map();
  const document = {
    visibilityState: "visible",
    readyState: "interactive",
    addEventListener: (name, listener) => documentListeners.set(name, listener),
  };
  const window = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    document,
    navigator: { onLine: true },
  };
  vm.runInNewContext(SOURCE, { window, Promise });
  return { listeners, documentListeners, document, window, diagnostics: window.AgentHubWebDiagnostics };
}

test("web diagnostics preserve early global errors until the Hub bridge is ready", async () => {
  const { listeners, diagnostics } = fixture();
  listeners.get("error")({
    error: new TypeError("render failed"),
    filename: "https://hub.test/app.js?revision=private",
    lineno: 42,
    colno: 7,
  });
  const reports = [];
  diagnostics.bindReporter(async (event) => { reports.push(event); });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reports.length, 1);
  assert.deepEqual({ ...reports[0] }, {
    name: "TypeError",
    message: "render failed",
    stack: reports[0].stack,
    source: "https://hub.test/app.js?revision=private",
    line: 42,
    column: 7,
    kind: "window-error",
    breadcrumbs: reports[0].breadcrumbs,
    clientState: reports[0].clientState,
  });
  assert.deepEqual(Array.from(reports[0].breadcrumbs, ({ message }) => message), [
    "diagnostics-installed",
    "window-error",
  ]);
  assert.deepEqual({ ...reports[0].clientState }, {
    surfaceHint: "browser",
    online: true,
    visibility: "visible",
    readyState: "interactive",
  });
});

test("web diagnostics serialize unhandled promise rejections without throwing", async () => {
  const { listeners, diagnostics } = fixture();
  const reports = [];
  diagnostics.bindReporter((event) => { reports.push(event); throw new Error("offline"); });
  listeners.get("unhandledrejection")({ reason: new Error("promise failed") });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, "unhandled-rejection");
  assert.equal(reports[0].message, "promise failed");
});

test("web diagnostics attach bounded connectivity and visibility breadcrumbs", async () => {
  const { listeners, documentListeners, document, window, diagnostics } = fixture();
  const reports = [];
  diagnostics.bindReporter((event) => { reports.push(event); });
  window.navigator.onLine = false;
  listeners.get("offline")();
  document.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  diagnostics.recordBreadcrumb("hub-connection-failure");
  diagnostics.recordBreadcrumb("private-chat-text");
  diagnostics.recordBreadcrumb("hub-connection-restored");
  listeners.get("error")({ error: new Error("failed") });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(Array.from(reports[0].breadcrumbs, ({ message }) => message), [
    "diagnostics-installed",
    "reporter-bound",
    "offline",
    "visibility-hidden",
    "hub-connection-failure",
    "hub-connection-restored",
    "window-error",
  ]);
  assert.equal(reports[0].clientState.online, false);
  assert.equal(reports[0].clientState.visibility, "hidden");
});
