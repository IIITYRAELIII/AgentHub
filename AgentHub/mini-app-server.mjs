import { watch } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";

import {
  buildLazyJournalPayload,
  extractRateLimitsHtml,
  publicJournalPayload,
} from "./mini-app-journal-data.mjs";

export { extractWorkLogHtml } from "./mini-app-journal-data.mjs";

const CONTENT_TYPES = new Map([
  ["/", "text/html; charset=utf-8"],
  ["/app.js", "text/javascript; charset=utf-8"],
  ["/hub-client.js", "text/javascript; charset=utf-8"],
  ["/styles.css", "text/css; charset=utf-8"],
  ["/work-log.css", "text/css; charset=utf-8"],
  ["/blackhole-blue.png", "image/png"],
  ["/pulsar-beams.png", "image/png"],
  ["/gothic-concrete.png", "image/png"],
  ["/nebula-veil.png", "image/png"],
  ["/orbit-earth.png", "image/png"],
  ["/magma-crust.png", "image/png"],
  ["/rainforest-night.png", "image/png"],
  ["/meadow-sun.png", "image/png"],
  ["/storm-rain.png", "image/png"],
]);
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/app.js", "app.js"],
  ["/hub-client.js", "hub-client.js"],
  ["/styles.css", "styles.css"],
  ["/blackhole-blue.png", "blackhole-blue.png"],
  ["/pulsar-beams.png", "pulsar-beams.png"],
  ["/gothic-concrete.png", "gothic-concrete.png"],
  ["/nebula-veil.png", "nebula-veil.png"],
  ["/orbit-earth.png", "orbit-earth.png"],
  ["/magma-crust.png", "magma-crust.png"],
  ["/rainforest-night.png", "rainforest-night.png"],
  ["/meadow-sun.png", "meadow-sun.png"],
  ["/storm-rain.png", "storm-rain.png"],
]);
/* Разметка и стили обязаны быть свежими, поэтому у них no-store. Фон темы —
   неизменяемый файл в несколько мегабайт: без долгого кэша он выкачивался бы
   заново при каждом открытии, что заметно через Telegram-туннель. */
const IMMUTABLE_FILES = new Set([
  "/blackhole-blue.png",
  "/gothic-concrete.png",
  "/nebula-veil.png",
  "/orbit-earth.png",
  "/magma-crust.png",
  "/meadow-sun.png",
  "/pulsar-beams.png",
  "/rainforest-night.png",
  "/storm-rain.png",
]);
const MAX_CONTROL_REQUEST_BYTES = 512 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
]);

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
    if (size > maxBytes) throw new Error("Изображение превышает 20 МБ");
    chunks.push(chunk);
  }
  if (!size) throw new Error("Пустое изображение");
  return Buffer.concat(chunks);
}
const HEARTBEAT_INTERVAL_MS = 20_000;
const CHANGE_DEBOUNCE_MS = 75;
const TELEGRAM_AUTH_MAX_AGE_SECONDS = 86_400;

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

export class MiniAppServer {
  #allowedUserIds;
  #assetsDirectory;
  #attachmentDirectory;
  #botToken;
  #clients = new Set();
  #controlHandler;
  #changeTimer = null;
  #heartbeatTimer = null;
  #host;
  #journalCache = null;
  #port;
  #requireTelegramAuth;
  #server = null;
  #watcher = null;
  #workLogCssFile;
  #workLogFile;

  constructor({
    host = "127.0.0.1",
    port = 8787,
    workLogFile,
    botToken = "",
    allowedUserIds = new Set(),
    requireTelegramAuth = false,
    controlHandler = null,
    assetsDirectory = path.join(import.meta.dirname, "assets", "mini-app"),
    attachmentDirectory = null,
    workLogCssFile = path.join(import.meta.dirname, "work-log.css"),
  } = {}) {
    this.#host = String(host);
    this.#port = Number(port);
    this.#workLogFile = path.resolve(workLogFile);
    this.#botToken = String(botToken);
    this.#allowedUserIds = new Set(allowedUserIds);
    this.#requireTelegramAuth = requireTelegramAuth === true;
    this.#controlHandler = typeof controlHandler === "function" ? controlHandler : null;
    this.#assetsDirectory = path.resolve(assetsDirectory);
    this.#attachmentDirectory = attachmentDirectory ? path.resolve(attachmentDirectory) : null;
    this.#workLogCssFile = path.resolve(workLogCssFile);
  }

  async #journal() {
    const info = await stat(this.#workLogFile);
    const version = `${Math.trunc(info.mtimeMs)}-${info.size}`;
    if (this.#journalCache?.version === version) return this.#journalCache;
    const markdown = await readFile(this.#workLogFile, "utf8");
    this.#journalCache = {
      ...buildLazyJournalPayload(markdown),
      updatedAt: info.mtime.toISOString(),
      version,
    };
    return this.#journalCache;
  }

  async #staticBody(pathname) {
    if (pathname === "/work-log.css") return readFile(this.#workLogCssFile, "utf8");
    const file = STATIC_FILES.get(pathname);
    if (!file) return null;
    const target = path.join(this.#assetsDirectory, file);
    // изображение читается буфером: utf8-декодирование испортило бы PNG
    return IMMUTABLE_FILES.has(pathname) ? readFile(target) : readFile(target, "utf8");
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

  #authorize(request, response) {
    if (!this.#requestNeedsTelegramAuth(request)) return true;
    const authorization = String(request.headers.authorization ?? "");
    if (!authorization.startsWith("tma ")) {
      json(response, 401, { error: "Откройте журнал из Telegram." });
      return false;
    }
    try {
      validateTelegramInitData(authorization.slice(4), {
        botToken: this.#botToken,
        allowedUserIds: this.#allowedUserIds,
      });
      return true;
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

  async #handle(request, response) {
    const method = String(request.method ?? "GET").toUpperCase();
    const url = new URL(request.url ?? "/", `http://${this.#host}`);
    if (url.pathname === "/api/control") {
      if (method !== "POST") {
        response.writeHead(405, {
          Allow: "POST",
          ...responseHeaders("text/plain; charset=utf-8"),
        });
        response.end("Method Not Allowed\n");
        return;
      }
      if (!this.#authorize(request, response)) return;
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
          result: await this.#controlHandler({ action, params }),
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
      if (!this.#authorize(request, response)) return;
      if (!this.#attachmentDirectory) {
        json(response, 503, { error: "Загрузка изображений недоступна." }, method);
        return;
      }
      try {
        const contentType = String(request.headers["content-type"] ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        const extension = IMAGE_CONTENT_TYPES.get(contentType);
        if (!extension) throw new Error("Неподдерживаемый формат изображения");
        const body = await readBinaryBody(request);
        await mkdir(this.#attachmentDirectory, { recursive: true });
        const target = path.join(this.#attachmentDirectory, `${randomUUID()}${extension}`);
        await writeFile(target, body, { flag: "wx", mode: 0o600 });
        json(response, 201, { ok: true, path: target }, method);
      } catch (error) {
        json(response, 400, { ok: false, error: String(error?.message ?? error) }, method);
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
    if (url.pathname === "/api/rate-limits") {
      if (!this.#authorize(request, response)) return;
      try {
        const markdown = await readFile(this.#workLogFile, "utf8");
        json(response, 200, extractRateLimitsHtml(markdown), method);
      } catch (error) {
        json(response, 503, { error: `Лимиты недоступны: ${error.message}` }, method);
      }
      return;
    }
    if (url.pathname === "/api/journal") {
      if (!this.#authorize(request, response)) return;
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
      if (!this.#authorize(request, response)) return;
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
        const html = url.pathname.endsWith("/day")
          ? journal.days[key]
          : journal.turns[key];
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
      if (!this.#authorize(request, response)) return;
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
    if (!CONTENT_TYPES.has(url.pathname)) {
      send(response, 404, "text/plain; charset=utf-8", "Not Found\n", method);
      return;
    }
    try {
      send(
        response,
        200,
        CONTENT_TYPES.get(url.pathname),
        await this.#staticBody(url.pathname),
        method,
        { immutable: IMMUTABLE_FILES.has(url.pathname) },
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
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, this.#host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
    this.#watcher = watch(
      path.dirname(this.#workLogFile),
      { persistent: false },
      (_eventType, fileName) => {
        if (!fileName || String(fileName) === path.basename(this.#workLogFile)) this.#scheduleChange();
      },
    );
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
    this.#watcher?.close();
    this.#watcher = null;
    for (const response of this.#clients) response.end();
    this.#clients.clear();
    if (!server?.listening) return;
    await new Promise((resolve) => server.close(resolve));
  }
}
