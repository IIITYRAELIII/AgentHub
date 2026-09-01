import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachmentDescriptor,
  attachmentMetadataFromId,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
} from "../../domain/attachment-files.mjs";
import { pathInsideOrSame } from "../../infrastructure/filesystem/config.mjs";

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

  constructor(options = {}) {
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
      if (!info.isFile() || info.size <= 0 || info.size > MAX_ATTACHMENT_BYTES) {
        throw new Error("Файл отсутствует или превышает 20 МБ");
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
