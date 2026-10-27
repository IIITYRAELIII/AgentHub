import { parentPort, threadId, workerData } from "node:worker_threads";
import { JournalDatabase } from "../../infrastructure/persistence/journal-database.mjs";
import { compressedJournalChunks } from "./journal-publication.mjs";

const journal = new JournalDatabase(workerData.databaseFile, { readOnly: true });
parentPort.on("message", async ({ id, requestedAt }) => {
  const startedAt = performance.now();
  try {
    const payload = await journal.snapshot();
    if (!payload) throw new Error("Journal snapshot is unavailable");
    const readFinishedAt = performance.now();
    // The wire protocol binds its ID to these compressed bytes. A lower gzip
    // level produces a new valid sync ID, never different bytes under an old ID.
    const { syncId, chunks } = await compressedJournalChunks(payload, { level: 1 });
    const compressed = Uint8Array.from(Buffer.concat(chunks));
    parentPort.postMessage({ id, result: {
      syncId, compressed, version: payload.version, updatedAt: payload.updatedAt,
      measurements: {
        queueWaitMs: startedAt - requestedAt,
        snapshotReadMs: readFinishedAt - startedAt,
        encodeCompressMs: performance.now() - readFinishedAt,
        durationMs: performance.now() - startedAt, workerThreadId: threadId,
        compressedBytes: compressed.length,
      },
    } }, [compressed.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: { code: error?.code ?? "JOURNAL_PUBLICATION_FAILED" } });
  }
});
