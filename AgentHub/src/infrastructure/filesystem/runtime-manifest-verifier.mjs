import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { agentHubReleaseSequence, readAgentHubVersion } from "./agent-hub-package.mjs";
import { relativeModuleSpecifiers } from "./module-import-specifiers.mjs";
import { manifestVersionIdentity } from "../../domain/agent-hub-version.mjs";

const MODULE_FILE_PATTERN = /\.(?:cjs|mjs)$/iu;

export const RELEASE_PROGRESS_RUNTIME_ASSETS = Object.freeze([
  "release-progress/server.mjs", "release-progress/reader.mjs", "release-progress/identity.mjs",
  "release-progress/index.html", "release-progress/app.js", "release-progress/style.css",
]);
const RELEASE_PROGRESS_RUNTIME_FILES = new Set(RELEASE_PROGRESS_RUNTIME_ASSETS);

const RUNTIME_TOP_LEVEL_FILES = new Set([
  "AGENT_HUB_GUIDE.md",
  "package.json",
  "package-lock.json",
  "RuntimeHost.release-acceptance-v1.json",
  "codex-process-ancestry.ps1",
  "codex-rollout-processes.ps1",
  "claude-session-processes.ps1",
  "requirements.txt",
  "requirements-tts.txt",
  "attachment_thumbnail.py",
  "runtime-launch.sh",
  "start.ps1",
  "transcribe.py",
  "whisper_runtime.py",
  "tts_worker.py",
  "work-log.css",
]);

function normalizedRelative(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

// Shared with the canonical source collector and native candidate validation.
// assets are copied recursively; src and top-level modules exclude test tools.
export function isRuntimeSourceModule(relative) {
  const file = normalizedRelative(relative);
  const name = path.posix.basename(file);
  if (file.startsWith("assets/") || RELEASE_PROGRESS_RUNTIME_FILES.has(file)) return MODULE_FILE_PATTERN.test(name);
  return /\.(?:cjs|mjs)$/u.test(name) && ((!file.includes("/") || file.startsWith("src/"))
      && !/\.(?:test|e2e\.test)\.(?:cjs|mjs)$/u.test(name)
      && file !== "syntax-check.mjs");
}

export function isRuntimeSourceFile(relative) {
  const file = normalizedRelative(relative);
  return RUNTIME_TOP_LEVEL_FILES.has(file) || file.startsWith("assets/")
    || RELEASE_PROGRESS_RUNTIME_FILES.has(file) || isRuntimeSourceModule(file);
}

export async function verifyRuntimeImportClosure(releaseRoot, files, {
  readModule = importer => readFile(releasePath(releaseRoot, importer), "utf8"),
} = {}) {
  const included = new Set(files.map((entry) => normalizedRelative(entry.path ?? entry)));
  const missing = [];
  // npm's locked package tree is verified by npm ci and the runtime manifest.
  // Its modules may use package exports or extensionless internal specifiers;
  // the first-party relative-import rule does not model Node package resolution.
  for (const importer of [...included].filter((entry) =>
    MODULE_FILE_PATTERN.test(entry) && !entry.startsWith("node_modules/"))) {
    const source = await readModule(importer);
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
    if (manifest.releaseVersion.includes("+build.")) manifestVersionIdentity(manifest);
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
