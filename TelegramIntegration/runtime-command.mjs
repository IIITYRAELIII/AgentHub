import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import path from "node:path";

import { defaultRuntimeRoot } from "./runtime-layout.mjs";

const MAX_REQUEST_BYTES = 1024 * 1024;
const ALLOWED_COMMANDS = new Set(["send-message", "send-images"]);
const FORWARDED_ENVIRONMENT = [
  "CODEX_THREAD_ID",
  "CODEX_HOME",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDECODE",
  "CLAUDE_PROJECT_DIR",
  "AI_PROVIDER",
];

export function runtimeCommandEndpoint(runtimeRoot = defaultRuntimeRoot()) {
  const id = createHash("sha256").update(path.resolve(runtimeRoot).toLowerCase()).digest("hex").slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\telegram-integration-command-${id}`
    : path.join(runtimeRoot, `command-${id}.sock`);
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

  constructor({ runtimeRoot = defaultRuntimeRoot(), handler }) {
    this.#endpoint = runtimeCommandEndpoint(runtimeRoot);
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
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    if (!server?.listening) return;
    await new Promise((resolve) => server.close(resolve));
  }
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
  return new Promise((resolve, reject) => {
    const socket = createConnection(runtimeCommandEndpoint(runtimeRoot));
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TelegramIntegration runtime command timed out"));
    }, timeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!response) return;
      try {
        const value = JSON.parse(response);
        if (!value.ok) reject(new Error(value.error || "Runtime command failed"));
        else resolve(value.result);
      } catch (error) {
        reject(new Error(`Invalid runtime command response: ${error.message}`));
      }
    });
  });
}

export function runtimeCommandUnavailable(error) {
  return ["ENOENT", "ECONNREFUSED", "EPIPE"].includes(error?.code);
}
