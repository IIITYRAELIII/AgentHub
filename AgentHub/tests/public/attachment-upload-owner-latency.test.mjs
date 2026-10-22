import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AttachmentUploadService } from "../../src/infrastructure/filesystem/attachment-upload-service.mjs";
import { CommandTraceSpanStore } from "../../src/infrastructure/persistence/command-trace-span-store.mjs";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { createLocalWebviewSession } from "../../src/interfaces/web/local-webview-session.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function png() {
  const bytes = Buffer.alloc(2_542_625, 73);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return bytes;
}

test("completion keeps exact hashes with bounded protocol-sized reads instead of tiny queued operations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hub-upload-owner-")), reads = [];
  const service = new AttachmentUploadService({ attachmentDirectory: root,
    readStream: async function* (file, options) {
      for await (const bytes of createReadStream(file, options)) { reads.push(bytes.length); yield bytes; }
    } });
  try {
    const bytes = png(), id = randomUUID(), chunk = service.capabilities().chunkBytes;
    await service.begin("fixture", { uploadId: id, name: "synthetic.png", type: "image/png", size: bytes.length });
    for (let i = 0; i * chunk < bytes.length; i++) {
      const part = bytes.subarray(i * chunk, (i + 1) * chunk);
      await service.putChunk("fixture", id, i, part, sha(part));
    }
    const timings = {}, ready = await service.complete("fixture", id, timings);
    assert.deepEqual(await readFile(ready.path), bytes);
    assert.equal(ready.sha256, sha(bytes));
    assert.equal(reads.length, Math.ceil(bytes.length / chunk), "no dozens of tiny read/write waits");
    assert.ok(reads.every(size => size <= chunk), "one protocol part bounds the assembly buffer");
    assert.ok(Number.isFinite(timings.storageRead) && Number.isFinite(timings.storageSync));
    assert.equal((await service.complete("fixture", id)).path, ready.path);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("public client ACK progress and failed owner observations survive the existing trace store reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hub-upload-http-owner-"));
  const databaseFile = path.join(root, "traces.sqlite"), store = new CommandTraceSpanStore({ databaseFile });
  const writes = [], secret = "p".repeat(43), messageId = randomUUID();
  const server = new MiniAppServer({ port: 0, attachmentDirectory: path.join(root, "attachments"), localAccessSecret: secret,
    recordCommandTrace: span => { const write = store.append(span); writes.push(write); return write; },
    journalDatabase: { metadata: async () => ({ version: "isolated", revision: 0 }), subscribe: () => () => {} } });
  try {
    const address = await server.start(), token = createLocalWebviewSession(secret).token;
    const context = vm.createContext({ Blob, URL, crypto: webcrypto, Uint8Array, console }); context.window = context;
    for (const file of ["composer-files.js", "upload.js"]) vm.runInContext(
      await readFile(new URL(`../../assets/web-app/attachments/${file}`, import.meta.url), "utf8"), context);
    const timings = [];
    const uploader = context.AgentHubAttachmentUpload.create({ request: async (uri, init) => {
      const response = await fetch(new URL(uri, address.url), { ...init,
        headers: { ...init.headers, Authorization: `webview ${token}` } });
      timings.push(response.headers.get("server-timing")); return response;
    } });
    const bytes = png(), progress = [];
    const file = await context.AgentHubComposerFiles.prepare(new Blob([bytes]),
      { name: "private-synthetic.png", type: "image/png", size: bytes.length });
    const readyPath = await uploader.upload(file, { traceRequestId: messageId,
      progress: n => progress.push(Math.floor(n / bytes.length * 100)) });
    assert.deepEqual(progress, [41, 82, 100]);
    assert.deepEqual(await readFile(readyPath), bytes);
    const bad = await fetch(new URL(`/api/attachment-upload?id=${randomUUID()}&complete=1`, address.url), {
      method: "POST", headers: { Authorization: `webview ${token}`,
        "X-Agent-Hub-Upload-Request-Id": randomUUID(), "X-Agent-Hub-Upload-Id": file.uploadId,
        "X-Agent-Hub-Message-Request-Id": messageId } });
    assert.equal(bad.status, 404); await bad.json();
    assert.ok(timings.some(value => value?.includes("storageSync;dur=")));
    await server.close(); await Promise.all(writes); await store.close();
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const spans = db.prepare("SELECT outcome,metadata_json FROM command_trace_spans WHERE command_id=?").all(file.uploadId);
      const terminal = spans.map(span => ({ ...span, metadata: JSON.parse(span.metadata_json) })).filter(span => span.outcome !== "started");
      const completed = terminal.find(span => span.metadata.action === "origin-complete" && span.outcome === "succeeded");
      const failed = terminal.find(span => span.metadata.action === "origin-complete" && span.outcome === "failed");
      assert.ok(completed && failed);
      assert.equal(completed.metadata.messageRequestId, messageId);
      for (const name of ["serverOwnerQueueMs", "serverStorageReadMs", "serverStorageWriteMs", "serverStorageSyncMs", "serverStorageCleanupMs", "serverOwnerLoopMaxMs"]) {
        assert.ok(Number.isFinite(completed.metadata[name]), name);
      }
      assert.ok(Number.isFinite(failed.metadata.serverStorageReadMs));
      assert.doesNotMatch(JSON.stringify(spans), /private-synthetic|webview/u);
    } finally { db.close(); }
  } finally {
    await server.close(); await Promise.allSettled(writes); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
