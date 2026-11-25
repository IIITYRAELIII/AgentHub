import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";

import {
  runtimeCommandId,
  runtimeCommandRoot,
  runtimeCommandSpoolDirectory,
} from "../../../codex-stop-hook-launcher.mjs";
import { writeTextAtomic } from "../persistence/state-store.mjs";
import {
  DurableCommandReceipts,
  DurableCommandRetryableError,
  commandFingerprint,
} from "../persistence/durable-command-receipts.mjs";

const MAX_REQUEST_BYTES = 1024 * 1024;
const ALLOWED_COMMANDS = new Set([
  "send-message",
  "send-images",
  "turn-start",
  "turn-complete",
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
const REQUEST_TIMEOUT_MS = 15_000;
const SOCKET_PROBE_TIMEOUT_MS = 1_000;

function probeUnixSocket(endpoint) {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.once("connect", () => finish("live"));
    socket.once("error", (error) => finish(error?.code === "ECONNREFUSED" ? "stale" : "unknown"));
    socket.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => finish("unknown"));
  });
}

async function removeStaleUnixSocket(endpoint) {
  if (process.platform === "win32") return false;
  const before = await lstat(endpoint).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!before?.isSocket() || await probeUnixSocket(endpoint) !== "stale") return false;
  const after = await lstat(endpoint).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!after?.isSocket() || after.dev !== before.dev || after.ino !== before.ino) return false;
  await unlink(endpoint);
  return true;
}

export function runtimeCommandEndpoint(runtimeRoot = runtimeCommandRoot()) {
  const id = runtimeCommandId(runtimeRoot);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\agent-hub-command-${id}`
    : path.join(runtimeRoot, `command-${id}.sock`);
}

export { runtimeCommandSpoolDirectory };

export const RUNTIME_COMMAND_RECEIPT_LAYOUT = "runtime-data-v1";

export function runtimeCommandReceiptFile(runtimeRoot) {
  return path.join(path.dirname(runtimeCommandSpoolDirectory(runtimeRoot)), "runtime-command-receipts.json");
}

async function readSpoolDirectory(directory) {
  return readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
}

async function removeSpoolFile(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
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
  #authorize;
  #server = null;
  #spoolDirectory;
  #legacySpoolDirectory;
  #spoolTimer = null;
  #spoolDrain = null;
  #sockets = new Set();
  #spoolReceipts;
  #legacyReceipts;
  #reconcile;
  #captureException;
  #captureUnexpectedException;

  constructor({
    runtimeRoot = runtimeCommandRoot(),
    handler,
    authorize = async (request) => request,
    reconcile = null,
    temporaryRoot,
    legacyTemporaryRoot,
    captureException = () => false,
    captureUnexpectedException = () => false,
  }) {
    this.#endpoint = runtimeCommandEndpoint(runtimeRoot);
    this.#spoolDirectory = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
    const legacy = legacyTemporaryRoot && runtimeCommandSpoolDirectory(runtimeRoot, legacyTemporaryRoot);
    this.#legacySpoolDirectory = legacy && legacy !== this.#spoolDirectory ? legacy : null;
    this.#handler = handler;
    this.#authorize = authorize;
    this.#reconcile = typeof reconcile === "function" ? reconcile : null;
    this.#captureException = captureException;
    this.#captureUnexpectedException = captureUnexpectedException;
    const receiptFile = temporaryRoot
      ? path.join(this.#spoolDirectory, "receipts.json")
      : runtimeCommandReceiptFile(runtimeRoot);
    this.#spoolReceipts = new DurableCommandReceipts({ file: receiptFile });
    this.#legacyReceipts = this.#legacySpoolDirectory && new DurableCommandReceipts({
      file: path.join(this.#legacySpoolDirectory, "receipts.json"),
    });
  }

  #capture(callback, error, action) {
    try {
      callback(error, {
        surface: "runtime-command",
        kind: "control",
        component: "runtime-command-server",
        action,
      });
    } catch {}
  }

  async #handle(request) {
    const authorized = await this.#authorize(request);
    try {
      return await this.#handler(authorized ?? request);
    } catch (error) {
      this.#capture(this.#captureUnexpectedException, error, "request-handler");
      throw error;
    }
  }

  async #handleSpool(request, receipts, canonicalIds) {
    const authorized = await this.#authorize(request);
    const fingerprint = commandFingerprint({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      environment: request.environment,
    });
    if (receipts === this.#legacyReceipts && canonicalIds.has(request.id)) {
      // The previous runtime may read this request after automatic rollback.
      // Bind the existing effect in its journal before publishing a reply.
      await receipts.retainFrom(this.#spoolReceipts, { id: request.id, fingerprint });
    }
    return receipts.execute({
      id: request.id,
      fingerprint,
      action: request.command,
      effect: () => this.#handler(authorized ?? request),
      reconcile: this.#reconcile ? (receipt) => this.#reconcile(request, receipt) : null,
    });
  }

  async start() {
    if (this.#server) return;
    await removeStaleUnixSocket(this.#endpoint);
    const server = createServer({ allowHalfOpen: false }, (socket) => {
      let body = "";
      let handled = false;
      this.#sockets.add(socket);
      socket.setEncoding("utf8");
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
      socket.once("close", () => this.#sockets.delete(socket));
      socket.on("data", (chunk) => {
        if (handled) return;
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) socket.destroy();
        const newline = body.indexOf("\n");
        if (newline >= 0) {
          handled = true;
          const requestBody = body.slice(0, newline);
          void (async () => {
            let request;
            try {
              request = validateRuntimeCommand(JSON.parse(requestBody));
            } catch (error) {
              socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
              return;
            }
            try {
              const result = await this.#handle(request);
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
    try {
      await mkdir(this.#spoolDirectory, { recursive: true, mode: 0o700 });
    } catch (error) {
      await this.close();
      throw error;
    }
    this.#scheduleSpoolDrain();
  }

  #scheduleSpoolDrain(delayMs = SPOOL_POLL_MS) {
    if (!this.#server || this.#spoolTimer) return;
    this.#spoolTimer = setTimeout(() => {
      this.#spoolTimer = null;
      this.#spoolDrain = this.#drainSpool()
        .catch((error) => {
          this.#capture(this.#captureException, error, "spool-drain");
          console.error("Cannot process runtime command spool:", error.message);
        })
        .finally(() => {
          this.#spoolDrain = null;
          this.#scheduleSpoolDrain();
        });
    }, delayMs);
    this.#spoolTimer.unref?.();
  }

  #receiptOwner(id, legacyIds) {
    return legacyIds.has(id) ? this.#legacyReceipts : this.#spoolReceipts;
  }

  async #retireAcknowledgedSpool(snapshots, legacyIds) {
    const acknowledgedIds = new Set(snapshots.flatMap(({ allNames }) => allNames)
      .filter((item) => item.endsWith(".ack"))
      .map((name) => name.slice(0, -".ack".length))
      .filter(Boolean));
    for (const id of acknowledgedIds) {
      await this.#retireAcknowledgedId(id, snapshots, this.#receiptOwner(id, legacyIds));
    }
    return acknowledgedIds;
  }

  async #retireAcknowledgedId(id, snapshots, receipts) {
    // Keep the ACK until all known copies of the request are gone.
    for (const { directory } of snapshots) {
      await removeSpoolFile(path.join(directory, `${id}.request.json`));
      await removeSpoolFile(path.join(directory, `${id}.response.json`));
    }
    await receipts.forget(id);
    if (receipts === this.#legacyReceipts) await this.#spoolReceipts.forget(id);
    for (const { directory } of snapshots) {
      await removeSpoolFile(path.join(directory, `${id}.ack`));
    }
  }

  async #drainSpool() {
    await mkdir(this.#spoolDirectory, { recursive: true, mode: 0o700 });
    // Serve the original location first so simultaneous copies use the
    // original request and the receipt owner understood by the old runtime.
    const directories = [this.#legacySpoolDirectory, this.#spoolDirectory].filter(Boolean);
    const snapshots = await Promise.all(directories.map(async (directory) => ({
      directory, allNames: await readSpoolDirectory(directory),
    })));
    const legacyIds = new Set();
    if (this.#legacyReceipts) {
      const legacy = snapshots[0];
      for (const name of legacy.allNames) {
        const match = /^(.+)\.(?:request\.json|response\.json|ack)$/u.exec(name);
        if (match) legacyIds.add(match[1]);
      }
      if (snapshots[1].allNames.length) {
        for (const id of await this.#legacyReceipts.ids()) legacyIds.add(id);
      }
    }
    const hasSharedRequests = snapshots.some(({ allNames }) => allNames
      .some((name) => name.endsWith(".request.json")
        && legacyIds.has(name.slice(0, -".request.json".length))));
    const canonicalIds = new Set(hasSharedRequests ? await this.#spoolReceipts.ids() : []);
    const acknowledgedIds = await this.#retireAcknowledgedSpool(snapshots, legacyIds);
    for (const snapshot of snapshots) {
      await this.#drainDirectory(snapshot, snapshots, acknowledgedIds, legacyIds, canonicalIds);
    }
  }

  async #drainDirectory({ directory, allNames }, snapshots, acknowledgedIds, legacyIds, canonicalIds) {
    for (const name of allNames.filter((item) => item.endsWith(".response.json"))) {
      const filePath = path.join(directory, name);
      const info = await stat(filePath).catch(() => null);
      if (info && Date.now() - info.mtimeMs >= SPOOL_RETENTION_MS) {
        await unlink(filePath).catch(() => {});
        const id = name.slice(0, -".response.json".length);
        if (snapshots.every(({ allNames: names }) => !names.includes(`${id}.request.json`))) {
          await this.#receiptOwner(id, legacyIds).forget(id).catch(() => {});
        }
      }
    }
    const names = allNames
      .filter((name) => name.endsWith(".request.json")
        && !acknowledgedIds.has(name.slice(0, -".request.json".length)))
      .sort();
    for (const name of names) {
      const requestPath = path.join(directory, name);
      const responsePath = requestPath.replace(/\.request\.json$/, ".response.json");
      const id = name.slice(0, -".request.json".length);
      const receipts = this.#receiptOwner(id, legacyIds);
      // Acknowledge may arrive after readdir() but before this request reaches
      // the handler. Recheck it at the point of side effect so a client never
      // receives an acknowledged command a second time after a restart.
      const acknowledgements = await Promise.all(snapshots.map(({ directory: candidate }) =>
        stat(path.join(candidate, `${id}.ack`)).then(() => true, (error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        })));
      if (acknowledgements.includes(true)) {
        await this.#retireAcknowledgedId(id, snapshots, receipts);
        acknowledgedIds.add(id);
        continue;
      }
      let response;
      try {
        const text = await this.#readSpoolRequest(requestPath);
        if (text === null) continue;
        const request = validateRuntimeCommand(JSON.parse(text));
        if (request.id !== id) throw new Error("Runtime command file identity mismatch");
        const result = await this.#handleSpool(request, receipts, canonicalIds);
        response = { ok: true, result: String(result ?? "") };
      } catch (error) {
        if (error instanceof DurableCommandRetryableError) continue;
        this.#capture(this.#captureException, error, "spool-command");
        response = { ok: false, error: String(error?.message ?? error) };
      }
      await writeTextAtomic(responsePath, `${JSON.stringify(response)}\n`);
      await unlink(requestPath).catch(() => {});
    }
  }

  async #readSpoolRequest(file) {
    try {
      if ((await stat(file)).size > MAX_REQUEST_BYTES) throw new Error("Runtime command is too large");
      return await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    if (this.#spoolTimer) clearTimeout(this.#spoolTimer);
    this.#spoolTimer = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (!server?.listening) return;
    await new Promise((resolve) => server.close(resolve));
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function forwardRuntimeCommandThroughSpool(command, args, {
  runtimeRoot = runtimeCommandRoot(),
  temporaryRoot,
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
  const acknowledgementPath = path.join(spoolDirectory, `${request.id}.ack`);
  await writeTextAtomic(requestPath, `${JSON.stringify(request)}\n`);
  const deadline = Date.now() + timeoutMs;
  let acknowledged = false;
  try {
    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(await readFile(responsePath, "utf8"));
        acknowledged = true;
        if (!response.ok) throw new Error(response.error || "Runtime command failed");
        return response.result;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await delay(SPOOL_POLL_MS);
    }
    throw new Error("Agent Hub runtime command spool timed out");
  } finally {
    if (acknowledged) await writeTextAtomic(acknowledgementPath, "\n").catch(() => {});
    await Promise.all([unlink(requestPath).catch(() => {}), unlink(responsePath).catch(() => {})]);
  }
}

export async function enqueueRuntimeCommandThroughSpool(command, args, {
  runtimeRoot = runtimeCommandRoot(),
  temporaryRoot,
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
  runtimeRoot = runtimeCommandRoot(),
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
      finish(reject, new Error("Agent Hub runtime command timed out"));
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
        finish(reject, new Error("Agent Hub runtime command closed without a response"));
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
