import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";

import { JournalDatabase } from "../../infrastructure/persistence/journal-database.mjs";
import {
  attachmentContentType,
  attachmentIsImage,
  attachmentMetadataFromId,
  createAttachmentStorageName,
  imageMatchesContentType,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
} from "../../domain/attachment-files.mjs";
import {
  DurableCommandReceipts,
  DurableCommandRetryableError,
  commandFingerprint,
} from "../../infrastructure/persistence/durable-command-receipts.mjs";
import { PersistentDeliveryOutbox } from "../../infrastructure/persistence/delivery-outbox.mjs";
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

const DEFAULT_TIMEOUT_MS = 15_000;
const ATTACHMENT_TIMEOUT_MS = 60_000;
const SYNC_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CONTROL_POLL_MS = 1_000;
const MAX_CONTROL_RETRY_MS = 60_000;
const DEFAULT_SNAPSHOT_REFRESH_MS = 2_000;
const MAX_CONTROL_RESULT_BYTES = 1024 * 1024;
const MAX_CONTROL_ERROR_CHARS = 4_096;
const MAX_ATTACHMENTS_PER_COMMAND = MAX_MESSAGE_ATTACHMENTS;
const REMOTE_ATTACHMENT_PREFIX = "remote-attachment:";
const CONTROL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_ACTIONS = new Set([
  "snapshot",
  "task-history",
  "rate-limit-history",
  "usage-history",
  "workspace-message-search",
  "mark-task-read",
  "workspace-message-open",
  "open-task",
  "open-turn",
  "select-task",
  "send-message",
  "submit-bug-report",
  "new-task",
  "rotate-stream",
  "update-setting",
  "rename-task",
  "archive-task",
  "archive-stream",
  "task-diff",
  "cancel-run",
  "resolve-approval",
  "deferred-input",
  "status-details",
  "speak-last-answer",
  "restart-server",
  "retry-startup",
  "compact-context",
  "open-attachment",
  "trusted-devices",
  "create-device-pairing",
  "revoke-device",
  "message-pin-set",
  "message-pins-clear",
  "board-task-attachment-add",
]);
const CONTROL_SOURCES = new Set(["telegram-mini-app", "trusted-device", "shared-dashboard-bot"]);
const gzipAsync = promisify(gzip);

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

function journalPayloadIdentity(payload) {
  if (!payload || typeof payload !== "object") return "";
  const version = String(payload.version ?? "").trim();
  if (version) return `version:${version}`;
  if (Object.hasOwn(payload, "revision")) {
    const revision = Number(payload.revision);
    if (Number.isFinite(revision)) return `revision:${revision}`;
  }
  return "";
}

export class MiniAppPublisher {
  #journalDatabase;
  #ownsJournalDatabase;
  #publicUrl;
  #syncSecretFile;
  #retryMs;
  #refreshMs;
  #fetch;
  #logger;
  #onPublished;
  #controlHandler;
  #snapshotUserIds;
  #snapshotRefreshMs;
  #snapshotVersions = new Map();
  #controlPollMs;
  #controlBackoff;
  #controlWakeChannel;
  #controlBatchSize;
  #attachmentDirectory;
  #unsubscribeJournal = null;
  #refreshTimer = null;
  #snapshotRefreshTimer = null;
  #snapshotDebounceTimer = null;
  #controlTimer = null;
  #controlDelayResolve = null;
  #controlLoop = null;
  #controlAbortController = null;
  #syncAbortController = null;
  #snapshotAbortController = null;
  #retryTimer = null;
  #debounceTimer = null;
  #syncing = null;
  #snapshotSyncing = null;
  #controlPolling = null;
  #controlReceipts;
  #controlResultOutbox;
  #lastControlDeliveryError = null;
  #controlReconciler;
  #afterControlEffect;
  #onControlResultDelivered;
  #pending = false;
  #snapshotPending = false;
  #published = false;
  #publishedJournalIdentity = "";
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
    logger = console,
    random = Math.random,
    onPublished = null,
    controlHandler = null,
    snapshotUserIds = [],
    snapshotRefreshSeconds = DEFAULT_SNAPSHOT_REFRESH_MS / 1_000,
    controlPollSeconds = DEFAULT_CONTROL_POLL_MS / 1_000,
    wakeFallbackSeconds = REMOTE_CONTROL_WAKE_FALLBACK_MS / 1_000,
    webSocketFactory = (url) => new globalThis.WebSocket(url),
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
    this.#logger = logger;
    this.#onPublished = onPublished;
    this.#controlHandler = typeof controlHandler === "function" ? controlHandler : null;
    this.#snapshotUserIds = [...new Set([...snapshotUserIds]
      .map((value) => String(value).trim())
      .filter(Boolean))];
    this.#snapshotRefreshMs = Math.max(
      1_000,
      Number(snapshotRefreshSeconds) * 1_000 || DEFAULT_SNAPSHOT_REFRESH_MS,
    );
    this.#controlPollMs = Math.max(500, Number(controlPollSeconds) * 1_000 || DEFAULT_CONTROL_POLL_MS);
    this.#controlBackoff = new BoundedPollingBackoff({
      baseMs: this.#controlPollMs,
      maxMs: MAX_CONTROL_RETRY_MS,
      random,
    });
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
    this.#controlWakeChannel = new RemoteControlWakeChannel({
      createUrl: async () => remoteControlWakeUrl({
        publicUrl: this.#publicUrl,
        pathname: "/api/control/wake",
        secret: await this.#secret(),
      }),
      createSocket: webSocketFactory,
      fallbackMs: Math.max(1_000, Number(wakeFallbackSeconds) * 1_000 || REMOTE_CONTROL_WAKE_FALLBACK_MS),
      logger,
    });
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
      void Promise.allSettled([this.sync(), this.syncSnapshots()]);
    }, this.#retryMs);
    this.#retryTimer.unref?.();
  }

  #scheduleChange() {
    if (this.#closed) return;
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => void this.sync().catch(() => {}), 250);
    this.#debounceTimer.unref?.();
  }

  #scheduleSnapshotChange() {
    if (this.#closed || !this.#snapshotUserIds.length) return;
    clearTimeout(this.#snapshotDebounceTimer);
    this.#snapshotDebounceTimer = setTimeout(() => void this.syncSnapshots().catch(() => {}), 250);
    this.#snapshotDebounceTimer.unref?.();
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
      const result = await response.clone().json().catch(() => ({}));
      const error = new Error(
        `Mini App Worker control request ${pathname} failed with HTTP ${response.status}`
        + `${result?.error ? `: ${result.error}` : ""}`,
      );
      error.status = response.status;
      error.code = String(result?.code ?? "");
      error.retryAfterMs = retryAfterMilliseconds(response.headers.get("Retry-After"));
      throw error;
    }
    return response;
  }

  async #signedControlRequest(pathname, payload, secret, options = {}) {
    return (await this.#signedControlFetch(pathname, payload, secret, options)).json();
  }

  async #publicDeviceRequest(pathname, payload) {
    const response = await this.#fetch(`${this.#publicUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(result?.error ?? `Mini App Worker device request failed with HTTP ${response.status}`));
    }
    return result;
  }

  async createDevicePairing(userId, { code = "", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const secret = await this.#secret();
    const payload = { userId: String(userId) };
    if (code) payload.code = String(code);
    return this.#signedControlRequest("/api/device/pairing", payload, secret, { timeoutMs });
  }

  async trustedDevices(userId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const secret = await this.#secret();
    return this.#signedControlRequest(
      "/api/device/list",
      { userId: String(userId) },
      secret,
      { timeoutMs },
    );
  }

  async revokeDevice(userId, deviceId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const secret = await this.#secret();
    return this.#signedControlRequest("/api/device/revoke", {
      userId: String(userId),
      deviceId: String(deviceId),
    }, secret, { timeoutMs });
  }

  pairDevice(payload) {
    return this.#publicDeviceRequest("/api/device/pair", payload);
  }

  createDeviceChallenge(payload) {
    return this.#publicDeviceRequest("/api/device/challenge", payload);
  }

  createDeviceSession(payload) {
    return this.#publicDeviceRequest("/api/device/session", payload);
  }

  async resolveDeviceSession(token) {
    const secret = await this.#secret();
    return this.#signedControlRequest("/api/device/session/resolve", { token: String(token) }, secret);
  }

  async importDevices(userId, devices, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const secret = await this.#secret();
    return this.#signedControlRequest("/api/device/import", {
      userId: String(userId),
      devices,
    }, secret, { timeoutMs });
  }

  async deleteDevices(userId, deviceIds) {
    const secret = await this.#secret();
    return this.#signedControlRequest("/api/device/delete", {
      userId: String(userId),
      deviceIds,
    }, secret);
  }

  async publishAttachmentView(userId, file) {
    if (!this.#attachmentDirectory) throw new Error("Remote attachment storage is not configured");
    const target = path.resolve(String(file ?? ""));
    const relative = path.relative(this.#attachmentDirectory, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Attachment is outside the configured storage");
    }
    const metadata = attachmentMetadataFromId(path.basename(target));
    if (!metadata) throw new Error("Unsupported attachment identifier");
    const contentType = metadata.type;
    const body = await readFile(target);
    if (
      body.length < 1
      || body.length > MAX_ATTACHMENT_BYTES
      || (attachmentIsImage(contentType) && !imageMatchesContentType(body, contentType))
    ) {
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
        "X-Agent-Hub-File-Name": encodeURIComponent(metadata.name),
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
      name: metadata.name,
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
    const source = String(command?.source ?? "telegram-mini-app").trim();
    const params = command?.params ?? {};
    if (!id || !userId || !CONTROL_ACTIONS.has(action) || !CONTROL_SOURCES.has(source) || params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("Mini App Worker returned an invalid control command");
    }
    const attachments = params.attachments ?? [];
    if (
      (Object.hasOwn(params, "attachments") && !Array.isArray(attachments))
      || attachments.length > MAX_ATTACHMENTS_PER_COMMAND
      || (attachments.length && !["send-message", "submit-bug-report", "board-task-attachment-add"].includes(action))
      || attachments.some((reference) => {
        const value = String(reference ?? "").toLowerCase();
        return !value.startsWith(REMOTE_ATTACHMENT_PREFIX)
          || !CONTROL_ID_PATTERN.test(value.slice(REMOTE_ATTACHMENT_PREFIX.length));
      })
    ) {
      throw new Error("Mini App Worker returned invalid remote attachments");
    }
    return { id, userId, action, source, params };
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
    const encodedName = String(response.headers.get("X-Agent-Hub-File-Name") ?? "").trim();
    const advertisedType = String(response.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
    const legacyImageExtension = new Map([
      ["image/png", ".png"],
      ["image/jpeg", ".jpg"],
      ["image/webp", ".webp"],
      ["image/gif", ".gif"],
      ["image/bmp", ".bmp"],
    ]).get(advertisedType) ?? "";
    let originalName = `attachment${legacyImageExtension || ".bin"}`;
    try {
      if (encodedName) originalName = decodeURIComponent(encodedName);
    } catch {
      throw new Error("Mini App Worker returned invalid attachment metadata");
    }
    const contentType = attachmentContentType(originalName, response.headers.get("Content-Type"));
    const expectedHash = String(response.headers.get("X-Agent-Hub-Attachment-Hash") ?? "").toLowerCase();
    const advertisedLength = Number(response.headers.get("Content-Length"));
    if (
      !/^[a-f0-9]{64}$/u.test(expectedHash)
      || (Number.isFinite(advertisedLength) && advertisedLength > MAX_ATTACHMENT_BYTES)
    ) {
      throw new Error("Mini App Worker returned invalid attachment metadata");
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (
      body.length < 1
      || body.length > MAX_ATTACHMENT_BYTES
      || (attachmentIsImage(contentType) && !imageMatchesContentType(body, contentType))
      || createHash("sha256").update(body).digest("hex") !== expectedHash
    ) {
      throw new Error("Mini App Worker returned a damaged attachment");
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

  async #handleControlCommand(rawCommand, secret) {
    let command;
    try {
      command = this.#validateRemoteCommand(rawCommand);
      command = await this.#prepareRemoteCommand(command, secret);
      const context = {
        source: command.source,
        transport: "worker",
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
          const value = await this.#controlHandler({ action: command.action, params: command.params, context });
          await this.#afterControlEffect?.(value, command);
          this.#scheduleSnapshotChange();
          return value;
        },
        reconcile: this.#controlReconciler
          ? (receipt) => this.#controlReconciler({ action: command.action, params: command.params, context, receipt })
          : null,
      });
      const serialized = JSON.stringify(result ?? null);
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
      if (!id || !userId) return { handled: false, deliveryError: null };
      await this.#queueControlResult({
        id,
        userId,
        ok: false,
        error: String(error?.message ?? error ?? "Agent Hub control action failed").slice(0, MAX_CONTROL_ERROR_CHARS),
      });
    }
    let deliveryError = null;
    try {
      await this.#flushControlResults();
      if (this.#controlResultOutbox.size) await this.#flushControlResults();
    } catch (error) {
      deliveryError = error;
    }
    return { handled: true, deliveryError };
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
        waitMs: 0,
        transport: REMOTE_CONTROL_WAKE_PROTOCOL,
      }, secret, {
        signal: abortController.signal,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (!Array.isArray(response?.commands)) throw new Error("Mini App Worker returned an invalid control response");
      let handled = 0;
      let deliveryError = null;
      const outcomes = await Promise.allSettled(
        response.commands.map((command) => this.#handleControlCommand(command, secret)),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
        if (outcome.value.handled) handled += 1;
        deliveryError ??= outcome.value.deliveryError;
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
        const handled = await this.pollControl();
        const recoveredAttempts = this.#controlBackoff.success();
        if (recoveredAttempts > 0) {
          this.#logger.info?.(`Mini App control polling recovered after ${recoveredAttempts} failed polls.`);
        }
        if (handled === 0) await this.#controlWakeChannel.wait();
      } catch (error) {
        if (this.#closed) break;
        const retry = this.#controlBackoff.failure({ minimumMs: error?.retryAfterMs });
        retryDelay = retry.delayMs;
        this.#logger.warn?.(
          `Mini App control poll failed (attempt ${retry.attempt}, retry in ${retry.delayMs} ms): ${error.message}`,
        );
      }
      if (retryDelay > 0) await this.#controlDelay(retryDelay);
    }
  }

  async sync() {
    if (this.#closed) return false;
    if (this.#syncing) {
      this.#pending = true;
      return this.#syncing;
    }
    const abortController = new AbortController();
    this.#syncAbortController = abortController;
    this.#syncing = (async () => {
      const index = typeof this.#journalDatabase?.payload === "function"
        ? await this.#journalDatabase.payload()
        : null;
      const indexIdentity = journalPayloadIdentity(index);
      if (indexIdentity && indexIdentity === this.#publishedJournalIdentity) return true;
      const payload = await journalSyncPayload(this.#journalDatabase);
      const payloadIdentity = journalPayloadIdentity(payload);
      if (payloadIdentity && payloadIdentity === this.#publishedJournalIdentity) return true;
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
          signal: AbortSignal.any([
            abortController.signal,
            AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          ]),
        });
        if (!response.ok) {
          throw new Error(`Mini App Worker sync failed at chunk ${index + 1}/${count} with HTTP ${response.status}`);
        }
      }
      if (!this.#published) {
        await this.#onPublished?.(this.#publicUrl);
        this.#published = true;
      }
      this.#publishedJournalIdentity = payloadIdentity;
      return true;
    })();
    try {
      return await this.#syncing;
    } catch (error) {
      this.#scheduleRetry();
      throw error;
    } finally {
      if (this.#syncAbortController === abortController) this.#syncAbortController = null;
      this.#syncing = null;
      if (this.#pending) {
        this.#pending = false;
        this.#scheduleChange();
      }
    }
  }

  async syncSnapshots() {
    if (this.#closed || !this.#controlHandler || !this.#snapshotUserIds.length) return false;
    if (this.#snapshotSyncing) {
      this.#snapshotPending = true;
      return this.#snapshotSyncing;
    }
    const abortController = new AbortController();
    this.#snapshotAbortController = abortController;
    this.#snapshotSyncing = (async () => {
      const secret = await this.#secret();
      let changed = false;
      for (const userId of this.#snapshotUserIds) {
        const snapshot = await this.#controlHandler({
          action: "snapshot",
          params: { knownVersion: this.#snapshotVersions.get(userId) ?? "" },
          context: { source: "telegram-mini-app", transport: "worker", userId },
        });
        if (snapshot?.notModified === true) continue;
        if (!snapshot || typeof snapshot !== "object" || !String(snapshot.version ?? "")) {
          throw new Error("Agent Hub returned an invalid client snapshot");
        }
        if (this.#closed) return changed;
        await this.#signedControlRequest("/api/snapshot/push", { userId, snapshot }, secret, {
          signal: abortController.signal,
        });
        this.#snapshotVersions.set(userId, String(snapshot.version));
        changed = true;
      }
      return changed;
    })();
    try {
      return await this.#snapshotSyncing;
    } catch (error) {
      this.#scheduleRetry();
      throw error;
    } finally {
      if (this.#snapshotAbortController === abortController) this.#snapshotAbortController = null;
      this.#snapshotSyncing = null;
      if (this.#snapshotPending) {
        this.#snapshotPending = false;
        this.#scheduleSnapshotChange();
      }
    }
  }

  async start() {
    if (!this.#journalDatabase) {
      throw new Error("Mini App journalDatabase or journalDatabaseFile is required");
    }
    this.#unsubscribeJournal = this.#journalDatabase.subscribe(() => {
      this.#scheduleChange();
      this.#scheduleSnapshotChange();
    });
    this.#refreshTimer = setInterval(() => void this.sync().catch(() => {}), this.#refreshMs);
    this.#refreshTimer.unref?.();
    this.#snapshotRefreshTimer = setInterval(
      () => void this.syncSnapshots().catch(() => {}),
      this.#snapshotRefreshMs,
    );
    this.#snapshotRefreshTimer.unref?.();
    if (this.#controlHandler) {
      this.#controlLoop = this.#runControlLoop();
    }
    const [published] = await Promise.all([this.sync(), this.syncSnapshots()]);
    return published;
  }

  async close() {
    this.#closed = true;
    this.#controlWakeChannel.close();
    this.#unsubscribeJournal?.();
    this.#unsubscribeJournal = null;
    clearTimeout(this.#debounceTimer);
    clearTimeout(this.#snapshotDebounceTimer);
    clearTimeout(this.#retryTimer);
    clearInterval(this.#refreshTimer);
    clearInterval(this.#snapshotRefreshTimer);
    clearTimeout(this.#controlTimer);
    this.#controlDelayResolve?.();
    this.#controlDelayResolve = null;
    this.#controlAbortController?.abort();
    this.#syncAbortController?.abort();
    this.#snapshotAbortController?.abort();
    await this.#syncing?.catch(() => {});
    await this.#snapshotSyncing?.catch(() => {});
    await this.#controlLoop?.catch(() => {});
    await this.#controlPolling?.catch(() => {});
    if (this.#ownsJournalDatabase) this.#journalDatabase.close();
  }
}
