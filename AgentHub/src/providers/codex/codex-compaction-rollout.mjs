import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

import { assertCodexRolloutReadAllowed } from "../../infrastructure/filesystem/test-contour-rollout-policy.mjs";
import { readCodexRolloutTail } from "./codex-turn-usage.mjs";
import { isRawCompactionItem } from "./context-compaction-tracker.mjs";

const DEFAULT_COMPACTION_TAIL_BYTES = 64 * 1024 * 1024;
const BOUNDARY_INDEX_LIMIT = 16;
const SOURCE_ANCHOR_BYTES = 4096;
const boundaryIndexes = new Map();

// The provider writes this zero-billable estimate immediately after its native
// compacted record. App Server notifications can omit or reorder that update.
export function codexCompactionEstimateFromJsonl(text, { turnId, notBefore = "" } = {}) {
  const expectedTurn = String(turnId ?? "").trim();
  if (!expectedTurn) return null;
  const minimum = parsedTimestamp(notBefore);
  let currentTurn = "";
  let boundaries = 0;
  let boundaryAt = 0;
  let estimate = null;
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (!line || !/(?:"task_started"|"task_complete"|"token_count"|"type":"compacted")/u.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const kind = entry?.payload?.type;
    if (entry?.type === "event_msg" && kind === "task_started") {
      currentTurn = String(entry.payload.turn_id ?? "").trim();
      continue;
    }
    if (currentTurn !== expectedTurn) continue;
    if (entry?.type === "event_msg" && kind === "task_complete") {
      currentTurn = "";
      continue;
    }
    if (entry?.type === "compacted") {
      const at = parsedTimestamp(entry.timestamp);
      if (!at || (minimum && at < minimum)) continue;
      boundaries += 1;
      boundaryAt = at;
      estimate = null;
      continue;
    }
    if (boundaries !== 1 || estimate !== null || entry?.type !== "event_msg" || kind !== "token_count") continue;
    const observedAt = parsedTimestamp(entry.timestamp);
    if (!observedAt || observedAt < boundaryAt) continue;
    const info = entry.payload.info;
    const last = info?.last_token_usage;
    const window = Number(info?.model_context_window);
    const used = Number(last?.total_tokens);
    if (last?.total_tokens == null || !Number.isFinite(used) || used < 0
      || !Number.isFinite(window) || window <= 0
      || [last.input_tokens, last.cached_input_tokens, last.output_tokens,
        last.reasoning_output_tokens].some((value) => Number(value) !== 0)) continue;
    estimate = { usedTokens: used, modelContextWindow: window };
  }
  return boundaries === 1 ? estimate : null;
}

export async function readCodexCompactionEstimate(rolloutPath, options = {}) {
  if (!rolloutPath) return null;
  return codexCompactionEstimateFromJsonl(
    await readCodexRolloutTail(rolloutPath, { maxBytes: DEFAULT_COMPACTION_TAIL_BYTES }), options,
  );
}

// A cold activity projection may scan the entire rollout for image ownership.
// Rotation needs only native terminal evidence from this turn and any later
// active turn; an incomplete bounded tail fails closed.
export function codexTurnIdleFromJsonl(text, turnId) {
  const expected = String(turnId ?? "").trim();
  if (!expected) return false;
  const active = new Set();
  let starts = 0;
  let completions = 0;
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (!line || !/(?:"task_started"|"task_complete")/u.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "event_msg") continue;
    const kind = entry.payload?.type;
    const id = String(entry.payload?.turn_id ?? "").trim();
    if (!id) continue;
    if (kind === "task_started") {
      active.add(id);
      if (id === expected) starts += 1;
    } else if (kind === "task_complete") {
      active.delete(id);
      if (id === expected) completions += 1;
    }
  }
  return starts === 1 && completions === 1 && active.size === 0;
}

export async function readCodexTurnIdle(rolloutPath, turnId, {
  readTail = readCodexRolloutTail,
  maxBytes = DEFAULT_COMPACTION_TAIL_BYTES,
} = {}) {
  const path = String(rolloutPath ?? "").trim();
  if (!path) return false;
  return codexTurnIdleFromJsonl(await readTail(path, { maxBytes }), turnId);
}

function parsedTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function responseItemTurnId(item) {
  return String(
    item?.internal_chat_message_metadata_passthrough?.turn_id
      ?? item?.turn_id
      ?? "",
  ).trim();
}

function transferableResponseItem(item) {
  if (!item || typeof item !== "object" || isRawCompactionItem(item)) return null;
  const {
    internal_chat_message_metadata_passthrough: _metadata,
    turn_id: _turnId,
    ...transferable
  } = item;
  return transferable;
}

export function latestCodexCompactionItemFromJsonl(text, {
  notBefore = "",
} = {}) {
  const minimumTimestamp = parsedTimestamp(notBefore);
  let latest = null;
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (!line || !line.includes('"type":"compacted"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "compacted") continue;
    const timestamp = parsedTimestamp(entry.timestamp);
    if (minimumTimestamp && timestamp && timestamp < minimumTimestamp) continue;
    const replacement = Array.isArray(entry?.payload?.replacement_history)
      ? entry.payload.replacement_history
      : [];
    const item = replacement.findLast((candidate) => isRawCompactionItem(candidate));
    if (item) latest = item;
  }
  return latest;
}

export async function readLatestCodexCompactionItem(rolloutPath, {
  notBefore = "",
  readTail = readCodexRolloutTail,
  maxBytes = DEFAULT_COMPACTION_TAIL_BYTES,
} = {}) {
  const path = String(rolloutPath ?? "").trim();
  if (!path) return null;
  return latestCodexCompactionItemFromJsonl(
    await readTail(path, { maxBytes }),
    { notBefore },
  );
}

/* Ход, внутри которого случилась свёртка, переносится в новый Thread не
   целиком: всё, что он сделал до свёртки, уже представлено её результатом.
   Граница — та самая запись compacted, чей результат переносится. Если её нет
   или она не одна, перенос не доказан и должен сорваться до создания Thread. */
export class CodexCompactionBoundaryError extends Error {
  constructor(message, { reason, matches = 0 } = {}) {
    super(message);
    this.name = "CodexCompactionBoundaryError";
    this.code = "CODEX_COMPACTION_BOUNDARY";
    this.reason = reason;
    this.matches = matches;
  }
}

function compactionIdentity(item) {
  if (!isRawCompactionItem(item)) return "";
  const encrypted = String(item.encrypted_content ?? "");
  if (encrypted) return `encrypted:${encrypted}`;
  const {
    internal_chat_message_metadata_passthrough: _metadata,
    turn_id: _turnId,
    ...rest
  } = item;
  return `json:${JSON.stringify(rest)}`;
}

function boundaryHash(item) {
  const identity = compactionIdentity(item);
  return identity ? createHash("sha256").update(identity).digest("hex") : "";
}

function countCompactionBoundaries(line, counts, offsets, offset) {
  if (!line.includes('"type":"compacted"')) return;
  let entry;
  try { entry = JSON.parse(line); } catch {
    throw new CodexCompactionBoundaryError("Повреждена запись границы свёртки", {
      reason: "boundary-record-invalid",
    });
  }
  if (entry?.type !== "compacted") return;
  const replacement = Array.isArray(entry.payload?.replacement_history)
    ? entry.payload.replacement_history : [];
  for (const hash of new Set(replacement.map(boundaryHash).filter(Boolean))) {
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
    if (!offsets.has(hash)) offsets.set(hash, offset);
  }
}

function sameSource(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function sameSnapshot(left, right) {
  return sameSource(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function sourceAnchor(path, size) {
  const handle = await open(path, "r");
  try {
    const length = Math.min(size, SOURCE_ANCHOR_BYTES);
    const head = Buffer.alloc(length);
    const suffix = Buffer.alloc(length);
    const first = await handle.read(head, 0, length, 0);
    const last = await handle.read(suffix, 0, length, size - length);
    if (first.bytesRead !== length || last.bytesRead !== length) return null;
    return {
      head: createHash("sha256").update(head).digest("hex"),
      suffix: createHash("sha256").update(suffix).digest("hex"),
      complete: size === 0 || suffix.at(-1) === 0x0a,
    };
  } finally {
    await handle.close();
  }
}

function retainBoundaryIndex(cache, path, entry) {
  cache.delete(path);
  cache.set(path, entry);
  while (cache.size > BOUNDARY_INDEX_LIMIT) cache.delete(cache.keys().next().value);
}

function boundaryCountError(count) {
  return count > 1
    ? new CodexCompactionBoundaryError("Граница переносимой свёртки неоднозначна", {
      reason: "boundary-ambiguous", matches: count,
    })
    : new CodexCompactionBoundaryError("В rollout не найдена граница переносимой свёртки", {
      reason: "boundary-not-found",
    });
}

async function scanBoundaryLines(path, collector, counts, offsets, {
  start = 0, end, createReadStreamImpl = createReadStream,
} = {}) {
  if (end < start) return;
  const input = createReadStreamImpl(path, { start, end });
  let fragments = [];
  let fragmentBytes = 0;
  let nextOffset = start;
  let lineOffset = start;
  try {
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      let position = 0;
      let newline;
      while ((newline = chunk.indexOf(0x0a, position)) >= 0) {
        const piece = chunk.subarray(position, newline);
        const rawLine = fragments.length
          ? Buffer.concat([...fragments, piece], fragmentBytes + piece.length) : piece;
        const line = (rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine).toString("utf8");
        countCompactionBoundaries(line, counts, offsets, lineOffset);
        collector.accept(line);
        fragments = [];
        fragmentBytes = 0;
        position = newline + 1;
        lineOffset = nextOffset + position;
      }
      if (position < chunk.length) {
        fragments.push(chunk.subarray(position));
        fragmentBytes += chunk.length - position;
      }
      nextOffset += chunk.length;
    }
  } finally {
    input.destroy?.();
  }
  if (fragmentBytes || nextOffset !== end + 1) {
    throw new CodexCompactionBoundaryError("Rollout содержит незавершённую запись", {
      reason: "incomplete-jsonl",
    });
  }
}

function turnSuffixCollector(turnId, compactionItem) {
  const expectedTurnId = String(turnId ?? "").trim();
  const boundary = compactionIdentity(compactionItem);
  if (!expectedTurnId) {
    throw new CodexCompactionBoundaryError("Не указан ход для переноса", { reason: "missing-turn" });
  }
  if (!boundary) {
    throw new CodexCompactionBoundaryError("Не указана свёртка, от которой считать перенос", {
      reason: "missing-compaction",
    });
  }
  let matches = 0;
  const items = [];
  return {
    matchCount: () => matches,
    accept(line) {
      if (!line) return;
      const compacted = line.includes('"type":"compacted"');
      if (!compacted && !line.includes('"type":"response_item"')) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (entry?.type === "compacted") {
        const replacement = Array.isArray(entry?.payload?.replacement_history)
          ? entry.payload.replacement_history
          : [];
        if (replacement.some((candidate) => compactionIdentity(candidate) === boundary)) matches += 1;
        return;
      }
      if (entry?.type !== "response_item" || matches !== 1) return;
      if (responseItemTurnId(entry.payload) !== expectedTurnId) return;
      const item = transferableResponseItem(entry.payload);
      if (item) items.push(item);
    },
    finish() {
      if (matches === 0) {
        throw new CodexCompactionBoundaryError("В rollout не найдена граница переносимой свёртки", {
          reason: "boundary-not-found",
        });
      }
      if (matches > 1) {
        throw new CodexCompactionBoundaryError("Граница переносимой свёртки неоднозначна", {
          reason: "boundary-ambiguous",
          matches,
        });
      }
      return items;
    },
  };
}

export function codexTurnItemsAfterCompactionFromJsonl(text, turnId, compactionItem) {
  const collector = turnSuffixCollector(turnId, compactionItem);
  for (const line of String(text ?? "").split(/\r?\n/u)) collector.accept(line);
  return collector.finish();
}

export async function readCodexTurnItemsAfterCompaction(rolloutPath, turnId, compactionItem, {
  readTail = readCodexRolloutTail,
  maxBytes = DEFAULT_COMPACTION_TAIL_BYTES,
  createReadStreamImpl = createReadStream,
  statImpl = stat,
  readAnchor = sourceAnchor,
  indexCache = boundaryIndexes,
} = {}) {
  assertCodexRolloutReadAllowed("readCodexTurnItemsAfterCompaction");
  const path = String(rolloutPath ?? "").trim();
  if (!path) {
    throw new CodexCompactionBoundaryError("Не найден rollout исходного Thread", { reason: "rollout-missing" });
  }
  const boundedBytes = Math.max(1, Number(maxBytes) || DEFAULT_COMPACTION_TAIL_BYTES);
  const source = await statImpl(path);
  const targetHash = boundaryHash(compactionItem);
  if (!targetHash) turnSuffixCollector(turnId, compactionItem);
  if (source.size <= boundedBytes) {
    const text = await readTail(path, { maxBytes: boundedBytes });
    const observed = await statImpl(path);
    if (!sameSnapshot(source, observed)) throw changedSourceError();
    if (!text.endsWith("\n")) {
      throw new CodexCompactionBoundaryError("Rollout содержит незавершённую запись", {
        reason: "incomplete-jsonl",
      });
    }
    return codexTurnItemsAfterCompactionFromJsonl(text, turnId, compactionItem);
  }

  // Codex's native recorder opens a rollout for append and writes complete
  // JSONL records. Under that writer contract, the process-local index reuses
  // a fully scanned prefix only for the same file generation and matching
  // bounded anchors. An external interior rewrite that also forges provenance
  // cannot be proved absent without rehashing the entire prefix.
  let indexed = indexCache.get(path);
  if (indexed) {
    const oldAnchor = await readAnchor(path, indexed.source.size).catch(() => null);
    const reusable = sameSource(indexed.source, source)
      && source.size >= indexed.source.size
      && (source.size > indexed.source.size || sameSnapshot(indexed.source, source))
      && oldAnchor?.complete === true
      && oldAnchor.head === indexed.anchor.head
      && oldAnchor.suffix === indexed.anchor.suffix;
    if (!reusable) {
      indexCache.delete(path);
      indexed = null;
    }
  }

  let directCollector = null;
  if (indexed && source.size > indexed.source.size) {
    const counts = new Map(indexed.counts);
    const offsets = new Map(indexed.offsets);
    directCollector = turnSuffixCollector(turnId, compactionItem);
    await scanBoundaryLines(path, directCollector, counts, offsets, {
      start: indexed.source.size, end: source.size - 1, createReadStreamImpl,
    });
    const anchor = await stableSourceAnchor(path, source, { statImpl, readAnchor });
    indexed = { source, anchor, counts, offsets };
    retainBoundaryIndex(indexCache, path, indexed);
  } else if (!indexed) {
    const counts = new Map();
    const offsets = new Map();
    directCollector = turnSuffixCollector(turnId, compactionItem);
    await scanBoundaryLines(path, directCollector, counts, offsets, {
      end: source.size - 1, createReadStreamImpl,
    });
    const anchor = await stableSourceAnchor(path, source, { statImpl, readAnchor });
    indexed = { source, anchor, counts, offsets };
    retainBoundaryIndex(indexCache, path, indexed);
  }

  const count = indexed.counts.get(targetHash) ?? 0;
  if (count !== 1) throw boundaryCountError(count);
  let items;
  if (directCollector?.matchCount() === 1) {
    items = directCollector.finish();
  } else {
    const tailCollector = turnSuffixCollector(turnId, compactionItem);
    for (const line of (await readTail(path, { maxBytes: boundedBytes })).split(/\r?\n/u)) {
      tailCollector.accept(line);
    }
    if (tailCollector.matchCount() === 1) {
      items = tailCollector.finish();
    } else {
      const offset = indexed.offsets.get(targetHash);
      if (!Number.isSafeInteger(offset)) throw boundaryCountError(0);
      const suffixCollector = turnSuffixCollector(turnId, compactionItem);
      await scanBoundaryLines(path, suffixCollector, new Map(), new Map(), {
        start: offset, end: source.size - 1, createReadStreamImpl,
      });
      items = suffixCollector.finish();
    }
  }
  await stableSourceAnchor(path, source, { statImpl, readAnchor });
  return items;
}

function changedSourceError() {
  return new CodexCompactionBoundaryError("Источник свёртки изменился во время проверки", {
    reason: "source-changed",
  });
}

async function stableSourceAnchor(path, source, { statImpl, readAnchor }) {
  const anchor = await readAnchor(path, source.size);
  const observed = await statImpl(path);
  if (!anchor?.complete) {
    throw new CodexCompactionBoundaryError("Rollout содержит незавершённую запись", {
      reason: "incomplete-jsonl",
    });
  }
  if (!sameSnapshot(source, observed)) throw changedSourceError();
  return anchor;
}
