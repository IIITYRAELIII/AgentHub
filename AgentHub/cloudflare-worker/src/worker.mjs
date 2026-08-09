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
const SYNC_STAGING_EXPIRY_MS = 30 * 60 * 1_000;
const STORAGE_DELETE_BATCH_SIZE = 128;
const REMOTE_ATTACHMENT_PREFIX = "remote-attachment:";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
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

function hasAttachments(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasAttachments(item, seen));
  for (const [key, item] of Object.entries(value)) {
    if (["attachment", "attachments", "image", "images", "files"].includes(key.toLowerCase())) {
      if (item != null && (!Array.isArray(item) || item.length > 0)) return true;
    }
    if (hasAttachments(item, seen)) return true;
  }
  return false;
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
    !["send-message", "submit-bug-report"].includes(action)
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
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateControlCommand(payload) {
  if (!isPlainObject(payload)) throw new Error("invalid control command");
  const id = String(payload.id ?? payload.commandId ?? "").trim().toLowerCase();
  const action = String(payload.action ?? "").trim();
  const params = payload.params ?? {};
  if (!CONTROL_ID_PATTERN.test(id)) throw new Error("invalid control command id");
  if (!CONTROL_ACTIONS.has(action)) throw new Error("control action is not allowed");
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
    params: attachmentIds.length
      ? { ...params, attachments: attachmentIds.map((attachmentId) => `${REMOTE_ATTACHMENT_PREFIX}${attachmentId}`) }
      : params,
  };
}

export async function validateControlServiceRequest(request, secret, { now = Date.now() } = {}) {
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
    url.pathname,
    await sha256(body),
  ].join("\n");
  if (!await verifyHmac(secret, signatureValue, receivedSignature)) {
    throw new Error("invalid control signature");
  }
  return body;
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

function dashboardBotTelegramReply(chatId, text) {
  return json({
    method: "sendMessage",
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
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

function deviceSessionMessage({ deviceId, challengeId, challenge }) {
  return ["agent-hub-device-session-v1", deviceId, challengeId, challenge].join("\n");
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
    const hubId = String(payload?.hubId ?? "").trim().toLowerCase();
    const secret = String(payload?.secret ?? "").trim();
    const name = String(payload?.name ?? "Agent Hub").trim().slice(0, DASHBOARD_BOT_HUB_NAME_MAX_CHARS)
      || "Agent Hub";
    if (!CONTROL_ID_PATTERN.test(hubId) || secret.length < 32 || secret.length > 256) {
      throw new Error("invalid dashboard bot hub registration");
    }
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

  async #authenticateDashboardBotHub(request) {
    const hubId = String(request.headers.get("X-Agent-Hub-Dashboard-Id") ?? "").trim().toLowerCase();
    if (!CONTROL_ID_PATTERN.test(hubId)) throw new Error("invalid dashboard bot hub id");
    const record = await this.ctx.storage.get(dashboardBotHubKey(hubId));
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

  async #routeDashboardBotUpdate(update) {
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
      return { reply: "Сначала отправьте /link КОД. После привязки любой обычный текст создаёт карточку в Backlog; /unlink удаляет привязку." };
    }
    const link = text.match(/^\/link(?:@\w+)?\s+(.+)$/iu);
    if (link) return this.#linkDashboardBotHub(message, link[1]);
    if (/^\/unlink(?:@\w+)?(?:\s|$)/iu.test(text)) return this.#unlinkDashboardBotHub(message);
    const task = text.match(/^\/task(?:@\w+)?\s+(.+)$/iu);
    const taskText = String(task?.[1] ?? text).trim();
    if (!taskText) return { reply: "Пока поддерживаются текстовые сообщения и подписи к пересылкам." };
    if (taskText.startsWith("/")) return { reply: "Неизвестная команда. Используйте /help." };
    const userId = String(message.from.id);
    const hubId = String(await this.ctx.storage.get(dashboardBotUserKey(userId)) ?? "");
    if (!CONTROL_ID_PATTERN.test(hubId)) {
      return { reply: "Сначала привяжите Agent Hub командой /link КОД." };
    }
    const hub = await this.ctx.storage.get(dashboardBotHubKey(hubId));
    if (!hub || String(hub.userId) !== userId) {
      return { reply: "Привязка Agent Hub устарела. Создайте новый код и повторите /link КОД." };
    }
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
          userId: message.from.id,
        },
      },
      userId,
    };
    return {
      hubId,
      command,
      reply: "Принято в Backlog. Карточка появится, когда ваш Agent Hub подключится.",
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
    const now = Date.now();
    await this.#cleanupDeviceAuth(now);
    const code = randomPairingCode();
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
    const record = await this.ctx.storage.get(`device:record:${deviceId}`);
    if (!record || record.revokedAt) throw new Error("device is not trusted");
    const now = Date.now();
    await this.#cleanupDeviceAuth(now);
    const challengeId = crypto.randomUUID().toLowerCase();
    const challenge = base64Url(randomBytes(32));
    const expiresAt = now + DEVICE_CHALLENGE_EXPIRY_MS;
    await this.ctx.storage.put(`device:challenge:${challengeId}`, { deviceId, challenge, expiresAt });
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
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      bytesFromBase64Url(signature),
      encoder.encode(deviceSessionMessage({ deviceId, challengeId, challenge: challenge.challenge })),
    );
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
    if (request.method === "POST" && url.pathname === "/dashboard-bot/register") {
      try {
        const body = await readBoundedBody(request, 8 * 1024, "dashboard bot registration");
        return json(await this.#registerDashboardBotHub(parseJson(body, "dashboard bot registration")));
      } catch (error) {
        return json({ error: error.message }, /conflict/iu.test(error.message) ? 409 : 400);
      }
    }
    if (
      request.method === "POST"
      && ["/api/dashboard-bot/pull", "/api/dashboard-bot/result"].includes(url.pathname)
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
    if (request.method === "POST" && url.pathname === "/device/pair") {
      try {
        return json(await this.#pairDevice(await request.json()), 201);
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/device/challenge") {
      try {
        return json(await this.#createDeviceChallenge(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 401);
      }
    }
    if (request.method === "POST" && url.pathname === "/device/session") {
      try {
        return json(await this.#createDeviceSession(await request.json()));
      } catch (error) {
        return json({ error: error.message }, 401);
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
    if (request.method === "POST" && url.pathname === "/device/revoke") {
      try {
        return json(await this.#revokeDevice(await request.json()));
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
        for (let offset = 0; offset < body.byteLength; offset += ATTACHMENT_CHUNK_BYTES) {
          chunks.push(body.slice(offset, Math.min(offset + ATTACHMENT_CHUNK_BYTES, body.byteLength)));
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
        for (let offset = 0; offset < body.byteLength; offset += ATTACHMENT_CHUNK_BYTES) {
          chunks.push(body.slice(offset, Math.min(offset + ATTACHMENT_CHUNK_BYTES, body.byteLength)));
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
          return json(this.#controlStatus(command));
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
        return json(this.#controlStatus(command));
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
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self' https://telegram.org",
    "style-src 'self'",
  ].join("; "));
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function telegramUser(request, env) {
  const authorization = String(request.headers.get("Authorization") ?? "");
  if (!authorization.startsWith("tma ")) throw new Error("Откройте Agent Hub из Telegram.");
  return validateTelegramInitData(authorization.slice(4), {
    botToken: env.TELEGRAM_BOT_TOKEN,
    allowedIds: allowedUserIds(env.ALLOWED_USER_IDS),
  });
}

async function clientUser(request, env, store) {
  const authorization = String(request.headers.get("Authorization") ?? "");
  if (authorization.startsWith("tma ")) return telegramUser(request, env);
  if (!authorization.startsWith("device ")) throw new Error("Откройте Agent Hub из Telegram или приложения.");
  const token = authorization.slice(7).trim();
  const response = await store.fetch(new Request("https://journal.internal/device/session/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }));
  const payload = await response.json();
  if (!response.ok) throw new Error(String(payload?.error ?? "device session is invalid"));
  return payload;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = env.JOURNAL.getByName("current");
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/api/dashboard-bot/register") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      try {
        const body = await readBoundedBody(request, 8 * 1024, "dashboard bot registration");
        return store.fetch(new Request("https://journal.internal/dashboard-bot/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }));
      } catch (error) {
        return json({ error: error.message }, /too large/iu.test(error.message) ? 413 : 400);
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
      const routedResponse = await store.fetch(new Request("https://journal.internal/dashboard-bot/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      }));
      const routed = await routedResponse.json();
      if (!routedResponse.ok) return json(routed, routedResponse.status);
      if (routed.command && routed.hubId) {
        const hubStore = env.JOURNAL.getByName(`dashboard-bot:${routed.hubId}`);
        const enqueueResponse = await hubStore.fetch(new Request("https://journal.internal/control/enqueue", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agent-Hub-Control-Expiry-Ms": String(DASHBOARD_BOT_COMMAND_EXPIRY_MS),
          },
          body: JSON.stringify(routed.command),
        }));
        if (!enqueueResponse.ok) {
          const error = await enqueueResponse.json().catch(() => ({}));
          return dashboardBotTelegramReply(
            update?.message?.chat?.id,
            `Agent Hub временно не принял сообщение: ${String(error?.error ?? "очередь недоступна").slice(0, 300)}`,
          );
        }
      }
      if (!routed.reply) return json({ ok: true, ignored: routed.ignored === true });
      return dashboardBotTelegramReply(update?.message?.chat?.id, routed.reply);
    }
    if (["/api/dashboard-bot/pull", "/api/dashboard-bot/result"].includes(url.pathname)) {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      const authenticated = await store.fetch(new Request(`https://journal.internal${url.pathname}`, request));
      if (!authenticated.ok) return authenticated;
      const identity = await authenticated.json();
      let payload;
      try {
        payload = parseJson(identity.body, "dashboard bot service request");
      } catch (error) {
        return json({ error: error.message }, 400);
      }
      const hubStore = env.JOURNAL.getByName(`dashboard-bot:${identity.hubId}`);
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
      return hubStore.fetch(new Request("https://journal.internal/control/result", {
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
    if (["/api/device/pairing", "/api/device/list", "/api/device/revoke"].includes(url.pathname)) {
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
        if (!allowedUserIds(env.ALLOWED_USER_IDS).has(userId)) throw new Error("user is not allowed");
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }));
        return response;
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }
    if (url.pathname === "/api/snapshot") {
      if (!["GET", "HEAD"].includes(request.method)) return json({ error: "Method Not Allowed" }, 405);
      const authorization = String(request.headers.get("Authorization") ?? "");
      let identity;
      try {
        if (authorization.startsWith("tma ")) {
          identity = { userId: String((await telegramUser(request, env)).id) };
        } else if (authorization.startsWith("device ")) {
          identity = { token: authorization.slice(7).trim() };
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
        const response = await store.fetch(new Request("https://journal.internal/control/enqueue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...command, userId: String(user.id) }),
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
          body: JSON.stringify({ id, userId, commandId }),
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
