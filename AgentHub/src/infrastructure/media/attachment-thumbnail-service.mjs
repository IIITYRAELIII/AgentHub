import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  attachmentMetadataFromId,
  createAttachmentStorageName,
  MAX_ATTACHMENT_BYTES,
} from "../../domain/attachment-files.mjs";
import { pathInsideOrSame } from "../filesystem/config.mjs";

const execFileAsync = promisify(execFile);
const THUMBNAIL_FORMAT_VERSION = 1;
const DEFAULT_MAX_EDGE = 480;

async function generateWithPillow({ pythonExe, script, source, target, maxEdge }) {
  const candidates = [...new Set([
    String(pythonExe ?? "").trim(),
    String(process.env.PYTHON ?? "").trim(),
    process.platform === "win32" ? "python" : "python3",
    "python",
  ].filter(Boolean))];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, [script, source, target, String(maxEdge)], {
        encoding: "utf8",
        env: { ...process.env, PYTHONUTF8: "1" },
        maxBuffer: 64 * 1024,
        timeout: 30_000,
        windowsHide: true,
      });
      return;
    } catch (error) {
      lastError = error;
      const details = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
      if (error?.code !== "ENOENT" && !/No module named ['"]PIL['"]/u.test(details)) throw error;
    }
  }
  throw lastError ?? new Error("Python с Pillow не найден");
}

function previewName(name) {
  const parsed = path.parse(String(name ?? ""));
  return `${parsed.name || "image"}-preview.webp`;
}

export class AttachmentThumbnailService {
  #attachmentRoot;
  #cacheRoot;
  #generateThumbnail;
  #inflight = new Map();
  #maxEdge;
  #queue = Promise.resolve();

  constructor({
    attachmentRoot,
    pythonExe = "",
    script = path.resolve(import.meta.dirname, "../../..", "attachment_thumbnail.py"),
    maxEdge = DEFAULT_MAX_EDGE,
    generateThumbnail = null,
  } = {}) {
    this.#attachmentRoot = path.resolve(String(attachmentRoot ?? ""));
    this.#cacheRoot = path.join(this.#attachmentRoot, ".thumbnails");
    this.#maxEdge = Math.max(64, Math.min(1_024, Math.trunc(Number(maxEdge) || DEFAULT_MAX_EDGE)));
    this.#generateThumbnail = typeof generateThumbnail === "function"
      ? generateThumbnail
      : ({ source, target }) => generateWithPillow({
        pythonExe: String(pythonExe ?? "").trim(),
        script: path.resolve(script),
        source,
        target,
        maxEdge: this.#maxEdge,
      });
  }

  async create(file) {
    const source = path.resolve(String(file ?? ""));
    if (!pathInsideOrSame(source, this.#attachmentRoot) || pathInsideOrSame(source, this.#cacheRoot)) {
      throw new Error("Источник миниатюры находится вне каталога вложений");
    }
    const sourceMetadata = attachmentMetadataFromId(path.basename(source));
    if (!sourceMetadata?.isImage) throw new Error("Миниатюра доступна только для изображения");
    const sourceInfo = await stat(source);
    if (!sourceInfo.isFile() || sourceInfo.size < 1 || sourceInfo.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("Изображение отсутствует, повреждено или слишком велико");
    }
    const key = createHash("sha256")
      .update([
        THUMBNAIL_FORMAT_VERSION,
        path.basename(source),
        sourceInfo.size,
        sourceInfo.mtimeMs.toFixed(3),
        this.#maxEdge,
      ].join("\0"))
      .digest("hex")
      .slice(0, 32);
    const id = createAttachmentStorageName(previewName(sourceMetadata.name), key);
    const target = path.join(this.#cacheRoot, id);
    const cached = await this.#cachedResult(target, id, key);
    if (cached) return cached;
    if (this.#inflight.has(target)) return this.#inflight.get(target);
    const operation = this.#queue.then(() => this.#generate(source, target, id, key));
    this.#queue = operation.catch(() => {});
    this.#inflight.set(target, operation);
    try {
      return await operation;
    } finally {
      this.#inflight.delete(target);
    }
  }

  async #cachedResult(file, id, key) {
    try {
      return await this.#result(file, id, key);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #generate(source, target, id, key) {
    const cached = await this.#cachedResult(target, id, key);
    if (cached) return cached;
    await mkdir(this.#cacheRoot, { recursive: true });
    const temporary = path.join(this.#cacheRoot, `.${randomUUID()}.tmp`);
    try {
      await this.#generateThumbnail({ source, target: temporary, maxEdge: this.#maxEdge });
      const generated = await stat(temporary);
      if (!generated.isFile() || generated.size < 1 || generated.size > MAX_ATTACHMENT_BYTES) {
        throw new Error("Генератор вернул некорректную миниатюру");
      }
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    return this.#result(target, id, key);
  }

  async #result(file, id, key) {
    const info = await stat(file);
    if (!info.isFile() || info.size < 1 || info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("Кеш миниатюры повреждён");
    }
    return {
      ...attachmentMetadataFromId(id),
      etag: `"thumbnail-${key}"`,
      file,
      size: info.size,
    };
  }
}
