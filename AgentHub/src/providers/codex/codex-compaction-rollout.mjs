import { readCodexRolloutTail } from "./codex-turn-usage.mjs";
import { isRawCompactionItem } from "./context-compaction-tracker.mjs";

const DEFAULT_COMPACTION_TAIL_BYTES = 64 * 1024 * 1024;

function parsedTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
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
