import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FILE_DROP_CLIPBOARD_SCRIPT = Buffer.from([
  "Add-Type -AssemblyName System.Windows.Forms",
  "$files = New-Object System.Collections.Specialized.StringCollection",
  "[void]$files.Add($env:AGENT_HUB_CLIPBOARD_FILE)",
  "[System.Windows.Forms.Clipboard]::SetFileDropList($files)",
].join("\n"), "utf16le").toString("base64");

export function copyWindowsFileObject(file, {
  platform = process.platform,
  execFileImpl = execFile,
} = {}) {
  if (platform !== "win32") {
    throw new Error("Копирование файлового объекта поддерживается только в Windows");
  }
  const target = path.resolve(String(file ?? ""));
  return new Promise((resolve, reject) => {
    execFileImpl("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-EncodedCommand",
      FILE_DROP_CLIPBOARD_SCRIPT,
    ], {
      env: { ...process.env, AGENT_HUB_CLIPBOARD_FILE: target },
      timeout: 10_000,
      windowsHide: true,
    }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function revealWindowsFile(file, {
  platform = process.platform,
  existsSyncImpl = fs.existsSync,
  spawnImpl = spawn,
} = {}) {
  if (platform !== "win32") {
    throw new Error("Показ файла в проводнике поддерживается только в Windows");
  }
  const target = path.resolve(String(file ?? ""));
  if (!existsSyncImpl(target)) {
    throw new Error(`Файл не найден: ${target}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const child = spawnImpl("explorer.exe", [`/select,${target}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => settle(reject, error));
    child.once("spawn", () => {
      child.unref();
      settle(resolve);
    });
  });
}
