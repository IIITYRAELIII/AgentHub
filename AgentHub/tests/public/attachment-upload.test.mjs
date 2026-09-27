import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto, createHash } from "node:crypto";
import vm from "node:vm";
import test from "node:test";

const sources = await Promise.all(["composer-files.js", "upload.js"].map((name) =>
  readFile(new URL(`../../assets/web-app/attachments/${name}`, import.meta.url), "utf8")));
const CHUNK = 1024 * 1024;
const protocol = "agent-hub-attachment-upload-v1";
async function fixture(size = 2 * CHUNK + 3) {
  const context = vm.createContext({ Blob, URL, crypto: webcrypto, Uint8Array, console });
  context.window = context;
  sources.forEach((source) => vm.runInContext(source, context));
  const file = await context.AgentHubComposerFiles.prepare(new Blob([new Uint8Array(size)], { type: "application/octet-stream" }),
    { name: "payload.bin", type: "application/octet-stream", size });
  return { context, file };
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

test("cancel stops capability negotiation before any attachment upload", async () => {
  const { context } = await fixture(1);
  const controller = new AbortController();
  const calls = [];
  const uploader = context.AgentHubAttachmentUpload.create({ request: (path, { method, signal }) => {
    calls.push(method);
    assert.equal(path, "/api/attachment-upload");
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } });
  const pending = uploader.validateBatch([{ size: 1 }], { signal: controller.signal });
  controller.abort(new Error("cancel preparation"));
  await assert.rejects(pending, /cancel preparation/);
  assert.deepEqual(calls, ["GET"]);
});

test("chunk uploader resumes a lost acknowledgement under the same upload ID without whole-file encoding", { timeout: 25_000 }, async () => {
  const { context, file } = await fixture(21 * CHUNK + 5);
  assert.equal(context.AgentHubComposerFiles.durable(file), false);
  assert.equal(context.AgentHubComposerFiles.serialized(file).dataUrl, undefined);
  const received = new Map();
  const begins = [];
  const written = [];
  let loseAck = true;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    const url = new URL(path, "http://fixture");
    if (init.method === "GET" && !url.search) return response({ protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK, maxTotalBytes: 256 * CHUNK });
    if (init.method === "POST" && !url.search) { begins.push(JSON.parse(init.body)); return response({}); }
    assert.equal(url.searchParams.get("id"), file.uploadId);
    if (init.method === "GET") return response({ protocol, uploadId: file.uploadId, received: [...received.values()] });
    if (init.method === "PUT") {
      const index = Number(url.searchParams.get("index"));
      assert.ok(init.body instanceof Blob);
      assert.ok(init.body.size <= CHUNK);
      const hash = createHash("sha256").update(Buffer.from(await init.body.arrayBuffer())).digest("hex");
      assert.equal(init.headers["X-Agent-Hub-Chunk-Sha256"], hash);
      received.set(index, { index, size: init.body.size, sha256: hash });
      written.push(index);
      if (loseAck) { loseAck = false; throw new Error("lost acknowledgement"); }
      return response({});
    }
    return response({ uploadId: file.uploadId, status: "ready", path: "/attachment/complete", sha256: "a".repeat(64) });
  } });
  await assert.rejects(uploader.upload(file), /lost acknowledgement/u);
  const progress = [];
  assert.equal(await uploader.upload(file, { progress: (bytes) => progress.push(bytes) }), "/attachment/complete");
  assert.equal(begins.length, 1);
  assert.equal(begins[0].uploadId, file.uploadId);
  assert.deepEqual(written, Array.from({ length: 22 }, (_, index) => index));
  assert.equal(progress.at(-1), file.size);
});

test("chunk uploader rejects mismatched stored hashes and exposes expired IDs as terminal", { timeout: 25_000 }, async () => {
  const { context, file } = await fixture(3);
  let expired = false;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    const url = new URL(path, "http://fixture");
    if (!url.search && init.method === "GET") return response({ protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK, maxTotalBytes: 256 * CHUNK });
    if (!url.search) return response({});
    assert.equal(init.method, "GET");
    return expired ? response({ error: "expired" }, 410)
      : response({ protocol, uploadId: file.uploadId, received: [{ index: 0, size: 3, sha256: "b".repeat(64) }] });
  } });
  await assert.rejects(uploader.upload(file), /сумма/u);
  expired = true;
  await assert.rejects(uploader.upload(file), (error) => error.attachmentUploadTerminal === true);
});

test("upload capabilities accept a total quota below the nominal file quota", async () => {
  const { context } = await fixture(3);
  const uploader = context.AgentHubAttachmentUpload.create({ request: async () => response({
    protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK, maxTotalBytes: 64 * CHUNK,
  }) });
  assert.equal((await uploader.capabilities()).maxBytes, 64 * CHUNK);
});

test("draft attachment batch checks negotiated aggregate quota before any upload", async () => {
  const { context } = await fixture(3);
  const calls = [];
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    calls.push([path, init.method]);
    return response({ protocol, chunkBytes: CHUNK, maxBytes: 8, maxTotalBytes: 10 });
  } });
  await assert.rejects(uploader.validateBatch([{ size: 6 }, { size: 5 }]),
    (error) => error.attachmentUploadTerminal === true);
  await uploader.validateBatch([{ size: 6 }, { size: 4 }]);
  await assert.rejects(uploader.validateBatch([{ size: 9 }]), /лимит/u);
  assert.deepEqual(calls, [["/api/attachment-upload", "GET"]]);
});

test("legacy aggregate quota remains 20 MiB and empty text sends do not negotiate", async () => {
  const { context } = await fixture(3);
  let calls = 0;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async () => {
    calls += 1;
    return response({}, 404);
  } });
  await uploader.validateBatch([]);
  assert.equal(calls, 0);
  await assert.rejects(uploader.validateBatch([{ size: 11 * CHUNK }, { size: 10 * CHUNK }]), /лимит/u);
  assert.equal(calls, 1);
});

test("Blob durability expires and memory pruning preserves staged and explicitly owned files", async () => {
  const { context, file } = await fixture(3);
  file.durable = true;
  assert.equal(context.AgentHubComposerFiles.durable(file), true);
  file.storedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  assert.equal(context.AgentHubComposerFiles.durable(file), false);
  context.AgentHubComposerFiles.prune([]);
  assert.ok(context.AgentHubComposerFiles.resolve(file));
  context.AgentHubComposerFiles.settle([file]);
  context.AgentHubComposerFiles.prune([file.blobId]);
  assert.ok(context.AgentHubComposerFiles.resolve(file));
  context.AgentHubComposerFiles.prune([]);
  assert.equal(context.AgentHubComposerFiles.resolve(file), null);
});
