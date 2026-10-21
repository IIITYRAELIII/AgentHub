import { readFile } from "node:fs/promises";
import { writeTextAtomic } from "./state-store.mjs";

function startTrace(context, phase, metadata = {}) {
  try {
    return context?.commandTrace?.startBestEffortSpan?.({
      commandId: context.commandId, transport: context.transport || "local",
      stage: `task-diff-${phase}`, recordStarted: true, metadata,
    });
  } catch { return null; }
}

function finishTrace(span, outcome, error, metadata = {}) {
  try {
    span?.finish({ outcome, metadata: { ...metadata,
      ...(error ? { errorCode: /^[A-Z][A-Z0-9_]{0,63}$/u.test(String(error.code))
        ? error.code : "ERR_TASK_DIFF_WRITE" } : {}) } });
  } catch { /* Diagnostics cannot change persistence or its error. */ }
}

async function measure(context, phase, operation) {
  const span = startTrace(context, phase);
  try {
    const value = await operation();
    finishTrace(span, "succeeded");
    return value;
  } catch (error) {
    finishTrace(span, "failed", error);
    throw error;
  }
}

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

  async set(key, value, context) {
    this.remember(key, value);
    return this.#persist(context);
  }

  // Beginning a run is a reset, not a cache access. Do not promote an empty
  // entry or evict another Stream; still observe dirty/in-flight persistence.
  async clear(key, context) {
    const previous = this.values.get(key);
    const span = startTrace(context, "reset", {
      decision: previous === undefined ? "absent" : previous === "" ? "already-empty" : "stale",
    });
    try {
      if (previous !== undefined && previous !== "") await this.set(key, "", context);
      else await this.flush(context);
      finishTrace(span, "succeeded");
    } catch (error) {
      finishTrace(span, "failed", error);
      throw error;
    }
  }

  async flush(context) {
    return this.#persist(context);
  }

  #persist(context) {
    if (this.scheduledRevision === this.revision) {
      return measure(context, "fence-wait", () => this.writeQueue);
    }
    const encode = startTrace(context, "encode", { revision: this.revision });
    let content;
    try {
      content = this.#content();
      finishTrace(encode, "succeeded", null, encode ? { bytes: Buffer.byteLength(content) } : {});
    } catch (error) {
      finishTrace(encode, "failed", error);
      throw error;
    }
    const revision = this.revision;
    this.scheduledRevision = revision;
    const queued = startTrace(context, "queue-wait", { revision });
    const write = this.writeQueue
      .catch(() => {})
      .then(() => {
        finishTrace(queued, "succeeded");
        return measure(context, "atomic-write", () => this.write(this.filePath, content, {
          measure: (phase, operation) => measure(context, phase, operation),
        }));
      })
      .then(() => {
        const settle = startTrace(context, "settle", { revision });
        this.persistedRevision = revision;
        finishTrace(settle, "succeeded");
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
