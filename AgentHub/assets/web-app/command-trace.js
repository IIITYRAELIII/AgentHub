(function installCommandTrace(global) {
  "use strict";

  const MAX_PENDING = 256;
  const BATCH_SIZE = 32;
  const UPLOAD_TRACE_KEY = "agent-hub-upload-trace-v1";
  const UPLOAD_TRACE_TTL_MS = 24 * 60 * 60 * 1_000;
  const pending = [];
  const retainedUploadEvents = new Map();
  const objectIds = new WeakMap();
  const recentInteractions = [];
  const views = new Set(["chat", "dashboard", "journal", "statistics", "background", "server", "tasks"]);
  const intentGroups = new Set(["approval", "attachment", "bug-report", "clipboard", "comparison", "connection",
    "context", "devices", "history", "hub", "limits", "message-pin", "message-pins", "message", "queue",
    "selection", "server", "status", "stream", "task", "usage", "workspace-search", "workspace"]);
  const targets = [
    ["[data-composer]", "composer"], ["[data-view-button]", "navigation"],
    ["[data-mobile-button]", "navigation"], ["[data-stream-task-id]", "stream"],
    ["[data-task-card-modal]", "task-card"], ["[data-task-board]", "task-board"],
    ["[data-queue]", "queue"], ["[data-journal-view]", "journal"], ["[data-server-view]", "server"],
    ["[data-statistics-view]", "statistics"],
  ];
  let reporter = null;
  let timer = null;
  let flushing = false;
  let droppedCount = 0;
  let reportedCount = 0;
  let failedBatches = 0;
  let activeId = "";
  let retryDelayMs = 1_000;
  const pendingPaints = new Set();
  const now = () => global.performance.now();
  const newId = () => typeof global.crypto.randomUUID === "function" ? global.crypto.randomUUID()
    : `ui-${Array.from(global.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const surface = () => global.__agentHubVscode ? "vscode-webview"
    : global.Telegram?.WebApp?.initData ? "telegram-mini-app"
    : global.AgentHubAndroid ? "android" : "browser";
  const view = () => views.has(global.document?.documentElement?.dataset?.view)
    ? global.document.documentElement.dataset.view : "chat";

  function persistUploadEvents() {
    try {
      const current = Date.now();
      const cutoff = current - UPLOAD_TRACE_TTL_MS;
      for (const [id, event] of retainedUploadEvents) {
        if (!Number.isSafeInteger(event.observedAtMs) || event.observedAtMs < cutoff
          || event.observedAtMs > current + 60_000) retainedUploadEvents.delete(id);
      }
      global.localStorage?.setItem(UPLOAD_TRACE_KEY, JSON.stringify([...retainedUploadEvents.values()]));
    } catch { /* Diagnostics must never change the upload outcome. */ }
  }

  function pruneExpiredPending() {
    const current = Date.now();
    const cutoff = current - UPLOAD_TRACE_TTL_MS;
    let cacheChanged = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const event = pending[index];
      if (event.stage === "client-ack") continue;
      if (Number.isSafeInteger(event.observedAtMs) && event.observedAtMs >= cutoff
        && event.observedAtMs <= current + 60_000) continue;
      pending.splice(index, 1);
      if (retainedUploadEvents.delete(event.traceEventId)) cacheChanged = true;
      droppedCount += 1;
    }
    if (cacheChanged) persistUploadEvents();
  }

  try {
    const cutoff = Date.now() - UPLOAD_TRACE_TTL_MS;
    const saved = JSON.parse(global.localStorage?.getItem(UPLOAD_TRACE_KEY) || "[]");
    if (Array.isArray(saved)) for (const event of saved.slice(-MAX_PENDING)) {
      if (event?.stage === "attachment-upload" && typeof event.traceEventId === "string"
        && Number.isSafeInteger(event.observedAtMs) && event.observedAtMs >= cutoff
        && event.observedAtMs <= Date.now() + 60_000) {
        retainedUploadEvents.set(event.traceEventId, event);
        pending.push(event);
      }
    }
  } catch { /* An unavailable or damaged diagnostic cache cannot block the app. */ }
  persistUploadEvents();

  function schedule() {
    if (timer !== null || !reporter || !pending.length) return;
    timer = global.setTimeout(() => { timer = null; void flush(); }, retryDelayMs);
  }

  async function flush() {
    pruneExpiredPending();
    if (flushing || !reporter || !pending.length) return;
    flushing = true;
    const events = pending.splice(0, BATCH_SIZE);
    try {
      await reporter({ events });
      reportedCount += events.length;
      retryDelayMs = 1_000;
      for (const event of events) retainedUploadEvents.delete(event.traceEventId);
      persistUploadEvents();
    } catch {
      failedBatches += 1;
      retryDelayMs = Math.min(60_000, retryDelayMs * 2);
      const uploadEvents = events.filter((event) => event.stage === "attachment-upload");
      droppedCount += events.length - uploadEvents.length;
      pending.unshift(...uploadEvents);
      pruneExpiredPending();
      if (pending.length > MAX_PENDING) {
        const evicted = pending.splice(MAX_PENDING);
        for (const event of evicted) retainedUploadEvents.delete(event.traceEventId);
        droppedCount += evicted.length;
        persistUploadEvents();
      }
    }
    finally { flushing = false; schedule(); }
  }

  function enqueue(event) {
    pruneExpiredPending();
    if (pending.length >= MAX_PENDING) {
      if (event.stage !== "attachment-upload") { droppedCount += 1; return; }
      const evicted = pending.shift();
      retainedUploadEvents.delete(evicted.traceEventId);
      droppedCount += 1;
    }
    if (event.stage === "attachment-upload") {
      event.traceEventId = newId();
      retainedUploadEvents.set(event.traceEventId, event);
      if (retainedUploadEvents.size > MAX_PENDING) retainedUploadEvents.delete(retainedUploadEvents.keys().next().value);
      persistUploadEvents();
    }
    pending.push(event);
    schedule();
  }

  function record(stage, action, durationMs, commandId = activeId || newId(), metadata = {}, observedAtMs = Date.now()) {
    enqueue({
      commandId, stage, outcome: "succeeded", observedAtMs,
      monotonicDurationMs: Math.max(0, Number(durationMs) || 0),
      metadata: { action, surface: surface(), view: view(), ...metadata,
        droppedCount, queueDepth: pending.length },
    });
  }

  function begin(stage, action, commandId, started = now(), metadata = {}) {
    const operationSpanId = newId();
    const startedAtMs = Date.now() - Math.max(0, Math.round(now() - started));
    const common = { action, surface: surface(), view: view(), ...metadata, operationSpanId, startedAtMs };
    enqueue({ commandId, stage, outcome: "started", observedAtMs: startedAtMs,
      monotonicDurationMs: 0, metadata: { ...common, queueDepth: pending.length } });
    let finished = false;
    return (outcome, details = {}) => {
      if (finished) return;
      finished = true;
      enqueue({
        commandId, stage, outcome, observedAtMs: Date.now(),
        monotonicDurationMs: Math.max(0, now() - started),
        metadata: { ...common, ...details },
      });
    };
  }

  function measure(stage, action, operation, commandId = activeId || newId(), describeResult) {
    const previous = activeId;
    activeId = commandId;
    const finish = begin(stage, action, commandId);
    const succeeded = (value) => {
      // Classification is diagnostic only; it cannot replace the result or
      // turn a successful application operation into an exception.
      let details;
      try { details = describeResult?.(value); } catch { /* Preserve application outcome. */ }
      finish(details?.outcome ?? "succeeded", details?.metadata);
      return value;
    };
    const failed = (error) => {
      const aborted = error?.name === "AbortError";
      finish(aborted ? "cancelled" : "failed", { failureKind: aborted ? "aborted"
        : error?.name === "TimeoutError" ? "timeout" : "error" });
      throw error;
    };
    try {
      const result = operation();
      if (result && typeof result.then === "function") return result.then(
        succeeded, failed,
      );
      return succeeded(result);
    } catch (error) { return failed(error); }
    finally { activeId = previous; }
  }

  function upload(action, operation, { uploadId, uploadAttemptId, messageRequestId, chunkIndex } = {}) {
    if (typeof uploadId !== "string" || !uploadId) return operation();
    const identity = { uploadId, ...(typeof uploadAttemptId === "string" ? { uploadAttemptId } : {}),
      ...(typeof messageRequestId === "string" ? { messageRequestId } : {}),
      ...(Number.isSafeInteger(chunkIndex) && chunkIndex >= 0 ? { chunkIndex } : {}) };
    let finish;
    try { finish = begin("attachment-upload", action, uploadId, now(), identity); }
    catch { return operation(); }
    const safeFinish = (outcome, details) => {
      try { finish(outcome, details); } catch { /* Diagnostics cannot change the upload result. */ }
    };
    const succeeded = (value) => {
      const details = {};
      if (Number.isInteger(value?.status)) details.statusCode = value.status;
      try {
        const timing = value?.headers?.get?.("Server-Timing") ?? "";
        for (const part of timing.split(",")) {
          const match = part.trim().match(/^(auth|body|storage|owner);dur=([0-9]+(?:\.[0-9]+)?)$/u);
          if (match) details[`server${match[1][0].toUpperCase()}${match[1].slice(1)}Ms`] = Number(match[2]);
        }
      } catch { /* Optional server timing must not change the response. */ }
      safeFinish(value?.status >= 400 ? "failed" : "succeeded", details);
      return value;
    };
    const failed = (error) => {
      safeFinish(error?.name === "AbortError" ? "cancelled" : "failed", {
        ...(["absent", "expired", "cancelled"].includes(error?.attachmentUploadState)
          ? { uploadState: error.attachmentUploadState } : {}),
        failureKind: error?.name === "AbortError" ? "aborted"
          : error?.name === "TimeoutError" ? "timeout" : "error",
      });
      throw error;
    };
    try {
      const result = operation();
      return result && typeof result.then === "function" ? result.then(succeeded, failed) : succeeded(result);
    } catch (error) { return failed(error); }
  }

  function afterPaint(stage, action, started, commandId, metadata = {}) {
    // A hidden WebView cannot paint. Never leave per-event frame callbacks
    // accumulating while it is suspended; the immediate stage remains recorded.
    if (pendingPaints.size >= BATCH_SIZE) { droppedCount += 1; return; }
    const finish = begin(stage, action, commandId, started, metadata);
    if (global.document?.hidden) { finish("cancelled", { failureKind: "hidden" }); return; }
    const entry = { frame: null, finish };
    pendingPaints.add(entry);
    entry.frame = global.requestAnimationFrame(() => {
      if (!pendingPaints.has(entry)) return;
      entry.frame = global.requestAnimationFrame(() => {
        if (!pendingPaints.delete(entry)) return;
        finish("succeeded");
      });
    });
  }

  function interaction(event) {
    const target = event.target?.closest?.("button, a, summary, select, input, form, [role='button']");
    if (!target || (event.type === "change" && !target.matches("select, input[type='checkbox'], input[type='radio']"))) return;
    const action = targets.find(([selector]) => target.closest(selector))?.[1] || "control";
    const commandId = newId();
    const started = now();
    recentInteractions.push({ commandId, started });
    if (recentInteractions.length > BATCH_SIZE) recentInteractions.shift();
    record("ui-interaction", action, 0, commandId, { trigger: event.type });
    // Only the synchronous event dispatch shares this identity. An unrelated
    // later event must never be attributed to an earlier user action.
    activeId = commandId;
    global.queueMicrotask(() => { if (activeId === commandId) activeId = ""; });
    afterPaint("ui-render", action, started, commandId, { trigger: "next-paint" });
  }

  for (const name of ["click", "change", "submit"]) {
    global.document?.addEventListener(name, interaction, { capture: true, passive: true });
  }
  if (global.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
    try {
      const observer = new global.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const ended = entry.startTime + entry.duration;
          const interaction = recentInteractions.findLast((item) => item.started >= entry.startTime && item.started <= ended);
          record("ui-long-task", "main-thread", entry.duration, interaction?.commandId, {},
            Math.round(global.performance.timeOrigin + ended));
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch { /* Unsupported WebViews retain interaction and render timings. */ }
  }
  global.document?.addEventListener("visibilitychange", () => {
    if (global.document.hidden) {
      for (const entry of pendingPaints.values()) {
        global.cancelAnimationFrame?.(entry.frame);
        entry.finish("cancelled", { failureKind: "hidden" });
      }
      pendingPaints.clear();
      void flush();
    }
  });
  global.addEventListener?.("pagehide", () => { void flush(); });

  global.AgentHubCommandTrace = Object.freeze({
    record, measure, upload, afterPaint, now, newId, surface,
    http(action, operation, commandId) {
      return measure("ui-control", action, operation, commandId, (response) => ({
        outcome: response.status >= 400 ? "failed" : "succeeded",
        metadata: { statusCode: response.status },
      }));
    },
    currentId: () => activeId,
    intent(type, detail, operation) {
      const group = String(type).split(":")[0];
      return measure("ui-interaction", intentGroups.has(group) ? `${group}-intent` : "intent", operation,
        type === "message:send" ? detail.requestId : undefined);
    },
    objectId: (object) => object && typeof object === "object" ? objectIds.get(object) : undefined,
    associate(object, commandId) {
      if (object && typeof object === "object") objectIds.set(object, commandId);
      if (object?.snapshot && typeof object.snapshot === "object") objectIds.set(object.snapshot, commandId);
      return object;
    },
    ack(commandId, timing, outcome) {
      enqueue({ commandId, stage: "client-ack", outcome, surface: surface(), timing: {
        ...timing, clientAckAtMs: Date.now(), clientAckMonotonicMs: now(),
      } });
    },
    bindReporter(value) { reporter = value; schedule(); },
    flush,
    diagnostics: () => ({ pending: pending.length, retainedUpload: retainedUploadEvents.size,
      paintPending: pendingPaints.size,
      flushing, droppedCount, reportedCount, failedBatches }),
  });
})(window);
