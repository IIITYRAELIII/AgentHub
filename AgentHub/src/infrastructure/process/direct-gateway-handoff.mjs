import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { trustedWindowsPowerShellPath } from "./system-boot-identity.mjs";

// The gateway controller may replace only its configured, preserved Caddy after
// the former Hub parent has exited. A live/unknown parent is a retryable barrier,
// not authority to stop a process or bind a competing listener.
export async function handoffDirectGateway(settings, { configFile, existingConfig,
  platform = process.platform, environment = process.env, execute = promisify(execFile) } = {}) {
  if (platform !== "win32" || !existingConfig || path.resolve(path.dirname(settings.executable)) !== path.resolve(settings.workingDirectory)
      || path.resolve(configFile) !== path.resolve(settings.workingDirectory, "Caddyfile")) {
    throw new Error("Managed gateway configuration handoff is unavailable");
  }
  for (const file of [settings.executable, configFile]) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Managed gateway handoff requires regular owned files");
  }
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  if (!Buffer.from(await readFile(configFile)).equals(Buffer.from(existingConfig))) throw new Error("Gateway configuration changed before handoff");
  const quote = value => /\s/u.test(value) ? `"${value}"` : value;
  const input = { executable: path.resolve(settings.executable), configFile: path.resolve(configFile),
    commandLine: [path.resolve(settings.executable), "run", "--config", path.resolve(configFile), "--adapter", "caddyfile"].map(quote).join(" "),
    configHash: hash(Buffer.from(existingConfig)), executableHash: hash(await readFile(settings.executable)) };
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
  const script = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function FileHash($file) {
  $stream=[IO.File]::OpenRead($file); $sha=[Security.Cryptography.SHA256]::Create()
  try {return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
  finally {$sha.Dispose();$stream.Dispose()}
}
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
$configured=@(Get-CimInstance Win32_Process -Filter "Name = 'caddy.exe'" | Where-Object {
  [StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath,$expected.executable) -and
  $_.CommandLine.IndexOf($expected.configFile,[StringComparison]::OrdinalIgnoreCase) -ge 0
})
$candidates=@($configured | Where-Object {[StringComparer]::OrdinalIgnoreCase.Equals($_.CommandLine,$expected.commandLine)})
if($configured.Count -ne $candidates.Count){throw 'Configured gateway command identity is unknown'}
if($candidates.Count -eq 0){[pscustomobject]@{absent=$true;stopped=$false}|ConvertTo-Json -Compress;exit 0}
if($candidates.Count -ne 1){throw 'Exact managed gateway identity is unavailable'}
$candidate=$candidates[0]
if(Get-CimInstance Win32_Process -Filter ("ProcessId = "+$candidate.ParentProcessId)){throw 'Previous gateway owner is still active'}
$process=[Diagnostics.Process]::GetProcessById([int]$candidate.ProcessId)
try {
  $handle=$process.SafeHandle
  if($process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -ne $candidate.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')){throw 'Gateway process identity changed'}
  if(-not [StringComparer]::OrdinalIgnoreCase.Equals($process.MainModule.FileName,$expected.executable)){throw 'Gateway executable identity changed'}
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class GatewayHandoffNative{[DllImport("kernel32.dll",SetLastError=true)]public static extern bool TerminateProcess(IntPtr handle,uint code);}'
  $again=Get-CimInstance Win32_Process -Filter ("ProcessId = "+$candidate.ProcessId)
  if($null -eq $again -or -not [StringComparer]::OrdinalIgnoreCase.Equals($again.CommandLine,$expected.commandLine) -or
     $again.CreationDate.ToUniversalTime().Ticks -ne $candidate.CreationDate.ToUniversalTime().Ticks){throw 'Gateway command identity changed'}
  if(Get-CimInstance Win32_Process -Filter ("ProcessId = "+$candidate.ParentProcessId)){throw 'Previous gateway owner is still active'}
  if((FileHash $expected.configFile) -ne $expected.configHash -or
     (FileHash $expected.executable) -ne $expected.executableHash){throw 'Gateway files changed before handoff'}
  if(-not [GatewayHandoffNative]::TerminateProcess($handle.DangerousGetHandle(),0)){throw 'Managed gateway termination failed'}
  if(-not $process.WaitForExit(3000)){throw 'Managed gateway exit was not confirmed'}
  [pscustomobject]@{pid=[int]$candidate.ProcessId;parentPid=[int]$candidate.ParentProcessId;creationTime=$candidate.CreationDate.ToUniversalTime().ToString('O');stopped=$true}|ConvertTo-Json -Compress
} finally {$process.Dispose()}
`;
  const result = await execute(trustedWindowsPowerShellPath(environment),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
  const receipt = JSON.parse(result.stdout);
  if (!(receipt.absent === true && receipt.stopped === false)
      && !(receipt.stopped === true && Number.isSafeInteger(receipt.pid))) throw new Error("Managed gateway handoff has no exit evidence");
  return receipt;
}
