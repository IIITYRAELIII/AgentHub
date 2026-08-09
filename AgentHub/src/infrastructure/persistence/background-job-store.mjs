import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "./state-store.mjs";

const SUPPORTED_KINDS = new Set(["image", "voice", "speech", "forward-bundle-image"]);

function validJob(item) {
  return item
    && typeof item.id === "string"
    && (item.dedupeKey === undefined || item.dedupeKey === null || typeof item.dedupeKey === "string")
    && SUPPORTED_KINDS.has(item.kind)
    && item.payload
    && typeof item.payload === "object"
    && typeof item.createdAt === "string"
    && (item.attempts === undefined || (Number.isSafeInteger(item.attempts) && item.attempts >= 0))
    && (item.nextAttemptAt === undefined || item.nextAttemptAt === null || (
      typeof item.nextAttemptAt === "string" && Number.isFinite(Date.parse(item.nextAttemptAt))
    ))
    && (item.lastError === undefined || item.lastError === null || typeof item.lastError === "string");
}

export class PersistentBackgroundJobStore {
  #items = new Map();
  #files = new Map();
  #operationQueue = Promise.resolve();

  constructor({ directoryPath, maxItems = 30, now = () => Date.now() }) {
    if (!directoryPath) throw new TypeError("directoryPath is required");
    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw new TypeError("maxItems must be a positive integer");
    }
    this.directoryPath = directoryPath;
    this.maxItems = maxItems;
    this.now = now;
  }

  #serialize(operation) {
    const result = this.#operationQueue.catch(() => {}).then(operation);
    this.#operationQueue = result.catch(() => {});
    return result;
  }

  async #load() {
    await mkdir(this.directoryPath, { recursive: true });
    const names = (await readdir(this.directoryPath))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const items = new Map();
    const files = new Map();
    for (const name of names) {
      const filePath = path.join(this.directoryPath, name);
      try {
        const item = JSON.parse(await readFile(filePath, "utf8"));
        if (!validJob(item) || items.has(item.id)) throw new Error("invalid background job");
        const normalized = {
          ...item,
          attempts: Number.isSafeInteger(item.attempts) ? item.attempts : 0,
          nextAttemptAt: item.nextAttemptAt ?? null,
          lastError: item.lastError ?? null,
        };
        items.set(item.id, normalized);
        files.set(item.id, filePath);
      } catch {
        await rename(filePath, `${filePath}.invalid-${this.now()}`).catch(() => {});
      }
    }
    this.#items = items;
    this.#files = files;
    return this.size;
  }

  load() {
    return this.#serialize(() => this.#load());
  }

  async enqueue({ kind, payload, dedupeKey = null }) {
    if (!SUPPORTED_KINDS.has(kind)) throw new TypeError(`unsupported background job kind: ${kind}`);
    if (!payload || typeof payload !== "object") throw new TypeError("payload must be an object");
    if (dedupeKey !== null && (typeof dedupeKey !== "string" || !dedupeKey.trim())) {
      throw new TypeError("dedupeKey must be a non-empty string or null");
    }
    return this.#serialize(async () => {
      await this.#load();
      if (dedupeKey) {
        const existing = this.values().find((item) => item.dedupeKey === dedupeKey);
        if (existing) return existing;
      }
      if (this.size >= this.maxItems) {
        const error = new Error(`background job store is full (${this.maxItems})`);
        error.code = "QUEUE_FULL";
        error.limit = this.maxItems;
        throw error;
      }
      const timestamp = this.now();
      const item = {
        id: randomUUID(),
        kind,
        payload,
        dedupeKey,
        createdAt: new Date(timestamp).toISOString(),
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      };
      const filePath = path.join(
        this.directoryPath,
        `${String(timestamp).padStart(13, "0")}-${process.hrtime.bigint().toString().padStart(20, "0")}-${item.id}.json`,
      );
      await writeTextAtomic(filePath, `${JSON.stringify(item, null, 2)}\n`);
      this.#items.set(item.id, item);
      this.#files.set(item.id, filePath);
      return item;
    });
  }

  async remove(id) {
    return this.#serialize(async () => {
      const filePath = this.#files.get(id);
      this.#items.delete(id);
      this.#files.delete(id);
      if (filePath) await unlink(filePath).catch(() => {});
    });
  }

  async recordFailure(id, { attempts, nextAttemptAt, lastError }) {
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
      throw new TypeError("attempts must be a positive integer");
    }
    if (typeof nextAttemptAt !== "string" || !Number.isFinite(Date.parse(nextAttemptAt))) {
      throw new TypeError("nextAttemptAt must be an ISO timestamp");
    }
    return this.#serialize(async () => {
      const current = this.#items.get(id);
      const filePath = this.#files.get(id);
      if (!current || !filePath) return null;
      const updated = {
        ...current,
        attempts,
        nextAttemptAt,
        lastError: String(lastError ?? "").slice(0, 1_000),
      };
      await writeTextAtomic(filePath, `${JSON.stringify(updated, null, 2)}\n`);
      this.#items.set(id, updated);
      return updated;
    });
  }

  values() {
    return [...this.#items.values()].sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    ));
  }

  count(kind) {
    return this.values().filter((item) => item.kind === kind).length;
  }

  findByDedupeKey(dedupeKey) {
    if (!dedupeKey) return null;
    return this.values().find((item) => item.dedupeKey === dedupeKey) ?? null;
  }

  waitForWrites() {
    return this.#operationQueue;
  }

  get size() {
    return this.#items.size;
  }
}
