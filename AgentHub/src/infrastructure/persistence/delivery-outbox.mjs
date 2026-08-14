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

const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DELIVERY_PENDING = "pending";
const DELIVERY_IN_PROGRESS = "delivering";
const DELIVERY_PENDING_ACK = "delivered-pending-ack";
const DELIVERY_STATES = new Set([
  DELIVERY_PENDING,
  DELIVERY_IN_PROGRESS,
  DELIVERY_PENDING_ACK,
]);

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
    && Number.isFinite(item.nextAttemptAt)
    && (item.state == null || DELIVERY_STATES.has(item.state))
    && (
      item.state !== DELIVERY_PENDING_ACK
      || Object.hasOwn(item, "deliveryResult")
    );
}

export class PersistentDeliveryOutbox {
  #items = new Map();
  #operationQueue = Promise.resolve();
  #flushPromise = null;

  constructor({
    directoryPath,
    deliver,
    onDelivered = async () => {},
    onPermanentFailure = async () => {},
    removeFile = unlink,
    now = () => Date.now(),
    maxItems = 1_000,
    retryDelay = deliveryRetryDelay,
  }) {
    this.directoryPath = directoryPath;
    this.deliver = deliver;
    this.onDelivered = onDelivered;
    this.onPermanentFailure = onPermanentFailure;
    this.removeFile = removeFile;
    this.now = now;
    this.maxItems = maxItems;
    this.retryDelay = retryDelay;
  }

  #serialize(operation) {
    const result = this.#operationQueue.catch(() => {}).then(operation);
    this.#operationQueue = result.catch(() => {});
    return result;
  }

  async #load() {
    await mkdir(this.directoryPath, { recursive: true });
    const allNames = await readdir(this.directoryPath);
    const quarantined = allNames
      .filter((name) => name.includes(".invalid-") || name.includes(".failed-"))
      .sort();
    await Promise.all(quarantined.slice(0, -100).map((name) => (
      unlink(path.join(this.directoryPath, name)).catch(() => {})
    )));
    const names = allNames
      .filter((name) => name.endsWith(".json"))
      .sort();
    const present = new Set();
    for (const name of names) {
      const filePath = path.join(this.directoryPath, name);
      present.add(filePath);
      if (this.#items.has(filePath)) continue;
      let item;
      try {
        item = JSON.parse(await readFile(filePath, "utf8"));
        if (!validDelivery(item)) throw new Error("invalid delivery outbox item");
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        await rename(filePath, `${filePath}.invalid-${this.now()}`).catch(() => {});
        present.delete(filePath);
        continue;
      }
      if (item.state == null) {
        item = { ...item, state: DELIVERY_PENDING };
      } else if (item.state === DELIVERY_IN_PROGRESS) {
        const timestamp = this.now();
        const attempts = item.attempts + 1;
        item = {
          ...item,
          state: DELIVERY_PENDING,
          attempts,
          nextAttemptAt: timestamp + this.retryDelay(attempts),
          lastError: "delivery outcome is uncertain after process interruption",
          uncertain: true,
          uncertainAttempts: Number(item.uncertainAttempts ?? 0) + 1,
          uncertainSince: item.uncertainSince ?? new Date(timestamp).toISOString(),
        };
        await this.#persist(filePath, item);
      }
      this.#items.set(filePath, item);
    }
    for (const filePath of this.#items.keys()) {
      if (!present.has(filePath)) this.#items.delete(filePath);
    }
    return this.size;
  }

  load() {
    return this.#serialize(() => this.#load());
  }

  async enqueue({
    method,
    body,
    binding = null,
    groupId = null,
    sequence = 0,
    supersedeKey = null,
  }) {
    return this.#serialize(async () => {
      await this.#load();
      if (supersedeKey) await this.#discardLoaded((item) => item.supersedeKey === supersedeKey);
      if (this.#items.size >= this.maxItems) {
        throw new Error(`delivery outbox limit reached (${this.maxItems})`);
      }
      const timestamp = this.now();
      const item = {
        id: randomUUID(),
        method,
        body,
        binding,
        groupId,
        sequence,
        supersedeKey,
        createdAt: new Date(timestamp).toISOString(),
        attempts: 0,
        nextAttemptAt: timestamp,
        lastError: "",
        state: DELIVERY_PENDING,
        uncertain: false,
        uncertainAttempts: 0,
      };
      const filePath = path.join(
        this.directoryPath,
        `${String(timestamp).padStart(13, "0")}-${process.hrtime.bigint().toString().padStart(20, "0")}-${item.id}.json`,
      );
      await this.#persist(filePath, item);
      this.#items.set(filePath, item);
      return item;
    });
  }

  flush(options = {}) {
    this.#flushPromise ??= this.#flush(options).finally(() => {
      this.#flushPromise = null;
    });
    return this.#flushPromise;
  }

  async #flush({ limit = 20 } = {}) {
    let delivered = 0;
    await this.#serialize(() => this.#load());
    const ordered = [...this.#items.entries()].sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath));
    const grouped = new Map();
    for (const entry of ordered) {
      const groupId = entry[1].groupId;
      if (groupId) grouped.set(groupId, [...(grouped.get(groupId) ?? []), entry]);
    }
    const emittedGroups = new Set();
    const entries = [];
    for (const entry of ordered) {
      const groupId = entry[1].groupId;
      if (!groupId) {
        entries.push(entry);
        continue;
      }
      if (emittedGroups.has(groupId)) continue;
      emittedGroups.add(groupId);
      entries.push(...grouped.get(groupId).sort((left, right) => (
        Number(left[1].sequence ?? 0) - Number(right[1].sequence ?? 0)
      )));
    }
    const blockedGroups = new Set();
    for (const [filePath, item] of entries) {
      if (delivered >= limit) break;
      // A concurrent enqueue may have superseded or discarded this snapshot entry
      // while an earlier network delivery was pending.
      if (this.#items.get(filePath) !== item) continue;
      if (item.groupId && blockedGroups.has(item.groupId)) continue;
      if (item.state === DELIVERY_PENDING_ACK) {
        await this.#acknowledge(filePath, item);
        continue;
      }
      if (item.nextAttemptAt > this.now()) {
        if (item.groupId) blockedGroups.add(item.groupId);
        continue;
      }
      const attemptId = randomUUID();
      const started = await this.#transition(filePath, item, {
        state: DELIVERY_IN_PROGRESS,
        deliveryAttemptId: attemptId,
        deliveryStartedAt: new Date(this.now()).toISOString(),
      });
      if (!started) continue;
      let result;
      try {
        result = await this.deliver(item.method, item.body, {
          deliveryId: item.id,
          idempotencyKey: item.id,
          attemptId,
          uncertain: item.uncertain === true,
        });
      } catch (error) {
        if (error?.retryable !== true) {
          this.#items.delete(filePath);
          await rename(filePath, `${filePath}.failed-${this.now()}`).catch(() => {});
          await this.onPermanentFailure(item, error);
          continue;
        }
        const attempts = item.attempts + 1;
        const uncertainAttempt = error?.uncertain === true;
        await this.#transition(filePath, item, {
          state: DELIVERY_PENDING,
          attempts,
          lastError: String(error.message ?? error),
          nextAttemptAt: this.now() + this.retryDelay(
            attempts,
            Number(error.retryAfterMs ?? 0),
          ),
          uncertain: item.uncertain === true || uncertainAttempt,
          uncertainAttempts: Number(item.uncertainAttempts ?? 0) + (uncertainAttempt ? 1 : 0),
          uncertainSince: uncertainAttempt
            ? item.uncertainSince ?? new Date(this.now()).toISOString()
            : item.uncertainSince,
        });
        if (item.groupId) blockedGroups.add(item.groupId);
        continue;
      }
      let recorded;
      try {
        recorded = await this.#transition(filePath, item, {
          state: DELIVERY_PENDING_ACK,
          deliveryResult: result ?? null,
          deliveredAt: new Date(this.now()).toISOString(),
          lastError: "",
        });
      } catch (error) {
        const timestamp = this.now();
        Object.assign(item, {
          state: DELIVERY_PENDING,
          nextAttemptAt: timestamp + this.retryDelay(item.attempts + 1),
          lastError: `delivery succeeded but its receipt was not persisted: ${String(error.message ?? error)}`,
          uncertain: true,
          uncertainAttempts: Number(item.uncertainAttempts ?? 0) + 1,
          uncertainSince: item.uncertainSince ?? new Date(timestamp).toISOString(),
        });
        throw error;
      }
      if (!recorded) continue;
      delivered += 1;
      await this.#acknowledge(filePath, item);
    }
    return { delivered, remaining: this.size };
  }

  #transition(filePath, item, changes) {
    return this.#serialize(async () => {
      if (this.#items.get(filePath) !== item) return false;
      const next = { ...item, ...changes };
      await this.#persist(filePath, next);
      Object.assign(item, next);
      return true;
    });
  }

  async #acknowledge(filePath, item) {
    await this.onDelivered(item, item.deliveryResult);
    await this.#serialize(async () => {
      if (this.#items.get(filePath) !== item) return;
      await this.removeFile(filePath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      this.#items.delete(filePath);
    });
  }

  #persist(filePath, item) {
    const content = `${JSON.stringify(item, null, 2)}\n`;
    return writeTextAtomic(filePath, content);
  }

  async #discardLoaded(predicate) {
    const operations = [];
    let matched = 0;
    for (const [filePath, item] of this.#items) {
      if (!predicate(item)) continue;
      matched += 1;
      if (item.state === DELIVERY_PENDING && item.uncertain !== true) {
        this.#items.delete(filePath);
        operations.push(unlink(filePath).catch(() => {}));
      } else if (item.discardRequested !== true) {
        item.discardRequested = true;
        operations.push(this.#persist(filePath, item));
      }
    }
    await Promise.all(operations);
    return matched;
  }

  async discard({ supersedeKey }) {
    return this.#serialize(async () => {
      await this.#load();
      return this.#discardLoaded((item) => item.supersedeKey === supersedeKey);
    });
  }

  waitForWrites() {
    return this.#operationQueue;
  }

  async waitForIdle({ flush = false } = {}) {
    await this.#operationQueue;
    if (this.#flushPromise) await this.#flushPromise;
    if (flush) await this.flush({ limit: this.maxItems });
    await this.#operationQueue;
  }

  get size() {
    return this.#items.size;
  }

  get uncertainSize() {
    return [...this.#items.values()].filter((item) => item.uncertain === true).length;
  }
}
