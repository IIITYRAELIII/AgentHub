import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();
const MAX_SYNC_AGE_SECONDS = 300;
const MAX_TELEGRAM_AUTH_AGE_SECONDS = 86_400;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_COUNT = 256;
const SYNC_ID_PATTERN = /^[a-z0-9_-]{8,100}$/iu;
const MAX_CONTROL_REQUEST_BYTES = 64 * 1024;
const MAX_CONTROL_RESULT_BYTES = 1024 * 1024;
const MAX_CONTROL_ERROR_CHARS = 4_096;
const MAX_CONTROL_COMMANDS = 500;
const MAX_CONTROL_COMMAND_DEPTH = 32;
const MAX_CONTROL_COMMAND_NODES = 1_024;
const MAX_CONTROL_COMMAND_CANONICAL_BYTES = 48 * 1024;
const CONTROL_EXPIRY_MS = 30 * 60 * 1_000;
const CONTROL_LEASE_MS = 30 * 1_000;
const MAX_CONTROL_WAIT_MS = 25 * 1_000;
const CONTROL_INDEX_VERSION = 1;
const CONTROL_INDEX_VERSION_KEY = "control:index-version";
const CONTROL_ACTIVE_COUNT_KEY = "control:active-count";
const CONTROL_AVAILABLE_PREFIX = "control:available:";
const CONTROL_EXPIRY_PREFIX = "control:expiry:";
const CLIENT_SNAPSHOT_PREFIX = "client:snapshot:";
const CONTROL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DASHBOARD_BOT_PAIRING_EXPIRY_MS = 10 * 60 * 1_000;
const DASHBOARD_BOT_COMMAND_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000;
const DASHBOARD_BOT_PAIRING_CODE_PATTERN = /^[A-Z2-9]{8}$/u;
const DASHBOARD_BOT_HUB_NAME_MAX_CHARS = 80;
const DASHBOARD_BOT_HUB_VERIFIER_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DASHBOARD_BOT_HUB_REGISTRY_MAX_ENTRIES = 1_000;
const DASHBOARD_BOT_ROUTER_NAME = "dashboard-bot:router";
const DASHBOARD_BOT_SERVICE_IDENTITY_KEY = "dashboard-bot:service-identity";
const DASHBOARD_BOT_BUNDLE_CALLBACK_PATTERN = /^forward-bundle:(send|separate|cancel):([0-9a-f-]{36})$/iu;
const DASHBOARD_BOT_BUNDLE_MAX_ITEMS = 100;
const DASHBOARD_BOT_BUNDLE_MAX_CHARS = 50_000;
const DASHBOARD_BOT_SUBMISSION_LEASE_MS = 5 * 60 * 1_000;
const DASHBOARD_BOT_PRECEDING_COMMENT_MAX_AGE_MS = 60 * 1_000;
const DASHBOARD_BOT_PRECEDING_COMMENT_MAX_CHARS = 160;
const DASHBOARD_BOT_PRECEDING_COMMENT_MAX_MESSAGE_GAP = 4;
const SYNC_STAGING_EXPIRY_MS = 30 * 60 * 1_000;
const STORAGE_DELETE_BATCH_SIZE = 128;
const REMOTE_ATTACHMENT_PREFIX = "remote-attachment:";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_STORAGE_CHUNK_BYTES = 1024 * 1024;
export const ATTACHMENT_TRANSPORT_PROTOCOL = "agent-hub-attachment-chunks-v1";
export const ATTACHMENT_TRANSPORT_CHUNK_BYTES = 16 * 1024;
const ATTACHMENT_TRANSPORT_MANIFEST_PAGE_CHUNKS = 128;
const ATTACHMENT_TRANSPORT_MAX_RESPONSE_BYTES = 24 * 1024;
const ATTACHMENT_TRANSPORT_PROBE_BYTES = 128 * 1024 + 123;
const MAX_ATTACHMENTS_PER_COMMAND = 8;
const MAX_ATTACHMENTS_PER_USER = 32;
const MAX_ATTACHMENT_BYTES_PER_USER = 100 * 1024 * 1024;
const ATTACHMENT_EXPIRY_MS = 30 * 60 * 1_000;
const DEVICE_PAIRING_EXPIRY_MS = 10 * 60 * 1_000;
const DEVICE_CHALLENGE_EXPIRY_MS = 2 * 60 * 1_000;
const DEVICE_SESSION_EXPIRY_MS = 12 * 60 * 60 * 1_000;
const DEVICE_NAME_MAX_CHARS = 80;
const DEVICE_ID_PATTERN = CONTROL_ID_PATTERN;
const DEVICE_CODE_PATTERN = /^[A-Z2-7]{20}$/u;
const DEVICE_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{80,256}$/u;
const DEVICE_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const CONTROL_ACTIONS = new Set([
  "snapshot",
  "task-history",
  "rate-limit-history",
  "usage-history",
  "search",
  "workspace-message-search",
  "workspace-message-open",
  "open-task",
  "open-turn",
  "select-task",
  "send-message",
  "submit-bug-report",
  "new-task",
  "update-setting",
  "rename-task",
  "archive-task",
  "task-diff",
  "cancel-run",
  "resolve-approval",
  "deferred-input",
  "status-details",
  "speak-last-answer",
  "restart-server",
  "compact-context",
  "open-attachment",
  "trusted-devices",
  "create-device-pairing",
  "revoke-device",
  "board-task-ingest",
]);
const CONTROL_SOURCES = new Set(["telegram-mini-app", "trusted-device", "shared-dashboard-bot"]);

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value));
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

async function verifyHmac(key, value, signature) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", cryptoKey, bytesFromHex(signature), encoder.encode(value));
}

async function constantTimeTextEqual(left, right) {
  const comparisonKey = "agent-hub-dashboard-registry-v1";
  const signature = hex(await hmac(comparisonKey, String(left)));
  return verifyHmac(comparisonKey, String(right), signature);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.prototype.toString.call(value) === "[object Object]";
}

async function readBoundedBytes(request, maxBytes, label) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label} is too large`);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader.cancel(`${label} is too large`).catch(() => {});
        throw new Error(`${label} is too large`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedBody(request, maxBytes, label) {
  return new TextDecoder().decode(await readBoundedBytes(request, maxBytes, label));
}

export async function materializeDashboardBotAttachmentResponse(response) {
  const body = response.body
    ? await readBoundedBytes(response, MAX_ATTACHMENT_BYTES, "dashboard bot attachment")
    : null;
  return new Response(body?.byteLength ? body : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function attachmentTransportChunkCount(size) {
  return Math.ceil(Number(size) / ATTACHMENT_TRANSPORT_CHUNK_BYTES);
}

function attachmentTransportChunkSize(size, index) {
  return Math.min(
    ATTACHMENT_TRANSPORT_CHUNK_BYTES,
    Number(size) - index * ATTACHMENT_TRANSPORT_CHUNK_BYTES,
  );
}

async function attachmentTransportManifestPage(metadata, page, readChunk) {
  const count = attachmentTransportChunkCount(metadata.size);
  const pageCount = Math.ceil(count / ATTACHMENT_TRANSPORT_MANIFEST_PAGE_CHUNKS);
  if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) {
    throw new RangeError("invalid attachment manifest page");
  }
  const start = page * ATTACHMENT_TRANSPORT_MANIFEST_PAGE_CHUNKS;
  const end = Math.min(count, start + ATTACHMENT_TRANSPORT_MANIFEST_PAGE_CHUNKS);
  const chunks = [];
  for (let index = start; index < end; index += 1) {
    const body = await readChunk(index);
    chunks.push({ index, size: body.byteLength, hash: await sha256(body) });
  }
  return {
    protocol: ATTACHMENT_TRANSPORT_PROTOCOL,
    id: metadata.id,
    size: metadata.size,
    hash: metadata.hash,
    count,
    chunkBytes: ATTACHMENT_TRANSPORT_CHUNK_BYTES,
    page,
    pageCount,
    contentType: metadata.contentType,
    name: metadata.name,
    chunks,
  };
}

function attachmentTransportJson(payload) {
  const body = JSON.stringify(payload);
  const size = encoder.encode(body).byteLength;
  if (size > ATTACHMENT_TRANSPORT_MAX_RESPONSE_BYTES) {
    throw new Error("attachment transport manifest exceeds response bound");
  }
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(size),
      "X-Agent-Hub-Attachment-Protocol": ATTACHMENT_TRANSPORT_PROTOCOL,
    },
  });
}

function attachmentTransportChunkResponse(metadata, descriptor, body) {
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.byteLength),
      "X-Agent-Hub-Attachment-Protocol": ATTACHMENT_TRANSPORT_PROTOCOL,
      "X-Agent-Hub-Attachment-Id": metadata.id,
      "X-Agent-Hub-Attachment-Hash": metadata.hash,
      "X-Agent-Hub-Chunk-Index": String(descriptor.index),
      "X-Agent-Hub-Chunk-Count": String(attachmentTransportChunkCount(metadata.size)),
      "X-Agent-Hub-Chunk-Hash": descriptor.hash,
    },
  });
}

function syntheticAttachmentTransportBody() {
  return Uint8Array.from(
    { length: ATTACHMENT_TRANSPORT_PROBE_BYTES },
    (_, index) => (index * 31 + 17) % 251,
  );
}

export async function dashboardAttachmentTransportProbeResponse(request) {
  if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
  const url = new URL(request.url);
  const body = syntheticAttachmentTransportBody();
  const metadata = {
    id: "dashboard-transport-probe-v1",
    size: body.byteLength,
    hash: await sha256(body),
    contentType: "application/octet-stream",
    name: "dashboard-transport-probe.bin",
  };
  const readChunk = async (index) => body.slice(
    index * ATTACHMENT_TRANSPORT_CHUNK_BYTES,
    Math.min(body.byteLength, (index + 1) * ATTACHMENT_TRANSPORT_CHUNK_BYTES),
  );
  if (url.searchParams.get("mode") === "manifest") {
    const page = Number(url.searchParams.get("page") ?? 0);
    try {
      return attachmentTransportJson(await attachmentTransportManifestPage(metadata, page, readChunk));
    } catch (error) {
      return json({ error: error.message }, error instanceof RangeError ? 400 : 500);
    }
  }
  if (url.searchParams.get("mode") === "chunk") {
    const index = Number(url.searchParams.get("index"));
    const count = attachmentTransportChunkCount(body.byteLength);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
      return json({ error: "invalid attachment chunk index" }, 400);
    }
    const chunk = await readChunk(index);
    return attachmentTransportChunkResponse(metadata, {
      index,
      size: chunk.byteLength,
      hash: await sha256(chunk),
    }, chunk);
  }
  return json({ error: "invalid attachment transport mode" }, 400);
}

export async function readBoundedBinary(request, maxBytes, label) {
  const body = await readBoundedBytes(request, maxBytes, label);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
}

function parseJson(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

function invalidControlPayloadLimit(limit) {
  return new Error(`control command payload exceeds ${limit} limit`);
}

function canonicalControlPayload(value, { serialize = false, inspectAttachments = false } = {}) {
  const parts = serialize ? [] : null;
  const active = new Set();
  const stack = [{ type: "value", value, depth: 0 }];
  let attachmentFound = false;
  let byteLength = 0;
  let nodeCount = 0;

  const append = (part) => {
    byteLength += encoder.encode(part).byteLength;
    if (byteLength > MAX_CONTROL_COMMAND_CANONICAL_BYTES) {
      throw invalidControlPayloadLimit("byte");
    }
    if (parts) parts.push(part);
  };

  while (stack.length) {
    const item = stack.pop();
    if (item.type === "token") {
      append(item.value);
      continue;
    }
    if (item.type === "leave") {
      active.delete(item.value);
      continue;
    }

    nodeCount += 1;
    if (nodeCount > MAX_CONTROL_COMMAND_NODES) throw invalidControlPayloadLimit("node");
    if (item.depth > MAX_CONTROL_COMMAND_DEPTH) throw invalidControlPayloadLimit("depth");
    const current = item.value;
    if (current === null || typeof current !== "object") {
      let encoded;
      try {
        encoded = JSON.stringify(current);
      } catch {
        throw new Error("invalid control command payload");
      }
      if (typeof encoded !== "string") throw new Error("invalid control command payload");
      append(encoded);
      continue;
    }
    if (active.has(current)) throw new Error("invalid control command payload");
    active.add(current);

    if (Array.isArray(current)) {
      append("[");
      stack.push({ type: "leave", value: current });
      stack.push({ type: "token", value: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (index < current.length - 1) stack.push({ type: "token", value: "," });
        stack.push({ type: "value", value: current[index], depth: item.depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(current)) throw new Error("invalid control command payload");

    const keys = Object.keys(current).sort();
    append("{");
    stack.push({ type: "leave", value: current });
    stack.push({ type: "token", value: "}" });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const nested = current[key];
      if (
        inspectAttachments
        && ["attachment", "attachments", "image", "images", "files"].includes(key.toLowerCase())
        && nested != null
        && (!Array.isArray(nested) || nested.length > 0)
      ) {
        attachmentFound = true;
      }
      if (index < keys.length - 1) stack.push({ type: "token", value: "," });
      stack.push({ type: "value", value: nested, depth: item.depth + 1 });
      stack.push({ type: "token", value: `${JSON.stringify(key)}:` });
    }
  }

  return { attachmentFound, text: parts?.join("") ?? "" };
}

function hasAttachments(value) {
  return canonicalControlPayload(value, { inspectAttachments: true }).attachmentFound;
}

function attachmentIdFromReference(value) {
  const reference = String(value ?? "").trim().toLowerCase();
  if (!reference.startsWith(REMOTE_ATTACHMENT_PREFIX)) return null;
  const id = reference.slice(REMOTE_ATTACHMENT_PREFIX.length);
  return CONTROL_ID_PATTERN.test(id) ? id : null;
}

function attachmentIdsFromParams(action, params) {
  if (!Object.hasOwn(params, "attachments") || params.attachments == null) return [];
  if (
    !["send-message", "submit-bug-report", "board-task-ingest"].includes(action)
    || !Array.isArray(params.attachments)
    || params.attachments.length < 1
    || params.attachments.length > MAX_ATTACHMENTS_PER_COMMAND
  ) {
    throw new Error("invalid remote attachments");
  }
  const ids = params.attachments.map(attachmentIdFromReference);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("invalid remote attachments");
  }
  return ids;
}

function imageMatchesContentType(bytes, contentType) {
  const value = new Uint8Array(bytes);
  if (contentType === "image/png") {
    return value.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((item, index) => value[index] === item);
  }
  if (contentType === "image/jpeg") return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  if (contentType === "image/gif") {
    const signature = new TextDecoder().decode(value.slice(0, 6));
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (contentType === "image/webp") {
    return value.length >= 12
      && new TextDecoder().decode(value.slice(0, 4)) === "RIFF"
      && new TextDecoder().decode(value.slice(8, 12)) === "WEBP";
  }
  if (contentType === "image/bmp") return value.length >= 2 && value[0] === 0x42 && value[1] === 0x4d;
  return false;
}

function attachmentContentType(value) {
  const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(type)
    ? type
    : "application/octet-stream";
}

function attachmentMatchesContentType(bytes, contentType) {
  return !String(contentType).startsWith("image/") || imageMatchesContentType(bytes, contentType);
}

function attachmentFileName(value) {
  let name = "attachment.bin";
  try {
    name = decodeURIComponent(String(value ?? "").trim()) || name;
  } catch {
    return name;
  }
  name = name.split(/[\\/]/u).at(-1).replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!name || name === "." || name === "..") return "attachment.bin";
  const extensionMatch = /(\.[A-Za-z0-9]{1,16})$/u.exec(name);
  const extension = extensionMatch?.[1] ?? "";
  return name.length <= 180 ? name : `${name.slice(0, 180 - extension.length)}${extension}`;
}

function encodedAttachmentFileName(name) {
  return encodeURIComponent(attachmentFileName(name));
}

async function deterministicAttachmentId(userId, bodyHash, name = "", contentType = "") {
  const value = await sha256(`${userId}\n${bodyHash}\n${attachmentFileName(name)}\n${attachmentContentType(contentType)}`);
  const chars = value.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ["8", "9", "a", "b"][Number.parseInt(chars[16], 16) % 4];
  return [
    chars.slice(0, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
    chars.slice(16, 20).join(""),
    chars.slice(20, 32).join(""),
  ].join("-");
}

function stableStringify(value) {
  return canonicalControlPayload(value, { serialize: true }).text;
}

export function validateControlCommand(payload) {
  if (!isPlainObject(payload)) throw new Error("invalid control command");
  const id = String(payload.id ?? payload.commandId ?? "").trim().toLowerCase();
  const action = String(payload.action ?? "").trim();
  const source = String(payload.source ?? "").trim();
  const params = payload.params ?? {};
  if (!CONTROL_ID_PATTERN.test(id)) throw new Error("invalid control command id");
  if (!CONTROL_ACTIONS.has(action)) throw new Error("control action is not allowed");
  if (source && !CONTROL_SOURCES.has(source)) throw new Error("control source is not allowed");
  if (!isPlainObject(params)) throw new Error("invalid control command params");
  const attachmentIds = attachmentIdsFromParams(action, params);
  const remainingParams = { ...params };
  delete remainingParams.attachments;
  if (hasAttachments(remainingParams)) {
    throw new Error("attachments are not supported by the remote control relay");
  }
  return {
    id,
    action,
    ...(source ? { source } : {}),
    params: attachmentIds.length
      ? { ...params, attachments: attachmentIds.map((attachmentId) => `${REMOTE_ATTACHMENT_PREFIX}${attachmentId}`) }
      : params,
  };
}

export async function validateControlServiceRequest(request, secret, {
  now = Date.now(),
  pathname = "",
} = {}) {
  const timestamp = Number(request.headers.get("X-Agent-Hub-Timestamp"));
  const receivedSignature = String(request.headers.get("X-Agent-Hub-Signature") ?? "").toLowerCase();
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.trunc(now / 1_000) - timestamp) > MAX_SYNC_AGE_SECONDS) {
    throw new Error("expired control request");
  }
  if (!/^[a-f0-9]{64}$/u.test(receivedSignature)) throw new Error("invalid control signature");
  const body = await readBoundedBody(request, MAX_CONTROL_RESULT_BYTES, "control payload");
  const url = new URL(request.url);
  const signatureValue = [
    timestamp,
    request.method.toUpperCase(),
    pathname || url.pathname,
    await sha256(body),
  ].join("\n");
  if (!await verifyHmac(secret, signatureValue, receivedSignature)) {
    throw new Error("invalid control signature");
  }
  return body;
}

function dashboardBotHubRegistry(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("dashboard bot hub registry is not configured");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("dashboard bot hub registry is invalid");
  }
  if (payload?.version !== 1 || !isPlainObject(payload.hubs)) {
    throw new Error("dashboard bot hub registry is invalid");
  }
  const entries = Object.entries(payload.hubs);
  if (entries.length > DASHBOARD_BOT_HUB_REGISTRY_MAX_ENTRIES) {
    throw new Error("dashboard bot hub registry is invalid");
  }
  const registry = new Map();
  for (const [rawHubId, rawVerifier] of entries) {
    const hubId = String(rawHubId).trim().toLowerCase();
    const verifier = String(rawVerifier).trim().toLowerCase();
    if (
      !CONTROL_ID_PATTERN.test(hubId)
      || !DASHBOARD_BOT_HUB_VERIFIER_PATTERN.test(verifier)
      || registry.has(hubId)
    ) {
      throw new Error("dashboard bot hub registry is invalid");
    }
    registry.set(hubId, verifier);
  }
  return registry;
}

function dashboardBotHubRegistration(payload) {
  const hubId = String(payload?.hubId ?? "").trim().toLowerCase();
  const secret = String(payload?.secret ?? "").trim();
  const name = String(payload?.name ?? "Agent Hub").trim().slice(0, DASHBOARD_BOT_HUB_NAME_MAX_CHARS)
    || "Agent Hub";
  if (!CONTROL_ID_PATTERN.test(hubId) || secret.length < 32 || secret.length > 256) {
    throw new Error("invalid dashboard bot hub registration");
  }
  return { hubId, secret, name };
}

async function authorizeDashboardBotRegistration(body, registryValue) {
  const payload = parseJson(body, "dashboard bot registration");
  const { hubId, secret } = dashboardBotHubRegistration(payload);
  const registry = dashboardBotHubRegistry(registryValue);
  const expected = registry.get(hubId) ?? `sha256:${"0".repeat(64)}`;
  const actual = `sha256:${await sha256(secret)}`;
  if (!registry.has(hubId) || !await constantTimeTextEqual(expected, actual)) {
    throw new Error("dashboard bot hub is not authorized");
  }
}

function allowedUserIds(value) {
  return new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

export async function validateTelegramInitData(initData, {
  botToken,
  allowedIds,
  now = Date.now(),
  maxAgeSeconds = MAX_TELEGRAM_AUTH_AGE_SECONDS,
} = {}) {
  const params = new URLSearchParams(String(initData ?? ""));
  const receivedHash = params.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/iu.test(receivedHash)) throw new Error("invalid hash");
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac("WebAppData", String(botToken ?? ""));
  if (!await verifyHmac(secret, dataCheckString, receivedHash.toLowerCase())) throw new Error("invalid signature");
  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || Math.abs(Math.trunc(now / 1_000) - authDate) > maxAgeSeconds) {
    throw new Error("expired auth data");
  }
  let user;
  try {
    user = JSON.parse(params.get("user") ?? "{}");
  } catch {
    throw new Error("invalid user");
  }
  if (!allowedIds.has(String(user?.id ?? ""))) throw new Error("user is not allowed");
  return user;
}

export async function validateSyncRequest(request, secret, { now = Date.now() } = {}) {
  const timestamp = Number(request.headers.get("X-Agent-Hub-Timestamp"));
  const receivedSignature = String(request.headers.get("X-Agent-Hub-Signature") ?? "").toLowerCase();
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.trunc(now / 1_000) - timestamp) > MAX_SYNC_AGE_SECONDS) {
    throw new Error("expired sync request");
  }
  if (!/^[a-f0-9]{64}$/u.test(receivedSignature)) throw new Error("invalid sync signature");
  const body = await readBoundedBody(request, MAX_BODY_BYTES, "sync payload");
  if (!await verifyHmac(secret, `${timestamp}\n${await sha256(body)}`, receivedSignature)) {
    throw new Error("invalid sync signature");
  }
  const payload = JSON.parse(body);
  if (
    typeof payload?.html !== "string"
    || typeof payload?.updatedAt !== "string"
    || typeof payload?.version !== "string"
  ) {
    throw new Error("invalid sync payload");
  }
  return payload;
}

export async function validateSyncChunkRequest(request, secret, { now = Date.now() } = {}) {
  const timestamp = Number(request.headers.get("X-Agent-Hub-Timestamp"));
  const receivedSignature = String(request.headers.get("X-Agent-Hub-Signature") ?? "").toLowerCase();
  const syncId = String(request.headers.get("X-Agent-Hub-Sync-Id") ?? "");
  const index = Number(request.headers.get("X-Agent-Hub-Chunk-Index"));
  const count = Number(request.headers.get("X-Agent-Hub-Chunk-Count"));
  const encoding = String(request.headers.get("X-Agent-Hub-Encoding") ?? "");
  const version = String(request.headers.get("X-Agent-Hub-Journal-Version") ?? "");
  const updatedAt = String(request.headers.get("X-Agent-Hub-Journal-Updated-At") ?? "");
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.trunc(now / 1_000) - timestamp) > MAX_SYNC_AGE_SECONDS) {
    throw new Error("expired sync request");
  }
  if (!/^[a-f0-9]{64}$/u.test(receivedSignature)) throw new Error("invalid sync signature");
  if (!SYNC_ID_PATTERN.test(syncId)) throw new Error("invalid sync id");
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || count < 1 || count > MAX_CHUNK_COUNT || index >= count) {
    throw new Error("invalid sync chunk");
  }
  if (encoding !== "gzip" || !version || !updatedAt) throw new Error("invalid sync metadata");
  const body = await readBoundedBinary(request, MAX_BODY_BYTES, "sync payload");
  if (body.byteLength < 1 || body.byteLength > MAX_BODY_BYTES) throw new Error("sync payload is too large");
  const signatureValue = [
    timestamp,
    syncId,
    index,
    count,
    encoding,
    version,
    updatedAt,
    await sha256(body),
  ].join("\n");
  if (!await verifyHmac(secret, signatureValue, receivedSignature)) {
    throw new Error("invalid sync signature");
  }
  return { body, syncId, index, count, encoding, version, updatedAt };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function dashboardBotTelegramRequest(env, method, body = {}) {
  const token = String(env.DASHBOARD_BOT_TOKEN ?? "").trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token)) throw new Error("dashboard bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Telegram ${method} failed: ${String(payload?.description ?? `HTTP ${response.status}`).slice(0, 300)}`);
  }
  return payload.result;
}

async function dashboardBotTelegramFile(env, attachment) {
  const token = String(env.DASHBOARD_BOT_TOKEN ?? "").trim();
  const file = await dashboardBotTelegramRequest(env, "getFile", { file_id: attachment.fileId });
  const filePath = String(file?.file_path ?? "").trim();
  if (!filePath || Number(file?.file_size ?? attachment.fileSize ?? 0) > MAX_ATTACHMENT_BYTES) {
    throw new Error("Telegram returned an invalid or oversized attachment");
  }
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
  const body = await readBoundedBinary(response, MAX_ATTACHMENT_BYTES, "dashboard bot attachment");
  const contentType = attachmentContentType(attachment.contentType ?? response.headers.get("Content-Type"));
  if (!attachmentMatchesContentType(body, contentType)) throw new Error("Telegram returned a damaged attachment");
  return {
    body,
    contentType,
    name: attachmentFileName(attachment.fileName ?? filePath.split("/").at(-1)),
    bodyHash: await sha256(body),
  };
}

async function uploadDashboardBotAttachments(env, hubStore, userId, attachments) {
  const references = [];
  for (const attachment of attachments) {
    const downloaded = await dashboardBotTelegramFile(env, attachment);
    const id = crypto.randomUUID().toLowerCase();
    const response = await hubStore.fetch(new Request("https://journal.internal/attachment/upload", {
      method: "POST",
      headers: {
        "Content-Type": downloaded.contentType,
        "Content-Length": String(downloaded.body.byteLength),
        "X-Agent-Hub-User-Id": String(userId),
        "X-Agent-Hub-Attachment-Id": id,
        "X-Agent-Hub-Attachment-Hash": downloaded.bodyHash,
        "X-Agent-Hub-File-Name": encodedAttachmentFileName(downloaded.name),
      },
      body: downloaded.body,
    }));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !attachmentIdFromReference(payload?.path)) {
      throw new Error(`Agent Hub rejected an attachment: ${String(payload?.error ?? `HTTP ${response.status}`).slice(0, 300)}`);
    }
    references.push(payload.path);
  }
  return references;
}

async function updateDashboardBotCard(env, registryStore, card) {
  if (!card) return null;
  const body = {
    chat_id: card.chatId,
    text: card.text,
    disable_web_page_preview: true,
    reply_markup: card.replyMarkup,
  };
  const clearStoredCard = async () => registryStore.fetch(new Request(
    "https://journal.internal/dashboard-bot/card",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: card.userId, id: card.bundleId, failed: true }),
    },
  ));
  if (card.mode === "replace" && Number.isSafeInteger(card.messageId)) {
    await dashboardBotTelegramRequest(env, "deleteMessage", {
      chat_id: card.chatId,
      message_id: card.messageId,
    }).catch(() => null);
    await clearStoredCard();
  } else if (card.mode === "edit" && Number.isSafeInteger(card.messageId)) {
    body.message_id = card.messageId;
    try {
      return await dashboardBotTelegramRequest(env, "editMessageText", body);
    } catch (error) {
      if (/message is not modified/iu.test(error.message)) return null;
      await clearStoredCard();
      delete body.message_id;
    }
  }
  let sent;
  try {
    sent = await dashboardBotTelegramRequest(env, "sendMessage", body);
  } catch (error) {
    await clearStoredCard();
    throw error;
  }
  if (Number.isSafeInteger(sent?.message_id)) {
    const storedResponse = await registryStore.fetch(new Request("https://journal.internal/dashboard-bot/card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: card.userId, id: card.bundleId, messageId: sent.message_id }),
    }));
    const stored = await storedResponse.json().catch(() => ({}));
    if (stored.card && stored.card.text !== card.text) {
      await updateDashboardBotCard(env, registryStore, stored.card);
    }
  }
  return sent;
}

export async function validateControlBinaryServiceRequest(request, secret, {
  now = Date.now(),
  maxBytes = MAX_ATTACHMENT_BYTES,
} = {}) {
  const timestamp = Number(request.headers.get("X-Agent-Hub-Timestamp"));
  const receivedSignature = String(request.headers.get("X-Agent-Hub-Signature") ?? "").toLowerCase();
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.trunc(now / 1_000) - timestamp) > MAX_SYNC_AGE_SECONDS) {
    throw new Error("expired control request");
  }
  if (!/^[a-f0-9]{64}$/u.test(receivedSignature)) throw new Error("invalid control signature");
  const body = await readBoundedBinary(request, maxBytes, "control attachment");
  const url = new URL(request.url);
  const signatureValue = [
    timestamp,
    request.method.toUpperCase(),
    url.pathname,
    await sha256(body),
  ].join("\n");
  if (!await verifyHmac(secret, signatureValue, receivedSignature)) {
    throw new Error("invalid control signature");
  }
  return body;
}

function base64Url(bytes) {
  let binary = "";
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function bytesFromBase64Url(value) {
  const normalized = String(value ?? "").replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomPairingCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return [...randomBytes(20)].map((value) => alphabet[value & 31]).join("");
}

function randomDashboardBotPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

function normalizedDashboardBotPairingCode(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z2-9]/gu, "");
}

function dashboardBotHubKey(hubId) {
  return `dashboard-bot:hub:${hubId}`;
}

function dashboardBotUserKey(userId) {
  return `dashboard-bot:user:${userId}`;
}

function dashboardBotPairingKey(codeHash) {
  return `dashboard-bot:pairing:${codeHash}`;
}

function dashboardBotBundleKey(userId) {
  return `dashboard-bot:bundle:${userId}`;
}

function dashboardBotRecentDirectKey(userId) {
  return `dashboard-bot:recent-direct:${userId}`;
}

function dashboardBotNonEmpty(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function dashboardBotSubmissionIsStale(bundle, now = Date.now()) {
  if (bundle?.submitting !== true) return false;
  const startedAt = Number(bundle.submissionStartedAt ?? bundle.updatedAt ?? 0);
  return !Number.isFinite(startedAt) || startedAt <= now - DASHBOARD_BOT_SUBMISSION_LEASE_MS;
}

function dashboardBotSubmissionFailureMessage(error) {
  const detail = String(error?.message ?? error ?? "");
  if (/timeout|timed out|aborted|durable object|storage operation/iu.test(detail)) {
    return "Agent Hub временно не ответил. Пачка сохранена: повторите отправку или отмените её.";
  }
  return `Agent Hub временно не принял пачку: ${detail || "очередь недоступна"}`.slice(0, 300);
}

function dashboardBotUserLabel(user) {
  const fullName = [dashboardBotNonEmpty(user?.first_name), dashboardBotNonEmpty(user?.last_name)]
    .filter(Boolean)
    .join(" ");
  if (fullName) return fullName;
  if (dashboardBotNonEmpty(user?.username)) return `@${user.username}`;
  return "неизвестный пользователь";
}

function dashboardBotChatLabel(chat) {
  return dashboardBotNonEmpty(chat?.title)
    ?? (dashboardBotNonEmpty(chat?.username) ? `@${chat.username}` : null)
    ?? "неизвестный чат";
}

function dashboardBotForwardSourceFromOrigin(origin, forwardingUserId) {
  if (!isPlainObject(origin)) return null;
  if (origin.type === "user") {
    return {
      type: "user",
      label: String(origin.sender_user?.id ?? "") === String(forwardingUserId ?? "")
        ? "Вы (переслано)"
        : dashboardBotUserLabel(origin.sender_user),
    };
  }
  if (origin.type === "hidden_user") {
    return {
      type: "hidden-user",
      label: dashboardBotNonEmpty(origin.sender_user_name) ?? "источник скрыт",
    };
  }
  if (origin.type === "chat") {
    return {
      type: "chat",
      label: [dashboardBotChatLabel(origin.sender_chat), dashboardBotNonEmpty(origin.author_signature)]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (origin.type === "channel") {
    return {
      type: "channel",
      label: [dashboardBotChatLabel(origin.chat), dashboardBotNonEmpty(origin.author_signature)]
        .filter(Boolean)
        .join(" · "),
    };
  }
  return { type: dashboardBotNonEmpty(origin.type) ?? "unknown", label: "источник скрыт" };
}

export function dashboardBotForwardedMessageSource(message) {
  const modern = dashboardBotForwardSourceFromOrigin(message?.forward_origin, message?.from?.id);
  if (modern) return modern;
  if (message?.forward_from) {
    return {
      type: "user",
      label: String(message.forward_from.id ?? "") === String(message?.from?.id ?? "")
        ? "Вы (переслано)"
        : dashboardBotUserLabel(message.forward_from),
    };
  }
  if (message?.forward_from_chat) {
    return {
      type: "chat",
      label: [
        dashboardBotChatLabel(message.forward_from_chat),
        dashboardBotNonEmpty(message.forward_signature),
      ].filter(Boolean).join(" · "),
    };
  }
  if (dashboardBotNonEmpty(message?.forward_sender_name)) {
    return { type: "hidden-user", label: dashboardBotNonEmpty(message.forward_sender_name) };
  }
  if (message?.forward_date != null || message?.is_automatic_forward === true) {
    return { type: "unknown", label: "источник скрыт" };
  }
  return null;
}

function dashboardBotAttachmentDescriptor(message) {
  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;
  if (dashboardBotNonEmpty(photo?.file_id)) {
    return {
      type: "image",
      fileId: String(photo.file_id),
      fileSize: Math.max(0, Number(photo.file_size) || 0),
      fileName: `telegram-${message.message_id}.jpg`,
      contentType: "image/jpeg",
    };
  }
  const candidates = [
    ["voice", message?.voice, ".ogg", "audio/ogg"],
    ["audio", message?.audio, ".audio", "audio/mpeg"],
    ["document", message?.document, ".bin", "application/octet-stream"],
    ["video", message?.video, ".mp4", "video/mp4"],
    ["video-note", message?.video_note, ".mp4", "video/mp4"],
    ["animation", message?.animation, ".mp4", "video/mp4"],
    ["sticker", message?.sticker, ".webp", "image/webp"],
  ];
  for (const [kind, file, extension, fallbackType] of candidates) {
    if (!dashboardBotNonEmpty(file?.file_id)) continue;
    const fileName = attachmentFileName(file.file_name ?? `telegram-${message.message_id}${extension}`);
    const declaredType = attachmentContentType(file.mime_type ?? fallbackType);
    const extensionType = ({
      ".bmp": "image/bmp",
      ".gif": "image/gif",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    })[/\.[a-z0-9]{1,16}$/u.exec(fileName.toLowerCase())?.[0]];
    const contentType = declaredType === "application/octet-stream" && extensionType
      ? extensionType
      : declaredType;
    return {
      type: contentType.startsWith("image/") ? "image" : kind,
      fileId: String(file.file_id),
      fileSize: Math.max(0, Number(file.file_size) || 0),
      fileName,
      contentType,
    };
  }
  return null;
}

function dashboardBotItemAttachments(item) {
  if (Array.isArray(item?.attachments)) return item.attachments;
  return Array.isArray(item?.images) ? item.images : [];
}

function dashboardBotBundleCallbackData(action, id) {
  return `forward-bundle:${action}:${id}`;
}

function dashboardBotBundleKeyboard(bundle) {
  return {
    inline_keyboard: [
      [{ text: "✅ Отправить пачку", callback_data: dashboardBotBundleCallbackData("send", bundle.id) }],
      [
        { text: "📤 Отправить раздельно", callback_data: dashboardBotBundleCallbackData("separate", bundle.id) },
        { text: "🗑 Отменить", callback_data: dashboardBotBundleCallbackData("cancel", bundle.id) },
      ],
    ],
  };
}

function dashboardBotBundleCardText(bundle, warning = "") {
  const forwards = bundle.items.filter((item) => item.kind === "forward").length;
  const comments = bundle.items.length - forwards;
  const attachments = bundle.items.flatMap(dashboardBotItemAttachments);
  const voices = attachments.filter((item) => ["voice", "audio"].includes(item.type)).length;
  return [
    "📥 Собираю пачку для Dashboard",
    "",
    `Сообщений: ${bundle.items.length} · переслано: ${forwards} · ваших: ${comments} · файлов: ${attachments.length} · голосовых: ${voices}`,
    "Добавляйте следующие сообщения и свои комментарии, затем нажмите «Отправить пачку».",
    warning ? `⚠️ ${warning}` : null,
  ].filter(Boolean).join("\n");
}

function dashboardBotBundleText(bundle) {
  let attachmentNumber = 0;
  const blocks = bundle.items.map((item, index) => {
    const heading = item.kind === "forward"
      ? `Переслано · ${dashboardBotNonEmpty(item.source?.label) ?? "источник скрыт"}`
      : "Вы";
    const lines = [`--- Сообщение ${index + 1} · ${heading} ---`];
    if (dashboardBotNonEmpty(item.text)) lines.push(String(item.text).trim());
    for (const attachment of dashboardBotItemAttachments(item)) {
      attachmentNumber += 1;
      if (attachment.type === "image") {
        lines.push(`[Изображение ${attachmentNumber} приложено следом за этим сообщением]`);
      } else if (["voice", "audio"].includes(attachment.type)) {
        lines.push(`[Голосовое сообщение ${attachmentNumber} приложено следом за этим сообщением]`);
      } else {
        lines.push(`[Файл ${attachmentNumber} «${attachmentFileName(attachment.fileName)}» приложен следом за этим сообщением]`);
      }
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

function dashboardBotSeparatedGroups(bundle) {
  const forwards = bundle.items.filter((item) => item.kind === "forward");
  const groups = forwards.map((item) => ({ items: [], forwardMessageId: item.messageId }));
  const groupByMessageId = new Map(groups.map((group) => [group.forwardMessageId, group]));
  let latestGroup = null;
  for (const item of bundle.items) {
    let group = item.kind === "forward"
      ? groupByMessageId.get(item.messageId)
      : groupByMessageId.get(item.replyToMessageId) ?? latestGroup ?? groups[0];
    if (!group) {
      group = { items: [] };
      groups.push(group);
    }
    group.items.push(item);
    groupByMessageId.set(item.messageId, group);
    if (item.kind === "forward") latestGroup = group;
  }
  return groups;
}

function dashboardBotPrecedingComment(recent, message, linked) {
  if (!recent || typeof recent !== "object") return null;
  const messageTime = Number(message.date) > 0 ? Number(message.date) * 1_000 : Date.now();
  const messageGap = Number(message.message_id) - Number(recent.messageId);
  const age = messageTime - Number(recent.createdAt);
  if (
    recent.hubId !== linked.hubId
    || Number(recent.chatId) !== Number(message.chat.id)
    || String(recent.userId) !== String(linked.userId)
    || !dashboardBotNonEmpty(recent.text)
    || String(recent.text).length > DASHBOARD_BOT_PRECEDING_COMMENT_MAX_CHARS
    || !Number.isSafeInteger(messageGap)
    || messageGap < 1
    || messageGap > DASHBOARD_BOT_PRECEDING_COMMENT_MAX_MESSAGE_GAP
    || !Number.isFinite(age)
    || age < 0
    || age > DASHBOARD_BOT_PRECEDING_COMMENT_MAX_AGE_MS
  ) return null;
  return {
    updateId: recent.updateId,
    messageId: recent.messageId,
    replyToMessageId: message.message_id,
    kind: "comment",
    source: null,
    text: recent.text,
    images: [],
    createdAt: recent.createdAt,
    existingTaskMessageId: recent.messageId,
  };
}

function normalizedDeviceCode(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z2-7]/gu, "");
}

function normalizedDeviceName(value) {
  const name = String(value ?? "").trim().replace(/\s+/gu, " ");
  if (!name || name.length > DEVICE_NAME_MAX_CHARS) throw new Error("invalid device name");
  return name;
}

function orderedTimestamp(value) {
  return String(Math.max(0, Math.trunc(Number(value) || 0))).padStart(16, "0");
}

function timedControlKey(prefix, timestamp, id) {
  return `${prefix}${orderedTimestamp(timestamp)}:${id}`;
}

function timedControlRangeEnd(prefix, timestamp) {
  return `${prefix}${orderedTimestamp(Number(timestamp) + 1)}`;
}

function controlCommandKey(id) {
  return `control:command:${id}`;
}

function controlAvailableKey(command, availableAt = command.createdAt) {
  return timedControlKey(CONTROL_AVAILABLE_PREFIX, availableAt, command.id);
}

function controlExpiryKey(command) {
  return timedControlKey(CONTROL_EXPIRY_PREFIX, command.expiresAt, command.id);
}

function clientSnapshotKey(userId) {
  return `${CLIENT_SNAPSHOT_PREFIX}${String(userId)}`;
}

function deviceSessionMessage({ origin, deviceId, challengeId, challenge }) {
  // The verifier origin is part of the signed statement, so a signature produced
  // for one Agent Hub endpoint cannot be relayed to another one.
  return ["agent-hub-device-session-v2", origin, deviceId, challengeId, challenge].join("\n");
}

function legacyDeviceSessionMessage({ deviceId, challengeId, challenge }) {
  return ["agent-hub-device-session-v1", deviceId, challengeId, challenge].join("\n");
}

function deviceVerifierOrigin(value) {
  const origin = String(value ?? "").trim();
  if (!origin) return "";
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("invalid device verifier origin");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("invalid device verifier origin");
  }
  return parsed.origin;
}

/**
 * Fixed-capacity limiter for the public device endpoints. The Durable Object is
 * a single instance, so an in-memory map is enough to bound unauthenticated
 * pairing and challenge traffic without extra storage writes.
 */
export class DeviceAuthAttemptLimiter {
  #buckets = new Map();
  #capacity;
  #limit;
  #windowMs;

  constructor({ capacity = 2_000, limit = 30, windowMs = 60_000 } = {}) {
    this.#capacity = Math.max(1, Math.floor(Number(capacity) || 2_000));
    this.#limit = Math.max(1, Math.floor(Number(limit) || 30));
    this.#windowMs = Math.max(1, Math.floor(Number(windowMs) || 60_000));
  }

  consume(key, now = Date.now()) {
    const normalizedKey = String(key ?? "unknown").slice(0, 128);
    const observedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    let bucket = this.#buckets.get(normalizedKey);
    if (bucket && observedAt - bucket.startedAt >= this.#windowMs) {
      this.#buckets.delete(normalizedKey);
      bucket = null;
    }
    if (!bucket) {
      if (this.#buckets.size >= this.#capacity) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest != null) this.#buckets.delete(oldest);
      }
      bucket = { startedAt: observedAt, count: 0 };
    } else {
      this.#buckets.delete(normalizedKey);
    }
    bucket.count += 1;
    this.#buckets.set(normalizedKey, bucket);
    const allowed = bucket.count <= this.#limit;
    return {
      allowed,
      retryAfter: allowed
        ? 0
        : Math.max(1, Math.ceil((bucket.startedAt + this.#windowMs - observedAt) / 1_000)),
    };
  }
}

async function importDevicePublicKey(value) {
  if (!DEVICE_PUBLIC_KEY_PATTERN.test(value)) throw new Error("invalid device public key");
  try {
    return await crypto.subtle.importKey(
      "spki",
      bytesFromBase64Url(value),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new Error("invalid device public key");
  }
}

async function deleteStorageKeys(storage, keys) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  for (let offset = 0; offset < uniqueKeys.length; offset += STORAGE_DELETE_BATCH_SIZE) {
    await storage.delete(uniqueKeys.slice(offset, offset + STORAGE_DELETE_BATCH_SIZE));
  }
}

async function putStorageEntries(storage, entries) {
  const uniqueEntries = [...new Map(entries.filter(([key]) => Boolean(key))).entries()];
  for (let offset = 0; offset < uniqueEntries.length; offset += STORAGE_DELETE_BATCH_SIZE) {
    await storage.put(Object.fromEntries(uniqueEntries.slice(offset, offset + STORAGE_DELETE_BATCH_SIZE)));
  }
}

export class JournalStore extends DurableObject {
  #cachedPayload = null;
  #snapshotCache = new Map();
  #snapshotWaiters = new Map();
  #controlResultWaiters = new Map();
  #controlWaiters = new Set();
  #deviceAuthAttempts = new DeviceAuthAttemptLimiter();

  #controlWaiter(waitMs) {
    let timer = null;
    let settle = null;
    const promise = new Promise((resolve) => {
      settle = () => {
        if (!this.#controlWaiters.delete(settle)) return;
        clearTimeout(timer);
        resolve();
      };
      this.#controlWaiters.add(settle);
      timer = setTimeout(settle, waitMs);
    });
    return { promise, cancel: () => settle() };
  }

  #wakeControlWaiters() {
    for (const settle of [...this.#controlWaiters]) settle();
  }

  #controlResultWaiter(id, waitMs) {
    let waiters = this.#controlResultWaiters.get(id);
    if (!waiters) {
      waiters = new Set();
      this.#controlResultWaiters.set(id, waiters);
    }
    let timer = null;
    let settled = false;
    let settle = null;
    const promise = new Promise((resolve) => {
      settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(settle);
        if (!waiters.size) this.#controlResultWaiters.delete(id);
        resolve();
      };
      waiters.add(settle);
      timer = setTimeout(settle, waitMs);
    });
    return { promise, cancel: () => settle() };
  }

  #wakeControlResultWaiters(id) {
    for (const settle of [...(this.#controlResultWaiters.get(id) ?? [])]) settle();
  }

  #snapshotWaiter(userId, waitMs) {
    let waiters = this.#snapshotWaiters.get(userId);
    if (!waiters) {
      waiters = new Set();
      this.#snapshotWaiters.set(userId, waiters);
    }
    let timer = null;
    let settled = false;
    let settle = null;
    const promise = new Promise((resolve) => {
      settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(settle);
        if (!waiters.size) this.#snapshotWaiters.delete(userId);
        resolve();
      };
      waiters.add(settle);
      timer = setTimeout(settle, waitMs);
    });
    return { promise, cancel: () => settle() };
  }

  #wakeSnapshotWaiters(userId) {
    for (const settle of [...(this.#snapshotWaiters.get(userId) ?? [])]) settle();
  }

  async #registerDashboardBotHub(payload) {
    const { hubId, secret, name } = dashboardBotHubRegistration(payload);
    const now = Date.now();
    const key = dashboardBotHubKey(hubId);
    const existing = await this.ctx.storage.get(key);
    if (existing && existing.secret !== secret) throw new Error("dashboard bot hub id conflict");
    if (existing?.userId) {
      existing.name = name;
      existing.updatedAt = now;
      await this.ctx.storage.put(key, existing);
      return { paired: true, userId: String(existing.userId), name };
    }
    if (existing?.pairingKey) await this.ctx.storage.delete(existing.pairingKey);
    const code = randomDashboardBotPairingCode();
    const codeHash = await sha256(code);
    const pairingKey = dashboardBotPairingKey(codeHash);
    const expiresAt = now + DASHBOARD_BOT_PAIRING_EXPIRY_MS;
    const record = {
      hubId,
      secret,
      name,
      userId: null,
      chatId: null,
      pairingKey,
      createdAt: Number(existing?.createdAt) || now,
      updatedAt: now,
    };
    await this.ctx.storage.put({
      [key]: record,
      [pairingKey]: { hubId, expiresAt },
    });
    return {
      paired: false,
      code: `${code.slice(0, 4)}-${code.slice(4)}`,
      expiresAt,
      name,
    };
  }

  async #registerExistingDashboardBotHub(payload) {
    const { hubId, secret } = dashboardBotHubRegistration(payload);
    const existing = await this.ctx.storage.get(dashboardBotHubKey(hubId));
    if (!existing) throw new Error("dashboard bot hub is not registered");
    if (existing.secret !== secret) throw new Error("dashboard bot hub id conflict");
    return this.#registerDashboardBotHub(payload);
  }

  async #exportDashboardBotHub(payload) {
    const { hubId, secret } = dashboardBotHubRegistration(payload);
    const record = await this.ctx.storage.get(dashboardBotHubKey(hubId));
    if (!record) throw new Error("dashboard bot hub is not registered");
    if (record.secret !== secret) throw new Error("dashboard bot hub id conflict");
    const userId = String(record.userId ?? "");
    const [mappedHubId, bundle, recent, pairing] = await Promise.all([
      userId ? this.ctx.storage.get(dashboardBotUserKey(userId)) : null,
      userId ? this.ctx.storage.get(dashboardBotBundleKey(userId)) : null,
      userId ? this.ctx.storage.get(dashboardBotRecentDirectKey(userId)) : null,
      record.pairingKey ? this.ctx.storage.get(record.pairingKey) : null,
    ]);
    return {
      record,
      mapped: userId && String(mappedHubId ?? "") === hubId,
      bundle: bundle?.hubId === hubId ? bundle : null,
      recent: recent?.hubId === hubId ? recent : null,
      pairing: pairing?.hubId === hubId ? pairing : null,
    };
  }

  async #importDashboardBotHub(payload) {
    const record = payload?.record;
    const { hubId, secret, name } = dashboardBotHubRegistration(record);
    const existing = await this.ctx.storage.get(dashboardBotHubKey(hubId));
    if (existing && existing.secret !== secret) throw new Error("dashboard bot hub id conflict");
    const imported = {
      ...record,
      hubId,
      secret,
      name,
      userId: record?.userId == null ? null : String(record.userId),
      chatId: record?.chatId == null ? null : String(record.chatId),
    };
    const writes = [[dashboardBotHubKey(hubId), imported]];
    if (payload?.mapped === true && imported.userId) {
      writes.push([dashboardBotUserKey(imported.userId), hubId]);
    }
    if (payload?.bundle?.hubId === hubId && String(payload.bundle.userId ?? "") === imported.userId) {
      writes.push([dashboardBotBundleKey(imported.userId), {
        ...payload.bundle,
        cardMessageId: null,
        cardPending: false,
        items: (Array.isArray(payload.bundle.items) ? payload.bundle.items : [])
          .filter((item) => String(item?.text ?? "") !== "/diagnostic_link_probe"),
      }]);
    }
    if (payload?.recent?.hubId === hubId && String(payload.recent.userId ?? "") === imported.userId) {
      writes.push([dashboardBotRecentDirectKey(imported.userId), payload.recent]);
    }
    if (imported.pairingKey && payload?.pairing?.hubId === hubId) {
      writes.push([imported.pairingKey, payload.pairing]);
    }
    await putStorageEntries(this.ctx.storage, writes);
    return { ok: true, hubId, paired: Boolean(imported.userId && imported.chatId) };
  }

  async #dashboardBotOpenCard(payload) {
    const hubId = String(payload?.hubId ?? "").trim().toLowerCase();
    if (!CONTROL_ID_PATTERN.test(hubId)) throw new Error("invalid dashboard bot hub id");
    const hub = await this.ctx.storage.get(dashboardBotHubKey(hubId));
    const userId = String(hub?.userId ?? "");
    if (!userId) return { card: null };
    const bundle = await this.ctx.storage.get(dashboardBotBundleKey(userId));
    return {
      card: bundle?.hubId === hubId ? this.#dashboardBotBundleCard(bundle) : null,
    };
  }

  async #authenticateDashboardBotHub(request) {
    const hubId = String(request.headers.get("X-Agent-Hub-Dashboard-Id") ?? "").trim().toLowerCase();
    if (!CONTROL_ID_PATTERN.test(hubId)) throw new Error("invalid dashboard bot hub id");
    const record = await this.ctx.storage.get(dashboardBotHubKey(hubId))
      ?? await this.ctx.storage.get(DASHBOARD_BOT_SERVICE_IDENTITY_KEY);
    if (record?.hubId !== hubId) throw new Error("dashboard bot hub is not registered");
    if (!record?.secret) throw new Error("dashboard bot hub is not registered");
    const body = await validateControlServiceRequest(request, record.secret);
    if (!record.userId || !record.chatId) throw new Error("dashboard bot hub is not paired");
    return {
      hubId,
      body,
      userId: String(record.userId),
      chatId: String(record.chatId),
    };
  }

  async #dashboardBotServiceIdentity(payload) {
    const hubId = String(payload?.hubId ?? "").trim().toLowerCase();
    if (!CONTROL_ID_PATTERN.test(hubId)) throw new Error("invalid dashboard bot hub id");
    const record = await this.ctx.storage.get(dashboardBotHubKey(hubId));
    if (!record?.secret) throw new Error("dashboard bot hub is not registered");
    if (!record.userId || !record.chatId) throw new Error("dashboard bot hub is not paired");
    return {
      hubId,
      secret: record.secret,
      userId: String(record.userId),
      chatId: String(record.chatId),
      updatedAt: Number(record.updatedAt) || 0,
    };
  }

  async #registerDashboardBotServiceIdentity(payload) {
    const hubId = String(payload?.hubId ?? "").trim().toLowerCase();
    const secret = String(payload?.secret ?? "").trim();
    const userId = String(payload?.userId ?? "").trim();
    const chatId = String(payload?.chatId ?? "").trim();
    const updatedAt = Math.max(0, Number(payload?.updatedAt) || 0);
    if (
      !CONTROL_ID_PATTERN.test(hubId)
      || secret.length < 32
      || secret.length > 256
      || !userId
      || !chatId
    ) {
      throw new Error("invalid dashboard bot service identity");
    }
    const existing = await this.ctx.storage.get(DASHBOARD_BOT_SERVICE_IDENTITY_KEY);
    if (Number(existing?.updatedAt ?? 0) > updatedAt) return { ok: true, updated: false };
    const identity = { hubId, secret, userId, chatId, updatedAt };
    await this.ctx.storage.put(DASHBOARD_BOT_SERVICE_IDENTITY_KEY, identity);
    return { ok: true, updated: true };
  }

  async #exportDashboardBotServiceIdentity(request, pathname) {
    if (![
      "/api/dashboard-bot/pull",
      "/api/dashboard-bot/result",
      "/api/dashboard-bot/attachment/pull",
    ].includes(pathname)) {
      throw new Error("invalid dashboard bot service path");
    }
    const hubId = String(request.headers.get("X-Agent-Hub-Dashboard-Id") ?? "").trim().toLowerCase();
    const identity = await this.#dashboardBotServiceIdentity({ hubId });
    const body = await validateControlServiceRequest(request, identity.secret, { pathname });
    return { ...identity, body };
  }

  async #linkDashboardBotHub(message, code) {
    const normalizedCode = normalizedDashboardBotPairingCode(code);
    if (!DASHBOARD_BOT_PAIRING_CODE_PATTERN.test(normalizedCode)) {
      return { reply: "Код привязки должен содержать 8 символов." };
    }
    const pairingKey = dashboardBotPairingKey(await sha256(normalizedCode));
    const pairing = await this.ctx.storage.get(pairingKey);
    const now = Date.now();
    if (!pairing || Number(pairing.expiresAt ?? 0) <= now) {
      if (pairing) await this.ctx.storage.delete(pairingKey);
      return { reply: "Код привязки недействителен или истёк. Создайте новый код в Agent Hub." };
    }
    const hubKey = dashboardBotHubKey(String(pairing.hubId));
    const hub = await this.ctx.storage.get(hubKey);
    if (!hub || hub.pairingKey !== pairingKey) {
      await this.ctx.storage.delete(pairingKey);
      return { reply: "Код привязки уже недействителен. Создайте новый код в Agent Hub." };
    }
    const userId = String(message.from.id);
    const chatId = String(message.chat.id);
    const previousHubId = String(await this.ctx.storage.get(dashboardBotUserKey(userId)) ?? "");
    const writes = [];
    if (previousHubId && previousHubId !== hub.hubId) {
      const previousKey = dashboardBotHubKey(previousHubId);
      const previousHub = await this.ctx.storage.get(previousKey);
      if (previousHub?.userId === userId) {
        previousHub.userId = null;
        previousHub.chatId = null;
        previousHub.updatedAt = now;
        writes.push([previousKey, previousHub]);
      }
    }
    if (hub.userId && String(hub.userId) !== userId) {
      await this.ctx.storage.delete(dashboardBotUserKey(String(hub.userId)));
    }
    hub.userId = userId;
    hub.chatId = chatId;
    hub.updatedAt = now;
    delete hub.pairingKey;
    writes.push([hubKey, hub], [dashboardBotUserKey(userId), hub.hubId]);
    await putStorageEntries(this.ctx.storage, writes);
    await this.ctx.storage.delete(pairingKey);
    return { reply: `Готово. Сообщения будут попадать в Dashboard «${hub.name}».` };
  }

  async #unlinkDashboardBotHub(message) {
    const userId = String(message.from.id);
    const userKey = dashboardBotUserKey(userId);
    const hubId = String(await this.ctx.storage.get(userKey) ?? "");
    if (!hubId) return { reply: "Этот Telegram ещё не привязан к Agent Hub." };
    const hubKey = dashboardBotHubKey(hubId);
    const hub = await this.ctx.storage.get(hubKey);
    if (hub?.userId === userId) {
      hub.userId = null;
      hub.chatId = null;
      hub.updatedAt = Date.now();
      await this.ctx.storage.put(hubKey, hub);
    }
    await this.ctx.storage.delete(userKey);
    return { reply: "Привязка удалена. Новые сообщения больше не попадут в Dashboard." };
  }

  async #dashboardBotLinkedHub(message) {
    const userId = String(message.from.id);
    const hubId = String(await this.ctx.storage.get(dashboardBotUserKey(userId)) ?? "");
    if (!CONTROL_ID_PATTERN.test(hubId)) {
      return { error: "Сначала привяжите Agent Hub командой /link КОД." };
    }
    const hub = await this.ctx.storage.get(dashboardBotHubKey(hubId));
    if (!hub || String(hub.userId) !== userId) {
      return { error: "Привязка Agent Hub устарела. Создайте новый код и повторите /link КОД." };
    }
    return { userId, hubId, hub };
  }

  #dashboardBotBundleCard(bundle, { warning = "", finalText = "", replace = false } = {}) {
    const messageId = Number.isSafeInteger(bundle.cardMessageId) ? bundle.cardMessageId : null;
    return {
      mode: messageId ? (replace ? "replace" : "edit") : "send",
      userId: bundle.userId,
      bundleId: bundle.id,
      chatId: bundle.chatId,
      messageId,
      text: finalText || dashboardBotBundleCardText(bundle, warning),
      replyMarkup: finalText ? { inline_keyboard: [] } : dashboardBotBundleKeyboard(bundle),
    };
  }

  async #dashboardBotAppendBundle(update, message, linked, { source, attachment, precedingComment = null }) {
    const key = dashboardBotBundleKey(linked.userId);
    let bundle = await this.ctx.storage.get(key);
    if (!bundle && !source && !attachment) return null;
    if (!bundle) {
      const now = Date.now();
      bundle = {
        id: crypto.randomUUID().toLowerCase(),
        userId: linked.userId,
        hubId: linked.hubId,
        chatId: message.chat.id,
        cardMessageId: null,
        cardPending: false,
        items: precedingComment ? [precedingComment] : [],
        createdAt: now,
        updatedAt: now,
        submitting: false,
      };
    }
    if (bundle.hubId !== linked.hubId || bundle.chatId !== message.chat.id) {
      await this.ctx.storage.delete(key);
      return { reply: "Открытая пачка относилась к другой привязке и была отменена. Перешлите сообщения ещё раз." };
    }
    if (bundle.submitting) {
      if (!dashboardBotSubmissionIsStale(bundle)) {
        return { reply: "Пачка уже отправляется. Дождитесь подтверждения." };
      }
      bundle.submitting = false;
      delete bundle.submissionStartedAt;
      bundle.updatedAt = Date.now();
      await this.ctx.storage.put(key, bundle);
      return {
        reply: "Предыдущая отправка не была подтверждена. Новое сообщение не добавлено: повторите отправку пачки или отмените её, затем перешлите сообщение ещё раз.",
        card: this.#dashboardBotBundleCard(bundle, {
          warning: "Предыдущая отправка не подтверждена. Пачка сохранена: её можно отправить повторно или отменить.",
        }),
      };
    }
    if (bundle.items.some((item) => item.messageId === message.message_id)) {
      if (Number.isSafeInteger(bundle.cardMessageId)) return { card: this.#dashboardBotBundleCard(bundle) };
      if (bundle.cardPending) return { ignored: true };
      bundle.cardPending = true;
      await this.ctx.storage.put(key, bundle);
      return { card: this.#dashboardBotBundleCard(bundle) };
    }
    const text = String(message.text ?? message.caption ?? "").trim();
    const totalChars = bundle.items.reduce((sum, item) => sum + String(item.text ?? "").length, 0);
    const totalAttachments = bundle.items.reduce(
      (sum, item) => sum + dashboardBotItemAttachments(item).length,
      0,
    );
    if (
      bundle.items.length >= DASHBOARD_BOT_BUNDLE_MAX_ITEMS
      || totalChars + text.length > DASHBOARD_BOT_BUNDLE_MAX_CHARS
      || totalAttachments + (attachment ? 1 : 0) > MAX_ATTACHMENTS_PER_COMMAND
    ) {
      return { card: this.#dashboardBotBundleCard(bundle, {
        warning: "Лимит пачки достигнут (до 100 сообщений и 8 файлов). Отправьте её или отмените.",
      }) };
    }
    bundle.items.push({
      updateId: update.update_id,
      messageId: message.message_id,
      replyToMessageId: Number.isSafeInteger(message.reply_to_message?.message_id)
        ? message.reply_to_message.message_id
        : null,
      kind: source ? "forward" : "comment",
      source,
      text,
      attachments: attachment ? [attachment] : [],
      createdAt: Number(message.date) > 0 ? Number(message.date) * 1_000 : Date.now(),
    });
    bundle.updatedAt = Date.now();
    let card = null;
    if (Number.isSafeInteger(bundle.cardMessageId)) {
      card = this.#dashboardBotBundleCard(bundle, { replace: true });
    }
    else if (!bundle.cardPending) {
      bundle.cardPending = true;
      card = this.#dashboardBotBundleCard(bundle);
    }
    await this.ctx.storage.put(key, bundle);
    return card ? { card } : { ignored: true };
  }

  async #dashboardBotSubmitBundle(userId, expectedId = "", { separate = false } = {}) {
    const key = dashboardBotBundleKey(userId);
    const bundle = await this.ctx.storage.get(key);
    if (!bundle) return { reply: "Открытая пачка не найдена." };
    if (expectedId && bundle.id !== expectedId) {
      return { reply: "Эта пачка уже закрыта. Используйте кнопки у последней карточки." };
    }
    if (bundle.submitting && !dashboardBotSubmissionIsStale(bundle)) {
      return { reply: "Пачка уже отправляется. Дождитесь подтверждения." };
    }
    const now = Date.now();
    bundle.submitting = true;
    bundle.submissionStartedAt = now;
    bundle.updatedAt = now;
    await this.ctx.storage.put(key, bundle);
    const groups = separate ? dashboardBotSeparatedGroups(bundle) : [{ items: bundle.items }];
    const commands = groups.map((group, index) => {
      const telegramAttachments = group.items.flatMap(dashboardBotItemAttachments);
      return {
        hubId: bundle.hubId,
        telegramAttachments,
        command: {
          id: crypto.randomUUID().toLowerCase(),
          action: "board-task-ingest",
          params: {
            text: dashboardBotBundleText(group),
            mergeMessageId: group.items.find((item) => Number.isSafeInteger(item.existingTaskMessageId))
              ?.existingTaskMessageId,
            sourceKey: separate
              ? `shared-dashboard:${bundle.id}:${index + 1}`
              : `shared-dashboard:${bundle.id}`,
            sourceDetails: {
              bundleId: bundle.id,
              chatId: bundle.chatId,
              userId: Number(bundle.userId),
              messageCount: group.items.length,
              bundleMessageCount: bundle.items.length,
              attachmentCount: telegramAttachments.length,
              attachmentKinds: telegramAttachments.map((item) => item.type),
              separate,
              separateIndex: separate ? index + 1 : null,
              items: group.items.map((item) => ({
                updateId: item.updateId,
                messageId: item.messageId,
                replyToMessageId: item.replyToMessageId,
                kind: item.kind,
                source: item.source,
                attachmentCount: dashboardBotItemAttachments(item).length,
              })),
            },
          },
          userId: bundle.userId,
        },
      };
    });
    return {
      commands,
      submittedBundle: {
        userId: bundle.userId,
        id: bundle.id,
        itemCount: bundle.items.length,
        taskCount: commands.length,
        separate,
      },
      card: this.#dashboardBotBundleCard(bundle, {
        finalText: separate
          ? `⏳ Отправляю ${commands.length} отдельных задач…`
          : `⏳ Отправляю пачку из ${bundle.items.length} сообщений…`,
      }),
    };
  }

  async #dashboardBotBundleCallback(update) {
    const query = update.callback_query;
    const match = DASHBOARD_BOT_BUNDLE_CALLBACK_PATTERN.exec(String(query?.data ?? ""));
    if (
      !match
      || !Number.isSafeInteger(query?.from?.id)
      || query.from.is_bot === true
      || query.message?.chat?.type !== "private"
    ) {
      return { ignored: true };
    }
    const linked = await this.#dashboardBotLinkedHub({ from: query.from });
    if (linked.error) return { callbackQueryId: query.id, callbackText: linked.error };
    const userId = linked.userId;
    const action = match[1].toLowerCase();
    const id = match[2].toLowerCase();
    if (["send", "separate"].includes(action)) {
      return {
        callbackQueryId: query.id,
        ...await this.#dashboardBotSubmitBundle(userId, id, { separate: action === "separate" }),
      };
    }
    const key = dashboardBotBundleKey(userId);
    const bundle = await this.ctx.storage.get(key);
    if (!bundle || bundle.id !== id) {
      return { callbackQueryId: query.id, callbackText: "Пачка уже закрыта." };
    }
    if (action === "cancel") {
      if (bundle.submitting && !dashboardBotSubmissionIsStale(bundle)) {
        return { callbackQueryId: query.id, callbackText: "Отправка ещё выполняется. Дождитесь подтверждения." };
      }
      const submissionWasAmbiguous = bundle.submitting === true;
      await this.ctx.storage.delete(key);
      return {
        callbackQueryId: query.id,
        callbackText: submissionWasAmbiguous ? "Зависшая пачка закрыта." : "Пачка отменена.",
        card: this.#dashboardBotBundleCard(bundle, {
          finalText: submissionWasAmbiguous
            ? "⚠️ Зависшая пачка закрыта. Её прежняя отправка не была подтверждена и ещё может завершиться отдельно."
            : "❌ Сбор пачки отменён.",
        }),
      };
    }
    return { callbackQueryId: query.id, callbackText: "Неизвестное действие." };
  }

  async #routeDashboardBotUpdate(update) {
    if (update?.callback_query) return this.#dashboardBotBundleCallback(update);
    const message = update?.message;
    if (
      !Number.isSafeInteger(update?.update_id)
      || !message
      || message.chat?.type !== "private"
      || !Number.isSafeInteger(message.chat?.id)
      || !Number.isSafeInteger(message.from?.id)
      || message.from?.is_bot === true
    ) {
      return { ignored: true };
    }
    const text = String(message.text ?? message.caption ?? "").trim();
    if (/^\/start(?:@\w+)?(?:\s|$)/iu.test(text)) {
      return { reply: "Это общий бот Dashboard. В Agent Hub создайте код привязки и отправьте /link КОД." };
    }
    if (/^\/help(?:@\w+)?(?:\s|$)/iu.test(text)) {
      return { reply: "Перешлите сообщения, голосовые или любые файлы: бот соберёт их в одну пачку. Ваши ответы до отправки станут уточнениями. Завершите её кнопкой «Отправить пачку» (/done) либо создайте отдельные задачи кнопкой «Отправить раздельно» (/separate); /cancel отменяет пачку." };
    }
    const link = text.match(/^\/link(?:@\w+)?\s+(.+)$/iu);
    if (link) return this.#linkDashboardBotHub(message, link[1]);
    if (/^\/unlink(?:@\w+)?(?:\s|$)/iu.test(text)) return this.#unlinkDashboardBotHub(message);
    const linked = await this.#dashboardBotLinkedHub(message);
    if (linked.error) return { reply: linked.error };
    const openBundle = await this.ctx.storage.get(dashboardBotBundleKey(linked.userId));
    if (/^\/(?:done|send)(?:@\w+)?(?:\s|$)/iu.test(text)) {
      return this.#dashboardBotSubmitBundle(linked.userId);
    }
    if (/^\/separate(?:@\w+)?(?:\s|$)/iu.test(text)) {
      return this.#dashboardBotSubmitBundle(linked.userId, "", { separate: true });
    }
    if (/^\/cancel(?:@\w+)?(?:\s|$)/iu.test(text)) {
      if (!openBundle) return { reply: "Открытая пачка не найдена." };
      if (openBundle.submitting && !dashboardBotSubmissionIsStale(openBundle)) {
        return { reply: "Отправка ещё выполняется. Дождитесь подтверждения." };
      }
      const submissionWasAmbiguous = openBundle.submitting === true;
      await this.ctx.storage.delete(dashboardBotBundleKey(linked.userId));
      return {
        card: this.#dashboardBotBundleCard(openBundle, {
          finalText: submissionWasAmbiguous
            ? "⚠️ Зависшая пачка закрыта. Её прежняя отправка не была подтверждена и ещё может завершиться отдельно."
            : "❌ Сбор пачки отменён.",
        }),
      };
    }
    const source = dashboardBotForwardedMessageSource(message);
    const attachment = dashboardBotAttachmentDescriptor(message);
    const repliedMessageId = Number.isSafeInteger(message.reply_to_message?.message_id)
      ? message.reply_to_message.message_id
      : null;
    const repliesToOwnMessage = repliedMessageId != null
      && String(message.reply_to_message?.from?.id ?? "") === String(message.from.id);
    if (!openBundle && repliesToOwnMessage && (text || attachment)) {
      await this.ctx.storage.delete(dashboardBotRecentDirectKey(linked.userId));
      return {
        hubId: linked.hubId,
        telegramAttachments: attachment ? [attachment] : [],
        command: {
          id: crypto.randomUUID().toLowerCase(),
          action: "board-task-ingest",
          params: {
            replyMessageId: repliedMessageId,
            ...(text ? { text } : {}),
            sourceDetails: {
              updateId: update.update_id,
              chatId: message.chat.id,
              messageId: message.message_id,
              replyToMessageId: repliedMessageId,
              userId: message.from.id,
              attachmentKinds: attachment ? [attachment.type] : [],
            },
          },
          userId: linked.userId,
        },
        reply: text
          ? attachment
            ? "⏳ Уточнение и файл поставлены в очередь Agent Hub."
            : "⏳ Уточнение поставлено в очередь Agent Hub."
          : "⏳ Файл поставлен в очередь Agent Hub.",
      };
    }
    if (source || openBundle || attachment) {
      if (!text && !attachment) return { reply: "В пачку можно добавить текст, голосовое сообщение или файл." };
      let precedingComment = null;
      if (!openBundle && (source || attachment)) {
        const recentKey = dashboardBotRecentDirectKey(linked.userId);
        const recent = await this.ctx.storage.get(recentKey);
        precedingComment = dashboardBotPrecedingComment(recent, message, linked);
        await this.ctx.storage.delete(recentKey);
      }
      return this.#dashboardBotAppendBundle(update, message, linked, { source, attachment, precedingComment });
    }
    const task = text.match(/^\/task(?:@\w+)?\s+(.+)$/iu);
    const taskText = String(task?.[1] ?? text).trim();
    if (!taskText) return { reply: "Отправьте текст или начните пачку пересланным сообщением." };
    if (taskText.startsWith("/")) return { reply: "Неизвестная команда. Используйте /help." };
    const command = {
      id: crypto.randomUUID().toLowerCase(),
      action: "board-task-ingest",
      params: {
        text: taskText,
        sourceKey: `shared-dashboard:${update.update_id}`,
        sourceDetails: {
          updateId: update.update_id,
          chatId: message.chat.id,
          messageId: message.message_id,
          userId: Number(linked.userId),
        },
      },
      userId: linked.userId,
    };
    await this.ctx.storage.put(dashboardBotRecentDirectKey(linked.userId), {
      hubId: linked.hubId,
      chatId: message.chat.id,
      userId: linked.userId,
      updateId: update.update_id,
      messageId: message.message_id,
      text: taskText,
      createdAt: Number(message.date) > 0 ? Number(message.date) * 1_000 : Date.now(),
    });
    return {
      hubId: linked.hubId,
      command,
      reply: "⏳ Поставлено в очередь Agent Hub. Подтверждение придёт после создания карточки.",
    };
  }

  async #setDashboardBotBundleCard(payload) {
    const userId = String(payload?.userId ?? "");
    const id = String(payload?.id ?? "").toLowerCase();
    const key = dashboardBotBundleKey(userId);
    const bundle = await this.ctx.storage.get(key);
    if (!bundle || bundle.id !== id) return { ok: false };
    if (payload?.failed === true) {
      bundle.cardPending = false;
      bundle.cardMessageId = null;
      await this.ctx.storage.put(key, bundle);
      return { ok: true };
    }
    const messageId = Number(payload?.messageId);
    if (!Number.isSafeInteger(messageId)) return { ok: false };
    bundle.cardMessageId = messageId;
    bundle.cardPending = false;
    bundle.updatedAt = Date.now();
    await this.ctx.storage.put(key, bundle);
    return { ok: true, card: this.#dashboardBotBundleCard(bundle) };
  }

  async #finalizeDashboardBotBundle(payload) {
    const userId = String(payload?.userId ?? "");
    const id = String(payload?.id ?? "").toLowerCase();
    const key = dashboardBotBundleKey(userId);
    const bundle = await this.ctx.storage.get(key);
    if (!bundle || bundle.id !== id) return { ok: false };
    if (payload?.submitted === true) {
      await this.ctx.storage.delete(key);
      return { ok: true };
    }
    bundle.submitting = false;
    delete bundle.submissionStartedAt;
    bundle.updatedAt = Date.now();
    await this.ctx.storage.put(key, bundle);
    return {
      ok: true,
      card: this.#dashboardBotBundleCard(bundle, {
        warning: String(payload?.error ?? "Пачка временно не отправлена. Попробуйте ещё раз.").slice(0, 300),
      }),
    };
  }

  async #storedSnapshot(userId) {
    if (this.#snapshotCache.has(userId)) return this.#snapshotCache.get(userId);
    const snapshot = await this.ctx.storage.get(clientSnapshotKey(userId));
    if (snapshot) this.#snapshotCache.set(userId, snapshot);
    return snapshot ?? null;
  }

  async #pushSnapshot(payload) {
    const userId = String(payload?.userId ?? "").trim();
    const snapshot = payload?.snapshot;
    if (!userId || !snapshot || typeof snapshot !== "object" || !String(snapshot.version ?? "")) {
      throw new Error("invalid client snapshot");
    }
    await this.ctx.storage.put(clientSnapshotKey(userId), snapshot);
    this.#snapshotCache.set(userId, snapshot);
    this.#wakeSnapshotWaiters(userId);
    return { ok: true, version: String(snapshot.version) };
  }

  async #readSnapshot(payload) {
    const token = String(payload?.token ?? "").trim();
    const userId = token
      ? String((await this.#resolveDeviceSession({ token })).id)
      : String(payload?.userId ?? "").trim();
    if (!userId) throw new Error("invalid snapshot user");
    const knownVersion = String(payload?.knownVersion ?? "").slice(0, 128);
    const waitMs = Math.min(MAX_CONTROL_WAIT_MS, Math.max(0, Number(payload?.waitMs) || 0));
    const waiter = knownVersion && waitMs > 0 ? this.#snapshotWaiter(userId, waitMs) : null;
    try {
      let snapshot = await this.#storedSnapshot(userId);
      if (!snapshot) throw new Error("Снимок Agent Hub ещё не опубликован.");
      if (knownVersion === String(snapshot.version) && waiter) {
        await waiter.promise;
        snapshot = await this.#storedSnapshot(userId);
      }
      if (knownVersion && knownVersion === String(snapshot?.version ?? "")) {
        return { notModified: true, version: knownVersion };
      }
      return snapshot;
    } finally {
      waiter?.cancel();
    }
  }

  #publicDevice(record) {
    return {
      id: record.id,
      name: record.name,
      platform: record.platform,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt ?? null,
      revokedAt: record.revokedAt ?? null,
    };
  }

  async #cleanupDeviceAuth(now = Date.now(), storage = this.ctx.storage) {
    const prefixes = ["device:pairing:", "device:challenge:", "device:session:"];
    for (const prefix of prefixes) {
      const values = await storage.list({ prefix });
      const expired = [...values]
        .filter(([, value]) => Number(value?.expiresAt ?? 0) <= now)
        .map(([key]) => key);
      if (expired.length) await deleteStorageKeys(storage, expired);
    }
  }

  async #createDevicePairing(payload) {
    const userId = String(payload?.userId ?? "").trim();
    if (!userId) throw new Error("invalid device user");
    const suppliedCode = normalizedDeviceCode(payload?.code);
    if (suppliedCode && !DEVICE_CODE_PATTERN.test(suppliedCode)) {
      throw new Error("invalid pairing code");
    }
    const now = Date.now();
    await this.#cleanupDeviceAuth(now);
    const code = suppliedCode || randomPairingCode();
    const codeHash = await sha256(code);
    const expiresAt = now + DEVICE_PAIRING_EXPIRY_MS;
    await this.ctx.storage.put(`device:pairing:${codeHash}`, { userId, createdAt: now, expiresAt });
    return {
      code: code.match(/.{1,5}/gu).join("-"),
      expiresAt,
    };
  }

  async #pairDevice(payload) {
    const code = normalizedDeviceCode(payload?.code);
    if (!DEVICE_CODE_PATTERN.test(code)) throw new Error("invalid pairing code");
    const name = normalizedDeviceName(payload?.name);
    const platform = String(payload?.platform ?? "Android").trim().slice(0, 40) || "Android";
    const publicKey = String(payload?.publicKey ?? "").trim();
    await importDevicePublicKey(publicKey);
    const codeHash = await sha256(code);
    const now = Date.now();
    const pairingKey = `device:pairing:${codeHash}`;
    const pairing = await this.ctx.storage.get(pairingKey);
    if (!pairing || Number(pairing.expiresAt ?? 0) <= now) {
      if (pairing) await this.ctx.storage.delete(pairingKey);
      throw new Error("pairing code is invalid or expired");
    }
    const id = crypto.randomUUID().toLowerCase();
    const record = {
      id,
      userId: String(pairing.userId),
      name,
      platform,
      publicKey,
      createdAt: now,
      lastSeenAt: null,
      revokedAt: null,
    };
    await this.ctx.storage.put(`device:record:${id}`, record);
    await this.ctx.storage.delete(pairingKey);
    return { device: this.#publicDevice(record) };
  }

  async #createDeviceChallenge(payload) {
    const deviceId = String(payload?.deviceId ?? "").trim().toLowerCase();
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("invalid device id");
    // The origin is supplied by the Worker from the request it served, never by
    // the client body, so a relayed challenge keeps the real verifier name.
    const origin = deviceVerifierOrigin(payload?.origin);
    const record = await this.ctx.storage.get(`device:record:${deviceId}`);
    if (!record || record.revokedAt) throw new Error("device is not trusted");
    const now = Date.now();
    await this.#cleanupDeviceAuth(now);
    const challengeId = crypto.randomUUID().toLowerCase();
    const challenge = base64Url(randomBytes(32));
    const expiresAt = now + DEVICE_CHALLENGE_EXPIRY_MS;
    await this.ctx.storage.put(`device:challenge:${challengeId}`, {
      deviceId,
      challenge,
      expiresAt,
      origin,
    });
    return { challengeId, challenge, expiresAt };
  }

  async #createDeviceSession(payload) {
    const deviceId = String(payload?.deviceId ?? "").trim().toLowerCase();
    const challengeId = String(payload?.challengeId ?? "").trim().toLowerCase();
    const signature = String(payload?.signature ?? "").trim();
    if (!DEVICE_ID_PATTERN.test(deviceId) || !CONTROL_ID_PATTERN.test(challengeId)) {
      throw new Error("invalid device challenge");
    }
    if (!DEVICE_SIGNATURE_PATTERN.test(signature)) throw new Error("invalid device signature");
    const now = Date.now();
    const challengeKey = `device:challenge:${challengeId}`;
    const [record, challenge] = await Promise.all([
      this.ctx.storage.get(`device:record:${deviceId}`),
      this.ctx.storage.get(challengeKey),
    ]);
    if (!record || record.revokedAt) throw new Error("device is not trusted");
    if (!challenge || challenge.deviceId !== deviceId || Number(challenge.expiresAt ?? 0) <= now) {
      if (challenge) await this.ctx.storage.delete(challengeKey);
      throw new Error("device challenge is invalid or expired");
    }
    const key = await importDevicePublicKey(record.publicKey);
    const verify = (message) => crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      bytesFromBase64Url(signature),
      encoder.encode(message),
    );
    const signed = {
      origin: String(challenge.origin ?? ""),
      deviceId,
      challengeId,
      challenge: challenge.challenge,
    };
    const valid = await verify(deviceSessionMessage(signed))
      || (String(this.env?.ALLOW_LEGACY_DEVICE_SESSIONS ?? "") === "1"
        && await verify(legacyDeviceSessionMessage(signed)));
    await this.ctx.storage.delete(challengeKey);
    if (!valid) throw new Error("invalid device signature");
    const token = base64Url(randomBytes(32));
    const tokenHash = await sha256(token);
    const expiresAt = now + DEVICE_SESSION_EXPIRY_MS;
    record.lastSeenAt = now;
    await this.ctx.storage.put({
      [`device:record:${deviceId}`]: record,
      [`device:session:${tokenHash}`]: {
        deviceId,
        userId: String(record.userId),
        createdAt: now,
        expiresAt,
      },
    });
    return { token, expiresAt, device: this.#publicDevice(record) };
  }

  async #resolveDeviceSession(payload) {
    const token = String(payload?.token ?? "").trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("invalid device session");
    const tokenHash = await sha256(token);
    const sessionKey = `device:session:${tokenHash}`;
    const session = await this.ctx.storage.get(sessionKey);
    const now = Date.now();
    if (!session || Number(session.expiresAt ?? 0) <= now) {
      if (session) await this.ctx.storage.delete(sessionKey);
      throw new Error("device session is invalid or expired");
    }
    const record = await this.ctx.storage.get(`device:record:${session.deviceId}`);
    if (!record || record.revokedAt) {
      await this.ctx.storage.delete(sessionKey);
      throw new Error("device is not trusted");
    }
    if (!record.lastSeenAt || now - record.lastSeenAt >= 5 * 60 * 1_000) {
      record.lastSeenAt = now;
      await this.ctx.storage.put(`device:record:${record.id}`, record);
    }
    return { id: String(session.userId), deviceId: record.id, deviceName: record.name };
  }

  async #listDevices(payload) {
    const userId = String(payload?.userId ?? "").trim();
    if (!userId) throw new Error("invalid device user");
    const records = [...(await this.ctx.storage.list({ prefix: "device:record:" })).values()]
      .filter((record) => String(record?.userId ?? "") === userId)
      .sort((left, right) => Number(right.lastSeenAt ?? right.createdAt ?? 0) - Number(left.lastSeenAt ?? left.createdAt ?? 0));
    return { devices: records.map((record) => this.#publicDevice(record)) };
  }

  async #importDevices(payload) {
    const userId = String(payload?.userId ?? "").trim();
    const devices = Array.isArray(payload?.devices) ? payload.devices : null;
    if (!userId || !devices || devices.length > 100) throw new Error("invalid device import");
    const records = [];
    for (const value of devices) {
      const id = String(value?.id ?? "").trim().toLowerCase();
      const recordUserId = String(value?.userId ?? "").trim();
      const name = normalizedDeviceName(value?.name);
      const platform = String(value?.platform ?? "Browser").trim().slice(0, 40) || "Browser";
      const publicKey = String(value?.publicKey ?? "").trim();
      const createdAt = Number(value?.createdAt);
      const lastSeenAt = value?.lastSeenAt == null ? null : Number(value.lastSeenAt);
      if (
        !DEVICE_ID_PATTERN.test(id)
        || recordUserId !== userId
        || !Number.isSafeInteger(createdAt)
        || createdAt < 1
        || (lastSeenAt != null && (!Number.isSafeInteger(lastSeenAt) || lastSeenAt < createdAt))
        || value?.revokedAt != null
      ) {
        throw new Error("invalid device import");
      }
      await importDevicePublicKey(publicKey);
      records.push({ id, userId, name, platform, publicKey, createdAt, lastSeenAt, revokedAt: null });
    }
    const keys = records.map((record) => `device:record:${record.id}`);
    const existing = keys.length ? await this.ctx.storage.get(keys) : new Map();
    const writes = [];
    for (const [index, record] of records.entries()) {
      const current = existing.get(keys[index]);
      if (current && (String(current.userId) !== userId || current.publicKey !== record.publicKey)) {
        throw new Error("device import conflict");
      }
      if (!current) writes.push([keys[index], record]);
    }
    if (writes.length) await putStorageEntries(this.ctx.storage, writes);
    return { imported: writes.length, existing: records.length - writes.length };
  }

  async #revokeDevice(payload) {
    const userId = String(payload?.userId ?? "").trim();
    const deviceId = String(payload?.deviceId ?? "").trim().toLowerCase();
    if (!userId || !DEVICE_ID_PATTERN.test(deviceId)) throw new Error("invalid device revoke request");
    const recordKey = `device:record:${deviceId}`;
    const record = await this.ctx.storage.get(recordKey);
    if (!record || String(record.userId) !== userId) throw new Error("device not found");
    const now = Date.now();
    record.revokedAt = now;
    const sessions = await this.ctx.storage.list({ prefix: "device:session:" });
    const sessionKeys = [...sessions]
      .filter(([, session]) => session?.deviceId === deviceId)
      .map(([key]) => key);
    await this.ctx.storage.put(recordKey, record);
    if (sessionKeys.length) await deleteStorageKeys(this.ctx.storage, sessionKeys);
    return { device: this.#publicDevice(record) };
  }

  async #deleteDevices(payload) {
    const userId = String(payload?.userId ?? "").trim();
    const deviceIds = [...new Set((Array.isArray(payload?.deviceIds) ? payload.deviceIds : [])
      .map((value) => String(value).trim().toLowerCase()))];
    if (!userId || !deviceIds.length || deviceIds.length > 100
      || deviceIds.some((deviceId) => !DEVICE_ID_PATTERN.test(deviceId))) {
      throw new Error("invalid device delete request");
    }
    const recordKeys = deviceIds.map((deviceId) => `device:record:${deviceId}`);
    const records = await this.ctx.storage.get(recordKeys);
    for (const key of recordKeys) {
      const record = records.get(key);
      if (!record || String(record.userId) !== userId || !record.revokedAt) {
        throw new Error("only revoked devices can be deleted");
      }
    }
    const [sessions, challenges] = await Promise.all([
      this.ctx.storage.list({ prefix: "device:session:" }),
      this.ctx.storage.list({ prefix: "device:challenge:" }),
    ]);
    const selected = new Set(deviceIds);
    await deleteStorageKeys(this.ctx.storage, [
      ...recordKeys,
      ...[...sessions].filter(([, value]) => selected.has(value?.deviceId)).map(([key]) => key),
      ...[...challenges].filter(([, value]) => selected.has(value?.deviceId)).map(([key]) => key),
    ]);
    return { deleted: deviceIds.length };
  }

  async #ensureControlIndex(storage = this.ctx.storage, now = Date.now()) {
    if (Number(await storage.get(CONTROL_INDEX_VERSION_KEY)) === CONTROL_INDEX_VERSION) return;
    const legacy = await storage.list({ prefix: "control:command:" });
    const writes = [[CONTROL_INDEX_VERSION_KEY, CONTROL_INDEX_VERSION]];
    const deletes = [];
    let activeCount = 0;
    for (const [key, command] of legacy) {
      if (!command?.id || Number(command.expiresAt ?? 0) <= now) {
        deletes.push(key);
        continue;
      }
      command.expiryKey = controlExpiryKey(command);
      writes.push([command.expiryKey, { id: command.id }]);
      if (!["completed", "failed"].includes(command.status)) {
        activeCount += 1;
        const availableAt = command.status === "running"
          ? Math.max(now, Number(command.leaseExpiresAt ?? 0))
          : now;
        command.availabilityKey = controlAvailableKey(command, availableAt);
        writes.push([command.availabilityKey, { id: command.id }]);
      } else {
        delete command.availabilityKey;
      }
      writes.push([key, command]);
    }
    writes.push([CONTROL_ACTIVE_COUNT_KEY, activeCount]);
    await putStorageEntries(storage, writes);
    if (deletes.length) await deleteStorageKeys(storage, deletes);
  }

  async #cleanupExpiredControlCommands(now = Date.now(), storage = this.ctx.storage) {
    await this.#ensureControlIndex(storage, now);
    const markers = await storage.list({
      prefix: CONTROL_EXPIRY_PREFIX,
      end: timedControlRangeEnd(CONTROL_EXPIRY_PREFIX, now),
      limit: STORAGE_DELETE_BATCH_SIZE,
    });
    if (!markers.size) return 0;
    const markerEntries = [...markers];
    const keys = markerEntries.map(([, value]) => controlCommandKey(String(value?.id ?? "")));
    const commands = await storage.get(keys);
    const deletes = markerEntries.map(([key]) => key);
    let activeCount = Number(await storage.get(CONTROL_ACTIVE_COUNT_KEY)) || 0;
    for (const [index, key] of keys.entries()) {
      const command = commands.get(key);
      const markerKey = markerEntries[index][0];
      if (!command || command.expiryKey !== markerKey) continue;
      deletes.push(key, command.availabilityKey);
      if (!["completed", "failed"].includes(command.status)) activeCount = Math.max(0, activeCount - 1);
    }
    await deleteStorageKeys(storage, deletes);
    await storage.put(CONTROL_ACTIVE_COUNT_KEY, activeCount);
    return markers.size;
  }

  async #attachmentManifests(storage = this.ctx.storage) {
    return [...(await storage.list({ prefix: "control:attachment:" })).values()];
  }

  async #deleteAttachment(manifest, storage = this.ctx.storage) {
    await storage.delete([
      `control:attachment:${manifest.id}`,
      ...Array.from(
        { length: Number(manifest.chunkCount) || 0 },
        (_, index) => `control:attachment-chunk:${manifest.id}:${index}`,
      ),
    ]);
  }

  async #cleanupAttachments(now = Date.now(), storage = this.ctx.storage) {
    const manifests = await this.#attachmentManifests(storage);
    const active = [];
    for (const manifest of manifests) {
      if (Number(manifest?.expiresAt ?? 0) <= now) await this.#deleteAttachment(manifest, storage);
      else active.push(manifest);
    }
    return active;
  }

  async #attachmentTransportChunk(manifest, index, storageChunks = null) {
    const count = attachmentTransportChunkCount(manifest.size);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
      throw new RangeError("invalid attachment chunk index");
    }
    const absoluteOffset = index * ATTACHMENT_TRANSPORT_CHUNK_BYTES;
    const storageIndex = Math.floor(absoluteOffset / ATTACHMENT_STORAGE_CHUNK_BYTES);
    const storageOffset = absoluteOffset % ATTACHMENT_STORAGE_CHUNK_BYTES;
    const storageKey = `control:attachment-chunk:${manifest.id}:${storageIndex}`;
    let stored = storageChunks?.get(storageIndex);
    if (stored == null) {
      stored = await this.ctx.storage.get(storageKey);
      if (stored != null) storageChunks?.set(storageIndex, stored);
    }
    const size = attachmentTransportChunkSize(manifest.size, index);
    const source = stored == null ? null : new Uint8Array(stored);
    if (!source || size < 1 || storageOffset + size > source.byteLength) {
      throw new Error("remote attachment is incomplete");
    }
    return source.slice(storageOffset, storageOffset + size);
  }

  async #attachmentTransportResponse(manifest, payload) {
    const metadata = {
      id: manifest.id,
      size: Number(manifest.size),
      hash: String(manifest.bodyHash),
      contentType: String(manifest.contentType),
      name: String(manifest.name),
    };
    if (
      !Number.isSafeInteger(metadata.size)
      || metadata.size < 1
      || metadata.size > MAX_ATTACHMENT_BYTES
      || !/^[a-f0-9]{64}$/u.test(metadata.hash)
    ) {
      return json({ error: "remote attachment metadata is invalid" }, 503);
    }
    if (payload.mode === "manifest") {
      try {
        const storageChunks = new Map();
        return attachmentTransportJson(await attachmentTransportManifestPage(
          metadata,
          Number(payload.page ?? 0),
          (index) => this.#attachmentTransportChunk(manifest, index, storageChunks),
        ));
      } catch (error) {
        return json({ error: error.message }, error instanceof RangeError ? 400 : 503);
      }
    }
    if (payload.mode === "chunk") {
      try {
        const index = Number(payload.index);
        const body = await this.#attachmentTransportChunk(manifest, index);
        return attachmentTransportChunkResponse(metadata, {
          index,
          size: body.byteLength,
          hash: await sha256(body),
        }, body);
      } catch (error) {
        return json({ error: error.message }, error instanceof RangeError ? 400 : 503);
      }
    }
    return json({ error: "invalid attachment transport mode" }, 400);
  }

  async #claimControlCommands(limit) {
    const now = Date.now();
    return this.ctx.storage.transaction(async (storage) => {
      await this.#cleanupExpiredControlCommands(now, storage);
      const markers = await storage.list({
        prefix: CONTROL_AVAILABLE_PREFIX,
        end: timedControlRangeEnd(CONTROL_AVAILABLE_PREFIX, now),
        limit: Math.max(20, limit * 2),
      });
      const markerEntries = [...markers];
      const keys = markerEntries.map(([, value]) => controlCommandKey(String(value?.id ?? "")));
      const stored = keys.length ? await storage.get(keys) : new Map();
      const commands = [];
      const writes = [];
      const deletes = [];
      for (const [index, [markerKey]] of markerEntries.entries()) {
        const key = keys[index];
        const command = stored.get(key);
        if (!command || command.availabilityKey !== markerKey) {
          deletes.push(markerKey);
          continue;
        }
        if (["completed", "failed"].includes(command.status) || Number(command.expiresAt ?? 0) <= now) {
          deletes.push(markerKey);
          continue;
        }
        if (commands.length >= limit) break;
        command.status = "running";
        command.updatedAt = now;
        command.leaseExpiresAt = now + CONTROL_LEASE_MS;
        command.deliveryAttempt = Math.max(0, Number(command.deliveryAttempt) || 0) + 1;
        deletes.push(markerKey);
        command.availabilityKey = controlAvailableKey(command, command.leaseExpiresAt);
        writes.push([key, command], [command.availabilityKey, { id: command.id }]);
        commands.push(command);
      }
      if (writes.length) await putStorageEntries(storage, writes);
      if (deletes.length) await deleteStorageKeys(storage, deletes);
      return commands.map((command) => ({
        id: command.id,
        userId: command.userId,
        action: command.action,
        params: command.params,
        createdAt: command.createdAt,
        expiresAt: command.expiresAt,
      }));
    });
  }

  async #cleanupSyncStaging(now = Date.now(), storage = this.ctx.storage) {
    const [current, staged] = await Promise.all([
      storage.get("journal-manifest"),
      storage.list({ prefix: "staging:" }),
    ]);
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [metadataKey, metadata] of staged) {
      const syncId = String(metadata?.syncId ?? metadataKey.slice("staging:".length));
      if (syncId && syncId === String(current?.syncId ?? "")) {
        await storage.delete(metadataKey);
        continue;
      }
      const expiresAt = Number(metadata?.expiresAt ?? 0);
      if (Number.isFinite(expiresAt) && expiresAt > now) {
        nextExpiry = Math.min(nextExpiry, expiresAt);
        continue;
      }
      const chunks = syncId
        ? await storage.list({ prefix: `chunk:${syncId}:` })
        : new Map();
      await deleteStorageKeys(storage, [metadataKey, ...chunks.keys()]);
    }
    return nextExpiry;
  }

  async #scheduleCleanupAlarm(expiresAt) {
    if (!Number.isFinite(expiresAt)) return;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || expiresAt < currentAlarm) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  async #nextControlExpiry(storage = this.ctx.storage) {
    const markers = await storage.list({ prefix: CONTROL_EXPIRY_PREFIX, limit: 1 });
    const key = markers.keys().next().value;
    if (!key) return Number.POSITIVE_INFINITY;
    const expiresAt = Number(String(key).slice(CONTROL_EXPIRY_PREFIX.length, CONTROL_EXPIRY_PREFIX.length + 16));
    return Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY;
  }

  async alarm() {
    const nextSyncExpiry = await this.#cleanupSyncStaging();
    await this.ctx.storage.transaction((storage) => this.#cleanupExpiredControlCommands(Date.now(), storage));
    const nextControlExpiry = await this.#nextControlExpiry();
    const nextExpiry = Math.min(nextSyncExpiry, nextControlExpiry);
    if (Number.isFinite(nextExpiry)) await this.ctx.storage.setAlarm(nextExpiry);
    else await this.ctx.storage.deleteAlarm();
  }

  #controlStatus(command) {
    const payload = {
      id: command.id,
      status: command.status,
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
      expiresAt: command.expiresAt,
    };
    if (command.status === "completed") payload.result = command.result;
    if (command.status === "failed") payload.error = command.error;
    return payload;
  }

  async #payload() {
    const manifest = await this.ctx.storage.get("journal-manifest");
    const expectedVersion = String(manifest?.version ?? "");
    if (this.#cachedPayload && (
      !expectedVersion || this.#cachedPayload.version === expectedVersion
    )) {
      return this.#cachedPayload;
    }
    if (manifest) {
      const chunkKeys = Array.from(
        { length: manifest.count },
        (_, chunkIndex) => `chunk:${manifest.syncId}:${chunkIndex}`,
      );
      const chunks = await this.ctx.storage.get(chunkKeys);
      if (chunks.size !== manifest.count) throw new Error("Снимок журнала повреждён.");
      const ordered = chunkKeys.map((key) => new Uint8Array(chunks.get(key)));
      const length = ordered.reduce((total, chunk) => total + chunk.byteLength, 0);
      const compressed = new Uint8Array(length);
      let offset = 0;
      for (const chunk of ordered) {
        compressed.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const body = new Blob([compressed])
        .stream()
        .pipeThrough(new DecompressionStream(manifest.encoding));
      this.#cachedPayload = await new Response(body).json();
      return this.#cachedPayload;
    }
    this.#cachedPayload = await this.ctx.storage.get("journal");
    if (!this.#cachedPayload) throw new Error("Журнал ещё не опубликован.");
    return this.#cachedPayload;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/dashboard-bot/service-identity") {
      try {
        return json(await this.#dashboardBotServiceIdentity(await request.json()));
      } catch (error) {
        const status = /not paired/iu.test(error.message) ? 409 : 400;
        return json({ error: error.message }, status);
      }
    }
    if (request.method === "POST" && url.pathname === "/dashboard-bot/service-register") {
      try {
        return json(await this.#registerDashboardBotServiceIdentity(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/dashboard-bot/service-export") {
      try {
        return json(await this.#exportDashboardBotServiceIdentity(
          request,
          String(url.searchParams.get("pathname") ?? ""),
        ));
      } catch (error) {
        const status = /not paired/iu.test(error.message) ? 409 : 401;
        return json({ error: error.message }, status);
      }
    }
    if (request.method === "POST" && url.pathname === "/dashboard-bot/hub-export") {
      try {
        return json(await this.#exportDashboardBotHub(await request.json()));
      } catch (error) {
        const status = /conflict/iu.test(error.message)
          ? 409
          : /not registered/iu.test(error.message)
            ? 404
            : 400;
        return json({ error: error.message }, status);
      }
    }
    if (request.method === "POST" && url.pathname === "/dashboard-bot/hub-import") {
      try {
        return json(await this.#importDashboardBotHub(await request.json()));
      } catch (error) {
        return json({ error: error.message }, /conflict/iu.test(error.message) ? 409 : 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/dashboard-bot/open-card") {
      try {
        return json(await this.#dashboardBotOpenCard(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (
      request.method === "POST"
      && ["/dashboard-bot/register", "/dashboard-bot/register-existing"].includes(url.pathname)
    ) {
      try {
        const body = await readBoundedBody(request, 8 * 1024, "dashboard bot registration");
        const payload = parseJson(body, "dashboard bot registration");
        return json(await (url.pathname.endsWith("register-existing")
          ? this.#registerExistingDashboardBotHub(payload)
          : this.#registerDashboardBotHub(payload)));
      } catch (error) {
        const status = /conflict/iu.test(error.message)
          ? 409
          : /not registered/iu.test(error.message)
            ? 404
            : 400;
        return json({ error: error.message }, status);
      }
    }
    if (
      request.method === "POST"
      && [
        "/api/dashboard-bot/pull",
        "/api/dashboard-bot/result",
        "/api/dashboard-bot/attachment/pull",
      ].includes(url.pathname)
    ) {
      try {
        return json(await this.#authenticateDashboardBotHub(request));
      } catch (error) {
        const status = /not paired/iu.test(error.message) ? 409 : 401;
        return json({ error: error.message }, status);
      }
    }
    if (request.method === "POST" && url.pathname === "/dashboard-bot/update") {
      try {
        const body = await readBoundedBody(request, 64 * 1024, "dashboard bot update");
        return json(await this.#routeDashboardBotUpdate(parseJson(body, "dashboard bot update")));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/dashboard-bot/card") {
      return json(await this.#setDashboardBotBundleCard(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/dashboard-bot/finalize") {
      return json(await this.#finalizeDashboardBotBundle(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/snapshot/push") {
      try {
        return json(await this.#pushSnapshot(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/snapshot/read") {
      try {
        return json(await this.#readSnapshot(await request.json()));
      } catch (error) {
        return json({ error: error.message }, /not published/iu.test(error.message) ? 503 : 401);
      }
    }
    if (request.method === "POST" && url.pathname === "/device/pairing/create") {
      try {
        return json(await this.#createDevicePairing(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (request.method === "POST" && ["/device/pair", "/device/challenge", "/device/session"].includes(url.pathname)) {
      const attempt = this.#deviceAuthAttempts.consume(
        String(request.headers.get("X-Agent-Hub-Client-Key") ?? "unknown"),
      );
      if (!attempt.allowed) {
        return new Response(JSON.stringify({ error: "too many device authentication attempts" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Retry-After": String(attempt.retryAfter),
          },
        });
      }
      try {
        if (url.pathname === "/device/pair") return json(await this.#pairDevice(await request.json()), 201);
        if (url.pathname === "/device/challenge") {
          return json(await this.#createDeviceChallenge(await request.json()));
        }
        return json(await this.#createDeviceSession(await request.json()));
      } catch (error) {
        return json({ error: error.message }, url.pathname === "/device/pair" ? 400 : 401);
      }
    }
    if (request.method === "POST" && url.pathname === "/device/session/resolve") {
      try {
        return json(await this.#resolveDeviceSession(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 401);
      }
    }
    if (request.method === "POST" && url.pathname === "/device/list") {
      try {
        return json(await this.#listDevices(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/device/import") {
      try {
        return json(await this.#importDevices(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/device/revoke") {
      try {
        return json(await this.#revokeDevice(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/device/delete") {
      try {
        return json(await this.#deleteDevices(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/attachment/upload") {
      const userId = String(request.headers.get("X-Agent-Hub-User-Id") ?? "");
      const id = String(request.headers.get("X-Agent-Hub-Attachment-Id") ?? "").toLowerCase();
      const contentType = attachmentContentType(request.headers.get("Content-Type"));
      const name = attachmentFileName(request.headers.get("X-Agent-Hub-File-Name"));
      const bodyHash = String(request.headers.get("X-Agent-Hub-Attachment-Hash") ?? "").toLowerCase();
      const body = await request.arrayBuffer();
      if (
        !userId
        || !CONTROL_ID_PATTERN.test(id)
        || !/^[a-f0-9]{64}$/u.test(bodyHash)
        || body.byteLength < 1
        || body.byteLength > MAX_ATTACHMENT_BYTES
        || !attachmentMatchesContentType(body, contentType)
        || await sha256(body) !== bodyHash
      ) {
        return json({ error: "invalid remote attachment" }, 400);
      }
      const now = Date.now();
      return this.ctx.storage.transaction(async (storage) => {
        const manifests = await this.#cleanupAttachments(now, storage);
        const key = `control:attachment:${id}`;
        const existing = await storage.get(key);
        if (existing) {
          if (
            existing.userId !== userId
            || existing.bodyHash !== bodyHash
            || existing.contentType !== contentType
            || existing.name !== name
          ) {
            return json({ error: "remote attachment id conflict" }, 409);
          }
          return json({
            ok: true,
            path: `${REMOTE_ATTACHMENT_PREFIX}${id}`,
            id,
            expiresAt: existing.expiresAt,
          });
        }
        const userAttachments = manifests.filter((manifest) => manifest.userId === userId);
        const userBytes = userAttachments.reduce((total, manifest) => total + Number(manifest.size ?? 0), 0);
        if (
          userAttachments.length >= MAX_ATTACHMENTS_PER_USER
          || userBytes + body.byteLength > MAX_ATTACHMENT_BYTES_PER_USER
        ) {
          return json({ error: "remote attachment quota exceeded" }, 429);
        }
        const chunks = [];
        for (let offset = 0; offset < body.byteLength; offset += ATTACHMENT_STORAGE_CHUNK_BYTES) {
          chunks.push(body.slice(offset, Math.min(offset + ATTACHMENT_STORAGE_CHUNK_BYTES, body.byteLength)));
        }
        const manifest = {
          id,
          userId,
          contentType,
          name,
          bodyHash,
          size: body.byteLength,
          chunkCount: chunks.length,
          commandIds: [],
          createdAt: now,
          expiresAt: now + ATTACHMENT_EXPIRY_MS,
        };
        await storage.put({
          [key]: manifest,
          ...Object.fromEntries(chunks.map((chunk, index) => [
            `control:attachment-chunk:${id}:${index}`,
            chunk,
          ])),
        });
        return json({
          ok: true,
          path: `${REMOTE_ATTACHMENT_PREFIX}${id}`,
          id,
          expiresAt: manifest.expiresAt,
        }, 201);
      });
    }
    if (request.method === "POST" && url.pathname === "/attachment/view-upload") {
      const userId = String(request.headers.get("X-Agent-Hub-User-Id") ?? "");
      const id = String(request.headers.get("X-Agent-Hub-Attachment-Id") ?? "").toLowerCase();
      const contentType = attachmentContentType(request.headers.get("Content-Type"));
      const name = attachmentFileName(request.headers.get("X-Agent-Hub-File-Name"));
      const bodyHash = String(request.headers.get("X-Agent-Hub-Attachment-Hash") ?? "").toLowerCase();
      const body = await request.arrayBuffer();
      if (
        !userId
        || !CONTROL_ID_PATTERN.test(id)
        || !/^[a-f0-9]{64}$/u.test(bodyHash)
        || body.byteLength < 1
        || body.byteLength > MAX_ATTACHMENT_BYTES
        || !attachmentMatchesContentType(body, contentType)
        || await sha256(body) !== bodyHash
      ) {
        return json({ error: "invalid attachment view" }, 400);
      }
      const now = Date.now();
      return this.ctx.storage.transaction(async (storage) => {
        const manifests = await this.#cleanupAttachments(now, storage);
        const key = `control:attachment:${id}`;
        const existing = await storage.get(key);
        if (existing) {
          if (
            existing.userId !== userId
            || existing.bodyHash !== bodyHash
            || existing.contentType !== contentType
            || existing.name !== name
            || existing.viewOnly !== true
          ) {
            return json({ error: "attachment view id conflict" }, 409);
          }
          return json({ ok: true, id, expiresAt: existing.expiresAt });
        }
        const userAttachments = manifests.filter((manifest) => manifest.userId === userId);
        const userBytes = userAttachments.reduce((total, manifest) => total + Number(manifest.size ?? 0), 0);
        if (
          userAttachments.length >= MAX_ATTACHMENTS_PER_USER
          || userBytes + body.byteLength > MAX_ATTACHMENT_BYTES_PER_USER
        ) {
          return json({ error: "attachment view quota exceeded" }, 429);
        }
        const chunks = [];
        for (let offset = 0; offset < body.byteLength; offset += ATTACHMENT_STORAGE_CHUNK_BYTES) {
          chunks.push(body.slice(offset, Math.min(offset + ATTACHMENT_STORAGE_CHUNK_BYTES, body.byteLength)));
        }
        const manifest = {
          id,
          userId,
          contentType,
          name,
          bodyHash,
          size: body.byteLength,
          chunkCount: chunks.length,
          commandIds: [],
          viewOnly: true,
          createdAt: now,
          expiresAt: now + ATTACHMENT_EXPIRY_MS,
        };
        await storage.put({
          [key]: manifest,
          ...Object.fromEntries(chunks.map((chunk, index) => [
            `control:attachment-chunk:${id}:${index}`,
            chunk,
          ])),
        });
        return json({ ok: true, id, expiresAt: manifest.expiresAt }, 201);
      });
    }
    if (request.method === "POST" && url.pathname === "/attachment/view") {
      const payload = await request.json();
      const id = String(payload?.id ?? "").toLowerCase();
      const userId = String(payload?.userId ?? "");
      if (!CONTROL_ID_PATTERN.test(id) || !userId) {
        return json({ error: "invalid attachment view request" }, 400);
      }
      await this.#cleanupAttachments();
      const manifest = await this.ctx.storage.get(`control:attachment:${id}`);
      if (!manifest || manifest.userId !== userId || manifest.viewOnly !== true) {
        return json({ error: "attachment view not found" }, 404);
      }
      const chunkKeys = Array.from(
        { length: manifest.chunkCount },
        (_, index) => `control:attachment-chunk:${id}:${index}`,
      );
      const chunks = await this.ctx.storage.get(chunkKeys);
      if (chunks.size !== manifest.chunkCount) return json({ error: "attachment view is incomplete" }, 503);
      const body = new Uint8Array(manifest.size);
      let offset = 0;
      for (const key of chunkKeys) {
        const chunk = new Uint8Array(chunks.get(key));
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (await sha256(body) !== manifest.bodyHash) return json({ error: "attachment view is damaged" }, 503);
      return new Response(body, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": manifest.contentType,
          "Content-Length": String(body.byteLength),
          "X-Content-Type-Options": "nosniff",
          "X-Agent-Hub-File-Name": encodedAttachmentFileName(manifest.name),
          ...(String(manifest.contentType).startsWith("image/")
            ? {}
            : { "Content-Disposition": `attachment; filename*=UTF-8''${encodedAttachmentFileName(manifest.name)}` }),
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/attachment/pull") {
      const payload = await request.json();
      const id = String(payload?.id ?? "").toLowerCase();
      const userId = String(payload?.userId ?? "");
      const commandId = String(payload?.commandId ?? "").toLowerCase();
      if (!CONTROL_ID_PATTERN.test(id) || !userId || !CONTROL_ID_PATTERN.test(commandId)) {
        return json({ error: "invalid remote attachment request" }, 400);
      }
      await this.#cleanupAttachments();
      const manifest = await this.ctx.storage.get(`control:attachment:${id}`);
      if (
        !manifest
        || manifest.userId !== userId
        || !Array.isArray(manifest.commandIds)
        || !manifest.commandIds.includes(commandId)
      ) {
        return json({ error: "remote attachment not found" }, 404);
      }
      if (payload?.mode != null) return this.#attachmentTransportResponse(manifest, payload);
      const chunkKeys = Array.from(
        { length: manifest.chunkCount },
        (_, index) => `control:attachment-chunk:${id}:${index}`,
      );
      const chunks = await this.ctx.storage.get(chunkKeys);
      if (chunks.size !== manifest.chunkCount) return json({ error: "remote attachment is incomplete" }, 503);
      const body = new Uint8Array(manifest.size);
      let offset = 0;
      for (const key of chunkKeys) {
        const chunk = new Uint8Array(chunks.get(key));
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(body, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": manifest.contentType,
          "Content-Length": String(body.byteLength),
          "X-Agent-Hub-Attachment-Hash": manifest.bodyHash,
          "X-Agent-Hub-Attachment-Id": manifest.id,
          "X-Agent-Hub-File-Name": encodedAttachmentFileName(manifest.name),
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/control/enqueue") {
      const payload = await request.json();
      const userId = String(payload?.userId ?? "");
      let command;
      try {
        command = validateControlCommand(payload);
      } catch (error) {
        return json({ error: error.message }, 400);
      }
      if (!userId) return json({ error: "invalid control user" }, 400);
      const now = Date.now();
      const key = controlCommandKey(command.id);
      const attachmentIds = attachmentIdsFromParams(command.action, command.params);
      const requestHash = await sha256(`${command.action}\n${stableStringify(command.params)}`);
      const requestedExpiryMs = Number(request.headers.get("X-Agent-Hub-Control-Expiry-Ms"));
      const expiryMs = Number.isSafeInteger(requestedExpiryMs)
        ? Math.min(DASHBOARD_BOT_COMMAND_EXPIRY_MS, Math.max(CONTROL_EXPIRY_MS, requestedExpiryMs))
        : CONTROL_EXPIRY_MS;
      const response = await this.ctx.storage.transaction(async (storage) => {
        await this.#cleanupExpiredControlCommands(now, storage);
        if (attachmentIds.length) await this.#cleanupAttachments(now, storage);
        const existing = await storage.get(key);
        if (existing) {
          if (existing.userId !== userId || existing.requestHash !== requestHash) {
            return json({ error: "control command id conflict" }, 409);
          }
          return json(this.#controlStatus(existing), 200);
        }
        const activeCount = Number(await storage.get(CONTROL_ACTIVE_COUNT_KEY)) || 0;
        if (activeCount >= MAX_CONTROL_COMMANDS) {
          return json({ error: "control queue is full" }, 429);
        }
        const attachmentManifests = [];
        for (const attachmentId of attachmentIds) {
          const manifest = await storage.get(`control:attachment:${attachmentId}`);
          if (!manifest || manifest.userId !== userId) {
            return json({ error: "remote attachment not found" }, 404);
          }
          attachmentManifests.push(manifest);
        }
        const record = {
          ...command,
          attachmentIds,
          userId,
          requestHash,
          status: "pending",
          createdAt: now,
          updatedAt: now,
          expiresAt: now + expiryMs,
        };
        record.availabilityKey = controlAvailableKey(record, now);
        record.expiryKey = controlExpiryKey(record);
        await storage.put({
          [key]: record,
          [record.availabilityKey]: { id: record.id },
          [record.expiryKey]: { id: record.id },
          [CONTROL_ACTIVE_COUNT_KEY]: activeCount + 1,
          ...Object.fromEntries(attachmentManifests.map((manifest) => {
            manifest.commandIds = [...new Set([...(manifest.commandIds ?? []), command.id])];
            manifest.expiresAt = Math.max(manifest.expiresAt, record.expiresAt);
            return [`control:attachment:${manifest.id}`, manifest];
          })),
        });
        return json(this.#controlStatus(record), 202);
      });
      if (response.status === 202) {
        this.#wakeControlWaiters();
        await this.#scheduleCleanupAlarm(now + expiryMs);
      }
      return response;
    }
    if (request.method === "GET" && url.pathname === "/control/status") {
      const id = String(url.searchParams.get("id") ?? "").toLowerCase();
      const userId = String(url.searchParams.get("userId") ?? "");
      if (!CONTROL_ID_PATTERN.test(id) || !userId) return json({ error: "invalid control query" }, 400);
      const waitMs = Math.min(MAX_CONTROL_WAIT_MS, Math.max(0, Number(url.searchParams.get("waitMs")) || 0));
      const waiter = waitMs > 0 ? this.#controlResultWaiter(id, waitMs) : null;
      try {
        await this.#cleanupExpiredControlCommands();
        let command = await this.ctx.storage.get(controlCommandKey(id));
        if (!command || command.userId !== userId) return json({ error: "control command not found" }, 404);
        if (Number(command.expiresAt ?? 0) <= Date.now()) {
          await this.ctx.storage.transaction(async (storage) => {
            const current = await storage.get(controlCommandKey(id));
            if (!current || Number(current.expiresAt ?? 0) > Date.now()) return;
            const activeCount = Number(await storage.get(CONTROL_ACTIVE_COUNT_KEY)) || 0;
            await deleteStorageKeys(storage, [controlCommandKey(id), current.availabilityKey, current.expiryKey]);
            if (!["completed", "failed"].includes(current.status)) {
              await storage.put(CONTROL_ACTIVE_COUNT_KEY, Math.max(0, activeCount - 1));
            }
          });
          return json({ error: "control command not found" }, 404);
        }
        if (["pending", "running"].includes(command.status) && waiter) {
          await waiter.promise;
          await this.#cleanupExpiredControlCommands();
          command = await this.ctx.storage.get(controlCommandKey(id));
          if (!command || command.userId !== userId) return json({ error: "control command not found" }, 404);
        }
        return json({ ...this.#controlStatus(command), longPoll: waitMs > 0 });
      } finally {
        waiter?.cancel();
      }
    }
    if (request.method === "POST" && url.pathname === "/control/pull") {
      const payload = await request.json();
      const limit = Math.min(20, Math.max(1, Number(payload?.limit) || 10));
      const waitMs = Math.min(MAX_CONTROL_WAIT_MS, Math.max(0, Number(payload?.waitMs) || 0));
      const waiter = waitMs > 0 ? this.#controlWaiter(waitMs) : null;
      try {
        let commands = await this.#claimControlCommands(limit);
        if (!commands.length && waiter) {
          await waiter.promise;
          commands = await this.#claimControlCommands(limit);
        }
        return json({ commands, longPoll: waitMs > 0 });
      } finally {
        waiter?.cancel();
      }
    }
    if (request.method === "POST" && url.pathname === "/control/result") {
      const payload = await request.json();
      const id = String(payload?.id ?? "").toLowerCase();
      const userId = String(payload?.userId ?? "");
      if (!CONTROL_ID_PATTERN.test(id) || !userId || typeof payload?.ok !== "boolean") {
        return json({ error: "invalid control result" }, 400);
      }
      const key = controlCommandKey(id);
      const response = await this.ctx.storage.transaction(async (storage) => {
        await this.#ensureControlIndex(storage);
        const command = await storage.get(key);
        if (!command || command.userId !== userId) return json({ error: "control command not found" }, 404);
        if (command.status === "completed" || command.status === "failed") {
          return json({ ...this.#controlStatus(command), resultAccepted: false });
        }
        if (command.status !== "running") return json({ error: "control command is not running" }, 409);
        const now = Date.now();
        command.status = payload.ok ? "completed" : "failed";
        command.updatedAt = now;
        const previousAvailabilityKey = command.availabilityKey;
        const previousExpiryKey = command.expiryKey;
        command.expiresAt = now + CONTROL_EXPIRY_MS;
        delete command.leaseExpiresAt;
        delete command.availabilityKey;
        command.expiryKey = controlExpiryKey(command);
        if (payload.ok) {
          command.result = payload.result ?? null;
          delete command.error;
        } else {
          command.error = String(payload.error ?? "Agent Hub control action failed").slice(0, MAX_CONTROL_ERROR_CHARS);
          delete command.result;
        }
        const activeCount = Math.max(0, (Number(await storage.get(CONTROL_ACTIVE_COUNT_KEY)) || 0) - 1);
        await deleteStorageKeys(storage, [
          previousAvailabilityKey,
          previousExpiryKey === command.expiryKey ? null : previousExpiryKey,
        ]);
        await storage.put({
          [key]: command,
          [command.expiryKey]: { id: command.id },
          [CONTROL_ACTIVE_COUNT_KEY]: activeCount,
        });
        for (const attachmentId of command.attachmentIds ?? []) {
          const attachmentKey = `control:attachment:${attachmentId}`;
          const manifest = await storage.get(attachmentKey);
          if (!manifest) continue;
          manifest.commandIds = (manifest.commandIds ?? []).filter((commandId) => commandId !== command.id);
          if (manifest.commandIds.length) await storage.put(attachmentKey, manifest);
          else await this.#deleteAttachment(manifest, storage);
        }
        const sourceDetails = command.params?.sourceDetails;
        const dashboardBotReceipt = command.action === "board-task-ingest"
          && sourceDetails && typeof sourceDetails === "object"
          ? {
            kind: Number.isSafeInteger(command.params?.replyMessageId)
              ? "update"
              : sourceDetails.bundleId
                ? "bundle"
                : "task",
            bundleId: String(sourceDetails.bundleId ?? ""),
            separate: sourceDetails.separate === true,
            separateIndex: Number(sourceDetails.separateIndex) || null,
          }
          : null;
        return json({
          ...this.#controlStatus(command),
          resultAccepted: true,
          ...(dashboardBotReceipt ? { dashboardBotReceipt } : {}),
        });
      });
      if (response.ok) {
        this.#wakeControlResultWaiters(id);
        await this.#scheduleCleanupAlarm(Date.now() + CONTROL_EXPIRY_MS);
      }
      return response;
    }
    if (request.method === "POST" && url.pathname === "/sync") {
      const payload = await request.json();
      const previous = await this.ctx.storage.get("journal-manifest");
      await this.ctx.storage.put("journal", payload);
      await this.ctx.storage.delete("journal-manifest");
      if (previous?.syncId) {
        await this.ctx.storage.delete(
          Array.from({ length: previous.count }, (_, index) => `chunk:${previous.syncId}:${index}`),
        );
      }
      this.#cachedPayload = payload;
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/sync-chunk") {
      const now = Date.now();
      const nextExpiry = await this.#cleanupSyncStaging(now);
      await this.#scheduleCleanupAlarm(nextExpiry);
      const syncId = String(request.headers.get("X-Agent-Hub-Sync-Id") ?? "");
      const index = Number(request.headers.get("X-Agent-Hub-Chunk-Index"));
      const count = Number(request.headers.get("X-Agent-Hub-Chunk-Count"));
      const encoding = String(request.headers.get("X-Agent-Hub-Encoding") ?? "");
      const version = String(request.headers.get("X-Agent-Hub-Journal-Version") ?? "");
      const updatedAt = String(request.headers.get("X-Agent-Hub-Journal-Updated-At") ?? "");
      const metadataKey = `staging:${syncId}`;
      const chunkKey = `chunk:${syncId}:${index}`;
      const existing = await this.ctx.storage.get(metadataKey);
      if (existing && (
        existing.count !== count
        || existing.encoding !== encoding
        || existing.version !== version
        || existing.updatedAt !== updatedAt
      )) {
        return json({ error: "sync metadata conflict" }, 409);
      }
      const createdAt = Number(existing?.createdAt ?? now);
      const expiresAt = now + SYNC_STAGING_EXPIRY_MS;
      await this.ctx.storage.put({
        [metadataKey]: {
          syncId,
          count,
          encoding,
          version,
          updatedAt,
          createdAt: Number.isFinite(createdAt) ? createdAt : now,
          expiresAt,
        },
        [chunkKey]: await request.arrayBuffer(),
      });
      await this.#scheduleCleanupAlarm(expiresAt);
      const chunkKeys = Array.from({ length: count }, (_, chunkIndex) => `chunk:${syncId}:${chunkIndex}`);
      const chunks = await this.ctx.storage.get(chunkKeys);
      if (chunks.size !== count) return json({ ok: true, complete: false }, 202);

      const previous = await this.ctx.storage.get("journal-manifest");
      await this.ctx.storage.put("journal-manifest", {
        syncId,
        count,
        encoding,
        version,
        updatedAt,
      });
      await this.ctx.storage.delete(["journal", metadataKey]);
      this.#cachedPayload = null;
      if (previous?.syncId && previous.syncId !== syncId) {
        await this.ctx.storage.delete(
          Array.from({ length: previous.count }, (_, chunkIndex) => `chunk:${previous.syncId}:${chunkIndex}`),
        );
      }
      return json({ ok: true, complete: true });
    }
    if (request.method === "GET" && url.pathname === "/rate-limits") {
      let payload;
      try {
        payload = await this.#payload();
      } catch (error) {
        return json({ error: error.message }, 503);
      }
      /* Сводка лимитов — первый блок снимка. Шапка Mini App показывает её во
         всех разделах, а журнал грузится лениво, поэтому блок отдаётся
         отдельно, без мегабайтного payload. */
      const block = String(payload.html ?? "").match(
        /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
      )?.[0] ?? "";
      return json({
        html: block,
        sampledAt: block.match(/data-sampled-at="([^"]*)"/iu)?.[1] ?? "",
      });
    }
    if (request.method === "GET" && [
      "/journal",
      "/journal/day",
      "/journal/turn",
    ].includes(url.pathname)) {
      let payload;
      try {
        payload = await this.#payload();
      } catch (error) {
        return json({ error: error.message }, 503);
      }
      if (url.pathname === "/journal/day" || url.pathname === "/journal/turn") {
        const requestedVersion = String(url.searchParams.get("version") ?? "");
        if (requestedVersion && requestedVersion !== payload.version) {
          return json({ error: "Журнал обновился.", version: payload.version }, 409);
        }
        const key = url.pathname.endsWith("/day")
          ? String(url.searchParams.get("date") ?? "")
          : String(url.searchParams.get("id") ?? "");
        const html = url.pathname.endsWith("/day")
          ? payload.days?.[key]
          : payload.turns?.[key];
        return typeof html === "string"
          ? json({ html, version: payload.version })
          : json({ error: "Фрагмент журнала не найден." }, 404);
      }
      const knownVersion = String(request.headers.get("If-None-Match") ?? "");
      const etag = `"${payload.version}"`;
      if (knownVersion === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      const response = json({
        html: payload.html,
        updatedAt: payload.updatedAt,
        version: payload.version,
      });
      response.headers.set("ETag", etag);
      return response;
    }
    return json({ error: "Not Found" }, 404);
  }
}

function secureStaticResponse(response, request) {
  const headers = new Headers(response.headers);
  const contentType = String(headers.get("Content-Type") ?? "").toLowerCase();
  const url = new URL(request.url);
  const directAssetOrigin = url.hostname.startsWith("hub.")
    ? `https://home.${url.hostname.slice(4)}`
    : "";
  const versioned = url.searchParams.has("v") || /\.[a-f0-9]{12}\.[^/]+$/iu.test(url.pathname);
  if (contentType.includes("text/html")) {
    headers.set("Cache-Control", "no-store");
  } else if (versioned) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "no-cache");
  }
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https://*.darksanctuary.ru",
    "object-src 'none'",
    `script-src 'self'${directAssetOrigin ? ` ${directAssetOrigin}` : ""} https://telegram.org`,
    `style-src 'self'${directAssetOrigin ? ` ${directAssetOrigin}` : ""}`,
  ].join("; "));
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const DEVICE_SESSION_COOKIE = "agent_hub_device";
const DEVICE_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function cookieValue(request, name) {
  for (const part of String(request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

/**
 * Hands the device session to the client as an HttpOnly cookie so same-origin
 * page scripts never have to hold the bearer token to talk to the Hub.
 */
async function deviceSessionResponse(response) {
  const session = await response.json();
  const maxAgeSeconds = Math.max(1, Math.floor((Number(session?.expiresAt) - Date.now()) / 1_000));
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.append(
    "Set-Cookie",
    `${DEVICE_SESSION_COOKIE}=${session.token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  );
  return new Response(JSON.stringify(session), { status: response.status, headers });
}

async function telegramUser(request, env) {
  const authorization = String(request.headers.get("Authorization") ?? "");
  if (!authorization.startsWith("tma ")) throw new Error("Откройте Agent Hub из Telegram.");
  return validateTelegramInitData(authorization.slice(4), {
    botToken: env.TELEGRAM_BOT_TOKEN,
    allowedIds: allowedUserIds(env.ALLOWED_USER_IDS),
  });
}

function deviceSessionToken(request) {
  const authorization = String(request.headers.get("Authorization") ?? "");
  if (authorization.startsWith("device ")) return authorization.slice(7).trim();
  if (authorization) return "";
  const cookieToken = cookieValue(request, DEVICE_SESSION_COOKIE);
  return DEVICE_SESSION_TOKEN_PATTERN.test(cookieToken) ? cookieToken : "";
}

async function clientUser(request, env, store) {
  const authorization = String(request.headers.get("Authorization") ?? "");
  if (authorization.startsWith("tma ")) return telegramUser(request, env);
  const token = deviceSessionToken(request);
  if (!token) throw new Error("Откройте Agent Hub из Telegram или приложения.");
  const response = await store.fetch(new Request("https://journal.internal/device/session/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }));
  const payload = await response.json();
  if (!response.ok) throw new Error(String(payload?.error ?? "device session is invalid"));
  return payload;
}

async function registerDashboardBotRouter({ body, registry, router, legacy }) {
  let authorized = false;
  let registryError = null;
  try {
    await authorizeDashboardBotRegistration(body, registry);
    authorized = true;
  } catch (error) {
    registryError = error;
    if (!/registry is not configured/iu.test(error.message)) throw error;
  }

  const existing = await router.fetch(new Request(
    "https://journal.internal/dashboard-bot/register-existing",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
  ));
  if (existing.ok || existing.status !== 404) return existing;

  const exported = await legacy.fetch(new Request(
    "https://journal.internal/dashboard-bot/hub-export",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
  ));
  if (exported.ok) {
    const imported = await router.fetch(new Request(
      "https://journal.internal/dashboard-bot/hub-import",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await exported.json()),
      },
    ));
    if (!imported.ok) return imported;
    return router.fetch(new Request(
      "https://journal.internal/dashboard-bot/register-existing",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    ));
  }
  if (!authorized) throw registryError;
  return router.fetch(new Request("https://journal.internal/dashboard-bot/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = env.JOURNAL.getByName("current");
    const dashboardBotRouter = env.JOURNAL.getByName(DASHBOARD_BOT_ROUTER_NAME);
    if (url.pathname === "/api/transport-probe/attachment") {
      return dashboardAttachmentTransportProbeResponse(request);
    }
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/api/dashboard-bot/register") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      try {
        const body = await readBoundedBody(request, 8 * 1024, "dashboard bot registration");
        const registration = await registerDashboardBotRouter({
          body,
          registry: env.DASHBOARD_BOT_HUB_REGISTRY,
          router: dashboardBotRouter,
          legacy: store,
        });
        if (registration.ok) {
          const { hubId } = parseJson(body, "dashboard bot registration");
          const cardResponse = await dashboardBotRouter.fetch(new Request(
            "https://journal.internal/dashboard-bot/open-card",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ hubId }),
            },
          ));
          const card = (await cardResponse.json().catch(() => ({}))).card;
          if (card?.mode === "send") {
            await updateDashboardBotCard(env, dashboardBotRouter, card).catch(() => null);
          }
        }
        return registration;
      } catch (error) {
        const status = /too large/iu.test(error.message)
          ? 413
          : /registry/iu.test(error.message)
            ? 503
            : /not authorized/iu.test(error.message)
              ? 403
              : 400;
        return json({ error: error.message }, status);
      }
    }
    if (url.pathname === "/api/dashboard-bot/webhook") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      const expectedSecret = String(env.DASHBOARD_BOT_WEBHOOK_SECRET ?? "").trim();
      const actualSecret = String(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "").trim();
      if (
        expectedSecret.length < 32
        || actualSecret.length !== expectedSecret.length
        || await sha256(actualSecret) !== await sha256(expectedSecret)
      ) {
        return json({ error: "invalid dashboard bot webhook secret" }, 401);
      }
      let update;
      try {
        update = parseJson(
          await readBoundedBody(request, 64 * 1024, "dashboard bot update"),
          "dashboard bot update",
        );
      } catch (error) {
        return json({ error: error.message }, /too large/iu.test(error.message) ? 413 : 400);
      }
      const routedResponse = await dashboardBotRouter.fetch(new Request("https://journal.internal/dashboard-bot/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      }));
      const routed = await routedResponse.json();
      if (!routedResponse.ok) return json(routed, routedResponse.status);
      if (routed.callbackQueryId) {
        await dashboardBotTelegramRequest(env, "answerCallbackQuery", {
          callback_query_id: routed.callbackQueryId,
          text: routed.callbackText || undefined,
        });
      }
      if (routed.card) await updateDashboardBotCard(env, dashboardBotRouter, routed.card);
      const routedCommands = Array.isArray(routed.commands)
        ? routed.commands
        : (routed.command && routed.hubId
          ? [{ command: routed.command, hubId: routed.hubId, telegramAttachments: routed.telegramAttachments ?? routed.telegramImages }]
          : []);
      if (routedCommands.length) {
        try {
          for (const routedCommand of routedCommands) {
            const hubStore = env.JOURNAL.getByName(`dashboard-bot:${routedCommand.hubId}`);
            const identityResponse = await dashboardBotRouter.fetch(new Request(
              "https://journal.internal/dashboard-bot/service-identity",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ hubId: routedCommand.hubId }),
              },
            ));
            if (!identityResponse.ok) {
              const error = await identityResponse.json().catch(() => ({}));
              throw new Error(String(error?.error ?? "dashboard bot hub identity is unavailable"));
            }
            const serviceRegistration = await hubStore.fetch(new Request(
              "https://journal.internal/dashboard-bot/service-register",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(await identityResponse.json()),
              },
            ));
            if (!serviceRegistration.ok) {
              const error = await serviceRegistration.json().catch(() => ({}));
              throw new Error(String(error?.error ?? "dashboard bot hub identity was not stored"));
            }
            let command = routedCommand.command;
            if (Array.isArray(routedCommand.telegramAttachments) && routedCommand.telegramAttachments.length) {
              command = {
                ...command,
                params: {
                  ...command.params,
                  attachments: await uploadDashboardBotAttachments(
                    env,
                    hubStore,
                    command.userId,
                    routedCommand.telegramAttachments,
                  ),
                },
              };
            }
            const enqueueResponse = await hubStore.fetch(new Request("https://journal.internal/control/enqueue", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Agent-Hub-Control-Expiry-Ms": String(DASHBOARD_BOT_COMMAND_EXPIRY_MS),
              },
              body: JSON.stringify(command),
            }));
            if (!enqueueResponse.ok) {
              const error = await enqueueResponse.json().catch(() => ({}));
              throw new Error(`Agent Hub временно не принял сообщение: ${String(error?.error ?? "очередь недоступна").slice(0, 300)}`);
            }
          }
        } catch (error) {
          if (routed.submittedBundle) {
            const userFacingError = dashboardBotSubmissionFailureMessage(error);
            console.warn(`Dashboard bot bundle submission failed: ${String(error?.message ?? error)}`);
            const resetResponse = await dashboardBotRouter.fetch(new Request("https://journal.internal/dashboard-bot/finalize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...routed.submittedBundle, submitted: false, error: userFacingError }),
            }));
            const reset = await resetResponse.json().catch(() => ({}));
            if (reset.card) await updateDashboardBotCard(env, dashboardBotRouter, reset.card);
          } else {
            await dashboardBotTelegramRequest(env, "sendMessage", {
              chat_id: update?.message?.chat?.id,
              text: error.message,
            });
          }
          return json({ error: error.message }, 503);
        }
        if (routed.submittedBundle) {
          await dashboardBotRouter.fetch(new Request("https://journal.internal/dashboard-bot/finalize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...routed.submittedBundle, submitted: true }),
          }));
          await updateDashboardBotCard(env, dashboardBotRouter, {
            ...routed.card,
            mode: "edit",
            text: routed.submittedBundle.separate
              ? `⏳ Отдельных задач поставлено в очередь: ${routed.submittedBundle.taskCount}.`
              : `⏳ Пачка из ${routed.submittedBundle.itemCount} сообщений поставлена в очередь Agent Hub.`,
            replyMarkup: { inline_keyboard: [] },
          });
        }
      }
      if (routed.reply) {
        const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
        if (chatId) await dashboardBotTelegramRequest(env, "sendMessage", {
          chat_id: chatId,
          text: routed.reply,
          disable_web_page_preview: true,
        });
      }
      return json({ ok: true, ignored: routed.ignored === true });
    }
    if ([
      "/api/dashboard-bot/pull",
      "/api/dashboard-bot/result",
      "/api/dashboard-bot/attachment/pull",
    ].includes(url.pathname)) {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      const hubId = String(request.headers.get("X-Agent-Hub-Dashboard-Id") ?? "").trim().toLowerCase();
      if (!CONTROL_ID_PATTERN.test(hubId)) return json({ error: "invalid dashboard bot hub id" }, 401);
      const hubStore = env.JOURNAL.getByName(`dashboard-bot:${hubId}`);
      let authenticated = await hubStore.fetch(new Request(
        `https://journal.internal${url.pathname}`,
        request.clone(),
      ));
      let identity;
      if (authenticated.ok) {
        identity = await authenticated.json();
      } else {
        if (authenticated.status !== 401) return authenticated;
        authenticated = await dashboardBotRouter.fetch(new Request(
          `https://journal.internal/dashboard-bot/service-export?pathname=${encodeURIComponent(url.pathname)}`,
          request.clone(),
        ));
        if (!authenticated.ok && authenticated.status === 401) {
          authenticated = await store.fetch(new Request(
            `https://journal.internal/dashboard-bot/service-export?pathname=${encodeURIComponent(url.pathname)}`,
            request.clone(),
          ));
        }
        if (!authenticated.ok) return authenticated;
        const migratedIdentity = await authenticated.json();
        const serviceRegistration = await hubStore.fetch(new Request(
          "https://journal.internal/dashboard-bot/service-register",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(migratedIdentity),
          },
        ));
        if (!serviceRegistration.ok) return serviceRegistration;
        const { secret: _secret, ...publicIdentity } = migratedIdentity;
        identity = publicIdentity;
      }
      let payload;
      try {
        payload = parseJson(identity.body, "dashboard bot service request");
      } catch (error) {
        return json({ error: error.message }, 400);
      }
      if (url.pathname.endsWith("/attachment/pull")) {
        const id = String(payload?.id ?? "").toLowerCase();
        const commandId = String(payload?.commandId ?? "").toLowerCase();
        if (
          !CONTROL_ID_PATTERN.test(id)
          || !CONTROL_ID_PATTERN.test(commandId)
          || String(payload?.userId ?? "") !== identity.userId
        ) {
          return json({ error: "invalid dashboard bot attachment request" }, 400);
        }
        const attachmentResponse = await hubStore.fetch(new Request("https://journal.internal/attachment/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            commandId,
            userId: identity.userId,
            ...(payload?.mode == null ? {} : {
              mode: payload.mode,
              page: payload.page,
              index: payload.index,
            }),
          }),
        }));
        return materializeDashboardBotAttachmentResponse(attachmentResponse);
      }
      if (url.pathname.endsWith("/pull")) {
        const limit = Number(payload?.limit ?? 10);
        const waitMs = Number(payload?.waitMs ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
          return json({ error: "invalid dashboard bot pull limit" }, 400);
        }
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_CONTROL_WAIT_MS) {
          return json({ error: "invalid dashboard bot pull wait" }, 400);
        }
        return hubStore.fetch(new Request("https://journal.internal/control/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit, waitMs }),
        }));
      }
      const id = String(payload?.id ?? "").toLowerCase();
      if (
        !CONTROL_ID_PATTERN.test(id)
        || String(payload?.userId ?? "") !== identity.userId
        || typeof payload?.ok !== "boolean"
      ) {
        return json({ error: "invalid dashboard bot result" }, 400);
      }
      const resultResponse = await hubStore.fetch(new Request("https://journal.internal/control/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          userId: identity.userId,
          ok: payload.ok,
          ...(payload.ok
            ? { result: payload.result ?? null }
            : { error: String(payload.error ?? "").slice(0, MAX_CONTROL_ERROR_CHARS) }),
        }),
      }));
      const result = await resultResponse.json().catch(() => ({}));
      if (resultResponse.ok && result.resultAccepted === true && result.dashboardBotReceipt) {
        const receipt = result.dashboardBotReceipt;
        const successText = receipt.kind === "update"
          ? "✅ Изменения сохранены в Dashboard."
          : receipt.kind === "bundle"
            ? receipt.separate
              ? receipt.separateIndex
                ? `✅ Задача ${receipt.separateIndex} добавлена в Backlog.`
                : "✅ Отдельная задача добавлена в Backlog."
              : "✅ Пачка сообщений добавлена в Backlog."
            : "✅ Задача добавлена в Backlog.";
        const failureText = `⚠️ Agent Hub не принял задачу: ${String(payload.error ?? "неизвестная ошибка").slice(0, 300)}`;
        await dashboardBotTelegramRequest(env, "sendMessage", {
          chat_id: identity.chatId,
          text: payload.ok ? successText : failureText,
          disable_web_page_preview: true,
        }).catch((error) => {
          console.warn(`Cannot send Dashboard bot delivery confirmation: ${error.message}`);
        });
      }
      return json(result, resultResponse.status);
    }
    if (url.pathname === "/api/sync") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      try {
        const payload = await validateSyncRequest(request, env.SYNC_SECRET);
        return store.fetch(new Request("https://journal.internal/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }));
      } catch (error) {
        return json({ error: error.message }, 401);
      }
    }
    if (url.pathname === "/api/sync/chunk") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      try {
        const chunk = await validateSyncChunkRequest(request, env.SYNC_SECRET);
        return store.fetch(new Request("https://journal.internal/sync-chunk", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Agent-Hub-Sync-Id": chunk.syncId,
            "X-Agent-Hub-Chunk-Index": String(chunk.index),
            "X-Agent-Hub-Chunk-Count": String(chunk.count),
            "X-Agent-Hub-Encoding": chunk.encoding,
            "X-Agent-Hub-Journal-Version": chunk.version,
            "X-Agent-Hub-Journal-Updated-At": chunk.updatedAt,
          },
          body: chunk.body,
        }));
      } catch (error) {
        return json({ error: error.message }, 401);
      }
    }
    if (url.pathname === "/api/snapshot/push") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      let body;
      try {
        body = await validateControlServiceRequest(request, env.SYNC_SECRET);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      try {
        const payload = parseJson(body, "snapshot publish request");
        const userId = String(payload?.userId ?? "").trim();
        if (!allowedUserIds(env.ALLOWED_USER_IDS).has(userId)) throw new Error("user is not allowed");
        return store.fetch(new Request("https://journal.internal/snapshot/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if ([
      "/api/device/pairing",
      "/api/device/list",
      "/api/device/revoke",
      "/api/device/import",
      "/api/device/delete",
      "/api/device/session/resolve",
    ].includes(url.pathname)) {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      let body;
      try {
        body = await validateControlServiceRequest(request, env.SYNC_SECRET);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      try {
        const payload = parseJson(body, "device service request");
        const userId = String(payload?.userId ?? "").trim();
        if (url.pathname !== "/api/device/session/resolve"
          && !allowedUserIds(env.ALLOWED_USER_IDS).has(userId)) throw new Error("user is not allowed");
        const internalPath = url.pathname === "/api/device/pairing"
          ? "/device/pairing/create"
          : url.pathname.replace(/^\/api/u, "");
        return store.fetch(new Request(`https://journal.internal${internalPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (["/api/device/pair", "/api/device/challenge", "/api/device/session"].includes(url.pathname)) {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      try {
        const body = await readBoundedBody(request, 16 * 1024, "device request");
        const payload = parseJson(body, "device request");
        const response = await store.fetch(new Request(`https://journal.internal${url.pathname.replace(/^\/api/u, "")}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Both values come from the edge, never from the client request.
            "X-Agent-Hub-Client-Key": String(request.headers.get("CF-Connecting-IP") ?? "unknown"),
          },
          body: JSON.stringify(
            url.pathname.endsWith("/challenge") ? { ...payload, origin: url.origin } : payload,
          ),
        }));
        if (!url.pathname.endsWith("/session") || !response.ok) return response;
        return await deviceSessionResponse(response);
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (url.pathname === "/api/snapshot") {
      if (!["GET", "HEAD"].includes(request.method)) return json({ error: "Method Not Allowed" }, 405);
      const authorization = String(request.headers.get("Authorization") ?? "");
      let identity;
      try {
        const token = deviceSessionToken(request);
        if (authorization.startsWith("tma ")) {
          identity = { userId: String((await telegramUser(request, env)).id) };
        } else if (token) {
          identity = { token };
        } else {
          throw new Error("Откройте Agent Hub из Telegram или приложения.");
        }
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      const knownVersion = String(url.searchParams.get("knownVersion") ?? "").slice(0, 128);
      const waitMs = Number(url.searchParams.get("waitMs") ?? 0);
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_CONTROL_WAIT_MS) {
        return json({ error: "invalid snapshot wait" }, 400);
      }
      const response = await store.fetch(new Request("https://journal.internal/snapshot/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...identity, knownVersion, waitMs }),
      }));
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    if (url.pathname === "/api/attachment") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      let user;
      try {
        user = await clientUser(request, env, store);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      try {
        const contentType = attachmentContentType(request.headers.get("Content-Type"));
        const name = attachmentFileName(request.headers.get("X-Agent-Hub-File-Name"));
        const body = await readBoundedBinary(request, MAX_ATTACHMENT_BYTES, "remote attachment");
        if (body.byteLength < 1 || !attachmentMatchesContentType(body, contentType)) {
          throw new Error("attachment content does not match its type");
        }
        const bodyHash = await sha256(body);
        const requestedId = String(request.headers.get("X-Agent-Hub-Attachment-Id") ?? "").toLowerCase();
        const id = requestedId || await deterministicAttachmentId(String(user.id), bodyHash, name, contentType);
        if (!CONTROL_ID_PATTERN.test(id)) throw new Error("invalid remote attachment id");
        return store.fetch(new Request("https://journal.internal/attachment/upload", {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            "X-Agent-Hub-User-Id": String(user.id),
            "X-Agent-Hub-Attachment-Id": id,
            "X-Agent-Hub-Attachment-Hash": bodyHash,
            "X-Agent-Hub-File-Name": encodedAttachmentFileName(name),
          },
          body,
        }));
      } catch (error) {
        const status = /too large/iu.test(error.message) ? 413 : 400;
        return json({ error: error.message }, status);
      }
    }
    if (url.pathname === "/api/control" || url.pathname === "/api/control/enqueue") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      let user;
      try {
        user = await clientUser(request, env, store);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      try {
        const body = await readBoundedBody(request, MAX_CONTROL_REQUEST_BYTES, "control command");
        const command = validateControlCommand(parseJson(body, "control command"));
        const source = user.deviceId ? "trusted-device" : "telegram-mini-app";
        if (command.action === "create-device-pairing" && source !== "trusted-device") {
          return json({ error: "Только доверенное устройство может делегировать доступ." }, 403);
        }
        const response = await store.fetch(new Request("https://journal.internal/control/enqueue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...command, userId: String(user.id), source }),
        }));
        if (!response.ok) return response;
        return json({ ok: true, pending: true, id: command.id }, response.status);
      } catch (error) {
        const status = /too large/iu.test(error.message) ? 413 : 400;
        return json({ error: error.message }, status);
      }
    }
    if (url.pathname === "/api/control/result" && request.method === "GET") {
      let user;
      try {
        user = await clientUser(request, env, store);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      const id = String(url.searchParams.get("id") ?? "").toLowerCase();
      if (!CONTROL_ID_PATTERN.test(id)) return json({ error: "invalid control command id" }, 400);
      const waitMs = Number(url.searchParams.get("waitMs") ?? 0);
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_CONTROL_WAIT_MS) {
        return json({ error: "invalid control result wait" }, 400);
      }
      const response = await store.fetch(new Request(
        `https://journal.internal/control/status?id=${encodeURIComponent(id)}&userId=${encodeURIComponent(user.id)}&waitMs=${waitMs}`,
      ));
      if (!response.ok) return response;
      const payload = await response.json();
      if (payload.status === "pending" || payload.status === "running") {
        return json({
          ok: true,
          pending: true,
          id,
          status: payload.status,
          ...(payload.longPoll === true ? { longPoll: true } : {}),
        }, 202);
      }
      if (payload.status === "completed") {
        return json({ ok: true, pending: false, id, result: payload.result ?? null });
      }
      return json({
        ok: false,
        pending: false,
        id,
        error: String(payload.error ?? "Agent Hub control action failed"),
      });
    }
    if (url.pathname === "/api/control/pull") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      let body;
      try {
        body = await validateControlServiceRequest(request, env.SYNC_SECRET);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      try {
        const payload = parseJson(body, "control pull");
        const limit = Number(payload?.limit ?? 10);
        const waitMs = Number(payload?.waitMs ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("invalid control pull limit");
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_CONTROL_WAIT_MS) {
          throw new Error("invalid control pull wait");
        }
        return store.fetch(new Request("https://journal.internal/control/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit, waitMs }),
        }));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (url.pathname === "/api/control/result" && request.method === "POST") {
      let body;
      try {
        body = await validateControlServiceRequest(request, env.SYNC_SECRET);
      } catch (error) {
        const status = /too large/iu.test(error.message) ? 413 : 401;
        return json({ error: error.message }, status);
      }
      try {
        const payload = parseJson(body, "control result");
        const id = String(payload?.id ?? "").toLowerCase();
        const userId = String(payload?.userId ?? "");
        if (
          !CONTROL_ID_PATTERN.test(id)
          || !userId
          || typeof payload?.ok !== "boolean"
          || (payload.ok && encoder.encode(JSON.stringify(payload.result ?? null)).byteLength > MAX_CONTROL_RESULT_BYTES)
        ) {
          throw new Error("invalid control result");
        }
        return store.fetch(new Request("https://journal.internal/control/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            userId,
            ok: payload.ok,
            ...(payload.ok
              ? { result: payload.result ?? null }
              : { error: String(payload.error ?? "").slice(0, MAX_CONTROL_ERROR_CHARS) }),
          }),
        }));
      } catch (error) {
        const status = /too large/iu.test(error.message) ? 413 : 400;
        return json({ error: error.message }, status);
      }
    }
    if (url.pathname === "/api/control/attachment/view/push") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      try {
        const body = await validateControlBinaryServiceRequest(request, env.SYNC_SECRET);
        const userId = String(request.headers.get("X-Agent-Hub-User-Id") ?? "");
        const id = String(request.headers.get("X-Agent-Hub-Attachment-Id") ?? "").toLowerCase();
        const contentType = attachmentContentType(request.headers.get("Content-Type"));
        const name = attachmentFileName(request.headers.get("X-Agent-Hub-File-Name"));
        const bodyHash = String(request.headers.get("X-Agent-Hub-Attachment-Hash") ?? "").toLowerCase();
        if (
          !userId
          || !CONTROL_ID_PATTERN.test(id)
          || !/^[a-f0-9]{64}$/u.test(bodyHash)
          || await sha256(body) !== bodyHash
          || !attachmentMatchesContentType(body, contentType)
        ) {
          throw new Error("invalid attachment view metadata");
        }
        return store.fetch(new Request("https://journal.internal/attachment/view-upload", {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            "X-Agent-Hub-User-Id": userId,
            "X-Agent-Hub-Attachment-Id": id,
            "X-Agent-Hub-Attachment-Hash": bodyHash,
            "X-Agent-Hub-File-Name": encodedAttachmentFileName(name),
          },
          body,
        }));
      } catch (error) {
        const status = /too large/iu.test(error.message) ? 413 : 401;
        return json({ error: error.message }, status);
      }
    }
    if (url.pathname === "/api/attachment/view") {
      if (!['GET', 'HEAD'].includes(request.method)) return json({ error: "Method Not Allowed" }, 405);
      let user;
      try {
        user = await clientUser(request, env, store);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      const id = String(url.searchParams.get("id") ?? "").toLowerCase();
      if (!CONTROL_ID_PATTERN.test(id)) return json({ error: "invalid attachment view id" }, 400);
      const response = await store.fetch(new Request("https://journal.internal/attachment/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, userId: String(user.id) }),
      }));
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    if (url.pathname === "/api/control/attachment/pull") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      let body;
      try {
        body = await validateControlServiceRequest(request, env.SYNC_SECRET);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      try {
        const payload = parseJson(body, "remote attachment request");
        const id = String(payload?.id ?? "").toLowerCase();
        const userId = String(payload?.userId ?? "");
        const commandId = String(payload?.commandId ?? "").toLowerCase();
        if (!CONTROL_ID_PATTERN.test(id) || !userId || !CONTROL_ID_PATTERN.test(commandId)) {
          throw new Error("invalid remote attachment request");
        }
        return store.fetch(new Request("https://journal.internal/attachment/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            userId,
            commandId,
            ...(payload?.mode == null ? {} : {
              mode: payload.mode,
              page: payload.page,
              index: payload.index,
            }),
          }),
        }));
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if ([
      "/api/journal",
      "/api/journal/day",
      "/api/journal/turn",
      "/api/rate-limits",
    ].includes(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "Method Not Allowed" }, 405);
      }
      try {
        await clientUser(request, env, store);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      const internalPath = url.pathname.replace(/^\/api/u, "");
      const response = await store.fetch(new Request(`https://journal.internal${internalPath}${url.search}`, {
        headers: {
          "If-None-Match": String(request.headers.get("If-None-Match") ?? ""),
        },
      }));
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    if (url.pathname === "/events") return json({ error: "Polling is used in Telegram." }, 404);
    return secureStaticResponse(await env.ASSETS.fetch(request), request);
  },
};
