import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const workerFile = fileURLToPath(new URL("./sqlite-cohort-capture-worker.mjs", import.meta.url));
const inside = (file, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};
async function noLinks(file) {
  let current = path.resolve(file);
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Capture paths cannot contain links or junctions");
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
async function createOwnedOutput(directory) {
  const pending = [];
  let existing = path.resolve(directory);
  for (;;) {
    try { await lstat(existing); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; pending.push(existing); existing = path.dirname(existing); }
  }
  await noLinks(existing);
  for (const entry of pending.reverse()) {
    try { await mkdir(entry); } catch (error) { if (error.code !== "EEXIST") throw error; }
    await noLinks(entry);
  }
}
function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
}
function captureError(code, message) { return Object.assign(new Error(message), { code }); }

// Only metadata and the process handle live here. All source DB connections,
// retained read transactions, backup and large-file hashing belong to the child.
export async function captureSqliteCohortInProcess({ sourceDataDirectory, outputDirectory,
  deadlineMs = 120_000, terminationTimeoutMs = 5_000, attempts = 3, signal, onProgress, includeQueueFiles = false,
} = {}, { spawnImpl = spawn, workerEntry = workerFile } = {}) {
  boundedInteger(deadlineMs, "capture deadline", 600_000);
  boundedInteger(terminationTimeoutMs, "termination deadline", 30_000);
  boundedInteger(attempts, "pin attempts", 3);
  if (!sourceDataDirectory || !outputDirectory || !path.isAbsolute(sourceDataDirectory) || !path.isAbsolute(outputDirectory)) throw new Error("Explicit absolute source/output paths required");
  if (signal?.aborted) throw captureError("CAPTURE_ABORTED", "SQLite capture cancelled before process start");
  const source = path.resolve(sourceDataDirectory);
  const output = path.resolve(outputDirectory);
  if (inside(source, output) || inside(output, source)) throw new Error("Snapshot source and output cannot overlap");
  await noLinks(source);
  await createOwnedOutput(output);
  const root = await mkdtemp(path.join(output, "supervised-"));
  const workerOutput = path.join(root, "worker-output");
  await mkdir(workerOutput);
  const manifestFile = path.join(root, "supervision.json");
  const supervision = { schemaVersion: 1, phase: "starting", bootable: false, deadlineMs,
    createdAt: new Date().toISOString(), workerExitConfirmed: false, workerPid: null, lastProgress: null };
  let pendingSave = Promise.resolve();
  const save = () => {
    const bytes = `${JSON.stringify(supervision, null, 2)}\n`;
    const operation = pendingSave.then(() => writeFile(manifestFile, bytes, "utf8"));
    pendingSave = operation.catch(() => {});
    return operation;
  };
  await save();
  if (signal?.aborted) { supervision.phase = "failed"; supervision.errorCode = "CAPTURE_ABORTED"; await save(); throw Object.assign(captureError("CAPTURE_ABORTED", "SQLite capture cancelled before process start"), { manifestFile }); }
  const started = performance.now();
  let child;
  let result = null;
  let failure = null;
  let deadlineTimer;
  let terminationTimer;
  let finished = false;
  let killRequested = false;
  let resolveClose;
  const closed = new Promise((resolve) => { resolveClose = resolve; });
  const stop = (reason) => {
    if (finished || killRequested) return;
    failure ??= reason;
    killRequested = true;
    supervision.phase = "terminating";
    supervision.errorCode = reason.code;
    void save().catch((error) => { supervision.metadataError = error.message; });
    try { child?.kill("SIGKILL"); } catch (error) { supervision.terminationError = error.message; }
    terminationTimer = setTimeout(() => {
      if (finished) return;
      // Never report cleanup success when the OS has not confirmed death.
      supervision.phase = "termination-unconfirmed";
      resolveClose({ unconfirmed: true });
    }, terminationTimeoutMs);
  };
  const abort = () => stop(captureError("CAPTURE_ABORTED", "SQLite capture cancelled"));
  try {
    child = spawnImpl(process.execPath, [workerEntry], { cwd: root, windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: root, TMP: root,
        HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root },
    });
    supervision.workerPid = child.pid ?? null;
    child.once("spawn", () => void (async () => {
      supervision.workerPid = child.pid;
      if (killRequested) {
        try { child.kill("SIGKILL"); } catch (error) { supervision.terminationError = error.message; }
        return;
      }
      supervision.phase = "capturing";
      // Persist the owned PID before the worker may open production read pins.
      await save();
      if (finished || killRequested) return;
      child.send({ type: "capture", options: { sourceDataDirectory: source, outputDirectory: workerOutput, attempts, includeQueueFiles } }, (error) => {
        if (error) stop(captureError("CAPTURE_IPC_FAILED", error.message));
      });
    })().catch((error) => stop(captureError("CAPTURE_IPC_FAILED", error.message))));
    child.on("message", (message) => {
      if (finished || failure) return;
      if (message?.type === "result") result = message.result;
      else if (message?.type === "failure") failure = captureError("CAPTURE_WORKER_FAILED", message.error?.message || "Capture worker failed");
      else if (message?.type === "progress") {
        supervision.lastProgress = message.progress;
        Promise.resolve().then(() => onProgress?.(message.progress)).catch((error) => stop(captureError("CAPTURE_OBSERVER_FAILED", error.message)));
      }
    });
    child.once("error", (error) => stop(captureError("CAPTURE_PROCESS_FAILED", error.message)));
    child.once("close", (code, exitSignal) => {
      finished = true;
      clearTimeout(deadlineTimer); clearTimeout(terminationTimer);
      resolveClose({ code, signal: exitSignal });
    });
    deadlineTimer = setTimeout(() => stop(captureError("CAPTURE_DEADLINE_EXCEEDED", `SQLite capture exceeded ${deadlineMs} ms`)), Math.max(1, deadlineMs - (performance.now() - started)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const exit = await closed;
    supervision.elapsedMs = Math.round(performance.now() - started);
    supervision.workerExitConfirmed = !exit.unconfirmed;
    supervision.exit = exit;
    if (exit.unconfirmed) {
      const error = captureError("CAPTURE_TERMINATION_UNCONFIRMED", "OS did not confirm capture worker termination; output remains quarantined");
      error.cause = failure;
      throw error;
    }
    if (!failure && supervision.elapsedMs > deadlineMs) failure = captureError("CAPTURE_DEADLINE_EXCEEDED", `SQLite capture exceeded ${deadlineMs} ms`);
    if (failure) throw failure;
    if (exit.code !== 0 || !result || !inside(result.root, workerOutput)
      || result.manifestFile !== path.join(result.root, "snapshot-manifest.json")
      || result.dataDirectory !== path.join(result.root, "databases")) throw captureError("CAPTURE_WORKER_FAILED", "Capture worker exited without an exact result");
    const manifest = JSON.parse(await readFile(result.manifestFile, "utf8"));
    if (manifest.phase !== "captured-raw" || manifest.bootable !== false || manifest.databases?.length !== 3) throw captureError("CAPTURE_WORKER_FAILED", "Capture manifest is not a completed raw cohort");
    supervision.phase = "captured-raw";
    supervision.captureManifestFile = result.manifestFile;
    await save();
    return { ...result, manifest, supervision, supervisionManifestFile: manifestFile };
  } catch (error) {
    supervision.phase = supervision.workerExitConfirmed || !child ? "failed" : "termination-unconfirmed";
    supervision.errorCode = error.code ?? "CAPTURE_PROCESS_FAILED";
    supervision.error = error.message;
    // Mutate capture metadata only after confirmed child exit. A killed child
    // may have left a valid-looking raw manifest just before the deadline.
    if (supervision.workerExitConfirmed) {
      for (const entry of await readdir(workerOutput, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("captured-")) continue;
        const captureManifest = path.join(workerOutput, entry.name, "snapshot-manifest.json");
        await noLinks(path.dirname(captureManifest));
        try {
          await noLinks(captureManifest);
          const prior = JSON.parse(await readFile(captureManifest, "utf8"));
          await writeFile(captureManifest, `${JSON.stringify({ ...prior, phase: "failed", bootable: false, error: error.message, errorCode: supervision.errorCode, workerExitConfirmed: true }, null, 2)}\n`, "utf8");
        } catch (metadataError) { if (metadataError.code !== "ENOENT") supervision.captureMetadataError = metadataError.message; }
      }
    }
    await save();
    throw Object.assign(error, { manifestFile, supervision });
  } finally {
    clearTimeout(deadlineTimer); clearTimeout(terminationTimer);
    signal?.removeEventListener("abort", abort);
  }
}
