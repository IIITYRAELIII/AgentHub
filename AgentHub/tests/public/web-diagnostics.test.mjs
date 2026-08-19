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
  const window = {
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  vm.runInNewContext(SOURCE, { window, Promise });
  return { listeners, diagnostics: window.AgentHubWebDiagnostics };
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
