import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  attachmentContentType,
  attachmentMetadataFromId,
  createAttachmentStorageName,
  MAX_ATTACHMENT_BYTES,
} from "../../domain/attachment-files.mjs";
import {
  extractRateLimitsHtml,
  publicJournalPayload,
} from "./mini-app-journal-data.mjs";
import { JournalDatabase } from "../../infrastructure/persistence/journal-database.mjs";

export { extractWorkLogHtml } from "./mini-app-journal-data.mjs";

const require = createRequire(import.meta.url);
const { loadThemeRegistry, renderThemeHtml } = require("../../../theme-registry.cjs");

const AGENT_HUB_ROOT = path.resolve(import.meta.dirname, "../../..");

const CONTENT_TYPES = new Map([
  ["/", "text/html; charset=utf-8"],
  ["/browser-device-auth.js", "text/javascript; charset=utf-8"],
  ["/message-disclosure.js", "text/javascript; charset=utf-8"],
  ["/app.js", "text/javascript; charset=utf-8"],
  ["/message-lifecycle.js", "text/javascript; charset=utf-8"],
  ["/hub-client.js", "text/javascript; charset=utf-8"],
  ["/context-flash.mjs", "text/javascript; charset=utf-8"],
  ["/styles.css", "text/css; charset=utf-8"],
  ["/backgrounds.css", "text/css; charset=utf-8"],
  ["/work-log.css", "text/css; charset=utf-8"],
  ["/agent-hub-mark.png", "image/png"],
]);
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/browser-device-auth.js", "browser-device-auth.js"],
  ["/message-disclosure.js", "message-disclosure.js"],
  ["/app.js", "app.js"],
  ["/message-lifecycle.js", "message-lifecycle.js"],
  ["/hub-client.js", "hub-client.js"],
  ["/context-flash.mjs", "context-flash.mjs"],
  ["/styles.css", "styles.css"],
  ["/backgrounds.css", "backgrounds.css"],
  ["/agent-hub-mark.png", "agent-hub-mark.png"],
]);
const IMMUTABLE_STATIC_FILES = new Set(["/agent-hub-mark.png"]);
const MAX_CONTROL_REQUEST_BYTES = 512 * 1024;
const MAX_MOBILE_UPDATE_BYTES = 100 * 1024 * 1024;
const MOBILE_UPDATE_FILE = "AgentHub-Mobile.apk";
const MOBILE_UPDATE_MANIFEST = "update.json";

function attachmentHeaderName(request) {
  const value = String(request.headers["x-agent-hub-file-name"] ?? "").trim();
  if (!value) return "attachment.bin";
  try {
    return decodeURIComponent(value);
  } catch {
    return "attachment.bin";
  }
}

function downloadDisposition(name) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(String(name ?? "attachment"))}`;
}

async function readJsonBody(request, maxBytes = MAX_CONTROL_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Запрос слишком большой");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ожидался JSON-объект");
  }
  return value;
}

async function readBinaryBody(request, maxBytes = MAX_ATTACHMENT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Файл превышает 20 МБ");
    chunks.push(chunk);
  }
  if (!size) throw new Error("Пустое изображение");
  return Buffer.concat(chunks);
}
const HEARTBEAT_INTERVAL_MS = 20_000;
const CHANGE_DEBOUNCE_MS = 75;
const PUBLIC_AUTH_WINDOW_MS = 60_000;
const PUBLIC_AUTH_ATTEMPT_LIMIT = 30;
const PUBLIC_AUTH_BUCKET_CAPACITY = 2_000;
const TELEGRAM_AUTH_MAX_AGE_SECONDS = 86_400;
const LOCAL_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const LOCAL_SESSION_COOKIE = "agent_hub_local";

function safeEqualText(left, right) {
  const leftBytes = Buffer.from(String(left ?? ""), "utf8");
  const rightBytes = Buffer.from(String(right ?? ""), "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function cookieValue(request, name) {
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function localSessionValue(secret, now = Date.now()) {
  const issuedAt = Math.floor(now / 1_000);
  const nonce = randomBytes(18).toString("base64url");
  const payload = `${issuedAt}.${nonce}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function validLocalSession(value, secret, now = Date.now()) {
  const match = /^(\d{10,12})\.([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/u.exec(String(value ?? ""));
  if (!match) return false;
  const issuedAt = Number(match[1]);
  const ageSeconds = Math.floor(now / 1_000) - issuedAt;
  if (!Number.isSafeInteger(issuedAt) || ageSeconds < -30 || ageSeconds > LOCAL_SESSION_MAX_AGE_SECONDS) {
    return false;
  }
  const payload = `${match[1]}.${match[2]}`;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  return safeEqualText(match[3], expected);
}

export function validateTelegramInitData(initData, {
  botToken,
  allowedUserIds,
  maxAgeSeconds = TELEGRAM_AUTH_MAX_AGE_SECONDS,
  now = Date.now(),
} = {}) {
  const params = new URLSearchParams(String(initData ?? ""));
  const receivedHash = params.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/iu.test(receivedHash)) throw new Error("invalid hash");
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(String(botToken ?? "")).digest();
  const expectedHash = createHmac("sha256", secret).update(dataCheckString).digest();
  const suppliedHash = Buffer.from(receivedHash, "hex");
  if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
    throw new Error("signature mismatch");
  }
  const authDate = Number(params.get("auth_date"));
  const ageSeconds = Math.floor(now / 1_000) - authDate;
  if (!Number.isSafeInteger(authDate) || ageSeconds < -30 || ageSeconds > maxAgeSeconds) {
    throw new Error("expired auth date");
  }
  let user;
  try {
    user = JSON.parse(params.get("user") ?? "");
  } catch {
    throw new Error("invalid user");
  }
  const userId = Number(user?.id);
  if (!Number.isSafeInteger(userId) || !allowedUserIds?.has(userId)) {
    throw new Error("user is not allowed");
  }
  return { ...user, id: userId };
}

function loopbackHost(hostHeader) {
  const value = String(hostHeader ?? "").trim();
  if (!value) return false;
  try {
    return ["127.0.0.1", "localhost", "::1"].includes(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}

export function miniAppMenuButtonRequests({
  url,
  text = "Журнал",
  chatIds = [],
} = {}) {
  const menuButton = {
    type: "web_app",
    text: String(text),
    web_app: { url: String(url) },
  };
  return [
    { menu_button: menuButton },
    ...[...chatIds].map((chatId) => ({
      chat_id: chatId,
      menu_button: menuButton,
    })),
  ];
}

function responseHeaders(contentType, { immutable = false } = {}) {
  return {
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self' https://telegram.org",
      "style-src 'self'",
    ].join("; "),
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function send(response, statusCode, contentType, body, method = "GET", options = {}) {
  const { headers = {}, ...headerOptions } = options;
  response.writeHead(statusCode, {
    ...responseHeaders(contentType, headerOptions),
    ...headers,
  });
  response.end(method === "HEAD" ? "" : body);
}

function json(response, statusCode, value, method = "GET", options = {}) {
  send(
    response,
    statusCode,
    "application/json; charset=utf-8",
    `${JSON.stringify(value)}\n`,
    method,
    options,
  );
}

async function sendBoundedFile(
  response,
  target,
  bytes,
  contentType,
  method = "GET",
  headers = {},
) {
  response.writeHead(200, {
    ...responseHeaders(contentType),
    "Content-Length": String(bytes),
    ...headers,
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  await pipeline(createReadStream(target, { start: 0, end: bytes - 1 }), response);
}

/**
 * Fixed-capacity, expiry-aware LRU limiter for public device-authentication
 * endpoints. A Map's insertion order is the LRU order, so every operation is
 * O(1): expired entries are removed only when they are touched and capacity is
 * enforced by evicting one oldest entry. This deliberately avoids sweeping all
 * distinct client IPs for every unauthenticated request.
 */
export class PublicAuthAttemptLimiter {
  #buckets = new Map();
  #capacity;
  #limit;
  #windowMs;

  constructor({
    capacity = PUBLIC_AUTH_BUCKET_CAPACITY,
    limit = PUBLIC_AUTH_ATTEMPT_LIMIT,
    windowMs = PUBLIC_AUTH_WINDOW_MS,
  } = {}) {
    this.#capacity = Math.max(1, Math.floor(Number(capacity) || PUBLIC_AUTH_BUCKET_CAPACITY));
    this.#limit = Math.max(1, Math.floor(Number(limit) || PUBLIC_AUTH_ATTEMPT_LIMIT));
    this.#windowMs = Math.max(1, Math.floor(Number(windowMs) || PUBLIC_AUTH_WINDOW_MS));
  }

  get size() {
    return this.#buckets.size;
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
      // A successful lookup also counts as use for the LRU policy.
      this.#buckets.delete(normalizedKey);
    }
    bucket.count += 1;
    this.#buckets.set(normalizedKey, bucket);
    const allowed = bucket.count <= this.#limit;
    return {
      allowed,
      retryAfter: allowed ? 0 : Math.max(1, Math.ceil((bucket.startedAt + this.#windowMs - observedAt) / 1_000)),
    };
  }
}

export class MiniAppServer {
  #allowedUserIds;
  #assetsDirectory;
  #attachmentDirectory;
  #botToken;
  #clients = new Set();
  #controlHandler;
  #deviceStore;
  #changeTimer = null;
  #heartbeatTimer = null;
  #host;
  #journalCache = null;
  #journalDatabase;
  #ownsJournalDatabase;
  #unsubscribeJournal = null;
  #localAccessSecret;
  #localAccessSecretFile;
  #mobileUpdateDirectory;
  #port;
  #publicAuthAttempts = new PublicAuthAttemptLimiter();
  #requireTelegramAuth;
  #server = null;
  #themeRegistry;
  #workLogCssFile;

  constructor({
    host = "127.0.0.1",
    port = 8787,
    botToken = "",
    allowedUserIds = new Set(),
    requireTelegramAuth = false,
    localAccessSecret = "",
    localAccessSecretFile = null,
    controlHandler = null,
    deviceStore = null,
    assetsDirectory = path.join(AGENT_HUB_ROOT, "assets", "mini-app"),
    attachmentDirectory = null,
    mobileUpdateDirectory = path.join(AGENT_HUB_ROOT, "assets", "mobile"),
    workLogCssFile = path.join(AGENT_HUB_ROOT, "work-log.css"),
    journalDatabase = null,
    journalDatabaseFile = null,
  } = {}) {
    this.#host = String(host);
    this.#port = Number(port);
    this.#botToken = String(botToken);
    this.#allowedUserIds = new Set(allowedUserIds);
    this.#requireTelegramAuth = requireTelegramAuth === true;
    this.#localAccessSecret = String(localAccessSecret);
    this.#localAccessSecretFile = localAccessSecretFile ? path.resolve(localAccessSecretFile) : null;
    this.#controlHandler = typeof controlHandler === "function" ? controlHandler : null;
    this.#deviceStore = deviceStore;
    this.#assetsDirectory = path.resolve(assetsDirectory);
    this.#themeRegistry = loadThemeRegistry(this.#assetsDirectory);
    this.#attachmentDirectory = attachmentDirectory ? path.resolve(attachmentDirectory) : null;
    this.#mobileUpdateDirectory = mobileUpdateDirectory
      ? path.resolve(mobileUpdateDirectory)
      : null;
    this.#workLogCssFile = path.resolve(workLogCssFile);
    if (!journalDatabase && !journalDatabaseFile) {
      throw new Error("Mini App journalDatabase or journalDatabaseFile is required");
    }
    this.#journalDatabase = journalDatabase ?? new JournalDatabase(journalDatabaseFile);
    this.#ownsJournalDatabase = !journalDatabase;
  }

  async #journal() {
    this.#journalCache = await this.#journalDatabase.payload();
    if (!this.#journalCache) throw new Error("Журнал ещё не создан");
    return this.#journalCache;
  }

  async #mobileUpdate() {
    if (!this.#mobileUpdateDirectory) throw new Error("Обновление Android отключено");
    const manifestFile = path.join(this.#mobileUpdateDirectory, MOBILE_UPDATE_MANIFEST);
    const apkFile = path.join(this.#mobileUpdateDirectory, MOBILE_UPDATE_FILE);
    const [manifestInfo, apkInfo] = await Promise.all([stat(manifestFile), stat(apkFile)]);
    if (!manifestInfo.isFile() || manifestInfo.size < 2 || manifestInfo.size > 16 * 1024) {
      throw new Error("Manifest обновления повреждён");
    }
    if (!apkInfo.isFile() || apkInfo.size < 1 || apkInfo.size > MAX_MOBILE_UPDATE_BYTES) {
      throw new Error("APK обновления отсутствует или слишком велик");
    }
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const versionCode = Number(manifest.versionCode);
    const versionName = String(manifest.versionName ?? "").trim();
    const sha256 = String(manifest.sha256 ?? "").trim().toLowerCase();
    const bytes = Number(manifest.bytes);
    if (
      !Number.isSafeInteger(versionCode) || versionCode < 1
      || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(versionName)
      || !/^[a-f0-9]{64}$/u.test(sha256)
      || !Number.isSafeInteger(bytes) || bytes !== apkInfo.size
    ) {
      throw new Error("Manifest обновления содержит некорректные данные");
    }
    return { versionCode, versionName, sha256, bytes, apkFile };
  }

  async #staticBody(pathname) {
    if (pathname === "/work-log.css") return readFile(this.#workLogCssFile, "utf8");
    const themeResource = this.#themeRegistry.resources.get(pathname);
    if (themeResource) {
      return themeResource.immutable
        ? readFile(themeResource.file)
        : readFile(themeResource.file, "utf8");
    }
    const file = STATIC_FILES.get(pathname);
    if (!file) return null;
    const target = path.join(this.#assetsDirectory, file);
    const body = IMMUTABLE_STATIC_FILES.has(pathname)
      ? await readFile(target)
      : await readFile(target, "utf8");
    return pathname === "/" ? renderThemeHtml(body, this.#themeRegistry) : body;
  }

  #staticDescriptor(pathname) {
    const themeResource = this.#themeRegistry.resources.get(pathname);
    if (themeResource) return themeResource;
    const contentType = CONTENT_TYPES.get(pathname);
    return contentType ? { contentType, immutable: IMMUTABLE_STATIC_FILES.has(pathname) } : null;
  }

  #writeEvent(response, event, data) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #requestNeedsTelegramAuth(request) {
    return this.#requireTelegramAuth || Boolean(
      request.headers["cf-connecting-ip"]
      || request.headers["x-forwarded-for"]
      || !loopbackHost(request.headers.host),
    );
  }

  async #refreshLocalAccessSecret() {
    if (!this.#localAccessSecretFile) return this.#localAccessSecret;
    try {
      const candidate = String(await readFile(this.#localAccessSecretFile, "utf8")).trim();
      if (/^[A-Za-z0-9_-]{43,128}$/u.test(candidate)) this.#localAccessSecret = candidate;
    } catch {
      // A transient read failure must not invalidate an already active local session.
    }
    return this.#localAccessSecret;
  }

  async #authorize(request, response) {
    if (!this.#requestNeedsTelegramAuth(request)) {
      if (!this.#localAccessSecret) return { source: "local-mini-app" };
      const cookie = cookieValue(request, LOCAL_SESSION_COOKIE);
      let localAccessSecret = this.#localAccessSecret;
      if (!validLocalSession(cookie, localAccessSecret)) {
        localAccessSecret = await this.#refreshLocalAccessSecret();
      }
      if (validLocalSession(cookie, localAccessSecret)) {
        return { source: "local-mini-app" };
      }
      json(response, 401, { error: "Откройте локальный Agent Hub через защищённый ярлык." });
      return false;
    }
    const authorization = String(request.headers.authorization ?? "");
    if (authorization.startsWith("device ") && this.#deviceStore) {
      try {
        const session = await this.#deviceStore.resolveSession(authorization.slice(7));
        return {
          source: "trusted-device",
          userId: String(session.id),
          deviceId: String(session.deviceId ?? ""),
        };
      } catch {
        json(response, 403, { error: "Авторизация устройства недействительна." });
        return false;
      }
    }
    if (!authorization.startsWith("tma ")) {
      json(response, 401, { error: "Откройте Agent Hub из Telegram или доверенного приложения." });
      return false;
    }
    try {
      const user = validateTelegramInitData(authorization.slice(4), {
        botToken: this.#botToken,
        allowedUserIds: this.#allowedUserIds,
      });
      return { source: "telegram-mini-app", userId: String(user.id) };
    } catch {
      json(response, 403, { error: "Telegram-авторизация недействительна." });
      return false;
    }
  }

  #broadcastChange() {
    const payload = { changedAt: new Date().toISOString() };
    for (const response of this.#clients) this.#writeEvent(response, "journal", payload);
  }

  #scheduleChange() {
    if (this.#changeTimer) clearTimeout(this.#changeTimer);
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      this.#broadcastChange();
    }, CHANGE_DEBOUNCE_MS);
    this.#changeTimer.unref?.();
  }

  #consumePublicAuthAttempt(request, response) {
    if (!this.#requestNeedsTelegramAuth(request)) return true;
    const now = Date.now();
    const forwarded = String(request.headers["x-forwarded-for"] ?? "")
      .split(",")
      .at(-1)
      ?.trim();
    const key = String(
      request.headers["cf-connecting-ip"] ?? forwarded ?? request.socket.remoteAddress ?? "unknown",
    ).slice(0, 128);
    const attempt = this.#publicAuthAttempts.consume(key, now);
    if (attempt.allowed) return true;
    json(response, 429, { error: "Слишком много запросов авторизации." }, request.method, {
      headers: { "Retry-After": String(attempt.retryAfter) },
    });
    return false;
  }

  async #handle(request, response) {
    const method = String(request.method ?? "GET").toUpperCase();
    const url = new URL(request.url ?? "/", `http://${this.#host}`);
    if (url.pathname === "/api/local-session") {
      if (
        method !== "POST"
        || this.#requireTelegramAuth
        || !loopbackHost(request.headers.host)
        || String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase()
          !== "application/json"
      ) {
        json(response, 404, { error: "Not Found" }, method);
        return;
      }
      const authorization = String(request.headers.authorization ?? "");
      const supplied = authorization.startsWith("local ") ? authorization.slice(6).trim() : "";
      let localAccessSecret = this.#localAccessSecret;
      if (!localAccessSecret || !safeEqualText(supplied, localAccessSecret)) {
        localAccessSecret = await this.#refreshLocalAccessSecret();
      }
      if (!localAccessSecret || !safeEqualText(supplied, localAccessSecret)) {
        json(response, 403, { error: "Локальная авторизация недействительна." }, method);
        return;
      }
      json(response, 200, { ok: true }, method, {
        headers: {
          "Set-Cookie": `${LOCAL_SESSION_COOKIE}=${localSessionValue(localAccessSecret)};`
            + ` Max-Age=${LOCAL_SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Strict`,
        },
      });
      return;
    }
    if (["/api/device/pair", "/api/device/challenge", "/api/device/session"].includes(url.pathname)) {
      if (method !== "POST") {
        response.writeHead(405, {
          Allow: "POST",
          ...responseHeaders("text/plain; charset=utf-8"),
        });
        response.end("Method Not Allowed\n");
        return;
      }
      if (!this.#deviceStore) {
        json(response, 503, { error: "Авторизация доверенных устройств недоступна." }, method);
        return;
      }
      if (!this.#consumePublicAuthAttempt(request, response)) return;
      if (
        String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase()
        !== "application/json"
      ) {
        json(response, 415, { error: "Ожидался application/json." }, method);
        return;
      }
      try {
        const body = await readJsonBody(request);
        const result = url.pathname.endsWith("/pair")
          ? await this.#deviceStore.pair(body)
          : url.pathname.endsWith("/challenge")
            ? await this.#deviceStore.createChallenge(body)
            : await this.#deviceStore.createSession(body);
        json(response, url.pathname.endsWith("/pair") ? 201 : 200, result, method);
      } catch (error) {
        json(response, 400, { error: String(error?.message ?? error) }, method);
      }
      return;
    }
    if (url.pathname === "/api/control") {
      if (method !== "POST") {
        response.writeHead(405, {
          Allow: "POST",
          ...responseHeaders("text/plain; charset=utf-8"),
        });
        response.end("Method Not Allowed\n");
        return;
      }
      const authorization = await this.#authorize(request, response);
      if (!authorization) return;
      if (
        String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase()
        !== "application/json"
      ) {
        json(response, 415, { error: "Ожидался application/json." }, method);
        return;
      }
      if (!this.#controlHandler) {
        json(response, 503, { error: "Управление Agent Hub недоступно." }, method);
        return;
      }
      try {
        const body = await readJsonBody(request);
        const action = String(body.action ?? "").trim();
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(action)) {
          throw new Error("Некорректная команда");
        }
        const params = body.params == null ? {} : body.params;
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          throw new Error("Некорректные параметры команды");
        }
        json(response, 200, {
          ok: true,
          result: await this.#controlHandler({ action, params, context: authorization }),
        }, method);
      } catch (error) {
        json(response, 400, { ok: false, error: String(error?.message ?? error) }, method);
      }
      return;
    }
    if (url.pathname === "/api/attachment") {
      if (method !== "POST") {
        response.writeHead(405, {
          Allow: "POST",
          ...responseHeaders("text/plain; charset=utf-8"),
        });
        response.end("Method Not Allowed\n");
        return;
      }
      if (!await this.#authorize(request, response)) return;
      if (!this.#attachmentDirectory) {
        json(response, 503, { error: "Загрузка файлов недоступна." }, method);
        return;
      }
      try {
        const originalName = attachmentHeaderName(request);
        const contentType = attachmentContentType(originalName, request.headers["content-type"]);
        const body = await readBinaryBody(request);
        await mkdir(this.#attachmentDirectory, { recursive: true });
        const id = createAttachmentStorageName(originalName, randomUUID());
        const target = path.join(this.#attachmentDirectory, id);
        await writeFile(target, body, { flag: "wx", mode: 0o600 });
        json(response, 201, {
          ok: true,
          path: target,
          attachment: { ...attachmentMetadataFromId(id), type: contentType },
        }, method);
      } catch (error) {
        json(response, 400, { ok: false, error: String(error?.message ?? error) }, method);
      }
      return;
    }
    if (url.pathname.startsWith("/api/message-attachment/")) {
      if (!["GET", "HEAD"].includes(method)) {
        response.writeHead(405, {
          Allow: "GET, HEAD",
          ...responseHeaders("text/plain; charset=utf-8"),
        });
        response.end("Method Not Allowed\n");
        return;
      }
      if (!await this.#authorize(request, response)) return;
      if (!this.#attachmentDirectory) {
        json(response, 503, { error: "Хранилище вложений недоступно." }, method);
        return;
      }
      try {
        const id = decodeURIComponent(url.pathname.slice("/api/message-attachment/".length)).trim();
        const metadata = attachmentMetadataFromId(id);
        if (!metadata) throw new Error("Некорректный идентификатор вложения");
        const target = path.join(this.#attachmentDirectory, id);
        const info = await stat(target);
        if (!info.isFile() || info.size < 1 || info.size > MAX_ATTACHMENT_BYTES) {
          throw new Error("Вложение отсутствует или повреждено");
        }
        send(response, 200, metadata.type, await readFile(target), method, {
          headers: {
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
            ...(metadata.isImage ? {} : { "Content-Disposition": downloadDisposition(metadata.name) }),
          },
        });
      } catch {
        json(response, 404, { error: "Вложение не найдено." }, method);
      }
      return;
    }
    if (!["GET", "HEAD"].includes(method)) {
      response.writeHead(405, {
        Allow: "GET, HEAD",
        ...responseHeaders("text/plain; charset=utf-8"),
      });
      response.end("Method Not Allowed\n");
      return;
    }
    if (url.pathname === "/health") {
      json(response, 200, { ok: true }, method);
      return;
    }
    if (url.pathname === "/api/mobile/update" || url.pathname === "/api/mobile/update.apk") {
      if (!await this.#authorize(request, response)) return;
      try {
        const update = await this.#mobileUpdate();
        if (url.pathname.endsWith(".apk")) {
          await sendBoundedFile(
            response,
            update.apkFile,
            update.bytes,
            "application/vnd.android.package-archive",
            method,
            {
              "Cache-Control": "private, no-store",
              "Content-Disposition": `attachment; filename="${MOBILE_UPDATE_FILE}"`,
              ETag: `"sha256-${update.sha256}"`,
            },
          );
        } else {
          json(response, 200, {
            versionCode: update.versionCode,
            versionName: update.versionName,
            sha256: update.sha256,
            bytes: update.bytes,
            downloadUrl: "/api/mobile/update.apk",
          }, method, { headers: { "Cache-Control": "private, no-store" } });
        }
      } catch (error) {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        json(response, 503, { error: `Обновление Android недоступно: ${error.message}` }, method);
      }
      return;
    }
    if (url.pathname === "/api/rate-limits") {
      if (!await this.#authorize(request, response)) return;
      try {
        const journal = await this.#journal();
        json(response, 200, extractRateLimitsHtml(journal.html), method);
      } catch (error) {
        json(response, 503, { error: `Лимиты недоступны: ${error.message}` }, method);
      }
      return;
    }
    if (url.pathname === "/api/journal") {
      if (!await this.#authorize(request, response)) return;
      try {
        const journal = await this.#journal();
        const etag = `"${journal.version}"`;
        if (String(request.headers["if-none-match"] ?? "") === etag) {
          response.writeHead(304, {
            ...responseHeaders("application/json; charset=utf-8"),
            ETag: etag,
          });
          response.end();
          return;
        }
        json(response, 200, publicJournalPayload(journal), method, { headers: { ETag: etag } });
      } catch (error) {
        json(response, 503, { error: `Журнал недоступен: ${error.message}` }, method);
      }
      return;
    }
    if (url.pathname === "/api/journal/day" || url.pathname === "/api/journal/turn") {
      if (!await this.#authorize(request, response)) return;
      try {
        const journal = await this.#journal();
        const requestedVersion = String(url.searchParams.get("version") ?? "");
        if (requestedVersion && requestedVersion !== journal.version) {
          json(response, 409, { error: "Журнал обновился.", version: journal.version }, method);
          return;
        }
        const key = url.pathname.endsWith("/day")
          ? String(url.searchParams.get("date") ?? "")
          : String(url.searchParams.get("id") ?? "");
        const html = await this.#journalDatabase.fragment(
          url.pathname.endsWith("/day") ? "day" : "turn",
          key,
        );
        if (typeof html !== "string") {
          json(response, 404, { error: "Фрагмент журнала не найден." }, method);
          return;
        }
        json(response, 200, { html, version: journal.version }, method);
      } catch (error) {
        json(response, 503, { error: `Журнал недоступен: ${error.message}` }, method);
      }
      return;
    }
    if (url.pathname === "/events") {
      if (!await this.#authorize(request, response)) return;
      if (method === "HEAD") {
        send(response, 200, "text/event-stream; charset=utf-8", "", method);
        return;
      }
      response.writeHead(200, {
        ...responseHeaders("text/event-stream; charset=utf-8"),
        Connection: "keep-alive",
      });
      response.write("retry: 1500\n\n");
      this.#writeEvent(response, "ready", { connectedAt: new Date().toISOString() });
      this.#clients.add(response);
      request.on("close", () => this.#clients.delete(response));
      return;
    }
    const descriptor = this.#staticDescriptor(url.pathname);
    if (!descriptor) {
      send(response, 404, "text/plain; charset=utf-8", "Not Found\n", method);
      return;
    }
    try {
      send(
        response,
        200,
        descriptor.contentType,
        await this.#staticBody(url.pathname),
        method,
        { immutable: descriptor.immutable },
      );
    } catch (error) {
      send(response, 500, "text/plain; charset=utf-8", `Cannot load Mini App: ${error.message}\n`, method);
    }
  }

  async start() {
    if (this.#server) return this.address();
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        if (!response.headersSent) {
          send(response, 500, "text/plain; charset=utf-8", `Mini App error: ${error.message}\n`);
        } else {
          response.destroy(error);
        }
      });
    });
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 100;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, this.#host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
    this.#unsubscribeJournal = this.#journalDatabase.subscribe(() => {
      this.#journalCache = null;
      this.#scheduleChange();
    });
    this.#heartbeatTimer = setInterval(() => {
      for (const response of this.#clients) response.write(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);
    this.#heartbeatTimer.unref?.();
    return this.address();
  }

  address() {
    const address = this.#server?.address();
    if (!address || typeof address === "string") return null;
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return {
      host: address.address,
      port: address.port,
      url: `http://${host}:${address.port}/`,
    };
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    if (this.#changeTimer) clearTimeout(this.#changeTimer);
    this.#changeTimer = null;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    this.#unsubscribeJournal?.();
    this.#unsubscribeJournal = null;
    for (const response of this.#clients) response.end();
    this.#clients.clear();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (this.#ownsJournalDatabase) this.#journalDatabase.close();
  }
}
