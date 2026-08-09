function normalizedId(value) {
  return String(value ?? "").trim();
}

export async function reconcileCodexThreadSubscriptions({
  sendRpc,
  selectedThreadId,
  activeRuns = [],
  pageSize = 100,
} = {}) {
  if (typeof sendRpc !== "function") throw new TypeError("sendRpc is required");
  const retained = new Set([
    normalizedId(selectedThreadId),
    ...(Array.isArray(activeRuns) ? activeRuns : [])
      .filter((run) => run?.provider === "codex" && run?.status === "running")
      .map((run) => normalizedId(run.threadId)),
  ].filter(Boolean));
  const loaded = [];
  const seenCursors = new Set();
  let cursor = null;
  do {
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
    const page = await sendRpc("thread/loaded/list", { cursor, limit: pageSize }, { priority: "background" });
    loaded.push(...(Array.isArray(page?.data) ? page.data : []));
    cursor = normalizedId(page?.nextCursor) || null;
  } while (cursor);

  const released = [];
  for (const threadId of new Set(loaded.map(normalizedId).filter(Boolean))) {
    if (retained.has(threadId)) continue;
    const result = await sendRpc("thread/unsubscribe", { threadId }, { priority: "background" });
    released.push({ threadId, status: String(result?.status ?? "") });
  }
  return { retained: [...retained], loaded, released };
}
