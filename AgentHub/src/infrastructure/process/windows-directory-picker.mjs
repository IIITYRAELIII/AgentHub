import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";

const INITIAL_PATH_ENVIRONMENT_KEY = "AGENT_HUB_DIRECTORY_PICKER_INITIAL_PATH";
const PICKER_TIMEOUT_MS = 180_000;
const PICKER_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = 'Выберите рабочую директорию Agent Hub'
$dialog.ShowNewFolderButton = $true
$initialPath = [Environment]::GetEnvironmentVariable('${INITIAL_PATH_ENVIRONMENT_KEY}', 'Process')
if (-not [string]::IsNullOrWhiteSpace($initialPath) -and [System.IO.Directory]::Exists($initialPath)) {
  $dialog.SelectedPath = $initialPath
}
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}
`;

function executeFile(executable, args, options, execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function windowsPowerShell(environment) {
  const systemRoot = String(environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows").trim();
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function pickWindowsDirectory({
  initialPath = "",
  platform = process.platform,
  environment = process.env,
  execFileImpl = execFile,
} = {}) {
  if (platform !== "win32") {
    const error = new Error("Выбор каталога через Проводник доступен только в Agent Hub для Windows");
    error.code = "directory-picker-unavailable";
    throw error;
  }
  const normalizedInitialPath = String(initialPath ?? "").trim();
  if (normalizedInitialPath.length > 1_000) throw new Error("Путь к каталогу слишком длинный");
  const encodedScript = Buffer.from(PICKER_SCRIPT, "utf16le").toString("base64");
  let result;
  try {
    result = await executeFile(
      windowsPowerShell(environment),
      ["-NoLogo", "-NoProfile", "-STA", "-NonInteractive", "-EncodedCommand", encodedScript],
      {
        encoding: "utf8",
        env: { ...environment, [INITIAL_PATH_ENVIRONMENT_KEY]: normalizedInitialPath },
        maxBuffer: 64 * 1024,
        timeout: PICKER_TIMEOUT_MS,
        windowsHide: true,
      },
      execFileImpl,
    );
  } catch (error) {
    if (error?.killed || error?.code === "ETIMEDOUT") {
      throw new Error("Диалог выбора каталога не ответил вовремя");
    }
    throw new Error(`Не удалось открыть диалог выбора каталога: ${String(error?.message ?? error)}`);
  }
  const selectedPath = String(result.stdout ?? "").trim();
  if (!selectedPath) return { canceled: true, path: "" };
  if (selectedPath.includes("\0") || !path.win32.isAbsolute(selectedPath)) {
    throw new Error("Проводник вернул некорректный путь к каталогу");
  }
  return { canceled: false, path: selectedPath };
}

export const windowsDirectoryPickerInternals = Object.freeze({
  INITIAL_PATH_ENVIRONMENT_KEY,
  PICKER_TIMEOUT_MS,
});
