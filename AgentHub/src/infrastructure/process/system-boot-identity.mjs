import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";

function run(executable, args, { execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    }, (error, stdout) => error ? reject(error) : resolve(String(stdout ?? "")));
  });
}

export function trustedWindowsPowerShellPath(environment = process.env) {
  const rawSystemRoot = String(environment?.SystemRoot ?? "").trim();
  if (
    !/^[a-z]:\\windows[\\]?$/iu.test(rawSystemRoot)
    || rawSystemRoot.includes("\0")
    || rawSystemRoot.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("Trusted Windows SystemRoot is unavailable");
  }
  const systemRoot = path.win32.normalize(rawSystemRoot).replace(/[\\]+$/u, "");
  return path.win32.join(
    systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
}

export function isTrustedWindowsPowerShellPath(value) {
  const executablePath = path.win32.normalize(String(value ?? "").trim());
  return /^[a-z]:\\windows\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/iu.test(executablePath);
}

export async function readTrustedSystemBootIdentity({
  platform = process.platform,
  environment = process.env,
  execFileImpl = execFile,
} = {}) {
  if (platform !== "win32") {
    throw new Error("Trusted system boot identity is available only from Win32_OperatingSystem");
  }
  const executablePath = trustedWindowsPowerShellPath(environment);
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$os=Get-CimInstance Win32_OperatingSystem",
    "if ($null -eq $os -or $null -eq $os.LastBootUpTime) { exit 3 }",
    "$os.LastBootUpTime.ToUniversalTime().ToString('O')",
  ].join(";");
  const output = (await run(executablePath, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ], { execFileImpl })).trim();
  const bootTimeMs = Date.parse(output);
  if (!Number.isFinite(bootTimeMs)) throw new Error("Win32_OperatingSystem returned an invalid boot identity");
  return {
    source: "Win32_OperatingSystem.LastBootUpTime",
    executablePath,
    bootTime: new Date(bootTimeMs).toISOString(),
  };
}
