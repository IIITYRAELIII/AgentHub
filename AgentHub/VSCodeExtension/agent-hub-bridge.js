"use strict";

const { randomUUID } = require("node:crypto");
const { mkdir, readFile, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
]);

function jsonResponse(value, status = 200, headers = {}) {
  return {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
    body: `${JSON.stringify(value)}\n`,
  };
}

class AgentHubBridge {
  constructor({ journalFile }) {
    this.journalFile = journalFile;
    this.journalCache = null;
    this.desktopModule = null;
    this.journalModule = null;
    this.runtimeModule = null;
  }

  async desktop() {
    this.desktopModule ??= import(pathToFileURL(
      path.join(__dirname, "..", "desktop-control.mjs"),
    ).href);
    return this.desktopModule;
  }

  async journalTools() {
    this.journalModule ??= import(pathToFileURL(
      path.join(__dirname, "..", "mini-app-journal-data.mjs"),
    ).href);
    return this.journalModule;
  }

  async runtimeTools() {
    this.runtimeModule ??= import(pathToFileURL(
      path.join(__dirname, "..", "runtime-layout.mjs"),
    ).href);
    return this.runtimeModule;
  }

  async control(action, params = {}) {
    if (action === "upload-attachment") return this.uploadAttachment(params);
    const { callDesktopControl } = await this.desktop();
    return callDesktopControl(action, params);
  }

  async uploadAttachment(params) {
    const match = String(params.dataUrl ?? "").match(/^data:([^;,]+);base64,(.+)$/u);
    if (!match) throw new Error("Изображение имеет неподдерживаемый формат");
    const extension = IMAGE_EXTENSIONS.get(match[1].toLowerCase());
    if (!extension) throw new Error("Неподдерживаемый формат изображения");
    const body = Buffer.from(match[2], "base64");
    if (!body.length || body.length > MAX_IMAGE_BYTES) {
      throw new Error("Изображение отсутствует или превышает 20 МБ");
    }
    const { defaultRuntimeRoot } = await this.runtimeTools();
    const runtimeRoot = process.env.AGENT_HUB_RUNTIME_ROOT
      ?? process.env.TELEGRAM_INTEGRATION_RUNTIME_ROOT
      ?? defaultRuntimeRoot();
    const directory = path.join(runtimeRoot, "DesktopApp", "attachments");
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${randomUUID()}${extension}`);
    await writeFile(target, body, { flag: "wx", mode: 0o600 });
    return target;
  }

  async journal() {
    const info = await stat(this.journalFile);
    const version = `${Math.trunc(info.mtimeMs)}-${info.size}`;
    if (this.journalCache?.version === version) return this.journalCache;
    const [{ buildLazyJournalPayload }, markdown] = await Promise.all([
      this.journalTools(),
      readFile(this.journalFile, "utf8"),
    ]);
    this.journalCache = {
      ...buildLazyJournalPayload(markdown),
      version,
      updatedAt: info.mtime.toISOString(),
    };
    return this.journalCache;
  }

  async http({ method = "GET", path: requestPath = "", headers = {} }) {
    if (String(method).toUpperCase() !== "GET") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }
    const url = new URL(requestPath, "https://agent-hub.local");
    try {
      const journal = await this.journal();
      if (url.pathname === "/api/journal") {
        const etag = `"${journal.version}"`;
        if (String(headers["if-none-match"] ?? "") === etag) {
          return { status: 304, headers: { ETag: etag }, body: "" };
        }
        return jsonResponse({
          html: journal.html,
          updatedAt: journal.updatedAt,
          version: journal.version,
        }, 200, { ETag: etag });
      }
      if (url.pathname === "/api/journal/day" || url.pathname === "/api/journal/turn") {
        const requestedVersion = String(url.searchParams.get("version") ?? "");
        if (requestedVersion && requestedVersion !== journal.version) {
          return jsonResponse({ error: "Журнал обновился.", version: journal.version }, 409);
        }
        const key = url.pathname.endsWith("/day")
          ? String(url.searchParams.get("date") ?? "")
          : String(url.searchParams.get("id") ?? "");
        const html = url.pathname.endsWith("/day")
          ? journal.days[key]
          : journal.turns[key];
        return typeof html === "string"
          ? jsonResponse({ html, version: journal.version })
          : jsonResponse({ error: "Фрагмент журнала не найден." }, 404);
      }
      return jsonResponse({ error: "Not Found" }, 404);
    } catch (error) {
      return jsonResponse({ error: `Журнал недоступен: ${error.message}` }, 503);
    }
  }
}

module.exports = { AgentHubBridge };
