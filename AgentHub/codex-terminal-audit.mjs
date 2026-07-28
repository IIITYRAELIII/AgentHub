import { stat } from "node:fs/promises";

import { scanCodexTerminalEventsFromOffset } from "./codex-turn-usage.mjs";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_BOOTSTRAP_WINDOW_MS = 30 * 60_000;
const DEFAULT_BOUNDARY_OVERLAP_MS = 2_000;
const DEFAULT_STATUS_IDLE_MS = 5_000;
const DEFAULT_STATUS_POLL_MS = 30_000;
const SNAPSHOT_VERSION = 4;

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

function terminalTurnStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "completed") return "completed";
  if (["interrupted", "aborted"].includes(status)) return "aborted";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (status === "failed") return "failed";
  return "";
}

function threadReference(thread) {
  return {
    id: String(thread?.id ?? "").trim(),
    cwd: String(thread?.cwd ?? "").trim(),
    path: String(thread?.path ?? "").trim(),
    parentThreadId: String(thread?.parentThreadId ?? "").trim(),
    updatedAt: thread?.updatedAt ?? "",
    name: String(thread?.name ?? "").trim(),
  };
}

function restoredPendingThread(value) {
  const thread = threadReference(value?.thread);
  if (!thread.id || !thread.path) return null;
  const turns = new Map();
  for (const turn of Array.isArray(value?.turns) ? value.turns : []) {
    const turnId = String(turn?.turnId ?? "").trim();
    if (!turnId) continue;
    turns.set(turnId, {
      turnId,
      startedAt: String(turn?.startedAt ?? ""),
      lastActivityAt: String(turn?.lastActivityAt ?? turn?.startedAt ?? ""),
    });
  }
  if (!turns.size) return null;
  return {
    thread,
    turns,
    lastActivityMs: timestampMs(value?.lastActivityAt),
    nextStatusCheckMs: timestampMs(value?.nextStatusCheckAt),
  };
}

export class CodexTerminalAudit {
  constructor({
    listPage,
    readThread,
    isTurnActive,
    onTurnStarted,
    onTurnActive,
    resolveProject,
    reconcile,
    statFile = stat,
    scanFile = scanCodexTerminalEventsFromOffset,
    now = Date.now,
    pageSize = DEFAULT_PAGE_SIZE,
    bootstrapWindowMs = DEFAULT_BOOTSTRAP_WINDOW_MS,
    boundaryOverlapMs = DEFAULT_BOUNDARY_OVERLAP_MS,
    statusIdleMs = DEFAULT_STATUS_IDLE_MS,
    statusPollMs = DEFAULT_STATUS_POLL_MS,
    maxPositions = 5_000,
  }) {
    this.listPage = listPage;
    this.readThread = readThread;
    this.isTurnActive = isTurnActive;
    this.onTurnStarted = onTurnStarted;
    this.onTurnActive = onTurnActive;
    this.resolveProject = resolveProject;
    this.reconcile = reconcile;
    this.statFile = statFile;
    this.scanFile = scanFile;
    this.now = now;
    this.pageSize = pageSize;
    this.bootstrapWindowMs = bootstrapWindowMs;
    this.boundaryOverlapMs = boundaryOverlapMs;
    this.statusIdleMs = statusIdleMs;
    this.statusPollMs = statusPollMs;
    this.maxPositions = Math.max(100, Number(maxPositions) || 5_000);
    this.completedThroughMs = 0;
    this.positions = new Map();
    this.pendingTurns = new Map();
    this.running = false;
  }

  restore(snapshot) {
    const currentSnapshot = Number(snapshot?.version) === SNAPSHOT_VERSION;
    this.completedThroughMs = currentSnapshot ? timestampMs(snapshot?.completedThrough) : 0;
    this.positions.clear();
    this.pendingTurns.clear();
    if (currentSnapshot) {
      for (const entry of Array.isArray(snapshot?.positions) ? snapshot.positions : []) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const position = restoredPosition(entry[1]);
        if (position) this.#setPosition(entry[0], position);
      }
      for (const entry of Array.isArray(snapshot?.pendingTurns) ? snapshot.pendingTurns : []) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const pending = restoredPendingThread(entry[1]);
        if (pending) this.pendingTurns.set(entry[0], pending);
      }
    }
  }

  snapshot() {
    return {
      version: SNAPSHOT_VERSION,
      completedThrough: this.completedThroughMs
        ? new Date(this.completedThroughMs).toISOString()
        : "",
      positions: [...this.positions.entries()],
      pendingTurns: [...this.pendingTurns.entries()].map(([threadId, pending]) => [
        threadId,
        {
          thread: pending.thread,
          turns: [...pending.turns.values()],
          lastActivityAt: pending.lastActivityMs
            ? new Date(pending.lastActivityMs).toISOString()
            : "",
          nextStatusCheckAt: pending.nextStatusCheckMs
            ? new Date(pending.nextStatusCheckMs).toISOString()
            : "",
        },
      ]),
    };
  }

  #setPosition(threadId, position) {
    this.positions.delete(threadId);
    this.positions.set(threadId, position);
    while (this.positions.size > this.maxPositions) {
      this.positions.delete(this.positions.keys().next().value);
    }
  }

  #removePendingTurn(threadId, turnId) {
    const pending = this.pendingTurns.get(threadId);
    if (!pending) return;
    pending.turns.delete(turnId);
    if (!pending.turns.size) this.pendingTurns.delete(threadId);
  }

  async #rememberActiveTurns(thread, project, activeTurns, {
    lowerBoundMs,
    canResume,
    activityMs,
  }) {
    const eligible = (activeTurns ?? []).filter((turn) => (
      canResume || timestampMs(turn?.lastActivityAt ?? turn?.startedAt) >= lowerBoundMs
    ));
    if (!eligible.length) return;
    const threadId = String(thread?.id ?? "").trim();
    const pending = this.pendingTurns.get(threadId) ?? {
      thread: threadReference(thread),
      turns: new Map(),
      lastActivityMs: 0,
      nextStatusCheckMs: 0,
    };
    pending.thread = threadReference(thread);
    for (const turn of eligible) {
      const turnId = String(turn?.turnId ?? "").trim();
      if (!turnId) continue;
      const newlyObserved = !pending.turns.has(turnId);
      if (newlyObserved && typeof this.onTurnStarted === "function") {
        await this.onTurnStarted(thread, project, {
          turnId,
          startedAt: String(turn?.startedAt ?? ""),
          lastActivityAt: String(turn?.lastActivityAt ?? turn?.startedAt ?? ""),
        });
      }
      pending.turns.set(turnId, {
        turnId,
        startedAt: String(turn?.startedAt ?? ""),
        lastActivityAt: String(turn?.lastActivityAt ?? turn?.startedAt ?? ""),
      });
    }
    pending.lastActivityMs = activityMs;
    pending.nextStatusCheckMs = activityMs + this.statusIdleMs;
    if (pending.turns.size) this.pendingTurns.set(threadId, pending);
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
    const activityMs = this.now();
    if (result.nextOffset > startOffset) {
      const pending = this.pendingTurns.get(threadId);
      if (pending) {
        pending.thread = threadReference(thread);
        pending.lastActivityMs = activityMs;
        pending.nextStatusCheckMs = activityMs + this.statusIdleMs;
      }
    }
    await this.#rememberActiveTurns(thread, project, result.activeTurns, {
      lowerBoundMs,
      canResume,
      activityMs,
    });

    let allHandled = true;
    for (const terminal of terminals) {
      if (await this.reconcile(thread, project, terminal) === false) {
        allHandled = false;
      } else {
        this.#removePendingTurn(threadId, terminal.turnId);
      }
    }
    if (!allHandled) {
      return false;
    }
    this.#setPosition(threadId, {
      path: transcriptPath,
      offset: result.nextOffset,
    });
    return true;
  }

  async #pollPendingTurns(lowerBoundMs) {
    let madeProgress = false;
    const nowMs = this.now();
    for (const [threadId, pending] of [...this.pendingTurns]) {
      const project = this.resolveProject(pending.thread);
      if (!project) continue;
      const position = this.positions.get(threadId);
      const info = await this.statFile(pending.thread.path);
      if (position?.path === pending.thread.path && position.offset < info.size) {
        const handled = await this.#auditThread(pending.thread, project, lowerBoundMs);
        madeProgress = madeProgress || handled;
        if (!handled || !this.pendingTurns.has(threadId)) continue;
      }

      const current = this.pendingTurns.get(threadId);
      if (!current || nowMs < current.nextStatusCheckMs) continue;
      if (typeof this.readThread !== "function") {
        current.nextStatusCheckMs = nowMs + this.statusPollMs;
        continue;
      }
      const response = await this.readThread(threadId);
      const fullThread = response?.thread ?? response;
      if (!fullThread?.id) {
        current.nextStatusCheckMs = nowMs + this.statusPollMs;
        continue;
      }
      current.thread = threadReference(fullThread);
      const turns = new Map((fullThread.turns ?? []).map((turn) => [String(turn?.id ?? ""), turn]));
      for (const turn of [...current.turns.values()]) {
        if (typeof this.isTurnActive === "function"
          && await this.isTurnActive(current.thread, turn.turnId)) {
          if (typeof this.onTurnActive === "function") {
            await this.onTurnActive(current.thread, project, turn.turnId);
          }
          continue;
        }
        const exactTurn = turns.get(turn.turnId);
        const status = terminalTurnStatus(exactTurn?.status);
        if (!status) continue;
        const handled = await this.reconcile(fullThread, project, {
          turnId: turn.turnId,
          status,
          completedAt: new Date(
            timestampMs(turn.lastActivityAt)
            || timestampMs(fullThread.updatedAt)
            || info.mtimeMs
            || nowMs,
          ).toISOString(),
          authoritative: true,
        });
        if (handled === false) continue;
        this.#removePendingTurn(threadId, turn.turnId);
        madeProgress = true;
      }
      const remaining = this.pendingTurns.get(threadId);
      if (remaining) remaining.nextStatusCheckMs = nowMs + this.statusPollMs;
    }
    return madeProgress;
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
      madeProgress = await this.#pollPendingTurns(lowerBoundMs);
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
            this.#setPosition(String(thread.id), {
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
