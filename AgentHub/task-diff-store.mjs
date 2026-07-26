import { readFile } from "node:fs/promises";
import { writeTextAtomic } from "./state-store.mjs";

export class TaskDiffStore {
  constructor({ filePath, limit = 100 }) {
    this.filePath = filePath;
    this.limit = limit;
    this.values = new Map();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const entries = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(entries)) return;
      for (const entry of entries.slice(-this.limit)) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
        this.values.set(entry[0], entry[1]);
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  get(key) {
    return this.values.get(key);
  }

  remember(key, value) {
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, String(value ?? ""));
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value);
  }

  async set(key, value) {
    this.remember(key, value);
    const content = `${JSON.stringify([...this.values.entries()], null, 2)}\n`;
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => writeTextAtomic(this.filePath, content));
    await this.writeQueue;
  }
}
