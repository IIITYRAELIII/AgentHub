import { stat } from "node:fs/promises";

import { scanCodexTerminalEventsFromOffset } from "./codex-turn-usage.mjs";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_BOOTSTRAP_WINDOW_MS = 30 * 60_000;
const DEFAULT_BOUNDARY_OVERLAP_MS = 2_000;
const DEFAULT_STATUS_IDLE_MS = 5_000;
const DEFAULT_STATUS_POLL_MS = 30_000;
const DEFAULT_SUBAGENT_BACKFILL_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_HISTORICAL_SUBAGENT_BACKFILL_BYTES = 32 * 1024 * 1024;
const DEFAULT_HISTORICAL_ACTIVE_STALE_MS = 30 * 60_000;
const DEFAULT_SUPPLEMENTAL_DISCOVERY_INTERVAL_MS = 30_000;
const SNAPSHOT_VERSION = 9;
const COMPATIBLE_SNAPSHOT_VERSIONS = new Set([4, 5, 6, 7, 8, SNAPSHOT_VERSION]);

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
    repositoryUrl: String(
      thread?.repositoryUrl
      ?? thread?.gitInfo?.repositoryUrl
      ?? thread?.git?.repository_url
      ?? "",
    ).trim(),
    updatedAt: thread?.updatedAt ?? "",
    name: String(thread?.name ?? "").trim(),
  };
}

function historicalRolloutKey(thread) {
  const reference = threadReference(thread);
  // One Codex thread can have several physical rollout files (for example,
  // after a resumed session).  The historical queue must visit every file;
  // deduplicating only by thread ID silently loses older portions of history.
  return `${reference.id}\u0000${reference.path.toLowerCase()}`;
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

function emptyHistoricalSubagentBackfill(pending = false) {
  return {
    pending,
    initialized: false,
    totalFiles: 0,
    completedFiles: 0,
    processedTurns: 0,
    queue: [],
  };
}

function restoredHistoricalSubagentBackfill(value) {
  const restored = emptyHistoricalSubagentBackfill(value?.pending === true);
  restored.initialized = value?.initialized === true;
  restored.totalFiles = Math.max(0, Number(value?.totalFiles) || 0);
  restored.completedFiles = Math.max(0, Number(value?.completedFiles) || 0);
  restored.processedTurns = Math.max(0, Number(value?.processedTurns) || 0);
  for (const item of Array.isArray(value?.queue) ? value.queue : []) {
    const thread = threadReference(item?.thread);
    const offset = Number(item?.offset);
    const size = Number(item?.size);
    if (!thread.id || !thread.path) continue;
    if (!Number.isSafeInteger(offset) || offset < 0) continue;
    restored.queue.push({
      thread,
      offset,
      size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
      terminalTurnIndex: Math.max(0, Number(item?.terminalTurnIndex) || 0),
      staleTurnIndex: Math.max(0, Number(item?.staleTurnIndex) || 0),
      activeTurns: Array.isArray(item?.activeTurns) ? item.activeTurns.flatMap((turn) => {
        const turnId = String(turn?.turnId ?? "").trim();
        return turnId ? [{
          turnId,
          startedAt: String(turn?.startedAt ?? ""),
          lastActivityAt: String(turn?.lastActivityAt ?? turn?.startedAt ?? ""),
        }] : [];
      }) : [],
    });
  }
  if (restored.initialized && !restored.queue.length) restored.pending = false;
  return restored;
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
    discoverHistoricalThreads = null,
    discoverSupplementalThreads = null,
    scanHistoricalFile = null,
    shouldRunHistoricalBackfill = () => true,
    statFile = stat,
    scanFile = scanCodexTerminalEventsFromOffset,
    now = Date.now,
    pageSize = DEFAULT_PAGE_SIZE,
    bootstrapWindowMs = DEFAULT_BOOTSTRAP_WINDOW_MS,
    boundaryOverlapMs = DEFAULT_BOUNDARY_OVERLAP_MS,
    statusIdleMs = DEFAULT_STATUS_IDLE_MS,
    statusPollMs = DEFAULT_STATUS_POLL_MS,
    subagentBackfillWindowMs = DEFAULT_SUBAGENT_BACKFILL_WINDOW_MS,
    historicalSubagentBackfillBytes = DEFAULT_HISTORICAL_SUBAGENT_BACKFILL_BYTES,
    historicalActiveStaleMs = DEFAULT_HISTORICAL_ACTIVE_STALE_MS,
    supplementalDiscoveryIntervalMs = DEFAULT_SUPPLEMENTAL_DISCOVERY_INTERVAL_MS,
    maxPositions = 5_000,
  }) {
    this.listPage = listPage;
    this.readThread = readThread;
    this.isTurnActive = isTurnActive;
    this.onTurnStarted = onTurnStarted;
    this.onTurnActive = onTurnActive;
    this.resolveProject = resolveProject;
    this.reconcile = reconcile;
    this.discoverHistoricalThreads = discoverHistoricalThreads;
    this.discoverSupplementalThreads = discoverSupplementalThreads;
    this.scanHistoricalFile = scanHistoricalFile;
    this.shouldRunHistoricalBackfill = shouldRunHistoricalBackfill;
    this.statFile = statFile;
    this.scanFile = scanFile;
    this.now = now;
    this.pageSize = pageSize;
    this.bootstrapWindowMs = bootstrapWindowMs;
    this.boundaryOverlapMs = boundaryOverlapMs;
    this.statusIdleMs = statusIdleMs;
    this.statusPollMs = statusPollMs;
    this.subagentBackfillWindowMs = Math.max(
      this.bootstrapWindowMs,
      Number(subagentBackfillWindowMs) || DEFAULT_SUBAGENT_BACKFILL_WINDOW_MS,
    );
    this.historicalSubagentBackfillBytes = Math.max(
      64 * 1024,
      Number(historicalSubagentBackfillBytes)
        || DEFAULT_HISTORICAL_SUBAGENT_BACKFILL_BYTES,
    );
    this.historicalActiveStaleMs = Math.max(
      this.statusIdleMs,
      Number(historicalActiveStaleMs) || DEFAULT_HISTORICAL_ACTIVE_STALE_MS,
    );
    this.supplementalDiscoveryIntervalMs = Math.max(
      1_000,
      Number(supplementalDiscoveryIntervalMs) || DEFAULT_SUPPLEMENTAL_DISCOVERY_INTERVAL_MS,
    );
    this.maxPositions = Math.max(100, Number(maxPositions) || 5_000);
    this.completedThroughMs = 0;
    this.positions = new Map();
    this.pendingTurns = new Map();
    this.subagentBackfillPending = false;
    this.historicalSubagentBackfill = emptyHistoricalSubagentBackfill();
    this.historicalScanCache = new Map();
    this.lastSupplementalDiscoveryMs = 0;
    this.running = false;
  }

  restore(snapshot) {
    const snapshotVersion = Number(snapshot?.version);
    const compatibleSnapshot = COMPATIBLE_SNAPSHOT_VERSIONS.has(snapshotVersion);
    this.completedThroughMs = compatibleSnapshot ? timestampMs(snapshot?.completedThrough) : 0;
    this.positions.clear();
    this.pendingTurns.clear();
    this.subagentBackfillPending = snapshotVersion === 4
      || (compatibleSnapshot && snapshot?.subagentBackfillPending === true);
    this.historicalSubagentBackfill = [8, SNAPSHOT_VERSION].includes(snapshotVersion)
      ? restoredHistoricalSubagentBackfill(snapshot?.historicalSubagentBackfill)
      : emptyHistoricalSubagentBackfill(compatibleSnapshot);
    this.historicalScanCache.clear();
    if (compatibleSnapshot) {
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
      subagentBackfillPending: this.subagentBackfillPending,
      historicalSubagentBackfill: this.historicalSubagentBackfill,
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

  async #projectFor(thread) {
    return await this.resolveProject(thread);
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

  async #auditThread(thread, project, lowerBoundMs, fileInfo = null) {
    const threadId = String(thread?.id ?? "").trim();
    const transcriptPath = String(thread?.path ?? "").trim();
    if (!threadId || !transcriptPath) return true;

    const info = fileInfo ?? await this.statFile(transcriptPath);
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
      try {
        const project = await this.#projectFor(pending.thread);
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
      } catch {
        // Retain this pending turn unchanged; another rollout must still be auditable.
      }
    }
    return madeProgress;
  }

  async #initializeHistoricalSubagentBackfill() {
    const backfill = this.historicalSubagentBackfill;
    if (!backfill.pending || backfill.initialized) return false;
    const candidates = new Map();
    let cursor = null;
    const seenCursors = new Set();
    do {
      if (cursor && seenCursors.has(cursor)) {
        throw new Error(`Codex historical backfill repeated cursor ${cursor}`);
      }
      if (cursor) seenCursors.add(cursor);
      const page = await this.listPage(cursor, this.pageSize);
      for (const value of page?.data ?? []) {
        const thread = threadReference(value);
        if (!thread.id || !thread.path) continue;
        if (!await this.#projectFor(thread)) continue;
        candidates.set(historicalRolloutKey(thread), thread);
      }
      cursor = page?.nextCursor ?? null;
    } while (cursor);

    if (typeof this.discoverHistoricalThreads === "function") {
      for (const value of await this.discoverHistoricalThreads()) {
        const thread = threadReference(value);
        if (!thread.id || !thread.path) continue;
        if (!await this.#projectFor(thread)) continue;
        candidates.set(historicalRolloutKey(thread), thread);
      }
    }

    const queue = [];
    for (const thread of candidates.values()) {
      try {
        const info = await this.statFile(thread.path);
        queue.push({
          thread,
          offset: 0,
          size: Number(info.size) || 0,
          terminalTurnIndex: 0,
          staleTurnIndex: 0,
          activeTurns: [],
        });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    queue.sort((left, right) => left.size - right.size
      || timestampMs(left.thread.updatedAt) - timestampMs(right.thread.updatedAt));
    backfill.queue = queue;
    backfill.totalFiles = queue.length;
    backfill.completedFiles = 0;
    backfill.processedTurns = 0;
    backfill.initialized = true;
    if (!queue.length) backfill.pending = false;
    return true;
  }

  async #runHistoricalSubagentBackfill() {
    const backfill = this.historicalSubagentBackfill;
    if (!backfill.pending) return false;
    // Historical migration is maintenance work.  Never let it contend with
    // interactive turns for the App Server, SQLite writer or event loop.
    if (!this.shouldRunHistoricalBackfill()) return false;
    let changed = await this.#initializeHistoricalSubagentBackfill();
    const item = backfill.queue[0];
    if (!item) {
      backfill.pending = false;
      return true;
    }
    const project = await this.#projectFor(item.thread);
    if (!project) {
      backfill.queue.shift();
      backfill.completedFiles += 1;
      return true;
    }

    let info;
    try {
      info = await this.statFile(item.thread.path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      backfill.queue.shift();
      backfill.completedFiles += 1;
      return true;
    }
    const startOffset = item.offset <= info.size ? item.offset : 0;
    if (typeof this.scanHistoricalFile === "function") {
      const cacheKey = historicalRolloutKey(item.thread);
      let historical = this.historicalScanCache.get(cacheKey);
      if (!historical) {
        historical = await this.scanHistoricalFile(item.thread);
        this.historicalScanCache.set(cacheKey, historical);
      }
      const turns = Array.isArray(historical?.turns) ? historical.turns : [];
      const terminalTurns = turns.filter((turn) => turn?.terminal === true);
      while (item.terminalTurnIndex < terminalTurns.length) {
        if (!this.shouldRunHistoricalBackfill()) return changed;
        const turn = terminalTurns[item.terminalTurnIndex];
        const handled = await this.reconcile(item.thread, project, {
          turnId: turn.turnId,
          status: turn.status || "completed",
          completedAt: turn.completedAt || turn.lastActivityAt,
          historical: true,
          usageResult: turn,
        });
        if (handled === false) return changed;
        item.terminalTurnIndex += 1;
        backfill.processedTurns += 1;
        changed = true;
      }

      const stale = this.now() - Number(info.mtimeMs || 0) >= this.historicalActiveStaleMs;
      if (stale) {
        const staleTurns = turns.filter((turn) => turn?.terminal !== true && turn?.startedAt);
        while (item.staleTurnIndex < staleTurns.length) {
          if (!this.shouldRunHistoricalBackfill()) return changed;
          const turn = staleTurns[item.staleTurnIndex];
          const handled = await this.reconcile(item.thread, project, {
            turnId: turn.turnId,
            status: "aborted",
            completedAt: turn.lastActivityAt || turn.startedAt || new Date(info.mtimeMs).toISOString(),
            authoritative: true,
            historical: true,
            usageResult: turn,
          });
          if (handled === false) return changed;
          item.staleTurnIndex += 1;
          backfill.processedTurns += 1;
          changed = true;
        }
      }
      this.historicalScanCache.delete(cacheKey);
      backfill.queue.shift();
      backfill.completedFiles += 1;
      if (!backfill.queue.length) backfill.pending = false;
      return true;
    }
    const result = await this.scanFile(item.thread.path, {
      startOffset,
      maxBytes: this.historicalSubagentBackfillBytes,
      rolloutId: item.thread.id,
      initialActiveTurns: item.activeTurns,
    });
    let allHandled = true;
    for (const terminal of result.terminals ?? []) {
      if (await this.reconcile(item.thread, project, {
        ...terminal,
        historical: true,
      }) === false) {
        allHandled = false;
      }
    }
    if (!allHandled) return changed;
    if (result.nextOffset < startOffset
      || (result.nextOffset === startOffset && startOffset < info.size)) {
      throw new Error(`Codex historical backfill made no progress for ${item.thread.id}`);
    }

    item.offset = result.nextOffset;
    item.size = Number(info.size) || item.size;
    item.activeTurns = result.activeTurns ?? [];
    backfill.processedTurns += (result.terminals ?? []).length;
    changed = true;
    if (item.offset >= info.size) {
      if (item.activeTurns.length) {
        const stale = this.now() - Number(info.mtimeMs || 0) >= this.historicalActiveStaleMs;
        if (!stale) {
          backfill.queue.push(backfill.queue.shift());
          return true;
        }
        let activeHandled = true;
        for (const turn of item.activeTurns) {
          const handled = await this.reconcile(item.thread, project, {
            turnId: turn.turnId,
            status: "aborted",
            completedAt: new Date(
              timestampMs(turn.lastActivityAt)
              || Number(info.mtimeMs)
              || this.now(),
            ).toISOString(),
            authoritative: true,
            historical: true,
          });
          if (handled === false) activeHandled = false;
        }
        if (!activeHandled) return true;
        backfill.processedTurns += item.activeTurns.length;
        item.activeTurns = [];
      }
      backfill.queue.shift();
      backfill.completedFiles += 1;
      if (!backfill.queue.length) backfill.pending = false;
    }
    return changed;
  }

  async run() {
    if (this.running) return false;
    this.running = true;
    const startedAtMs = this.now();
    const bootstrapping = !this.completedThroughMs;
    const lowerBoundMs = bootstrapping
      ? startedAtMs - this.bootstrapWindowMs
      : this.completedThroughMs - this.boundaryOverlapMs;
    const subagentBackfillLowerBoundMs = Math.max(
      0,
      (this.completedThroughMs || startedAtMs) - this.subagentBackfillWindowMs,
    );
    let cursor = null;
    const seenCursors = new Set();
    let madeProgress = false;
    let allHandled = true;
    const supplementalThreads = [];
    const supplementalThreadIds = new Set();

    try {
      madeProgress = await this.#runHistoricalSubagentBackfill();
      madeProgress = await this.#pollPendingTurns(lowerBoundMs) || madeProgress;
      if (typeof this.discoverSupplementalThreads === "function"
        && startedAtMs - this.lastSupplementalDiscoveryMs >= this.supplementalDiscoveryIntervalMs) {
        const discovered = await this.discoverSupplementalThreads();
        this.lastSupplementalDiscoveryMs = startedAtMs;
        for (const value of discovered ?? []) {
          const reference = threadReference(value);
          if (!reference.id || !reference.path || !reference.parentThreadId) continue;
          supplementalThreads.push(reference);
          supplementalThreadIds.add(reference.id);
        }
      }
      const visitedThreadIds = new Set();
      let includeSupplementalThreads = true;
      do {
        if (cursor && seenCursors.has(cursor)) {
          throw new Error(`Codex thread/list repeated cursor ${cursor}`);
        }
        if (cursor) seenCursors.add(cursor);
        const page = await this.listPage(cursor, this.pageSize);
        const threads = [
          ...(page?.data ?? []),
          ...(includeSupplementalThreads ? supplementalThreads : []),
        ];
        includeSupplementalThreads = false;

        for (const thread of threads) {
          try {
            const project = await this.#projectFor(thread);
            if (!project || !thread?.path) continue;
            const threadId = String(thread.id ?? "").trim();
            if (!threadId) continue;
            if (visitedThreadIds.has(threadId)) continue;
            visitedThreadIds.add(threadId);
            const transcriptPath = String(thread.path);
            const info = await this.statFile(transcriptPath);
            const prior = this.positions.get(threadId);
            const canResume = prior?.path === transcriptPath && prior.offset <= info.size;
            const hasUnreadBytes = canResume && prior.offset < info.size;
            const isSubagent = Boolean(String(thread.parentThreadId ?? "").trim());
            const activityMs = Number(info.mtimeMs) || timestampMs(thread.updatedAt);
            const backfillMissingSubagent = isSubagent
              && !canResume
              && (
                supplementalThreadIds.has(threadId)
                || (this.subagentBackfillPending && activityMs >= subagentBackfillLowerBoundMs)
              );
            const olderThanBoundary = activityMs > 0 && activityMs < lowerBoundMs;

            if (this.subagentBackfillPending
              && isSubagent
              && !canResume
              && !backfillMissingSubagent) {
              this.#setPosition(threadId, {
                path: transcriptPath,
                offset: info.size,
              });
              madeProgress = true;
              continue;
            }

            if (bootstrapping && olderThanBoundary && !backfillMissingSubagent) {
              this.#setPosition(threadId, {
                path: transcriptPath,
                offset: info.size,
              });
              madeProgress = true;
              continue;
            }
            if (olderThanBoundary && !hasUnreadBytes && !backfillMissingSubagent) continue;
            const handled = await this.#auditThread(
              thread,
              project,
              backfillMissingSubagent ? 0 : lowerBoundMs,
              info,
            );
            madeProgress = madeProgress || handled;
            allHandled = allHandled && handled;
          } catch {
            // Keep the prior cursor for this rollout and retry it on a later pass.
            // A damaged or disappeared file must not block other independent threads.
            allHandled = false;
          }
        }

        cursor = page?.nextCursor ?? null;
      } while (cursor);

      if (allHandled) {
        this.subagentBackfillPending = false;
        this.completedThroughMs = startedAtMs;
        madeProgress = true;
      }
      return madeProgress;
    } finally {
      this.running = false;
    }
  }
}
