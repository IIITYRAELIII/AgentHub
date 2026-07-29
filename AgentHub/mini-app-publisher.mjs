import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";

import { buildLazyJournalPayload } from "./mini-app-journal-data.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const SYNC_CHUNK_BYTES = 1024 * 1024;
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
  #watcher = null;
  #refreshTimer = null;
  #retryTimer = null;
  #debounceTimer = null;
  #syncing = null;
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
  }) {
    this.#workLogFile = path.resolve(workLogFile);
    this.#publicUrl = String(publicUrl).replace(/\/+$/u, "");
    this.#syncSecretFile = path.resolve(syncSecretFile);
    this.#retryMs = Number(retrySeconds) * 1_000;
    this.#refreshMs = Number(refreshSeconds) * 1_000;
    this.#fetch = fetchImpl;
    this.#onPublished = onPublished;
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
    return this.sync();
  }

  async close() {
    this.#closed = true;
    this.#watcher?.close();
    clearTimeout(this.#debounceTimer);
    clearTimeout(this.#retryTimer);
    clearInterval(this.#refreshTimer);
    await this.#syncing?.catch(() => {});
  }
}
