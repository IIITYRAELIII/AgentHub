import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { trustedWindowsPowerShellPath } from "../process/system-boot-identity.mjs";
const source = fileURLToPath(new URL("./sealed-native-capture.cs", import.meta.url));
function run(mode, input) {
  if (process.platform !== "win32") return Promise.reject(new Error("native-capture-platform-unavailable"));
  const script = [
    "$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$net=[System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()",
    "Add-Type -Path $env:AGENT_HUB_CAPTURE_SOURCE -ReferencedAssemblies @((Join-Path $net 'System.Web.Extensions.dll'),(Join-Path $net 'System.dll'))",
    "$b=ConvertFrom-Json $env:AGENT_HUB_CAPTURE_INPUT",
    mode === "measure" ? "[AgentHubSealedNativeCapture]::Measure([string]$b.roots)"
      : mode === "alias" ? "[AgentHubSealedNativeCapture]::UnlinkObjectAlias([string]$b.path,[string]$b.identity)"
      : "[AgentHubSealedNativeCapture]::Retire([string]$b.root,[string]$b.plan,[string]$b.sha256,[bool]$b.allowPartial)",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(trustedWindowsPowerShellPath(process.env), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        AGENT_HUB_CAPTURE_SOURCE: source, AGENT_HUB_CAPTURE_INPUT: JSON.stringify(input) } });
    let stdout = "", stderr = "", overflow = false, failure;
    child.stdout.on("data", b => { if (stdout.length + b.length > 128 * 1024) overflow = true; else stdout += b.toString("utf8"); });
    child.stderr.on("data", b => { if (stderr.length + b.length > 64 * 1024) overflow = true; else stderr += b.toString("utf8"); });
    child.on("error", e => { failure = e; });
    // Always drain/join the destructive child. No transport timeout kills it.
    child.on("close", (code, signal) => {
      if (failure) return reject(failure);
      if (code !== 0 || signal || stderr.trim() || overflow) return reject(new Error("native-capture-outcome-unknown:" + code + ":" + stderr.slice(0, 4096)));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("native-capture-outcome-unknown:invalid-result")); }
    });
  });
}
export async function retireSealedNativeCapture(root, plan, sha256, { allowPartial = false } = {}) {
  if (!path.isAbsolute(root) || !path.isAbsolute(plan) || !/^[a-f0-9]{64}$/u.test(sha256) || typeof allowPartial !== "boolean") throw new TypeError("Exact native capture proof required");
  const result = await run("retire", { root, plan, sha256, allowPartial });
  if (!["complete", "partial"].includes(result.status) || !Number.isSafeInteger(result.files) || result.files < 0 || result.files > 64
      || !["logicalBytes", "allocatedBytesUnlinked", "sharedObjectsUnlinked"].every(k => Number.isSafeInteger(result[k]) && result[k] >= 0)) throw new Error("native-capture-outcome-unknown:invalid-metrics");
  return result;
}
export function measureNativeCaptureAllocation(roots) {
  if (!Array.isArray(roots) || !roots.length || roots.some(r => !path.isAbsolute(r))) throw new TypeError("Exact selected roots required");
  return run("measure", { roots: JSON.stringify(roots) });
}
export async function unlinkOwnedNativeObjectAlias(file, identity) {
  if (!path.isAbsolute(file) || !/^[a-f0-9]{64}$/u.test(identity?.sha256)) throw new TypeError("Exact immutable object alias required");
  const result = await run("alias", { path: file, identity: JSON.stringify(identity) });
  if (result.status !== "unlinked") throw new Error("native-capture-outcome-unknown:alias");
}
