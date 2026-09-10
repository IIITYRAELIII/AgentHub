import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { attachmentContentType, attachmentIsImage, createAttachmentStorageName,
  imageMatchesContentType } from "../../domain/attachment-files.mjs";

const PROTOCOL = "agent-hub-attachment-chunks-v1";
const CHUNK_BYTES = 16 * 1024;
const PAGE_CHUNKS = 128;
const HASH = /^[a-f0-9]{64}$/u;

export async function readAttachmentResponse(response, maxBytes, timeoutMs = 60_000) {
  if (!response.ok) throw new Error(`Attachment transport HTTP ${response.status}`);
  const advertised = response.headers.get("Content-Length");
  if (advertised != null && (!Number.isSafeInteger(Number(advertised))
    || Number(advertised) < 0 || Number(advertised) > maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Attachment response exceeds its byte bound");
  }
  if (!response.body) throw new Error("Attachment response has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Attachment body timed out")), timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Attachment response exceeds its byte bound");
      chunks.push(Buffer.from(value));
    }
    if (advertised != null && size !== Number(advertised)) throw new Error("Incomplete attachment body");
    return Buffer.concat(chunks, size);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function manifestPage(response, id, pageIndex, maxBytes, first) {
  const page = JSON.parse((await readAttachmentResponse(response, 24 * 1024)).toString("utf8"));
  if (page?.protocol !== PROTOCOL || page.id !== id || page.page !== pageIndex
    || page.chunkBytes !== CHUNK_BYTES || !Number.isSafeInteger(page.size)
    || page.size < 1 || page.size > maxBytes || !HASH.test(page.hash ?? "")
    || page.count !== Math.ceil(page.size / CHUNK_BYTES)
    || page.pageCount !== Math.ceil(page.count / PAGE_CHUNKS)
    || typeof page.name !== "string" || !page.name || page.name.length > 255
    || typeof page.contentType !== "string" || page.contentType.length > 255
    || !Array.isArray(page.chunks)
    || page.chunks.length !== Math.min(PAGE_CHUNKS, page.count - pageIndex * PAGE_CHUNKS)) {
    throw new Error("Invalid attachment manifest");
  }
  if (first && ["size", "hash", "count", "pageCount", "name", "contentType"].some(key => page[key] !== first[key])) {
    throw new Error("Conflicting attachment manifest pages");
  }
  for (const [offset, descriptor] of page.chunks.entries()) {
    const index = pageIndex * PAGE_CHUNKS + offset;
    if (descriptor?.index !== index || descriptor.size !== Math.min(CHUNK_BYTES, page.size - index * CHUNK_BYTES)
      || !HASH.test(descriptor.hash ?? "")) throw new Error("Invalid attachment chunk order or size");
  }
  return page;
}

async function matchesFile(target, size, hash) {
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size !== size) throw new Error("Local attachment id conflict");
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(target, { highWaterMark: 64 * 1024 })) digest.update(bytes);
    if (digest.digest("hex") !== hash) throw new Error("Local attachment id conflict");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// One bounded manifest page is in memory; accepted files are never overwritten.
export async function downloadChunkedAttachment({ firstResponse, request, id, commandId, directory, maxBytes }) {
  const first = await manifestPage(firstResponse, id, 0, maxBytes);
  const target = path.join(directory, createAttachmentStorageName(first.name, `${commandId}-${id}`));
  await mkdir(directory, { recursive: true });
  if (await matchesFile(target, first.size, first.hash)) return target;
  const temporary = path.join(directory, `.${id}-${randomUUID()}.download`);
  const file = await open(temporary, "wx", 0o600);
  const digest = createHash("sha256");
  let total = 0;
  let prefix;
  try {
    for (let pageIndex = 0; pageIndex < first.pageCount; pageIndex += 1) {
      const page = pageIndex === 0 ? first : await manifestPage(
        await request({ mode: "manifest", page: pageIndex }), id, pageIndex, maxBytes, first,
      );
      const bodies = new Array(page.chunks.length);
      let next = 0;
      let failure;
      await Promise.allSettled(Array.from({ length: Math.min(4, bodies.length) }, async () => {
        while (!failure) {
          const slot = next++;
          if (slot >= bodies.length) return;
          try {
            const descriptor = page.chunks[slot];
            const response = await request({ mode: "chunk", index: descriptor.index });
            if (response.headers.get("X-Agent-Hub-Attachment-Protocol") !== PROTOCOL
              || response.headers.get("X-Agent-Hub-Attachment-Id") !== id
              || response.headers.get("X-Agent-Hub-Attachment-Hash") !== first.hash
              || Number(response.headers.get("X-Agent-Hub-Chunk-Index")) !== descriptor.index
              || Number(response.headers.get("X-Agent-Hub-Chunk-Count")) !== first.count
              || response.headers.get("X-Agent-Hub-Chunk-Hash") !== descriptor.hash
              || Number(response.headers.get("Content-Length")) !== descriptor.size) {
              void response.body?.cancel().catch(() => {});
              throw new Error("Conflicting attachment chunk identity");
            }
            const body = await readAttachmentResponse(response, CHUNK_BYTES);
            if (body.length !== descriptor.size || createHash("sha256").update(body).digest("hex") !== descriptor.hash) {
              throw new Error("Damaged attachment chunk");
            }
            bodies[slot] = body;
          } catch (error) { failure ??= error; }
        }
      }));
      if (failure) throw failure;
      for (const body of bodies) {
        prefix ??= body.subarray(0, 12);
        digest.update(body);
        let written = 0;
        while (written < body.length) {
          const result = await file.write(body, written, body.length - written);
          if (!result.bytesWritten) throw new Error("Attachment write made no progress");
          written += result.bytesWritten;
        }
        total += body.length;
      }
    }
    const type = attachmentContentType(first.name, first.contentType);
    if (total !== first.size || digest.digest("hex") !== first.hash
      || (attachmentIsImage(type) && !imageMatchesContentType(prefix, type))) {
      throw new Error("Damaged complete attachment");
    }
    await file.sync();
    await file.close();
    try { await link(temporary, target); }
    catch (error) {
      if (error.code !== "EEXIST" || !await matchesFile(target, first.size, first.hash)) throw error;
    }
    return target;
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
