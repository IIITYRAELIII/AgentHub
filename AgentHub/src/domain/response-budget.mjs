const ELLIPSIS = "\n…[усечено по лимиту транспорта]";

export class TaskHistoryResponseBudgetError extends Error {
  constructor(maxBytes) {
    super(`История превышает лимит транспорта ${maxBytes} байт даже после усечения`);
    this.name = "TaskHistoryResponseBudgetError";
    this.code = "TASK_HISTORY_RESPONSE_BUDGET_EXCEEDED";
    this.maxBytes = maxBytes;
  }
}

export function utf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

export function truncateUtf8(value, maxBytes, suffix = ELLIPSIS) {
  const text = String(value ?? "");
  const limit = Math.max(0, Math.trunc(Number(maxBytes) || 0));
  if (utf8ByteLength(text) <= limit) return text;
  const suffixBytes = utf8ByteLength(suffix);
  if (limit <= suffixBytes) return Buffer.from(text, "utf8").subarray(0, limit).toString("utf8").replace(/\uFFFD$/u, "");
  const source = Buffer.from(text, "utf8");
  let end = limit - suffixBytes;
  while (end > 0 && (source[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${source.subarray(0, end).toString("utf8")}${suffix}`;
}

function textSlots(payload) {
  const slots = [];
  for (const item of payload.items ?? []) {
    for (const key of ["prompt", "answer"]) {
      if (typeof item[key] === "string") {
        slots.push({ read: () => item[key], write: (value) => { item[key] = value; } });
      }
    }
    for (const message of item.messages ?? []) {
      if (typeof message.text === "string") {
        slots.push({ read: () => message.text, write: (value) => { message.text = value; } });
      }
    }
    for (const group of item.activityGroups ?? []) {
      if (typeof group.reasoning === "string") {
        slots.push({ read: () => group.reasoning, write: (value) => { group.reasoning = value; } });
      }
    }
  }
  return slots;
}

export function fitTaskHistoryPayload(payload, {
  maxBytes,
  minimumTextBytes = 1_024,
} = {}) {
  const budget = Math.max(64 * 1_024, Math.trunc(Number(maxBytes) || 0));
  const result = structuredClone(payload);
  let truncated = false;
  const encodedSize = () => utf8ByteLength(JSON.stringify(result));

  while (encodedSize() > budget) {
    const largest = textSlots(result)
      .map((slot) => ({ slot, bytes: utf8ByteLength(slot.read()) }))
      .filter((entry) => entry.bytes > minimumTextBytes)
      .sort((left, right) => right.bytes - left.bytes)[0];
    if (largest) {
      largest.slot.write(truncateUtf8(
        largest.slot.read(),
        Math.max(minimumTextBytes, Math.floor(largest.bytes * 0.65)),
      ));
      truncated = true;
      continue;
    }
    const activityItem = (result.items ?? []).find((item) => (item.activities?.length ?? 0) > 0);
    if (activityItem) {
      activityItem.activities = activityItem.activities.slice(Math.ceil(activityItem.activities.length / 2));
      truncated = true;
      continue;
    }
    const groupedActivityItem = (result.items ?? []).find((item) => (
      item.activityGroups?.some((group) => (group.activities?.length ?? 0) > 0)
    ));
    if (groupedActivityItem) {
      const group = groupedActivityItem.activityGroups.find((entry) => (entry.activities?.length ?? 0) > 0);
      group.activities = group.activities.slice(Math.ceil(group.activities.length / 2));
      truncated = true;
      continue;
    }
    if ((result.items?.length ?? 0) > 1) {
      result.items.shift();
      result.start += 1;
      result.nextBefore = result.start > 0 ? result.start : null;
      truncated = true;
      continue;
    }
    break;
  }
  if (encodedSize() > budget) {
    throw new TaskHistoryResponseBudgetError(budget);
  }
  if (truncated) result.transportTruncated = true;
  return result;
}
