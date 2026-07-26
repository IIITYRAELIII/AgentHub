import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "./state-store.mjs";

function validRecord(record) {
  return record
    && Number.isSafeInteger(record.updateId)
    && record.update
    && typeof record.update === "object"
    && typeof record.error === "string"
    && typeof record.createdAt === "string";
}

export class FailedTelegramUpdateStore {
  #records = new Map();
  #writeQueue = Promise.resolve();

  constructor({ directoryPath, maxItems = 100, now = Date.now }) {
    this.directoryPath = directoryPath;
    this.maxItems = maxItems;
    this.now = now;
  }

  async load() {
    await this.#writeQueue;
    await mkdir(this.directoryPath, { recursive: true });
    const records = new Map();
    for (const name of (await readdir(this.directoryPath)).filter((item) => item.endsWith(".json")).sort()) {
      const filePath = path.join(this.directoryPath, name);
      try {
        const record = JSON.parse(await readFile(filePath, "utf8"));
        if (!validRecord(record)) throw new Error("invalid failed Telegram update");
        records.set(record.updateId, record);
      } catch {
        await rename(filePath, `${filePath}.invalid-${this.now()}`).catch(() => {});
      }
    }
    this.#records = records;
    return records.size;
  }

  async add(update, error) {
    await this.load();
    const updateId = Number(update?.update_id);
    if (!Number.isSafeInteger(updateId)) throw new TypeError("Telegram update_id is required");
    if (this.#records.has(updateId)) return this.#records.get(updateId);
    if (this.#records.size >= this.maxItems) {
      throw new Error(`failed Telegram update store is full (${this.maxItems})`);
    }
    const timestamp = this.now();
    const record = {
      updateId,
      update,
      error: String(error?.message ?? error),
      createdAt: new Date(timestamp).toISOString(),
    };
    const filePath = path.join(this.directoryPath, `${String(updateId).padStart(20, "0")}.json`);
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(() => (
      writeTextAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`)
    ));
    await this.#writeQueue;
    this.#records.set(updateId, record);
    return record;
  }

  values() {
    return [...this.#records.values()].sort((left, right) => left.updateId - right.updateId);
  }

  waitForWrites() {
    return this.#writeQueue;
  }
}
