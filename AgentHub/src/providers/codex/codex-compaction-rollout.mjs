import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { readCodexRolloutTail } from "./codex-turn-usage.mjs";
import { isRawCompactionItem } from "./context-compaction-tracker.mjs";

const DEFAULT_COMPACTION_TAIL_BYTES = 64 * 1024 * 1024;

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
  createReadStreamImpl = createReadStream,
} = {}) {
  const path = String(rolloutPath ?? "").trim();
  if (!path) {
    throw new CodexCompactionBoundaryError("Не найден rollout исходного Thread", { reason: "rollout-missing" });
  }
  const collector = turnSuffixCollector(turnId, compactionItem);
  const input = createReadStreamImpl(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) collector.accept(line);
  } finally {
    lines.close();
    input.destroy?.();
  }
  return collector.finish();
}
