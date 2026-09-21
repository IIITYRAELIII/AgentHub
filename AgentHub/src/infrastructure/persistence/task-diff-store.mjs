import { readFile } from "node:fs/promises";
import { writeTextAtomic } from "./state-store.mjs";

export class TaskDiffStore {
  constructor({ filePath, limit = 100, write = writeTextAtomic }) {
    this.filePath = filePath;
    this.limit = limit;
    this.write = write;
    this.values = new Map();
    this.writeQueue = Promise.resolve();
    this.revision = 0;
    this.persistedRevision = -1;
    this.scheduledRevision = -1;
  }

  async load() {
    try {
      const content = await readFile(this.filePath, "utf8");
      const entries = JSON.parse(content);
      if (!Array.isArray(entries)) return;
      for (const entry of entries.slice(-this.limit)) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
        this.values.set(entry[0], entry[1]);
      }
      if (content === this.#content()) {
        this.persistedRevision = this.revision;
        this.scheduledRevision = this.revision;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  get(key) {
    return this.values.get(key);
  }

  remember(key, value) {
    const normalizedValue = String(value ?? "");
    const latestKey = [...this.values.keys()].at(-1);
    if (latestKey === key && this.values.get(key) === normalizedValue) return false;
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, normalizedValue);
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value);
    this.revision += 1;
    return true;
  }

  async set(key, value) {
    this.remember(key, value);
    if (this.scheduledRevision === this.revision) {
      return this.writeQueue;
    }
    const content = this.#content();
    const revision = this.revision;
    this.scheduledRevision = revision;
    const write = this.writeQueue
      .catch(() => {})
      .then(() => this.write(this.filePath, content))
      .then(() => {
        this.persistedRevision = revision;
      }, (error) => {
        if (this.scheduledRevision === revision) this.scheduledRevision = this.persistedRevision;
        throw error;
      });
    this.writeQueue = write;
    return write;
  }

  #content() {
    return `${JSON.stringify([...this.values.entries()], null, 2)}\n`;
  }
}
