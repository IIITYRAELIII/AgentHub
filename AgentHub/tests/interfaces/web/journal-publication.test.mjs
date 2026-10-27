import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
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
