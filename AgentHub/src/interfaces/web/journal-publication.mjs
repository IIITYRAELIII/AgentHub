import { observeRuntimeWorkerMemory } from "../../application/runtime-worker-memory.mjs";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const CHUNK_BYTES = 1024 * 1024;

function* encodedJsonChunks(json) {
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(offset + CHUNK_BYTES, json.length);
    // Encoding each half separately would replace a split astral character.
    const before = json.charCodeAt(end - 1), after = json.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1;
    yield Buffer.from(json.slice(offset, end), "utf8");
    offset = end;
  }
}

export async function compressedJournalChunks(payload, { chunkBytes = CHUNK_BYTES, syncId = null, level = 9 } = {}) {
  const json = JSON.stringify(payload);
  // Keep the existing native input error (and its precedence over gzip options)
  // when JSON serialization produces no string.
  if (typeof json !== "string") Buffer.from(json, "utf8");
  const output = [];
  // Keep canonical serialization, but do not allocate a second full uncompressed
  // UTF8 body. Stream backpressure bounds encoding buffers, not journal content.
  await pipeline(Readable.from(encodedJsonChunks(json), { objectMode: false }), createGzip({ level }),
    async (source) => { for await (const chunk of source) output.push(chunk); });
  const compressed = Buffer.concat(output);
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
      observeRuntimeWorkerMemory("journalPublication", worker);
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
