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

const SUPPORTED_KINDS = new Set(["image", "voice", "speech"]);

function validJob(item) {
  return item
    && typeof item.id === "string"
    && SUPPORTED_KINDS.has(item.kind)
    && item.payload
    && typeof item.payload === "object"
    && typeof item.createdAt === "string";
}

export class PersistentBackgroundJobStore {
  #items = new Map();
  #files = new Map();
  #writeQueue = Promise.resolve();

  constructor({ directoryPath, maxItems = 30, now = () => Date.now() }) {
    if (!directoryPath) throw new TypeError("directoryPath is required");
    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw new TypeError("maxItems must be a positive integer");
    }
    this.directoryPath = directoryPath;
    this.maxItems = maxItems;
    this.now = now;
  }

  async load() {
    await this.#writeQueue;
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
        items.set(item.id, item);
        files.set(item.id, filePath);
      } catch {
        await rename(filePath, `${filePath}.invalid-${this.now()}`).catch(() => {});
      }
    }
    this.#items = items;
    this.#files = files;
    return this.size;
  }

  async enqueue({ kind, payload }) {
    if (!SUPPORTED_KINDS.has(kind)) throw new TypeError(`unsupported background job kind: ${kind}`);
    if (!payload || typeof payload !== "object") throw new TypeError("payload must be an object");
    await this.load();
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
      createdAt: new Date(timestamp).toISOString(),
    };
    const filePath = path.join(
      this.directoryPath,
      `${String(timestamp).padStart(13, "0")}-${process.hrtime.bigint().toString().padStart(20, "0")}-${item.id}.json`,
    );
    const content = `${JSON.stringify(item, null, 2)}\n`;
    this.#writeQueue = this.#writeQueue
      .catch(() => {})
      .then(() => writeTextAtomic(filePath, content));
    await this.#writeQueue;
    this.#items.set(item.id, item);
    this.#files.set(item.id, filePath);
    return item;
  }

  async remove(id) {
    await this.#writeQueue;
    const filePath = this.#files.get(id);
    this.#items.delete(id);
    this.#files.delete(id);
    if (filePath) await unlink(filePath).catch(() => {});
  }

  values() {
    return [...this.#items.values()].sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    ));
  }

  count(kind) {
    return this.values().filter((item) => item.kind === kind).length;
  }

  waitForWrites() {
    return this.#writeQueue;
  }

  get size() {
    return this.#items.size;
  }
}
