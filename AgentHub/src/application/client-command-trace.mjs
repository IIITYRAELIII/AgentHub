const TRACE_TOKEN_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/u;
const MAX_CLIENT_TRACE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLIENT_CLOCK_LEAD_MS = 60_000;

function timestamp(value, referenceAtMs) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) return null;
  if (normalized > referenceAtMs + MAX_CLIENT_CLOCK_LEAD_MS) return null;
  if (normalized < referenceAtMs - MAX_CLIENT_TRACE_AGE_MS) return null;
  return normalized;
}

function monotonic(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function duration(start, end) {
  return start == null || end == null || end < start ? 0 : end - start;
}

function transportToken(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return TRACE_TOKEN_PATTERN.test(normalized) ? normalized : fallback;
}

function timingValues(rawTiming, referenceAtMs) {
  const timing = rawTiming && typeof rawTiming === "object" && !Array.isArray(rawTiming)
    ? rawTiming
    : {};
  return {
    submittedAtMs: timestamp(timing.submittedAtMs, referenceAtMs),
    controlStartedAtMs: timestamp(timing.controlStartedAtMs, referenceAtMs),
    transportStartedAtMs: timestamp(timing.transportStartedAtMs, referenceAtMs),
    submittedMonotonicMs: monotonic(timing.submittedMonotonicMs),
    controlStartedMonotonicMs: monotonic(timing.controlStartedMonotonicMs),
    transportStartedMonotonicMs: monotonic(timing.transportStartedMonotonicMs),
    transport: transportToken(timing.transport, null),
    surface: transportToken(timing.surface, "client"),
  };
}

export function clientCommandBoundaryTraceSpans({
  commandId,
  timing,
  receivedAtMs = Date.now(),
  transport = "desktop-control",
} = {}) {
  const rootId = String(commandId ?? "").trim();
  if (!rootId) return [];
  const received = Number.isSafeInteger(Number(receivedAtMs)) ? Number(receivedAtMs) : Date.now();
  const values = timingValues(timing, received);
  const traceTransport = transportToken(values.transport, transportToken(transport, "desktop-control"));
  const spans = [];
  if (values.submittedAtMs != null) {
    spans.push({
      commandId: rootId,
      stage: "client-submit",
      outcome: "started",
      transport: traceTransport,
      observedAtMs: values.submittedAtMs,
      monotonicDurationMs: 0,
      metadata: { surface: values.surface },
    });
  }
  if (values.transportStartedAtMs != null) {
    spans.push({
      commandId: rootId,
      stage: "transport-start",
      outcome: "started",
      transport: traceTransport,
      observedAtMs: values.transportStartedAtMs,
      monotonicDurationMs: duration(
        values.controlStartedMonotonicMs,
        values.transportStartedMonotonicMs,
      ),
      metadata: {
        surface: values.surface,
        submitToControlMs: duration(
          values.submittedMonotonicMs,
          values.controlStartedMonotonicMs,
        ),
      },
    });
  }
  spans.push({
    commandId: rootId,
    stage: "hub-receive",
    outcome: "succeeded",
    transport: traceTransport,
    observedAtMs: received,
    monotonicDurationMs: 0,
    metadata: {
      surface: values.surface,
      clientToHubMs: values.submittedAtMs == null ? null : Math.max(0, received - values.submittedAtMs),
      controlToHubMs: values.controlStartedAtMs == null
        ? null
        : Math.max(0, received - values.controlStartedAtMs),
      transportToHubMs: values.transportStartedAtMs == null
        ? null
        : Math.max(0, received - values.transportStartedAtMs),
    },
  });
  return spans;
}

export function clientCommandAckTraceSpan({
  commandId,
  timing,
  reportedAtMs = Date.now(),
  outcome = "succeeded",
  transport = "client",
} = {}) {
  const rootId = String(commandId ?? "").trim();
  if (!rootId) return null;
  const reported = Number.isSafeInteger(Number(reportedAtMs)) ? Number(reportedAtMs) : Date.now();
  const values = timingValues(timing, reported);
  const clientAckAtMs = timestamp(timing?.clientAckAtMs, reported) ?? reported;
  const clientAckMonotonicMs = monotonic(timing?.clientAckMonotonicMs);
  return {
    commandId: rootId,
    stage: "client-ack",
    outcome: outcome === "failed" ? "failed" : "succeeded",
    transport: transportToken(transport, values.surface),
    observedAtMs: clientAckAtMs,
    monotonicDurationMs: duration(values.submittedMonotonicMs, clientAckMonotonicMs),
    metadata: {
      surface: values.surface,
      submittedToAckMs: values.submittedAtMs == null
        ? null
        : Math.max(0, clientAckAtMs - values.submittedAtMs),
      controlToAckMs: values.controlStartedAtMs == null
        ? null
        : Math.max(0, clientAckAtMs - values.controlStartedAtMs),
      reportDelayMs: Math.max(0, reported - clientAckAtMs),
    },
  };
}
