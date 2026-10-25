import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { trustedWindowsPowerShellPath } from "../process/system-boot-identity.mjs";

const source = fileURLToPath(new URL("./sealed-runtime-release.cs", import.meta.url));
const script = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
  "$net=[System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()",
  "Add-Type -Path $env:AGENT_HUB_RUNTIME_RETIRE_SOURCE -ReferencedAssemblies @((Join-Path $net 'System.Web.Extensions.dll'),(Join-Path $net 'System.dll'))",
  "$b=ConvertFrom-Json $env:AGENT_HUB_RUNTIME_RETIRE_BINDING",
  "[AgentHubSealedRuntimeRelease]::Retire($env:AGENT_HUB_RUNTIME_RETIRE_ROOT,[string]$b.root.dev,[string]$b.root.ino,[string]$b.root.birthFileTime,[string]$b.manifestSha256,[string]$b.releaseId,[bool]::Parse($env:AGENT_HUB_RUNTIME_RETIRE_PARTIAL))",
].join("\n");

function decimal(value, maximum, minimum = 0n) {
  return typeof value === "string" && /^(?:0|[1-9]\d{0,19})$/u.test(value)
    && BigInt(value) >= minimum && BigInt(value) <= maximum;
}

/** Caller owns fresh runtime pins, the lease and original pruning admission. */
export function retireSealedRuntimeRelease(target, binding, { allowPartial = false } = {}) {
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
  const environment = Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    AGENT_HUB_RUNTIME_RETIRE_SOURCE: source,
    AGENT_HUB_RUNTIME_RETIRE_ROOT: path.win32.normalize(target),
    AGENT_HUB_RUNTIME_RETIRE_BINDING: JSON.stringify({
      releaseId: binding.releaseId, manifestSha256: binding.manifestSha256,
      root: { dev: binding.root.dev, ino: binding.root.ino, birthFileTime: binding.root.birthFileTime },
    }),
    AGENT_HUB_RUNTIME_RETIRE_PARTIAL: String(allowPartial),
  }).filter(([, value]) => value !== undefined));
  const executable = trustedWindowsPowerShellPath(process.env);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], {
      env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", overflow = false, spawnError;
    const capture = (kind, chunk) => {
      const bytes = chunk.toString("utf8");
      if ((kind === "out" ? stdout.length : stderr.length) + bytes.length > 64 * 1024) overflow = true;
      else if (kind === "out") stdout += bytes;
      else stderr += bytes;
    };
    child.stdout.on("data", chunk => capture("out", chunk));
    child.stderr.on("data", chunk => capture("err", chunk));
    child.once("error", error => { spawnError = error; });
    // No timeout, abort or maxBuffer kill: keep draining even oversized output
    // and resolve/reject only AFTER the destructive child has actually closed.
    child.once("close", (code, signal) => {
      if (spawnError) { reject(spawnError); return; }
      if (code !== 0 || signal || overflow || stderr.trim()) {
        reject(new Error(`sealed-runtime-outcome-unknown:${code ?? signal}:${stderr.slice(0, 4096)}`)); return;
      }
      try {
        const result = JSON.parse(stdout);
        if (!result || !["complete", "partial"].includes(result.status)
            || Object.keys(result).sort().join(",") !== "files,logicalBytes,status"
            || !Number.isInteger(result.files) || result.files < 0 || result.files > 64
            || !Number.isInteger(result.logicalBytes) || result.logicalBytes < 0
            || result.logicalBytes > 256 * 1024 * 1024) throw new Error("Invalid native result");
        resolve(result);
      } catch { reject(new Error("sealed-runtime-outcome-unknown:invalid-result")); }
    });
  });
}
