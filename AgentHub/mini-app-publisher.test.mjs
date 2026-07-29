import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compressedJournalChunks,
  MiniAppPublisher,
  signMiniAppSyncChunk,
} from "./mini-app-publisher.mjs";

test("Mini App publisher signs and sends the current journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publisher-"));
  const workLogFile = path.join(root, "WORK_LOG.md");
  const secretFile = path.join(root, "sync.secret");
  const secret = "a".repeat(64);
  await writeFile(workLogFile, "# Глобальный журнал работ\n\n<details open><summary>28.07.2026</summary></details>\n");
  await writeFile(secretFile, secret);
  const requests = [];
  const published = [];
  const publisher = new MiniAppPublisher({
    workLogFile,
    publicUrl: "https://hub.example.test/",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    onPublished: async (url) => published.push(url),
  });
  try {
    assert.equal(await publisher.sync(), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://hub.example.test/api/sync/chunk");
    const body = requests[0].options.body;
    const headers = requests[0].options.headers;
    const timestamp = Number(headers["X-Agent-Hub-Timestamp"]);
    assert.equal(headers["X-Agent-Hub-Encoding"], "gzip");
    assert.deepEqual(headers["X-Agent-Hub-Signature"], signMiniAppSyncChunk({
      body,
      secret,
      syncId: headers["X-Agent-Hub-Sync-Id"],
      index: Number(headers["X-Agent-Hub-Chunk-Index"]),
      count: Number(headers["X-Agent-Hub-Chunk-Count"]),
      encoding: headers["X-Agent-Hub-Encoding"],
      version: headers["X-Agent-Hub-Journal-Version"],
      updatedAt: headers["X-Agent-Hub-Journal-Updated-At"],
      timestamp,
    }).signature);
    const payload = JSON.parse(gunzipSync(body).toString("utf8"));
    assert.match(payload.html, /28\.07\.2026/u);
    assert.equal(published.length, 1);
    await publisher.sync();
    assert.equal(published.length, 1);
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher splits a large compressed journal without losing data", async () => {
  const payload = {
    html: Array.from({ length: 10_000 }, (_, index) => `${index}:${"история".repeat(12)}`).join("\n"),
    updatedAt: "2026-07-29T08:00:00.000Z",
    version: "large",
  };
  const { syncId, chunks } = await compressedJournalChunks(payload, {
    chunkBytes: 4_096,
    syncId: "fixed-sync",
  });
  assert.equal(syncId, "fixed-sync");
  assert.ok(chunks.length > 1);
  assert.deepEqual(
    JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8")),
    payload,
  );
});
