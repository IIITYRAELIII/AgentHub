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
import {
  BoundedPollingBackoff,
  retryAfterMilliseconds,
} from "./remote-polling-policy.mjs";
import {
  RemoteControlWakeChannel,
  REMOTE_CONTROL_WAKE_FALLBACK_MS,
  REMOTE_CONTROL_WAKE_PROTOCOL,
  remoteControlWakeUrl,
} from "./remote-control-wake-channel.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HUB_ID_PATTERN = COMMAND_ID_PATTERN;
const REMOTE_ATTACHMENT_PREFIX = "remote-attachment:";
const ATTACHMENT_TIMEOUT_MS = 60_000;
const ATTACHMENT_COMMAND_CONCURRENCY = 3;
const ATTACHMENT_CHUNK_CONCURRENCY = 8;
const ATTACHMENT_TRANSPORT_PROTOCOL = "agent-hub-attachment-chunks-v1";
const ATTACHMENT_TRANSPORT_CHUNK_BYTES = 16 * 1024;
const ATTACHMENT_TRANSPORT_MANIFEST_MAX_BYTES = 24 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ATTACHMENT_ERROR_CODES = new Set([
  "ABORT_ERR", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_RESPONSE_CONTENT_LENGTH_MISMATCH",
]);

function attachmentErrorCode(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (ATTACHMENT_ERROR_CODES.has(current.code)) return current.code;
  }
  return null;
}

function retryableCommandError(error) {
  const status = Number(error?.status);
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? error ?? "");
  return error?.retryable === true
    || status >= 500
    || ["AbortError", "TimeoutError"].includes(name)
    || /(?:aborted|timeout|timed out|fetch failed|network|socket|econn|etimedout)/iu.test(message);
}

function persistentRetryableError(error, description) {
  const wrapped = new Error(`${description}: ${String(error?.message ?? error)}`, { cause: error });
  wrapped.name = String(error?.name ?? "Error");
  wrapped.retryable = true;
  for (const key of ["code", "status", "retryAfterMs", "attachmentTransport"]) {
    if (error?.[key] !== undefined) wrapped[key] = error[key];
  }
  return wrapped;
}

// Одна попытка опроса. Первый отказ фиксируется один раз и останавливает
// планирование новых команд во всех полосах, не трогая уже начатые: у них
// остаются собственные дедлайны, а повтор выполняет следующий опрос.
function pollAttempt() {
  let failed = false;
  let error;
  return {
    get failed() { return failed; },
    get error() { return error; },
    fail(cause) {
      if (failed) return;
      failed = true;
      error = cause;
    },
  };
}

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
  #backoff;
  #attachmentTimeoutMs;
  #activeAttachmentRequests = 0;
  #attachmentResponses = new WeakMap();
  #wakeChannel;
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
    maxRetrySeconds = MAX_RETRY_MS / 1_000,
    attachmentTimeoutMs = ATTACHMENT_TIMEOUT_MS,
    wakeFallbackSeconds = REMOTE_CONTROL_WAKE_FALLBACK_MS / 1_000,
    webSocketFactory = (url) => new globalThis.WebSocket(url),
    logger = console,
    random = Math.random,
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
    this.#backoff = new BoundedPollingBackoff({
      baseMs: this.#retryMs,
      maxMs: Math.max(this.#retryMs, Number(maxRetrySeconds) * 1_000 || MAX_RETRY_MS),
      random,
    });
    this.#attachmentTimeoutMs = Math.max(1, Number(attachmentTimeoutMs) || ATTACHMENT_TIMEOUT_MS);
    if (!this.#publicUrl || !HUB_ID_PATTERN.test(this.#hubId)) {
      throw new TypeError("Shared Dashboard bot publicUrl and hubId are required");
    }
    if (typeof handler !== "function") throw new TypeError("Shared Dashboard bot handler is required");
    this.#wakeChannel = new RemoteControlWakeChannel({
      createUrl: async () => remoteControlWakeUrl({
        publicUrl: this.#publicUrl,
        pathname: "/api/dashboard-bot/wake",
        secret: await this.#secret(),
        parameters: { hubId: this.#hubId },
      }),
      createSocket: webSocketFactory,
      fallbackMs: Math.max(1_000, Number(wakeFallbackSeconds) * 1_000 || REMOTE_CONTROL_WAKE_FALLBACK_MS),
      logger,
    });
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
    const activeSignal = signal ?? this.#abortController?.signal ?? null;
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
        signal: activeSignal
          ? AbortSignal.any([activeSignal, AbortSignal.timeout(timeoutMs)])
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
      error.code = String(result?.code ?? "");
      error.retryAfterMs = retryAfterMilliseconds(response.headers.get("Retry-After"));
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

  async #attachmentResponse(payload, consume) {
    const started = performance.now();
    const diagnostic = {
      mode: payload.mode === "chunk" ? "chunk" : "manifest",
      page: Number.isSafeInteger(payload.page) ? payload.page : null,
      index: Number.isSafeInteger(payload.index) ? payload.index : null,
      phase: "headers", headersMs: null, bodyMs: null, status: null, bytes: 0,
      activeAtStart: ++this.#activeAttachmentRequests,
    };
    try {
      const response = await this.#signedFetch("/api/dashboard-bot/attachment/pull", payload, {
        timeoutMs: this.#attachmentTimeoutMs,
      });
      diagnostic.headersMs = Math.round(performance.now() - started);
      diagnostic.status = response.status;
      diagnostic.phase = "response";
      this.#attachmentResponses.set(response, diagnostic);
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        const error = new Error(`Shared Dashboard bot attachment download failed: ${result?.error ?? `HTTP ${response.status}`}`);
        error.status = response.status;
        throw error;
      }
      return await consume(response);
    } catch (error) {
      if (!retryableCommandError(error)) throw error;
      const details = {
        ...diagnostic,
        elapsedMs: Math.round(performance.now() - started),
        activeAtFailure: this.#activeAttachmentRequests,
        causeCode: attachmentErrorCode(error),
      };
      // Only bounded transport metadata reaches the poll log; dependency messages
      // may contain signed URLs or request data. Preserve the original cause.
      const wrapped = new Error(`Shared Dashboard bot attachment transport failed: ${JSON.stringify(details)}`, { cause: error });
      wrapped.name = String(error?.name ?? "Error");
      wrapped.code = error?.code ?? error?.cause?.code;
      wrapped.status = error?.status;
      wrapped.retryAfterMs = error?.retryAfterMs ?? error?.cause?.retryAfterMs;
      wrapped.retryable = true;
      wrapped.attachmentTransport = details;
      throw wrapped;
    } finally {
      this.#activeAttachmentRequests -= 1;
    }
  }

  async #storeDownloadedAttachment({ body, command, contentType, expectedHash, id, originalName }) {
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

  async #storeLegacyAttachment(response, { command, id }) {
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
      !SHA256_PATTERN.test(expectedHash)
      || (Number.isFinite(advertisedLength) && advertisedLength > MAX_ATTACHMENT_BYTES)
    ) {
      throw new Error("Shared Dashboard bot returned invalid attachment metadata");
    }
    const body = await this.#readAttachmentBody(response);
    return this.#storeDownloadedAttachment({ body, command, contentType, expectedHash, id, originalName });
  }

  async #attachmentManifestPage(response) {
    const body = await this.#readAttachmentBody(response, ATTACHMENT_TRANSPORT_MANIFEST_MAX_BYTES);
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("Shared Dashboard bot returned invalid attachment manifest JSON");
    }
  }

  #validateAttachmentManifestPage(page, { id, expected = null, expectedPage }) {
    const count = page?.count;
    const size = page?.size;
    const pageCount = page?.pageCount;
    const valid = page?.protocol === ATTACHMENT_TRANSPORT_PROTOCOL
      && page?.id === id
      && page?.chunkBytes === ATTACHMENT_TRANSPORT_CHUNK_BYTES
      && page?.page === expectedPage
      && Number.isSafeInteger(size) && size > 0 && size <= MAX_ATTACHMENT_BYTES
      && Number.isSafeInteger(count) && count === Math.ceil(size / ATTACHMENT_TRANSPORT_CHUNK_BYTES)
      && Number.isSafeInteger(pageCount) && pageCount > 0 && pageCount <= count
      && SHA256_PATTERN.test(String(page?.hash ?? ""))
      && typeof page?.name === "string" && page.name.length > 0
      && typeof page?.contentType === "string" && page.contentType.length > 0
      && Array.isArray(page?.chunks) && page.chunks.length > 0;
    if (!valid) throw new Error("Shared Dashboard bot returned invalid attachment manifest");
    if (expected && ["size", "hash", "count", "pageCount", "contentType", "name"].some(
      (key) => page[key] !== expected[key],
    )) {
      throw new Error("Shared Dashboard bot returned inconsistent attachment manifest pages");
    }
    return page;
  }

  async #downloadAttachmentChunk({ command, descriptor, id, manifest }) {
    return this.#attachmentResponse({
      id,
      userId: command.userId,
      commandId: command.id,
      mode: "chunk",
      index: descriptor.index,
    }, async (response) => {
      const advertisedLength = Number(response.headers.get("Content-Length"));
      if (
        response.headers.get("X-Agent-Hub-Attachment-Protocol") !== ATTACHMENT_TRANSPORT_PROTOCOL
        || response.headers.get("X-Agent-Hub-Attachment-Id") !== id
        || response.headers.get("X-Agent-Hub-Attachment-Hash") !== manifest.hash
        || Number(response.headers.get("X-Agent-Hub-Chunk-Index")) !== descriptor.index
        || Number(response.headers.get("X-Agent-Hub-Chunk-Count")) !== manifest.count
        || response.headers.get("X-Agent-Hub-Chunk-Hash") !== descriptor.hash
        || advertisedLength !== descriptor.size
      ) {
        throw new Error("Shared Dashboard bot returned invalid attachment chunk metadata");
      }
      const body = await this.#readAttachmentBody(response, ATTACHMENT_TRANSPORT_CHUNK_BYTES);
      if (
        body.length !== descriptor.size
        || createHash("sha256").update(body).digest("hex") !== descriptor.hash
      ) {
        throw new Error("Shared Dashboard bot returned a damaged attachment chunk");
      }
      return body;
    });
  }

  async #downloadAttachmentChunks({ command, descriptors, id, manifest }) {
    const bodies = new Array(descriptors.length);
    let nextIndex = 0;
    let failed = false;
    let firstError;
    const workers = Array.from(
      { length: Math.min(ATTACHMENT_CHUNK_CONCURRENCY, descriptors.length) },
      async () => {
        while (!failed) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= descriptors.length) break;
          try {
            bodies[index] = await this.#downloadAttachmentChunk({
              command,
              descriptor: descriptors[index],
              id,
              manifest,
            });
          } catch (error) {
            if (!failed) firstError = error;
            failed = true;
            throw error;
          }
        }
      },
    );
    // A retry must not outlive this attempt's downloads. Started requests keep
    // their existing deadlines; no further chunks are scheduled after failure.
    await Promise.allSettled(workers);
    if (failed) throw firstError;
    return bodies;
  }

  async #downloadRemoteAttachmentOnce(reference, command) {
    if (!this.#attachmentDirectory) throw new Error("Shared Dashboard bot attachment storage is not configured");
    const id = String(reference).toLowerCase().slice(REMOTE_ATTACHMENT_PREFIX.length);
    const firstResult = await this.#attachmentResponse({
      id,
      userId: command.userId,
      commandId: command.id,
      mode: "manifest",
      page: 0,
    }, async (response) => {
      if (!String(response.headers.get("Content-Type") ?? "").toLowerCase().includes("application/json")) {
        return { legacyPath: await this.#storeLegacyAttachment(response, { command, id }) };
      }
      return { manifest: await this.#attachmentManifestPage(response) };
    });
    if (firstResult.legacyPath) return firstResult.legacyPath;
    const first = this.#validateAttachmentManifestPage(
      firstResult.manifest,
      { id, expectedPage: 0 },
    );
    const pages = [first];
    for (let page = 1; page < first.pageCount; page += 1) {
      const manifest = await this.#attachmentResponse({
        id,
        userId: command.userId,
        commandId: command.id,
        mode: "manifest",
        page,
      }, (response) => this.#attachmentManifestPage(response));
      pages.push(this.#validateAttachmentManifestPage(
        manifest,
        { id, expected: first, expectedPage: page },
      ));
    }
    const descriptors = pages.flatMap((page) => page.chunks);
    if (descriptors.length !== first.count || descriptors.some((descriptor, index) => (
      Number(descriptor?.index) !== index
      || Number(descriptor?.size) !== Math.min(
        ATTACHMENT_TRANSPORT_CHUNK_BYTES,
        first.size - index * ATTACHMENT_TRANSPORT_CHUNK_BYTES,
      )
      || !SHA256_PATTERN.test(String(descriptor?.hash ?? ""))
    ))) {
      throw new Error("Shared Dashboard bot returned unordered attachment chunks");
    }
    const chunks = await this.#downloadAttachmentChunks({ command, descriptors, id, manifest: first });
    const body = Buffer.concat(chunks, first.size);
    const contentType = attachmentContentType(first.name, first.contentType);
    return this.#storeDownloadedAttachment({
      body,
      command,
      contentType,
      expectedHash: first.hash,
      id,
      originalName: first.name,
    });
  }

  async #readAttachmentBody(response, maxBytes = MAX_ATTACHMENT_BYTES) {
    const diagnostic = this.#attachmentResponses.get(response);
    const started = performance.now();
    if (diagnostic) diagnostic.phase = "body";
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    let timeoutTimer = null;
    const timeout = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        const error = new Error(
          `Shared Dashboard bot attachment body timed out after ${this.#attachmentTimeoutMs} ms`,
        );
        error.name = "TimeoutError";
        reject(error);
      }, this.#attachmentTimeoutMs);
    });
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        const chunk = Buffer.from(value);
        length += chunk.length;
        if (diagnostic) diagnostic.bytes = length;
        if (length > maxBytes) {
          throw new Error("Shared Dashboard bot returned an oversized attachment");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, length);
    } catch (error) {
      void reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      if (diagnostic) diagnostic.bodyMs = Math.round(performance.now() - started);
      clearTimeout(timeoutTimer);
      reader.releaseLock();
    }
  }

  async #downloadRemoteAttachment(reference, command) {
    try {
      return await this.#downloadRemoteAttachmentOnce(reference, command);
    } catch (error) {
      if (!retryableCommandError(error)) throw error;
      throw persistentRetryableError(error, "Shared Dashboard bot attachment download is incomplete; command will be retried");
    }
  }

  async #prepareCommand(command) {
    const references = command.params.attachments ?? [];
    if (!references.length) return command;
    const downloads = await Promise.allSettled(
      references.map((reference) => this.#downloadRemoteAttachment(reference, command)),
    );
    const attachments = downloads
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const failed = downloads.find((result) => result.status === "rejected");
    if (failed) {
      await Promise.all(attachments.map((file) => unlink(file).catch(() => {})));
      throw failed.reason;
    }
    return { ...command, params: { ...command.params, attachments } };
  }

  async #handleCommand(rawCommand) {
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
      if (retryableCommandError(error)) {
        return {
          handled: 0,
          retryError: persistentRetryableError(error, "Shared Dashboard bot command will be retried"),
        };
      }
      const id = String(command?.id ?? rawCommand?.id ?? "").trim().toLowerCase();
      const userId = String(command?.userId ?? rawCommand?.userId ?? "").trim();
      if (!COMMAND_ID_PATTERN.test(id) || !userId) return { handled: 0, retryError: null };
      outcome = {
        id,
        userId,
        ok: false,
        error: String(error?.message ?? error ?? "Shared Dashboard bot command failed").slice(0, 4_096),
      };
    }
    await this.#signedRequest("/api/dashboard-bot/result", outcome);
    return { handled: 1, retryError: null };
  }

  async #handleCommandLane(commands, attempt) {
    let handled = 0;
    let retryError = null;
    for (const command of commands) {
      if (attempt.failed) break;
      try {
        const result = await this.#handleCommand(command);
        handled += result.handled;
        retryError ??= result.retryError;
      } catch (error) {
        attempt.fail(error);
        throw error;
      }
    }
    return { handled, retryError };
  }

  async #handleCommandPool(commands, concurrency, attempt) {
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, commands.length) },
      async () => {
        let handled = 0;
        let retryError = null;
        while (!attempt.failed) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= commands.length) break;
          try {
            const result = await this.#handleCommand(commands[index]);
            handled += result.handled;
            retryError ??= result.retryError;
          } catch (error) {
            attempt.fail(error);
            throw error;
          }
        }
        return { handled, retryError };
      },
    );
    // Отклонённый пул не должен пережить свою попытку: начатые команды
    // дорабатывают со своими дедлайнами, новые после отказа не планируются.
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find((entry) => entry.status === "rejected");
    if (attempt.failed) throw attempt.error;
    if (rejected) throw rejected.reason;
    return settled.reduce((total, entry) => ({
      handled: total.handled + entry.value.handled,
      retryError: total.retryError ?? entry.value.retryError,
    }), { handled: 0, retryError: null });
  }

  async poll() {
    if (this.#closed) return 0;
    const abortController = new AbortController();
    this.#abortController = abortController;
    try {
      const payload = await this.#signedRequest("/api/dashboard-bot/pull", {
        limit: 10,
        waitMs: 0,
        transport: REMOTE_CONTROL_WAKE_PROTOCOL,
      }, { signal: abortController.signal, timeoutMs: DEFAULT_POLL_TIMEOUT_MS });
      if (!Array.isArray(payload?.commands)) throw new Error("Shared Dashboard bot returned an invalid queue");
      const textCommands = [];
      const attachmentCommands = [];
      for (const command of payload.commands) {
        const attachments = command?.params?.attachments;
        (Array.isArray(attachments) && attachments.length > 0
          ? attachmentCommands
          : textCommands).push(command);
      }
      const attempt = pollAttempt();
      const lanes = [];
      if (textCommands.length) lanes.push(this.#handleCommandLane(textCommands, attempt));
      if (attachmentCommands.length) {
        lanes.push(this.#handleCommandPool(attachmentCommands, ATTACHMENT_COMMAND_CONCURRENCY, attempt));
      }
      // Обе полосы дорабатывают внутри этой попытки: ни одна не продолжает
      // слать запросы после того, как опрос уже отклонён.
      const settled = await Promise.allSettled(lanes);
      const rejected = settled.find((entry) => entry.status === "rejected");
      if (attempt.failed) throw attempt.error;
      if (rejected) throw rejected.reason;
      let handled = 0;
      let retryError = null;
      for (const entry of settled) {
        handled += entry.value.handled;
        retryError ??= entry.value.retryError;
      }
      if (retryError) throw retryError;
      return handled;
    } finally {
      if (this.#abortController === abortController) this.#abortController = null;
    }
  }

  async #delay(delayMs = this.#retryMs) {
    if (this.#closed) return;
    await new Promise((resolve) => {
      this.#delayResolve = resolve;
      this.#delayTimer = setTimeout(() => {
        this.#delayTimer = null;
        this.#delayResolve = null;
        resolve();
      }, delayMs);
      this.#delayTimer.unref?.();
    });
  }

  async #run() {
    while (!this.#closed) {
      try {
        const handled = await this.poll();
        const recoveredAttempts = this.#backoff.success();
        if (recoveredAttempts > 0) {
          this.#logger.info?.(`Shared Dashboard bot recovered after ${recoveredAttempts} failed polls.`);
        }
        if (handled === 0) await this.#wakeChannel.wait();
      } catch (error) {
        if (this.#closed || error?.name === "AbortError") break;
        const retry = this.#backoff.failure({ minimumMs: error?.retryAfterMs });
        if (error?.status !== 409) {
          this.#logger.warn(
            `Shared Dashboard bot poll failed (attempt ${retry.attempt}, retry in ${retry.delayMs} ms): ${error.message}`,
          );
        }
        await this.#delay(retry.delayMs);
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
    this.#wakeChannel.close();
    clearTimeout(this.#delayTimer);
    this.#delayTimer = null;
    this.#delayResolve?.();
    this.#delayResolve = null;
    this.#abortController?.abort();
    await this.#loop?.catch(() => {});
    this.#loop = null;
  }
}
