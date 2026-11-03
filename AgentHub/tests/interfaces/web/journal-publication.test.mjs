import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";
import { JournalPublicationWorker } from "../../../src/interfaces/web/journal-publication.mjs";
import { compressedJournalChunks, MiniAppPublisher } from "../../../src/interfaces/web/mini-app-publisher.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "journal-publication-"));
  const file = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(file);
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await journal.close(); await rm(root, { recursive: true, force: true });
  });
  const payload = {
    html: "<p>Canonical index</p>",
    days: { "23.10.2026": "<p>Day fragment</p>" },
    turns: { "turn": "<p>Private final with unchanged identity</p>" },
  };
  await journal.replaceProjection(payload);
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "synthetic-test-secret".repeat(4));
  return { root, file, journal, secretFile, cleanup };
}

test("publication worker reads canonical SQLite and transfers only exact compressed bytes", async (t) => {
  const { file, journal, cleanup } = await fixture(t);
  const worker = new JournalPublicationWorker(file);
  cleanup.push(() => worker.close());
  const expected = await journal.snapshot();
  const reference = await compressedJournalChunks(expected, { level: 1 });
  const pending = worker.prepare();
  assert.equal(worker.prepare(), pending, "concurrent preparation shares the same bounded slot");
  let yielded = false;
  await new Promise((resolve) => setImmediate(() => { yielded = true; resolve(); }));
  const result = await pending;
  assert.ok(yielded);
  assert.ok(result.measurements.workerThreadId > 0);
  assert.ok(result.measurements.snapshotReadMs >= 0);
  assert.ok(result.measurements.queueWaitMs >= 0);
  assert.equal(result.syncId, reference.syncId);
  assert.deepEqual(Buffer.concat(result.chunks), Buffer.concat(reference.chunks));
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(result.chunks))), expected);
  assert.equal(Object.hasOwn(result, "days"), false);
  assert.equal(await journal.currentRevision(), expected.revision);
  await journal.replaceProjection({ html: "<p>Next</p>", days: {}, turns: {} });
  const changed = await worker.prepare();
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(changed.chunks))), await journal.snapshot());
  assert.notEqual(changed.syncId, result.syncId);
});

test("file-backed publisher never hydrates full journal in the main-thread adapter and retries exact bytes", async (t) => {
  const { root, file, journal, secretFile, cleanup } = await fixture(t);
  const expected = await journal.snapshot();
  journal.snapshot = () => { throw new Error("Main-thread full snapshot must not run"); };
  const requests = [], traces = [];
  let fail = true;
  const publisher = new MiniAppPublisher({
    journalDatabase: journal, journalDatabaseFile: file, dataDirectory: root,
    publicUrl: "https://hub.example.test", syncSecretFile: secretFile, retrySeconds: 60,
    recordCommandTrace: (span) => { traces.push(span); },
    fetchImpl: async (_url, options) => {
      requests.push({ body: Buffer.from(options.body), headers: options.headers });
      return new Response(null, { status: fail ? 503 : 200 });
    },
  });
  cleanup.push(() => publisher.close());
  await assert.rejects(publisher.sync(), /HTTP 503/u);
  fail = false;
  assert.equal(await publisher.sync(), true);
  assert.equal(await publisher.sync(), true);
  assert.equal(requests.length, 2, "unchanged publication skips full preparation and upload");
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(requests[0].headers["X-Agent-Hub-Sync-Id"], requests[1].headers["X-Agent-Hub-Sync-Id"]);
  assert.deepEqual(JSON.parse(gunzipSync(requests[1].body)), expected);
  const complete = traces.filter((span) => span.outcome === "succeeded");
  assert.equal(complete.length, 2);
  assert.equal(complete[0].commandId, complete[1].commandId);
  assert.ok(complete.every((span) => span.metadata.workerThreadId > 0));
  assert.equal(JSON.stringify(traces).includes("Private final"), false);
});

test("publisher shutdown drains an active worker preparation without late publication", async (t) => {
  const { root, file, journal, secretFile, cleanup } = await fixture(t);
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let requests = 0;
  const publisher = new MiniAppPublisher({
    journalDatabase: journal, journalDatabaseFile: file, dataDirectory: root,
    publicUrl: "https://hub.example.test", syncSecretFile: secretFile,
    recordCommandTrace: (span) => { if (span.outcome === "started") markStarted(); },
    fetchImpl: async () => { requests += 1; return Response.json({ ok: true }); },
  });
  cleanup.push(() => publisher.close());
  const pending = publisher.sync();
  await started;
  await publisher.close();
  assert.equal(await pending, false);
  assert.equal(requests, 0);
});

test("read-only preparation fails without fallback or creating a missing SQLite source", async (t) => {
  const { root, journal, secretFile, cleanup } = await fixture(t);
  const missing = path.join(root, "missing", "journal.sqlite");
  let snapshots = 0, requests = 0;
  const publisher = new MiniAppPublisher({
    journalDatabase: { payload: () => journal.payload(), snapshot: () => { snapshots += 1; } },
    journalDatabaseFile: missing, dataDirectory: root,
    publicUrl: "https://hub.example.test", syncSecretFile: secretFile, retrySeconds: 60,
    fetchImpl: async () => { requests += 1; return Response.json({ ok: true }); },
  });
  cleanup.push(() => publisher.close());
  await assert.rejects(publisher.sync(), /preparation failed/u);
  assert.equal(snapshots, 0);
  assert.equal(requests, 0);
  await assert.rejects(stat(missing), { code: "ENOENT" });
});

test("publication reads the committed WAL generation while another owner has an uncommitted write", async (t) => {
  const { file, journal, cleanup } = await fixture(t);
  const worker = new JournalPublicationWorker(file);
  cleanup.push(() => worker.close());
  const writer = new DatabaseSync(file);
  cleanup.push(() => writer.close());
  const expected = await journal.snapshot();
  writer.exec("BEGIN IMMEDIATE");
  try {
    writer.prepare("UPDATE journal_meta SET source_version = 'uncommitted', html = 'not committed'").run();
    writer.prepare("UPDATE journal_days SET html = 'not committed'").run();
    writer.prepare("UPDATE journal_turns SET html = 'not committed'").run();
    const prepared = await worker.prepare();
    assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(prepared.chunks))), expected);
  } finally {
    writer.exec("ROLLBACK");
  }
  assert.deepEqual(await journal.snapshot(), expected);
});

test("publication compression avoids a full UTF8 input Buffer and preserves exact gzip identity", async (t) => {
  const block = 1024 * 1024;
  // The first astral character straddles the encoder's ordinary string block.
  const payload = {
    html: "x".repeat(block - '{"html":"'.length - 1) + "\u{1f642}" + "abc".repeat(2 * block),
    days: { day: "\u0416\u4e2d\u{1f642}\ud800\udc00\ud800".repeat(4096) },
    turns: { exact: "answer\n\"\\\u0000" },
  };
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, "utf8");
  const originalFrom = Buffer.from;
  for (const level of [1, 9]) {
    const reference = gzipSync(originalFrom(json, "utf8"), { level });
    let maxInputBufferBytes = 0, totalInputBufferBytes = 0, inputBuffers = 0;
    const from = t.mock.method(Buffer, "from", function (value, ...options) {
      const result = Reflect.apply(originalFrom, Buffer, [value, ...options]);
      if (typeof value === "string" && options[0] === "utf8") {
        maxInputBufferBytes = Math.max(maxInputBufferBytes, result.length);
        totalInputBufferBytes += result.length;
        inputBuffers += 1;
      }
      return result;
    });
    let result;
    try { result = await compressedJournalChunks(payload, { level, chunkBytes: 127 }); }
    finally { from.mock.restore(); }
    t.diagnostic(JSON.stringify({ level, bytes, maxInputBufferBytes, totalInputBufferBytes, inputBuffers }));
    assert.equal(totalInputBufferBytes, bytes, "every original UTF8 byte is encoded exactly once");
    assert.ok(maxInputBufferBytes <= 3 * block, "no complete uncompressed UTF8 allocation");
    assert.ok(inputBuffers > 1);
    assert.deepEqual(Buffer.concat(result.chunks), reference, "chunked encoding keeps the original gzip bytes");
    assert.deepEqual(JSON.parse(gunzipSync(reference)), payload);
    assert.ok(result.chunks.every(chunk => chunk.length <= 127));
    const explicit = await compressedJournalChunks(payload, { level, syncId: result.syncId });
    assert.equal(explicit.syncId, result.syncId);
    assert.deepEqual(Buffer.concat(explicit.chunks), reference);
  }
});

test("publication encoding preserves serialization failures and rejects invalid compression without a partial result", async () => {
  const original = new Error("synthetic serialization failure");
  await assert.rejects(compressedJournalChunks({ toJSON() { throw original; } }), error => error === original);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(compressedJournalChunks(cyclic), TypeError);
  await assert.rejects(compressedJournalChunks({ html: "unchanged" }, { level: 100 }), { code: "ERR_OUT_OF_RANGE" });
  const result = await compressedJournalChunks({ html: "unchanged" });
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(result.chunks))), { html: "unchanged" });
});
