import {
  catalogTaskKey,
  normalizedCatalogPath,
} from "./task-catalog-identity.mjs";
import { isCodexContextProbeText } from "./codex-context-probe.mjs";

export function taskCatalogTitleSignature(entries = []) {
  return JSON.stringify(
    (Array.isArray(entries) ? entries : [])
      .flatMap((entry) => {
        const provider = String(entry?.provider ?? "").trim().toLowerCase();
        const threadId = String(entry?.threadId ?? "").trim();
        const projectRoot = String(entry?.projectRoot ?? "").trim();
        const title = String(entry?.title ?? "").replace(/\s+/g, " ").trim();
        return provider && threadId && projectRoot && title
          ? [[normalizedCatalogPath(projectRoot), provider, threadId, title]]
          : [];
      })
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

export function pinnedTaskTitle(titles, provider, threadId) {
  return String(titles?.[catalogTaskKey({ provider, threadId })] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function pinTaskTitle(titles, provider, threadId, title) {
  const value = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!titles || !threadId || !value) return "";
  titles[catalogTaskKey({ provider, threadId })] = value;
  return value;
}

export function reconcilePinnedTaskTitle(titles, provider, threadId, discoveredTitle) {
  const discovered = String(discoveredTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const pinned = pinnedTaskTitle(titles, provider, threadId);
  if (!discovered || !pinned || discovered === pinned) {
    return { title: pinned || discovered, changed: false };
  }
  pinTaskTitle(titles, provider, threadId, discovered);
  return { title: discovered, changed: true };
}

export function preferredCodexTaskTitle(
  threadTitle,
  titleHistory = {},
  pinnedTitle = "",
  pendingTitle = "",
) {
  const liveTitle = String(threadTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const pinned = String(pinnedTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const pending = String(pendingTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (pending && !isCodexContextProbeText(pending)) return pending;
  // A successful Hub rename is written to the App Server before the append-only
  // session index catches up. Keep the confirmed live title during that gap.
  if (pinned && !isCodexContextProbeText(pinned)
    && (liveTitle === pinned || isCodexContextProbeText(liveTitle))) return pinned;
  // A hidden probe can enter provider auto-naming and its append-only index.
  // Reuse the normal pin reconciliation without retaining that service text.
  return [titleHistory.recoverableTitle, titleHistory.currentTitle, liveTitle, pinned]
    .map((value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80))
    .find((value) => value && !isCodexContextProbeText(value)) || "";
}
