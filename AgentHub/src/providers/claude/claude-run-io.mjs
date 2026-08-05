import { mkdir, open, readFile, readlink, readdir, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// Claude Code запускается отдельным CLI-процессом и раньше отдавал stream-json
// в pipe: при перезапуске бота поток обрывался вместе с родителем и ход
// приходилось помечать прерванным. Теперь вывод пишется в файл хода, а бот
// читает его хвостом — это позволяет переподключиться к живому процессу после
// перезапуска так же, как Codex переподключается к своему App Server.

export function claudeRunDirectory(dataDir) {
  return path.join(String(dataDir ?? ""), "claude-runs");
}

export function claudeRunOutputPath(dataDir, turnId) {
  return path.join(claudeRunDirectory(dataDir), `${turnId}.jsonl`);
}

export function claudeRunErrorPath(dataDir, turnId) {
  return path.join(claudeRunDirectory(dataDir), `${turnId}.err.log`);
}

export async function openClaudeRunOutput(dataDir, turnId) {
  const outputPath = claudeRunOutputPath(dataDir, turnId);
  const errorPath = claudeRunErrorPath(dataDir, turnId);
  await mkdir(claudeRunDirectory(dataDir), { recursive: true });
  const [outputHandle, errorHandle] = await Promise.all([
    open(outputPath, "w"),
    open(errorPath, "w"),
  ]);
  return { outputPath, errorPath, outputHandle, errorHandle };
}

// Обработчики подписываются в том же тике, что и spawn. Ошибка запуска (нет CLI,
// нет прав) приходит следующим тиком, поэтому любой await между запуском и
// подпиской превращает её в uncaughtException и роняет весь бот.
export function spawnClaudeWorker({
  command,
  args = [],
  cwd,
  env,
  stdout = "ignore",
  stderr = "ignore",
  onError = () => {},
  onExit = () => {},
}) {
  const worker = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
    detached: true,
  });
  worker.on("error", onError);
  worker.on("exit", onExit);
  worker.unref();
  return worker;
}

export async function removeClaudeRunOutput({ outputPath, errorPath } = {}) {
  await Promise.all([outputPath, errorPath]
    .filter(Boolean)
    .map((file) => unlink(file).catch(() => {})));
}

export async function cleanupOrphanedClaudeRunOutputs(dataDir, activePaths = []) {
  const directory = claudeRunDirectory(dataDir);
  const normalize = (file) => {
    const resolved = path.resolve(String(file));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const normalizedActivePaths = new Set(activePaths
    .filter(Boolean)
    .map(normalize));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".err.log"))) continue;
    const file = path.join(directory, entry.name);
    if (normalizedActivePaths.has(normalize(file))) continue;
    try {
      await unlink(file);
      removed.push(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

// Читает дописанные строки файла хода, сохраняя незавершённый хвост до тех пор,
// пока CLI не допишет перевод строки.
export class ClaudeOutputReader {
  #path;
  #offset;
  #decoder = new StringDecoder("utf8");
  #trailingText = "";

  constructor(filePath, { offset = 0 } = {}) {
    this.#path = String(filePath ?? "");
    this.#offset = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;
  }

  get offset() {
    return this.#offset;
  }

  async read({ maximumBytes = 1024 * 1024 } = {}) {
    if (!this.#path) return [];
    let handle;
    try {
      handle = await open(this.#path, "r");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const lines = [];
    try {
      const info = await handle.stat();
      // Файл хода только дописывается; уменьшение размера означает пересоздание.
      if (info.size < this.#offset) {
        this.#offset = 0;
        this.#decoder = new StringDecoder("utf8");
        this.#trailingText = "";
      }
      while (this.#offset < info.size) {
        const length = Math.min(maximumBytes, info.size - this.#offset);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
        if (!bytesRead) break;
        this.#offset += bytesRead;
        this.#trailingText += this.#decoder.write(buffer.subarray(0, bytesRead));
        const parts = this.#trailingText.split(/\r?\n/);
        this.#trailingText = parts.pop() ?? "";
        for (const part of parts) {
          if (part.trim()) lines.push(part);
        }
      }
    } finally {
      await handle.close();
    }
    return lines;
  }
}

export function processIsAlive(pid, killImpl = process.kill) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    killImpl(value, 0);
    return true;
  } catch (error) {
    // EPERM означает чужой, но живой процесс.
    return error?.code === "EPERM";
  }
}

function normalizedFingerprintText(value, { lowerCase = false } = {}) {
  const normalized = String(value ?? "").replace(/\0/g, " ").replace(/\s+/g, " ").trim();
  return lowerCase ? normalized.toLowerCase() : normalized;
}

export function processFingerprintMatches(expected, actual, { platform = process.platform } = {}) {
  if (!expected || !actual) return false;
  const expectedPid = Number(expected.pid);
  const actualPid = Number(actual.pid);
  if (!Number.isInteger(expectedPid) || expectedPid <= 0 || expectedPid !== actualPid) return false;
  const expectedCreation = normalizedFingerprintText(expected.creationTime);
  const actualCreation = normalizedFingerprintText(actual.creationTime);
  if (!expectedCreation || !actualCreation || expectedCreation !== actualCreation) return false;
  const lowerCasePaths = platform === "win32";
  for (const field of ["executablePath", "commandLine"]) {
    const expectedValue = normalizedFingerprintText(expected[field], {
      lowerCase: field === "executablePath" && lowerCasePaths,
    });
    if (!expectedValue) continue;
    const actualValue = normalizedFingerprintText(actual[field], {
      lowerCase: field === "executablePath" && lowerCasePaths,
    });
    if (!actualValue || actualValue !== expectedValue) return false;
  }
  return true;
}

function captureCommand(command, args, {
  spawnImpl = spawn,
  timeoutMs = 3_000,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let output = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill?.();
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1_000_000) {
        child.kill?.();
        finish(null);
      }
    });
    child.once("error", () => finish(null));
    child.once("exit", (code) => finish(code === 0 ? output : null));
  });
}

async function readWindowsProcessFingerprint(pid, options) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if ($null -eq $p) { exit 3 }",
    "[pscustomobject]@{pid=[int]$p.ProcessId;creationTime=$p.CreationDate.ToUniversalTime().ToString('O');executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine}|ConvertTo-Json -Compress",
  ].join(";");
  const output = await (options.captureCommandImpl ?? captureCommand)(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    options,
  );
  if (!output) return null;
  try {
    const value = JSON.parse(output);
    return {
      pid: Number(value.pid),
      creationTime: normalizedFingerprintText(value.creationTime),
      executablePath: normalizedFingerprintText(value.executablePath),
      commandLine: normalizedFingerprintText(value.commandLine),
    };
  } catch {
    return null;
  }
}

async function readLinuxProcessFingerprint(pid, {
  readFileImpl = readFile,
  readlinkImpl = readlink,
} = {}) {
  try {
    const statText = await readFileImpl(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = statText.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    const fieldsAfterName = statText.slice(closingParenthesis + 1).trim().split(/\s+/);
    const startTicks = normalizedFingerprintText(fieldsAfterName[19]);
    if (!startTicks) return null;
    const [bootId, executablePath, commandLine] = await Promise.all([
      readFileImpl("/proc/sys/kernel/random/boot_id", "utf8").catch(() => ""),
      readlinkImpl(`/proc/${pid}/exe`).catch(() => ""),
      readFileImpl(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
    ]);
    return {
      pid,
      creationTime: `linux:${normalizedFingerprintText(bootId)}:${startTicks}`,
      executablePath: normalizedFingerprintText(executablePath),
      commandLine: normalizedFingerprintText(commandLine),
    };
  } catch {
    return null;
  }
}

async function readDarwinProcessFingerprint(pid, options) {
  const run = options.captureCommandImpl ?? captureCommand;
  const [creationTime, executablePath, commandLine] = await Promise.all([
    run("ps", ["-p", String(pid), "-o", "lstart="], options),
    run("ps", ["-p", String(pid), "-o", "comm="], options),
    run("ps", ["-p", String(pid), "-o", "command="], options),
  ]);
  const normalizedCreation = normalizedFingerprintText(creationTime);
  if (!normalizedCreation) return null;
  return {
    pid,
    creationTime: normalizedCreation,
    executablePath: normalizedFingerprintText(executablePath),
    commandLine: normalizedFingerprintText(commandLine),
  };
}

export async function readProcessFingerprint(pid, {
  platform = process.platform,
  ...options
} = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return null;
  if (platform === "win32") return readWindowsProcessFingerprint(value, options);
  if (platform === "linux") return readLinuxProcessFingerprint(value, options);
  if (platform === "darwin") return readDarwinProcessFingerprint(value, options);
  return null;
}

export async function stopProcessTree(pid, {
  platform = process.platform,
  spawnImpl = spawn,
  killImpl = process.kill,
} = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (platform !== "win32") {
    try {
      // Detached Claude является лидером своей группы процессов.
      killImpl(-value, "SIGTERM");
      return true;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (valueToReturn) => {
      if (settled) return;
      settled = true;
      resolve(valueToReturn);
    };
    const fallback = () => {
      try {
        killImpl(value, "SIGTERM");
        finish(true);
      } catch (error) {
        finish(error?.code === "ESRCH");
      }
    };
    let killer;
    try {
      killer = spawnImpl("taskkill.exe", ["/PID", String(value), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      fallback();
      return;
    }
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code === 0 || !processIsAlive(value, killImpl)) finish(true);
      else fallback();
    });
  });
}
