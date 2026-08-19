"use strict";

const { randomUUID } = require("node:crypto");
const { watch } = require("node:fs");
const { mkdir, readFile, stat, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const WEBVIEW_HTTP_CHUNK_CHARS = 192 * 1024;

function attachmentStorageName(value) {
  const cleanName = path.basename(String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ")).trim()
    || "attachment.bin";
  const extension = path.extname(cleanName);
  const safeExtension = /^\.[A-Za-z0-9]{1,16}$/u.test(extension) ? extension.toLowerCase() : "";
  let stem = safeExtension ? cleanName.slice(0, -extension.length) : cleanName;
  let name = `${stem}${safeExtension}`;
  while (stem.length > 1 && Buffer.from(name, "utf8").toString("base64url").length > 180) {
    stem = stem.slice(0, -1);
    name = `${stem}${safeExtension}`;
  }
  const encoded = Buffer.from(name, "utf8").toString("base64url");
  return `${randomUUID().toLowerCase()}--${encoded}${safeExtension}`;
}

function safeAttachmentId(value) {
  const name = String(value ?? "").trim();
  return /^(?:[a-z0-9-]{16,100}--[A-Za-z0-9_-]{1,180}(?:\.[A-Za-z0-9]{1,16})?|[A-Za-z0-9][A-Za-z0-9._-]{0,239})$/u.test(name)
    && !name.includes("..");
}

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

function defaultProcessIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class AgentHubBridge {
  constructor({
    moduleRoot = null,
    runtimeRoot = null,
    journalDatabase = null,
    processIsAlive = defaultProcessIsAlive,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.moduleRoot = moduleRoot ? path.resolve(moduleRoot) : null;
    this.runtimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : defaultRuntimeRoot();
    this.journalCache = null;
    this.desktopModule = null;
    this.journalDatabase = journalDatabase;
    this.ownsJournalDatabase = !journalDatabase;
    this.journalDatabaseModule = null;
    this.resolvedModuleRoot = null;
    this.processIsAlive = processIsAlive;
    this.fetchImpl = fetchImpl;
  }

  async backendRoot() {
    return this.runtimeReleaseRoot();
  }

  /* current.json публикуется до безопасного перезапуска. Пока прежний процесс
     жив, UI и backend должны оставаться на его release из data/bot.lock. */
  async runtimeReleaseRoot() {
    if (this.moduleRoot) return this.moduleRoot;
    const manifest = JSON.parse(await readFile(path.join(this.runtimeRoot, "current.json"), "utf8"));
    const lock = JSON.parse(await readFile(
      path.join(this.runtimeRoot, "data", "bot.lock"),
      "utf8",
    ).catch(() => "{}"));
    const runningRelease = this.processIsAlive(Number(lock.pid))
      ? String(lock.releaseId ?? "").trim()
      : "";
    const release = runningRelease || String(manifest.current ?? "");
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
    const moduleCandidates = [
      path.join(root, "src", "infrastructure", "persistence", "journal-database.mjs"),
      path.join(root, "journal-database.mjs"),
    ];
    let modulePath = null;
    for (const candidate of moduleCandidates) {
      try {
        if ((await stat(candidate)).isFile()) {
          modulePath = candidate;
          break;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!modulePath) {
      throw new Error("Модуль журнала отсутствует в активном runtime Agent Hub");
    }
    this.journalDatabaseModule ??= import(pathToFileURL(
      modulePath,
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
    const clientUserMessageId = action === "send-message"
      ? String(params.clientUserMessageId ?? "").trim()
      : "";
    return callDesktopControl(action, params, {
      timeoutMs: ["rotate-stream", "submit-bug-report"].includes(action) ? 180_000 : 10_000,
      ...(clientUserMessageId ? { commandId: clientUserMessageId } : {}),
    });
  }

  attachmentDirectory() {
    return path.join(this.runtimeRoot, "DesktopApp", "attachments");
  }

  async attachmentPath(id) {
    const name = String(id ?? "").trim();
    if (!safeAttachmentId(name)) {
      throw new Error("Некорректный идентификатор вложения");
    }
    const target = path.join(this.attachmentDirectory(), name);
    const info = await stat(target);
    if (!info.isFile() || info.size < 1 || info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("Вложение отсутствует или повреждено");
    }
    return target;
  }

  async uploadAttachment(params) {
    const match = String(params.dataUrl ?? "").match(/^data:([^;,]+);base64,(.+)$/u);
    if (!match) throw new Error("Файл имеет неподдерживаемый формат");
    const body = Buffer.from(match[2], "base64");
    if (!body.length || body.length > MAX_ATTACHMENT_BYTES) {
      throw new Error("Файл отсутствует или превышает 20 МБ");
    }
    const directory = this.attachmentDirectory();
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, attachmentStorageName(params.name));
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

  subscribeRuntime(listener, { pollMs = 30_000 } = {}) {
    if (this.moduleRoot) return () => {};
    const watchers = [];
    let disposed = false;
    const notify = () => {
      if (disposed) return;
      try {
        Promise.resolve(listener({ type: "runtime" })).catch(() => {});
      } catch {
        // Наблюдатель runtime не должен останавливать Extension Host.
      }
    };
    try {
      /* Наблюдаем каталог, потому что current.json публикуется атомарной
         заменой файла и файловый watcher самого файла после rename устаревает. */
      const watcher = watch(this.runtimeRoot, { persistent: false }, (_event, filename) => {
        if (!filename || String(filename).toLowerCase() === "current.json") notify();
      });
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // Резервная сверка ниже восстановит панель после появления runtime.
    }
    try {
      const watcher = watch(path.join(this.runtimeRoot, "data"), { persistent: false }, (_event, filename) => {
        if (!filename || String(filename).toLowerCase() === "bot.lock") notify();
      });
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // Polling also covers a data directory created after the subscription.
    }
    const timer = setInterval(notify, Math.max(50, Number(pollMs) || 30_000));
    timer.unref?.();
    return () => {
      disposed = true;
      for (const watcher of watchers) watcher.close();
      clearInterval(timer);
    };
  }

  async http({ method = "GET", path: requestPath = "", headers = {} }) {
    if (String(method).toUpperCase() !== "GET") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }
    const url = new URL(requestPath, "https://agent-hub.local");
    if (url.pathname === "/health") {
      try {
        const config = JSON.parse(await readFile(path.join(this.runtimeRoot, "config.json"), "utf8"));
        const host = String(config?.miniApp?.host ?? "127.0.0.1").trim().toLowerCase();
        if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
          throw new Error("miniApp.host должен быть локальным");
        }
        const port = Number(config?.miniApp?.port ?? 8787);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
          throw new Error("miniApp.port некорректен");
        }
        const address = host === "::1" ? `[${host}]` : host;
        const response = await this.fetchImpl(`http://${address}:${port}/health`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        return {
          status: response.status,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
          },
          body: await response.text(),
        };
      } catch (error) {
        return jsonResponse({ error: `Состояние Agent Hub недоступно: ${error.message}` }, 503);
      }
    }
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
