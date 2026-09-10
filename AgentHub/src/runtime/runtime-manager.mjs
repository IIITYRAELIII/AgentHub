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

import { readAgentHubVersion } from "../infrastructure/filesystem/agent-hub-package.mjs";
import { defaultRuntimeRoot, runtimeLayout, runtimeReleaseDirectory } from "../infrastructure/filesystem/runtime-layout.mjs";
import { verifyRuntimeImportClosure } from "../infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { nextRuntimeReleaseVersion } from "../infrastructure/filesystem/runtime-release-version.mjs";
import { protectRuntimeConfig, protectRuntimeDirectory } from "../infrastructure/filesystem/runtime-security.mjs";
import { buildWindowsRuntimeHost, runtimeHostSourceHash } from "../infrastructure/process/runtime-host-builder.mjs";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";
import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TOP_LEVEL_FILES = new Set([
  "AGENT_HUB_GUIDE.md",
  "package.json",
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

async function exists(target) {
  return access(target).then(() => true, () => false);
}

async function atomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeTextAtomic(target, `${JSON.stringify(value, null, 2)}\n`, {
    temporaryFile: temporary,
    exchangeBlockedTarget: process.platform === "win32",
  });
  await chmod(target, 0o600).catch(() => {});
}

async function releaseFileNames(sourceRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const topLevel = entries
    .filter((entry) => (
      (entry.isFile() && (
        TOP_LEVEL_FILES.has(entry.name)
        || ((entry.name.endsWith(".mjs") || entry.name.endsWith(".cjs"))
          && !entry.name.endsWith(".test.mjs")
          && !entry.name.endsWith(".test.cjs")
          && !entry.name.endsWith(".e2e.test.mjs")
          && entry.name !== "syntax-check.mjs")
      ))
      || (entry.isDirectory() && entry.name === "assets")
    ))
    .map((entry) => entry.name)
    .sort();
  const internal = [];
  async function visitInternal(relative) {
    const entries = await readdir(path.join(sourceRoot, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visitInternal(child);
      } else if (
        (entry.name.endsWith(".mjs") || entry.name.endsWith(".cjs"))
        && !entry.name.endsWith(".test.mjs")
        && !entry.name.endsWith(".test.cjs")
        && !entry.name.endsWith(".e2e.test.mjs")
      ) {
        internal.push(child);
      }
    }
  }
  if (entries.some((entry) => entry.isDirectory() && entry.name === "src")) {
    await visitInternal("src");
  }
  return [...topLevel, ...internal].sort();
}

async function hashFile(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function sameFileContents(left, right) {
  const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
  if (leftInfo.size !== rightInfo.size) return false;
  const [leftContents, rightContents] = await Promise.all([readFile(left), readFile(right)]);
  return leftContents.equals(rightContents);
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

async function pruneReplacedStableFiles(layout) {
  const entries = await readdir(layout.root, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(".stable-runtime-replaced-"))
    .map((entry) => rm(path.join(layout.root, entry.name), { force: true }).catch(() => {})));
}

function stableRuntimeFiles(layout, releaseRoot) {
  const files = [{
    source: path.join(releaseRoot, "codex-stop-hook-launcher.mjs"),
    target: layout.codexHookLauncherFile,
    executable: process.platform !== "win32",
  }];
  if (process.platform === "win32") {
    files.push({
      source: path.join(releaseRoot, "AgentHub.RuntimeHost.exe"),
      target: layout.launcherFile,
    });
    files.push({
      source: path.join(releaseRoot, "AgentHub.RuntimeHost.source.sha256"),
      target: layout.runtimeHostSourceHashFile,
    });
    files.push({
      source: path.join(releaseRoot, "AgentHub.RuntimeHost.exe.sha256"),
      target: layout.runtimeHostBinaryHashFile,
    });
  } else {
    files.push({
      source: path.join(releaseRoot, "runtime-launch.sh"),
      target: layout.launcherFile,
      executable: true,
    });
  }
  return files;
}

async function installStableRuntimeFiles(layout, releaseRoot, {
  beforeCommit,
  commitFile = (source, target) => cp(source, target, { force: true }),
} = {}) {
  const staging = path.join(layout.root, `.stable-runtime-${randomUUID()}`);
  const files = stableRuntimeFiles(layout, releaseRoot);
  await mkdir(staging, { recursive: true });
  let settled = false;
  const rollback = async () => {
    await Promise.all(files.map(async (file) => {
      if (!file.changed) return;
      if (file.displaced) {
        await rm(file.target, { force: true }).catch(() => {});
        const restored = await rename(file.displaced, file.target).then(() => true, () => false);
        if (restored) file.displaced = null;
        return;
      }
      if (file.existed) await cp(file.backup, file.target, { force: true }).catch(() => {});
      else await rm(file.target, { force: true }).catch(() => {});
    }));
  };
  const cleanup = async ({ removeDisplaced = true } = {}) => {
    if (settled) return;
    settled = true;
    if (removeDisplaced) {
      await Promise.all(files.map((file) => (
        file.displaced ? rm(file.displaced, { force: true }).catch(() => {}) : undefined
      )));
    }
    await rm(staging, { recursive: true, force: true });
  };
  try {
    for (const [index, file] of files.entries()) {
      file.staged = path.join(staging, `new-${index}`);
      file.backup = path.join(staging, `old-${index}`);
      file.existed = await exists(file.target);
      await cp(file.source, file.staged, { force: false, errorOnExist: true });
      file.changed = !file.existed || !await sameFileContents(file.staged, file.target);
      if (file.existed && file.changed) {
        await cp(file.target, file.backup, { force: false, errorOnExist: true });
      }
    }
    await beforeCommit?.();
    try {
      for (const file of files) {
        if (!file.changed) continue;
        try {
          await commitFile(file.staged, file.target);
        } catch (error) {
          if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
          if (process.platform !== "win32" || !file.existed) throw error;
          file.displaced = path.join(
            layout.root,
            `.stable-runtime-replaced-${randomUUID()}${path.extname(file.target)}`,
          );
          try {
            await rename(file.target, file.displaced);
            await commitFile(file.staged, file.target);
          } catch (replacementError) {
            await rm(file.target, { force: true }).catch(() => {});
            await rename(file.displaced, file.target).catch(() => {});
            file.displaced = null;
            throw replacementError;
          }
        }
        if (file.executable) await chmod(file.target, 0o700);
        else await protectRuntimeConfig(file.target);
      }
    } catch (error) {
      await rollback();
      throw error;
    }
    return { rollback, cleanup };
  } catch (error) {
    await cleanup({ removeDisplaced: false });
    throw error;
  }
}

export async function deployRuntime({
  sourceRoot = SOURCE_ROOT,
  runtimeRoot = defaultRuntimeRoot(),
  releaseId = newReleaseId(),
  removeRelease,
  onPruneWarning,
  beforeStableLauncherCommit,
  beforePointerCommit,
  commitStableFile,
  writePointer = atomicJson,
  protectPointer = protectRuntimeConfig,
  restorePointer = async (target, priorText) => {
    if (priorText === null) await rm(target, { force: true });
    else await writeTextAtomic(target, priorText);
  },
} = {}) {
  const layout = runtimeLayout(runtimeRoot);
  const releaseRoot = runtimeReleaseDirectory(runtimeRoot, releaseId);
  const staging = `${releaseRoot}.staging-${randomUUID()}`;
  await mkdir(layout.root, { recursive: true });
  await protectRuntimeDirectory(layout.root);
  await pruneReplacedStableFiles(layout);
  await mkdir(layout.releasesDir, { recursive: true });
  await protectRuntimeDirectory(layout.releasesDir);
  await mkdir(staging, { recursive: true });
  try {
    const names = await releaseFileNames(sourceRoot);
    for (const name of names) {
      const target = path.join(staging, name);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(sourceRoot, name), target, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    if (process.platform === "win32") {
      const sourceHash = await runtimeHostSourceHash(sourceRoot);
      const cachedHash = await readFile(layout.runtimeHostSourceHashFile, "utf8")
        .then((value) => value.trim().toLowerCase(), () => "");
      const cachedBinaryHash = await readFile(layout.runtimeHostBinaryHashFile, "utf8")
        .then((value) => value.trim().toLowerCase(), () => "");
      const actualCachedBinaryHash = await exists(layout.launcherFile)
        ? await hashFile(layout.launcherFile)
        : "";
      const stagedHost = path.join(staging, "AgentHub.RuntimeHost.exe");
      if (cachedHash === sourceHash
        && cachedBinaryHash === actualCachedBinaryHash
        && actualCachedBinaryHash) {
        await cp(layout.launcherFile, stagedHost, { force: false, errorOnExist: true });
      } else {
        await buildWindowsRuntimeHost({ sourceRoot, outputFile: stagedHost });
      }
      await writeFile(
        path.join(staging, "AgentHub.RuntimeHost.source.sha256"),
        `${sourceHash}\n`,
        "utf8",
      );
      await writeFile(
        path.join(staging, "AgentHub.RuntimeHost.exe.sha256"),
        `${await hashFile(stagedHost)}\n`,
        "utf8",
      );
      names.push(
        "AgentHub.RuntimeHost.exe",
        "AgentHub.RuntimeHost.exe.sha256",
        "AgentHub.RuntimeHost.source.sha256",
      );
      names.sort();
    }
    const packageVersion = readAgentHubVersion({ packageFile: path.join(sourceRoot, "package.json") });
    const manifest = {
      releaseId,
      version: packageVersion,
      releaseVersion: await nextRuntimeReleaseVersion({
        releasesDir: layout.releasesDir,
        packageVersion,
      }),
      createdAt: new Date().toISOString(),
      sourceRoot: path.resolve(sourceRoot),
      files: await releaseManifest(staging, names),
    };
    await verifyRuntimeImportClosure(staging, manifest.files);
    await writeFile(path.join(staging, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(staging, releaseRoot);
    // Staging is created below the already protected releases directory, so
    // every copied file inherits the owner-only ACL. Running icacls /T with
    // directory inheritance flags would strip effective ACEs from files.
    await protectRuntimeDirectory(releaseRoot);

    // The stable launchers select current.json.  They must therefore be fully
    // staged and installed before publishing a pointer to this release.
    const priorPointerText = await readFile(layout.currentFile, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    const previousPointer = JSON.parse(priorPointerText ?? "{}");
    const stableFiles = await installStableRuntimeFiles(layout, releaseRoot, {
      beforeCommit: beforeStableLauncherCommit,
      commitFile: commitStableFile,
    });
    const pointer = {
      current: releaseId,
      previous: previousPointer.current ?? previousPointer.previous ?? null,
      updatedAt: new Date().toISOString(),
    };
    try {
      await beforePointerCommit?.({ layout, releaseId, releaseRoot, pointer });
      await writePointer(layout.currentFile, pointer);
      await protectPointer(layout.currentFile);
      await stableFiles.cleanup();
    } catch (error) {
      const rollbackErrors = [];
      for (const rollback of [
        () => stableFiles.rollback(),
        () => stableFiles.cleanup({ removeDisplaced: false }),
        () => restorePointer(layout.currentFile, priorPointerText),
      ]) {
        try {
          await rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Runtime deployment failed and rollback was incomplete: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
    await pruneRuntimeReleases(
      layout,
      new Set([pointer.current, pointer.previous].filter(Boolean)),
      { removeRelease, onWarning: onPruneWarning },
    );
    for (const entry of await readdir(layout.root, { withFileTypes: true })) {
      if (entry.isFile() && /^config(?:\\..+)?\\.json$/iu.test(entry.name)) {
        await protectRuntimeConfig(path.join(layout.root, entry.name));
      }
    }
    return {
      layout,
      releaseId,
      releaseRoot,
      stableUpdateDeferred: false,
      blockedStableTarget: null,
    };
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
    ".venv-voice",
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

async function directoryContains(source, target) {
  const sourceInfo = await stat(source);
  const targetInfo = await stat(target).catch(() => null);
  if (!targetInfo || sourceInfo.isDirectory() !== targetInfo.isDirectory()) return false;
  if (!sourceInfo.isDirectory()) return (await readFile(source)).equals(await readFile(target));
  for (const entry of await readdir(source)) {
    if (!await directoryContains(path.join(source, entry), path.join(target, entry))) return false;
  }
  return true;
}

async function migrateDirectory(source, target, { replace = false } = {}) {
  if (!await exists(source)) return true;
  if (replace) {
    await replaceDirectory(source, target);
    return true;
  }
  if (!await exists(target)) return copyIfPresent(source, target);
  if (await directoryContains(source, target)) return true;
  throw new Error("Runtime data migration is incomplete; source data was preserved");
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
  for (const name of [
    "config.json",
    "TGBotToken.txt",
  ]) {
    await rm(path.join(sourceRoot, name), { force: true });
  }
  for (const name of [
    "data",
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
  await migrateDirectory(path.join(sourceRoot, "data"), layout.dataDir, { replace: replaceData });
  await migrateDirectory(path.join(sourceRoot, ".venv-voice"), path.join(layout.root, "voice-venv"));
  await migrateDirectory(path.join(sourceRoot, ".whisper-models"), path.join(layout.dataDir, "models", "whisper"));
  await migrateDirectory(path.join(sourceRoot, ".silero-models"), path.join(layout.dataDir, "models", "silero"));
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

export async function runtimeStatus({ runtimeRoot = defaultRuntimeRoot(), requireProcessEvidence = false } = {}) {
  const layout = runtimeLayout(runtimeRoot);
  const pointer = JSON.parse(await readFile(layout.currentFile, "utf8").catch(() => "{}"));
  const lockText = await readFile(path.join(layout.dataDir, "bot.lock"), "utf8").catch((error) => {
    if (requireProcessEvidence && error.code !== "ENOENT") throw error;
    return null;
  });
  const lock = JSON.parse(lockText ?? "{}");
  if (requireProcessEvidence && lockText !== null && (!Number.isSafeInteger(lock.pid) || lock.pid <= 0)) {
    throw new Error("Agent Hub lock has no valid process identity");
  }
  const pid = Number.isSafeInteger(lock.pid) ? lock.pid : null;
  const running = pid !== null && processIsAlive(pid);
  const runningRelease = running ? String(lock.releaseId ?? "").trim() || null : null;
  return {
    root: layout.root,
    current: pointer.current ?? null,
    previous: pointer.previous ?? null,
    configured: await exists(layout.configFile),
    active: await exists(layout.activationFile),
    running,
    ready: running && lock.ready === true,
    pid: running ? pid : null,
    runningRelease,
    restartRequired: running && pointer.current != null && runningRelease !== pointer.current,
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

