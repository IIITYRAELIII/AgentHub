import { createHash } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathInsideOrSame } from "../../../config.mjs";

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
]);

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,([a-z0-9+/]+={0,2})$/iu;
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif|bmp)$/iu;
const CLIPBOARD_FILE = /^codex-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif|bmp)$/iu;

function descriptor(id, extension, { missing = false, privateName = false } = {}) {
  return {
    id,
    name: privateName ? "Изображение" : id,
    type: IMAGE_TYPES.get(extension) ?? "application/octet-stream",
    ...(missing ? { missing: true } : {}),
  };
}

function privateFileName(prefix, source, extension) {
  return `${prefix}-${createHash("sha256").update(source).digest("hex")}${extension}`;
}

export function createCodexAssistantAttachmentImporter({
  attachmentRoot,
  temporaryRoot,
  generatedImageRoot,
  viewImageRoots = [],
  maxFiles = 8,
  maxBytes = 20 * 1024 * 1024,
}) {
  const targetRoot = path.resolve(attachmentRoot);
  const tempRoot = path.resolve(temporaryRoot);
  const generatedRoot = path.resolve(generatedImageRoot);
  const allowedViewRoots = [...new Set(viewImageRoots.map((value) => path.resolve(value)))];

  return async function importCodexAssistantAttachments(values) {
    const imported = [];
    await mkdir(targetRoot, { recursive: true });
    for (const item of Array.isArray(values) ? values.slice(0, maxFiles) : []) {
      if (item?.type === "data") {
        const match = DATA_URL.exec(String(item.value ?? ""));
        if (!match) continue;
        const bytes = Buffer.from(match[2], "base64");
        if (bytes.length <= 0 || bytes.length > maxBytes) continue;
        const extension = match[1].toLowerCase() === "image/jpeg"
          ? ".jpg"
          : `.${match[1].slice("image/".length).toLowerCase()}`;
        const name = `codex-inline-${createHash("sha256").update(bytes).digest("hex")}${extension}`;
        const target = path.join(targetRoot, name);
        await writeFile(target, bytes, { flag: "wx" }).catch((error) => {
          if (error?.code !== "EEXIST") throw error;
        });
        imported.push(descriptor(name, extension, { privateName: true }));
        continue;
      }

      const generated = item?.type === "generated-path";
      const viewed = item?.type === "view-path";
      const clipboard = item?.type === "path";
      if (!generated && !viewed && !clipboard) continue;
      const source = path.resolve(String(item.value ?? ""));
      const sourceName = path.basename(source);
      const extension = path.extname(sourceName).toLowerCase();
      if (!IMAGE_FILE.test(sourceName)) continue;
      if (generated && !pathInsideOrSame(source, generatedRoot)) continue;
      if (viewed && !allowedViewRoots.some((root) => pathInsideOrSame(source, root))) continue;
      if (clipboard && (!pathInsideOrSame(source, tempRoot) || !CLIPBOARD_FILE.test(sourceName))) continue;

      const privateName = generated || viewed;
      const name = generated
        ? privateFileName("codex-generated", source, extension)
        : viewed
          ? privateFileName("codex-viewed", source, extension)
          : sourceName;
      const target = path.join(targetRoot, name);
      let sourceInfo;
      try {
        sourceInfo = await stat(source);
      } catch {
        let durableInfo = null;
        try {
          durableInfo = await stat(target);
        } catch {
          // A source can disappear after the first history read; the private copy remains canonical.
        }
        if (durableInfo?.isFile() && durableInfo.size > 0 && durableInfo.size <= maxBytes) {
          imported.push(descriptor(name, extension, { privateName: true }));
        } else if (privateName) {
          imported.push(descriptor(name, extension, { missing: true, privateName: true }));
        }
        continue;
      }
      if (!sourceInfo.isFile() || sourceInfo.size <= 0 || sourceInfo.size > maxBytes) continue;
      let targetInfo = null;
      try {
        targetInfo = await stat(target);
      } catch {
        // The first history read creates the private durable copy.
      }
      if (!targetInfo?.isFile() || targetInfo.size !== sourceInfo.size) await copyFile(source, target);
      imported.push(descriptor(name, extension, { privateName }));
    }
    return imported;
  };
}
