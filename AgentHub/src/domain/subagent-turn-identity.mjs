const UUID_V7_PATTERN = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function uuidV7TimestampMs(value) {
  const match = String(value ?? "").trim().match(UUID_V7_PATTERN);
  if (!match) return 0;
  return Number.parseInt(`${match[1]}${match[2]}`, 16);
}

export function isInheritedSubagentTurn({ aggregateOnly, threadId: childThreadId, turnId }) {
  if (aggregateOnly !== true) return false;
  const childCreatedAt = uuidV7TimestampMs(childThreadId);
  const turnCreatedAt = uuidV7TimestampMs(turnId);
  return childCreatedAt > 0 && turnCreatedAt > 0 && turnCreatedAt < childCreatedAt;
}
