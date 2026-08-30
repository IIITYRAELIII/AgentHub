import { open, stat } from "node:fs/promises";

import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";
import { scanCodexHistoricalRollout } from "./codex-turn-usage.mjs";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_BOOTSTRAP_WINDOW_MS = 30 * 60_000;
const DEFAULT_BOUNDARY_OVERLAP_MS = 2_000;
const DEFAULT_STATUS_IDLE_MS = 5_000;
const DEFAULT_STATUS_POLL_MS = 30_000;
const DEFAULT_SUBAGENT_BACKFILL_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_HISTORICAL_SUBAGENT_BACKFILL_BYTES = 32 * 1024 * 1024;
const DEFAULT_HISTORICAL_ACTIVE_STALE_MS = 30 * 60_000;
const DEFAULT_SUPPLEMENTAL_DISCOVERY_INTERVAL_MS = 30_000;
const DEFAULT_HISTORICAL_TURNS_PER_RUN = 25;
const ROLLOUT_CHECKPOINT_BYTES = 128;
const SNAPSHOT_VERSION = 13;
const COMPATIBLE_SNAPSHOT_VERSIONS = new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, SNAPSHOT_VERSION]);

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
    ...(value?.resumeState ? { resumeState: structuredClone(value.resumeState) } : {}),
    ...(String(value?.fileIdentity ?? "").trim()
      ? { fileIdentity: String(value.fileIdentity).trim() }
      : {}),
    ...(String(value?.fileCheckpoint ?? "").trim()
      ? { fileCheckpoint: String(value.fileCheckpoint).trim() }
      : {}),
  };
}

async function readRolloutCheckpoint(transcriptPath, offset) {
  const end = Math.max(0, Number(offset) || 0);
  const length = Math.min(end, ROLLOUT_CHECKPOINT_BYTES);
  if (!length) return "";
  const handle = await open(transcriptPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, end - length);
    return buffer.subarray(0, bytesRead).toString("base64");
  } finally {
    await handle.close();
  }
}

function rolloutFileIdentity(info) {
  const parts = [info?.dev, info?.ino, info?.birthtimeMs]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(":") : "";
}

function resumablePosition(prior, transcriptPath, info, { requireResumeState = false } = {}) {
  if (prior?.path !== transcriptPath || prior.offset > info.size) return false;
  if (requireResumeState && !prior.resumeState) return false;
  const currentIdentity = rolloutFileIdentity(info);
  return !prior.fileIdentity || !currentIdentity || prior.fileIdentity === currentIdentity;
}

function normalizedLiveScanResult(result) {
  if (!Array.isArray(result?.turns)) return result;
  const activeTurns = Array.isArray(result.resumeState?.turns)
    ? result.resumeState.turns
    : result.turns.filter((turn) => turn?.terminal !== true);
  return {
    terminals: result.turns
      .filter((turn) => turn?.terminal === true)
      .map((turn) => ({
        turnId: String(turn.turnId),
        status: terminalTurnStatus(turn.status) || "completed",
        completedAt: String(turn.completedAt ?? turn.lastActivityAt ?? ""),
        ...(turn.contextProbe === true ? { contextProbe: true } : {}),
        usageResult: turn,
      })),
    activeTurns: activeTurns.map((turn) => ({
      turnId: String(turn.turnId),
      startedAt: String(turn.startedAt ?? ""),
      lastActivityAt: String(turn.lastActivityAt ?? turn.startedAt ?? ""),
      ...(turn.contextProbe === true ? { contextProbe: true } : {}),
    })),
    nextOffset: result.nextOffset,
    resumeState: result.resumeState ?? null,
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

function historicalTurnIdentity(thread, turnId, session = null) {
  const reference = threadReference(thread);
  const accountingThreadId = [
    session?.parentThreadId,
    reference.parentThreadId,
    session?.threadId,
    reference.id,
  ].map((value) => String(value ?? "").trim()).find(Boolean) || reference.id;
  return `${accountingThreadId}\u0000${String(turnId ?? "").trim()}`;
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
      ...(turn?.contextProbe === true ? { contextProbe: true } : {}),
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
    prepared: false,
    backupFile: "",
    totalFiles: 0,
    completedFiles: 0,
    processedTurns: 0,
    projectionPending: false,
    queue: [],
  };
}

function restoredHistoricalSubagentBackfill(value) {
  const restored = emptyHistoricalSubagentBackfill(value?.pending === true);
  restored.initialized = value?.initialized === true;
  restored.prepared = value?.prepared === true;
  restored.backupFile = String(value?.backupFile ?? "").trim();
  restored.totalFiles = Math.max(0, Number(value?.totalFiles) || 0);
  restored.completedFiles = Math.max(0, Number(value?.completedFiles) || 0);
  restored.processedTurns = Math.max(0, Number(value?.processedTurns) || 0);
  restored.projectionPending = value?.projectionPending === true;
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
      resumeState: item?.resumeState ?? null,
      activeTurns: Array.isArray(item?.activeTurns) ? item.activeTurns.flatMap((turn) => {
        const turnId = String(turn?.turnId ?? "").trim();
        return turnId ? [{
          turnId,
          startedAt: String(turn?.startedAt ?? ""),
          lastActivityAt: String(turn?.lastActivityAt ?? turn?.startedAt ?? ""),
          ...(turn?.contextProbe === true ? { contextProbe: true } : {}),
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
    scanHistoricalChunk = scanCodexHistoricalRollout,
    shouldRunHistoricalBackfill = () => true,
    prepareHistoricalBackfill = async () => null,
    flushHistoricalProjection = async () => {},
    statFile = stat,
    scanFile = scanCodexHistoricalRollout,
    readCheckpoint = readRolloutCheckpoint,
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
    historicalTurnsPerRun = DEFAULT_HISTORICAL_TURNS_PER_RUN,
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
    this.scanHistoricalChunk = scanHistoricalChunk;
    this.shouldRunHistoricalBackfill = shouldRunHistoricalBackfill;
    this.prepareHistoricalBackfill = prepareHistoricalBackfill;
    this.flushHistoricalProjection = flushHistoricalProjection;
    this.statFile = statFile;
    this.scanFile = scanFile;
    this.incrementalUsageScan = scanFile === scanCodexHistoricalRollout;
    this.readCheckpoint = readCheckpoint;
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
    this.historicalTurnsPerRun = Math.max(
      1,
      Math.floor(Number(historicalTurnsPerRun) || DEFAULT_HISTORICAL_TURNS_PER_RUN),
    );
    this.maxPositions = Math.max(100, Number(maxPositions) || 5_000);
    this.completedThroughMs = 0;
    this.positions = new Map();
    this.pendingTurns = new Map();
    this.subagentBackfillPending = false;
    this.historicalSubagentBackfill = emptyHistoricalSubagentBackfill();
    this.historicalScanCache = new Map();
    this.historicalTurnIdentities = new Set();
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
    // Snapshots v10 and v11 may have completed or interrupted the old
    // per-turn projection pass. Treat them as compatible for live cursors,
    // while rebuilding only the resumable historical queue once under v13.
    this.historicalSubagentBackfill = [8, 9, 12, SNAPSHOT_VERSION].includes(snapshotVersion)
      ? restoredHistoricalSubagentBackfill(snapshot?.historicalSubagentBackfill)
      : emptyHistoricalSubagentBackfill(compatibleSnapshot);
    this.historicalScanCache.clear();
    this.historicalTurnIdentities = new Set(
      Array.isArray(snapshot?.historicalSubagentBackfill?.processedTurnIdentities)
        ? snapshot.historicalSubagentBackfill.processedTurnIdentities
          .map((value) => String(value ?? "").trim())
          .filter(Boolean)
        : [],
    );
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
      historicalSubagentBackfill: {
        ...this.historicalSubagentBackfill,
        processedTurnIdentities: [...this.historicalTurnIdentities],
      },
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

  async #canResume(prior, transcriptPath, info) {
    if (!resumablePosition(prior, transcriptPath, info, {
      requireResumeState: this.incrementalUsageScan,
    })) return false;
    if (!this.incrementalUsageScan || !prior.fileCheckpoint) return true;
    return await this.readCheckpoint(transcriptPath, prior.offset) === prior.fileCheckpoint;
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
        ...(turn?.contextProbe === true ? { contextProbe: true } : {}),
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
    const canResume = await this.#canResume(prior, transcriptPath, info);
    const startOffset = canResume ? prior.offset : 0;
    const result = normalizedLiveScanResult(await this.scanFile(transcriptPath, {
      startOffset,
      ...(canResume && prior.resumeState ? { resumeState: prior.resumeState } : {}),
    }));
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
    await this.#rememberActiveTurns(
      thread,
      project,
      (result.activeTurns ?? []).filter((turn) => !isCodexContextProbeTurn(turn)),
      {
        lowerBoundMs,
        canResume,
        activityMs,
      },
    );

    let allHandled = true;
    for (const terminal of terminals) {
      const candidate = isCodexContextProbeTurn(terminal)
        ? { ...terminal, historical: true, resolveCurrentAccount: true }
        : terminal;
      if (await this.reconcile(thread, project, candidate) === false) {
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
      ...(result.resumeState ? { resumeState: result.resumeState } : {}),
      ...(rolloutFileIdentity(info) ? { fileIdentity: rolloutFileIdentity(info) } : {}),
      ...(this.incrementalUsageScan
        ? { fileCheckpoint: await this.readCheckpoint(transcriptPath, result.nextOffset) }
        : {}),
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
        if (await this.#canResume(position, pending.thread.path, info) && position.offset < info.size) {
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
          const contextProbe = isCodexContextProbeTurn(exactTurn);
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
            ...(contextProbe ? { historical: true, resolveCurrentAccount: true } : {}),
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

  async #discoverThreads() {
    if (typeof this.discoverHistoricalThreads === "function") {
      return await this.discoverHistoricalThreads();
    }
    const threads = [];
    let cursor = null;
    const seenCursors = new Set();
    do {
      if (cursor && seenCursors.has(cursor)) {
        throw new Error(`Codex thread/list repeated cursor ${cursor}`);
      }
      if (cursor) seenCursors.add(cursor);
      const page = await this.listPage(cursor, this.pageSize);
      threads.push(...(page?.data ?? []));
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    return threads;
  }

  async #initializeHistoricalSubagentBackfill() {
    const backfill = this.historicalSubagentBackfill;
    if (!backfill.pending || backfill.initialized) return false;
    if (!backfill.prepared) {
      const preparation = await this.prepareHistoricalBackfill();
      backfill.prepared = true;
      backfill.backupFile = String(preparation?.backupFile ?? "").trim();
    }
    const candidates = new Map();
    for (const value of await this.#discoverThreads()) {
      const thread = threadReference(value);
      if (!thread.id || !thread.path) continue;
      if (!await this.#projectFor(thread)) continue;
      candidates.set(historicalRolloutKey(thread), thread);
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
    this.historicalTurnIdentities.clear();
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
    let handledTurns = 0;
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
    const useBoundedHistoricalScan = startOffset > 0
      || info.size > this.historicalSubagentBackfillBytes;
    if (typeof this.scanHistoricalFile === "function" && !useBoundedHistoricalScan) {
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
        const identity = historicalTurnIdentity(item.thread, turn.turnId, historical?.session);
        if (!this.historicalTurnIdentities.has(identity)) {
          const handled = await this.reconcile(item.thread, project, {
            turnId: turn.turnId,
            status: turn.status || "completed",
            completedAt: turn.completedAt || turn.lastActivityAt,
            historical: true,
            usageResult: turn,
          });
          if (handled === false) return changed;
          this.historicalTurnIdentities.add(identity);
          backfill.processedTurns += 1;
          backfill.projectionPending = true;
          changed = true;
        }
        item.terminalTurnIndex += 1;
        handledTurns += 1;
        if (handledTurns >= this.historicalTurnsPerRun) return changed;
      }

      const stale = this.now() - Number(info.mtimeMs || 0) >= this.historicalActiveStaleMs;
      if (stale) {
        const staleTurns = turns.filter((turn) => turn?.terminal !== true && turn?.startedAt);
        while (item.staleTurnIndex < staleTurns.length) {
          if (!this.shouldRunHistoricalBackfill()) return changed;
          const turn = staleTurns[item.staleTurnIndex];
          const identity = historicalTurnIdentity(item.thread, turn.turnId, historical?.session);
          if (!this.historicalTurnIdentities.has(identity)) {
            const handled = await this.reconcile(item.thread, project, {
              turnId: turn.turnId,
              status: "aborted",
              completedAt: turn.lastActivityAt || turn.startedAt || new Date(info.mtimeMs).toISOString(),
              authoritative: true,
              historical: true,
              usageResult: turn,
            });
            if (handled === false) return changed;
            this.historicalTurnIdentities.add(identity);
            backfill.processedTurns += 1;
            backfill.projectionPending = true;
            changed = true;
          }
          item.staleTurnIndex += 1;
          handledTurns += 1;
          if (handledTurns >= this.historicalTurnsPerRun) return changed;
        }
      }
      this.historicalScanCache.delete(cacheKey);
      backfill.queue.shift();
      backfill.completedFiles += 1;
      if (!backfill.queue.length) backfill.pending = false;
      return true;
    }
    if (useBoundedHistoricalScan && typeof this.scanHistoricalFile === "function") {
      const cacheKey = historicalRolloutKey(item.thread);
      let cached = this.historicalScanCache.get(cacheKey);
      if (!cached || cached.startOffset !== startOffset || !cached.result) {
        cached = {
          startOffset,
          result: await this.scanHistoricalChunk(item.thread.path, {
            startOffset,
            maxBytes: this.historicalSubagentBackfillBytes,
            resumeState: item.resumeState ?? null,
          }),
        };
        this.historicalScanCache.set(cacheKey, cached);
      }
      const historical = cached.result;
      const terminalTurns = (historical?.turns ?? []).filter((turn) => turn?.terminal === true);
      for (const turn of terminalTurns) {
        if (!this.shouldRunHistoricalBackfill()) return changed;
        const identity = historicalTurnIdentity(item.thread, turn.turnId, historical?.session);
        if (this.historicalTurnIdentities.has(identity)) continue;
        const handled = await this.reconcile(item.thread, project, {
          turnId: turn.turnId,
          status: turn.status || "completed",
          completedAt: turn.completedAt || turn.lastActivityAt,
          historical: true,
          usageResult: turn,
        });
        if (handled === false) return changed;
        this.historicalTurnIdentities.add(identity);
        backfill.processedTurns += 1;
        backfill.projectionPending = true;
        changed = true;
        handledTurns += 1;
        if (handledTurns >= this.historicalTurnsPerRun) return changed;
      }
      if (historical.nextOffset < startOffset
        || (historical.nextOffset === startOffset && startOffset < info.size)) {
        return changed;
      }

      item.offset = historical.nextOffset;
      item.size = Number(info.size) || item.size;
      item.resumeState = historical.resumeState ?? null;
      item.activeTurns = historical.resumeState?.turns ?? [];
      cached.startOffset = item.offset;
      cached.result = null;
      changed = true;
      if (item.offset < info.size) return changed;

      if (item.activeTurns.length) {
        const stale = this.now() - Number(info.mtimeMs || 0) >= this.historicalActiveStaleMs;
        if (!stale) {
          backfill.queue.push(backfill.queue.shift());
          return true;
        }
        for (const turn of item.activeTurns) {
          const identity = historicalTurnIdentity(item.thread, turn.turnId, historical?.session);
          if (this.historicalTurnIdentities.has(identity)) continue;
          const handled = await this.reconcile(item.thread, project, {
            turnId: turn.turnId,
            status: "aborted",
            completedAt: turn.lastActivityAt || turn.startedAt || new Date(info.mtimeMs).toISOString(),
            authoritative: true,
            historical: true,
            usageResult: turn,
          });
          if (handled === false) return changed;
          this.historicalTurnIdentities.add(identity);
          backfill.processedTurns += 1;
          backfill.projectionPending = true;
          handledTurns += 1;
          if (handledTurns >= this.historicalTurnsPerRun) return changed;
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
      const identity = historicalTurnIdentity(item.thread, terminal.turnId);
      if (this.historicalTurnIdentities.has(identity)) continue;
      if (await this.reconcile(item.thread, project, {
        ...terminal,
        historical: true,
      }) === false) {
        allHandled = false;
      } else {
        this.historicalTurnIdentities.add(identity);
        backfill.processedTurns += 1;
        backfill.projectionPending = true;
        handledTurns += 1;
        if (handledTurns >= this.historicalTurnsPerRun) return changed;
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
          const identity = historicalTurnIdentity(item.thread, turn.turnId);
          if (this.historicalTurnIdentities.has(identity)) continue;
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
          else {
            this.historicalTurnIdentities.add(identity);
            backfill.processedTurns += 1;
            backfill.projectionPending = true;
            handledTurns += 1;
            if (handledTurns >= this.historicalTurnsPerRun) return true;
          }
        }
        if (!activeHandled) return true;
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
    let madeProgress = false;
    let allHandled = true;
    const supplementalThreads = [];
    const supplementalThreadIds = new Set();

    try {
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
      const threads = [
        ...await this.#discoverThreads(),
        ...supplementalThreads,
      ];
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
          const canResume = await this.#canResume(prior, transcriptPath, info);
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
              ...(rolloutFileIdentity(info) ? { fileIdentity: rolloutFileIdentity(info) } : {}),
            });
            madeProgress = true;
            continue;
          }

          if (bootstrapping && olderThanBoundary && !backfillMissingSubagent) {
            this.#setPosition(threadId, {
              path: transcriptPath,
              offset: info.size,
              ...(rolloutFileIdentity(info) ? { fileIdentity: rolloutFileIdentity(info) } : {}),
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
          // Keep the prior position for this rollout and retry it on a later pass.
          // A damaged or disappeared file must not block other independent threads.
          allHandled = false;
        }
      }

      if (allHandled) {
        this.subagentBackfillPending = false;
        this.completedThroughMs = startedAtMs;
        madeProgress = true;
      }
      madeProgress = await this.#runHistoricalSubagentBackfill() || madeProgress;
      if (!this.historicalSubagentBackfill.pending
        && this.historicalSubagentBackfill.projectionPending) {
        await this.flushHistoricalProjection();
        this.historicalSubagentBackfill.projectionPending = false;
        madeProgress = true;
      }
      return madeProgress;
    } finally {
      this.running = false;
    }
  }
}
