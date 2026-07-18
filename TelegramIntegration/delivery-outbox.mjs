import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "./state-store.mjs";

const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;

export function deliveryRetryDelay(attempts, retryAfterMs = 0, {
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
} = {}) {
  const exponential = baseDelayMs * (2 ** Math.max(0, attempts - 1));
  return Math.min(maxDelayMs, Math.max(retryAfterMs, exponential));
}

function validDelivery(item) {
  return item
    && typeof item.id === "string"
    && typeof item.method === "string"
    && item.body
    && typeof item.body === "object"
    && Number.isSafeInteger(item.attempts)
    && Number.isFinite(item.nextAttemptAt);
}

export class PersistentDeliveryOutbox {
  #items = new Map();
  #writeQueue = Promise.resolve();
  #flushing = false;

  constructor({
    directoryPath,
    deliver,
    onDelivered = async () => {},
    onPermanentFailure = async () => {},
    now = () => Date.now(),
    maxItems = 1_000,
  }) {
    this.directoryPath = directoryPath;
    this.deliver = deliver;
    this.onDelivered = onDelivered;
    this.onPermanentFailure = onPermanentFailure;
    this.now = now;
    this.maxItems = maxItems;
  }

  async load() {
    await mkdir(this.directoryPath, { recursive: true });
    const names = (await readdir(this.directoryPath))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const present = new Set();
    for (const name of names) {
      const filePath = path.join(this.directoryPath, name);
      present.add(filePath);
      if (this.#items.has(filePath)) continue;
      const item = JSON.parse(await readFile(filePath, "utf8"));
      if (validDelivery(item)) this.#items.set(filePath, item);
    }
    for (const filePath of this.#items.keys()) {
      if (!present.has(filePath)) this.#items.delete(filePath);
    }
    return this.size;
  }

  async enqueue({ method, body, binding = null }) {
    await this.load();
    if (this.#items.size >= this.maxItems) {
      throw new Error(`delivery outbox limit reached (${this.maxItems})`);
    }
    const timestamp = this.now();
    const item = {
      id: randomUUID(),
      method,
      body,
      binding,
      createdAt: new Date(timestamp).toISOString(),
      attempts: 0,
      nextAttemptAt: timestamp,
      lastError: "",
    };
    const filePath = path.join(
      this.directoryPath,
      `${String(timestamp).padStart(13, "0")}-${item.id}.json`,
    );
    await this.#persist(filePath, item);
    this.#items.set(filePath, item);
    return item;
  }

  async flush({ limit = 20 } = {}) {
    if (this.#flushing) return { delivered: 0, remaining: this.size };
    this.#flushing = true;
    let delivered = 0;
    try {
      await this.load();
      for (const [filePath, item] of this.#items) {
        if (delivered >= limit || item.nextAttemptAt > this.now()) break;
        let result;
        try {
          result = await this.deliver(item.method, item.body);
        } catch (error) {
          if (error?.retryable !== true) {
            this.#items.delete(filePath);
            await unlink(filePath).catch(() => {});
            await this.onPermanentFailure(item, error);
            continue;
          }
          item.attempts += 1;
          item.lastError = String(error.message ?? error);
          item.nextAttemptAt = this.now() + deliveryRetryDelay(
            item.attempts,
            Number(error.retryAfterMs ?? 0),
          );
          await this.#persist(filePath, item);
          break;
        }
        this.#items.delete(filePath);
        await unlink(filePath).catch(() => {});
        delivered += 1;
        await this.onDelivered(item, result);
      }
      return { delivered, remaining: this.size };
    } finally {
      this.#flushing = false;
    }
  }

  #persist(filePath, item) {
    const content = `${JSON.stringify(item, null, 2)}\n`;
    this.#writeQueue = this.#writeQueue
      .catch(() => {})
      .then(() => writeTextAtomic(filePath, content));
    return this.#writeQueue;
  }

  waitForWrites() {
    return this.#writeQueue;
  }

  get size() {
    return this.#items.size;
  }
}
