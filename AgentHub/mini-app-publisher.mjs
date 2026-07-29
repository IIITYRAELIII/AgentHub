import { watch } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";

import { buildLazyJournalPayload } from "./mini-app-journal-data.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const ATTACHMENT_TIMEOUT_MS = 60_000;
const SYNC_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CONTROL_POLL_MS = 2_000;
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
  syncId = randomUUID(),
} = {}) {
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 });
  const chunks = [];
  for (let offset = 0; offset < compressed.length; offset += chunkBytes) {
    chunks.push(compressed.subarray(offset, Math.min(offset + chunkBytes, compressed.length)));
  }
  return { syncId, chunks };
}

export async function journalSyncPayload(workLogFile) {
  const [markdown, info] = await Promise.all([
    readFile(workLogFile, "utf8"),
    stat(workLogFile),
  ]);
  return {
    ...buildLazyJournalPayload(markdown),
    updatedAt: info.mtime.toISOString(),
    version: `${Math.trunc(info.mtimeMs)}-${info.size}`,
  };
}

export class MiniAppPublisher {
  #workLogFile;
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
  #watcher = null;
  #refreshTimer = null;
  #controlTimer = null;
  #retryTimer = null;
  #debounceTimer = null;
  #syncing = null;
  #controlPolling = null;
  #pendingControlResults = new Map();
  #pending = false;
  #published = false;
  #closed = false;

  constructor({
    workLogFile,
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
  }) {
    this.#workLogFile = path.resolve(workLogFile);
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

  async #signedControlFetch(pathname, payload, secret, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Mini App Worker control request ${pathname} failed with HTTP ${response.status}`);
    }
    return response;
  }

  async #signedControlRequest(pathname, payload, secret) {
    return (await this.#signedControlFetch(pathname, payload, secret)).json();
  }

  async #flushControlResults(secret) {
    for (const [id, payload] of this.#pendingControlResults) {
      await this.#signedControlRequest("/api/control/result", payload, secret);
      this.#pendingControlResults.delete(id);
    }
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
    this.#controlPolling = (async () => {
      const secret = await this.#secret();
      await this.#flushControlResults(secret);
      const response = await this.#signedControlRequest("/api/control/pull", {
        limit: this.#controlBatchSize,
      }, secret);
      if (!Array.isArray(response?.commands)) throw new Error("Mini App Worker returned an invalid control response");
      let handled = 0;
      let deliveryError = null;
      for (const rawCommand of response.commands) {
        let command;
        try {
          command = this.#validateRemoteCommand(rawCommand);
          command = await this.#prepareRemoteCommand(command, secret);
          let result = await this.#controlHandler({
            action: command.action,
            params: command.params,
            context: {
              source: "telegram-mini-app",
              userId: command.userId,
              commandId: command.id,
            },
          });
          let serialized = JSON.stringify(result ?? null);
          if (Buffer.byteLength(serialized, "utf8") > MAX_CONTROL_RESULT_BYTES) {
            throw new Error("Agent Hub control result is too large");
          }
          result = JSON.parse(serialized);
          this.#pendingControlResults.set(command.id, {
            id: command.id,
            userId: command.userId,
            ok: true,
            result,
          });
        } catch (error) {
          const id = String(command?.id ?? rawCommand?.id ?? "");
          const userId = String(command?.userId ?? rawCommand?.userId ?? "");
          if (!id || !userId) continue;
          this.#pendingControlResults.set(id, {
            id,
            userId,
            ok: false,
            error: String(error?.message ?? error ?? "Agent Hub control action failed").slice(0, MAX_CONTROL_ERROR_CHARS),
          });
        }
        try {
          await this.#flushControlResults(secret);
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
      this.#controlPolling = null;
    }
  }

  async sync() {
    if (this.#closed) return false;
    if (this.#syncing) {
      this.#pending = true;
      return this.#syncing;
    }
    this.#syncing = (async () => {
      const payload = await journalSyncPayload(this.#workLogFile);
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
    this.#watcher = watch(
      path.dirname(this.#workLogFile),
      { persistent: false },
      (_eventType, fileName) => {
        if (!fileName || String(fileName) === path.basename(this.#workLogFile)) this.#scheduleChange();
      },
    );
    this.#refreshTimer = setInterval(() => void this.sync().catch(() => {}), this.#refreshMs);
    this.#refreshTimer.unref?.();
    if (this.#controlHandler) {
      this.#controlTimer = setInterval(
        () => void this.pollControl().catch(() => {}),
        this.#controlPollMs,
      );
      this.#controlTimer.unref?.();
      void this.pollControl().catch(() => {});
    }
    return this.sync();
  }

  async close() {
    this.#closed = true;
    this.#watcher?.close();
    clearTimeout(this.#debounceTimer);
    clearTimeout(this.#retryTimer);
    clearInterval(this.#refreshTimer);
    clearInterval(this.#controlTimer);
    await this.#syncing?.catch(() => {});
    await this.#controlPolling?.catch(() => {});
  }
}
