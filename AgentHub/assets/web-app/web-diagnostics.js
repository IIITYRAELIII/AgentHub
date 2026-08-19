(function installAgentHubWebDiagnostics(global) {
  "use strict";

  const MAX_PENDING_EVENTS = 20;
  const pending = [];
  let reporter = null;
  let reporting = false;

  function text(value, maxLength) {
    return String(value ?? "").slice(0, maxLength);
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
    flushPending();
  }

  global.addEventListener("error", (event) => {
    deliver(serialize(event.error, {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      kind: "window-error",
    }));
  });
  global.addEventListener("unhandledrejection", (event) => {
    deliver(serialize(event.reason, { kind: "unhandled-rejection" }));
  });

  global.AgentHubWebDiagnostics = Object.freeze({ bindReporter, captureException: deliver });
})(window);
