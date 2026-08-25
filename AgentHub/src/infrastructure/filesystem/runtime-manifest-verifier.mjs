import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { agentHubReleaseSequence, readAgentHubVersion } from "./agent-hub-package.mjs";
import { relativeModuleSpecifiers } from "./module-import-specifiers.mjs";

const MODULE_FILE_PATTERN = /\.(?:cjs|mjs)$/iu;

function normalizedRelative(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export async function verifyRuntimeImportClosure(releaseRoot, files) {
  const included = new Set(files.map((entry) => normalizedRelative(entry.path ?? entry)));
  const missing = [];
  for (const importer of [...included].filter((entry) => MODULE_FILE_PATTERN.test(entry))) {
    const source = await readFile(releasePath(releaseRoot, importer), "utf8");
    for (const specifier of relativeModuleSpecifiers(source)) {
      const target = normalizedRelative(path.posix.normalize(path.posix.join(
        path.posix.dirname(importer),
        specifier.replaceAll("\\", "/"),
      )));
      if (!included.has(target)) missing.push({ importer, specifier, target });
    }
  }
  if (missing.length > 0) {
    const details = missing
      .map(({ importer, specifier }) => `${importer} -> ${specifier}`)
      .join(", ");
    throw new Error(`Agent Hub runtime has missing relative imports: ${details}`);
  }
}

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
  const packageVersion = readAgentHubVersion({ packageFile: path.join(releaseRoot, "package.json") });
  if (manifest.version !== packageVersion) {
    throw new Error("Agent Hub runtime manifest version does not match package.json");
  }
  if (manifest.releaseVersion != null) {
    agentHubReleaseSequence(packageVersion, manifest.releaseVersion);
  }
  if (!Array.isArray(manifest.files)) throw new Error("Agent Hub runtime manifest has no file list");
  await verifyRuntimeImportClosure(releaseRoot, manifest.files);
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
