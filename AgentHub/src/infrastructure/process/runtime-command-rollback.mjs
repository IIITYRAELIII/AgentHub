import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DurableCommandReceipts } from "../persistence/durable-command-receipts.mjs";
import {
  RUNTIME_COMMAND_RECEIPT_LAYOUT,
  runtimeCommandReceiptFile,
} from "./runtime-command.mjs";

const COMMAND_SERVER = "src/infrastructure/process/runtime-command.mjs";
const LEGACY_223 = new Map([
  [COMMAND_SERVER, "0f73d526dbc1b0c1e96022b2dd0d474019268f77b1ea5c7b7e37fdf87f651518"],
  ["src/composition/infrastructure-composition.mjs",
    "7266fd8a2b736b2ce63de956913af806a195974046d8ac9a6c4e2808a2bebaaf"],
  ["src/infrastructure/persistence/durable-command-receipts.mjs",
    "3daec881b590ab36493e5eaee83413727d925a66d1ea4a21dfbade089272b30f"],
]);

async function statIfPresent(file) {
  try { return await lstat(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function physicalDirectory(directory) {
  const entry = await statIfPresent(directory);
  if (entry) {
    const physical = await realpath(directory);
    if (!(await stat(physical)).isDirectory()) throw new Error("Runtime command rollback path is not a directory");
    return physical;
  }
  const parent = path.dirname(directory);
  if (parent === directory) throw new Error("Runtime command rollback volume is unavailable");
  return path.join(await physicalDirectory(parent), path.basename(directory));
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function assertOutsideWorkingTree(directory) {
  for (let candidate = directory;; candidate = path.dirname(candidate)) {
    if (await statIfPresent(path.join(candidate, ".git"))) {
      throw new Error("Runtime command rollback requires writing inside a Git working tree");
    }
    if (path.dirname(candidate) === candidate) return;
  }
}

// Called only by the installer which owns the stopped candidate and verified
// the manifest of the exact previous release. It never consumes command files.
export async function preserveRuntimeCommandsForRollback({
  runtimeRoot, previousLaunchRoot, previousRoot, manifest, readLegacyProjectRoot,
}) {
  const currentFile = runtimeCommandReceiptFile(runtimeRoot);
  const sourceEntry = await statIfPresent(currentFile);
  if (!sourceEntry) return { layout: "empty", retained: 0 };
  if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) {
    throw new Error("Runtime command rollback source is not an owned receipt file");
  }
  const physicalRuntime = await realpath(runtimeRoot);
  if (!inside(physicalRuntime, await realpath(currentFile))) throw new Error("Runtime command rollback source escapes the runtime");
  const source = new DurableCommandReceipts({ file: currentFile });
  if (!(await source.ids()).length) return { layout: "empty", retained: 0 };
  if (path.relative(physicalRuntime, await realpath(previousLaunchRoot)) !== "") {
    throw new Error("Previous runtime command launch root has different ownership");
  }
  const immutableFiles = new Map(manifest.files.map(({ path: relative, sha256 }) => [relative, sha256]));
  if (!immutableFiles.has(COMMAND_SERVER)) throw new Error("Previous runtime command receipt owner is unavailable");
  const previous = await import(pathToFileURL(path.join(previousRoot, COMMAND_SERVER)));
  if (manifest.version !== "2.1.23" || [...LEGACY_223].some(([relative, hash]) => immutableFiles.get(relative) !== hash)) {
    if (previous.RUNTIME_COMMAND_RECEIPT_LAYOUT !== RUNTIME_COMMAND_RECEIPT_LAYOUT) {
      throw new Error("Previous runtime command receipt layout is unverified");
    }
    return { layout: RUNTIME_COMMAND_RECEIPT_LAYOUT, retained: 0 };
  }
  if (!immutableFiles.has("src/infrastructure/filesystem/config.mjs")) throw new Error("Previous runtime configuration owner is unavailable");
  const projectRoot = await readLegacyProjectRoot();
  const legacyBase = path.join(projectRoot, ".agent-hub", "runtime");
  const legacyDirectory = previous.runtimeCommandSpoolDirectory(previousLaunchRoot, legacyBase);
  await assertOutsideWorkingTree(legacyDirectory);
  const physicalLegacy = await physicalDirectory(legacyDirectory);
  if (!inside(await realpath(projectRoot), physicalLegacy)) throw new Error("Runtime command rollback target escapes the previous project root");
  await assertOutsideWorkingTree(physicalLegacy);
  const file = path.join(physicalLegacy, "receipts.json");
  const entry = await statIfPresent(file);
  if (entry && !entry.isFile()) throw new Error("Runtime command rollback target is not an owned receipt file");
  const legacy = new DurableCommandReceipts({ file });
  return { layout: "legacy-2.1.23", retained: await legacy.retainForRollback(source) };
}
