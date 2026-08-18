import { createHash, randomUUID } from "node:crypto";
import { connect, createServer } from "node:net";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processIsAlive } from "./process-liveness.mjs";

function pipeName(dataDir) {
  const id = createHash("sha256").update(path.resolve(dataDir).toLowerCase()).digest("hex").slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\agent-hub-${id}`;
  if (process.platform === "linux") return `\0agent-hub-${id}`;
  return path.join(os.tmpdir(), `agent-hub-${id}.sock`);
}

function isFilesystemSocket(endpoint) {
  return !endpoint.startsWith("\0") && !endpoint.startsWith("\\\\.\\pipe\\");
}

function socketHasOwner(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (["ECONNREFUSED", "ENOENT"].includes(error?.code)) resolve(false);
      else reject(error);
    });
  });
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(endpoint);
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function parseLock(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (Number.isSafeInteger(value)) return { pid: value, legacy: true };
    if (Number.isSafeInteger(value?.pid) && typeof value?.instanceToken === "string") return value;
  } catch {
    const pid = Number.parseInt(text, 10);
    if (Number.isSafeInteger(pid)) return { pid, legacy: true };
  }
  return null;
}

export class SingleInstanceGuard {
  #dataDir;
  #lockFile;
  #isAlive;
  #releaseId;
  #server = null;
  #handle = null;
  #token = randomUUID();
  #startedAt = new Date().toISOString();

  constructor({
    dataDir,
    lockFile = path.join(dataDir, "bot.lock"),
    isAlive = processIsAlive,
    releaseId = process.env.AGENT_HUB_RELEASE_ID,
  }) {
    this.#dataDir = dataDir;
    this.#lockFile = lockFile;
    this.#isAlive = isAlive;
    this.#releaseId = String(releaseId ?? "").trim() || null;
  }

  get instanceToken() {
    return this.#token;
  }

  async acquire() {
    await mkdir(this.#dataDir, { recursive: true });
    const endpoint = pipeName(this.#dataDir);
    const server = createServer((socket) => socket.end(this.#token));
    try {
      await listen(server, endpoint);
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        if (!isFilesystemSocket(endpoint) || await socketHasOwner(endpoint)) {
          server.close();
          throw new Error("Telegram bot is already running for this data directory");
        }
        await unlink(endpoint).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
        await listen(server, endpoint);
      } else {
        server.close();
        throw error;
      }
    }
    this.#server = server;

    try {
      const existing = parseLock(await readFile(this.#lockFile, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      }));
      // Старый бот не держит системный канал. Его числовой lock нельзя отбирать,
      // пока PID жив: это обеспечивает безопасное обновление со старой версии.
      if (existing?.legacy && this.#isAlive(existing.pid)) {
        throw new Error(`Telegram bot is already running (PID ${existing.pid})`);
      }
      // Для нового формата свободный системный канал является источником истины:
      // даже переиспользованный системой PID не превращает аварийный lock в вечный.
      await unlink(this.#lockFile).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      this.#handle = await open(this.#lockFile, "wx");
      await this.#writeLock(false);
      return this;
    } catch (error) {
      await close(this.#server);
      this.#server = null;
      throw error;
    }
  }

  async #writeLock(ready) {
    if (!this.#handle) throw new Error("Telegram bot instance lock is not acquired");
    const value = `${JSON.stringify({
        pid: process.pid,
        instanceToken: this.#token,
        startedAt: this.#startedAt,
        endpoint: pipeName(this.#dataDir),
        releaseId: this.#releaseId,
        ready,
      })}\n`;
    await this.#handle.truncate(0);
    await this.#handle.write(value, 0, "utf8");
    await this.#handle.sync();
  }

  async markReady() {
    await this.#writeLock(true);
    return this;
  }

  async release() {
    await this.#handle?.close().catch(() => {});
    this.#handle = null;
    const current = parseLock(await readFile(this.#lockFile, "utf8").catch(() => ""));
    if (current?.instanceToken === this.#token) await unlink(this.#lockFile).catch(() => {});
    await close(this.#server);
    this.#server = null;
    const endpoint = pipeName(this.#dataDir);
    if (isFilesystemSocket(endpoint)) await unlink(endpoint).catch(() => {});
  }
}
