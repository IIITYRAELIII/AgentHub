"use strict";

const { randomUUID } = require("node:crypto");
const { mkdir, readFile, stat, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
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

function defaultRuntimeRoot() {
  const configured = process.env.AGENT_HUB_RUNTIME_ROOT
    ?? process.env.TELEGRAM_INTEGRATION_RUNTIME_ROOT;
  if (configured) return path.resolve(configured);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "Tyrael", "TelegramIntegration");
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
    "tyrael", "telegram-integration");
}

class AgentHubBridge {
  constructor({ journalFile, moduleRoot = null, runtimeRoot = null }) {
    this.journalFile = journalFile;
    this.moduleRoot = moduleRoot ? path.resolve(moduleRoot) : null;
    this.runtimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : defaultRuntimeRoot();
    this.journalCache = null;
    this.desktopModule = null;
    this.journalModule = null;
    this.resolvedModuleRoot = null;
  }

  async backendRoot() {
    if (this.moduleRoot) return this.moduleRoot;
    if (this.resolvedModuleRoot) return this.resolvedModuleRoot;
    const manifest = JSON.parse(await readFile(path.join(this.runtimeRoot, "current.json"), "utf8"));
    const release = String(manifest.current ?? "");
    if (!/^[A-Za-z0-9._-]+$/u.test(release)) {
      throw new Error("Активный runtime Agent Hub не определён");
    }
    const root = path.join(this.runtimeRoot, "releases", release);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("Активный runtime Agent Hub недоступен");
    this.resolvedModuleRoot = root;
    return root;
  }

  async desktop() {
    const root = await this.backendRoot();
    this.desktopModule ??= import(pathToFileURL(
      path.join(root, "desktop-control.mjs"),
    ).href);
    return this.desktopModule;
  }

  async journalTools() {
    const root = await this.backendRoot();
    this.journalModule ??= import(pathToFileURL(
      path.join(root, "mini-app-journal-data.mjs"),
    ).href);
    return this.journalModule;
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
    const directory = path.join(this.runtimeRoot, "DesktopApp", "attachments");
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
      /* Сводка лимитов нужна шапке во всех разделах, а журнал панель отдаёт
         целиком, поэтому блок вырезается из готового снимка. */
      if (url.pathname === "/api/rate-limits") {
        const block = String(journal.html ?? "").match(
          /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
        )?.[0] ?? "";
        return jsonResponse({
          html: block,
          sampledAt: block.match(/data-sampled-at="([^"]*)"/iu)?.[1] ?? "",
        });
      }
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
