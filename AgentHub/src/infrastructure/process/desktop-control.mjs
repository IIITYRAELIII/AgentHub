import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";

import { defaultRuntimeRoot } from "../filesystem/runtime-layout.mjs";
import { protectRuntimeConfig } from "../filesystem/runtime-security.mjs";

const PROTOCOL_VERSION = 2;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_WIRE_REQUEST_BYTES = 768 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CLIENT_RECONNECT_DELAYS_MS = Object.freeze([80, 220, 500]);
const TRANSIENT_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "EPIPE",
]);
const ENDPOINT_ID_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[a-f0-9]{64}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function desktopControlSecretFile(runtimeRoot = defaultRuntimeRoot()) {
  return path.join(runtimeRoot, "desktop-control.secret");
}

export function desktopControlEndpointFile(runtimeRoot = defaultRuntimeRoot()) {
  return path.join(runtimeRoot, "desktop-control.endpoint.json");
}

function endpointPipeName(endpointId) {
  return `agent-hub-desktop-${endpointId}`;
}

function createEndpointDescriptor() {
  const endpointId = randomBytes(32).toString("hex");
  return {
    protocol: PROTOCOL_VERSION,
    endpointId,
    pipeName: endpointPipeName(endpointId),
  };
}

export function validateDesktopControlEndpoint(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Desktop control endpoint");
  }
  const protocol = Number(value.protocol);
  const endpointId = String(value.endpointId ?? "").trim().toLowerCase();
  const pipeName = String(value.pipeName ?? "").trim();
  if (protocol !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported Desktop control protocol: ${protocol || "unknown"}`);
  }
  if (!ENDPOINT_ID_PATTERN.test(endpointId) || pipeName !== endpointPipeName(endpointId)) {
    throw new Error("Invalid Desktop control endpoint");
  }
  return { protocol, endpointId, pipeName };
}

export function desktopControlEndpoint(runtimeRoot, descriptor) {
  const endpoint = validateDesktopControlEndpoint(descriptor);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${endpoint.pipeName}`
    : path.join(runtimeRoot, `desktop-${endpoint.endpointId.slice(0, 24)}.sock`);
}

export async function readDesktopControlEndpoint(runtimeRoot = defaultRuntimeRoot()) {
  const raw = await readFile(desktopControlEndpointFile(runtimeRoot), "utf8");
  return validateDesktopControlEndpoint(JSON.parse(raw));
}

async function publishEndpoint(runtimeRoot, descriptor, protectFile) {
  const file = desktopControlEndpointFile(runtimeRoot);
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600).catch(() => {});
    await protectFile(temporary);
    for (const delayMs of [0, 10, 25, 50, 100, 200, 400]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await rename(temporary, file);
        break;
      } catch (error) {
        const retryable = ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
        if (!retryable || delayMs === 400) throw error;
      }
    }
    await protectFile(file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function removePublishedEndpoint(runtimeRoot, descriptor) {
  const file = desktopControlEndpointFile(runtimeRoot);
  try {
    const current = await readDesktopControlEndpoint(runtimeRoot);
    if (current.endpointId === descriptor?.endpointId) {
      await rm(file, { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // A malformed or concurrently replaced descriptor must not be deleted.
    }
  }
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

function sameValue(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function hmac(secret, value) {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(value, "utf8")
    .digest("hex");
}

function payloadDigest(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function serverProofValue({ endpointId, clientNonce, challenge }) {
  return [
    "agent-hub-desktop/server/v2",
    endpointId,
    clientNonce,
    challenge,
  ].join("\n");
}

function clientProofValue({
  endpointId,
  clientNonce,
  challenge,
  digest,
}) {
  return [
    "agent-hub-desktop/client/v2",
    endpointId,
    clientNonce,
    challenge,
    digest,
  ].join("\n");
}

export function validateDesktopControlRequest(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Desktop control request");
  }
  const action = String(value.action ?? "").trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(action)) throw new Error("Invalid desktop control action");
  const params = value.params == null ? {} : value.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Invalid desktop control parameters");
  }
  const commandId = String(value.commandId ?? "").trim();
  if (commandId && !COMMAND_ID_PATTERN.test(commandId)) {
    throw new Error("Invalid desktop control command id");
  }
  return { action, params, ...(commandId ? { commandId } : {}) };
}

function parseProtocolLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Invalid Desktop control protocol message");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Desktop control protocol message");
  }
  return value;
}

function protocolError(socket, error) {
  if (socket.destroyed) return;
  const message = String(error?.message ?? error ?? "Desktop control protocol failed");
  socket.end(`${JSON.stringify({ ok: false, error: message })}\n`);
}

export class DesktopControlServer {
  #runtimeRoot;
  #handler;
  #reportUnexpectedError;
  #onResultDelivered;
  #server = null;
  #secret = null;
  #descriptor = null;
  #protectSecret;
  #sockets = new Set();

  constructor({
    runtimeRoot = defaultRuntimeRoot(),
    handler,
    onResultDelivered = null,
    protectSecret = protectRuntimeConfig,
    reportUnexpectedError = null,
  }) {
    this.#runtimeRoot = runtimeRoot;
    this.#handler = handler;
    this.#onResultDelivered = typeof onResultDelivered === "function" ? onResultDelivered : null;
    this.#protectSecret = protectSecret;
    this.#reportUnexpectedError = typeof reportUnexpectedError === "function" ? reportUnexpectedError : null;
  }

  async start() {
    if (this.#server) return;
    this.#secret = await readOrCreateSecret(this.#runtimeRoot, this.#protectSecret);
    const descriptor = createEndpointDescriptor();
    const server = createServer({ allowHalfOpen: false }, (socket) => {
      const transportReceivedAtMs = Date.now();
      let body = "";
      let state = "hello";
      let processing = false;
      let clientNonce = "";
      let challenge = "";
      let handledCommandId = "";
      this.#sockets.add(socket);
      socket.setEncoding("utf8");
      socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
        protocolError(socket, new Error("Desktop control handshake timed out"));
      });

      const processNextLine = () => {
        if (processing || socket.destroyed) return;
        const newline = body.indexOf("\n");
        if (newline < 0) return;
        const line = body.slice(0, newline);
        body = body.slice(newline + 1);
        processing = true;
        void (async () => {
          try {
            const message = parseProtocolLine(line);
            if (state === "hello") {
              if (message.type !== "hello" || Number(message.protocol) !== PROTOCOL_VERSION) {
                throw new Error("Desktop control handshake required");
              }
              clientNonce = String(message.clientNonce ?? "").trim().toLowerCase();
              if (!NONCE_PATTERN.test(clientNonce)) throw new Error("Invalid Desktop client nonce");
              challenge = randomBytes(32).toString("hex");
              const serverProof = hmac(this.#secret, serverProofValue({
                endpointId: descriptor.endpointId,
                clientNonce,
                challenge,
              }));
              state = "request";
              socket.write(`${JSON.stringify({
                type: "challenge",
                protocol: PROTOCOL_VERSION,
                endpointId: descriptor.endpointId,
                challenge,
                serverProof,
              })}\n`);
              return;
            }
            if (state === "result") {
              const acknowledgedId = String(message.commandId ?? "").trim();
              if (message.type !== "result-ack" || acknowledgedId !== handledCommandId) {
                throw new Error("Invalid Desktop control result acknowledgement");
              }
              let retired = false;
              try {
                retired = await this.#onResultDelivered({ id: handledCommandId }) === true;
              } catch {
                retired = false;
              }
              state = "handled";
              socket.setTimeout(0);
              socket.end(`${JSON.stringify({
                type: "result-retired",
                commandId: handledCommandId,
                retired,
              })}\n`);
              return;
            }
            if (state !== "request" || message.type !== "request") {
              throw new Error("Invalid Desktop control protocol state");
            }
            state = "handled";
            const requestClientNonce = String(message.clientNonce ?? "").trim().toLowerCase();
            const requestChallenge = String(message.challenge ?? "").trim().toLowerCase();
            const encodedPayload = String(message.payload ?? "");
            const proof = String(message.proof ?? "").trim().toLowerCase();
            if (!sameValue(requestClientNonce, clientNonce)
              || !sameValue(requestChallenge, challenge)
              || !NONCE_PATTERN.test(requestClientNonce)
              || !NONCE_PATTERN.test(requestChallenge)) {
              throw new Error("Desktop control challenge mismatch");
            }
            if (!encodedPayload || !BASE64_PATTERN.test(encodedPayload)) {
              throw new Error("Invalid Desktop control payload");
            }
            const payload = Buffer.from(encodedPayload, "base64");
            if (payload.length === 0 || payload.length > MAX_REQUEST_BYTES) {
              throw new Error("Desktop control request is too large");
            }
            const digest = payloadDigest(payload);
            const expectedProof = hmac(this.#secret, clientProofValue({
              endpointId: descriptor.endpointId,
              clientNonce,
              challenge,
              digest,
            }));
            if (!sameValue(proof, expectedProof)) {
              throw new Error("Desktop control client authentication failed");
            }
            const request = validateDesktopControlRequest(parseProtocolLine(payload.toString("utf8")));
            handledCommandId = request.commandId ?? "";
            socket.setTimeout(0);
            const result = await this.#handler({
              ...request,
              context: {
                ...(request.context ?? {}),
                source: request.context?.source ?? "desktop-control",
                commandId: request.commandId ?? null,
                transportReceivedAtMs,
              },
            });
            const acknowledgementRequired = Boolean(handledCommandId && this.#onResultDelivered);
            const response = `${JSON.stringify({
              ok: true,
              result: result ?? null,
              ...(acknowledgementRequired ? {
                ackRequired: true,
                commandId: handledCommandId,
              } : {}),
            })}\n`;
            if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
              throw new Error("Desktop control response is too large");
            }
            if (acknowledgementRequired) {
              state = "result";
              socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
              socket.write(response);
            } else {
              socket.end(response);
            }
          } catch (error) {
            state = "handled";
            try {
              this.#reportUnexpectedError?.(error, {
                surface: "desktop-control",
                kind: "control",
                component: "desktop-control-server",
                action: "request",
              });
            } catch {}
            protocolError(socket, error);
          } finally {
            processing = false;
            if (state !== "handled") processNextLine();
          }
        })();
      };

      socket.on("data", (chunk) => {
        if (state === "handled") return;
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_WIRE_REQUEST_BYTES) {
          state = "handled";
          protocolError(socket, new Error("Desktop control request is too large"));
          return;
        }
        processNextLine();
      });
      socket.on("error", () => {});
      socket.once("close", () => this.#sockets.delete(socket));
    });
    const endpoint = desktopControlEndpoint(this.#runtimeRoot, descriptor);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({
          path: endpoint,
          exclusive: true,
          readableAll: false,
          writableAll: false,
        }, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await publishEndpoint(this.#runtimeRoot, descriptor, this.#protectSecret);
    } catch (error) {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      throw error;
    }
    this.#descriptor = descriptor;
    this.#server = server;
  }

  async close() {
    const server = this.#server;
    const descriptor = this.#descriptor;
    this.#server = null;
    this.#descriptor = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await removePublishedEndpoint(this.#runtimeRoot, descriptor);
  }
}

async function callDesktopControlOnce(action, params, {
  runtimeRoot,
  timeoutMs,
  commandId,
}) {
  const [secret, descriptor] = await Promise.all([
    readFile(desktopControlSecretFile(runtimeRoot), "utf8").then((value) => value.trim()),
    readDesktopControlEndpoint(runtimeRoot),
  ]);
  const requestPayload = Buffer.from(JSON.stringify(validateDesktopControlRequest({
    action,
    params,
    commandId,
  })), "utf8");
  if (requestPayload.length > MAX_REQUEST_BYTES) {
    throw new Error("Desktop control request is too large");
  }
  const clientNonce = randomBytes(32).toString("hex");
  return new Promise((resolve, reject) => {
    const socket = createConnection(desktopControlEndpoint(runtimeRoot, descriptor));
    let response = "";
    let settled = false;
    let state = "challenge";
    let deliveredResult;
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
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        clientNonce,
      })}\n`);
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        finish(reject, new Error("Desktop control response is too large"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      const line = response.slice(0, newline);
      response = response.slice(newline + 1);
      try {
        const value = parseProtocolLine(line);
        if (state === "challenge") {
          if (value.type !== "challenge"
            || Number(value.protocol) !== PROTOCOL_VERSION
            || String(value.endpointId ?? "") !== descriptor.endpointId) {
            throw new Error("Desktop control server authentication failed");
          }
          const challenge = String(value.challenge ?? "").trim().toLowerCase();
          const proof = String(value.serverProof ?? "").trim().toLowerCase();
          if (!NONCE_PATTERN.test(challenge)) {
            throw new Error("Desktop control server authentication failed");
          }
          const expected = hmac(secret, serverProofValue({
            endpointId: descriptor.endpointId,
            clientNonce,
            challenge,
          }));
          if (!sameValue(proof, expected)) {
            throw new Error("Desktop control server authentication failed");
          }
          const digest = payloadDigest(requestPayload);
          state = "response";
          socket.write(`${JSON.stringify({
            type: "request",
            clientNonce,
            challenge,
            payload: requestPayload.toString("base64"),
            proof: hmac(secret, clientProofValue({
              endpointId: descriptor.endpointId,
              clientNonce,
              challenge,
              digest,
            })),
          })}\n`);
          return;
        }
        if (state === "retirement") {
          if (value.type !== "result-retired" || String(value.commandId ?? "") !== commandId) {
            throw new Error("Invalid Desktop control result retirement confirmation");
          }
          finish(resolve, deliveredResult);
          return;
        }
        if (state !== "response") {
          throw new Error("Invalid Desktop control response state");
        }
        if (!value.ok) finish(reject, Object.assign(
          new Error(value.error || "Desktop control request failed"),
          { desktopControlRejected: true },
        ));
        else if (value.ackRequired === true && String(value.commandId ?? "") === commandId) {
          deliveredResult = value.result;
          state = "retirement";
          socket.write(`${JSON.stringify({ type: "result-ack", commandId })}\n`, () => {
            finish(resolve, deliveredResult);
          });
        } else finish(resolve, value.result);
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.on("error", (error) => {
      if (state === "retirement") {
        finish(resolve, deliveredResult);
        return;
      }
      if (error && typeof error === "object") {
        Object.defineProperty(error, "desktopControlRequestMayHaveReachedServer", {
          configurable: true,
          enumerable: false,
          value: state === "response",
        });
      }
      finish(reject, error);
    });
    socket.on("close", () => {
      if (settled) return;
      if (state === "retirement") {
        finish(resolve, deliveredResult);
        return;
      }
      const error = new Error("Desktop control connection closed without a response");
      error.code = "ECONNRESET";
      Object.defineProperty(error, "desktopControlRequestMayHaveReachedServer", {
        configurable: true,
        enumerable: false,
        value: state === "response",
      });
      finish(reject, error);
    });
  });
}

function canReconnectDesktopControl(error) {
  if (error?.desktopControlRequestMayHaveReachedServer === true) return false;
  return TRANSIENT_CONNECT_CODES.has(String(error?.code ?? "").toUpperCase());
}

function reconnectDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function callDesktopControl(action, params = {}, {
  runtimeRoot = defaultRuntimeRoot(),
  timeoutMs = 10_000,
  commandId = randomUUID(),
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callDesktopControlOnce(action, params, { runtimeRoot, timeoutMs, commandId });
    } catch (error) {
      const delayMs = CLIENT_RECONNECT_DELAYS_MS[attempt];
      if (delayMs == null || !canReconnectDesktopControl(error)) throw error;
      await reconnectDelay(delayMs);
    }
  }
}
