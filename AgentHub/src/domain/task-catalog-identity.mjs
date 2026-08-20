import path from "node:path";

export function normalizedCatalogPath(value) {
  const resolved = path.resolve(String(value ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function catalogTaskKey({ streamId, provider, threadId }) {
  const normalizedStreamId = String(streamId ?? "").trim();
  const normalizedProvider = String(provider ?? "").toLowerCase();
  const normalizedThreadId = String(threadId ?? "").trim();
  if (normalizedStreamId && normalizedProvider && normalizedThreadId) {
    return `stream\0${normalizedStreamId}\0${normalizedProvider}\0${normalizedThreadId}`;
  }
  if (normalizedStreamId) return `stream\0${normalizedStreamId}`;
  return `${normalizedProvider}\0${normalizedThreadId}`;
}

export function catalogEntryIsSelected(entry, selected) {
  if (entry?.streamId && selected?.streamId) {
    if (entry.threadId && selected.threadId) {
      return entry.streamId === selected.streamId
        && entry.provider === selected.provider
        && entry.threadId === selected.threadId;
    }
    return entry.streamId === selected.streamId;
  }
  return entry.provider === selected.provider
    && entry.threadId === selected.threadId
    && normalizedCatalogPath(entry.projectRoot) === normalizedCatalogPath(selected.projectRoot);
}
