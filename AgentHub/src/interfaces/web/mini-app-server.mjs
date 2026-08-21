import { createReadStream, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { agentHubRuntimeHealth } from "../../application/runtime-health.mjs";

import {
  attachmentContentType,
  attachmentMetadataFromId,
  createAttachmentStorageName,
  MAX_ATTACHMENT_BYTES,
} from "../../domain/attachment-files.mjs";
import {
  extractRateLimitsHtml,
  journalPayloadEtag,
  publicJournalPayload,
} from "./mini-app-journal-data.mjs";
import { JournalDatabase } from "../../infrastructure/persistence/journal-database.mjs";
import { pathInsideOrSame } from "../../infrastructure/filesystem/config.mjs";
import { validLocalWebviewSession } from "./local-webview-session.mjs";

export { extractWorkLogHtml } from "./mini-app-journal-data.mjs";

const require = createRequire(import.meta.url);
const { loadThemeRegistry, renderThemeHtml } = require("../../../theme-registry.cjs");
const { localAssetFile, localAssetReferences } = require("../../../client-assets.cjs");

const AGENT_HUB_ROOT = path.resolve(import.meta.dirname, "../../..");

const STATIC_CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ttf", "font/ttf"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);
function staticAssetManifest(assetsDirectory) {
  const root = path.resolve(assetsDirectory);
  const indexSource = readFileSync(path.join(root, "index.html"), "utf8");
  const assets = new Map([
    ["/", {
      binary: false,
      contentType: "text/html; charset=utf-8",
      file: "index.html",
      immutable: false,
    }],
  ]);
  for (const reference of localAssetReferences(indexSource)) {
    const { pathname, relative, target } = localAssetFile(root, reference);
    if (pathname === "/work-log.css") continue;
    if (!statSync(target).isFile()) throw new Error(`Не найден ресурс Agent Hub: ${pathname}`);
    const contentType = STATIC_CONTENT_TYPES.get(path.extname(pathname).toLowerCase());
    if (!contentType) throw new Error(`Неизвестный тип ресурса Agent Hub: ${pathname}`);
    const binary = !contentType.startsWith("text/") && contentType !== "image/svg+xml; charset=utf-8";
    assets.set(pathname, {
      binary,
      contentType,
      file: relative,
      immutable: binary,
    });
  }
  return assets;
}

function staticAssetBundle({ id = "", assetsDirectory, workLogCssFile }) {
  const resolvedAssetsDirectory = path.resolve(assetsDirectory);
  const resolvedWorkLogCssFile = path.resolve(workLogCssFile);
  return {
    id: String(id || `${resolvedAssetsDirectory}\0${resolvedWorkLogCssFile}`),
    assetsDirectory: resolvedAssetsDirectory,
    staticAssets: staticAssetManifest(resolvedAssetsDirectory),
    themeRegistry: loadThemeRegistry(resolvedAssetsDirectory),
    workLogCssFile: resolvedWorkLogCssFile,
  };
}
const MAX_CONTROL_REQUEST_BYTES = 512 * 1024;
const MAX_MOBILE_UPDATE_BYTES = 100 * 1024 * 1024;
const MAX_WORKSPACE_FILE_BYTES = 512 * 1024 * 1024;
const CONTROL_COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
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

function workspaceFilePath(value) {
  const source = String(value ?? "").trim();
  if (!source || source.length > 4_096 || source.includes("\0")) {
    throw new Error("Некорректный путь файла Workspace");
  }
  return path.resolve(source.replace(/:[1-9][0-9]*(?::[1-9][0-9]*)?$/u, ""));
}

async function resolveWorkspaceFile(value, roots) {
  const target = await realpath(workspaceFilePath(value));
  const resolvedRoots = (await Promise.all((roots ?? []).map(async (root) => {
    try {
      return await realpath(root);
    } catch {
      return null;
    }
  }))).filter(Boolean);
  if (!resolvedRoots.some((root) => pathInsideOrSame(target, root))) {
    throw new Error("Файл находится вне Workspace");
  }
  const info = await stat(target);
  if (!info.isFile() || info.size < 1 || info.size > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error("Файл отсутствует, пуст или превышает 512 МБ");
  }
  const name = path.basename(target);
  return {
    bytes: info.size,
    name,
    target,
    type: attachmentContentType(name),
  };
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
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    error.diagnosticExpected = true;
    throw error;
  }
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
const DEVICE_SESSION_COOKIE = "agent_hub_device";
const DEVICE_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const VSCODE_WEBVIEW_ORIGIN = /^(?:vscode-webview:\/\/[a-z0-9-]+|https:\/\/[a-z0-9-]+\.vscode-cdn\.net)$/iu;
const JSON_GZIP_MIN_BYTES = 16 * 1_024;

function safeEqualText(left, right) {
  const leftBytes = Buffer.from(String(left ?? ""), "utf8");
  const rightBytes = Buffer.from(String(right ?? ""), "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validUsageSyncService(service) {
  return Boolean(service && (
    typeof service.sync === "function"
    || typeof service.createEnrollmentCode === "function"
    || typeof service.enroll === "function"
  ));
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

function forwardedProtocol(request) {
  const value = String(request.headers["x-forwarded-proto"] ?? "").split(",", 1)[0].trim().toLowerCase();
  return ["http", "https"].includes(value) ? value : "";
}

/**
 * The origin this Hub answered on, derived from the request the proxy actually
 * routed here. Device challenges are bound to it, so a signature made for
 * another endpoint cannot be replayed against this one.
 */
function requestOrigin(request) {
  const host = String(request.headers.host ?? "").trim();
  if (!host) return "";
  const protocol = forwardedProtocol(request)
    || (request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"] ? "https" : "http");
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return "";
  }
}

function deviceSessionCookie(token, expiresAt, { secure = false } = {}) {
  const maxAgeSeconds = Math.max(1, Math.floor((Number(expiresAt) - Date.now()) / 1_000));
  return `${DEVICE_SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict`
    + `${secure ? "; Secure" : ""}`;
}

const TELEGRAM_RUNTIME_SCRIPT = /\s*<script src="https:\/\/telegram\.org\/[^"]*"><\/script>/u;

export function withoutTelegramRuntime(html) {
  return String(html).replace(TELEGRAM_RUNTIME_SCRIPT, "");
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

function responseHeaders(contentType, { immutable = false, telegramRuntime = true } = {}) {
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
      `script-src 'self'${telegramRuntime ? " https://telegram.org" : ""}`,
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

function acceptedEncodingQuality(value, encoding) {
  const qualities = new Map();
  for (const entry of String(value ?? "").toLowerCase().split(",")) {
    const [name, ...parameters] = entry.trim().split(";").map((item) => item.trim());
    if (!name) continue;
    const qualityParameter = parameters.find((item) => item.startsWith("q="));
    const quality = qualityParameter ? Number(qualityParameter.slice(2)) : 1;
    qualities.set(name, Number.isFinite(quality) ? quality : 0);
  }
  return qualities.get(encoding) ?? qualities.get("*") ?? 0;
}

function varyHeader(...values) {
  return [...new Set(values
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean))]
    .join(", ");
}

function json(response, statusCode, value, method = "GET", options = {}) {
  const { acceptEncoding = "", headers = {}, ...sendOptions } = options;
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const compressed = body.length >= JSON_GZIP_MIN_BYTES
    && acceptedEncodingQuality(acceptEncoding, "gzip") > 0;
  const responseBody = compressed ? gzipSync(body) : body;
  send(
    response,
    statusCode,
    "application/json; charset=utf-8",
    responseBody,
    method,
    {
      ...sendOptions,
      headers: {
        ...headers,
        "Content-Length": String(responseBody.length),
        ...(compressed ? {
          "Content-Encoding": "gzip",
          Vary: varyHeader(response.getHeader("Vary"), headers.Vary, "Accept-Encoding"),
        } : {}),
      },
    },
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
  #activeHandlers = new Set();
  #allowedUserIds;
  #assetBundle;
  #assetBundleProvider;
  #assetBundleRefreshAfter = 0;
  #assetBundleRefreshMs;
  #assetBundleWarning = "";
  #attachmentDirectory;
  #botToken;
  #clients = new Set();
  #controlHandler;
  #copyWorkspaceFile;
  #revealWorkspaceFile;
  #reportUnexpectedError;
  #onControlResultDelivered;
  #deviceStore;
  #changeTimer = null;
  #heartbeatTimer = null;
  #host;
  #health;
  #handlerCloseTimeoutMs;
  #journalCache = null;
  #journalDatabase;
  #usageSyncRemoteConfigStore;
  #usageSyncService;
  #ownsJournalDatabase;
  #unsubscribeJournal = null;
  #localAccessSecret;
  #localAccessSecretFile;
  #mobileUpdateDirectory;
  #port;
  #publicAuthAttempts = new PublicAuthAttemptLimiter();
  #requireTelegramAuth;
  #telegramRuntime;
  #server = null;
  #closePromise = null;
  #workspaceFileRoots;

  constructor({
    host = "127.0.0.1",
    port = 8787,
    botToken = "",
    allowedUserIds = new Set(),
    requireTelegramAuth = false,
    telegramRuntime = true,
    localAccessSecret = "",
    localAccessSecretFile = null,
    controlHandler = null,
    copyWorkspaceFile = null,
    revealWorkspaceFile = null,
    reportUnexpectedError = null,
    onControlResultDelivered = null,
    deviceStore = null,
    assetsDirectory = path.join(AGENT_HUB_ROOT, "assets", "web-app"),
    assetBundleProvider = null,
    assetBundleRefreshMs = 1_000,
    attachmentDirectory = null,
    mobileUpdateDirectory = path.join(AGENT_HUB_ROOT, "assets", "mobile"),
    workLogCssFile = path.join(AGENT_HUB_ROOT, "work-log.css"),
    journalDatabase = null,
    journalDatabaseFile = null,
    usageSyncRemoteConfigStore = null,
    usageSyncService = null,
    workspaceFileRoots = [],
    health = agentHubRuntimeHealth,
    handlerCloseTimeoutMs = 1_000,
  } = {}) {
    this.#host = String(host);
    this.#health = health && typeof health.snapshot === "function" ? health : agentHubRuntimeHealth;
    this.#handlerCloseTimeoutMs = Math.max(0, Number(handlerCloseTimeoutMs) || 0);
    this.#port = Number(port);
    this.#botToken = String(botToken);
    this.#allowedUserIds = new Set(allowedUserIds);
    this.#requireTelegramAuth = requireTelegramAuth === true;
    this.#telegramRuntime = telegramRuntime !== false;
    this.#localAccessSecret = String(localAccessSecret);
    this.#localAccessSecretFile = localAccessSecretFile ? path.resolve(localAccessSecretFile) : null;
    this.#controlHandler = typeof controlHandler === "function" ? controlHandler : null;
    this.#copyWorkspaceFile = typeof copyWorkspaceFile === "function" ? copyWorkspaceFile : null;
    this.#revealWorkspaceFile = typeof revealWorkspaceFile === "function" ? revealWorkspaceFile : null;
    this.#reportUnexpectedError = typeof reportUnexpectedError === "function" ? reportUnexpectedError : null;
    this.#onControlResultDelivered = typeof onControlResultDelivered === "function"
      ? onControlResultDelivered
      : null;
    this.#deviceStore = deviceStore;
    this.#assetBundle = staticAssetBundle({ assetsDirectory, workLogCssFile });
    this.#assetBundleProvider = typeof assetBundleProvider === "function" ? assetBundleProvider : null;
    this.#assetBundleRefreshMs = Math.max(0, Number(assetBundleRefreshMs) || 0);
    this.#attachmentDirectory = attachmentDirectory ? path.resolve(attachmentDirectory) : null;
    this.#mobileUpdateDirectory = mobileUpdateDirectory
      ? path.resolve(mobileUpdateDirectory)
      : null;
    this.#workspaceFileRoots = (workspaceFileRoots ?? [])
      .map((root) => String(root ?? "").trim())
      .filter(Boolean)
      .map((root) => path.resolve(root));
    if (!journalDatabase && !journalDatabaseFile) {
      throw new Error("Mini App journalDatabase or journalDatabaseFile is required");
    }
    this.#journalDatabase = journalDatabase ?? new JournalDatabase(journalDatabaseFile);
    this.#usageSyncRemoteConfigStore = usageSyncRemoteConfigStore;
    this.#usageSyncService = validUsageSyncService(usageSyncService) ? usageSyncService : null;
    this.#ownsJournalDatabase = !journalDatabase;
  }

  setUsageSyncService(service = null) {
    this.#usageSyncService = validUsageSyncService(service) ? service : null;
  }

  async #activeAssetBundle() {
    if (!this.#assetBundleProvider) return this.#assetBundle;
    const now = Date.now();
    if (now < this.#assetBundleRefreshAfter) return this.#assetBundle;
    this.#assetBundleRefreshAfter = now + this.#assetBundleRefreshMs;
    try {
      const candidate = await this.#assetBundleProvider();
      const id = String(candidate?.id ?? "").trim();
      if (id && id === this.#assetBundle.id) return this.#assetBundle;
      const next = staticAssetBundle(candidate ?? {});
      this.#assetBundle = next;
      this.#assetBundleWarning = "";
    } catch (error) {
      const warning = `Cannot switch Mini App assets: ${error.message}`;
      if (warning !== this.#assetBundleWarning) console.warn(warning);
      this.#assetBundleWarning = warning;
    }
    return this.#assetBundle;
  }

  async #journal() {
    this.#journalCache = await this.#journalDatabase.payload();
    if (!this.#journalCache) throw new Error("Журнал ещё не создан");
    return this.#journalCache;
  }

  async #usageSyncStatus() {
    if (!this.#usageSyncRemoteConfigStore || typeof this.#usageSyncRemoteConfigStore.load !== "function") {
      return null;
    }
    try {
      return await this.#usageSyncRemoteConfigStore.load();
    } catch (error) {
      this.#reportUnexpectedError?.(error, {
        surface: "mini-app",
        component: "usage-sync",
        action: "status",
      });
      return null;
    }
  }

  async #manualUsageSync() {
    if (!this.#usageSyncService) throw new Error("Синхронизация расхода недоступна");
    const result = await this.#usageSyncService.sync();
    this.#journalCache = null;
    return result;
  }

  async #createUsageSyncInvite() {
    if (!this.#usageSyncService?.createEnrollmentCode) {
      throw new Error("Создание кода Sync недоступно");
    }
    return this.#usageSyncService.createEnrollmentCode({ ttlSeconds: 10_800 });
  }

  async #enrollUsageSync(request) {
    if (!this.#usageSyncService?.enroll) throw new Error("Подключение Sync недоступно");
    const body = await readJsonBody(request, 16 * 1024);
    const result = await this.#usageSyncService.enroll({
      serverUrl: body.serverUrl,
      code: body.code,
    });
    this.#journalCache = null;
    return result;
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

  async #staticBody(pathname, bundle) {
    if (pathname === "/work-log.css") return readFile(bundle.workLogCssFile, "utf8");
    const themeResource = bundle.themeRegistry.resources.get(pathname);
    if (themeResource) {
      return themeResource.immutable
        ? readFile(themeResource.file)
        : readFile(themeResource.file, "utf8");
    }
    const asset = bundle.staticAssets.get(pathname);
    if (!asset) return null;
    const target = path.join(bundle.assetsDirectory, asset.file);
    const body = asset.binary
      ? await readFile(target)
      : await readFile(target, "utf8");
    return pathname === "/" ? renderThemeHtml(body, bundle.themeRegistry) : body;
  }

  #staticDescriptor(pathname, bundle) {
    const themeResource = bundle.themeRegistry.resources.get(pathname);
    if (themeResource) return themeResource;
    if (pathname === "/work-log.css") {
      return { contentType: "text/css; charset=utf-8", immutable: false };
    }
    return bundle.staticAssets.get(pathname) ?? null;
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

  /**
   * Telegram's runtime is third-party JavaScript, so it is served only where a
   * Telegram Mini App can actually appear: never on the loopback interface, and
   * never at all when the deployment has no Telegram component.
   */
  #telegramRuntimeAllowed(request) {
    return this.#telegramRuntime && this.#requestNeedsTelegramAuth(request);
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
      const authorization = String(request.headers.authorization ?? "");
      const webviewToken = authorization.startsWith("webview ")
        ? authorization.slice(8).trim()
        : "";
      const cookie = cookieValue(request, LOCAL_SESSION_COOKIE);
      let localAccessSecret = this.#localAccessSecret;
      if (
        !validLocalWebviewSession(webviewToken, localAccessSecret)
        && !validLocalSession(cookie, localAccessSecret)
      ) {
        localAccessSecret = await this.#refreshLocalAccessSecret();
      }
      if (validLocalWebviewSession(webviewToken, localAccessSecret)) {
        return { source: "local-vscode-webview" };
      }
      if (validLocalSession(cookie, localAccessSecret)) {
        return { source: "local-mini-app" };
      }
      json(response, 401, { error: "Откройте локальный Agent Hub через защищённый ярлык." });
      return false;
    }
    const authorization = String(request.headers.authorization ?? "");
    // An explicit Authorization header always wins; the HttpOnly cookie keeps the
    // device session out of page JavaScript for clients that stay same-origin.
    const cookieToken = cookieValue(request, DEVICE_SESSION_COOKIE);
    const deviceToken = authorization.startsWith("device ")
      ? authorization.slice(7).trim()
      : (!authorization && DEVICE_SESSION_TOKEN_PATTERN.test(cookieToken) ? cookieToken : "");
    if (deviceToken && this.#deviceStore) {
      try {
        const session = await this.#deviceStore.resolveSession(deviceToken);
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
    const webviewCors = applyVscodeWebviewCors(
      request,
      response,
      !this.#requireTelegramAuth && Boolean(this.#localAccessSecret),
    );
    if (method === "OPTIONS" && webviewCors) {
      response.writeHead(204, {
        "Access-Control-Allow-Headers": [
          "Authorization",
          "Content-Type",
          "If-None-Match",
          "X-Agent-Hub-Attachment-Name",
        ].join(", "),
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }
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
        if (url.pathname.endsWith("/pair")) {
          json(response, 201, await this.#deviceStore.pair(body), method);
          return;
        }
        if (url.pathname.endsWith("/challenge")) {
          // The verifier origin comes from the served request, never from the body.
          const challenge = await this.#deviceStore.createChallenge({
            ...body,
            origin: requestOrigin(request),
          });
          json(response, 200, challenge, method);
          return;
        }
        const session = await this.#deviceStore.createSession(body);
        json(response, 200, session, method, {
          headers: {
            "Set-Cookie": deviceSessionCookie(session.token, session.expiresAt, {
              secure: forwardedProtocol(request) === "https" || !loopbackHost(request.headers.host),
            }),
          },
        });
      } catch (error) {
        this.#reportUnexpected(error, "snapshot");
        json(response, 400, { error: String(error?.message ?? error) }, method);
      }
      return;
    }
    if (url.pathname === "/api/snapshot") {
      if (!["GET", "HEAD"].includes(method)) {
        response.writeHead(405, {
          Allow: "GET, HEAD",
          ...responseHeaders("text/plain; charset=utf-8"),
        });
        response.end("Method Not Allowed\n");
        return;
      }
      const authorization = await this.#authorize(request, response);
      if (!authorization) return;
      if (!this.#controlHandler) {
        json(response, 503, { error: "Снимок Agent Hub недоступен." }, method);
        return;
      }
      try {
        const knownVersion = String(url.searchParams.get("knownVersion") ?? "").slice(0, 128);
        const result = await this.#controlHandler({
          action: "snapshot",
          params: { knownVersion },
          context: authorization,
        });
        json(response, 200, result, method, {
          acceptEncoding: request.headers["accept-encoding"],
        });
      } catch (error) {
        json(response, 400, { error: String(error?.message ?? error) }, method);
      }
      return;
    }
    if (url.pathname === "/api/control/ack") {
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
      if (!this.#onControlResultDelivered) {
        json(response, 503, { error: "Подтверждение результата Agent Hub недоступно." }, method);
        return;
      }
      try {
        const body = await readJsonBody(request);
        const commandId = String(body.commandId ?? "").trim();
        if (!CONTROL_COMMAND_ID_PATTERN.test(commandId)) {
          throw new Error("Некорректный идентификатор команды");
        }
        const retired = await this.#onControlResultDelivered({
          id: commandId,
          context: authorization,
        }) === true;
        json(response, 200, { ok: true, retired }, method);
      } catch (error) {
        this.#reportUnexpected(error, "control-ack");
        json(response, 400, { ok: false, error: String(error?.message ?? error) }, method);
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
        const commandId = String(body.commandId ?? "").trim();
        if (commandId && !CONTROL_COMMAND_ID_PATTERN.test(commandId)) {
          throw new Error("Некорректный идентификатор команды");
        }
        json(response, 200, {
          ok: true,
          result: await this.#controlHandler({
            action,
            params,
            context: { ...authorization, ...(commandId ? { commandId } : {}) },
          }),
          ...(commandId ? { receiptId: commandId } : {}),
        }, method, {
          acceptEncoding: request.headers["accept-encoding"],
        });
      } catch (error) {
        this.#reportUnexpected(error, "control");
        json(response, 400, { ok: false, error: String(error?.message ?? error) }, method);
      }
      return;
    }
    if (url.pathname === "/api/workspace-file") {
      if (!["GET", "HEAD"].includes(method)) {
        response.writeHead(405, {
          Allow: "GET, HEAD",
          ...responseHeaders("text/plain; charset=utf-8"),
        });
        response.end("Method Not Allowed\n");
        return;
      }
      const authorization = await this.#authorize(request, response);
      if (!authorization) return;
      if (authorization.source !== "local-mini-app" || !this.#workspaceFileRoots.length) {
        json(response, 403, { error: "Локальные файлы Workspace доступны только локальному Agent Hub." }, method);
        return;
      }
      try {
        const file = await resolveWorkspaceFile(url.searchParams.get("path"), this.#workspaceFileRoots);
        await sendBoundedFile(response, file.target, file.bytes, file.type, method, {
          "Content-Disposition": downloadDisposition(file.name),
        });
      } catch (error) {
        json(response, 404, { error: String(error?.message ?? error) }, method);
      }
      return;
    }
    if (url.pathname === "/api/workspace-file/copy") {
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
      if (authorization.source !== "local-mini-app"
        || !this.#workspaceFileRoots.length
        || !this.#copyWorkspaceFile) {
        json(response, 403, { error: "Копирование файлов Workspace доступно только локальному Agent Hub." }, method);
        return;
      }
      try {
        const body = await readJsonBody(request);
        const file = await resolveWorkspaceFile(body.path, this.#workspaceFileRoots);
        await this.#copyWorkspaceFile(file.target);
        json(response, 200, { ok: true }, method);
      } catch (error) {
        json(response, 400, { ok: false, error: String(error?.message ?? error) }, method);
      }
      return;
    }
    if (url.pathname === "/api/workspace-file/reveal") {
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
      if (authorization.source !== "local-mini-app"
        || !this.#workspaceFileRoots.length
        || !this.#revealWorkspaceFile) {
        json(response, 403, { error: "Показ файлов доступен только локальному Agent Hub." }, method);
        return;
      }
      try {
        const body = await readJsonBody(request);
        const file = await resolveWorkspaceFile(body.path, this.#workspaceFileRoots);
        await this.#revealWorkspaceFile(file.target);
        json(response, 200, { ok: true }, method);
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
    if (url.pathname === "/api/journal/usage-sync") {
      if (!await this.#authorize(request, response)) return;
      if (method !== "POST") {
        json(response, 405, { error: "Метод не поддерживается" }, method, {
          headers: { Allow: "POST" },
        });
        return;
      }
      try {
        const result = await this.#manualUsageSync();
        const usageSync = await this.#usageSyncStatus();
        const journal = await this.#journal().catch(() => null);
        json(response, 200, {
          ok: true,
          result,
          usageSync: publicJournalPayload({ html: "", updatedAt: "", version: "" }, { usageSync }).usageSync,
          journal: journal
            ? {
                updatedAt: journal.updatedAt,
                version: journal.version,
              }
            : null,
        }, method, { headers: { "Cache-Control": "private, no-store" } });
      } catch (error) {
        json(response, 503, { error: `Синхронизация расхода недоступна: ${error.message}` }, method);
      }
      return;
    }
    if (url.pathname === "/api/journal/usage-sync/invite") {
      if (!await this.#authorize(request, response)) return;
      if (method !== "POST") {
        json(response, 405, { error: "Метод не поддерживается" }, method, {
          headers: { Allow: "POST" },
        });
        return;
      }
      try {
        const result = await this.#createUsageSyncInvite();
        const usageSync = await this.#usageSyncStatus();
        json(response, 200, {
          ok: true,
          result,
          usageSync: publicJournalPayload({ html: "", updatedAt: "", version: "" }, { usageSync }).usageSync,
        }, method, { headers: { "Cache-Control": "private, no-store" } });
      } catch (error) {
        json(response, 503, { error: `Код Sync недоступен: ${error.message}` }, method);
      }
      return;
    }
    if (url.pathname === "/api/journal/usage-sync/enroll") {
      if (!await this.#authorize(request, response)) return;
      if (method !== "POST") {
        json(response, 405, { error: "Метод не поддерживается" }, method, {
          headers: { Allow: "POST" },
        });
        return;
      }
      try {
        const result = await this.#enrollUsageSync(request);
        const usageSync = await this.#usageSyncStatus();
        const journal = await this.#journal().catch(() => null);
        json(response, 200, {
          ok: true,
          result,
          usageSync: publicJournalPayload({ html: "", updatedAt: "", version: "" }, { usageSync }).usageSync,
          journal: journal
            ? {
                updatedAt: journal.updatedAt,
                version: journal.version,
              }
            : null,
        }, method, { headers: { "Cache-Control": "private, no-store" } });
      } catch (error) {
        json(response, 503, { error: `Подключение Sync недоступно: ${error.message}` }, method);
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
      // The probe stays unauthenticated, so it reports liveness and state without
      // the startup error text, which carries local paths and provider messages.
      const { capabilities, startup, ...summary } = this.#health.snapshot();
      json(response, 200, {
        ok: true,
        ...summary,
        capabilities: capabilities.map(({ error: _error, ...capability }) => capability),
        ...(startup ? {
          startup: {
            ...startup,
            operations: startup.operations.map(({ error: _error, ...operation }) => operation),
          },
        } : {}),
      }, method);
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
        const usageSync = await this.#usageSyncStatus();
        const etag = `"${journalPayloadEtag(journal, usageSync)}"`;
        if (String(request.headers["if-none-match"] ?? "") === etag) {
          response.writeHead(304, {
            ...responseHeaders("application/json; charset=utf-8"),
            ETag: etag,
          });
          response.end();
          return;
        }
        json(response, 200, publicJournalPayload(journal, { usageSync }), method, {
          acceptEncoding: request.headers["accept-encoding"],
          headers: { ETag: etag },
        });
      } catch (error) {
        json(response, 503, { error: `Журнал недоступен: ${error.message}` }, method);
      }
      return;
    }
    if (url.pathname === "/api/journal/days") {
      if (!await this.#authorize(request, response)) return;
      try {
        const journal = await this.#journal();
        const requestedVersion = String(url.searchParams.get("version") ?? "");
        if (requestedVersion && requestedVersion !== journal.version) {
          json(response, 409, { error: "Журнал обновился.", version: journal.version }, method);
          return;
        }
        const days = await this.#journalDatabase.fragments("day");
        json(response, 200, { days, version: journal.version }, method, {
          acceptEncoding: request.headers["accept-encoding"],
        });
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
        json(response, 200, { html, version: journal.version }, method, {
          acceptEncoding: request.headers["accept-encoding"],
        });
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
    const assetBundle = await this.#activeAssetBundle();
    const descriptor = this.#staticDescriptor(url.pathname, assetBundle);
    if (!descriptor) {
      send(response, 404, "text/plain; charset=utf-8", "Not Found\n", method);
      return;
    }
    const telegramRuntime = this.#telegramRuntimeAllowed(request);
    try {
      const body = await this.#staticBody(url.pathname, assetBundle);
      send(
        response,
        200,
        descriptor.contentType,
        url.pathname === "/" && !telegramRuntime ? withoutTelegramRuntime(body) : body,
        method,
        { immutable: descriptor.immutable, telegramRuntime },
      );
    } catch (error) {
      send(response, 500, "text/plain; charset=utf-8", `Cannot load Mini App: ${error.message}\n`, method);
    }
  }

  async start() {
    if (this.#closePromise) await this.#closePromise;
    if (this.#server) return this.address();
    const server = createServer((request, response) => {
      const handling = this.#handle(request, response).catch((error) => {
        this.#reportUnexpected(error, "request");
        if (!response.headersSent) {
          send(response, 500, "text/plain; charset=utf-8", `Mini App error: ${error.message}\n`);
        } else {
          response.destroy(error);
        }
      });
      this.#activeHandlers.add(handling);
      void handling.finally(() => this.#activeHandlers.delete(handling));
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
    if (this.#closePromise) return this.#closePromise;
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    this.#closePromise = (async () => {
      if (this.#changeTimer) clearTimeout(this.#changeTimer);
      this.#changeTimer = null;
      if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
      this.#unsubscribeJournal?.();
      this.#unsubscribeJournal = null;
      for (const response of this.#clients) response.end();
      this.#clients.clear();
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
        });
      }
      const activeHandlers = [...this.#activeHandlers];
      if (activeHandlers.length > 0 && this.#handlerCloseTimeoutMs > 0) {
        let handlerCloseTimer;
        await Promise.race([
          Promise.allSettled(activeHandlers),
          new Promise((resolve) => {
            handlerCloseTimer = setTimeout(resolve, this.#handlerCloseTimeoutMs);
          }),
        ]).finally(() => clearTimeout(handlerCloseTimer));
      }
      for (const handling of activeHandlers) this.#activeHandlers.delete(handling);
      if (this.#ownsJournalDatabase) this.#journalDatabase.close();
    })();
    try {
      await this.#closePromise;
    } finally {
      this.#closePromise = null;
    }
  }

  #reportUnexpected(error, action) {
    try {
      this.#reportUnexpectedError?.(error, {
        surface: "web",
        kind: "control",
        component: "mini-app-server",
        action,
      });
    } catch {}
  }
}

function vscodeWebviewCorsOrigin(request, enabled) {
  const origin = String(request.headers.origin ?? "").trim();
  return enabled && VSCODE_WEBVIEW_ORIGIN.test(origin) ? origin : "";
}

function applyVscodeWebviewCors(request, response, enabled) {
  const origin = vscodeWebviewCorsOrigin(request, enabled);
  if (!origin) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Expose-Headers", "Content-Type, ETag");
  response.setHeader("Vary", "Origin");
  return true;
}
