import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { defaultRuntimeRoot } from "./runtime-layout.mjs";
import { writeTextAtomic } from "./state-store.mjs";

const MAX_REQUEST_BYTES = 1024 * 1024;
const ALLOWED_COMMANDS = new Set([
  "send-message",
  "send-images",
  "turn-complete",
  "turn-end-message",
]);
const FORWARDED_ENVIRONMENT = [
  "CODEX_THREAD_ID",
  "CODEX_HOME",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDECODE",
  "CLAUDE_PROJECT_DIR",
  "AI_PROVIDER",
];
const SPOOL_POLL_MS = 100;
const SPOOL_RETENTION_MS = 24 * 60 * 60 * 1000;

function runtimeCommandId(runtimeRoot) {
  return createHash("sha256").update(path.resolve(runtimeRoot).toLowerCase()).digest("hex").slice(0, 24);
}

export function runtimeCommandEndpoint(runtimeRoot = defaultRuntimeRoot()) {
  const id = runtimeCommandId(runtimeRoot);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\telegram-integration-command-${id}`
    : path.join(runtimeRoot, `command-${id}.sock`);
}

export function runtimeCommandSpoolDirectory(
  runtimeRoot = defaultRuntimeRoot(),
  temporaryRoot = os.tmpdir(),
) {
  return path.join(temporaryRoot, `telegram-integration-command-${runtimeCommandId(runtimeRoot)}`);
}

export function runtimeCommandEnvironment(environment = process.env) {
  return Object.fromEntries(FORWARDED_ENVIRONMENT
    .filter((name) => typeof environment[name] === "string" && environment[name].length <= 32_768)
    .map((name) => [name, environment[name]]));
}

export function validateRuntimeCommand(value) {
  if (!value || typeof value !== "object" || !ALLOWED_COMMANDS.has(value.command)) {
    throw new Error("Unsupported runtime command");
  }
  if (!Array.isArray(value.args)
    || value.args.length > 256
    || value.args.some((item) => typeof item !== "string" || item.length > 100_000)) {
    throw new Error("Invalid runtime command arguments");
  }
  const cwd = String(value.cwd ?? "").trim();
  if (!cwd || cwd.length > 32_768) throw new Error("Invalid runtime command working directory");
  const environment = value.environment && typeof value.environment === "object"
    ? Object.fromEntries(Object.entries(value.environment)
      .filter(([name, item]) => FORWARDED_ENVIRONMENT.includes(name) && typeof item === "string"))
    : {};
  return { id: String(value.id ?? randomUUID()), command: value.command, args: value.args, cwd, environment };
}

export class RuntimeCommandServer {
  #endpoint;
  #handler;
  #server = null;
  #spoolDirectory;
  #spoolTimer = null;
  #spoolDrain = null;

  constructor({ runtimeRoot = defaultRuntimeRoot(), handler, temporaryRoot = os.tmpdir() }) {
    this.#endpoint = runtimeCommandEndpoint(runtimeRoot);
    this.#spoolDirectory = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
    this.#handler = handler;
  }

  async start() {
    if (this.#server) return;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let body = "";
      let handled = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        if (handled) return;
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) socket.destroy();
        const newline = body.indexOf("\n");
        if (newline >= 0) {
          handled = true;
          const requestBody = body.slice(0, newline);
          void (async () => {
            try {
              const request = validateRuntimeCommand(JSON.parse(requestBody));
              const result = await this.#handler(request);
              socket.end(`${JSON.stringify({ ok: true, result: String(result ?? "") })}\n`);
            } catch (error) {
              socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
            }
          })();
        }
      });
      socket.on("error", () => {});
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
    await mkdir(this.#spoolDirectory, { recursive: true });
    this.#scheduleSpoolDrain(0);
  }

  #scheduleSpoolDrain(delayMs = SPOOL_POLL_MS) {
    if (!this.#server || this.#spoolTimer) return;
    this.#spoolTimer = setTimeout(() => {
      this.#spoolTimer = null;
      this.#spoolDrain = this.#drainSpool()
        .catch((error) => console.error("Cannot process runtime command spool:", error.message))
        .finally(() => {
          this.#spoolDrain = null;
          this.#scheduleSpoolDrain();
        });
    }, delayMs);
    this.#spoolTimer.unref?.();
  }

  async #drainSpool() {
    const allNames = await readdir(this.#spoolDirectory);
    for (const name of allNames.filter((item) => item.endsWith(".response.json"))) {
      const filePath = path.join(this.#spoolDirectory, name);
      const info = await stat(filePath).catch(() => null);
      if (info && Date.now() - info.mtimeMs >= SPOOL_RETENTION_MS) await unlink(filePath).catch(() => {});
    }
    const names = allNames
      .filter((name) => name.endsWith(".request.json"))
      .sort();
    for (const name of names) {
      const requestPath = path.join(this.#spoolDirectory, name);
      const responsePath = requestPath.replace(/\.request\.json$/, ".response.json");
      let response;
      try {
        if ((await stat(requestPath)).size > MAX_REQUEST_BYTES) throw new Error("Runtime command is too large");
        const request = validateRuntimeCommand(JSON.parse(await readFile(requestPath, "utf8")));
        const result = await this.#handler(request);
        response = { ok: true, result: String(result ?? "") };
      } catch (error) {
        response = { ok: false, error: String(error?.message ?? error) };
      }
      await writeTextAtomic(responsePath, `${JSON.stringify(response)}\n`);
      await unlink(requestPath).catch(() => {});
    }
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    if (this.#spoolTimer) clearTimeout(this.#spoolTimer);
    this.#spoolTimer = null;
    await this.#spoolDrain;
    if (!server?.listening) return;
    await new Promise((resolve) => server.close(resolve));
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function forwardRuntimeCommandThroughSpool(command, args, {
  runtimeRoot = defaultRuntimeRoot(),
  temporaryRoot = os.tmpdir(),
  cwd = process.cwd(),
  environment = process.env,
  timeoutMs = 120_000,
} = {}) {
  const request = validateRuntimeCommand({
    id: randomUUID(),
    command,
    args,
    cwd,
    environment: runtimeCommandEnvironment(environment),
  });
  const spoolDirectory = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
  await mkdir(spoolDirectory, { recursive: true });
  const requestPath = path.join(spoolDirectory, `${request.id}.request.json`);
  const responsePath = path.join(spoolDirectory, `${request.id}.response.json`);
  await writeTextAtomic(requestPath, `${JSON.stringify(request)}\n`);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(await readFile(responsePath, "utf8"));
        if (!response.ok) throw new Error(response.error || "Runtime command failed");
        return response.result;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await delay(SPOOL_POLL_MS);
    }
    throw new Error("TelegramIntegration runtime command spool timed out");
  } finally {
    await Promise.all([unlink(requestPath).catch(() => {}), unlink(responsePath).catch(() => {})]);
  }
}

export async function enqueueRuntimeCommandThroughSpool(command, args, {
  runtimeRoot = defaultRuntimeRoot(),
  temporaryRoot = os.tmpdir(),
  cwd = process.cwd(),
  environment = process.env,
} = {}) {
  const request = validateRuntimeCommand({
    id: randomUUID(),
    command,
    args,
    cwd,
    environment: runtimeCommandEnvironment(environment),
  });
  const spoolDirectory = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
  await mkdir(spoolDirectory, { recursive: true });
  const requestPath = path.join(spoolDirectory, `${request.id}.request.json`);
  await writeTextAtomic(requestPath, `${JSON.stringify(request)}\n`);
  return request.id;
}

export async function forwardRuntimeCommand(command, args, {
  runtimeRoot = defaultRuntimeRoot(),
  cwd = process.cwd(),
  environment = process.env,
  timeoutMs = 120_000,
} = {}) {
  const payload = JSON.stringify(validateRuntimeCommand({
    id: randomUUID(),
    command,
    args,
    cwd,
    environment: runtimeCommandEnvironment(environment),
  }));
  try {
    return await new Promise((resolve, reject) => {
    const socket = createConnection(runtimeCommandEndpoint(runtimeRoot));
    let response = "";
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(reject, new Error("TelegramIntegration runtime command timed out"));
    }, timeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", (error) => {
      finish(reject, error);
    });
    socket.on("close", () => {
      if (!response) {
        finish(reject, new Error("TelegramIntegration runtime command closed without a response"));
        return;
      }
      try {
        const value = JSON.parse(response);
        if (!value.ok) finish(reject, new Error(value.error || "Runtime command failed"));
        else finish(resolve, value.result);
      } catch (error) {
        finish(reject, new Error(`Invalid runtime command response: ${error.message}`));
      }
    });
    });
  } catch (error) {
    // Some Codex sandboxes deny named-pipe connections even though a narrow,
    // validated local notification request is allowed. Use a token-free file
    // spool only for that access failure; a missing bot keeps the old fallback.
    if (!["EACCES", "EPERM"].includes(error?.code)) throw error;
    return forwardRuntimeCommandThroughSpool(command, args, {
      runtimeRoot,
      cwd,
      environment,
      timeoutMs,
    });
  }
}

export function runtimeCommandUnavailable(error) {
  return ["ENOENT", "ECONNREFUSED", "EPIPE"].includes(error?.code);
}
