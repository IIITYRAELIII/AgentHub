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
const CONTROL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SYNC_STAGING_EXPIRY_MS = 30 * 60 * 1_000;
const STORAGE_DELETE_BATCH_SIZE = 128;
const REMOTE_ATTACHMENT_PREFIX = "remote-attachment:";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS_PER_COMMAND = 8;
const MAX_ATTACHMENTS_PER_USER = 32;
const MAX_ATTACHMENT_BYTES_PER_USER = 100 * 1024 * 1024;
const ATTACHMENT_EXPIRY_MS = 30 * 60 * 1_000;
const IMAGE_CONTENT_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
]);
const CONTROL_ACTIONS = new Set([
  "snapshot",
  "task-history",
  "rate-limit-history",
  "search",
  "open-task",
  "open-turn",
  "select-task",
  "send-message",
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

async function readBoundedBody(request, maxBytes, label) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label} is too large`);
  }
  const body = await request.text();
  if (encoder.encode(body).byteLength > maxBytes) throw new Error(`${label} is too large`);
  return body;
}

async function readBoundedBinary(request, maxBytes, label) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label} is too large`);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) throw new Error(`${label} is too large`);
  return body;
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
    action !== "send-message"
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

async function deterministicAttachmentId(userId, bodyHash) {
  const value = await sha256(`${userId}\n${bodyHash}`);
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
  const body = await request.text();
  if (encoder.encode(body).byteLength > MAX_BODY_BYTES) throw new Error("sync payload is too large");
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
  const body = await request.arrayBuffer();
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

async function deleteStorageKeys(storage, keys) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  for (let offset = 0; offset < uniqueKeys.length; offset += STORAGE_DELETE_BATCH_SIZE) {
    await storage.delete(uniqueKeys.slice(offset, offset + STORAGE_DELETE_BATCH_SIZE));
  }
}

export class JournalStore extends DurableObject {
  #cachedPayload = null;

  async #controlCommands(storage = this.ctx.storage) {
    return [...(await storage.list({ prefix: "control:command:" })).values()];
  }

  async #cleanupControlCommands(now = Date.now(), storage = this.ctx.storage) {
    const commands = await this.#controlCommands(storage);
    const expiredKeys = commands
      .filter((command) => Number(command?.expiresAt ?? 0) <= now)
      .map((command) => `control:command:${command.id}`);
    if (expiredKeys.length) await storage.delete(expiredKeys);
    return commands.filter((command) => Number(command?.expiresAt ?? 0) > now);
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

  async #scheduleSyncCleanupAlarm(expiresAt) {
    if (!Number.isFinite(expiresAt)) return;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || expiresAt < currentAlarm) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  async alarm() {
    const nextExpiry = await this.#cleanupSyncStaging();
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
    if (request.method === "POST" && url.pathname === "/attachment/upload") {
      const userId = String(request.headers.get("X-Agent-Hub-User-Id") ?? "");
      const id = String(request.headers.get("X-Agent-Hub-Attachment-Id") ?? "").toLowerCase();
      const contentType = String(request.headers.get("Content-Type") ?? "").toLowerCase();
      const bodyHash = String(request.headers.get("X-Agent-Hub-Attachment-Hash") ?? "").toLowerCase();
      const body = await request.arrayBuffer();
      if (
        !userId
        || !CONTROL_ID_PATTERN.test(id)
        || !IMAGE_CONTENT_TYPES.has(contentType)
        || !/^[a-f0-9]{64}$/u.test(bodyHash)
        || body.byteLength < 1
        || body.byteLength > MAX_ATTACHMENT_BYTES
        || !imageMatchesContentType(body, contentType)
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
          if (existing.userId !== userId || existing.bodyHash !== bodyHash || existing.contentType !== contentType) {
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
          extension: IMAGE_CONTENT_TYPES.get(contentType),
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
      const key = `control:command:${command.id}`;
      const requestHash = await sha256(`${command.action}\n${stableStringify(command.params)}`);
      return this.ctx.storage.transaction(async (storage) => {
        const commands = await this.#cleanupControlCommands(now, storage);
        await this.#cleanupAttachments(now, storage);
        const existing = await storage.get(key);
        if (existing) {
          if (existing.userId !== userId || existing.requestHash !== requestHash) {
            return json({ error: "control command id conflict" }, 409);
          }
          return json(this.#controlStatus(existing), 200);
        }
        if (commands.length >= MAX_CONTROL_COMMANDS) {
          return json({ error: "control queue is full" }, 429);
        }
        const attachmentIds = attachmentIdsFromParams(command.action, command.params);
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
          expiresAt: now + CONTROL_EXPIRY_MS,
        };
        await storage.put({
          [key]: record,
          ...Object.fromEntries(attachmentManifests.map((manifest) => {
            manifest.commandIds = [...new Set([...(manifest.commandIds ?? []), command.id])];
            manifest.expiresAt = Math.max(manifest.expiresAt, record.expiresAt);
            return [`control:attachment:${manifest.id}`, manifest];
          })),
        });
        return json(this.#controlStatus(record), 202);
      });
    }
    if (request.method === "GET" && url.pathname === "/control/status") {
      const id = String(url.searchParams.get("id") ?? "").toLowerCase();
      const userId = String(url.searchParams.get("userId") ?? "");
      if (!CONTROL_ID_PATTERN.test(id) || !userId) return json({ error: "invalid control query" }, 400);
      await this.#cleanupControlCommands();
      const command = await this.ctx.storage.get(`control:command:${id}`);
      if (!command || command.userId !== userId) return json({ error: "control command not found" }, 404);
      return json(this.#controlStatus(command));
    }
    if (request.method === "POST" && url.pathname === "/control/pull") {
      const payload = await request.json();
      const limit = Math.min(20, Math.max(1, Number(payload?.limit) || 10));
      const now = Date.now();
      return this.ctx.storage.transaction(async (storage) => {
        const commands = (await this.#cleanupControlCommands(now, storage))
          .filter((command) => (
            command.status === "pending"
            || (command.status === "running" && Number(command.leaseExpiresAt ?? 0) <= now)
          ))
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(0, limit);
        if (commands.length) {
          await storage.put(Object.fromEntries(commands.map((command) => {
            command.status = "running";
            command.updatedAt = now;
            command.leaseExpiresAt = now + CONTROL_LEASE_MS;
            command.deliveryAttempt = Math.max(0, Number(command.deliveryAttempt) || 0) + 1;
            return [`control:command:${command.id}`, command];
          })));
        }
        return json({
          commands: commands.map((command) => ({
            id: command.id,
            userId: command.userId,
            action: command.action,
            params: command.params,
            createdAt: command.createdAt,
            expiresAt: command.expiresAt,
          })),
        });
      });
    }
    if (request.method === "POST" && url.pathname === "/control/result") {
      const payload = await request.json();
      const id = String(payload?.id ?? "").toLowerCase();
      const userId = String(payload?.userId ?? "");
      if (!CONTROL_ID_PATTERN.test(id) || !userId || typeof payload?.ok !== "boolean") {
        return json({ error: "invalid control result" }, 400);
      }
      const key = `control:command:${id}`;
      return this.ctx.storage.transaction(async (storage) => {
        const command = await storage.get(key);
        if (!command || command.userId !== userId) return json({ error: "control command not found" }, 404);
        if (command.status === "completed" || command.status === "failed") {
          return json(this.#controlStatus(command));
        }
        if (command.status !== "running") return json({ error: "control command is not running" }, 409);
        const now = Date.now();
        command.status = payload.ok ? "completed" : "failed";
        command.updatedAt = now;
        command.expiresAt = now + CONTROL_EXPIRY_MS;
        delete command.leaseExpiresAt;
        if (payload.ok) {
          command.result = payload.result ?? null;
          delete command.error;
        } else {
          command.error = String(payload.error ?? "Agent Hub control action failed").slice(0, MAX_CONTROL_ERROR_CHARS);
          delete command.result;
        }
        await storage.put(key, command);
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
      await this.#scheduleSyncCleanupAlarm(nextExpiry);
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
      await this.#scheduleSyncCleanupAlarm(expiresAt);
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

function secureStaticResponse(response) {
  const headers = new Headers(response.headers);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = env.JOURNAL.getByName("current");
    if (url.pathname === "/health") return json({ ok: true });
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
    if (url.pathname === "/api/attachment") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      let user;
      try {
        user = await telegramUser(request, env);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      try {
        const contentType = String(request.headers.get("Content-Type") ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (!IMAGE_CONTENT_TYPES.has(contentType)) throw new Error("unsupported image content type");
        const body = await readBoundedBinary(request, MAX_ATTACHMENT_BYTES, "remote attachment");
        if (body.byteLength < 1 || !imageMatchesContentType(body, contentType)) {
          throw new Error("image content does not match its type");
        }
        const bodyHash = await sha256(body);
        const requestedId = String(request.headers.get("X-Agent-Hub-Attachment-Id") ?? "").toLowerCase();
        const id = requestedId || await deterministicAttachmentId(String(user.id), bodyHash);
        if (!CONTROL_ID_PATTERN.test(id)) throw new Error("invalid remote attachment id");
        return store.fetch(new Request("https://journal.internal/attachment/upload", {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            "X-Agent-Hub-User-Id": String(user.id),
            "X-Agent-Hub-Attachment-Id": id,
            "X-Agent-Hub-Attachment-Hash": bodyHash,
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
        user = await telegramUser(request, env);
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
        user = await telegramUser(request, env);
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      const id = String(url.searchParams.get("id") ?? "").toLowerCase();
      if (!CONTROL_ID_PATTERN.test(id)) return json({ error: "invalid control command id" }, 400);
      const response = await store.fetch(new Request(
        `https://journal.internal/control/status?id=${encodeURIComponent(id)}&userId=${encodeURIComponent(user.id)}`,
      ));
      if (!response.ok) return response;
      const payload = await response.json();
      if (payload.status === "pending" || payload.status === "running") {
        return json({ ok: true, pending: true, id, status: payload.status }, 202);
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
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("invalid control pull limit");
        return store.fetch(new Request("https://journal.internal/control/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit }),
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
        await telegramUser(request, env);
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
    return secureStaticResponse(await env.ASSETS.fetch(request));
  },
};
