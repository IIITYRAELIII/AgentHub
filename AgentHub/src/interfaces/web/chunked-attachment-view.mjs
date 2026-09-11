import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export async function publishChunkedAttachmentView({ file, metadata, userId, request, limits }) {
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > limits.maxBytes) {
      throw new Error("Attachment exceeds the configured file limit");
    }
    const buffer = Buffer.allocUnsafe(limits.chunkBytes);
    const digest = createHash("sha256");
    for (let offset = 0; offset < before.size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new Error("Attachment changed during publication");
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const sha256 = digest.digest("hex");
    const identity = createHash("sha256").update(JSON.stringify([String(userId), metadata.name, metadata.type, sha256])).digest();
    identity[6] = (identity[6] & 15) | 80;
    identity[8] = (identity[8] & 63) | 128;
    const hex = identity.subarray(0, 16).toString("hex");
    const uploadId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const shared = { userId: String(userId), uploadId };
    const begun = await request({ ...shared, action: "begin", name: metadata.name, type: metadata.type, size: before.size });
    if (begun.protocol !== limits.protocol || begun.uploadId !== uploadId || begun.chunkBytes !== limits.chunkBytes) {
      throw new Error("Unsupported attachment upload protocol");
    }
    const received = new Map((begun.received ?? []).map(part => [part.index, part]));
    for (let index = 0, offset = 0; offset < before.size; index += 1) {
      const size = Math.min(buffer.length, before.size - offset);
      let filled = 0;
      while (filled < size) {
        const { bytesRead } = await handle.read(buffer, filled, size - filled, offset + filled);
        if (!bytesRead) throw new Error("Attachment changed during publication");
        filled += bytesRead;
      }
      const bytes = buffer.subarray(0, size);
      const partHash = createHash("sha256").update(bytes).digest("hex");
      const existing = received.get(index);
      if (existing && (existing.size !== size || existing.sha256 !== partHash)) {
        throw new Error("Attachment upload identity conflict");
      }
      if (!existing) await request({ ...shared, action: "chunk", index,
        sha256: partHash, dataBase64: bytes.toString("base64") });
      offset += size;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      throw new Error("Attachment changed during publication");
    }
    const result = await request({ ...shared, action: "complete" });
    if (result.uploadId !== uploadId || result.sha256 !== sha256 || !Number.isFinite(result.expiresAt)) {
      throw new Error("Attachment publication was not verified");
    }
    return { id: uploadId, name: metadata.name, type: metadata.type, expiresAt: result.expiresAt };
  } finally { await handle.close(); }
}
