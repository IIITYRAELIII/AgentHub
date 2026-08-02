"use strict";

const { randomUUID } = require("node:crypto");
const { mkdir, readFile, stat, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const WEBVIEW_HTTP_CHUNK_CHARS = 192 * 1024;
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

/* VS Code пересылает данные между extension host и webview через IPC. Большой
   журнал нельзя класть в одно сообщение: после разрастания истории такой пакет
   перестаёт доходить до webview. Протокол ниже режет только тело ответа, а
   метаданные передаёт один раз в начале потока. */
function webviewHttpMessages(id, response, maxChunkChars = WEBVIEW_HTTP_CHUNK_CHARS) {
  const body = String(response?.body ?? "");
  const common = {
    id: String(id ?? ""),
    status: Number(response?.status) || 500,
    headers: response?.headers ?? { "Content-Type": "application/json; charset=utf-8" },
  };
  if (body.length <= maxChunkChars) {
    return [{ type: "agenthub:http-result", ...common, body }];
  }
  const chunks = [];
  for (let offset = 0; offset < body.length; offset += maxChunkChars) {
    chunks.push(body.slice(offset, offset + maxChunkChars));
  }
  return [
    { type: "agenthub:http-start", ...common, chunkCount: chunks.length },
    ...chunks.map((chunk, index) => ({
      type: "agenthub:http-chunk",
      id: common.id,
      index,
      body: chunk,
    })),
    { type: "agenthub:http-result", id: common.id, chunked: true },
  ];
}

function defaultRuntimeRoot() {
  const configured = process.env.AGENT_HUB_RUNTIME_ROOT;
  if (configured) return path.resolve(configured);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "AgentHub");
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
    "agent-hub");
}

class AgentHubBridge {
  constructor({ moduleRoot = null, runtimeRoot = null, journalDatabase = null } = {}) {
    this.moduleRoot = moduleRoot ? path.resolve(moduleRoot) : null;
    this.runtimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : defaultRuntimeRoot();
    this.journalCache = null;
    this.desktopModule = null;
    this.journalDatabase = journalDatabase;
    this.ownsJournalDatabase = !journalDatabase;
    this.journalDatabaseModule = null;
    this.resolvedModuleRoot = null;
  }

  async backendRoot() {
    return this.runtimeReleaseRoot();
  }

  /* Runtime переключается атомарной заменой current.json. Мост не должен
     держать старую версию до Reload Window: следующий запрос берёт текущий
     release, а привязанные к прежнему release импорт-кэши сбрасываются. */
  async runtimeReleaseRoot() {
    if (this.moduleRoot) return this.moduleRoot;
    const manifest = JSON.parse(await readFile(path.join(this.runtimeRoot, "current.json"), "utf8"));
    const release = String(manifest.current ?? "");
    if (!/^[A-Za-z0-9._-]+$/u.test(release)) {
      throw new Error("Активный runtime Agent Hub не определён");
    }
    const root = path.join(this.runtimeRoot, "releases", release);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("Активный runtime Agent Hub недоступен");
    if (this.resolvedModuleRoot && this.resolvedModuleRoot !== root) {
      this.desktopModule = null;
      this.journalDatabaseModule = null;
    }
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

  async journalStore() {
    if (this.journalDatabase) return this.journalDatabase;
    const root = await this.backendRoot();
    this.journalDatabaseModule ??= import(pathToFileURL(
      path.join(root, "journal-database.mjs"),
    ).href);
    const { JournalDatabase } = await this.journalDatabaseModule;
    this.journalDatabase ??= new JournalDatabase(
      path.join(this.runtimeRoot, "data", "journal.sqlite"),
    );
    return this.journalDatabase;
  }

  async control(action, params = {}) {
    if (action === "upload-attachment") return this.uploadAttachment(params);
    const { callDesktopControl } = await this.desktop();
    return callDesktopControl(action, params);
  }

  attachmentDirectory() {
    return path.join(this.runtimeRoot, "DesktopApp", "attachments");
  }

  async attachmentPath(id) {
    const name = String(id ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]{1,160}\.(?:png|jpe?g|webp|gif|bmp)$/u.test(name)) {
      throw new Error("Некорректный идентификатор вложения");
    }
    const target = path.join(this.attachmentDirectory(), name);
    const info = await stat(target);
    if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES) {
      throw new Error("Вложение отсутствует или повреждено");
    }
    return target;
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
    const directory = this.attachmentDirectory();
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${randomUUID()}${extension}`);
    await writeFile(target, body, { flag: "wx", mode: 0o600 });
    return target;
  }

  async journal() {
    this.journalCache = await (await this.journalStore()).payload();
    if (!this.journalCache) throw new Error("Журнал ещё не создан");
    return this.journalCache;
  }

  async subscribeJournal(listener) {
    return (await this.journalStore()).subscribe((event) => {
      this.journalCache = null;
      listener(event);
    });
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
        const html = await (await this.journalStore()).fragment(
          url.pathname.endsWith("/day") ? "day" : "turn",
          key,
        );
        return typeof html === "string"
          ? jsonResponse({ html, version: journal.version })
          : jsonResponse({ error: "Фрагмент журнала не найден." }, 404);
      }
      return jsonResponse({ error: "Not Found" }, 404);
    } catch (error) {
      return jsonResponse({ error: `Журнал недоступен: ${error.message}` }, 503);
    }
  }

  close() {
    if (this.ownsJournalDatabase) this.journalDatabase?.close();
    this.journalDatabase = null;
  }
}

module.exports = { AgentHubBridge, defaultRuntimeRoot, webviewHttpMessages };
