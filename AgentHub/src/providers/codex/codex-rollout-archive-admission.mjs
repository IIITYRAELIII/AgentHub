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

// Node's streaming Zstandard decoder can finish successfully on a truncated
// final frame. Walk only the frame/block lengths (RFC 8878); zlib decodes the data.
async function* completeZstdFrames(chunks) {
  const widths = { magic: 4, descriptor: 1, skippable: 4, block: 3 };
  const header = Buffer.alloc(4);
  let field = "magic", used = 0, skip = 0, checksum = 0, sawFrame = false;
  for await (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length;) {
      if (skip) {
        const count = Math.min(skip, chunk.length - offset);
        offset += count;
        skip -= count;
        continue;
      }
      const width = widths[field];
      const count = Math.min(width - used, chunk.length - offset);
      chunk.copy(header, used, offset, offset + count);
      offset += count;
      used += count;
      if (used !== width) continue;
      used = 0;
      if (field === "magic") {
        const magic = header.readUInt32LE();
        if (magic === 0xfd2fb528) {
          sawFrame = true;
          field = "descriptor";
        } else if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
          field = "skippable";
        } else throw invalidArchive();
      } else if (field === "descriptor") {
        const descriptor = header[0];
        const singleSegment = Boolean(descriptor & 32);
        const contentSizeFlag = descriptor >> 6;
        checksum = descriptor & 4;
        skip = (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]
          + (contentSizeFlag ? 1 << contentSizeFlag : Number(singleSegment));
        field = "block";
      } else if (field === "skippable") {
        skip = header.readUInt32LE();
        field = "magic";
      } else {
        const block = header.readUIntLE(0, 3);
        const type = (block >> 1) & 3;
        if (type === 3) throw invalidArchive();
        skip = type === 1 ? 1 : block >> 3;
        if (block & 1) {
          skip += checksum;
          field = "magic";
        }
      }
    }
    yield chunk;
  }
  if (!sawFrame || field !== "magic" || used || skip) throw invalidArchive();
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
  await pipeline(createReadStream(archivePath), completeZstdFrames, zlib.createZstdDecompress(), async (chunks) => {
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
    if (!identified) throw invalidArchive();
  }, { signal });
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
      if (error.code === "ABORT_ERR") {
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
