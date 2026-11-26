import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trustedWindowsPowerShellPath } from "./system-boot-identity.mjs";

const source = fileURLToPath(new URL("./codex-executable-custody.cs", import.meta.url));
const recordedMainChanged = '{"ready":false,"recordedMainChanged":true}';
const recordedMemberChanged = '{"ready":false,"recordedMemberChanged":true}';
const script = [
  "$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "Add-Type -Path $env:AGENT_HUB_CODEX_CUSTODY_SOURCE",
  "$reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false)",
  "$b=ConvertFrom-Json ($reader.ReadLine())", "$lease=$null",
  "try {",
  "  $lease=[AgentHubCodexBundleCustody]::Acquire([string]$b.root,[string]$b.installRoot,[string[]]$b.names,[string[]]$b.hashes,[string]$b.recordedMainName)",
  "  [Console]::WriteLine('{\"ready\":true}'); [Console]::Out.Flush()",
  "  while ($null -ne $reader.ReadLine()) {}",
  "} catch {",
  "  if ($_.Exception.GetBaseException() -is [AgentHubCodexBundleCustody+RecordedMainChangedException]) {",
  `    [Console]::WriteLine('${recordedMainChanged}'); [Console]::Out.Flush()`,
  "  }",
  "  if ($_.Exception.GetBaseException() -is [AgentHubCodexBundleCustody+RecordedMemberChangedException]) {",
  `    [Console]::WriteLine('${recordedMemberChanged}'); [Console]::Out.Flush()`,
  "  }",
  "  [Console]::Error.WriteLine('Codex bundle custody refused'); exit 1",
  "}",
  "finally { if ($null -ne $lease) { $lease.Dispose() }; $reader.Dispose() }",
].join("\n");

export function validBundleMemberName(name) {
  return typeof name === "string" && name.length > 0 && !path.win32.isAbsolute(name)
    && !name.includes("\0") && !name.includes(":")
    && name.split(/[\\/]/u).every(part => part && part !== "." && part !== "..");
}

/** The executable update owner supplies an already trusted, complete hash binding. */
export function acquireCodexExecutableCustody(bundle, { platform = process.platform,
  environment = process.env, spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
  if (platform !== "win32") return Promise.reject(new Error("Codex bundle custody is Windows-only"));
  if (typeof bundle?.root !== "string" || !path.win32.isAbsolute(bundle.root)
    || typeof bundle.installRoot !== "string" || !path.win32.isAbsolute(bundle.installRoot)
    || (path.win32.relative(bundle.installRoot, bundle.root).startsWith("..")
      || path.win32.isAbsolute(path.win32.relative(bundle.installRoot, bundle.root)))
    || !Array.isArray(bundle.files) || !bundle.files.length
    || bundle.files.some(file => !validBundleMemberName(file?.name) || !/^[A-F0-9]{64}$/u.test(file?.sha256 ?? ""))
    || new Set(bundle.files.map(file => file.name.toLowerCase())).size !== bundle.files.length
    || (bundle.recordedMainName !== undefined && !bundle.files.some(file => file.name === bundle.recordedMainName))) {
    return Promise.reject(new TypeError("Exact Codex bundle member identities required"));
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl(trustedWindowsPowerShellPath(environment), ["-NoProfile", "-NonInteractive",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { SystemRoot: environment.SystemRoot, TEMP: environment.TEMP, TMP: environment.TMP,
        AGENT_HUB_CODEX_CUSTODY_SOURCE: source },
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let ready = false, closed = false, output = "", timer;
    let refused = false;
    let mainChanged = false, memberChanged = false;
    let settleClose;
    const completion = new Promise(resolveClose => { settleClose = resolveClose; });
    // Only a confirmed mismatch from the held recorded main overrides availability.
    const refusal = () => mainChanged ? new Error("Codex executable changed during bundle verification")
      : Object.assign(new Error(memberChanged ? "Recorded Codex bundle identity changed" : "Codex bundle custody could not be established"),
        { code: "CODEX_BUNDLE_UNAVAILABLE" });
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {}); // Never retain native exception/path text.
    child.stdout.on("data", chunk => {
      if (ready || refused) return;
      output += chunk.toString("utf8");
      if (output.length > 64 * 1024) { refused = true; child.kill(); return; }
      if (!output.includes("\n")) return;
      const reply = output.trim();
      if (reply === recordedMainChanged && bundle.recordedMainName !== undefined) {
        mainChanged = true; refused = true; return;
      }
      if (reply === recordedMemberChanged && bundle.recordedMainName !== undefined) {
        memberChanged = true; refused = true; return;
      }
      if (reply !== '{"ready":true}') { refused = true; child.kill(); return; }
      ready = true; clearTimeout(timer);
      resolve(Object.freeze({
        pid: child.pid,
        assertAlive() { if (closed || child.exitCode !== null || child.signalCode !== null) throw refusal(); },
        async release() { child.stdin.end(); await completion; },
      }));
    });
    child.once("error", () => { closed = true; clearTimeout(timer); reject(refusal()); settleClose(); });
    child.once("close", () => { closed = true; clearTimeout(timer); if (!ready || refused) reject(refusal()); settleClose(); });
    timer = setTimeout(() => {
      // Only this exact read-only child is owned. Wait for close before refusal,
      // so a timeout cannot leave partial native custody behind.
      refused = true; child.kill();
    }, timeoutMs);
    timer.unref?.();
    child.stdin.write(`${JSON.stringify({ root: bundle.root, installRoot: bundle.installRoot ?? bundle.root,
      names: bundle.files.map(file => file.name), hashes: bundle.files.map(file => file.sha256),
      recordedMainName: bundle.recordedMainName })}\n`, "utf8");
  });
}
