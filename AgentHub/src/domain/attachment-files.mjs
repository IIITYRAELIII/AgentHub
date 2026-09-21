import { randomUUID } from "node:crypto";
import path from "node:path";

export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
]);

const DOCUMENT_TYPES = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".xml", "application/xml"],
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
  [".7z", "application/x-7z-compressed"],
  [".rar", "application/vnd.rar"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);

const ENCODED_ID = /^([a-z0-9-]{16,100})--([A-Za-z0-9_-]{1,180})(\.[A-Za-z0-9]{1,16})?$/u;
const LEGACY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const WINDOWS_RESERVED_FILE = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function cleanDisplayName(value) {
  const base = path.basename(String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ")).trim();
  return base && base !== "." && base !== ".." ? base : "Вложение";
}

function encodedDisplayName(value, maxChars = 180, preservedSuffix = "") {
  const clean = cleanDisplayName(value);
  const suffix = clean.endsWith(preservedSuffix) ? preservedSuffix : "";
  let stem = suffix ? clean.slice(0, -suffix.length) : clean;
  let name = `${stem}${suffix}`;
  while (stem.length > 1 && Buffer.from(name, "utf8").toString("base64url").length > maxChars) {
    stem = stem.slice(0, -1);
    name = `${stem}${suffix}`;
  }
  return { name, encoded: Buffer.from(name, "utf8").toString("base64url") };
}

export function attachmentContentType(name, fallback = "") {
  const extension = path.extname(cleanDisplayName(name)).toLowerCase();
  if (IMAGE_TYPES.has(extension)) return IMAGE_TYPES.get(extension);
  if (DOCUMENT_TYPES.has(extension)) return DOCUMENT_TYPES.get(extension);
  const candidate = String(fallback ?? "").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(candidate)
    ? candidate
    : "application/octet-stream";
}

export function attachmentIsImage(value) {
  const type = typeof value === "string" ? value : value?.type;
  return String(type ?? "").toLowerCase().startsWith("image/");
}

export function imageMatchesContentType(body, contentType) {
  const value = new Uint8Array(body);
  if (contentType === "image/png") {
    return value.length >= 8
      && [137, 80, 78, 71, 13, 10, 26, 10].every((item, index) => value[index] === item);
  }
  if (contentType === "image/jpeg") {
    return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  }
  if (contentType === "image/gif") {
    const signature = Buffer.from(value.subarray(0, 6)).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (contentType === "image/webp") {
    return value.length >= 12
      && Buffer.from(value.subarray(0, 4)).toString("ascii") === "RIFF"
      && Buffer.from(value.subarray(8, 12)).toString("ascii") === "WEBP";
  }
  if (contentType === "image/bmp") return value.length >= 2 && value[0] === 0x42 && value[1] === 0x4d;
  return false;
}

export function createAttachmentStorageName(originalName, uniqueId = randomUUID()) {
  const prefix = String(uniqueId ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{16,100}$/u.test(prefix)) throw new Error("Некорректный идентификатор вложения");
  const initialName = cleanDisplayName(originalName);
  const initialExtension = path.extname(initialName);
  const initialSafeExtension = /^\.[A-Za-z0-9]{1,16}$/u.test(initialExtension)
    ? initialExtension.toLowerCase()
    : "";
  const maxEncodedLength = Math.min(180, Math.max(32, 220 - prefix.length - 2 - initialSafeExtension.length));
  const { name, encoded } = encodedDisplayName(initialName, maxEncodedLength, initialSafeExtension);
  const extension = path.extname(name);
  const safeExtension = /^\.[A-Za-z0-9]{1,16}$/u.test(extension) ? extension.toLowerCase() : "";
  return `${prefix}--${encoded}${safeExtension}`;
}

export function attachmentMetadataFromId(value) {
  const id = String(value ?? "").trim();
  if (!id || id !== path.basename(id) || WINDOWS_RESERVED_FILE.test(id)) return null;
  const encoded = ENCODED_ID.exec(id);
  let name = id;
  if (encoded) {
    try {
      name = cleanDisplayName(Buffer.from(encoded[2], "base64url").toString("utf8"));
    } catch {
      return null;
    }
  } else if (!LEGACY_ID.test(id) || id.includes("..")) {
    return null;
  }
  const type = attachmentContentType(name);
  return { id, name, type, isImage: attachmentIsImage(type) };
}

export function attachmentDescriptor(file) {
  const id = path.basename(path.resolve(String(file ?? "")));
  return attachmentMetadataFromId(id);
}

// Persisted Task rows hold paths in sourceDetails; public snapshots hold descriptors.
// Both representations must expose the same attachment membership without paths.
export function taskAttachmentDescriptors(task) {
  if (Array.isArray(task?.sourceDetails?.attachments)) {
    return task.sourceDetails.attachments.map(attachmentDescriptor).filter(Boolean);
  }
  return Array.isArray(task?.attachments) ? task.attachments : [];
}

function promptFileName(value) {
  return cleanDisplayName(value).replace(/[:\r\n]+/gu, " ").trim().slice(0, 180) || "Вложение";
}

export function messageInputWithAttachments(text, files, descriptors) {
  const attachments = Array.isArray(files) ? files : [];
  const metadata = Array.isArray(descriptors) ? descriptors : [];
  const hasFiles = metadata.some((item) => !attachmentIsImage(item));
  const defaultText = hasFiles
    ? "Проанализируй приложенные файлы."
    : "Проанализируй приложенные изображения.";
  const request = String(text ?? "").trim() || defaultText;
  const prompt = hasFiles
    ? [
      "# Files mentioned by the user:",
      "",
      ...attachments.flatMap((file, index) => [
        `## ${promptFileName(metadata[index]?.name)}: ${path.resolve(file)}`,
        "",
      ]),
      "## My request for Codex:",
      request,
    ].join("\n")
    : request;
  return [
    { type: "text", text: prompt },
    ...attachments.map((file, index) => ({
      type: attachmentIsImage(metadata[index]) ? "localImage" : "localFile",
      path: path.resolve(file),
    })),
  ];
}
