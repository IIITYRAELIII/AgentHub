import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

const INVALID = "ERR_CODEX_ARCHIVE_INVALID";
const WRONG_THREAD = "ERR_CODEX_ARCHIVE_IDENTITY";
const MAX_SESSION_META_BYTES = 256 * 1024;
const validatedArchives = new Map();

function invalidArchive(code = INVALID) {
  return Object.assign(new Error("Invalid Codex rollout archive"), { code });
}

// Node can stop after the first Zstandard frame, and its stream does not
// reliably reject a truncated footer. Feed zlib one complete RFC 8878 frame
// at a time, streaming each block and skipping only declared skippable frames.
function compressedInput(stream) {
  const source = stream[Symbol.asyncIterator]();
  let chunk = Buffer.alloc(0);
  let offset = 0;
  async function hasBytes() {
    while (offset === chunk.length) {
      const next = await source.next();
      if (next.done) return false;
      chunk = next.value;
      offset = 0;
    }
    return true;
  }
  async function* take(length) {
    while (length > 0) {
      if (!await hasBytes()) throw invalidArchive();
      const count = Math.min(length, chunk.length - offset);
      const part = chunk.subarray(offset, offset + count);
      offset += count;
      length -= count;
      yield part;
    }
  }
  async function header(length, allowEof = false) {
    if (allowEof && !await hasBytes()) return null;
    const buffer = Buffer.alloc(length);
    let written = 0;
    for await (const part of take(length)) written += part.copy(buffer, written);
    return buffer;
  }
  return { header, take };
}

async function* compressedFrame(input, magic) {
  const descriptor = await input.header(1);
  const singleSegment = Boolean(descriptor[0] & 32);
  const contentSizeFlag = descriptor[0] >> 6;
  const checksumLength = descriptor[0] & 4;
  const headerLength = (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor[0] & 3]
    + (contentSizeFlag ? 1 << contentSizeFlag : Number(singleSegment));
  yield magic;
  yield descriptor;
  yield* input.take(headerLength);
  for (;;) {
    const blockHeader = await input.header(3);
    const block = blockHeader.readUIntLE(0, 3);
    const type = (block >> 1) & 3;
    if (type === 3) throw invalidArchive();
    yield blockHeader;
    yield* input.take(type === 1 ? 1 : block >> 3);
    if (block & 1) break;
  }
  yield* input.take(checksumLength);
}

async function decodeCompleteArchive(archivePath, consume, signal) {
  const stream = createReadStream(archivePath, { signal });
  const input = compressedInput(stream);
  try {
    let magic;
    while ((magic = await input.header(4, true))) {
      const marker = magic.readUInt32LE();
      if (marker === 0xfd2fb528) {
        await pipeline(compressedFrame(input, magic), zlib.createZstdDecompress(), consume, { signal });
      } else if (marker >= 0x184d2a50 && marker <= 0x184d2a5f) {
        const skip = (await input.header(4)).readUInt32LE();
        for await (const _part of input.take(skip)) { /* No decompressed content. */ }
      } else throw invalidArchive();
    }
  } finally {
    stream.destroy();
  }
}

function fileGeneration(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

async function validateArchive(archivePath, threadId, deadlineAt) {
  const remaining = Math.ceil(deadlineAt - (performance.timeOrigin + performance.now()));
  const signal = Number.isFinite(remaining) ? AbortSignal.timeout(Math.max(0, remaining)) : undefined;
  const head = Buffer.alloc(MAX_SESSION_META_BYTES);
  let used = 0;
  let identified = false;
  await decodeCompleteArchive(archivePath, async (chunks) => {
    for await (const chunk of chunks) {
      if (identified) continue;
      const newline = chunk.indexOf(10);
      const length = newline < 0 ? chunk.length : newline;
      if (used + length > head.length) throw invalidArchive();
      chunk.copy(head, used, 0, length);
      used += length;
      if (newline < 0) continue;
      let meta;
      try { meta = JSON.parse(head.toString("utf8", 0, used)); } catch { throw invalidArchive(); }
      if (meta?.type !== "session_meta") throw invalidArchive();
      if ((meta.payload?.id ?? meta.payload?.session_id) !== threadId) throw invalidArchive(WRONG_THREAD);
      identified = true;
    }
  }, signal);
  if (!identified) throw invalidArchive();
}

export function plainCodexAdmissionPath(rolloutPath) {
  return /\.jsonl\.zst$/iu.test(rolloutPath) ? rolloutPath.slice(0, -4) : rolloutPath;
}

export async function readCodexArchiveAdmission(rolloutPath, threadId, deadlineAt) {
  const archivePath = `${rolloutPath}.zst`;
  let info;
  try { info = await stat(archivePath, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return { sourceUnavailable: true, sourceIssue: "missing" };
    throw error;
  }
  const unavailable = (sourceIssue) => ({ sourceKind: "compressed", sourceUnavailable: true, sourceIssue });
  if (!info.isFile() || info.size === 0n) return unavailable("invalid");
  if (typeof zlib.createZstdDecompress !== "function") return unavailable("decoder-unavailable");
  const generation = fileGeneration(info);
  const key = `${archivePath}\0${threadId}`;
  const cached = validatedArchives.get(key);
  let issue = cached?.generation === generation ? cached.issue : null;
  const scanBytes = cached?.generation === generation ? 0 : Number(info.size);
  if (cached?.generation !== generation) {
    try { await validateArchive(archivePath, threadId, deadlineAt); }
    catch (error) {
      if (error.code === "ABORT_ERR" && performance.timeOrigin + performance.now() >= deadlineAt) {
        throw Object.assign(new Error("Deferred archive read timed out"), { code: "ERR_DEFERRED_ACTIVITY_TIMEOUT" });
      }
      if (error.code === WRONG_THREAD) issue = "thread-mismatch";
      else if (error.code === INVALID || /^(?:ZSTD_|ERR_ZSTD)/u.test(error.code ?? "")) issue = "invalid";
      else if (error.code === "ENOENT") return unavailable("changed");
      else throw error;
    }
    const after = await stat(archivePath, { bigint: true }).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!after || fileGeneration(after) !== generation) return unavailable("changed");
    validatedArchives.set(key, { generation, issue });
    if (validatedArchives.size > 100) validatedArchives.delete(validatedArchives.keys().next().value);
  }
  if (issue) return { ...unavailable(issue), scanBytes };
  return { sourceKind: "compressed", sourceGeneration: generation, rolloutPath, archivePath, scanBytes };
}
