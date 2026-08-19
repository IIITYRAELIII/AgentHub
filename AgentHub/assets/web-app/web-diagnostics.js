(function installAgentHubWebDiagnostics(global) {
  "use strict";

  const MAX_PENDING_EVENTS = 20;
  const MAX_BREADCRUMBS = 20;
  const BREADCRUMB_MESSAGES = new Set([
    "diagnostics-installed", "reporter-bound", "window-error", "unhandled-rejection",
    "online", "offline", "visibility-visible", "visibility-hidden",
    "hub-connection-failure", "hub-connection-offline", "hub-connection-restored",
  ]);
  const pending = [];
  const breadcrumbs = [];
  let reporter = null;
  let reporting = false;

  function text(value, maxLength) {
    return String(value ?? "").slice(0, maxLength);
  }

  function recordBreadcrumb(message) {
    if (!BREADCRUMB_MESSAGES.has(message)) return false;
    breadcrumbs.push({ timestamp: Date.now() / 1_000, message });
    if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift();
    return true;
  }

  function surfaceHint() {
    if (global.__agentHubVscode || typeof global.acquireVsCodeApi === "function") return "vscode";
    if (global.Telegram?.WebApp) return "telegram";
    if (global.AgentHubAndroid) return "android";
    if (global.AgentHubBrowserDevice) return "device";
    return "browser";
  }

  function clientState() {
    return {
      surfaceHint: surfaceHint(),
      online: typeof global.navigator?.onLine === "boolean" ? global.navigator.onLine : undefined,
      visibility: text(global.document?.visibilityState || "", 20),
      readyState: text(global.document?.readyState || "", 20),
    };
  }

  function serialize(error, fallback = {}) {
    const value = error && typeof error === "object" ? error : {};
    return {
      name: text(value.name || fallback.name || "Error", 120),
      message: text(value.message || fallback.message || error || "Unknown browser error", 1_000),
      stack: text(value.stack || fallback.stack || "", 8_000),
      source: text(fallback.source || "", 500),
      line: Number(fallback.line) || 0,
      column: Number(fallback.column) || 0,
      kind: text(fallback.kind || "window-error", 80),
      breadcrumbs: breadcrumbs.slice(),
      clientState: clientState(),
    };
  }

  function flushPending() {
    if (typeof reporter !== "function" || reporting || pending.length === 0) return;
    const event = pending.shift();
    reporting = true;
    Promise.resolve().then(() => reporter(event)).catch(() => {}).finally(() => {
      reporting = false;
      flushPending();
    });
  }

  function deliver(event) {
    pending.push(event);
    if (pending.length > MAX_PENDING_EVENTS) pending.shift();
    flushPending();
  }

  function bindReporter(value) {
    reporter = typeof value === "function" ? value : null;
    if (reporter) recordBreadcrumb("reporter-bound");
    flushPending();
  }

  global.addEventListener("error", (event) => {
    recordBreadcrumb("window-error");
    deliver(serialize(event.error, {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      kind: "window-error",
    }));
  });
  global.addEventListener("unhandledrejection", (event) => {
    recordBreadcrumb("unhandled-rejection");
    deliver(serialize(event.reason, { kind: "unhandled-rejection" }));
  });
  global.addEventListener("online", () => recordBreadcrumb("online"));
  global.addEventListener("offline", () => recordBreadcrumb("offline"));
  global.document?.addEventListener?.("visibilitychange", () => {
    const visibility = text(global.document?.visibilityState || "hidden", 20);
    recordBreadcrumb(visibility === "visible" ? "visibility-visible" : "visibility-hidden");
  });

  recordBreadcrumb("diagnostics-installed");
  global.AgentHubWebDiagnostics = Object.freeze({
    bindReporter,
    recordBreadcrumb,
    captureException(error) {
      deliver(serialize(error, { kind: "manual" }));
    },
  });
})(window);
