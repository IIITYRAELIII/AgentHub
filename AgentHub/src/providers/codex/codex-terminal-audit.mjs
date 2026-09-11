import { contourRolloutPolicy } from "../../infrastructure/filesystem/test-contour-rollout-policy.mjs";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";
import { scanCodexHistoricalRollout } from "./codex-turn-usage.mjs";
import { uuidV7TimestampMs } from "./codex-subagent-accounting.mjs";

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
const DEFAULT_LIVE_SCAN_BYTES = 128 * 1024;
const DEFAULT_AUDIT_BYTES_PER_RUN = 512 * 1024;
const DEFAULT_AUDIT_THREADS_PER_RUN = 8;
const DEFAULT_AUDIT_TURNS_PER_RUN = 20;
const DEFAULT_AUDIT_TIME_MS = 75;
const ROLLOUT_CHECKPOINT_BYTES = 128;
const SNAPSHOT_VERSION = 18;
const COMPATIBLE_SNAPSHOT_VERSIONS = new Set([
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, SNAPSHOT_VERSION,
]);
const HISTORICAL_BACKFILL_STATE_VERSIONS = new Set([SNAPSHOT_VERSION]);

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
    ...(value?.backlog === true ? { backlog: true } : {}),
    ...(value?.resumeState ? { resumeState: structuredClone(value.resumeState) } : {}),
    ...(String(value?.fileIdentity ?? "").trim()
      ? { fileIdentity: String(value.fileIdentity).trim() }
      : {}),
    ...(String(value?.fileCheckpoint ?? "").trim()
      ? { fileCheckpoint: String(value.fileCheckpoint).trim() }
      : {}),
    ...(value?.pendingScan && typeof value.pendingScan === "object"
      ? {
          pendingScan: {
            fingerprint: String(value.pendingScan.fingerprint ?? ""),
            terminalIndex: Math.max(0, Math.floor(Number(value.pendingScan.terminalIndex) || 0)),
            nextOffset: Math.max(offset, Math.floor(Number(value.pendingScan.nextOffset) || offset)),
            resumeState: value.pendingScan.resumeState ?? null,
          },
        }
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
  if (requireResumeState && !prior.resumeState && !prior.pendingScan) return false;
  const currentIdentity = rolloutFileIdentity(info);
  return !prior.fileIdentity || !currentIdentity || prior.fileIdentity === currentIdentity;
}

function isNativeRolloutTurn(threadId, turn) {
  const rolloutCreatedAt = uuidV7TimestampMs(threadId);
  const turnCreatedAt = uuidV7TimestampMs(turn?.turnId);
  return !(rolloutCreatedAt > 0 && turnCreatedAt > 0 && turnCreatedAt < rolloutCreatedAt);
}

function normalizedLiveScanResult(result, threadId) {
  const nativeTurn = (turn) => isNativeRolloutTurn(threadId, turn);
  const activeTurnIds = Array.isArray(result?.resumeState?.activeTurnIds)
    ? new Set(result.resumeState.activeTurnIds.map(String))
    : null;
  const activeTurn = (turn) => nativeTurn(turn)
    && (!activeTurnIds || activeTurnIds.has(String(turn?.turnId)));
  if (!Array.isArray(result?.turns)) return {
    ...result,
    terminals: (result?.terminals ?? []).filter(nativeTurn),
    activeTurns: (result?.activeTurns ?? []).filter(activeTurn),
  };
  const turns = result.turns.filter(nativeTurn);
  const activeTurns = (Array.isArray(result.resumeState?.turns)
    ? result.resumeState.turns
    : result.turns.filter((turn) => turn?.terminal !== true)).filter(activeTurn);
  const attachmentCandidates = new Map((result.attachmentCandidates ?? []).flatMap((candidate) => {
    if (!nativeTurn(candidate)) return [];
    const turnId = String(candidate?.turnId ?? "").trim();
    const sources = (candidate?.generatedImageSources ?? []).filter((source) => (
      source?.type === "generated-path" && String(source.value ?? "").trim()
    ));
    return turnId && sources.length ? [[turnId, sources]] : [];
  }));
  const terminalTurnIds = new Set(turns
    .filter((turn) => turn?.terminal === true)
    .map((turn) => String(turn.turnId)));
  return {
    terminals: [...turns
      .filter((turn) => turn?.terminal === true)
      .map((turn) => ({
        turnId: String(turn.turnId),
        status: terminalTurnStatus(turn.status) || "completed",
        completedAt: String(turn.completedAt ?? turn.lastActivityAt ?? ""),
        ...(turn.contextProbe === true ? { contextProbe: true } : {}),
        ...(attachmentCandidates.has(String(turn.turnId)) ? {
          generatedImageSources: attachmentCandidates.get(String(turn.turnId)),
        } : {}),
        usageResult: turn,
      })), ...[...attachmentCandidates].flatMap(([turnId, generatedImageSources]) => (
        terminalTurnIds.has(turnId) ? [] : [{
          turnId,
          attachmentRepairOnly: true,
          generatedImageSources,
        }]
      ))],
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
    if (!turnId || !isNativeRolloutTurn(thread.id, turn)) continue;
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
      attachmentCandidateIndex: Math.max(0, Number(item?.attachmentCandidateIndex) || 0),
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
    recordingRoot = null,
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
    incrementalUsageScan = scanFile === scanCodexHistoricalRollout,
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
    liveScanBytes = DEFAULT_LIVE_SCAN_BYTES,
    auditBytesPerRun = DEFAULT_AUDIT_BYTES_PER_RUN,
    auditThreadsPerRun = DEFAULT_AUDIT_THREADS_PER_RUN,
    auditTurnsPerRun = DEFAULT_AUDIT_TURNS_PER_RUN,
    auditTimeMs = DEFAULT_AUDIT_TIME_MS,
    shouldRunAudit = () => true,
    persistProgress = null,
    maxPositions = 5_000,
  }) {
    this.rolloutPolicy = recordingRoot ? contourRolloutPolicy({ testContourRecording: { root: recordingRoot } }) : null;
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
    this.incrementalUsageScan = incrementalUsageScan;
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
    this.liveScanBytes = Math.max(16 * 1024, Number(liveScanBytes) || DEFAULT_LIVE_SCAN_BYTES);
    this.auditBytesPerRun = Math.max(
      this.liveScanBytes,
      Number(auditBytesPerRun) || DEFAULT_AUDIT_BYTES_PER_RUN,
    );
    this.auditThreadsPerRun = Math.max(
      1,
      Math.floor(Number(auditThreadsPerRun) || DEFAULT_AUDIT_THREADS_PER_RUN),
    );
    this.auditTurnsPerRun = Math.max(
      1,
      Math.floor(Number(auditTurnsPerRun) || DEFAULT_AUDIT_TURNS_PER_RUN),
    );
    this.auditTimeMs = Math.max(1, Number(auditTimeMs) || DEFAULT_AUDIT_TIME_MS);
    this.shouldRunAudit = shouldRunAudit;
    this.persistProgress = typeof persistProgress === "function" ? persistProgress : null;
    this.persistsProgress = Boolean(this.persistProgress);
    this.maxPositions = Math.max(100, Number(maxPositions) || 5_000);
    this.completedThroughMs = 0;
    this.positions = new Map();
    this.pendingTurns = new Map();
    this.subagentBackfillPending = false;
    this.historicalSubagentBackfill = emptyHistoricalSubagentBackfill();
    this.historicalScanCache = new Map();
    this.historicalTurnIdentities = new Set();
    this.lastSupplementalDiscoveryMs = 0;
    this.liveProjectionPending = false;
    this.lastRun = null;
    this.nextThreadId = "";
    this.priorityTurn = true;
    this.running = false;
  }

  restore(snapshot) {
    const snapshotVersion = Number(snapshot?.version);
    const compatibleSnapshot = COMPATIBLE_SNAPSHOT_VERSIONS.has(snapshotVersion);
    const compatibleHistoricalBackfill = HISTORICAL_BACKFILL_STATE_VERSIONS.has(snapshotVersion);
    this.nextThreadId = compatibleSnapshot ? String(snapshot?.nextThreadId ?? "").trim() : "";
    this.priorityTurn = !compatibleSnapshot || snapshot?.priorityTurn !== false;
    this.completedThroughMs = compatibleSnapshot ? timestampMs(snapshot?.completedThrough) : 0;
    this.positions.clear();
    this.pendingTurns.clear();
    this.subagentBackfillPending = snapshotVersion === 4
      || (compatibleSnapshot && snapshot?.subagentBackfillPending === true);
    this.historicalSubagentBackfill = compatibleHistoricalBackfill
      ? restoredHistoricalSubagentBackfill(snapshot?.historicalSubagentBackfill)
      : emptyHistoricalSubagentBackfill(compatibleSnapshot);
    this.historicalScanCache.clear();
    this.historicalTurnIdentities = new Set(
      compatibleHistoricalBackfill
        && Array.isArray(snapshot?.historicalSubagentBackfill?.processedTurnIdentities)
        ? snapshot.historicalSubagentBackfill.processedTurnIdentities
          .map((value) => String(value ?? "").trim())
          .filter(Boolean)
        : [],
    );
    this.liveProjectionPending = snapshotVersion === SNAPSHOT_VERSION
      && snapshot?.liveProjectionPending === true;
    this.lastRun = snapshotVersion === SNAPSHOT_VERSION && snapshot?.lastRun
      ? structuredClone(snapshot.lastRun)
      : null;
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
      liveProjectionPending: this.liveProjectionPending,
      lastRun: this.lastRun,
      nextThreadId: this.nextThreadId,
      priorityTurn: this.priorityTurn,
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

  hasPendingHistoricalMaintenance() {
    return this.historicalSubagentBackfill.pending === true;
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

  #budget(startedAtMs) {
    return {
      startedAtMs,
      bytes: 0,
      threads: 0,
      turns: 0,
      workUnits: 0,
      scanElapsedMs: 0,
      backlogThreads: new Set([...this.positions].filter(([, position]) => position.backlog || position.pendingScan).map(([id]) => id)),
      yielded: "",
    };
  }

  #hasBudget(budget, { scan = false } = {}) {
    if (scan && budget.bytes >= this.auditBytesPerRun) {
      budget.yielded ||= "bytes";
      return false;
    }
    if (scan && budget.threads >= this.auditThreadsPerRun) {
      budget.yielded ||= "threads";
      return false;
    }
    if (budget.turns >= this.auditTurnsPerRun) {
      budget.yielded ||= "turns";
      return false;
    }
    if (budget.workUnits > 0
      && this.now() - budget.startedAtMs - budget.scanElapsedMs >= this.auditTimeMs) {
      budget.yielded ||= "time";
      return false;
    }
    if (!this.shouldRunAudit()) {
      budget.yielded ||= "interactive";
      return false;
    }
    return true;
  }

  #scanFingerprint(result) {
    const digest = createHash("sha256");
    for (const terminal of result?.terminals ?? []) {
      digest.update(JSON.stringify([
        String(terminal?.turnId ?? ""),
        String(terminal?.status ?? ""),
        String(terminal?.completedAt ?? ""),
        terminal?.attachmentRepairOnly === true,
        (terminal?.generatedImageSources ?? []).map((source) => [source?.type, source?.value]),
      ])).update("\0");
    }
    return `${Math.max(0, Number(result?.nextOffset) || 0)}:${digest.digest("hex")}`;
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

  async #reconcileLive(thread, project, terminal) {
    return this.reconcile(thread, project, terminal, {
      deferProjection: true,
      onProjectionDeferred: () => { this.liveProjectionPending = true; },
    });
  }

  async #reconcileHistorical(thread, project, terminal, options) {
    return this.reconcile(thread, project, terminal, {
      ...options,
      onProjectionDeferred: () => { this.historicalSubagentBackfill.projectionPending = true; },
    });
  }

  async #auditThread(thread, project, lowerBoundMs, budget, fileInfo = null) {
    const threadId = String(thread?.id ?? "").trim();
    const transcriptPath = String(thread?.path ?? "").trim();
    if (!threadId || !transcriptPath) return { handled: true, complete: true, progressed: false };

    const info = fileInfo ?? await this.statFile(transcriptPath);
    const prior = this.positions.get(threadId);
    const canResume = await this.#canResume(prior, transcriptPath, info);
    const startOffset = canResume ? prior.offset : 0;
    if (!this.#hasBudget(budget, { scan: true })) {
      return { handled: true, complete: false, progressed: false };
    }
    const remainingBytes = Math.max(1, this.auditBytesPerRun - budget.bytes);
    const scanStartedAtMs = this.now();
    const scanned = await this.scanFile(transcriptPath, {
      startOffset,
      maxBytes: Math.min(this.liveScanBytes, remainingBytes),
      ...(canResume && prior.resumeState ? { resumeState: prior.resumeState } : {}),
    });
    if (this.incrementalUsageScan) {
      budget.scanElapsedMs += Math.max(0, this.now() - scanStartedAtMs);
    }
    const result = normalizedLiveScanResult(scanned, threadId);
    budget.threads += 1;
    budget.bytes += Math.max(0, Number(result.nextOffset) - startOffset);
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

    const fingerprint = this.#scanFingerprint(result);
    let terminalIndex = canResume && prior?.pendingScan?.fingerprint === fingerprint
      ? Math.min(terminals.length, prior.pendingScan.terminalIndex)
      : 0;
    const initialTerminalIndex = terminalIndex;
    let allHandled = true;
    for (; terminalIndex < terminals.length; terminalIndex += 1) {
      if (!this.#hasBudget(budget)) break;
      const terminal = terminals[terminalIndex];
      const candidate = isCodexContextProbeTurn(terminal)
        ? { ...terminal, historical: true, resolveCurrentAccount: true }
        : terminal;
      const handled = await this.#reconcileLive(thread, project, candidate);
      budget.workUnits += 1;
      if (handled === false) {
        allHandled = false;
        break;
      }
      budget.turns += 1;
      this.#removePendingTurn(threadId, terminal.turnId);
    }
    if (!allHandled || terminalIndex < terminals.length) {
      budget.backlogThreads.add(threadId);
      this.#setPosition(threadId, {
        path: transcriptPath,
        offset: startOffset,
        backlog: true,
        ...(canResume && prior?.resumeState ? { resumeState: prior.resumeState } : {}),
        pendingScan: {
          fingerprint,
          terminalIndex,
          nextOffset: result.nextOffset,
          resumeState: result.resumeState ?? null,
        },
        ...(rolloutFileIdentity(info) ? { fileIdentity: rolloutFileIdentity(info) } : {}),
        ...(this.incrementalUsageScan && startOffset > 0
          ? { fileCheckpoint: await this.readCheckpoint(transcriptPath, startOffset) }
          : {}),
      });
      return {
        handled: allHandled,
        complete: false,
        progressed: terminalIndex > initialTerminalIndex,
      };
    }
    this.#setPosition(threadId, {
      path: transcriptPath,
      offset: result.nextOffset,
      ...(result.nextOffset < info.size ? { backlog: true } : {}),
      ...(result.resumeState ? { resumeState: result.resumeState } : {}),
      ...(rolloutFileIdentity(info) ? { fileIdentity: rolloutFileIdentity(info) } : {}),
      ...(this.incrementalUsageScan
        ? { fileCheckpoint: await this.readCheckpoint(transcriptPath, result.nextOffset) }
        : {}),
    });
    if (result.nextOffset < info.size) budget.backlogThreads.add(threadId);
    else budget.backlogThreads.delete(threadId);
    return {
      handled: true,
      complete: result.nextOffset >= info.size,
      progressed: result.nextOffset > startOffset || terminals.length > 0,
    };
  }

  async #pollPendingTurns(lowerBoundMs, budget, selectedThreadId) {
    let madeProgress = false;
    let complete = true;
    const nowMs = this.now();
    for (const [threadId, pending] of [...this.pendingTurns]) {
      if (threadId !== selectedThreadId) continue;
      if (!this.#hasBudget(budget)) {
        complete = false;
        break;
      }
      try {
        const project = await this.#projectFor(pending.thread);
        if (!project) continue;
        const position = this.positions.get(threadId);
        const info = await this.statFile(pending.thread.path);
        if (await this.#canResume(position, pending.thread.path, info) && position.offset < info.size) {
          budget.backlogThreads.add(threadId);
          const audit = await this.#auditThread(pending.thread, project, lowerBoundMs, budget, info);
          madeProgress = madeProgress || audit.progressed;
          if (!audit.complete) complete = false;
          if (!audit.handled || !audit.complete || !this.pendingTurns.has(threadId)) continue;
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
          if (!this.#hasBudget(budget)) {
            complete = false;
            break;
          }
          current.turns.delete(turn.turnId);
          current.turns.set(turn.turnId, turn);
          try {
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
            const handled = await this.#reconcileLive(fullThread, project, {
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
            budget.turns += 1;
            this.#removePendingTurn(threadId, turn.turnId);
            madeProgress = true;
          } finally {
            budget.workUnits += 1;
          }
        }
        const remaining = this.pendingTurns.get(threadId);
        if (remaining) remaining.nextStatusCheckMs = nowMs + this.statusPollMs;
      } catch {
        // Retain this pending turn unchanged; another rollout must still be auditable.
      }
    }
    return { madeProgress, complete };
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
          attachmentCandidateIndex: 0,
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

  async #runHistoricalSubagentBackfill({ localOnlyAccounting = false } = {}) {
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
          const handled = await this.#reconcileHistorical(item.thread, project, {
            turnId: turn.turnId,
            status: turn.status || "completed",
            completedAt: turn.completedAt || turn.lastActivityAt,
            historical: true,
            usageResult: turn,
          }, { localOnlyAccounting });
          if (handled === false) return changed;
          this.historicalTurnIdentities.add(identity);
          backfill.processedTurns += 1;
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
            const handled = await this.#reconcileHistorical(item.thread, project, {
              turnId: turn.turnId,
              status: "aborted",
              completedAt: turn.lastActivityAt || turn.startedAt || new Date(info.mtimeMs).toISOString(),
              authoritative: true,
              historical: true,
              usageResult: turn,
            }, { localOnlyAccounting });
            if (handled === false) return changed;
            this.historicalTurnIdentities.add(identity);
            backfill.processedTurns += 1;
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
      const terminalTurns = (historical?.turns ?? []).filter((turn) => (
        turn?.terminal === true && isNativeRolloutTurn(item.thread.id, turn)
      ));
      for (const turn of terminalTurns) {
        if (!this.shouldRunHistoricalBackfill()) return changed;
        const identity = historicalTurnIdentity(item.thread, turn.turnId, historical?.session);
        if (this.historicalTurnIdentities.has(identity)) continue;
        const handled = await this.#reconcileHistorical(item.thread, project, {
          turnId: turn.turnId,
          status: turn.status || "completed",
          completedAt: turn.completedAt || turn.lastActivityAt,
          historical: true,
          usageResult: turn,
        }, { localOnlyAccounting });
        if (handled === false) return changed;
        this.historicalTurnIdentities.add(identity);
        backfill.processedTurns += 1;
        changed = true;
        handledTurns += 1;
        if (handledTurns >= this.historicalTurnsPerRun) return changed;
      }
      const terminalTurnIds = new Set((historical?.turns ?? [])
        .filter((turn) => turn?.terminal === true).map((turn) => String(turn.turnId)));
      const attachmentCandidates = (historical?.attachmentCandidates ?? []).filter((candidate) => (
        !terminalTurnIds.has(String(candidate?.turnId ?? ""))
      ));
      while (item.attachmentCandidateIndex < attachmentCandidates.length) {
        if (!this.shouldRunHistoricalBackfill()) return changed;
        const candidate = attachmentCandidates[item.attachmentCandidateIndex];
        if (!isNativeRolloutTurn(item.thread.id, candidate)) {
          item.attachmentCandidateIndex += 1;
          changed = true;
          continue;
        }
        const handled = await this.#reconcileHistorical(item.thread, project, {
          turnId: String(candidate.turnId),
          attachmentRepairOnly: true,
          historical: true,
          generatedImageSources: candidate.generatedImageSources,
        }, { localOnlyAccounting });
        if (handled === false) return changed;
        item.attachmentCandidateIndex += 1;
        handledTurns += 1;
        changed = true;
        if (handledTurns >= this.historicalTurnsPerRun) return changed;
      }
      if (historical.nextOffset < startOffset
        || (historical.nextOffset === startOffset && startOffset < info.size)) {
        return changed;
      }

      item.offset = historical.nextOffset;
      item.size = Number(info.size) || item.size;
      item.resumeState = historical.resumeState ?? null;
      item.activeTurns = (historical.resumeState?.turns ?? []).filter((turn) => (
        isNativeRolloutTurn(item.thread.id, turn)
      ));
      item.attachmentCandidateIndex = 0;
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
          const handled = await this.#reconcileHistorical(item.thread, project, {
            turnId: turn.turnId,
            status: "aborted",
            completedAt: turn.lastActivityAt || turn.startedAt || new Date(info.mtimeMs).toISOString(),
            authoritative: true,
            historical: true,
            usageResult: turn,
          }, { localOnlyAccounting });
          if (handled === false) return changed;
          this.historicalTurnIdentities.add(identity);
          backfill.processedTurns += 1;
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
    const result = normalizedLiveScanResult(await this.scanFile(item.thread.path, {
      startOffset,
      maxBytes: this.historicalSubagentBackfillBytes,
      rolloutId: item.thread.id,
      initialActiveTurns: item.activeTurns,
    }), item.thread.id);
    let allHandled = true;
    for (const terminal of result.terminals ?? []) {
      const identity = historicalTurnIdentity(item.thread, terminal.turnId);
      if (this.historicalTurnIdentities.has(identity)) continue;
      if (await this.#reconcileHistorical(item.thread, project, {
        ...terminal,
        historical: true,
      }, { localOnlyAccounting }) === false) {
        allHandled = false;
      } else {
        this.historicalTurnIdentities.add(identity);
        backfill.processedTurns += 1;
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
          const handled = await this.#reconcileHistorical(item.thread, project, {
            turnId: turn.turnId,
            status: "aborted",
            completedAt: new Date(
              timestampMs(turn.lastActivityAt)
              || Number(info.mtimeMs)
              || this.now(),
            ).toISOString(),
            authoritative: true,
            historical: true,
          }, { localOnlyAccounting });
          if (handled === false) activeHandled = false;
          else {
            this.historicalTurnIdentities.add(identity);
            backfill.processedTurns += 1;
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

  async #flushCompletedHistoricalProjection() {
    if (this.historicalSubagentBackfill.pending
      || !this.historicalSubagentBackfill.projectionPending
      || !this.shouldRunAudit()) return false;
    await this.flushHistoricalProjection();
    this.historicalSubagentBackfill.projectionPending = false;
    return true;
  }

  async excludeCapturedRollouts() {
    const status = {
      ...this.rolloutPolicy.exclude("terminal-audit"),
      pendingThreads: this.pendingTurns.size,
      pendingTurns: [...this.pendingTurns.values()].reduce((sum, item) => sum + item.turns.size, 0),
      historicalFiles: this.historicalSubagentBackfill.queue.length,
      positions: this.positions.size,
      cycleComplete: false, backlog: false,
    };
    if (JSON.stringify(this.lastRun) !== JSON.stringify(status)) {
      this.lastRun = status;
      if (this.persistProgress) await this.persistProgress();
    }
    return false;
  }

  async runHistoricalMaintenance({ localOnlyAccounting = false } = {}) {
    if (this.rolloutPolicy) return this.excludeCapturedRollouts();
    if (this.running || !this.hasPendingHistoricalMaintenance()) return false;
    this.running = true;
    const startedAtMs = this.now();
    try {
      if (!this.shouldRunAudit() || !this.shouldRunHistoricalBackfill()) return false;
      let changed = await this.#runHistoricalSubagentBackfill({ localOnlyAccounting });
      this.lastRun = {
        completedAt: new Date(this.now()).toISOString(),
        elapsedMs: Math.max(0, this.now() - startedAtMs),
        bytes: 0,
        threads: 0,
        turns: 0,
        cycleComplete: !this.historicalSubagentBackfill.pending,
        yielded: this.historicalSubagentBackfill.pending ? "historical-maintenance" : "",
        maintenanceOnly: true,
      };
      if (changed && this.persistProgress) await this.persistProgress();
      if (await this.#flushCompletedHistoricalProjection()) {
        changed = true;
        if (this.persistProgress) await this.persistProgress();
      }
      return changed;
    } finally {
      this.running = false;
    }
  }

  async run() {
    if (this.rolloutPolicy) return this.excludeCapturedRollouts();
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
    let cycleComplete = true;
    const supplementalThreads = [];
    const supplementalThreadIds = new Set();

    try {
      if (!this.shouldRunAudit()) return false;
      // A versioned historical repair is a bounded local migration. Give it
      // one owned pass and persist its checkpoint before live reconciliation:
      // a slow or stalled live rollout must not starve an already-known repair.
      if (this.hasPendingHistoricalMaintenance()) {
        madeProgress = await this.#runHistoricalSubagentBackfill() || madeProgress;
        if (madeProgress && this.persistProgress) await this.persistProgress();
        if (await this.#flushCompletedHistoricalProjection()) {
          madeProgress = true;
          if (this.persistProgress) await this.persistProgress();
        }
      }
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
      const discovered = await this.#discoverThreads();
      const uniqueThreads = new Map();
      for (const thread of [...discovered, ...supplementalThreads]) {
        const threadId = String(thread?.id ?? "").trim();
        if (threadId && !uniqueThreads.has(threadId)) uniqueThreads.set(threadId, thread);
      }
      for (const [threadId, pending] of this.pendingTurns) {
        if (!uniqueThreads.has(threadId)) uniqueThreads.set(threadId, pending.thread);
      }
      const candidates = [...uniqueThreads.values()].sort((left, right) => (
        timestampMs(right.updatedAt) - timestampMs(left.updatedAt)
      ));
      const startIndex = Math.max(0, candidates.findIndex((thread) => String(thread.id).trim() === this.nextThreadId));
      const ordinaryThreads = [...candidates.slice(startIndex), ...candidates.slice(0, startIndex)];
      const priorityThreadId = this.priorityTurn
        ? [...new Set([
          ...[...this.positions].filter(([, position]) => position.backlog || position.pendingScan).map(([id]) => id),
          ...this.pendingTurns.keys(),
        ])].find((id) => (
          uniqueThreads.has(id)
          && (this.positions.get(id)?.backlog || this.positions.get(id)?.pendingScan || this.pendingTurns.has(id))
        ))
        : null;
      const priorityThread = priorityThreadId ? uniqueThreads.get(priorityThreadId) : null;
      const threads = priorityThread
        ? [priorityThread, ...ordinaryThreads.filter((thread) => String(thread.id).trim() !== priorityThreadId)]
        : ordinaryThreads;
      const nextOrdinaryId = new Map(ordinaryThreads.map((thread, index) => [
        String(thread.id).trim(),
        ordinaryThreads.length > 1 ? String(ordinaryThreads[(index + 1) % ordinaryThreads.length].id).trim() : "",
      ]));
      const budget = this.#budget(this.now());
      for (const [index, thread] of threads.entries()) {
        if (index >= Math.max(64, this.auditThreadsPerRun * 16)) {
          budget.yielded ||= "entries";
          cycleComplete = false;
          break;
        }
        if (!this.#hasBudget(budget, { scan: true })) {
          cycleComplete = false;
          break;
        }
        const threadId = String(thread.id).trim();
        const priority = thread === priorityThread;
        const nextThreadId = priority ? this.nextThreadId : nextOrdinaryId.get(threadId);
        madeProgress = madeProgress || this.nextThreadId !== nextThreadId || this.priorityTurn !== !priority;
        this.nextThreadId = nextThreadId;
        this.priorityTurn = !priority;
        try {
          if (this.pendingTurns.has(threadId)) {
            const pending = this.pendingTurns.get(threadId);
            this.pendingTurns.delete(threadId);
            this.pendingTurns.set(threadId, pending);
            const pendingPoll = await this.#pollPendingTurns(lowerBoundMs, budget, threadId);
            madeProgress = pendingPoll.madeProgress || madeProgress;
            cycleComplete = pendingPoll.complete && cycleComplete;
            budget.workUnits += 1;
            if (!this.#hasBudget(budget, { scan: true })) {
              cycleComplete = false;
              continue;
            }
          }
          const project = await this.#projectFor(thread);
          if (!project || !thread?.path) continue;
          const transcriptPath = String(thread.path);
          const info = await this.statFile(transcriptPath);
          const prior = this.positions.get(threadId);
          const canResume = await this.#canResume(prior, transcriptPath, info);
          const hasUnreadBytes = canResume && prior.offset < info.size;
          if (hasUnreadBytes) budget.backlogThreads.add(threadId);
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
          if (canResume && prior.offset >= info.size && !backfillMissingSubagent) continue;
          const audit = await this.#auditThread(
            thread,
            project,
            backfillMissingSubagent ? 0 : lowerBoundMs,
            budget,
            info,
          );
          madeProgress = madeProgress || audit.progressed;
          allHandled = allHandled && audit.handled;
          if (!audit.complete) cycleComplete = false;
        } catch {
          // Keep the prior position for this rollout and retry it on a later pass.
          // A damaged or disappeared file must not block other independent threads.
          allHandled = false;
        } finally {
          budget.workUnits += 1;
        }
      }

      if (cycleComplete && allHandled) {
        this.subagentBackfillPending = false;
        this.completedThroughMs = startedAtMs;
        madeProgress = true;
      }
      this.lastRun = {
        completedAt: new Date(this.now()).toISOString(),
        elapsedMs: Math.max(0, this.now() - startedAtMs),
        bytes: budget.bytes,
        threads: budget.threads,
        turns: budget.turns,
        cycleComplete,
        yielded: budget.yielded,
        backlog: budget.backlogThreads.size > 0,
      };
      if (madeProgress && this.persistProgress) await this.persistProgress();
      if ((this.liveProjectionPending || (
        !this.historicalSubagentBackfill.pending
        && this.historicalSubagentBackfill.projectionPending
      )) && this.shouldRunAudit()) {
        await this.flushHistoricalProjection();
        this.liveProjectionPending = false;
        this.historicalSubagentBackfill.projectionPending = false;
        madeProgress = true;
        if (this.persistProgress) await this.persistProgress();
      }
      return madeProgress;
    } finally {
      this.running = false;
    }
  }
}
