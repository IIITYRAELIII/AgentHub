import { mkdir, open, readdir, unlink } from "node:fs/promises";
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
    killer.unref?.();
  });
}
