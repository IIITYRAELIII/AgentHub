import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";

import { defaultRuntimeRoot } from "./runtime-layout.mjs";
import { protectRuntimeConfig } from "./runtime-security.mjs";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function controlId(runtimeRoot) {
  return createHash("sha256")
    .update(path.resolve(runtimeRoot).toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

export function desktopControlEndpoint(runtimeRoot = defaultRuntimeRoot()) {
  const id = controlId(runtimeRoot);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\tyrael-integration-desktop-${id}`
    : path.join(runtimeRoot, `desktop-${id}.sock`);
}

export function desktopControlSecretFile(runtimeRoot = defaultRuntimeRoot()) {
  return path.join(runtimeRoot, "desktop-control.secret");
}

async function readOrCreateSecret(runtimeRoot, protectSecret = protectRuntimeConfig) {
  const file = desktopControlSecretFile(runtimeRoot);
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing.length >= 32) {
      await protectSecret(file);
      return existing;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const secret = randomBytes(32).toString("hex");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${secret}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
    .catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  await chmod(file, 0o600).catch(() => {});
  await protectSecret(file);
  return (await readFile(file, "utf8")).trim();
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateDesktopControlRequest(value, secret) {
  if (!value || typeof value !== "object" || !sameSecret(value.secret, secret)) {
    throw new Error("Desktop control authentication failed");
  }
  const action = String(value.action ?? "").trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(action)) throw new Error("Invalid desktop control action");
  const params = value.params == null ? {} : value.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Invalid desktop control parameters");
  }
  return { action, params };
}

export class DesktopControlServer {
  #runtimeRoot;
  #handler;
  #server = null;
  #secret = null;
  #protectSecret;

  constructor({ runtimeRoot = defaultRuntimeRoot(), handler, protectSecret = protectRuntimeConfig }) {
    this.#runtimeRoot = runtimeRoot;
    this.#handler = handler;
    this.#protectSecret = protectSecret;
  }

  async start() {
    if (this.#server) return;
    this.#secret = await readOrCreateSecret(this.#runtimeRoot, this.#protectSecret);
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let body = "";
      let handled = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        if (handled) return;
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
          handled = true;
          socket.end(`${JSON.stringify({ ok: false, error: "Desktop control request is too large" })}\n`);
          return;
        }
        const newline = body.indexOf("\n");
        if (newline < 0) return;
        handled = true;
        void (async () => {
          try {
            const request = validateDesktopControlRequest(JSON.parse(body.slice(0, newline)), this.#secret);
            const result = await this.#handler(request);
            const response = `${JSON.stringify({ ok: true, result: result ?? null })}\n`;
            if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
              throw new Error("Desktop control response is too large");
            }
            socket.end(response);
          } catch (error) {
            socket.end(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
          }
        })();
      });
      socket.on("error", () => {});
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(desktopControlEndpoint(this.#runtimeRoot), () => {
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

export async function callDesktopControl(action, params = {}, {
  runtimeRoot = defaultRuntimeRoot(),
  timeoutMs = 10_000,
} = {}) {
  const secret = (await readFile(desktopControlSecretFile(runtimeRoot), "utf8")).trim();
  const payload = `${JSON.stringify({ secret, action, params })}\n`;
  return new Promise((resolve, reject) => {
    const socket = createConnection(desktopControlEndpoint(runtimeRoot));
    let response = "";
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      operation(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Desktop control request timed out")), timeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        finish(reject, new Error("Desktop control response is too large"));
      }
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("close", () => {
      if (settled) return;
      try {
        const value = JSON.parse(response);
        if (!value.ok) finish(reject, new Error(value.error || "Desktop control request failed"));
        else finish(resolve, value.result);
      } catch (error) {
        finish(reject, new Error(`Invalid desktop control response: ${error.message}`));
      }
    });
  });
}
