import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

function releasePath(releaseRoot, relative) {
  if (path.isAbsolute(relative)) throw new Error(`Agent Hub runtime manifest contains an absolute path: ${relative}`);
  const root = path.resolve(releaseRoot);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Agent Hub runtime manifest escapes its release: ${relative}`);
  }
  return target;
}

export async function verifyRuntimeManifest(releaseRoot, releaseId) {
  const manifestPath = path.join(releaseRoot, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.releaseId !== releaseId) {
    throw new Error("Agent Hub runtime manifest does not match current.json");
  }
  if (!Array.isArray(manifest.files)) throw new Error("Agent Hub runtime manifest has no file list");
  for (const entry of manifest.files) {
    const relative = String(entry?.path ?? "");
    const target = releasePath(releaseRoot, relative);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new Error(`Agent Hub runtime file is missing: ${relative}`);
    if (info.size !== Number(entry.bytes)) throw new Error(`Agent Hub runtime file size mismatch: ${relative}`);
    const hash = createHash("sha256").update(await readFile(target)).digest("hex");
    if (hash !== String(entry.sha256 ?? "").toLowerCase()) {
      throw new Error(`Agent Hub runtime file hash mismatch: ${relative}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [releaseRoot, releaseId] = process.argv.slice(2);
  verifyRuntimeManifest(releaseRoot, releaseId).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
