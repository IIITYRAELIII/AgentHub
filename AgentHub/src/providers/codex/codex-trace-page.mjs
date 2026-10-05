import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertCodexRolloutReadAllowed } from "../../infrastructure/filesystem/test-contour-rollout-policy.mjs";
import { codexTraceEntry, rolloutObservationGeneration } from "./codex-rollout-activity.mjs";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const PAGE_BYTES = 512 * 1024;
const PAGE_ITEMS = 50;

// Explicit detail reads run in the rollout worker, never during polling. Scan
// a fixed prefix with bounded buffers; retain only the requested page. The
// source stays authoritative and no detailed history cache is introduced.
export async function readCodexTracePage(rolloutPath, request = {}) {
  assertCodexRolloutReadAllowed("readCodexTracePage");
  const turnId = String(request.turnId ?? "").trim();
  const offset = request.offset ?? 0;
  const groupId = String(request.groupId ?? "");
  if (!turnId || turnId.length > 300 || !Number.isSafeInteger(offset) || offset < 0
    || offset > 1_000_000 || groupId.length > 300) throw new Error("Invalid trace page identity");
  const before = await stat(rolloutPath);
  const generation = await rolloutObservationGeneration(rolloutPath, before);
  if (!generation) throw new Error("Trace source identity unavailable");
  const size = request.sourceSize ?? before.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > before.size
    || (request.generation && request.generation !== generation)) throw new Error("Trace source changed");
  const stream = createReadStream(rolloutPath, { start: 0, end: Math.max(0, size - 1), highWaterMark: 64 * 1024 });
  let pending = Buffer.alloc(0);
  let currentTurnId = "";
  let sequence = 0;
  let position = 0;
  let bytes = 0;
  let nextOffset = null;
  let pageFull = false;
  const groups = [];
  const hash = createHash("sha256");
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(10, cursor);
        const end = newline < 0 ? chunk.length : newline;
        const fragment = chunk.subarray(cursor, end);
        if (pending.length + fragment.length > MAX_LINE_BYTES) throw new Error("Trace record exceeds read budget");
        pending = pending.length ? Buffer.concat([pending, fragment]) : Buffer.from(fragment);
        cursor = newline < 0 ? chunk.length : newline + 1;
        if (newline < 0) continue;
        if (!pending.toString("utf8").trim()) { pending = Buffer.alloc(0); continue; }
        let entry;
        try { entry = JSON.parse(pending.toString("utf8")); }
        catch { throw new Error("Trace source contains an invalid record"); }
        pending = Buffer.alloc(0);
        if (entry.type === "event_msg" && entry.payload?.type === "task_started") {
          currentTurnId = String(entry.payload.turn_id ?? "");
        }
        const exactTurn = String(entry.payload?.internal_chat_message_metadata_passthrough?.turn_id
          ?? entry.payload?.turn_id ?? currentTurnId);
        if (exactTurn !== turnId) continue;
        const group = codexTraceEntry(entry, sequence);
        if (!group) continue;
        if (group.reasoning) sequence += 1;
        const index = position++;
        if (pageFull) continue;
        if (groupId ? group.id !== groupId : index < offset) continue;
        const groupBytes = Buffer.byteLength(JSON.stringify(group));
        if (groupBytes > PAGE_BYTES) throw new Error("Trace block exceeds transport budget; source was not truncated");
        if (groups.length >= PAGE_ITEMS || bytes + groupBytes > PAGE_BYTES) {
          nextOffset = index;
          pageFull = true;
          continue;
        }
        groups.push(group);
        bytes += groupBytes;
      }
    }
  } finally { stream.destroy(); }
  const sourceHash = hash.digest("hex");
  if (request.sourceHash && request.sourceHash !== sourceHash) throw new Error("Trace source prefix changed");
  const after = await stat(rolloutPath);
  if (after.size < before.size || after.ino !== before.ino
    || (after.size === before.size && after.mtimeMs !== before.mtimeMs)
    || generation !== await rolloutObservationGeneration(rolloutPath, after)) throw new Error("Trace source changed during read");
  // Exact-ID lookups reject repeated provider IDs rather than guessing which
  // occurrence a citation meant. Ordinary browsing preserves both records.
  if (groupId && (groups.length !== 1 || nextOffset !== null)) throw new Error("Trace block is missing or ambiguous");
  return { turnId, generation, sourceSize: size, sourceHash, offset, nextOffset, groups };
}
