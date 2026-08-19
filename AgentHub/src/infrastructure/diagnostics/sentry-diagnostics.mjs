import { randomUUID } from "node:crypto";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_EVENTS_PER_MINUTE = 30;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_STACK_LENGTH = 8_000;
const SDK = Object.freeze({ name: "agent-hub", version: "1.0.0" });
const SAFE_ERROR_TYPES = new Set([
  "Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "URIError", "EvalError", "AggregateError",
]);
const CLIENT_ERROR_KINDS = new Set(["window-error", "unhandled-rejection", "manual"]);
const CLIENT_ERROR_ACTIONS = new Set([
  "local-dispatcher", "local-domain", "local-task",
]);
const UNEXPECTED_ERROR_TYPES = new Set([
  "TypeError", "ReferenceError", "RangeError", "SyntaxError", "URIError", "EvalError", "AggregateError",
]);

function trimmed(value) {
  return String(value ?? "").trim();
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripUrlDetails(value) {
  return value.replace(/https?:\/\/[^\s)\]}>'"]+/giu, (candidate) => {
    try {
      const parsed = new URL(candidate);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return candidate;
    }
  });
}

function sanitizeText(value, { roots = [], maxLength = MAX_MESSAGE_LENGTH } = {}) {
  let text = String(value ?? "");
  text = text.replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/giu, "%USERPROFILE%");
  for (const root of roots) {
    const normalized = trimmed(root).replace(/[\\/]+$/u, "");
    if (!normalized) continue;
    text = text.replace(new RegExp(escapePattern(normalized), "giu"), "<project>");
  }
  text = text
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(token|api[_-]?key|secret|password)\s*[:=]\s*["']?[^"'\s,;]+/giu, "$1=[redacted]");
  text = stripUrlDetails(text);
  return text.slice(0, maxLength);
}

function safeTag(value) {
  return sanitizeText(value, { maxLength: 80 }).replace(/[\r\n\t]/gu, " ").trim();
}

function safeErrorType(value) {
  const type = trimmed(value);
  return SAFE_ERROR_TYPES.has(type) ? type : "Error";
}

function safeFrameFilename(value, roots) {
  const filename = sanitizeText(value, { roots, maxLength: 500 });
  if (filename.startsWith("<project>")) return filename;
  if (filename.startsWith("%USERPROFILE%")) return "%USERPROFILE%";
  if (/^https?:\/\//iu.test(filename)) return "<url>";
  if (/^(?:[A-Za-z]:[\\/]|\/)/u.test(filename)) return "<external>";
  return filename;
}

function parseDsn(value) {
  const dsn = trimmed(value);
  if (!dsn) return null;
  const parsed = new URL(dsn);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Sentry DSN must use HTTP or HTTPS");
  const publicKey = decodeURIComponent(parsed.username);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!publicKey || !projectId) throw new Error("Sentry DSN must contain a public key and project id");
  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  const endpoint = new URL(`${prefix}/api/${encodeURIComponent(projectId)}/envelope/`, parsed.origin);
  endpoint.searchParams.set("sentry_version", "7");
  endpoint.searchParams.set("sentry_key", publicKey);
  endpoint.searchParams.set("sentry_client", `${SDK.name}/${SDK.version}`);
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return { dsn: parsed.toString(), endpoint: endpoint.toString() };
}

function errorDetails(error) {
  if (error instanceof Error) {
    return {
      name: trimmed(error.name) || "Error",
      message: trimmed(error.message) || String(error),
      stack: trimmed(error.stack),
    };
  }
  if (error && typeof error === "object") {
    return {
      name: trimmed(error.name) || "Error",
      message: trimmed(error.message) || "Unknown Agent Hub error",
      stack: trimmed(error.stack),
    };
  }
  return { name: "Error", message: trimmed(error) || "Unknown Agent Hub error", stack: "" };
}

function stackFrames(stack, roots) {
  const frames = [];
  const lines = String(stack ?? "").split(/\r?\n/u);
  const frameLines = /^\s*at\s+/u.test(lines[0] ?? "") ? lines : lines.slice(1);
  for (const rawLine of frameLines.slice(0, 80)) {
    const line = rawLine.trim();
    const dotnet = /^at\s+(.*?)\s+in\s+(.+):line\s+(\d+)$/u.exec(line);
    const match = dotnet
      ? [dotnet[0], dotnet[1], dotnet[2], dotnet[3], "1"]
      : /^(?:at\s+)?(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/u.exec(line);
    if (!match) continue;
    frames.push({
      filename: safeFrameFilename(match[2], roots),
      function: /^[A-Za-z_$][\w$.[\]<>-]{0,119}$/u.test(match[1] || "") ? match[1] : "<anonymous>",
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: true,
    });
  }
  return frames.reverse();
}

function clientError(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const name = trimmed(source.name) || "Error";
  const message = trimmed(source.message) || "Unknown browser error";
  const location = [trimmed(source.source), Number(source.line) || 0, Number(source.column) || 0]
    .filter(Boolean)
    .join(":");
  return {
    name,
    message,
    stack: trimmed(source.stack) || (location ? `${name}: ${message}\n    at ${location}` : ""),
    kind: CLIENT_ERROR_KINDS.has(trimmed(source.kind)) ? trimmed(source.kind) : "window-error",
    action: CLIENT_ERROR_ACTIONS.has(trimmed(source.action)) ? trimmed(source.action) : "",
  };
}

function reportableUnexpectedError(error) {
  if (error?.diagnosticExpected === true) return false;
  if (error?.diagnosticReportable === true) return true;
  return error instanceof Error && UNEXPECTED_ERROR_TYPES.has(trimmed(error.name));
}

function retryAfterMs(response, nowMs) {
  if (response.status === 429) {
    const seconds = Number(response.headers?.get?.("retry-after"));
    return nowMs + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 60_000);
  }
  const sentryLimits = trimmed(response.headers?.get?.("x-sentry-rate-limits"));
  if (!sentryLimits) return 0;
  const seconds = Math.max(...sentryLimits.split(",").map((entry) => Number(entry.split(":", 1)[0]) || 0));
  return seconds > 0 ? nowMs + seconds * 1_000 : 0;
}

export function createSentryDiagnostics({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  randomId = randomUUID,
  processRef = process,
} = {}) {
  let settings = {
    enabled: false,
    dsn: null,
    environment: "production",
    release: "",
    sampleRate: 1,
    maxEventsPerMinute: DEFAULT_MAX_EVENTS_PER_MINUTE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    roots: [],
  };
  let recentEvents = [];
  let blockedUntilMs = 0;
  const pending = new Set();
  const capturedErrors = new WeakSet();

  function configure(value = {}) {
    let parsedDsn = null;
    try {
      parsedDsn = parseDsn(value.dsn ?? processRef.env?.SENTRY_DSN ?? "");
    } catch {
      parsedDsn = null;
    }
    const sampleRate = Number(value.sampleRate ?? 1);
    const maxEventsPerMinute = Number(value.maxEventsPerMinute ?? DEFAULT_MAX_EVENTS_PER_MINUTE);
    const timeoutMs = Number(value.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const enabled = value.enabled == null ? Boolean(parsedDsn) : value.enabled === true;
    settings = {
      enabled: enabled && Boolean(parsedDsn),
      dsn: parsedDsn,
      environment: safeTag(value.environment ?? processRef.env?.SENTRY_ENVIRONMENT ?? "production") || "production",
      release: safeTag(value.release ?? processRef.env?.SENTRY_RELEASE ?? ""),
      sampleRate: Number.isFinite(sampleRate) && sampleRate >= 0 && sampleRate <= 1 ? sampleRate : 1,
      maxEventsPerMinute: Number.isInteger(maxEventsPerMinute) && maxEventsPerMinute > 0
        ? maxEventsPerMinute
        : DEFAULT_MAX_EVENTS_PER_MINUTE,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      roots: Array.isArray(value.roots) ? value.roots.map(trimmed).filter(Boolean) : [],
    };
    return { enabled: settings.enabled, environment: settings.environment, release: settings.release || null };
  }

  function admission(nowMs) {
    if (!settings.enabled || !settings.dsn || typeof fetchImpl !== "function") return false;
    if (nowMs < blockedUntilMs || settings.sampleRate === 0) return false;
    if (settings.sampleRate < 1 && Math.random() > settings.sampleRate) return false;
    recentEvents = recentEvents.filter((timestamp) => nowMs - timestamp < 60_000);
    if (recentEvents.length >= settings.maxEventsPerMinute) return false;
    recentEvents.push(nowMs);
    return true;
  }

  function schedule(error, context = {}) {
    const trackable = error !== null && (typeof error === "object" || typeof error === "function");
    if (trackable && capturedErrors.has(error)) return false;
    const nowMs = now();
    if (!admission(nowMs)) return false;
    if (trackable) capturedErrors.add(error);
    const details = errorDetails(error);
    const stack = sanitizeText(details.stack, { roots: settings.roots, maxLength: MAX_STACK_LENGTH });
    const eventId = randomId().replaceAll("-", "").slice(0, 32);
    const tags = Object.fromEntries(Object.entries({
      surface: safeTag(context.surface) || "server",
      kind: safeTag(context.kind) || "error",
      component: safeTag(context.component),
      action: safeTag(context.action),
    }).filter(([, value]) => value));
    const event = {
      event_id: eventId,
      timestamp: nowMs / 1_000,
      platform: "node",
      level: "error",
      environment: settings.environment,
      ...(settings.release ? { release: settings.release } : {}),
      sdk: SDK,
      tags,
      exception: {
        values: [{
          type: safeErrorType(details.name),
          value: `Agent Hub captured ${tags.kind}`,
          ...(stack ? { stacktrace: { frames: stackFrames(stack, settings.roots) } } : {}),
        }],
      },
      contexts: {
        runtime: { name: "node", version: trimmed(processRef.version) },
        app: { app_name: "Agent Hub" },
      },
    };
    const eventJson = JSON.stringify(event);
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: new Date(nowMs).toISOString(), dsn: settings.dsn.dsn, sdk: SDK }),
      JSON.stringify({ type: "event", content_type: "application/json", length: Buffer.byteLength(eventJson) }),
      eventJson,
    ].join("\n");
    const request = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      timer.unref?.();
      try {
        const response = await fetchImpl(settings.dsn.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-sentry-envelope" },
          body: envelope,
          signal: controller.signal,
        });
        blockedUntilMs = Math.max(blockedUntilMs, retryAfterMs(response, now()));
      } catch {
        // Diagnostics must never change Agent Hub behavior or create a logging loop.
      } finally {
        clearTimeout(timer);
      }
    })();
    pending.add(request);
    void request.finally(() => pending.delete(request));
    return true;
  }

  function captureClientEvent(value, context = {}) {
    const error = clientError(value);
    const accepted = schedule(error, {
      surface: safeTag(context.source) || "web",
      kind: error.kind,
      component: safeTag(context.source).startsWith("desktop") ? "local-client" : "web-client",
      action: error.action,
    });
    return { accepted };
  }

  function captureUnexpectedException(error, context = {}) {
    return reportableUnexpectedError(error) ? schedule(error, context) : false;
  }

  async function flush(timeoutMs = 2_000) {
    if (pending.size === 0) return true;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 1));
      timer.unref?.();
    });
    const completed = Promise.allSettled([...pending]).then(() => true);
    const result = await Promise.race([completed, timeout]);
    clearTimeout(timer);
    return result;
  }

  configure();
  return { configure, captureException: schedule, captureUnexpectedException, captureClientEvent, flush };
}

export const sentryDiagnostics = createSentryDiagnostics();
