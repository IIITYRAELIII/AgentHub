import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachmentUploadLimits } from "../../../src/domain/attachment-upload-policy.mjs";
import { publishChunkedAttachmentView } from "../../../src/interfaces/web/chunked-attachment-view.mjs";

test("large attachment view resumes the exact upload after lost chunk acknowledgement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub172-view-"));
  try {
    const file = path.join(directory, "file.zip");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 91);
    await writeFile(file, bytes);
    const limits = attachmentUploadLimits({});
    const received = new Map();
    const identities = [];
    let lostAck = true;
    let peakBody = 0;
    const request = async payload => {
      peakBody = Math.max(peakBody, Buffer.byteLength(JSON.stringify(payload)));
      identities.push(payload.uploadId);
      const status = { ...limits, uploadId: payload.uploadId, received: [...received.values()] };
      if (payload.action === "chunk") {
        const body = Buffer.from(payload.dataBase64, "base64");
        assert.equal(createHash("sha256").update(body).digest("hex"), payload.sha256);
        assert.deepEqual(body, bytes.subarray(payload.index * limits.chunkBytes, (payload.index + 1) * limits.chunkBytes));
        assert.equal(received.has(payload.index), false, "acknowledged part must not upload again");
        received.set(payload.index, { index: payload.index, size: body.length, sha256: payload.sha256 });
        if (lostAck) { lostAck = false; throw new Error("lost acknowledgement"); }
      }
      if (payload.action === "complete") return { ...status,
        sha256: createHash("sha256").update(bytes).digest("hex"), expiresAt: Date.now() + 10000 };
      return status;
    };
    const options = { file, metadata: { name: "file.zip", type: "application/zip" }, userId: "42", limits, request };
    await assert.rejects(publishChunkedAttachmentView(options), /lost acknowledgement/);
    const result = await publishChunkedAttachmentView(options);
    assert.equal(new Set(identities).size, 1);
    assert.equal(result.id, identities[0]);
    assert.equal(received.size, 3);
    assert.ok(peakBody < 2 * 1024 * 1024);
    await assert.rejects(publishChunkedAttachmentView({ ...options,
      request: async payload => payload.action === "complete"
        ? { uploadId: payload.uploadId, sha256: "0".repeat(64), expiresAt: Date.now() + 10000 }
        : request(payload),
    }), /not verified/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
