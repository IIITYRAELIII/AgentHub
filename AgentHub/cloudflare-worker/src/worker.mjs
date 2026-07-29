import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();
const MAX_SYNC_AGE_SECONDS = 300;
const MAX_TELEGRAM_AUTH_AGE_SECONDS = 86_400;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_COUNT = 256;
const SYNC_ID_PATTERN = /^[a-z0-9_-]{8,100}$/iu;

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

export class JournalStore extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") {
      const payload = await request.json();
      await this.ctx.storage.put("journal", payload);
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/sync-chunk") {
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
      await this.ctx.storage.put({
        [metadataKey]: { syncId, count, encoding, version, updatedAt },
        [chunkKey]: await request.arrayBuffer(),
      });
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
      if (previous?.syncId && previous.syncId !== syncId) {
        await this.ctx.storage.delete(
          Array.from({ length: previous.count }, (_, chunkIndex) => `chunk:${previous.syncId}:${chunkIndex}`),
        );
      }
      return json({ ok: true, complete: true });
    }
    if (request.method === "GET" && url.pathname === "/journal") {
      const knownVersion = String(request.headers.get("If-None-Match") ?? "");
      const manifest = await this.ctx.storage.get("journal-manifest");
      if (manifest) {
        const etag = `"${manifest.version}"`;
        if (knownVersion === etag) {
          return new Response(null, {
            status: 304,
            headers: {
              ETag: etag,
              "X-Agent-Hub-Journal-Version": manifest.version,
            },
          });
        }
        const chunkKeys = Array.from(
          { length: manifest.count },
          (_, chunkIndex) => `chunk:${manifest.syncId}:${chunkIndex}`,
        );
        const chunks = await this.ctx.storage.get(chunkKeys);
        if (chunks.size !== manifest.count) return json({ error: "Снимок журнала повреждён." }, 503);
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
        return new Response(body, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
            ETag: etag,
            "X-Agent-Hub-Journal-Version": manifest.version,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      const payload = await this.ctx.storage.get("journal");
      if (!payload) return json({ error: "Журнал ещё не опубликован." }, 503);
      const etag = `"${payload.version}"`;
      if (knownVersion === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      const response = json(payload);
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
    if (url.pathname === "/api/journal") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "Method Not Allowed" }, 405);
      }
      const authorization = String(request.headers.get("Authorization") ?? "");
      try {
        if (!authorization.startsWith("tma ")) throw new Error("Откройте журнал из Telegram.");
        await validateTelegramInitData(authorization.slice(4), {
          botToken: env.TELEGRAM_BOT_TOKEN,
          allowedIds: allowedUserIds(env.ALLOWED_USER_IDS),
        });
      } catch (error) {
        return json({ error: error.message }, 401);
      }
      const response = await store.fetch(new Request("https://journal.internal/journal", {
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
