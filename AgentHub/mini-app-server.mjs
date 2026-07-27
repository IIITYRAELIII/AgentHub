import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const CONTENT_TYPES = new Map([
  ["/", "text/html; charset=utf-8"],
  ["/app.js", "text/javascript; charset=utf-8"],
  ["/styles.css", "text/css; charset=utf-8"],
  ["/work-log.css", "text/css; charset=utf-8"],
]);
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
]);
const HEARTBEAT_INTERVAL_MS = 20_000;
const CHANGE_DEBOUNCE_MS = 75;

function escapeHtmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function extractWorkLogHtml(markdown) {
  const source = String(markdown ?? "");
  const firstDay = source.search(/<details\b[^>]*data-work-log-day-section/iu);
  if (firstDay >= 0) return source.slice(firstDay).trim();
  const text = source
    .replace(/^\uFEFF/u, "")
    .replace(/^#\s+.*(?:\r?\n|$)/u, "")
    .trim();
  return text
    ? `<pre data-mini-app-fallback>${escapeHtmlText(text)}</pre>`
    : '<p data-mini-app-empty>Журнал пока пуст.</p>';
}

function responseHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join("; "),
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function send(response, statusCode, contentType, body, method = "GET") {
  response.writeHead(statusCode, responseHeaders(contentType));
  response.end(method === "HEAD" ? "" : body);
}

function json(response, statusCode, value, method = "GET") {
  send(
    response,
    statusCode,
    "application/json; charset=utf-8",
    `${JSON.stringify(value)}\n`,
    method,
  );
}

export class MiniAppServer {
  #assetsDirectory;
  #clients = new Set();
  #changeTimer = null;
  #heartbeatTimer = null;
  #host;
  #port;
  #server = null;
  #watcher = null;
  #workLogCssFile;
  #workLogFile;

  constructor({
    host = "127.0.0.1",
    port = 8787,
    workLogFile,
    assetsDirectory = path.join(import.meta.dirname, "assets", "mini-app"),
    workLogCssFile = path.join(import.meta.dirname, "work-log.css"),
  } = {}) {
    this.#host = String(host);
    this.#port = Number(port);
    this.#workLogFile = path.resolve(workLogFile);
    this.#assetsDirectory = path.resolve(assetsDirectory);
    this.#workLogCssFile = path.resolve(workLogCssFile);
  }

  async #journal() {
    const [markdown, info] = await Promise.all([
      readFile(this.#workLogFile, "utf8"),
      stat(this.#workLogFile),
    ]);
    return {
      html: extractWorkLogHtml(markdown),
      updatedAt: info.mtime.toISOString(),
      version: `${Math.trunc(info.mtimeMs)}-${info.size}`,
    };
  }

  async #staticBody(pathname) {
    if (pathname === "/work-log.css") return readFile(this.#workLogCssFile, "utf8");
    const file = STATIC_FILES.get(pathname);
    if (!file) return null;
    return readFile(path.join(this.#assetsDirectory, file), "utf8");
  }

  #writeEvent(response, event, data) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
    if (!["GET", "HEAD"].includes(method)) {
      response.writeHead(405, {
        Allow: "GET, HEAD",
        ...responseHeaders("text/plain; charset=utf-8"),
      });
      response.end("Method Not Allowed\n");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${this.#host}`);
    if (url.pathname === "/health") {
      json(response, 200, { ok: true }, method);
      return;
    }
    if (url.pathname === "/api/journal") {
      try {
        json(response, 200, await this.#journal(), method);
      } catch (error) {
        json(response, 503, { error: `Журнал недоступен: ${error.message}` }, method);
      }
      return;
    }
    if (url.pathname === "/events") {
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
