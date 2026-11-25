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

function coldPageFinal(items, knownFinal) {
  const exact = knownFinal && items.find(item => item.id === knownFinal.turnId
    && item.provider === knownFinal.provider && item.threadId === knownFinal.threadId
    && (!knownFinal.revision || item.terminalRevision === knownFinal.revision));
  return exact ?? items.findLast(item => item.completed && (item.answer
    || item.messages?.some(message => message.role === "agent" && message.text
      && (!message.phase || ["final", "final_answer", "finalAnswer"].includes(message.phase)))));
}

function shrinkTextToBudget(page, excessBytes, minimum) {
  // Each slot is one JSON string. Updating its encoded byte delta avoids
  // serializing the entire page again for every shortened message.
  const slots = textSlots(page).map(slot => ({ slot, bytes: utf8ByteLength(slot.read()) }));
  while (excessBytes > 0) {
    let largest;
    for (const entry of slots) {
      if (entry.bytes > (largest?.bytes ?? minimum)) largest = entry;
    }
    if (!largest) return;
    const previous = largest.slot.read();
    const next = truncateUtf8(previous, Math.max(minimum, Math.floor(largest.bytes * 0.65)));
    largest.slot.write(next);
    largest.bytes = utf8ByteLength(next);
    excessBytes -= utf8ByteLength(JSON.stringify(previous)) - utf8ByteLength(JSON.stringify(next));
  }
}

function fitColdWindow(page, budget, knownFinal) {
  const items = page.items;
  const envelope = { ...page, items: [] };
  let bytes = 0;
  let first = items.length - 1;
  for (let i = first; i >= 0; i -= 1) {
    envelope.start = page.start + i;
    envelope.nextBefore = envelope.start || null;
    bytes += utf8ByteLength(JSON.stringify(items[i])) + (i === items.length - 1 ? 0 : 1);
    if (bytes + utf8ByteLength(JSON.stringify(envelope)) > budget) break;
    first = i;
  }
  const final = coldPageFinal(items, knownFinal);
  const anchor = final ? items.indexOf(final) : -1;
  if (anchor >= 0 && anchor < first) {
    // Paint the complete exchange first. The ordinary refresh loads newer requests.
    first = anchor;
    page.end = page.start + anchor + 1;
    page.items = [final];
  } else {
    page.items = items.slice(first);
  }
  page.start += first;
  page.nextBefore = page.start || null;
}

export function fitTaskHistoryPayload(payload, {
  maxBytes,
  minimumTextBytes = 1_024,
  preferCompleteTail = false,
  knownFinal,
  reservedBytes = 0,
} = {}) {
  const budget = Math.max(64 * 1_024, Math.trunc(Number(maxBytes) || 0)) - reservedBytes;
  const result = structuredClone(payload);
  const encodedSize = () => utf8ByteLength(JSON.stringify(result));
  if (encodedSize() <= budget) return result;
  result.transportTruncated = true;
  if (preferCompleteTail && result.items?.length > 1) fitColdWindow(result, budget, knownFinal);

  const excessBytes = encodedSize() - budget;
  if (excessBytes > 0) shrinkTextToBudget(result, excessBytes, minimumTextBytes);
  while (encodedSize() > budget) {
    const activityItem = (result.items ?? []).find((item) => (item.activities?.length ?? 0) > 0);
    if (activityItem) {
      activityItem.activities = activityItem.activities.slice(Math.ceil(activityItem.activities.length / 2));
      continue;
    }
    const groupedActivityItem = (result.items ?? []).find((item) => (
      item.activityGroups?.some((group) => (group.activities?.length ?? 0) > 0)
    ));
    if (groupedActivityItem) {
      const group = groupedActivityItem.activityGroups.find((entry) => (entry.activities?.length ?? 0) > 0);
      group.activities = group.activities.slice(Math.ceil(group.activities.length / 2));
      continue;
    }
    if ((result.items?.length ?? 0) > 1) {
      result.items.shift();
      result.start += 1;
      result.nextBefore = result.start > 0 ? result.start : null;
      continue;
    }
    break;
  }
  if (encodedSize() > budget) {
    throw new TaskHistoryResponseBudgetError(budget);
  }
  return result;
}
