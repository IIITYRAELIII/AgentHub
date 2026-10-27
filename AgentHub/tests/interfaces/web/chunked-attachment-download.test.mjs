import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadChunkedAttachment, readAttachmentResponse } from "../../../src/interfaces/web/chunked-attachment-download.mjs";

const protocol = "agent-hub-attachment-chunks-v1";
const hash = body => createHash("sha256").update(body).digest("hex");
function fixture(body, overrides = {}) {
  const id = randomUUID();
  const digest = hash(body);
  const count = Math.ceil(body.length / 16384);
  const calls = [];
  let active = 0;
  let peak = 0;
  const request = async params => {
    calls.push(params);
    if (params.mode === "manifest") {
      const start = params.page * 128;
      return Response.json({ protocol, id, name: "large.zip", contentType: "application/zip",
        size: body.length, hash: digest, count, chunkBytes: 16384,
        page: params.page, pageCount: Math.ceil(count / 128),
        chunks: Array.from({ length: Math.min(128, count - start) }, (_, offset) => {
          const index = start + offset;
          const bytes = body.subarray(index * 16384, (index + 1) * 16384);
          return { index, size: bytes.length, hash: hash(bytes) };
        }), ...overrides.manifest,
      });
    }
    active += 1;
    peak = Math.max(peak, active);
    try {
      await Promise.resolve();
      if (params.index === overrides.failIndex) throw new Error("connection lost");
      const bytes = body.subarray(params.index * 16384, (params.index + 1) * 16384);
      return new Response(overrides.corruptIndex === params.index ? Buffer.alloc(bytes.length) : bytes, {
        headers: { "Content-Length": String(bytes.length),
          "X-Agent-Hub-Attachment-Protocol": protocol, "X-Agent-Hub-Attachment-Id": id,
          "X-Agent-Hub-Attachment-Hash": digest, "X-Agent-Hub-Chunk-Hash": hash(bytes),
          "X-Agent-Hub-Chunk-Index": String(params.index), "X-Agent-Hub-Chunk-Count": String(count) },
      });
    } finally { active -= 1; }
  };
  return { id, request, calls, peak: () => peak, active: () => active };
}

test("chunk download materializes >20 MiB atomically with bounded parallelism and stable retry", {  }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub172-download-"));
  try {
    const bytes = Buffer.alloc(21 * 1024 * 1024 + 17, 53);
    const source = fixture(bytes);
    const commandId = randomUUID();
    const args = { ...source, commandId, directory, maxBytes: 128 * 1024 * 1024 };
    const target = await downloadChunkedAttachment({ ...args, firstResponse: await source.request({ mode: "manifest", page: 0 }) });
    assert.deepEqual(await readFile(target), bytes);
    assert.ok(source.peak() <= 4);
    const before = source.calls.filter(item => item.mode === "chunk").length;
    assert.equal(await downloadChunkedAttachment({ ...args, firstResponse: await source.request({ mode: "manifest", page: 0 }) }), target);
    assert.equal(source.calls.filter(item => item.mode === "chunk").length, before);
    assert.deepEqual(await readdir(directory), [path.basename(target)]);
    await writeFile(target, "conflicting local file");
    await assert.rejects(downloadChunkedAttachment({ ...args,
      firstResponse: await source.request({ mode: "manifest", page: 0 }) }), /conflict/);
    assert.equal(await readFile(target, "utf8"), "conflicting local file");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed or corrupt chunks drain requests and never expose a partial file", async () => {
  for (const overrides of [{ failIndex: 5 }, { corruptIndex: 3 }, { manifest: { size: 999999999 } }]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hub172-download-failure-"));
    try {
      const source = fixture(Buffer.alloc(200000, 12), overrides);
      await assert.rejects(downloadChunkedAttachment({ ...source, commandId: randomUUID(), directory,
        maxBytes: 128 * 1024 * 1024, firstResponse: await source.request({ mode: "manifest", page: 0 }) }));
      assert.equal(source.active(), 0);
      assert.deepEqual(await readdir(directory), []);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("attachment response bounds body and stalls independently of headers", async () => {
  await assert.rejects(readAttachmentResponse(new Response("12345"), 4), /bound/);
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(readAttachmentResponse(response, 16, 20), /timed out/);
  assert.equal(cancelled, true);
});
