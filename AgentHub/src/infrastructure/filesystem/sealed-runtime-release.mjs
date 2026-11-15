import { fileURLToPath } from "node:url";
import path from "node:path";
import { trustedWindowsPowerShellPath } from "../process/system-boot-identity.mjs";
import { runtimeGeneratedCacheProof } from "./runtime-generated-cache.mjs";
import { executeScopedRuntimeRetirement, withSealedRuntimeExecutor } from "./sealed-runtime-executor.mjs";

const source = fileURLToPath(new URL("./sealed-runtime-release.cs", import.meta.url));

function decimal(value, maximum, minimum = 0n) {
  return typeof value === "string" && /^(?:0|[1-9]\d{0,19})$/u.test(value)
    && BigInt(value) >= minimum && BigInt(value) <= maximum;
}

function nativeResult(stdout) {
  try {
    const result = JSON.parse(stdout);
    if (!result || !["complete", "partial"].includes(result.status)
        || Object.keys(result).sort().join(",") !== "files,logicalBytes,status"
        || !Number.isInteger(result.files) || result.files < 0 || result.files > 64
        || !Number.isInteger(result.logicalBytes) || result.logicalBytes < 0
        || result.logicalBytes > 256 * 1024 * 1024) throw new Error("Invalid native result");
    return result;
  } catch { throw new Error("sealed-runtime-outcome-unknown:invalid-result"); }
}

/** Caller owns fresh runtime pins, the lease and original pruning admission. */
export function retireSealedRuntimeRelease(target, binding, { allowPartial = false, verifiedCache = null } = {}) {
  if (typeof target !== "string" || target.includes("\0") || !path.win32.isAbsolute(target)
      || /^[\\/]{2}[?.][\\/]/u.test(target)
      || path.win32.dirname(path.win32.normalize(target)) === path.win32.normalize(target)
      || typeof allowPartial !== "boolean"
      || !/^[A-Za-z0-9._-]{1,160}$/u.test(binding?.releaseId ?? "")
      || [".", ".."].includes(binding?.releaseId)
      || !/^[a-f0-9]{64}$/u.test(binding?.manifestSha256 ?? "")
      || !decimal(binding?.root?.dev, 0xffffffffn)
      || !decimal(binding?.root?.ino, 0xffffffffffffffffn, 1n)
      || !decimal(binding?.root?.birthFileTime, 0xffffffffffffffffn, 1n)) {
    throw new TypeError("Exact retired runtime root/manifest/release binding required");
  }
  if (process.platform !== "win32") return Promise.reject(new Error("sealed-runtime-platform-unavailable"));
  const cache = runtimeGeneratedCacheProof(target, binding, verifiedCache);
  const environment = Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    AGENT_HUB_RUNTIME_RETIRE_SOURCE: source,
    AGENT_HUB_RUNTIME_RETIRE_ROOT: path.win32.normalize(target),
    AGENT_HUB_RUNTIME_RETIRE_BINDING: JSON.stringify({
      releaseId: binding.releaseId, manifestSha256: binding.manifestSha256,
      root: { dev: binding.root.dev, ino: binding.root.ino, birthFileTime: binding.root.birthFileTime },
    }),
    AGENT_HUB_RUNTIME_RETIRE_PARTIAL: String(allowPartial),
    AGENT_HUB_RUNTIME_RETIRE_CACHE: JSON.stringify(cache),
  }).filter(([, value]) => value !== undefined));
  const executable = trustedWindowsPowerShellPath(process.env);
  // Unscoped callers get a joined one-batch lifetime. The actual installation
  // and foreground maintenance leases share a producer across admitted batches.
  return withSealedRuntimeExecutor(() => executeScopedRuntimeRetirement(source, executable, environment, nativeResult));
}
