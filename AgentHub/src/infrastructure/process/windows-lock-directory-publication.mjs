import { execFile } from "node:child_process";
import { lstatSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
function runtimeHostCompilerCandidates(environment = process.env) {
  const windows = environment.WINDIR || environment.SystemRoot || "C:\\Windows";
  return [path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")];
}

import { verifyRuntimeManifest } from "../filesystem/runtime-manifest-verifier.mjs";
const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../..");
import { LOCK_PUBLISHER_SOURCE } from "./lock-publisher-protocol.mjs";
const SOURCE_FILE = path.join(import.meta.dirname, LOCK_PUBLISHER_SOURCE);
const execute = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = (message, code, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
let prepared;

async function regularBytes(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Lock publisher requires a regular file");
  return readFile(file);
}

async function prepare() {
  if (process.platform !== "win32") throw new Error("Windows lock directory publisher is unavailable on this platform");
  const sourceBytes = await regularBytes(SOURCE_FILE);
  const sourceHash = sha(sourceBytes);
  const sourceInputs = [{ path: "release-lock-publisher.cs", bytes: sourceBytes.length, sha256: sourceHash }];
  const manifestBytes = await readFile(path.join(SOURCE_ROOT, "runtime-manifest.json")).catch(error => {
    if (error.code === "ENOENT") return null; throw error;
  });
  let binary, binaryHash, ownedRoot = null, ownedIdentity = null;
  const assertOwnedRoot = (info) => {
    if (!info.isDirectory() || info.isSymbolicLink()
      || info.dev !== ownedIdentity.dev || info.ino !== ownedIdentity.ino) {
      throw new Error("Owned lock publisher directory changed; cleanup refused");
    }
  };
  const removeOwnedRoot = async () => {
    if (!ownedRoot) return;
    const info = await lstat(ownedRoot, { bigint: true }).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info) {
      assertOwnedRoot(info);
      await rm(ownedRoot, { recursive: true, force: true });
    }
    ownedRoot = null;
  };
  const provenance = { sourceHash, sourceInputs, compilerExecutions: [] };
  if (manifestBytes !== null) {
    const manifest = JSON.parse(manifestBytes);
    await verifyRuntimeManifest(SOURCE_ROOT, manifest.releaseId);
    for (const name of ["src/infrastructure/process/release-lock-publisher.cs", "ReleaseLockPublisher.exe", "ReleaseLockPublisher.source.sha256"]) {
      if (!manifest.files.some(entry => entry.path === name)) throw new Error("Prepared lock publisher input is not manifested");
    }
    binary = path.join(SOURCE_ROOT, "ReleaseLockPublisher.exe");
    binaryHash = sha(await regularBytes(binary));
    if ((await readFile(path.join(SOURCE_ROOT, "ReleaseLockPublisher.source.sha256"), "utf8")).trim() !== sourceHash) {
      throw new Error("Prepared lock publisher provenance mismatch");
    }
    Object.assign(provenance, { mode: "prepared", manifestHash: sha(manifestBytes) });
  } else {
  ownedRoot = await mkdtemp(path.join(os.tmpdir(), "ah-lockhost-"));
  ownedIdentity = await lstat(ownedRoot, { bigint: true });
  try {
    const snapshot = path.join(ownedRoot, "release-lock-publisher.cs");
    await writeFile(snapshot, sourceBytes, { flag: "wx" });
    let compiler;
    for (const candidate of runtimeHostCompilerCandidates(process.env)) {
      if ((await lstat(candidate).catch(error => { if (error.code === "ENOENT") return null; throw error; }))?.isFile()) {
        compiler = await realpath(candidate); break;
      }
    }
    if (!compiler) throw new Error("System C# compiler for the release lock publisher was not found");
    const compilerHash = sha(await regularBytes(compiler));
    binary = path.join(ownedRoot, "AgentHub.ReleaseLockPublisher.exe");
    await execute(compiler, ["/nologo", "/target:exe", "/optimize+", `/out:${binary}`,
      "/reference:System.dll", "/reference:System.Web.Extensions.dll", snapshot],
      { windowsHide: true, maxBuffer: 1024 * 1024 });
    if (sha(await regularBytes(compiler)) !== compilerHash
        || sha(await regularBytes(SOURCE_FILE)) !== sourceHash || sha(await regularBytes(snapshot)) !== sourceHash) {
      throw new Error("Lock publisher inputs changed during compilation");
    }
    provenance.compilerExecutions.push({ executable: compiler, sha256: compilerHash });
    binaryHash = sha(await regularBytes(binary));
    provenance.mode = "source";
  } catch (error) {
    try { await removeOwnedRoot(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
  }
  Object.assign(provenance, { executable: binary, binaryHash });
  const active = new Set();
  let closed = false;
  const verifyBinary = async () => {
    if (sha(await regularBytes(binary)) !== binaryHash) throw failure("Lock publisher binary changed", "WINDOWS_LOCK_PUBLISHER_CHANGED");
    if (manifestBytes && !(await readFile(path.join(SOURCE_ROOT, "runtime-manifest.json"))).equals(manifestBytes)) {
      throw failure("Lock publisher manifest changed", "WINDOWS_LOCK_PUBLISHER_CHANGED");
    }
    if (sha(await regularBytes(SOURCE_FILE)) !== sourceHash) {
      throw failure("Lock publisher source changed", "WINDOWS_LOCK_PUBLISHER_CHANGED");
    }
  };
  const shutdown = async () => {
    closed = true;
    await Promise.allSettled([...active]);
    await removeOwnedRoot();
  };
  // beforeExit is event-loop quiescence, not terminal shutdown: a library/test
  // owner can schedule more work from it. Keep the same verified consumer live.
  // Explicit shutdown still fences and joins. At actual exit async work cannot
  // be drained; retain the body for unresolved active work and clean only idle
  // body with the exact same physical-identity guard as explicit cleanup.
  if (ownedRoot) process.once("exit", () => {
    closed = true;
    if (active.size || !ownedRoot) return;
    try {
      assertOwnedRoot(lstatSync(ownedRoot, { bigint: true }));
      rmSync(ownedRoot, { recursive: true, force: true });
      ownedRoot = null;
    } catch { /* Unknown/replaced bodies remain retained; no cleanup fallback. */ }
  });
  return {
    provenance: structuredClone(provenance),
    shutdown,
    async inspectProcess(processId) {
      if (closed || !Number.isSafeInteger(processId) || processId < 1) return null;
      const operation = (async () => {
        await verifyBinary();
        const result = await new Promise(resolve => {
          const child = execFile(binary, ["--inspect-lock-process"], {
            windowsHide: true, encoding: "utf8", maxBuffer: 4096, timeout: 1000,
          }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
          child.stdin.on("error", () => {});
          child.stdin.end(JSON.stringify({ protocol: 1, processId }) + "\n");
        });
        await verifyBinary();
        if (result.error || result.stderr) return null;
        const value = JSON.parse(result.stdout);
        return value.protocol === 1 && value.status === "observed" && value.processId === processId
          && /^[0-9]{1,20}$/u.test(value.birthFileTime) && typeof value.alive === "boolean"
          ? { processId, birthFileTime: value.birthFileTime, alive: value.alive } : null;
      })().catch(() => null);
      active.add(operation);
      try { return await operation; } finally { active.delete(operation); }
    },
    async publish(readyPath, canonicalPath) {
      if (closed) throw failure("Lock publisher is closed", "WINDOWS_LOCK_PUBLISHER_CLOSED");
      const ready = path.resolve(readyPath), canonical = path.resolve(canonicalPath);
      const suffix = ready.slice(canonical.length + 7);
      if (!canonical.toLowerCase().endsWith(".lock") || !ready.toLowerCase().startsWith(`${canonical}.ready-`.toLowerCase())
          || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(suffix)
          || path.dirname(ready).toLowerCase() !== path.dirname(canonical).toLowerCase()) {
        throw failure("Invalid lock directory publication binding", "WINDOWS_LOCK_PUBLICATION_INVALID");
      }
      const operation = (async () => {
        await verifyBinary();
        const result = await new Promise(resolve => {
          const child = execFile(binary, ["--publish-lock-directory"], { windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 },
            (error, stdout, stderr) => resolve({ error, stdout, stderr }));
          child.stdin.on("error", () => {});
          child.stdin.end(JSON.stringify({ protocol: 1, readyPath: ready, canonicalPath: canonical }));
        }); // execFile callback joins close; no timeout/retry abandons an ambiguous publisher.
        try { await verifyBinary(); }
        catch (error) { throw failure("Lock publisher changed after native execution; outcome is unknown", "WINDOWS_LOCK_PUBLICATION_UNKNOWN", error); }
        let receipt;
        try { receipt = JSON.parse(result.stdout); } catch {}
        if (!result.stderr && receipt?.protocol === 1 && receipt.status === "published" && !result.error
            && Object.keys(receipt).sort().join(",") === "protocol,status") return;
        if (!result.stderr && result.error?.code === 2 && receipt?.protocol === 1 && receipt.status === "refused") {
          if (receipt.nativeError === 183 || receipt.nativeError === 80) throw failure("Interprocess lock already exists", "EEXIST");
          throw Object.assign(failure("Native lock directory publication refused", "WINDOWS_LOCK_PUBLICATION_REFUSED"), { nativeError: receipt.nativeError });
        }
        throw failure("Native lock directory publication outcome is unknown; do not replay", "WINDOWS_LOCK_PUBLICATION_UNKNOWN", result.error);
      })();
      active.add(operation);
      try { return await operation; } finally { active.delete(operation); }
    },
  };
}

export function prepareWindowsLockDirectoryPublisher() {
  return prepared ??= prepare().catch(error => { prepared = null; throw error; });
}
