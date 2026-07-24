import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "./main-module.mjs";
import { defaultRuntimeRoot, runtimeLayout, runtimeReleaseDirectory } from "./runtime-layout.mjs";
import { writeTextAtomic } from "./state-store.mjs";
import { protectRuntimeConfig } from "./runtime-security.mjs";

const SOURCE_ROOT = path.resolve(import.meta.dirname);
const TOP_LEVEL_FILES = new Set([
  "package.json",
  "install-autostart.ps1",
  "codex-rollout-processes.ps1",
  "requirements.txt",
  "requirements-tts.txt",
  "runtime-launch.ps1",
  "runtime-launch.vbs",
  "runtime-launch.sh",
  "start.ps1",
  "transcribe.py",
  "tts_worker.py",
]);

async function exists(target) {
  return access(target).then(() => true, () => false);
}

async function atomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeTextAtomic(target, `${JSON.stringify(value, null, 2)}\n`, { temporaryFile: temporary });
  await chmod(target, 0o600).catch(() => {});
}

async function releaseFileNames(sourceRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  return entries
    .filter((entry) => (
      (entry.isFile() && (
        TOP_LEVEL_FILES.has(entry.name)
        || (entry.name.endsWith(".mjs")
          && !entry.name.endsWith(".test.mjs")
          && !entry.name.endsWith(".e2e.test.mjs")
          && entry.name !== "syntax-check.mjs")
      ))
      || (entry.isDirectory() && entry.name === "assets")
    ))
    .map((entry) => entry.name)
    .sort();
}

async function hashFile(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function releaseManifest(releaseRoot, names) {
  const files = [];
  async function visit(relative) {
    const full = path.join(releaseRoot, relative);
    const info = await stat(full);
    if (info.isDirectory()) {
      for (const child of await readdir(full)) await visit(path.join(relative, child));
      return;
    }
    files.push({
      path: relative.replaceAll("\\", "/"),
      bytes: info.size,
      sha256: await hashFile(full),
    });
  }
  for (const name of names) await visit(name);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function newReleaseId(now = new Date()) {
  return `${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

async function pruneRuntimeReleases(layout, keep, {
  removeRelease = (target) => rm(target, { recursive: true, force: true }),
  onWarning = (error, target) => console.warn(`Cannot prune runtime release ${target}: ${error.message}`),
} = {}) {
  for (const entry of await readdir(layout.releasesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    const target = path.join(layout.releasesDir, entry.name);
    try {
      await removeRelease(target);
    } catch (error) {
      if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
      onWarning(error, target);
    }
  }
}

export async function deployRuntime({
  sourceRoot = SOURCE_ROOT,
  runtimeRoot = defaultRuntimeRoot(),
  releaseId = newReleaseId(),
  removeRelease,
  onPruneWarning,
} = {}) {
  const layout = runtimeLayout(runtimeRoot);
  const releaseRoot = runtimeReleaseDirectory(runtimeRoot, releaseId);
  const staging = `${releaseRoot}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    const names = await releaseFileNames(sourceRoot);
    for (const name of names) {
      await cp(path.join(sourceRoot, name), path.join(staging, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    const manifest = {
      releaseId,
      createdAt: new Date().toISOString(),
      sourceRoot: path.resolve(sourceRoot),
      files: await releaseManifest(staging, names),
    };
    await writeFile(path.join(staging, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(layout.releasesDir, { recursive: true });
    await rename(staging, releaseRoot);

    const previousPointer = JSON.parse(await readFile(layout.currentFile, "utf8").catch(() => "{}"));
    const pointer = {
      current: releaseId,
      previous: previousPointer.current ?? previousPointer.previous ?? null,
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(layout.currentFile, pointer);
    if (process.platform === "win32") {
      await cp(path.join(sourceRoot, "runtime-launch.vbs"), layout.launcherFile, { force: true });
      // Keep the source filename as a compatibility alias. One-off deployment
      // helpers historically referred to runtime-launch.vbs while the stable
      // installed entry point is launch.vbs.
      await cp(path.join(sourceRoot, "runtime-launch.vbs"), layout.legacyWindowsLauncherFile, { force: true });
      await cp(path.join(sourceRoot, "runtime-launch.ps1"), layout.powershellLauncherFile, { force: true });
    } else {
      await cp(path.join(sourceRoot, "runtime-launch.sh"), layout.launcherFile, { force: true });
      await chmod(layout.launcherFile, 0o700);
    }
    await pruneRuntimeReleases(
      layout,
      new Set([pointer.current, pointer.previous].filter(Boolean)),
      { removeRelease, onWarning: onPruneWarning },
    );
    return { layout, releaseId, releaseRoot };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareRuntimeConfig({
  sourceRoot = SOURCE_ROOT,
  runtimeRoot = defaultRuntimeRoot(),
  overwrite = false,
} = {}) {
  const layout = runtimeLayout(runtimeRoot);
  if (!overwrite && await exists(layout.configFile)) {
    await protectRuntimeConfig(layout.configFile);
    return layout.configFile;
  }
  const sourceConfig = path.join(sourceRoot, "config.json");
  const raw = JSON.parse(await readFile(sourceConfig, "utf8"));
  raw.dataDir = "data";
  const sourceWhisperPython = path.join(
    sourceRoot,
    ".venv-telegram",
    process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
  );
  if (!raw.pythonExe && await exists(sourceWhisperPython)) {
    raw.pythonExe = path.join(
      layout.root,
      "voice-venv",
      process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
    );
  }
  raw.whisperModelDir = "data/models/whisper";
  raw.ttsCacheDir = "data/models/silero";
  await atomicJson(layout.configFile, raw);
  await protectRuntimeConfig(layout.configFile);
  return layout.configFile;
}

async function copyIfPresent(source, target) {
  if (!await exists(source) || await exists(target)) return false;
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  return true;
}

async function replaceDirectory(source, target) {
  const staging = `${target}.staging-${randomUUID()}`;
  const backup = `${target}.previous-${randomUUID()}`;
  await rm(staging, { recursive: true, force: true });
  if (await exists(source)) await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
  else await mkdir(staging, { recursive: true });
  const hadTarget = await exists(target);
  if (hadTarget) await rename(target, backup);
  try {
    await rename(staging, target);
    if (hadTarget) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadTarget && !await exists(target)) await rename(backup, target).catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function retireLegacyArtifacts(sourceRoot, layout) {
  for (const name of ["telegram-codex.log", "telegram-codex-error.log"]) {
    const source = path.join(sourceRoot, name);
    if (await exists(source)) {
      await cp(source, path.join(layout.dataDir, `legacy-${name}`), { force: false, errorOnExist: true })
        .catch((error) => {
          if (error?.code !== "EEXIST") throw error;
        });
      await rm(source, { force: true });
    }
  }
  for (const name of [
    "config.json",
    "TGBotToken.txt",
    ".telegram-codex-state.json",
    ".telegram-codex-state.pre-rename.json",
  ]) {
    await rm(path.join(sourceRoot, name), { force: true });
  }
  for (const name of [
    "data",
    ".telegram-audio",
    ".venv-telegram",
    ".whisper-models",
    ".silero-models",
  ]) {
    await rm(path.join(sourceRoot, name), { recursive: true, force: true });
  }
}

export async function activateRuntime({
  sourceRoot = SOURCE_ROOT,
  runtimeRoot = defaultRuntimeRoot(),
  retireLegacyConfig = true,
  replaceData = false,
  retireWorkspaceRuntime = retireLegacyConfig,
} = {}) {
  const layout = runtimeLayout(runtimeRoot);
  const pointer = JSON.parse(await readFile(layout.currentFile, "utf8"));
  await prepareRuntimeConfig({ sourceRoot, runtimeRoot });
  if (replaceData) await replaceDirectory(path.join(sourceRoot, "data"), layout.dataDir);
  else await copyIfPresent(path.join(sourceRoot, "data"), layout.dataDir);
  await copyIfPresent(path.join(sourceRoot, ".venv-telegram"), path.join(layout.root, "voice-venv"));
  await copyIfPresent(path.join(sourceRoot, ".whisper-models"), path.join(layout.dataDir, "models", "whisper"));
  await copyIfPresent(path.join(sourceRoot, ".silero-models"), path.join(layout.dataDir, "models", "silero"));
  await atomicJson(layout.activationFile, {
    release: pointer.current,
    activatedAt: new Date().toISOString(),
    sourceRoot: path.resolve(sourceRoot),
  });
  if (retireWorkspaceRuntime) await retireLegacyArtifacts(sourceRoot, layout);
  else if (retireLegacyConfig) await rm(path.join(sourceRoot, "config.json"), { force: true });
  return { layout, releaseId: pointer.current };
}

export async function rollbackRuntime({ runtimeRoot = defaultRuntimeRoot() } = {}) {
  const layout = runtimeLayout(runtimeRoot);
  const pointer = JSON.parse(await readFile(layout.currentFile, "utf8"));
  if (!pointer.previous) throw new Error("No previous runtime release is available");
  await access(runtimeReleaseDirectory(runtimeRoot, pointer.previous));
  await atomicJson(layout.currentFile, {
    current: pointer.previous,
    previous: pointer.current,
    updatedAt: new Date().toISOString(),
  });
  return { current: pointer.previous, previous: pointer.current };
}

export async function runtimeStatus({ runtimeRoot = defaultRuntimeRoot() } = {}) {
  const layout = runtimeLayout(runtimeRoot);
  const pointer = JSON.parse(await readFile(layout.currentFile, "utf8").catch(() => "{}"));
  return {
    root: layout.root,
    current: pointer.current ?? null,
    previous: pointer.previous ?? null,
    configured: await exists(layout.configFile),
    active: await exists(layout.activationFile),
  };
}

function parseCli(args) {
  const command = args[0] ?? "status";
  let runtimeRoot = defaultRuntimeRoot();
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--runtime-root" && args[index + 1]) runtimeRoot = path.resolve(args[++index]);
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return { command, runtimeRoot };
}

export async function main(args = process.argv.slice(2)) {
  const { command, runtimeRoot } = parseCli(args);
  if (command === "deploy") {
    const result = await deployRuntime({ runtimeRoot });
    await prepareRuntimeConfig({ runtimeRoot });
    console.log(`Runtime release deployed: ${result.releaseId}`);
  } else if (command === "activate") {
    const result = await activateRuntime({ runtimeRoot });
    console.log(`Runtime activated: ${result.releaseId}`);
  } else if (command === "rollback") {
    const result = await rollbackRuntime({ runtimeRoot });
    console.log(`Runtime rolled back: ${result.current}`);
  } else if (command === "status") {
    console.log(JSON.stringify(await runtimeStatus({ runtimeRoot }), null, 2));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Runtime manager failed: ${error.message}`);
    process.exitCode = 1;
  });
}
