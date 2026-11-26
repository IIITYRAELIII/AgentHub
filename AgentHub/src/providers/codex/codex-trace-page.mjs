import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertCodexRolloutReadAllowed } from "../../infrastructure/filesystem/test-contour-rollout-policy.mjs";
import { codexTraceEntry, rolloutObservationGeneration } from "./codex-rollout-activity.mjs";
import { IgnoredTraceRecord } from "./codex-trace-record.mjs";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const PAGE_BYTES = 512 * 1024;
const PAGE_ITEMS = 50;
const PAGE_CHUNK_BYTES = 64 * 1024;
const HASH_CHUNK_BYTES = 512 * 1024;
const EXACT_PREFIX_LIMIT = 4;
const EXACT_PREFIX_GROUPS = 256;
const EXACT_PREFIX_GROUP_BYTES = 1024 * 1024;
const exactPrefixes = new Map();

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

async function verifyExactPrefix(file, before, source, size) {
  let candidate;
  for (const prefix of exactPrefixes.values()) {
    if (prefix.source === source && prefix.size <= size && sameFile(prefix.file, before)
      && (!candidate || prefix.size > candidate.size)) candidate = prefix;
  }
  if (!candidate) return null;
  // File metadata can rule out reuse. Only the digest of the actual bytes
  // permits skipping the parser, including for a rollout that has grown.
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, candidate.size));
  for (let offset = 0; offset < candidate.size;) {
    const length = Math.min(buffer.length, candidate.size - offset);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    if (!bytesRead) throw new Error("Trace source changed during read");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (hash.copy().digest("hex") !== candidate.sourceHash) return null;
  return { candidate, hash };
}

function retainExactPrefix(prefix) {
  const key = JSON.stringify([prefix.source, prefix.size]);
  exactPrefixes.delete(key);
  exactPrefixes.set(key, prefix);
  if (exactPrefixes.size > EXACT_PREFIX_LIMIT) exactPrefixes.delete(exactPrefixes.keys().next().value);
}

// Explicit detail reads run in the rollout worker, never during polling.
export async function readCodexTracePage(rolloutPath, request = {}) {
  assertCodexRolloutReadAllowed("readCodexTracePage");
  const turnId = String(request.turnId ?? "").trim();
  const offset = request.offset ?? 0;
  const groupId = String(request.groupId ?? "");
  if (!turnId || turnId.length > 300 || !Number.isSafeInteger(offset) || offset < 0
    || offset > 1_000_000 || groupId.length > 300) throw new Error("Invalid trace page identity");
  const file = await open(rolloutPath, "r");
  try {
    return await readTracePrefix(file, rolloutPath, request, { turnId, offset, groupId });
  } finally {
    await file.close();
  }
}

async function readTracePrefix(file, rolloutPath, request, { turnId, offset, groupId }) {
  const before = await file.stat();
  const generation = await rolloutObservationGeneration(rolloutPath, before);
  if (!generation) throw new Error("Trace source identity unavailable");
  const size = request.sourceSize ?? before.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > before.size
    || (request.generation && request.generation !== generation)) throw new Error("Trace source changed");
  const source = groupId ? JSON.stringify([rolloutPath, generation, turnId]) : null;
  const verified = source && await verifyExactPrefix(file, before, source, size);
  const prefix = verified?.candidate;
  const hash = verified?.hash ?? createHash("sha256");
  const start = prefix?.size ?? 0;
  let endedAtNewline = Boolean(prefix);
  let prefixGroups = source ? prefix?.groups.slice() ?? [] : null;
  let prefixGroupBytes = prefix?.groupBytes ?? 0;
  let pending = [];
  let pendingBytes = 0;
  let ignoredRecord = null;
  let currentTurnId = prefix?.currentTurnId ?? "";
  let sequence = prefix?.sequence ?? 0;
  let position = prefix?.groups.length ?? 0;
  let bytes = 0;
  let nextOffset = null;
  let pageFull = false;
  const groups = [];

  function collectGroup(group, index, measuredBytes = null) {
    if (pageFull || (groupId ? group.id !== groupId : index < offset)) return;
    const groupBytes = measuredBytes ?? Buffer.byteLength(JSON.stringify(group));
    if (groupBytes > PAGE_BYTES) throw new Error("Trace block exceeds transport budget; source was not truncated");
    if (groups.length >= PAGE_ITEMS || bytes + groupBytes > PAGE_BYTES) {
      nextOffset = index;
      pageFull = true;
      return;
    }
    groups.push(group);
    bytes += groupBytes;
  }

  prefix?.groups.forEach(({ group, bytes }, index) => collectGroup(group, index, bytes));
  const chunks = start < size ? file.createReadStream({
    start, end: size - 1, highWaterMark: PAGE_CHUNK_BYTES, autoClose: false,
  }) : [];
  let scanned = start;
  for await (const chunk of chunks) {
    hash.update(chunk);
    scanned += chunk.length;
    endedAtNewline = chunk.at(-1) === 10;
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(cursor, end);
      if (!ignoredRecord && pendingBytes + fragment.length > MAX_LINE_BYTES) {
        ignoredRecord = new IgnoredTraceRecord(MAX_LINE_BYTES);
        for (const part of pending) ignoredRecord.push(part);
        pending = [];
        pendingBytes = 0;
      }
      if (ignoredRecord) {
        ignoredRecord.push(fragment);
      } else if (fragment.length) {
        pending.push(fragment);
        pendingBytes += fragment.length;
      }
      cursor = newline < 0 ? chunk.length : newline + 1;
      if (newline < 0) continue;
      if (ignoredRecord) {
        ignoredRecord.finish();
        ignoredRecord = null;
        continue;
      }
      const record = pending.length <= 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      const json = record?.toString("utf8");
      if (!json?.trim()) continue;
      let entry;
      try { entry = JSON.parse(json); }
      catch { throw new Error("Trace source contains an invalid record"); }
      if (entry.type === "event_msg" && entry.payload?.type === "task_started") {
        currentTurnId = String(entry.payload.turn_id ?? "");
      }
      const exactTurn = String(entry.payload?.internal_chat_message_metadata_passthrough?.turn_id
        ?? entry.payload?.turn_id ?? currentTurnId);
      if (exactTurn !== turnId) continue;
      const group = codexTraceEntry(entry, sequence);
      if (!group) continue;
      if (group.reasoning) sequence += 1;
      let groupBytes = null;
      if (prefixGroups) {
        groupBytes = Buffer.byteLength(JSON.stringify(group));
        prefixGroupBytes += groupBytes;
        if (prefixGroups.length === EXACT_PREFIX_GROUPS || prefixGroupBytes > EXACT_PREFIX_GROUP_BYTES) {
          prefixGroups = null;
        } else {
          prefixGroups.push({ group, bytes: groupBytes });
        }
      }
      collectGroup(group, position++, groupBytes);
    }
  }
  if (scanned !== size) throw new Error("Trace source changed during read");
  if (ignoredRecord) throw new Error("Trace source contains an incomplete record");
  const sourceHash = hash.digest("hex");
  if (request.sourceHash && request.sourceHash !== sourceHash) throw new Error("Trace source prefix changed");
  const after = await stat(rolloutPath);
  if (after.size < before.size || !sameFile(after, before)
    || (after.size === before.size && after.mtimeMs !== before.mtimeMs)
    || generation !== await rolloutObservationGeneration(rolloutPath, after)) throw new Error("Trace source changed during read");
  // Exact-ID lookups reject repeated provider IDs rather than guessing which
  // occurrence a citation meant. Ordinary browsing preserves both records.
  if (groupId && (groups.length !== 1 || nextOffset !== null)) throw new Error("Trace block is missing or ambiguous");
  if (prefixGroups && endedAtNewline) {
    retainExactPrefix({ source, size, sourceHash, file: before, groups: prefixGroups,
      groupBytes: prefixGroupBytes, currentTurnId, sequence });
  }
  return { turnId, generation, sourceSize: size, sourceHash, offset, nextOffset,
    groups: groupId ? structuredClone(groups) : groups };
}
