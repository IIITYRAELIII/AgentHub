import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AttachmentUploadService, acquireAttachmentUploadService } from "../../src/infrastructure/filesystem/attachment-upload-service.mjs";
import { attachmentUploadLimits } from "../../src/domain/attachment-upload-policy.mjs";
import { DesktopAttachmentService } from "../../src/interfaces/desktop/desktop-attachment-service.mjs";

const sha = (body) => createHash("sha256").update(body).digest("hex");

test("a blocked finalization does not block another authenticated owner's upload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-upload-"));
  const gateEntered = Promise.withResolvers(), gateRelease = Promise.withResolvers();
  let gateNextRead = true;
  const service = new AttachmentUploadService({ attachmentDirectory: root,
    readStream: async function* (file, options) {
      if (gateNextRead) { gateNextRead = false; gateEntered.resolve(); await gateRelease.promise; }
      yield* createReadStream(file, options);
    } });
  let firstCompletion;
  let timeout;
  try {
    const bytes = Buffer.from("abcd");
    const first = { uploadId: randomUUID(), name: "a.txt", size: bytes.length };
    await service.begin("alice", first);
    await service.putChunk("alice", first.uploadId, 0, bytes, sha(bytes));
    firstCompletion = service.complete("alice", first.uploadId);
    await gateEntered.promise;
    const second = { ...first, uploadId: randomUUID() };
    const independentUpload = (async () => {
      await service.begin("bob", second);
      await service.putChunk("bob", second.uploadId, 0, bytes, sha(bytes));
      return service.complete("bob", second.uploadId);
    })();
    const completed = await Promise.race([independentUpload,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Other owner blocked by finalization")), 1000); })]);
    assert.equal(completed.status, "ready");
    assert.equal(await readFile(completed.path, "utf8"), "abcd");
  } finally {
    clearTimeout(timeout); gateRelease.resolve(); await firstCompletion;
    await service.close(); await rm(root, { recursive: true, force: true });
  }
});

test("image signature is checked before a completed upload becomes visible", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-upload-"));
  const service = new AttachmentUploadService({ attachmentDirectory: root });
  try {
    const bytes = Buffer.from("not a PNG image");
    const metadata = { uploadId: randomUUID(), name: "bad.png", type: "image/png", size: bytes.length };
    await service.begin("alice", metadata);
    await service.putChunk("alice", metadata.uploadId, 0, bytes, sha(bytes));
    await assert.rejects(service.complete("alice", metadata.uploadId), { statusCode: 400 });
    assert.equal((await service.status("alice", metadata.uploadId)).status, "uploading");
    assert.deepEqual((await readdir(root)).filter((name) => !name.startsWith(".")), []);
    const valid = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const accepted = { ...metadata, uploadId: randomUUID(), name: "signature.png", size: valid.length };
    await service.begin("alice", accepted);
    await service.putChunk("alice", accepted.uploadId, 0, valid, sha(valid));
    assert.equal((await service.complete("alice", accepted.uploadId)).status, "ready");
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("ready receipts fail closed after their file disappears or changes without resubmitting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-upload-"));
  const service = new AttachmentUploadService({ attachmentDirectory: root });
  try {
    for (const mutation of ["missing", "same-size-change"]) {
      const bytes = Buffer.from("original");
      const metadata = { uploadId: randomUUID(), name: "ready.txt", type: "text/plain", size: bytes.length };
      await service.begin("alice", metadata);
      await service.putChunk("alice", metadata.uploadId, 0, bytes, sha(bytes));
      const completed = await service.complete("alice", metadata.uploadId);
      if (mutation === "missing") await rm(completed.path);
      else await writeFile(completed.path, Buffer.from("modified"));
      await assert.rejects(service.status("alice", metadata.uploadId), { statusCode: 409 });
      await assert.rejects(service.begin("alice", metadata), { statusCode: 409 });
      await assert.rejects(service.complete("alice", metadata.uploadId), { statusCode: 409 });
      await assert.rejects(service.putChunk("alice", metadata.uploadId, 0, bytes, sha(bytes)), { statusCode: 409 });
      if (mutation === "missing") await assert.rejects(stat(completed.path), { code: "ENOENT" });
      else assert.equal(await readFile(completed.path, "utf8"), "modified");
    }
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("local and public listeners share reservations and release the owner only after both close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-upload-"));
  const limits = { ...attachmentUploadLimits(), maxBytes: 8, maxTotalBytes: 8 };
  const local = await acquireAttachmentUploadService({ attachmentDirectory: root, limits });
  const remote = await acquireAttachmentUploadService({ attachmentDirectory: root, limits });
  try {
    const metadata = { uploadId: randomUUID(), name: "a.txt", size: 8 };
    const results = await Promise.allSettled([
      local.service.begin("alice", metadata),
      remote.service.begin("alice", { ...metadata, uploadId: randomUUID() }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.statusCode, 429);
    await local.release();
    assert.equal((await remote.service.status("alice", metadata.uploadId)).size, 8);
  } finally { await local.release(); await remote.release(); await rm(root, { recursive: true, force: true }); }
});

test("21 MiB upload survives restart and lost ACK, validates paths, and preserves published ownership on cancel", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-upload-"));
  const attachmentDirectory = path.join(root, "attachments");
  let service = new AttachmentUploadService({ attachmentDirectory });
  try {
    const bytes = Buffer.alloc(21 * 1024 * 1024 + 13, 73);
    const metadata = { uploadId: randomUUID(), name: "large.zip", type: "application/zip", size: bytes.length };
    await service.begin("alice", metadata);
    const chunkBytes = service.capabilities().chunkBytes;
    const first = bytes.subarray(0, chunkBytes);
    await service.putChunk("alice", metadata.uploadId, 0, first, sha(first));
    await service.close();
    service = new AttachmentUploadService({ attachmentDirectory });
    assert.equal((await service.status("alice", metadata.uploadId)).received.length, 1);
    assert.equal((await service.putChunk("alice", metadata.uploadId, 0, first, sha(first))).received.length, 1);
    await assert.rejects(service.complete("alice", metadata.uploadId), { statusCode: 409 });
    await assert.rejects(service.status("bob", metadata.uploadId), { statusCode: 404 });
    for (let index = 1; index < Math.ceil(bytes.length / chunkBytes); index++) {
      const part = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
      await service.putChunk("alice", metadata.uploadId, index, part, sha(part));
    }
    const completed = await service.complete("alice", metadata.uploadId);
    assert.equal(completed.sha256, sha(bytes));
    assert.equal(sha(await readFile(completed.path)), completed.sha256);
    await service.close();
    service = new AttachmentUploadService({ attachmentDirectory });
    assert.equal((await service.complete("alice", metadata.uploadId)).path, completed.path);
    const validator = new DesktopAttachmentService({ runtimeCommandRoot: root, projectRoot: root });
    assert.deepEqual(await validator.paths([completed.path]), [completed.path]);
    await service.cancel("alice", metadata.uploadId);
    assert.equal((await stat(completed.path)).size, bytes.length);
    await assert.rejects(service.complete("alice", metadata.uploadId), { statusCode: 409 });
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("upload reservations, immutable metadata, chunk conflicts and expiry are enforced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-upload-"));
  let now = 100;
  const service = new AttachmentUploadService({ attachmentDirectory: root, now: () => now,
    limits: { ...attachmentUploadLimits(), chunkBytes: 4, maxBytes: 8, maxTotalBytes: 8, ttlMs: 20 } });
  try {
    const metadata = { uploadId: randomUUID(), name: "a.txt", type: "text/plain", size: 8 };
    await service.begin("alice", metadata);
    await assert.rejects(service.begin("alice", { ...metadata, name: "b.txt" }), { statusCode: 409 });
    await assert.rejects(service.begin("alice", { ...metadata, uploadId: randomUUID(), size: 1 }), { statusCode: 429 });
    const part = Buffer.from("abcd");
    await assert.rejects(service.putChunk("alice", metadata.uploadId, 0, part, "0".repeat(64)), { statusCode: 400 });
    await service.putChunk("alice", metadata.uploadId, 0, part, sha(part));
    const other = Buffer.from("wxyz");
    await assert.rejects(service.putChunk("alice", metadata.uploadId, 0, other, sha(other)), { statusCode: 409 });
    now = 121;
    await assert.rejects(service.status("alice", metadata.uploadId), { statusCode: 404 });
    const next = await service.begin("alice", { ...metadata, uploadId: randomUUID() });
    assert.equal(next.received.length, 0);
    assert.equal(attachmentUploadLimits({ AGENT_HUB_ATTACHMENT_MAX_BYTES: 1e12 }).maxBytes, 256 * 1024 * 1024);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
