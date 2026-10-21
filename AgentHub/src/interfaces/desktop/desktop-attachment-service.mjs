import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachmentDescriptor,
  attachmentMetadataFromId,
  MAX_MESSAGE_ATTACHMENTS,
} from "../../domain/attachment-files.mjs";
import { pathInsideOrSame } from "../../infrastructure/filesystem/config.mjs";
import { attachmentUploadLimits } from "../../domain/attachment-upload-policy.mjs";
import { acquireAttachmentUploadService } from "../../infrastructure/filesystem/attachment-upload-service.mjs";

export class DesktopAttachmentService {
  #attachmentRoot;
  #projectRoot;
  #projectRoots;
  #workerEnabled;
  #publisher;
  #trustedUserId;
  #assistantAttachmentImporterFactory;
  #attachmentThumbnails;
  #generatedImageRoot;
  #importer = null;
  #maxAttachmentBytes;
  #uploadLimits;
  #uploadLease = null;

  constructor(options = {}) {
    this.#uploadLimits = options.attachmentUploadPolicy ?? attachmentUploadLimits();
    this.#maxAttachmentBytes = this.#uploadLimits.maxBytes;
    this.#attachmentRoot = path.join(path.resolve(options.runtimeCommandRoot), "attachments");
    this.#projectRoot = path.resolve(options.projectRoot);
    this.#projectRoots = (options.projectRoots ?? []).map((value) => path.resolve(value));
    this.#workerEnabled = Boolean(options.workerEnabled);
    this.#publisher = typeof options.publisher === "function" ? options.publisher : () => null;
    this.#trustedUserId = typeof options.trustedUserId === "function" ? options.trustedUserId : () => "local";
    this.#assistantAttachmentImporterFactory = options.assistantAttachmentImporterFactory;
    this.#attachmentThumbnails = options.attachmentThumbnails ?? null;
    const codexHome = String(options.codexHome ?? "").trim() || path.join(os.homedir(), ".codex");
    this.#generatedImageRoot = path.join(path.resolve(codexHome), "generated_images");
  }

  async upload(params = {}, context = {}) {
    const response = (status, value) => ({ status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify(value),
    });
    if (context.source !== "desktop-control") return response(403, { error: "Local desktop transport required" });
    try {
      const url = new URL(String(params.path ?? ""), "https://agent-hub.local");
      if (url.origin !== "https://agent-hub.local" || url.pathname !== "/api/attachment-upload") {
        return response(404, { error: "Unknown attachment upload route" });
      }
      const method = String(params.method ?? "GET").toUpperCase();
      const id = url.searchParams.get("id");
      let chunk;
      if (method === "PUT") {
        const encoded = params.body;
        if (params.bodyEncoding !== "base64" || typeof encoded !== "string"
          || encoded.length > 4 * Math.ceil(this.#uploadLimits.chunkBytes / 3)) {
          return response(413, { error: "Attachment chunk exceeds transport limit" });
        }
        if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
          return response(400, { error: "Invalid attachment chunk encoding" });
        }
        chunk = Buffer.from(encoded, "base64");
        if (chunk.length > this.#uploadLimits.chunkBytes) return response(413, { error: "Attachment chunk exceeds transport limit" });
      }
      this.#uploadLease ??= acquireAttachmentUploadService({
        attachmentDirectory: this.#attachmentRoot, limits: this.#uploadLimits,
      }).catch((error) => { this.#uploadLease = null; throw error; });
      const { service } = await this.#uploadLease;
      // The authenticated HTTP WebView uses this same local owner and service.
      const owner = "local";
      let result;
      if (method === "GET") result = id ? await service.status(owner, id) : service.capabilities();
      else if (method === "POST" && id && url.searchParams.get("complete") === "1") result = await service.complete(owner, id);
      else if (method === "POST" && !id) {
        if (typeof params.body !== "string" || params.body.length > 16_384) return response(413, { error: "Upload metadata exceeds transport limit" });
        result = await service.begin(owner, JSON.parse(params.body));
      } else if (method === "PUT" && id) {
        const index = url.searchParams.get("index");
        if (!/^\d+$/u.test(index ?? "")) return response(400, { error: "Invalid attachment chunk index" });
        const headers = new Headers(params.headers);
        result = await service.putChunk(owner, id, Number(index), chunk, headers.get("X-Agent-Hub-Chunk-Sha256") ?? "");
      } else if (method === "DELETE" && id) result = await service.cancel(owner, id);
      else return response(405, { error: "Unsupported upload operation" });
      return response(200, { ok: true, ...result });
    } catch (error) {
      return response(error.statusCode ?? 400, { ok: false, error: String(error.message ?? error),
        ...(error.state ? { state: error.state } : error.statusCode === 404 ? { state: "absent" } : {}) });
    }
  }

  async close() {
    const lease = this.#uploadLease;
    this.#uploadLease = null;
    if (lease) await (await lease).release();
  }

  async paths(values) {
    if (values == null) return [];
    if (!Array.isArray(values) || values.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new Error("Можно приложить не более восьми файлов");
    }
    const result = [];
    for (const value of values) {
      const file = path.resolve(String(value ?? ""));
      if (!pathInsideOrSame(file, this.#attachmentRoot)) {
        throw new Error("Файл находится вне каталога вложений Agent Hub");
      }
      if (!attachmentMetadataFromId(path.basename(file))) throw new Error("Некорректный идентификатор вложения");
      let info;
      try {
        info = await stat(file);
      } catch (error) {
        if (error?.code === "ENOENT") throw new Error("Файл вложения недоступен");
        throw error;
      }
      if (!info.isFile() || info.size <= 0 || info.size > this.#maxAttachmentBytes) {
        throw new Error("Файл отсутствует или превышает лимит вложения");
      }
      result.push(file);
    }
    return result;
  }

  isLegacyFile(value) {
    const file = path.resolve(String(value ?? ""));
    return pathInsideOrSame(file, this.#attachmentRoot)
      && Boolean(attachmentMetadataFromId(path.basename(file)));
  }

  descriptors(files) {
    return (Array.isArray(files) ? files : []).map(attachmentDescriptor).filter(Boolean);
  }

  async importCodex(values) {
    if (typeof this.#assistantAttachmentImporterFactory !== "function") {
      throw new Error("Импорт вложений Codex не настроен");
    }
    this.#importer ??= this.#assistantAttachmentImporterFactory({
      temporaryRoot: os.tmpdir(),
      generatedImageRoot: this.#generatedImageRoot,
      attachmentRoot: this.#attachmentRoot,
      viewImageRoots: [os.homedir(), path.dirname(path.dirname(this.#attachmentRoot)), this.#projectRoot, ...this.#projectRoots],
    });
    return this.#importer(values);
  }

  async pathById(value) {
    const id = String(value ?? "").trim();
    if (!attachmentMetadataFromId(id)) throw new Error("Некорректный идентификатор вложения");
    const [resolved] = await this.paths([path.join(this.#attachmentRoot, id)]);
    return resolved;
  }

  async open(params, context) {
    const id = String(params?.id ?? "").trim();
    const target = await this.pathById(id);
    const metadata = attachmentMetadataFromId(id);
    const preview = params?.preview === true;
    if (preview && !metadata.isImage) throw new Error("Миниатюра доступна только для изображения");
    if (context?.source === "telegram-mini-app" && this.#workerEnabled) {
      const publisher = this.#publisher();
      if (!publisher) throw new Error("Вложения доступны только при включённом Mini App Worker");
      if (preview && !this.#attachmentThumbnails) throw new Error("Генератор миниатюр не настроен");
      const publishedTarget = preview
        ? (await this.#attachmentThumbnails.create(target)).file
        : target;
      return publisher.publishAttachmentView(this.#trustedUserId(context), publishedTarget);
    }
    return {
      ...metadata,
      url: `/api/message-attachment/${encodeURIComponent(id)}${preview ? "?preview=1" : ""}`,
    };
  }
}
