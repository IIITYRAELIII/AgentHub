import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  attachmentContentType,
  attachmentIsImage,
  createAttachmentStorageName,
  imageMatchesContentType,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
} from "../../domain/attachment-files.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const DEFAULT_POLL_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 5_000;
const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HUB_ID_PATTERN = COMMAND_ID_PATTERN;
const REMOTE_ATTACHMENT_PREFIX = "remote-attachment:";
const ATTACHMENT_TIMEOUT_MS = 60_000;

export function signSharedDashboardBotRequest({
  body,
  secret,
  pathname,
  timestamp = Math.trunc(Date.now() / 1_000),
}) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret)
    .update([timestamp, "POST", pathname, bodyHash].join("\n"))
    .digest("hex");
  return { timestamp, signature };
}

export class SharedDashboardBotClient {
  #publicUrl;
  #hubId;
  #hubName;
  #secretFile;
  #attachmentDirectory;
  #handler;
  #fetch;
  #logger;
  #retryMs;
  #closed = false;
  #loop = null;
  #abortController = null;
  #delayTimer = null;
  #delayResolve = null;

  constructor({
    publicUrl,
    hubId,
    hubName = "Agent Hub",
    secretFile,
    attachmentDirectory,
    handler,
    fetchImpl = globalThis.fetch,
    retrySeconds = DEFAULT_RETRY_MS / 1_000,
    logger = console,
  } = {}) {
    this.#publicUrl = String(publicUrl ?? "").replace(/\/+$/u, "");
    this.#hubId = String(hubId ?? "").trim().toLowerCase();
    this.#hubName = String(hubName ?? "Agent Hub").trim().slice(0, 80) || "Agent Hub";
    this.#secretFile = path.resolve(String(secretFile ?? ""));
    this.#attachmentDirectory = attachmentDirectory ? path.resolve(String(attachmentDirectory)) : null;
    this.#handler = handler;
    this.#fetch = fetchImpl;
    this.#logger = logger;
    this.#retryMs = Math.max(1_000, Number(retrySeconds) * 1_000 || DEFAULT_RETRY_MS);
    if (!this.#publicUrl || !HUB_ID_PATTERN.test(this.#hubId)) {
      throw new TypeError("Shared Dashboard bot publicUrl and hubId are required");
    }
    if (typeof handler !== "function") throw new TypeError("Shared Dashboard bot handler is required");
  }

  async #secret() {
    const secret = (await readFile(this.#secretFile, "utf8")).trim();
    if (secret.length < 32 || secret.length > 256) {
      throw new Error("Shared Dashboard bot secret must contain 32-256 characters");
    }
    return secret;
  }

  async createPairing() {
    const secret = await this.#secret();
    const response = await this.#fetch(`${this.#publicUrl}/api/dashboard-bot/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubId: this.#hubId, name: this.#hubName, secret }),
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Shared Dashboard bot registration failed: ${payload?.error ?? `HTTP ${response.status}`}`);
    }
    return payload;
  }

  async #signedFetch(pathname, payload, { signal = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    const secret = await this.#secret();
    const body = JSON.stringify(payload);
    const { timestamp, signature } = signSharedDashboardBotRequest({ body, secret, pathname });
    try {
      return await this.#fetch(`${this.#publicUrl}${pathname}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-Hub-Dashboard-Id": this.#hubId,
          "X-Agent-Hub-Timestamp": String(timestamp),
          "X-Agent-Hub-Signature": signature,
        },
        body,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const wrapped = new Error(
        `Shared Dashboard bot request ${pathname} failed: ${String(error?.message ?? error)}`,
        { cause: error },
      );
      wrapped.name = String(error?.name ?? "Error");
      throw wrapped;
    }
  }

  async #signedRequest(pathname, payload, options = {}) {
    const response = await this.#signedFetch(pathname, payload, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Shared Dashboard bot request ${pathname} failed: ${result?.error ?? `HTTP ${response.status}`}`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  #validateCommand(command) {
    const id = String(command?.id ?? "").trim().toLowerCase();
    const userId = String(command?.userId ?? "").trim();
    const params = command?.params;
    const attachments = params?.attachments ?? [];
    const replyMessage = Number.isSafeInteger(params?.replyMessageId) && params.replyMessageId > 0;
    const hasText = Boolean(String(params?.text ?? "").trim());
    const replyAttachment = replyMessage && Array.isArray(attachments) && attachments.length > 0;
    if (
      !COMMAND_ID_PATTERN.test(id)
      || !userId
      || command?.action !== "board-task-ingest"
      || !params
      || typeof params !== "object"
      || Array.isArray(params)
      || (!hasText && !replyAttachment)
      || (!replyMessage && !/^shared-dashboard:(?:\d+|[0-9a-f-]{36})(?::\d+)?$/iu.test(String(params.sourceKey ?? "")))
    ) {
      throw new Error("Shared Dashboard bot returned an invalid command");
    }
    if (
      (Object.hasOwn(params, "attachments") && !Array.isArray(attachments))
      || attachments.length > MAX_MESSAGE_ATTACHMENTS
      || attachments.some((reference) => {
        const value = String(reference ?? "").toLowerCase();
        return !value.startsWith(REMOTE_ATTACHMENT_PREFIX)
          || !COMMAND_ID_PATTERN.test(value.slice(REMOTE_ATTACHMENT_PREFIX.length));
      })
    ) {
      throw new Error("Shared Dashboard bot returned invalid attachments");
    }
    return { id, userId, action: "board-task-ingest", params };
  }

  async #downloadRemoteAttachment(reference, command) {
    if (!this.#attachmentDirectory) throw new Error("Shared Dashboard bot attachment storage is not configured");
    const id = String(reference).toLowerCase().slice(REMOTE_ATTACHMENT_PREFIX.length);
    const response = await this.#signedFetch("/api/dashboard-bot/attachment/pull", {
      id,
      userId: command.userId,
      commandId: command.id,
    }, { timeoutMs: ATTACHMENT_TIMEOUT_MS });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(`Shared Dashboard bot attachment download failed: ${payload?.error ?? `HTTP ${response.status}`}`);
    }
    const encodedName = String(response.headers.get("X-Agent-Hub-File-Name") ?? "").trim();
    let originalName = "attachment.bin";
    try {
      if (encodedName) originalName = decodeURIComponent(encodedName);
    } catch {
      throw new Error("Shared Dashboard bot returned invalid attachment metadata");
    }
    const contentType = attachmentContentType(originalName, response.headers.get("Content-Type"));
    const expectedHash = String(response.headers.get("X-Agent-Hub-Attachment-Hash") ?? "").toLowerCase();
    const advertisedLength = Number(response.headers.get("Content-Length"));
    if (
      !/^[a-f0-9]{64}$/u.test(expectedHash)
      || (Number.isFinite(advertisedLength) && advertisedLength > MAX_ATTACHMENT_BYTES)
    ) {
      throw new Error("Shared Dashboard bot returned invalid attachment metadata");
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (
      body.length < 1
      || body.length > MAX_ATTACHMENT_BYTES
      || (attachmentIsImage(contentType) && !imageMatchesContentType(body, contentType))
      || createHash("sha256").update(body).digest("hex") !== expectedHash
    ) {
      throw new Error("Shared Dashboard bot returned a damaged attachment");
    }
    await mkdir(this.#attachmentDirectory, { recursive: true });
    const target = path.join(
      this.#attachmentDirectory,
      createAttachmentStorageName(originalName, `${command.id}-${id}`),
    );
    try {
      const existing = await readFile(target);
      if (createHash("sha256").update(existing).digest("hex") !== expectedHash) {
        throw new Error("Local attachment id conflict");
      }
      return target;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const temporary = path.join(this.#attachmentDirectory, `.${id}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    return target;
  }

  async #prepareCommand(command) {
    const references = command.params.attachments ?? [];
    if (!references.length) return command;
    const attachments = [];
    try {
      for (const reference of references) {
        attachments.push(await this.#downloadRemoteAttachment(reference, command));
      }
    } catch (error) {
      await Promise.all(attachments.map((file) => unlink(file).catch(() => {})));
      throw error;
    }
    return { ...command, params: { ...command.params, attachments } };
  }

  async poll() {
    if (this.#closed) return 0;
    const abortController = new AbortController();
    this.#abortController = abortController;
    try {
      const payload = await this.#signedRequest("/api/dashboard-bot/pull", {
        limit: 10,
        waitMs: 0,
      }, { signal: abortController.signal, timeoutMs: DEFAULT_POLL_TIMEOUT_MS });
      if (!Array.isArray(payload?.commands)) throw new Error("Shared Dashboard bot returned an invalid queue");
      let handled = 0;
      for (const rawCommand of payload.commands) {
        let command;
        let outcome;
        try {
          command = await this.#prepareCommand(this.#validateCommand(rawCommand));
          const result = await this.#handler({
            action: command.action,
            params: command.params,
            context: {
              source: "shared-dashboard-bot",
              userId: command.userId,
              commandId: command.id,
              clientId: `shared-dashboard-bot:${command.userId}`,
            },
          });
          outcome = { id: command.id, userId: command.userId, ok: true, result: result ?? null };
        } catch (error) {
          const id = String(command?.id ?? rawCommand?.id ?? "").trim().toLowerCase();
          const userId = String(command?.userId ?? rawCommand?.userId ?? "").trim();
          if (!COMMAND_ID_PATTERN.test(id) || !userId) continue;
          outcome = {
            id,
            userId,
            ok: false,
            error: String(error?.message ?? error ?? "Shared Dashboard bot command failed").slice(0, 4_096),
          };
        }
        await this.#signedRequest("/api/dashboard-bot/result", outcome);
        handled += 1;
      }
      return handled;
    } finally {
      if (this.#abortController === abortController) this.#abortController = null;
    }
  }

  async #delay() {
    if (this.#closed) return;
    await new Promise((resolve) => {
      this.#delayResolve = resolve;
      this.#delayTimer = setTimeout(() => {
        this.#delayTimer = null;
        this.#delayResolve = null;
        resolve();
      }, this.#retryMs);
      this.#delayTimer.unref?.();
    });
  }

  async #run() {
    while (!this.#closed) {
      try {
        const handled = await this.poll();
        if (handled === 0) await this.#delay();
      } catch (error) {
        if (this.#closed || error?.name === "AbortError") break;
        if (error?.status !== 409) this.#logger.warn(`Shared Dashboard bot: ${error.message}`);
        await this.#delay();
      }
    }
  }

  async start() {
    if (this.#loop) return null;
    this.#closed = false;
    let pairing = null;
    try {
      pairing = await this.createPairing();
      if (!pairing.paired && pairing.code) {
        this.#logger.log(`Shared Dashboard bot pairing: send /link ${pairing.code} to the team bot.`);
      }
    } catch (error) {
      this.#logger.warn(`Cannot register Shared Dashboard bot yet: ${error.message}`);
    }
    this.#loop = this.#run();
    return pairing;
  }

  async close() {
    this.#closed = true;
    clearTimeout(this.#delayTimer);
    this.#delayTimer = null;
    this.#delayResolve?.();
    this.#delayResolve = null;
    this.#abortController?.abort();
    await this.#loop?.catch(() => {});
    this.#loop = null;
  }
}
