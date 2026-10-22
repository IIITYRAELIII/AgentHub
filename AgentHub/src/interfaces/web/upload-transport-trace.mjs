import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEADERS = { httpRequestId: "x-agent-hub-upload-request-id", uploadId: "x-agent-hub-upload-id",
  uploadAttemptId: "x-agent-hub-upload-attempt-id", messageRequestId: "x-agent-hub-message-request-id" };
export const UPLOAD_TRACE_HEADERS = Object.freeze(Object.values(HEADERS));

function identity(headers = {}) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const result = {};
  for (const [key, header] of Object.entries(HEADERS)) {
    const raw = headers[header] ?? headers[header.replace(/(^|-)[a-z]/gu, part => part.toUpperCase())];
    const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
    if (typeof value === "string" && UUID.test(value)) result[key] = value;
  }
  return result.httpRequestId && result.uploadId ? result : null;
}

export function uploadTransportAction(method, uri) {
  let url;
  try { url = new URL(uri, "http://upload.invalid"); } catch { return null; }
  if (url.pathname !== "/api/attachment-upload") return null;
  const id = url.searchParams.has("id");
  if (method === "GET") return id ? "status" : "capabilities";
  if (method === "POST") return id && url.searchParams.get("complete") === "1" ? "complete" : !id ? "begin" : null;
  if (method === "PUT" && id) return "chunk";
  if (method === "DELETE" && id) return "cancel";
  return null;
}

function safeRecord(record, span) {
  try { record?.(span)?.catch?.(() => {}); } catch { /* Diagnostic failure has no transport authority. */ }
}

/** Called only after authentication; raw headers/URI/body never enter a span. */
export function observeAuthorizedUpload({ request, response, record, timings, receivedAtMs = Date.now() }) {
  const ids = identity(request.headers), action = uploadTransportAction(request.method, request.url);
  if (!ids || !action || typeof record !== "function") return;
  const started = performance.now() - (timings.auth ?? 0), operationSpanId = randomUUID();
  const common = { commandId: ids.uploadId, stage: "attachment-upload", transport: "origin",
    metadata: { ...ids, action: `origin-${action}`, operationSpanId, startedAtMs: receivedAtMs } };
  safeRecord(record, { ...common, outcome: "started", observedAtMs: receivedAtMs, monotonicDurationMs: 0 });
  response.setHeader("X-Agent-Hub-Upload-Request-Id", ids.httpRequestId);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const completed = response.writableFinished;
    const metadata = { ...common.metadata, statusCode: response.statusCode,
      ...(!completed ? { failureKind: "aborted" } : {}) };
    for (const [name, value] of Object.entries(timings)) {
      if (["auth", "body", "owner", "ownerQueue", "ownerLoopMax", "storageRead", "storageOpen",
        "storageWrite", "storageSync", "storageClose", "storageRename", "storagePublish", "storageCleanup"].includes(name)
          && Number.isFinite(value) && value >= 0 && value <= 86_400_000) {
        metadata[`server${name[0].toUpperCase()}${name.slice(1)}Ms`] = value;
      }
    }
    safeRecord(record, { ...common, metadata, outcome: completed && response.statusCode < 400 ? "succeeded" : "failed",
      observedAtMs: Date.now(), monotonicDurationMs: Math.max(0, performance.now() - started) });
  };
  response.once("finish", finish);
  response.once("close", finish);
}

/** Consume bounded Caddy JSON errors into the existing trace owner, not a log
 * mirror. Cookies, authorization, file names, addresses and error text drop.
 */
export function createUploadGatewayObserver(record) {
  if (typeof record !== "function") return () => {};
  let pending = "", discard = false;
  return chunk => {
    // A stream chunk may contain arbitrarily many lines; process at most 64KiB.
    if (chunk.length > 64 * 1024) { pending = ""; discard = true; return; }
    const text = String(chunk);
    for (const part of text.split(/(?<=\n)/u)) {
      const ended = part.endsWith("\n");
      if (discard) { if (ended) discard = false; continue; }
      pending += part;
      if (pending.length > 16 * 1024) { pending = ""; discard = !ended; continue; }
      if (!ended) continue;
      let value;
      try { value = JSON.parse(pending); } catch { pending = ""; continue; }
      pending = "";
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (value.logger !== "http.log.error" || !Number.isInteger(value.status) || value.status < 500 || value.status > 599) continue;
      const ids = identity(value.request?.headers), action = uploadTransportAction(value.request?.method, value.request?.uri);
      if (!ids || !action) continue;
      const text = typeof value.msg === "string" ? value.msg : "";
      const upstreamError = /reset|forcibly closed/iu.test(text) ? "connection-reset"
        : /refused/iu.test(text) ? "connection-refused" : /timeout|timed out/iu.test(text) ? "timeout"
          : /\bEOF\b/u.test(text) ? "eof" : "other";
      if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0 || value.duration > 86_400) continue;
      const duration = value.duration * 1000;
      safeRecord(record, { commandId: ids.uploadId, stage: "attachment-upload", transport: "gateway", outcome: "failed",
        observedAtMs: Date.now(), monotonicDurationMs: duration,
        metadata: { ...ids, action: `gateway-${action}`, statusCode: value.status, upstreamError } });
    }
  };
}
