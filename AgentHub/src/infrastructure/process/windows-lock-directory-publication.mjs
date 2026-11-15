import { execFile } from "node:child_process";
import { lstatSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildWindowsRuntimeHost, runtimeHostSourceHash, RUNTIME_HOST_SOURCE_INPUTS } from "./runtime-host-builder.mjs";
import { verifyRuntimeManifest } from "../filesystem/runtime-manifest-verifier.mjs";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../..");
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
  const sourceHash = await runtimeHostSourceHash(SOURCE_ROOT);
  const sourceInputs = [];
  for (const name of RUNTIME_HOST_SOURCE_INPUTS) {
    const bytes = await regularBytes(path.join(SOURCE_ROOT, name));
    sourceInputs.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
  }
  let manifestBytes = await readFile(path.join(SOURCE_ROOT, "runtime-manifest.json")).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
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
    for (const name of [...RUNTIME_HOST_SOURCE_INPUTS, "AgentHub.RuntimeHost.exe", "AgentHub.RuntimeHost.exe.sha256", "AgentHub.RuntimeHost.source.sha256"]) {
      if (!manifest.files.some(entry => entry.path === name)) throw new Error("Prepared lock publisher input is not manifested");
    }
    binary = path.join(SOURCE_ROOT, "AgentHub.RuntimeHost.exe");
    binaryHash = sha(await regularBytes(binary));
    if ((await readFile(path.join(SOURCE_ROOT, "AgentHub.RuntimeHost.source.sha256"), "utf8")).trim() !== sourceHash
        || (await readFile(path.join(SOURCE_ROOT, "AgentHub.RuntimeHost.exe.sha256"), "utf8")).trim() !== binaryHash) {
      throw new Error("Prepared lock publisher provenance mismatch");
    }
    Object.assign(provenance, { mode: "prepared", manifestHash: sha(manifestBytes) });
  } else {
    ownedRoot = await mkdtemp(path.join(os.tmpdir(), "ah-lockhost-"));
    ownedIdentity = await lstat(ownedRoot, { bigint: true });
    try {
      const snapshot = path.join(ownedRoot, "source");
      for (const entry of sourceInputs) {
        const bytes = await regularBytes(path.join(SOURCE_ROOT, entry.path));
        if (sha(bytes) !== entry.sha256) throw new Error("Lock publisher source input changed");
        const target = path.join(snapshot, entry.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx" });
      }
      if (await runtimeHostSourceHash(snapshot) !== sourceHash) throw new Error("Lock publisher snapshot mismatch");
      binary = path.join(ownedRoot, "AgentHub.RuntimeHost.exe");
      await buildWindowsRuntimeHost({ sourceRoot: snapshot, outputFile: binary,
        execute: async (command, args, options) => {
          const executable = await realpath(command);
          const before = sha(await regularBytes(executable));
          const result = await execute(executable, args, options);
          if (sha(await regularBytes(executable)) !== before) throw new Error("Lock publisher compiler executable changed");
          provenance.compilerExecutions.push({ executable, sha256: before });
          return result;
        },
      });
      if (await runtimeHostSourceHash(SOURCE_ROOT) !== sourceHash || await runtimeHostSourceHash(snapshot) !== sourceHash) {
        throw new Error("Lock publisher inputs changed during compilation");
      }
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
