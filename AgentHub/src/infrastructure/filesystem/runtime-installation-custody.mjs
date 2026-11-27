import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { runtimeLayout } from "./runtime-layout.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import { writeTextAtomic } from "../persistence/state-store.mjs";
import { withSealedRuntimeExecutor } from "./sealed-runtime-executor.mjs";

export const MAX_RUNTIME_MANIFEST_BYTES = 4 * 1024 * 1024;

async function readBounded(file, maximum) {
  const bytes = Buffer.allocUnsafe(maximum + 1);
  let used = 0;
  while (used <= maximum) {
    const result = await file.read(bytes, used, bytes.length - used, null);
    if (!result.bytesRead) return bytes.subarray(0, used);
    used += result.bytesRead;
  }
  throw new Error("runtime-metadata-budget");
}

// Alias and native paths acquire the SAME physical installation lease. This
// protects prepare/publication/rollback/retirement, never ordinary user turns.
export async function withRuntimeInstallationLease(runtimeRoot, operation) {
  await mkdir(runtimeRoot, { recursive: true });
  const physical = await realpath(runtimeRoot);
  // Preparing a first release must not precreate data/: explicit activation
  // owns migration into that directory and refuses an incomplete existing body.
  return withInterprocessLocks([path.join(physical, ".runtime-installation")],
    lease => withSealedRuntimeExecutor(() => operation(lease)));
}

// This witness lives only as long as the operation that verified the bytes.
export async function observeRuntimeContent(files, releaseRoot) {
  const paths = [...new Set(files.map(file => path.resolve(file)))];
  const originalRoot = await realpath(releaseRoot);
  const directory = await stat(originalRoot, { bigint: true });
  const fingerprint = info => [info.dev, info.ino, info.birthtimeNs, info.size,
    info.mtimeNs, info.ctimeNs, info.mode, info.nlink].join(":");
  const missing = error => {
    if (error.code === "ENOENT") return null;
    throw error;
  };
  const read = async file => {
    const named = await lstat(file, { bigint: true }).catch(missing);
    if (!named || !named.isSymbolicLink()) return named && fingerprint(named);
    const target = await stat(file, { bigint: true }).catch(missing);
    return [fingerprint(named), target && fingerprint(target)].join(":");
  };
  const scan = async expected => {
    const values = [];
    for (let offset = 0; offset < paths.length; offset += 32) {
      const entries = await Promise.all(paths.slice(offset, offset + 32).map(read));
      if (expected && entries.some((value, index) => value !== expected[offset + index])) {
        throw new Error("Installed runtime file changed after content proof");
      }
      if (!expected) values.push(...entries);
    }
    const root = await realpath(releaseRoot);
    const current = await stat(root, { bigint: true });
    if (root !== originalRoot || current.dev !== directory.dev || current.ino !== directory.ino
        || current.birthtimeNs !== directory.birthtimeNs) {
      throw new Error("Installed runtime directory changed after content proof");
    }
    return values;
  };
  const original = await scan();
  return async () => { await scan(original); };
}

export async function readRuntimePointer(runtimeRoot) {
  try {
    const file = await open(runtimeLayout(runtimeRoot).currentFile, "r");
    try {
      if ((await file.stat()).size > 256 * 1024) throw new Error("runtime-pointer-budget");
      return JSON.parse((await readBounded(file, 256 * 1024)).toString("utf8"));
    } finally { await file.close(); }
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeRuntimePointer(runtimeRoot, pointer) {
  const target = runtimeLayout(runtimeRoot).currentFile;
  await writeTextAtomic(target, `${JSON.stringify(pointer, null, 2)}\n`, {
    temporaryFile: `${target}.${process.pid}.${randomUUID()}.tmp`,
    exchangeBlockedTarget: process.platform === "win32",
  });
  await chmod(target, 0o600).catch(() => {});
}

export async function readRuntimeManifest(root) {
  const file = await open(path.join(root, "runtime-manifest.json"), "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_RUNTIME_MANIFEST_BYTES) throw new Error("runtime-manifest-budget");
    const bytes = await readBounded(file, MAX_RUNTIME_MANIFEST_BYTES);
    return { manifest: JSON.parse(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { await file.close(); }
}

export async function captureRuntimeReleaseBinding(root, releaseId) {
  const physical = await realpath(root);
  // Only the overall runtime root may be a compatibility alias; a release leaf
  // cannot substitute a link for an immutable prepared body.
  const named = await lstat(root);
  const info = await lstat(physical, { bigint: true });
  if (named.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink()) throw new Error("runtime-release-root-refused");
  const { manifest, sha256 } = await readRuntimeManifest(physical);
  if (manifest.releaseId !== releaseId) throw new Error("runtime-release-identity-changed");
  return { releaseId, manifestSha256: sha256, root: { dev: String(info.dev), ino: String(info.ino),
    birthFileTime: String(info.birthtimeNs / 100n + 116444736000000000n) } };
}

export function sameRuntimeBinding(left, right) {
  return Boolean(left && right && left.releaseId === right.releaseId && left.manifestSha256 === right.manifestSha256
    && ["dev", "ino", "birthFileTime"].every(k => left.root?.[k] === right.root?.[k]));
}
