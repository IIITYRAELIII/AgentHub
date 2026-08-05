import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathInsideOrSame } from "../../../config.mjs";

const ATTACHMENT_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
]);
const ATTACHMENT_PATTERN = /\.(?:png|jpe?g|webp|gif|bmp)$/i;

export class DesktopAttachmentService {
  #attachmentRoot;
  #projectRoot;
  #projectRoots;
  #workerEnabled;
  #publisher;
  #trustedUserId;
  #assistantAttachmentImporterFactory;
  #importer = null;

  constructor(options = {}) {
    this.#attachmentRoot = path.join(path.resolve(options.runtimeCommandRoot), "DesktopApp", "attachments");
    this.#projectRoot = path.resolve(options.projectRoot);
    this.#projectRoots = (options.projectRoots ?? []).map((value) => path.resolve(value));
    this.#workerEnabled = Boolean(options.workerEnabled);
    this.#publisher = typeof options.publisher === "function" ? options.publisher : () => null;
    this.#trustedUserId = typeof options.trustedUserId === "function" ? options.trustedUserId : () => "local";
    this.#assistantAttachmentImporterFactory = options.assistantAttachmentImporterFactory;
  }

  async paths(values) {
    if (values == null) return [];
    if (!Array.isArray(values) || values.length > 8) {
      throw new Error("Можно приложить не более восьми изображений");
    }
    const result = [];
    for (const value of values) {
      const file = path.resolve(String(value ?? ""));
      if (!pathInsideOrSame(file, this.#attachmentRoot)) {
        throw new Error("Изображение находится вне каталога Desktop-приложения");
      }
      if (!ATTACHMENT_PATTERN.test(file)) throw new Error("Неподдерживаемый формат изображения");
      const info = await stat(file);
      if (!info.isFile() || info.size <= 0 || info.size > 20 * 1024 * 1024) {
        throw new Error("Изображение отсутствует или превышает 20 МБ");
      }
      result.push(file);
    }
    return result;
  }

  isLegacyFile(value) {
    const file = path.resolve(String(value ?? ""));
    return pathInsideOrSame(file, this.#attachmentRoot) && ATTACHMENT_PATTERN.test(file);
  }

  descriptors(files) {
    return (Array.isArray(files) ? files : []).map((file) => {
      const name = path.basename(path.resolve(String(file ?? "")));
      return {
        id: name,
        name,
        type: ATTACHMENT_TYPES.get(path.extname(name).toLowerCase()) ?? "application/octet-stream",
      };
    });
  }

  async importCodex(values) {
    if (typeof this.#assistantAttachmentImporterFactory !== "function") {
      throw new Error("Импорт вложений Codex не настроен");
    }
    this.#importer ??= this.#assistantAttachmentImporterFactory({
      temporaryRoot: os.tmpdir(),
      generatedImageRoot: path.resolve(os.homedir(), ".codex", "generated_images"),
      attachmentRoot: this.#attachmentRoot,
      viewImageRoots: [os.homedir(), path.dirname(path.dirname(this.#attachmentRoot)), this.#projectRoot, ...this.#projectRoots],
    });
    return this.#importer(values);
  }

  async pathById(value) {
    const id = String(value ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]{1,160}\.(?:png|jpe?g|webp|gif|bmp)$/u.test(id)) {
      throw new Error("Некорректный идентификатор вложения");
    }
    const [resolved] = await this.paths([path.join(this.#attachmentRoot, id)]);
    return resolved;
  }

  async open(params, context) {
    const id = String(params?.id ?? "").trim().toLowerCase();
    const target = await this.pathById(id);
    if (context?.source === "telegram-mini-app" && this.#workerEnabled) {
      const publisher = this.#publisher();
      if (!publisher) throw new Error("Вложения доступны только при включённом Mini App Worker");
      return publisher.publishAttachmentView(this.#trustedUserId(context), target);
    }
    return {
      id,
      name: path.basename(target),
      type: ATTACHMENT_TYPES.get(path.extname(target).toLowerCase()) ?? "application/octet-stream",
      url: `/api/message-attachment/${encodeURIComponent(id)}`,
    };
  }
}
