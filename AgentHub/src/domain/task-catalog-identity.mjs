import path from "node:path";

export function normalizedCatalogPath(value) {
  const resolved = path.resolve(String(value ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function catalogTaskKey({ provider, threadId }) {
  return `${String(provider ?? "").toLowerCase()}\0${String(threadId ?? "")}`;
}

export function catalogEntryIsSelected(entry, selected) {
  return entry.provider === selected.provider
    && entry.threadId === selected.threadId
    && normalizedCatalogPath(entry.projectRoot) === normalizedCatalogPath(selected.projectRoot);
}
