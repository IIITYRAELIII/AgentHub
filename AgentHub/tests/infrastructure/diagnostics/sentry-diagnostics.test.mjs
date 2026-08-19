import assert from "node:assert/strict";
import test from "node:test";

import { createSentryDiagnostics } from "../../../src/infrastructure/diagnostics/sentry-diagnostics.mjs";

function response(status = 200, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  };
}

test("Sentry diagnostics stay inert without an enabled DSN", async () => {
  const requests = [];
  const diagnostics = createSentryDiagnostics({
    fetchImpl: async (...args) => { requests.push(args); return response(); },
    processRef: { env: {}, version: "v-test" },
  });

  assert.equal(diagnostics.captureException(new Error("ignored")), false);
  assert.equal(await diagnostics.flush(), true);
  assert.equal(requests.length, 0);
});

test("Sentry diagnostics send a redacted envelope through the local runtime", async () => {
  const requests = [];
  const diagnostics = createSentryDiagnostics({
    fetchImpl: async (...args) => { requests.push(args); return response(); },
    now: () => Date.parse("2026-08-19T12:00:00.000Z"),
    randomId: () => "018f6c86-3f34-7a31-8f27-16f5b96cce10",
    processRef: { env: {}, version: "v24.0.0" },
  });
  diagnostics.configure({
    enabled: true,
    dsn: "https://public@example.test/sentry/42",
    environment: "test",
    roots: ["D:\\Workspace"],
  });
  const error = new Error(
    "token=super-secret https://example.test/path?chat=private C:\\Users\\Example\\Desktop",
  );
  error.stack = [
    `Error: ${error.message}`,
    "    at run (D:\\Workspace\\AgentHub\\app.mjs:12:4)",
  ].join("\n");

  assert.equal(diagnostics.captureException(error, { surface: "server", component: "runtime" }), true);
  assert.equal(diagnostics.captureException(error, { surface: "server", component: "bootstrap" }), false);
  assert.equal(await diagnostics.flush(), true);
  assert.equal(requests.length, 1);
  const [url, init] = requests[0];
  assert.match(url, /^https:\/\/example\.test\/sentry\/api\/42\/envelope\//u);
  assert.equal(init.headers["Content-Type"], "application/x-sentry-envelope");
  assert.doesNotMatch(init.body, /super-secret|Example|chat=private|D:\\Workspace/u);
  const event = JSON.parse(init.body.split("\n")[2]);
  assert.equal(event.environment, "test");
  assert.equal(event.tags.surface, "server");
  assert.equal(event.tags.reason, "unclassified");
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "<project>\\AgentHub\\app.mjs");
});

test("Sentry diagnostics accept only bounded client error fields", async () => {
  const requests = [];
  const diagnostics = createSentryDiagnostics({
    fetchImpl: async (...args) => { requests.push(args); return response(); },
    processRef: { env: {}, version: "v-test" },
  });
  diagnostics.configure({
    enabled: true,
    dsn: "https://public@example.test/42",
    maxEventsPerMinute: 1,
  });

  assert.deepEqual(diagnostics.captureClientEvent({
    name: "TypeError",
    message: "render failed",
    stack: "TypeError: render failed\n    at render (https://hub.test/assets/app.js?token=private:42:7)",
    clientState: { surfaceHint: "vscode", online: false, visibility: "hidden", readyState: "complete" },
    breadcrumbs: [
      { timestamp: 1_787_175_600, message: "diagnostics-installed" },
      { timestamp: 1_787_175_601, message: "window-error" },
      { timestamp: 1_787_175_602, message: "private chat text" },
    ],
    prompt: "private chat text",
    messages: ["private history"],
  }, { source: "vscode", userId: "must-not-leak" }), { accepted: true });
  assert.deepEqual(diagnostics.captureClientEvent({ message: "second" }), { accepted: false });
  await diagnostics.flush();
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0][1].body, /private chat text|private history|must-not-leak/u);
  assert.doesNotMatch(requests[0][1].body, /render failed/u);
  const event = JSON.parse(requests[0][1].body.split("\n")[2]);
  assert.equal(event.exception.values[0].value, "Agent Hub captured window-error: unclassified");
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "<url>/app.js");
  assert.equal(event.tags.surface, "vscode");
  assert.equal(event.contexts.agent_hub.surface_hint, "vscode");
  assert.equal(event.contexts.agent_hub.online, false);
  assert.deepEqual(event.breadcrumbs.map(({ message }) => message), ["diagnostics-installed", "window-error"]);
});

test("Sentry diagnostics report only explicitly unexpected control failures", async () => {
  const requests = [];
  const diagnostics = createSentryDiagnostics({
    fetchImpl: async (...args) => { requests.push(args); return response(); },
    processRef: { env: {}, version: "v-test" },
  });
  diagnostics.configure({ enabled: true, dsn: "https://public@example.test/42" });

  assert.equal(diagnostics.captureUnexpectedException(new Error("ordinary rejection")), false);
  const expectedSyntaxError = new SyntaxError("invalid client json");
  expectedSyntaxError.diagnosticExpected = true;
  assert.equal(diagnostics.captureUnexpectedException(expectedSyntaxError), false);
  assert.equal(diagnostics.captureUnexpectedException(new TypeError("broken invariant"), {
    surface: "web", kind: "control", component: "mini-app-server", action: "control",
  }), true);
  await diagnostics.flush();
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0][1].body, /ordinary rejection|broken invariant/u);
});

test("Sentry diagnostics identify local client events without leaking messages", async () => {
  const requests = [];
  const diagnostics = createSentryDiagnostics({
    fetchImpl: async (...args) => { requests.push(args); return response(); },
    processRef: { env: {}, version: "v-test" },
  });
  diagnostics.configure({ enabled: true, dsn: "https://public@example.test/42" });

  assert.deepEqual(diagnostics.captureClientEvent({
    kind: "manual",
    name: "InvalidOperationException",
    message: "private local message",
    action: "local-domain",
    stack: "InvalidOperationException\n   at LocalClient.Main() in D:\\Workspace\\Program.cs:line 42",
  }, { source: "desktop-control" }), { accepted: true });
  await diagnostics.flush();
  const event = JSON.parse(requests[0][1].body.split("\n")[2]);
  assert.equal(event.tags.component, "local-client");
  assert.equal(event.tags.action, "local-domain");
  assert.equal(event.tags.reason, "unclassified");
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "<external>");
  assert.doesNotMatch(requests[0][1].body, /private local message/u);
});

test("Sentry diagnostics classify error causes without sending raw messages", async () => {
  const requests = [];
  const diagnostics = createSentryDiagnostics({
    fetchImpl: async (...args) => { requests.push(args); return response(); },
    processRef: { env: {}, version: "v-test" },
  });
  diagnostics.configure({ enabled: true, dsn: "https://public@example.test/42" });

  diagnostics.captureClientEvent({
    name: "Error",
    message: "unknown Phosphor icon: private-icon-name",
    source: "https://hub.test/stream-tabs-controller.js?secret=value",
    line: 85,
    column: 26,
  }, { source: "local-vscode-webview" });
  await diagnostics.flush();

  const event = JSON.parse(requests[0][1].body.split("\n")[2]);
  assert.equal(event.tags.reason, "unknown-icon");
  assert.equal(event.exception.values[0].value, "Agent Hub captured window-error: unknown-icon");
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "<url>/stream-tabs-controller.js");
  assert.doesNotMatch(requests[0][1].body, /private-icon-name|secret=value/u);
});
