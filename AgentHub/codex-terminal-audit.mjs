import { stat } from "node:fs/promises";

import { scanCodexTerminalEventsFromOffset } from "./codex-turn-usage.mjs";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_BOOTSTRAP_WINDOW_MS = 30 * 60_000;
const DEFAULT_BOUNDARY_OVERLAP_MS = 2_000;

function timestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function restoredPosition(value) {
  const offset = Number(value?.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return {
    path: String(value?.path ?? ""),
    offset,
  };
}

export class CodexTerminalAudit {
  constructor({
    listPage,
    resolveProject,
    reconcile,
    statFile = stat,
    scanFile = scanCodexTerminalEventsFromOffset,
    now = Date.now,
    pageSize = DEFAULT_PAGE_SIZE,
    bootstrapWindowMs = DEFAULT_BOOTSTRAP_WINDOW_MS,
    boundaryOverlapMs = DEFAULT_BOUNDARY_OVERLAP_MS,
  }) {
    this.listPage = listPage;
    this.resolveProject = resolveProject;
    this.reconcile = reconcile;
    this.statFile = statFile;
    this.scanFile = scanFile;
    this.now = now;
    this.pageSize = pageSize;
    this.bootstrapWindowMs = bootstrapWindowMs;
    this.boundaryOverlapMs = boundaryOverlapMs;
    this.completedThroughMs = 0;
    this.positions = new Map();
    this.running = false;
  }

  restore(snapshot) {
    this.completedThroughMs = timestampMs(snapshot?.completedThrough);
    this.positions.clear();
    for (const entry of Array.isArray(snapshot?.positions) ? snapshot.positions : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const position = restoredPosition(entry[1]);
      if (position) this.positions.set(entry[0], position);
    }
  }

  snapshot() {
    return {
      completedThrough: this.completedThroughMs
        ? new Date(this.completedThroughMs).toISOString()
        : "",
      positions: [...this.positions.entries()],
    };
  }

  async #auditThread(thread, project, lowerBoundMs) {
    const threadId = String(thread?.id ?? "").trim();
    const transcriptPath = String(thread?.path ?? "").trim();
    if (!threadId || !transcriptPath) return true;

    const info = await this.statFile(transcriptPath);
    const prior = this.positions.get(threadId);
    const canResume = prior?.path === transcriptPath && prior.offset <= info.size;
    const startOffset = canResume ? prior.offset : 0;
    const result = await this.scanFile(transcriptPath, { startOffset });
    const terminals = canResume
      ? result.terminals
      : result.terminals.filter((terminal) => (
        timestampMs(terminal.completedAt) >= lowerBoundMs
      ));

    let allHandled = true;
    for (const terminal of terminals) {
      if (await this.reconcile(thread, project, terminal) === false) {
        allHandled = false;
      }
    }
    if (!allHandled) {
      return false;
    }
    this.positions.set(threadId, {
      path: transcriptPath,
      offset: result.nextOffset,
    });
    return true;
  }

  async run() {
    if (this.running) return false;
    this.running = true;
    const startedAtMs = this.now();
    const bootstrapping = !this.completedThroughMs;
    const lowerBoundMs = bootstrapping
      ? startedAtMs - this.bootstrapWindowMs
      : this.completedThroughMs - this.boundaryOverlapMs;
    let cursor = null;
    const seenCursors = new Set();
    let madeProgress = false;
    let allHandled = true;

    try {
      do {
        if (cursor && seenCursors.has(cursor)) {
          throw new Error(`Codex thread/list repeated cursor ${cursor}`);
        }
        if (cursor) seenCursors.add(cursor);
        const page = await this.listPage(cursor, this.pageSize);
        const threads = page?.data ?? [];
        let reachedOlderThread = false;

        for (const thread of threads) {
          const project = this.resolveProject(thread);
          if (!project || !thread?.path) continue;
          const updatedAtMs = timestampMs(thread.updatedAt);
          const olderThanBoundary = updatedAtMs > 0 && updatedAtMs < lowerBoundMs;
          if (olderThanBoundary) reachedOlderThread = true;

          if (bootstrapping && olderThanBoundary) {
            const info = await this.statFile(thread.path);
            this.positions.set(String(thread.id), {
              path: String(thread.path),
              offset: info.size,
            });
            madeProgress = true;
            continue;
          }
          if (olderThanBoundary) continue;
          const handled = await this.#auditThread(thread, project, lowerBoundMs);
          madeProgress = madeProgress || handled;
          allHandled = allHandled && handled;
        }

        cursor = page?.nextCursor ?? null;
        if (!bootstrapping && reachedOlderThread) break;
      } while (cursor);

      if (allHandled) {
        this.completedThroughMs = startedAtMs;
        madeProgress = true;
      }
      return madeProgress;
    } finally {
      this.running = false;
    }
  }
}
