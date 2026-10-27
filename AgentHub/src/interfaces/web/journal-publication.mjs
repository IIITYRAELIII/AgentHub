import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const CHUNK_BYTES = 1024 * 1024;

export async function compressedJournalChunks(payload, { chunkBytes = CHUNK_BYTES, syncId = null, level = 9 } = {}) {
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"), { level });
  const resolvedSyncId = syncId ?? `sync-${createHash("sha256").update(compressed).digest("hex")}`;
  const chunks = [];
  for (let offset = 0; offset < compressed.length; offset += chunkBytes) {
    chunks.push(compressed.subarray(offset, Math.min(offset + chunkBytes, compressed.length)));
  }
  return { syncId: resolvedSyncId, chunks };
}

// The publisher already serializes sync passes. This worker owns no writer,
// retry, publication receipt or payload cache; only a read-only preparation.
export class JournalPublicationWorker {
  #worker = null;
  #pending = null;
  #sequence = 0;
  #closed = false;

  constructor(databaseFile) { this.databaseFile = databaseFile; }

  prepare() {
    if (this.#closed) return Promise.reject(new Error("Journal publication worker is closed"));
    if (this.#pending) return this.#pending.promise;
    if (!this.#worker) {
      const worker = new Worker(new URL("./journal-publication-worker.mjs", import.meta.url), {
        workerData: { databaseFile: this.databaseFile },
      });
      this.#worker = worker;
      worker.on("message", (message) => {
        if (message.id !== this.#pending?.id) return;
        const pending = this.#pending;
        this.#pending = null;
        worker.unref();
        if (message.error) {
          pending.reject(new Error("Journal publication preparation failed", { cause: message.error }));
          return;
        }
        const { compressed, ...result } = message.result;
        const chunks = [];
        for (let offset = 0; offset < compressed.length; offset += CHUNK_BYTES) {
          chunks.push(Buffer.from(compressed.buffer, compressed.byteOffset + offset,
            Math.min(CHUNK_BYTES, compressed.length - offset)));
        }
        pending.resolve({ ...result, chunks });
      });
      const fail = (error) => {
        if (this.#worker !== worker) return;
        this.#worker = null;
        const pending = this.#pending;
        this.#pending = null;
        pending?.reject(error);
      };
      worker.on("error", fail);
      worker.on("exit", () => fail(new Error("Journal publication worker exited")));
    }
    this.#worker.ref();
    const id = ++this.#sequence;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.#pending = { id, resolve, reject, promise };
    try {
      this.#worker.postMessage({ id, requestedAt: performance.now() });
    } catch (error) {
      this.#pending = null;
      this.#worker.unref();
      reject(error);
    }
    return promise;
  }

  async close() {
    this.#closed = true;
    await this.#pending?.promise.catch(() => {});
    const worker = this.#worker;
    this.#worker = null;
    await worker?.terminate();
  }
}
