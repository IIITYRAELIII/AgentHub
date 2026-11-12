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
import { spawn } from "node:child_process";

import { artifactVersionIdentity } from "../domain/agent-hub-version.mjs";
import { defaultRuntimeRoot, runtimeLayout, runtimeReleaseDirectory } from "../infrastructure/filesystem/runtime-layout.mjs";
import { verifyRuntimeManifest } from "../infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { releaseRecipeModule } from "../infrastructure/process/release-recipe.mjs";
import { protectRuntimeConfig, protectRuntimeDirectory } from "../infrastructure/filesystem/runtime-security.mjs";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";
import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";
import { migrateUsageSyncServerSetting } from "../infrastructure/filesystem/usage-sync-settings-migration.mjs";
import { captureRuntimeReleaseBinding, readRuntimePointer, withRuntimeInstallationLease } from "../infrastructure/filesystem/runtime-installation-custody.mjs";
import { runtimePointerTransition, runtimeRollbackPointer } from "../infrastructure/filesystem/runtime-release-retention-policy.mjs";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "..", "..");

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

async function hashFile(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function sameFileContents(left, right) {
  const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
  if (leftInfo.size !== rightInfo.size) return false;
  const [leftContents, rightContents] = await Promise.all([readFile(left), readFile(right)]);
  return leftContents.equals(rightContents);
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

export async function prepareRuntime(options = {}) {
  const { recipe } = await releaseRecipeModule();
  if (typeof recipe.prepareArtifact !== "function") throw new Error("Pinned recipe has no artifact preparation API");
  return recipe.prepareArtifact({ sourceRoot: SOURCE_ROOT, ...options });
}

export async function verifyInstalledRuntime({ runtimeRoot = defaultRuntimeRoot(), releaseId, releaseRoot }) {
  const layout = runtimeLayout(runtimeRoot);
  await verifyRuntimeManifest(releaseRoot, releaseId);
  const pointer = JSON.parse(await readFile(layout.currentFile, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  }));
  if (pointer.current !== releaseId) return false;
  for (const file of stableRuntimeFiles(layout, releaseRoot)) {
    if (!await exists(file.target) || !await sameFileContents(file.source, file.target)) return false;
  }
  return true;
}

export async function installPreparedRuntime(options = {}) {
  const runtimeRoot = options.runtimeRoot ?? defaultRuntimeRoot();
  return withRuntimeInstallationLease(runtimeRoot, lease => installPreparedRuntimeOwned({ ...options, runtimeRoot, lease }));
}

async function installPreparedRuntimeOwned({
  runtimeRoot = defaultRuntimeRoot(), releaseId, releaseRoot = runtimeReleaseDirectory(runtimeRoot, releaseId),
  beforeStableLauncherCommit, beforePointerCommit, commitStableFile, lease,
  writePointer = atomicJson, protectPointer = protectRuntimeConfig,
  restorePointer = async (target, priorText) => {
    if (priorText === null) await rm(target, { force: true });
    else await writeTextAtomic(target, priorText);
  },
} = {}) {
  const layout = runtimeLayout(runtimeRoot);
  if (path.resolve(releaseRoot) !== path.resolve(runtimeReleaseDirectory(runtimeRoot, releaseId))) {
    throw new Error("Prepared runtime must belong to the target runtime release directory");
  }
  await verifyRuntimeManifest(releaseRoot, releaseId);
  if (await verifyInstalledRuntime({ runtimeRoot, releaseId, releaseRoot })) {
    return { layout, releaseId, releaseRoot, reused: true, stableUpdateDeferred: false, blockedStableTarget: null };
  }
  await pruneReplacedStableFiles(layout);

    // The stable launchers select current.json.  They must therefore be fully
    // staged and installed before publishing a pointer to this release.
    const priorPointerText = await readFile(layout.currentFile, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    const previousPointer = JSON.parse(priorPointerText ?? "{}");
    const installed = await captureRuntimeReleaseBinding(releaseRoot, releaseId);
    const transition = runtimePointerTransition({ pointer: previousPointer, installed });
    await migrateUsageSyncServerSetting({ layout, previousReleaseId: previousPointer.current });
    const stableFiles = await installStableRuntimeFiles(layout, releaseRoot, {
      beforeCommit: beforeStableLauncherCommit,
      commitFile: commitStableFile,
    });
    const pointer = transition.pointer;
    try {
      await beforePointerCommit?.({ layout, releaseId, releaseRoot, pointer });
      await lease.assertOwned();
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
    // Prepared, running, unpublished and legacy bodies are not disposable by
    // exclusion from two pointer IDs. The after-ready owner retires only exact
    // known bindings through its original durable maintenance operation.
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
      pruningDeferred: true,
      retentionReason: transition.deferred ?? "after-ready-runtime-owner",
    };
}

// Compatibility entry point for installers and contours: the publication
// executor calls the two phases separately, with its persisted artifact proof.
export async function deployRuntime(options = {}) {
  const prepared = await prepareRuntime(options);
  return installPreparedRuntime({ ...options, ...prepared });
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
  return withRuntimeInstallationLease(runtimeRoot, lease => rollbackRuntimeOwned(runtimeRoot, lease));
}

async function rollbackRuntimeOwned(runtimeRoot, lease) {
  const layout = runtimeLayout(runtimeRoot);
  const pointer = JSON.parse(await readFile(layout.currentFile, "utf8"));
  if (!pointer.previous) throw new Error("No previous runtime release is available");
  await access(runtimeReleaseDirectory(runtimeRoot, pointer.previous));
  await lease.assertOwned();
  await atomicJson(layout.currentFile, runtimeRollbackPointer({ pointer }));
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

export function parseRuntimeArguments(args) {
  const command = args[0] ?? "status";
  let runtimeRoot = defaultRuntimeRoot();
  let expectedReleaseVersion = null, publicationRevision = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--runtime-root" && args[index + 1]) runtimeRoot = path.resolve(args[++index]);
    else if (args[index] === "--expected-release-version" && args[index + 1] && expectedReleaseVersion === null) expectedReleaseVersion = args[++index];
    else if (args[index] === "--publication-revision" && args[index + 1] && publicationRevision === null) publicationRevision = args[++index];
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (expectedReleaseVersion !== null || publicationRevision !== null) {
    if (command !== "deploy" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(publicationRevision ?? "")) {
      throw new Error("Frozen deploy requires its original source and artifact version");
    }
    artifactVersionIdentity(expectedReleaseVersion);
  }
  return { command, runtimeRoot, expectedReleaseVersion, publicationRevision };
}

export async function main(args = process.argv.slice(2)) {
  const { command, runtimeRoot, expectedReleaseVersion, publicationRevision } = parseRuntimeArguments(args);
  if (command === "deploy") {
    const result = await deployRuntime({ runtimeRoot, expectedReleaseVersion, publicationRevision });
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
