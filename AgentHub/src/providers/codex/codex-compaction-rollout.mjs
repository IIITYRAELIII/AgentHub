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

export function codexTurnResponseItemsFromJsonl(text, turnId) {
  const expectedTurnId = String(turnId ?? "").trim();
  if (!expectedTurnId) return [];
  const items = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (!line || !line.includes('"type":"response_item"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "response_item" || responseItemTurnId(entry.payload) !== expectedTurnId) {
      continue;
    }
    const item = transferableResponseItem(entry.payload);
    if (item) items.push(item);
  }
  return items;
}

export async function readCodexTurnResponseItems(rolloutPath, turnId, {
  createReadStreamImpl = createReadStream,
} = {}) {
  const path = String(rolloutPath ?? "").trim();
  const expectedTurnId = String(turnId ?? "").trim();
  if (!path || !expectedTurnId) return [];
  const input = createReadStreamImpl(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const items = [];
  try {
    for await (const line of lines) {
      if (!line || !line.includes('"type":"response_item"')) continue;
      const parsed = codexTurnResponseItemsFromJsonl(line, expectedTurnId);
      if (parsed.length) items.push(...parsed);
    }
  } finally {
    lines.close();
    input.destroy?.();
  }
  return items;
}
