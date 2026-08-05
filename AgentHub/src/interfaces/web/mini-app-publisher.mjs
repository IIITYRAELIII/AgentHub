import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";

import { JournalDatabase } from "../../../journal-database.mjs";
import {
  DurableCommandReceipts,
  DurableCommandRetryableError,
  commandFingerprint,
} from "../../../durable-command-receipts.mjs";
import { PersistentDeliveryOutbox } from "../../../delivery-outbox.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const ATTACHMENT_TIMEOUT_MS = 60_000;
const SYNC_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CONTROL_POLL_MS = 2_000;
const CONTROL_LONG_POLL_MS = 25_000;
const CONTROL_LONG_POLL_TIMEOUT_MS = 35_000;
const CONTROL_LOOP_GAP_MS = 25;
const MAX_CONTROL_RESULT_BYTES = 1024 * 1024;
const MAX_CONTROL_ERROR_CHARS = 4_096;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_COMMAND = 8;
const REMOTE_ATTACHMENT_PREFIX = "remote-attachment:";
const CONTROL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMAGE_CONTENT_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
]);
const CONTROL_ACTIONS = new Set([
  "snapshot",
  "task-history",
  "rate-limit-history",
  "usage-history",
  "open-task",
  "open-turn",
  "select-task",
  "send-message",
  "new-task",
  "update-setting",
  "rename-task",
  "archive-task",
  "task-diff",
  "cancel-run",
  "resolve-approval",
  "deferred-input",
  "status-details",
  "speak-last-answer",
  "restart-server",
  "compact-context",
  "open-attachment",
  "trusted-devices",
  "create-device-pairing",
  "revoke-device",
]);
const gzipAsync = promisify(gzip);

function imageMatchesContentType(body, contentType) {
  const value = new Uint8Array(body);
  if (contentType === "image/png") {
    return value.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((item, index) => value[index] === item);
  }
  if (contentType === "image/jpeg") return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  if (contentType === "image/gif") {
    const signature = Buffer.from(value.subarray(0, 6)).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (contentType === "image/webp") {
    return value.length >= 12
      && Buffer.from(value.subarray(0, 4)).toString("ascii") === "RIFF"
      && Buffer.from(value.subarray(8, 12)).toString("ascii") === "WEBP";
  }
  if (contentType === "image/bmp") return value.length >= 2 && value[0] === 0x42 && value[1] === 0x4d;
  return false;
}

export function signMiniAppSync(body, secret, timestamp = Math.trunc(Date.now() / 1_000)) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}\n${bodyHash}`)
    .digest("hex");
  return { timestamp, signature };
}

export function signMiniAppSyncChunk({
  body,
  secret,
  syncId,
  index,
  count,
  encoding,
  version,
  updatedAt,
  timestamp = Math.trunc(Date.now() / 1_000),
}) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret)
    .update([
      timestamp,
      syncId,
      index,
      count,
      encoding,
      version,
      updatedAt,
      bodyHash,
    ].join("\n"))
    .digest("hex");
  return { timestamp, signature };
}

export function signMiniAppControlRequest({
  body,
  secret,
  method = "POST",
  pathname,
  timestamp = Math.trunc(Date.now() / 1_000),
}) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret)
    .update([timestamp, method.toUpperCase(), pathname, bodyHash].join("\n"))
    .digest("hex");
  return { timestamp, signature };
}

export async function compressedJournalChunks(payload, {
  chunkBytes = SYNC_CHUNK_BYTES,
  syncId = null,
} = {}) {
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 });
  const resolvedSyncId = syncId ?? `sync-${createHash("sha256").update(compressed).digest("hex")}`;
  const chunks = [];
  for (let offset = 0; offset < compressed.length; offset += chunkBytes) {
    chunks.push(compressed.subarray(offset, Math.min(offset + chunkBytes, compressed.length)));
  }
  return { syncId: resolvedSyncId, chunks };
}

export async function journalSyncPayload(journalDatabase) {
  const payload = await journalDatabase?.snapshot?.();
  if (!payload) throw new Error("Agent Hub journal snapshot is unavailable");
  return payload;
}

export class MiniAppPublisher {
  #journalDatabase;
  #ownsJournalDatabase;
  #publicUrl;
  #syncSecretFile;
  #retryMs;
  #refreshMs;
  #fetch;
  #onPublished;
  #controlHandler;
  #controlPollMs;
  #controlBatchSize;
  #attachmentDirectory;
  #unsubscribeJournal = null;
  #refreshTimer = null;
  #controlTimer = null;
  #controlDelayResolve = null;
  #controlLoop = null;
  #controlAbortController = null;
  #lastControlLongPoll = false;
  #retryTimer = null;
  #debounceTimer = null;
  #syncing = null;
  #controlPolling = null;
  #controlReceipts;
  #controlResultOutbox;
  #lastControlDeliveryError = null;
  #controlReconciler;
  #afterControlEffect;
  #onControlResultDelivered;
  #pending = false;
  #published = false;
  #closed = false;

  constructor({
    journalDatabase = null,
    journalDatabaseFile = null,
    dataDirectory = null,
    publicUrl,
    syncSecretFile,
    retrySeconds = 15,
    refreshSeconds = 60,
    fetchImpl = globalThis.fetch,
    onPublished = null,
    controlHandler = null,
    controlPollSeconds = DEFAULT_CONTROL_POLL_MS / 1_000,
    controlBatchSize = 10,
    attachmentDirectory = null,
    controlReceiptFile = null,
    controlResultOutboxDirectory = null,
    controlReconciler = null,
    afterControlEffect = null,
    onControlResultDelivered = null,
  }) {
    this.#journalDatabase = journalDatabase
      ?? (journalDatabaseFile ? new JournalDatabase(journalDatabaseFile) : null);
    this.#ownsJournalDatabase = Boolean(!journalDatabase && journalDatabaseFile);
    this.#publicUrl = String(publicUrl).replace(/\/+$/u, "");
    this.#syncSecretFile = path.resolve(syncSecretFile);
    this.#retryMs = Number(retrySeconds) * 1_000;
    this.#refreshMs = Number(refreshSeconds) * 1_000;
    this.#fetch = fetchImpl;
    this.#onPublished = onPublished;
    this.#controlHandler = typeof controlHandler === "function" ? controlHandler : null;
    this.#controlPollMs = Math.max(500, Number(controlPollSeconds) * 1_000 || DEFAULT_CONTROL_POLL_MS);
    this.#controlBatchSize = Math.min(20, Math.max(1, Math.trunc(Number(controlBatchSize) || 10)));
    this.#attachmentDirectory = attachmentDirectory ? path.resolve(attachmentDirectory) : null;
    const storageDirectory = dataDirectory
      ? path.resolve(dataDirectory)
      : journalDatabaseFile
        ? path.dirname(path.resolve(journalDatabaseFile))
        : path.dirname(this.#syncSecretFile);
    const resolvedControlReceiptFile = controlReceiptFile
      ?? path.join(storageDirectory, ".mini-app-control-receipts.json");
    this.#controlReceipts = new DurableCommandReceipts({ file: resolvedControlReceiptFile });
    this.#controlResultOutbox = new PersistentDeliveryOutbox({
      directoryPath: controlResultOutboxDirectory
        ?? path.join(path.dirname(resolvedControlReceiptFile), ".mini-app-control-result-outbox"),
      // Keep the delivery item until both journals are retired. A crash after
      // the Worker accepts the result therefore replays an idempotent result
      // post instead of permanently stranding a completed receipt.
      deliver: async (_method, payload) => {
        try {
          const secret = await this.#secret();
          const result = await this.#signedControlRequest("/api/control/result", payload, secret);
          await this.#onControlResultDelivered?.(payload);
          await this.#controlReceipts.forget(payload.id);
          return result;
        } catch (error) {
          const retryableError = error instanceof Error ? error : new Error(String(error));
          this.#lastControlDeliveryError = retryableError;
          retryableError.retryable = true;
          throw retryableError;
        }
      },
      maxItems: 500,
      // `pollControl` already supplies the bounded retry cadence. Retrying on
      // its next pass preserves prompt control-result delivery without a
      // second, unrelated backoff schedule.
      retryDelay: () => 0,
    });
    this.#controlReconciler = typeof controlReconciler === "function" ? controlReconciler : null;
    this.#afterControlEffect = typeof afterControlEffect === "function" ? afterControlEffect : null;
    this.#onControlResultDelivered = typeof onControlResultDelivered === "function"
      ? onControlResultDelivered
      : null;
  }

  async #secret() {
    const secret = (await readFile(this.#syncSecretFile, "utf8")).trim();
    if (secret.length < 32) throw new Error("Mini App Worker sync secret must contain at least 32 characters");
    return secret;
  }

  #scheduleRetry() {
    if (this.#closed || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.sync().catch(() => {});
    }, this.#retryMs);
    this.#retryTimer.unref?.();
  }

  #scheduleChange() {
    if (this.#closed) return;
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => void this.sync().catch(() => {}), 250);
    this.#debounceTimer.unref?.();
  }

  async #signedControlFetch(pathname, payload, secret, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = null,
  } = {}) {
    const body = JSON.stringify(payload);
    const { timestamp, signature } = signMiniAppControlRequest({
      body,
      secret,
      pathname,
    });
    const response = await this.#fetch(`${this.#publicUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Hub-Timestamp": String(timestamp),
        "X-Agent-Hub-Signature": signature,
      },
      body,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Mini App Worker control request ${pathname} failed with HTTP ${response.status}`);
    }
    return response;
  }

  async #signedControlRequest(pathname, payload, secret, options = {}) {
    return (await this.#signedControlFetch(pathname, payload, secret, options)).json();
  }

  async createDevicePairing(userId) {
    const secret = await this.#secret();
    return this.#signedControlRequest("/api/device/pairing", { userId: String(userId) }, secret);
  }

  async trustedDevices(userId) {
    const secret = await this.#secret();
    return this.#signedControlRequest("/api/device/list", { userId: String(userId) }, secret);
  }

  async revokeDevice(userId, deviceId) {
    const secret = await this.#secret();
    return this.#signedControlRequest("/api/device/revoke", {
      userId: String(userId),
      deviceId: String(deviceId),
    }, secret);
  }

  async publishAttachmentView(userId, file) {
    if (!this.#attachmentDirectory) throw new Error("Remote attachment storage is not configured");
    const target = path.resolve(String(file ?? ""));
    const relative = path.relative(this.#attachmentDirectory, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Attachment is outside the configured storage");
    }
    const contentType = [...IMAGE_CONTENT_TYPES.entries()]
      .find(([, extension]) => extension === path.extname(target).toLowerCase())?.[0]
      ?? (path.extname(target).toLowerCase() === ".jpeg" ? "image/jpeg" : "");
    if (!contentType) throw new Error("Unsupported attachment format");
    const body = await readFile(target);
    if (body.length < 1 || body.length > MAX_ATTACHMENT_BYTES || !imageMatchesContentType(body, contentType)) {
      throw new Error("Attachment is missing, damaged or too large");
    }
    const pathname = "/api/control/attachment/view/push";
    const id = randomUUID().toLowerCase();
    const secret = await this.#secret();
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const { timestamp, signature } = signMiniAppControlRequest({ body, secret, pathname });
    const response = await this.#fetch(`${this.#publicUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        "X-Agent-Hub-Timestamp": String(timestamp),
        "X-Agent-Hub-Signature": signature,
        "X-Agent-Hub-User-Id": String(userId),
        "X-Agent-Hub-Attachment-Id": id,
        "X-Agent-Hub-Attachment-Hash": bodyHash,
      },
      body,
      signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Mini App Worker attachment view failed with HTTP ${response.status}`);
    }
    const result = await response.json();
    return {
      id,
      name: path.basename(target),
      type: contentType,
      expiresAt: result.expiresAt,
    };
  }

  async #flushControlResults() {
    this.#lastControlDeliveryError = null;
    await this.#controlResultOutbox.flush({ limit: this.#controlBatchSize });
    if (this.#lastControlDeliveryError) throw this.#lastControlDeliveryError;
  }

  async #queueControlResult(payload) {
    await this.#controlResultOutbox.enqueue({
      method: "control-result",
      body: payload,
      // A command has exactly one terminal outcome. This also makes an
      // in-process retry replace its old delivery record rather than grow the
      // outbox.
      supersedeKey: `control-result:${payload.id}`,
    });
  }

  #validateRemoteCommand(command) {
    const id = String(command?.id ?? "").trim();
    const userId = String(command?.userId ?? "").trim();
    const action = String(command?.action ?? "").trim();
    const params = command?.params ?? {};
    if (!id || !userId || !CONTROL_ACTIONS.has(action) || params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("Mini App Worker returned an invalid control command");
    }
    const attachments = params.attachments ?? [];
    if (
      (Object.hasOwn(params, "attachments") && !Array.isArray(attachments))
      || attachments.length > MAX_ATTACHMENTS_PER_COMMAND
      || (attachments.length && action !== "send-message")
      || attachments.some((reference) => {
        const value = String(reference ?? "").toLowerCase();
        return !value.startsWith(REMOTE_ATTACHMENT_PREFIX)
          || !CONTROL_ID_PATTERN.test(value.slice(REMOTE_ATTACHMENT_PREFIX.length));
      })
    ) {
      throw new Error("Mini App Worker returned invalid remote attachments");
    }
    return { id, userId, action, params };
  }

  async #downloadRemoteAttachment(reference, command, secret) {
    if (!this.#attachmentDirectory) throw new Error("Remote attachment storage is not configured");
    const id = String(reference).toLowerCase().slice(REMOTE_ATTACHMENT_PREFIX.length);
    const response = await this.#signedControlFetch(
      "/api/control/attachment/pull",
      {
        id,
        userId: command.userId,
        commandId: command.id,
      },
      secret,
      { timeoutMs: ATTACHMENT_TIMEOUT_MS },
    );
    const contentType = String(response.headers.get("Content-Type") ?? "").toLowerCase();
    const extension = IMAGE_CONTENT_TYPES.get(contentType);
    const expectedHash = String(response.headers.get("X-Agent-Hub-Attachment-Hash") ?? "").toLowerCase();
    const advertisedLength = Number(response.headers.get("Content-Length"));
    if (
      !extension
      || !/^[a-f0-9]{64}$/u.test(expectedHash)
      || (Number.isFinite(advertisedLength) && advertisedLength > MAX_ATTACHMENT_BYTES)
    ) {
      throw new Error("Mini App Worker returned invalid attachment metadata");
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (
      body.length < 1
      || body.length > MAX_ATTACHMENT_BYTES
      || !imageMatchesContentType(body, contentType)
      || createHash("sha256").update(body).digest("hex") !== expectedHash
    ) {
      throw new Error("Mini App Worker returned a damaged attachment");
    }
    await mkdir(this.#attachmentDirectory, { recursive: true });
    const target = path.join(this.#attachmentDirectory, `${command.id}-${id}${extension}`);
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

  async #prepareRemoteCommand(command, secret) {
    const attachments = command.params.attachments ?? [];
    if (!attachments.length) return command;
    const localAttachments = [];
    try {
      for (const reference of attachments) {
        localAttachments.push(await this.#downloadRemoteAttachment(reference, command, secret));
      }
    } catch (error) {
      await Promise.all(localAttachments.map((file) => unlink(file).catch(() => {})));
      throw error;
    }
    return {
      ...command,
      params: {
        ...command.params,
        attachments: localAttachments,
      },
    };
  }

  async pollControl() {
    if (this.#closed || !this.#controlHandler) return 0;
    if (this.#controlPolling) return this.#controlPolling;
    const abortController = new AbortController();
    this.#controlAbortController = abortController;
    this.#controlPolling = (async () => {
      const secret = await this.#secret();
      await this.#flushControlResults();
      const response = await this.#signedControlRequest("/api/control/pull", {
        limit: this.#controlBatchSize,
        waitMs: CONTROL_LONG_POLL_MS,
      }, secret, {
        timeoutMs: CONTROL_LONG_POLL_TIMEOUT_MS,
        signal: abortController.signal,
      });
      if (!Array.isArray(response?.commands)) throw new Error("Mini App Worker returned an invalid control response");
      this.#lastControlLongPoll = response.longPoll === true;
      let handled = 0;
      let deliveryError = null;
      for (const rawCommand of response.commands) {
        let command;
        try {
          command = this.#validateRemoteCommand(rawCommand);
          command = await this.#prepareRemoteCommand(command, secret);
          const context = {
            source: "telegram-mini-app",
            userId: command.userId,
            commandId: command.id,
          };
          let result = await this.#controlReceipts.execute({
            id: command.id,
            fingerprint: commandFingerprint({
              action: command.action,
              params: command.params,
              userId: command.userId,
            }),
            action: command.action,
            effect: async () => {
              const result = await this.#controlHandler({ action: command.action, params: command.params, context });
              await this.#afterControlEffect?.(result, command);
              return result;
            },
            reconcile: this.#controlReconciler
              ? (receipt) => this.#controlReconciler({ action: command.action, params: command.params, context, receipt })
              : null,
          });
          let serialized = JSON.stringify(result ?? null);
          if (Buffer.byteLength(serialized, "utf8") > MAX_CONTROL_RESULT_BYTES) {
            throw new Error("Agent Hub control result is too large");
          }
          result = JSON.parse(serialized);
          await this.#queueControlResult({
            id: command.id,
            userId: command.userId,
            ok: true,
            result,
          });
        } catch (error) {
          if (error instanceof DurableCommandRetryableError) throw error;
          const id = String(command?.id ?? rawCommand?.id ?? "");
          const userId = String(command?.userId ?? rawCommand?.userId ?? "");
          if (!id || !userId) continue;
          await this.#queueControlResult({
            id,
            userId,
            ok: false,
            error: String(error?.message ?? error ?? "Agent Hub control action failed").slice(0, MAX_CONTROL_ERROR_CHARS),
          });
        }
        try {
          await this.#flushControlResults();
        } catch (error) {
          deliveryError ??= error;
        }
        handled += 1;
      }
      if (deliveryError) throw deliveryError;
      return handled;
    })();
    try {
      return await this.#controlPolling;
    } finally {
      if (this.#controlAbortController === abortController) this.#controlAbortController = null;
      this.#controlPolling = null;
    }
  }

  async #controlDelay(delayMs) {
    if (delayMs <= 0 || this.#closed) return;
    await new Promise((resolve) => {
      this.#controlDelayResolve = resolve;
      this.#controlTimer = setTimeout(() => {
        this.#controlTimer = null;
        this.#controlDelayResolve = null;
        resolve();
      }, delayMs);
      this.#controlTimer.unref?.();
    });
  }

  async #runControlLoop() {
    while (!this.#closed) {
      let retryDelay = 0;
      try {
        await this.pollControl();
        retryDelay = this.#lastControlLongPoll ? CONTROL_LOOP_GAP_MS : this.#controlPollMs;
      } catch {
        if (this.#closed) break;
        retryDelay = this.#controlPollMs;
      }
      await this.#controlDelay(retryDelay);
    }
  }

  async sync() {
    if (this.#closed) return false;
    if (this.#syncing) {
      this.#pending = true;
      return this.#syncing;
    }
    this.#syncing = (async () => {
      const payload = await journalSyncPayload(this.#journalDatabase);
      const secret = await this.#secret();
      const { syncId, chunks } = await compressedJournalChunks(payload);
      for (const [index, body] of chunks.entries()) {
        const count = chunks.length;
        const encoding = "gzip";
        const { timestamp, signature } = signMiniAppSyncChunk({
          body,
          secret,
          syncId,
          index,
          count,
          encoding,
          version: payload.version,
          updatedAt: payload.updatedAt,
        });
        const response = await this.#fetch(`${this.#publicUrl}/api/sync/chunk`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Agent-Hub-Timestamp": String(timestamp),
            "X-Agent-Hub-Signature": signature,
            "X-Agent-Hub-Sync-Id": syncId,
            "X-Agent-Hub-Chunk-Index": String(index),
            "X-Agent-Hub-Chunk-Count": String(count),
            "X-Agent-Hub-Encoding": encoding,
            "X-Agent-Hub-Journal-Version": payload.version,
            "X-Agent-Hub-Journal-Updated-At": payload.updatedAt,
          },
          body,
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`Mini App Worker sync failed at chunk ${index + 1}/${count} with HTTP ${response.status}`);
        }
      }
      if (!this.#published) {
        await this.#onPublished?.(this.#publicUrl);
        this.#published = true;
      }
      return true;
    })();
    try {
      return await this.#syncing;
    } catch (error) {
      this.#scheduleRetry();
      throw error;
    } finally {
      this.#syncing = null;
      if (this.#pending) {
        this.#pending = false;
        this.#scheduleChange();
      }
    }
  }

  async start() {
    if (!this.#journalDatabase) {
      throw new Error("Mini App journalDatabase or journalDatabaseFile is required");
    }
    this.#unsubscribeJournal = this.#journalDatabase.subscribe(() => this.#scheduleChange());
    this.#refreshTimer = setInterval(() => void this.sync().catch(() => {}), this.#refreshMs);
    this.#refreshTimer.unref?.();
    if (this.#controlHandler) {
      this.#controlLoop = this.#runControlLoop();
    }
    return this.sync();
  }

  async close() {
    this.#closed = true;
    this.#unsubscribeJournal?.();
    this.#unsubscribeJournal = null;
    clearTimeout(this.#debounceTimer);
    clearTimeout(this.#retryTimer);
    clearInterval(this.#refreshTimer);
    clearTimeout(this.#controlTimer);
    this.#controlDelayResolve?.();
    this.#controlDelayResolve = null;
    this.#controlAbortController?.abort();
    await this.#syncing?.catch(() => {});
    await this.#controlLoop?.catch(() => {});
    await this.#controlPolling?.catch(() => {});
    if (this.#ownsJournalDatabase) this.#journalDatabase.close();
  }
}
