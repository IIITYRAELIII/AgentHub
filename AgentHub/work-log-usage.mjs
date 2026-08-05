import crypto from "node:crypto";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { looksLikeImageGenerationPrompt } from "./src/domain/codex-usage-estimate.mjs";
import { normalizeServiceTier } from "./src/domain/token-usage.mjs";
import { writeTextAtomic } from "./src/infrastructure/persistence/state-store.mjs";
import { withInterprocessLocks } from "./src/infrastructure/process/interprocess-lock.mjs";
import { JournalDatabase } from "./src/infrastructure/persistence/journal-database.mjs";
import { replaceJournalProjectionFromMarkdown } from "./src/application/journal-projection-service.mjs";
import {
  ledgerRecordChanges,
  ledgerRecordSnapshot,
} from "./src/infrastructure/persistence/incremental-ledger.mjs";
import {
  buildWorkLogUsageHistory,
  incomingLedgerRecord,
  mergeLedgerRecord,
  normalizeEstimatedCredits,
  normalizedLedger,
  normalizeProjectRoot,
  normalizeWorkLogId,
  projectWorkLogRateLimits,
  projectWorkLogUsage,
  sameProjectRoot,
  searchWorkLogRecords,
  taskThreadId,
  workLogTurnKey,
} from "./src/application/work-log-usage-projection.mjs";

export {
  applyWorkLogUsage,
  buildWorkLogUsageHistory,
  formatWorkLogUsage,
  normalizeWorkLogId,
  projectWorkLogRateLimits,
  projectWorkLogUsage,
  restoreLegacyOutcomes,
  searchWorkLogRecords,
  workLogTurnKey,
} from "./src/application/work-log-usage-projection.mjs";

export class WorkLogUsageStore {
  #ledgerFile;
  #databaseFile;
  #database;
  #quarantineFile;
  #defaultProjectRoot;
  #randomUUID;
  #loaded = false;
  #loadedRevision = -1;
  #ledger = normalizedLedger().ledger;
  #recordSnapshot = new Map();
  #tail = Promise.resolve();
  #includeClaudeUsage = true;
  #beforeProjectionWrite;

  constructor({
    ledgerFile,
    databaseFile = path.join(path.dirname(path.resolve(ledgerFile)), "journal.sqlite"),
    journalDatabase = null,
    defaultProjectRoot = "",
    randomUUID = crypto.randomUUID,
    includeClaudeUsage = true,
    beforeProjectionWrite = null,
  } = {}) {
    this.#ledgerFile = path.resolve(ledgerFile);
    this.#databaseFile = path.resolve(databaseFile);
    this.#database = journalDatabase ?? new JournalDatabase(this.#databaseFile);
    this.#quarantineFile = `${this.#ledgerFile}.invalid-records.json`;
    this.#defaultProjectRoot = normalizeProjectRoot(defaultProjectRoot);
    this.#randomUUID = randomUUID;
    this.#includeClaudeUsage = includeClaudeUsage !== false;
    this.#beforeProjectionWrite = typeof beforeProjectionWrite === "function"
      ? beforeProjectionWrite
      : null;
  }

  setIncludeClaudeUsage(value) {
    this.#includeClaudeUsage = value !== false;
  }

  async #load() {
    let imported = null;
    let persisted = null;
    try {
      imported = await this.#database.importLegacyLedger(this.#ledgerFile);
    } catch (error) {
      persisted = await this.#database.loadLedger();
      if (!Object.keys(persisted?.turns ?? {}).length) throw error;
      console.error(
        `Ignored unreadable retired work-log ledger ${this.#ledgerFile}; SQLite already contains the journal records: ${String(error?.message ?? error)}`,
      );
    }
    const revision = await this.#database.currentRevision();
    if (this.#loaded && revision === this.#loadedRevision) return;
    persisted ??= await this.#database.loadLedger();
    const normalized = normalizedLedger(persisted, {
      defaultProjectRoot: this.#defaultProjectRoot,
    });
    this.#ledger = normalized.ledger;
    this.#recordSnapshot = ledgerRecordSnapshot(this.#ledger.turns);
    if (normalized.invalidRecords.length) {
      await mkdir(path.dirname(this.#quarantineFile), { recursive: true });
      await writeTextAtomic(
        this.#quarantineFile,
        `${JSON.stringify({
          detectedAt: new Date().toISOString(),
          source: imported?.imported ? this.#ledgerFile : this.#databaseFile,
          records: normalized.invalidRecords,
        }, null, 2)}\n`,
      );
      console.error(
        `Quarantined ${normalized.invalidRecords.length} invalid work-log ledger record(s) in ${this.#quarantineFile}`,
      );
    }
    this.#loaded = true;
    this.#loadedRevision = revision;
    const migrated = Number(persisted?.version ?? 0) !== this.#ledger.version
      || Object.entries(persisted?.turns ?? {}).some(
        ([key, record]) => (
          String(record?.prompt ?? "").trim() !== String(this.#ledger.turns[key]?.prompt ?? "")
          || normalizeProjectRoot(record?.projectRoot) !== this.#ledger.turns[key]?.projectRoot
          || normalizeEstimatedCredits(
            record?.estimatedCredits
              ?? (Number(persisted?.version ?? 0) < 6
                ? Number(record?.estimatedUnits ?? 0) / 8_000
                : 0),
          ) !== this.#ledger.turns[key]?.estimatedCredits
          || String(record?.estimateKind ?? "").trim()
            !== this.#ledger.turns[key]?.estimateKind
          || String(record?.model ?? "").trim().toLowerCase()
            !== this.#ledger.turns[key]?.model
          || normalizeServiceTier(record?.serviceTier ?? record?.service_tier)
            !== this.#ledger.turns[key]?.serviceTier
        ),
      );
    if (migrated || normalized.invalidRecords.length) {
      await this.#save({ forceCheckpoint: true });
    }
  }

  async #save({ forceCheckpoint = false } = {}) {
    const changes = ledgerRecordChanges(this.#ledger.turns, this.#recordSnapshot);
    if (!forceCheckpoint && !changes.events.length) return;
    if (forceCheckpoint) {
      const result = await this.#database.replaceLedger(this.#ledger);
      this.#loadedRevision = result.revision;
    } else {
      const upserts = changes.events
        .filter((event) => event.op === "upsert")
        .map((event) => event.record);
      const deletions = changes.events
        .filter((event) => event.op === "delete")
        .map((event) => {
          const [provider, threadId, turnId] = String(event.key).split("\0");
          return { provider, threadId, turnId };
        });
      if (upserts.length) {
        const result = await this.#database.upsertRecords(upserts);
        this.#loadedRevision = result.revision;
      }
      if (deletions.length) {
        const result = await this.#database.deleteRecords(deletions);
        this.#loadedRevision = result.revision;
      }
    }
    this.#recordSnapshot = changes.snapshot;
  }

  #enqueueMutation(_workLogFile, operation) {
    const queued = this.#tail.catch(() => {}).then(() => withInterprocessLocks(
      [this.#databaseFile],
      async () => {
        await this.#load();
        return operation();
      },
    ));
    this.#tail = queued;
    return queued;
  }

  #enqueueRead(operation) {
    const queued = this.#tail.catch(() => {}).then(() => withInterprocessLocks(
      [this.#databaseFile],
      async () => {
        // Legacy import and record normalization can write during the first
        // logical read, so readers use the same cross-process lock as writers.
        await this.#load();
        return operation();
      },
    ));
    this.#tail = queued;
    return queued;
  }

  async #projectionSource() {
    const current = await this.#database.payload();
    const rateLimits = String(current?.html ?? "").match(
      /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
    )?.[0] ?? "";
    return `# Глобальный журнал работ\n${rateLimits ? `${rateLimits}\n` : ""}`;
  }

  async #projectDatabase(selectedTurns) {
    const current = await this.#database.payload();
    const source = await this.#projectionSource();
    const updated = this.#projectUsage(source, selectedTurns);
    const version = `sha256:${crypto.createHash("sha256").update(updated, "utf8").digest("hex")}`;
    if (current?.version === version) {
      return { projected: false, reason: "unchanged" };
    }
    await this.#beforeProjectionWrite?.({
      databaseFile: this.#databaseFile,
      current: current?.html ?? "",
      updated,
      attempt: 0,
    });
    const result = await replaceJournalProjectionFromMarkdown(this.#database, updated, { version });
    this.#loadedRevision = result.revision;
    return { projected: true };
  }

  mergeTurnTexts(messages = []) {
    const operation = this.#enqueueMutation(null, async () => {
      let updated = 0;
      for (const message of messages) {
        const text = String(message?.text ?? "").trim();
        const title = String(message?.title ?? "").trim();
        let records = [];
        if (message?.workLogId) {
          try {
            const workLogId = normalizeWorkLogId(message.workLogId);
            records = Object.values(this.#ledger.turns)
              .filter((record) => record.workLogId === workLogId);
          } catch {
            records = [];
          }
        } else if (message?.provider && message?.threadId && message?.turnId) {
          const key = workLogTurnKey(message);
          if (this.#ledger.turns[key]) records = [this.#ledger.turns[key]];
        }
        if (records.length !== 1) continue;
        const record = records[0];
        if (record.body === text && record.title === title) continue;
        if (text) record.body = text;
        if (title) record.title = title;
        updated += 1;
      }
      if (updated) await this.#save();
      return { updated };
    });
    this.#tail = operation;
    return operation;
  }

  getTurn({ provider = "codex", threadId, turnId }) {
    return this.#enqueueRead(async () => {
      const record = this.#ledger.turns[workLogTurnKey({ provider, threadId, turnId })];
      return record ? structuredClone(record) : null;
    });
  }

  searchTurns(query, options = {}) {
    return this.#enqueueRead(async () => {
      return structuredClone(searchWorkLogRecords(this.#ledger.turns, query, options));
    });
  }

  usageHistory(options = {}) {
    return this.#enqueueRead(async () => {
      return structuredClone(buildWorkLogUsageHistory(this.#ledger.turns, {
        includeClaudeUsage: this.#includeClaudeUsage,
        ...options,
      }));
    });
  }

  ledgerSnapshot() {
    return this.#enqueueRead(async () => structuredClone(this.#ledger));
  }

  journalSnapshot() {
    return this.#enqueueRead(async () => structuredClone(await this.#database.snapshot()));
  }

  missingPricingTurns({ provider = "codex" } = {}) {
    return this.#enqueueRead(async () => {
      const normalizedProvider = String(provider ?? "").trim().toLowerCase();
      return Object.values(this.#ledger.turns)
        .filter((record) => (
          record.provider === normalizedProvider
          && (!record.model || !record.pricingMetadataResolved)
        ))
        .map((record) => ({
          provider: record.provider,
          threadId: record.threadId,
          turnId: record.turnId,
          projectRoot: record.projectRoot,
          startedAt: record.startedAt,
        }));
    });
  }

  missingImageGenerationEstimateTurns({ provider = "codex" } = {}) {
    return this.#enqueueRead(async () => {
      const normalizedProvider = String(provider ?? "").trim().toLowerCase();
      return Object.values(this.#ledger.turns)
        .filter((record) => (
          record.provider === normalizedProvider
          && normalizeEstimatedCredits(record.estimatedCredits) === 0
          && looksLikeImageGenerationPrompt(record.prompt)
        ))
        .map((record) => ({
          provider: record.provider,
          threadId: record.threadId,
          turnId: record.turnId,
          projectRoot: record.projectRoot,
          startedAt: record.startedAt,
        }));
    });
  }

  synchronizeUsageEstimatesAndProject({
    items = [],
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
  }) {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      let updated = 0;
      for (const item of items) {
        const provider = String(item?.provider ?? "codex").trim().toLowerCase();
        const threadId = String(item?.threadId ?? "").trim();
        const turnId = String(item?.turnId ?? "").trim();
        const estimatedCredits = normalizeEstimatedCredits(item?.estimatedCredits);
        if (!provider || !threadId || !turnId || !estimatedCredits) continue;
        const record = this.#ledger.turns[workLogTurnKey({ provider, threadId, turnId })];
        if (!record || !sameProjectRoot(record.projectRoot, projectRoot)) continue;
        const estimateKind = String(item?.estimateKind ?? "").trim();
        if (record.estimatedCredits === estimatedCredits && record.estimateKind === estimateKind) continue;
        record.estimatedCredits = estimatedCredits;
        record.estimateKind = estimateKind;
        updated += 1;
      }
      if (!updated) return { updated: 0, projected: false, reason: "unchanged" };
      await this.#save();
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      const projection = await this.#projectDatabase(selectedTurns);
      return { updated, projected: projection.projected };
    });
    this.#tail = operation;
    return operation;
  }

  synchronizePricingMetadataAndProject({
    items = [],
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
  }) {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      let updated = 0;
      for (const item of items) {
        const provider = String(item?.provider ?? "codex").trim().toLowerCase();
        const threadId = String(item?.threadId ?? "").trim();
        const turnId = String(item?.turnId ?? "").trim();
        const model = String(item?.model ?? "").trim().toLowerCase();
        if (!provider || !threadId || !turnId || !model) continue;
        const record = this.#ledger.turns[workLogTurnKey({ provider, threadId, turnId })];
        if (!record || !sameProjectRoot(record.projectRoot, projectRoot)) continue;
        const serviceTier = normalizeServiceTier(item?.serviceTier);
        if (
          record.model === model
          && record.serviceTier === serviceTier
          && record.pricingMetadataResolved
        ) continue;
        record.model = model;
        record.serviceTier = serviceTier;
        record.pricingMetadataResolved = true;
        updated += 1;
      }
      if (!updated) return { updated: 0, projected: false, reason: "unchanged" };
      await this.#save();
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      const projection = await this.#projectDatabase(selectedTurns);
      return { updated, projected: projection.projected };
    });
    this.#tail = operation;
    return operation;
  }

  synchronizeTaskTitlesAndProject({
    titles = [],
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
  }) {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      const byTask = new Map(
        titles
          .map((item) => {
            const provider = String(item?.provider ?? "").trim().toLowerCase();
            const threadId = String(item?.threadId ?? "").trim();
            const taskTitle = String(item?.taskTitle ?? "").replace(/\s+/g, " ").trim();
            return provider && threadId && taskTitle
              ? [`${provider}\0${threadId}`, taskTitle]
              : null;
          })
          .filter(Boolean),
      );
      let updated = 0;
      for (const record of Object.values(this.#ledger.turns)) {
        if (!sameProjectRoot(record.projectRoot, projectRoot)) continue;
        const title = byTask.get(`${record.provider}\0${taskThreadId(record)}`);
        if (!title || record.taskTitle === title) continue;
        record.taskTitle = title;
        updated += 1;
      }
      if (!updated) return { updated: 0, projected: false, reason: "unchanged" };
      await this.#save();
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      const projection = await this.#projectDatabase(selectedTurns);
      return { updated, projected: projection.projected };
    });
    this.#tail = operation;
    return operation;
  }

  #turnsForProjection(projectRoot, projectionProjectRoots) {
    const roots = (
      Array.isArray(projectionProjectRoots) && projectionProjectRoots.length
        ? projectionProjectRoots
        : [projectRoot]
    ).map((root) => normalizeProjectRoot(root));
    if (!roots.some(Boolean)) return { ...this.#ledger.turns };
    return Object.fromEntries(
      Object.entries(this.#ledger.turns).filter(([, record]) => (
        roots.some((root) => sameProjectRoot(record.projectRoot, root))
      )),
    );
  }

  #projectUsage(text, turns) {
    return projectWorkLogUsage(text, turns, {
      includeClaudeUsage: this.#includeClaudeUsage,
    });
  }

  project(workLogFile, {
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
  } = {}) {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      return this.#projectDatabase(selectedTurns);
    });
    this.#tail = operation;
    return operation;
  }

  projectRateLimits(workLogFile, summary, sampledAt = "") {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      const current = await this.#database.payload();
      const updated = projectWorkLogRateLimits(
        String(current?.html ?? "") || "# Глобальный журнал работ\n",
        summary,
        sampledAt,
      );
      if (updated === String(current?.html ?? "")) {
        return { projected: false, reason: "unchanged" };
      }
      const result = await replaceJournalProjectionFromMarkdown(this.#database, updated);
      this.#loadedRevision = result.revision;
      return { projected: true };
    });
    this.#tail = operation;
    return operation;
  }

  recordAndProject({
    provider = "codex",
    threadId,
    turnId,
    projectRoot = this.#defaultProjectRoot,
    workLogId,
    usage,
    usageReported,
    estimatedCredits,
    estimateKind,
    model,
    serviceTier,
    taskThreadId,
    parentThreadId,
    parentTurnId,
    aggregateOnly,
    provisional,
    taskTitle,
    title,
    body,
    prompt,
    changedFiles,
    diff,
    skillsUsed,
    mcpCalls,
    toolMetricsKnown,
    startedAt,
    completedAt,
    status,
    text,
    workLogFile,
    projectionProjectRoots,
  }) {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      const id = normalizeWorkLogId(workLogId);
      const key = workLogTurnKey({ provider, threadId, turnId });
      const existing = this.#ledger.turns[key];
      const reusedId = Object.entries(this.#ledger.turns)
        .find(([existingKey, record]) => existingKey !== key && record.workLogId === id);
      if (existing?.workLogId && existing.workLogId !== id) {
        throw new Error(`Turn ${turnId} is already assigned to another WORK_LOG placeholder`);
      }
      if (reusedId) {
        throw new Error(`WORK_LOG placeholder ${id} is already assigned to another turn`);
      }
      const incoming = incomingLedgerRecord({
        provider,
        threadId,
        turnId,
        projectRoot,
        workLogId: id,
        usage,
        usageReported,
        estimatedCredits,
        estimateKind,
        model,
        serviceTier,
        taskThreadId,
        parentThreadId,
        parentTurnId,
        aggregateOnly,
        provisional,
        taskTitle,
        title,
        body,
        text,
        prompt,
        changedFiles,
        diff,
        skillsUsed,
        mcpCalls,
        toolMetricsKnown,
        startedAt,
        completedAt,
        status,
      });
      this.#ledger.turns[key] = mergeLedgerRecord(existing, incoming);
      await this.#save();
      const recordedUsage = this.#ledger.turns[key].usage;
      try {
        const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
        const projection = await this.#projectDatabase(selectedTurns);
        return {
          recorded: !existing,
          usage: recordedUsage,
          workLogId: id,
          projected: projection.projected,
        };
      } catch (error) {
        return {
          recorded: !existing,
          usage: recordedUsage,
          workLogId: id,
          projected: false,
          projectionError: String(error?.message ?? error),
        };
      }
    });
    this.#tail = operation;
    return operation;
  }

  recordAutomaticAndProject({
    provider = "codex",
    threadId,
    turnId,
    projectRoot = this.#defaultProjectRoot,
    usage,
    usageReported,
    estimatedCredits,
    estimateKind,
    model,
    serviceTier,
    taskThreadId,
    parentThreadId,
    parentTurnId,
    aggregateOnly,
    provisional,
    taskTitle,
    title,
    body,
    prompt,
    changedFiles,
    diff,
    skillsUsed,
    mcpCalls,
    toolMetricsKnown,
    startedAt,
    completedAt,
    status,
    text,
    workLogFile,
    projectionProjectRoots,
  }) {
    return this.#enqueueMutation(workLogFile, async () => {
      const key = workLogTurnKey({ provider, threadId, turnId });
      const existing = this.#ledger.turns[key];
      const incoming = incomingLedgerRecord({
        provider,
        threadId,
        turnId,
        projectRoot,
        usage,
        usageReported,
        estimatedCredits,
        estimateKind,
        model,
        serviceTier,
        taskThreadId,
        parentThreadId,
        parentTurnId,
        aggregateOnly,
        provisional,
        taskTitle,
        title,
        body,
        text,
        prompt,
        changedFiles,
        diff,
        skillsUsed,
        mcpCalls,
        toolMetricsKnown,
        startedAt,
        completedAt,
        status,
      });
      this.#ledger.turns[key] = mergeLedgerRecord(existing, incoming);
      await this.#save();
      try {
        const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
        const projection = await this.#projectDatabase(selectedTurns);
        return {
          recorded: !existing,
          usage: this.#ledger.turns[key].usage,
          workLogId: null,
          target: "thread-day-row",
          projected: projection.projected,
        };
      } catch (error) {
        return {
          recorded: !existing,
          usage: this.#ledger.turns[key].usage,
          workLogId: null,
          target: "thread-day-row",
          projected: false,
          projectionError: String(error?.message ?? error),
        };
      }
    });
  }

  recordAutomaticBatchAndProject({
    records = [],
    projectRoot = this.#defaultProjectRoot,
    workLogFile,
    projectionProjectRoots,
  } = {}) {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      let recorded = 0;
      let updated = 0;
      for (const value of Array.isArray(records) ? records : []) {
        const provider = String(value?.provider ?? "codex").trim().toLowerCase();
        const threadId = String(value?.threadId ?? "").trim();
        const turnId = String(value?.turnId ?? "").trim();
        if (!provider || !threadId || !turnId) continue;
        const key = workLogTurnKey({ provider, threadId, turnId });
        const existing = this.#ledger.turns[key];
        const before = existing ? JSON.stringify(existing) : "";
        const incoming = incomingLedgerRecord({
          ...value,
          provider,
          threadId,
          turnId,
          projectRoot: value.projectRoot ?? projectRoot,
        });
        this.#ledger.turns[key] = mergeLedgerRecord(existing, incoming);
        if (!existing) recorded += 1;
        else if (JSON.stringify(this.#ledger.turns[key]) !== before) updated += 1;
      }
      if (!recorded && !updated) {
        return { recorded: 0, updated: 0, projected: false, reason: "unchanged" };
      }
      await this.#save();
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      const projection = await this.#projectDatabase(selectedTurns);
      return {
        recorded,
        updated,
        projected: projection.projected,
      };
    });
    this.#tail = operation;
    return operation;
  }

  retractProvisionalAndProject({
    provider = "codex",
    threadId,
    turnId,
    projectRoot = this.#defaultProjectRoot,
    workLogFile,
    projectionProjectRoots,
  }) {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      const key = workLogTurnKey({ provider, threadId, turnId });
      const existing = this.#ledger.turns[key];
      if (!existing?.provisional) return { retracted: false, projected: false };
      delete this.#ledger.turns[key];
      await this.#save();
      try {
        const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
        const projection = await this.#projectDatabase(selectedTurns);
        return { retracted: true, projected: projection.projected };
      } catch (error) {
        return {
          retracted: true,
          projected: false,
          projectionError: String(error?.message ?? error),
        };
      }
    });
    this.#tail = operation;
    return operation;
  }

  retireLegacyStorage({
    workLogFile = null,
    backupRoot = path.join(path.dirname(this.#ledgerFile), "migrations"),
    now = new Date(),
  } = {}) {
    const operation = this.#tail.catch(() => {}).then(() => withInterprocessLocks(
      [this.#databaseFile],
      async () => {
        const imported = await this.#database.importLegacyLedger(this.#ledgerFile);
        const verification = await this.#database.verifyLegacyLedger(this.#ledgerFile);
        if (!verification.verified) {
          const error = new Error(
            `Legacy work-log storage does not match SQLite: ${JSON.stringify({
              reason: verification.reason ?? "mismatch",
              invalid: verification.invalid ?? 0,
              missing: verification.missing?.length ?? 0,
              mismatched: verification.mismatched?.length ?? 0,
              extra: verification.extra?.length ?? 0,
            })}`,
          );
          error.code = "WORK_LOG_LEGACY_VERIFICATION_FAILED";
          error.verification = verification;
          throw error;
        }

        const sources = [...new Set([
          this.#ledgerFile,
          `${this.#ledgerFile}.bak`,
          `${this.#ledgerFile}.delta.jsonl`,
          this.#quarantineFile,
          workLogFile ? path.resolve(workLogFile) : null,
        ].filter(Boolean))];
        const existing = [];
        for (const source of sources) {
          try {
            const info = await stat(source);
            if (info.isFile()) existing.push({ source, size: info.size });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }

        const timestamp = now.toISOString().replace(/[:.]/gu, "-");
        const backupDirectory = path.join(path.resolve(backupRoot), `sqlite-cutover-${timestamp}`);
        await mkdir(backupDirectory, { recursive: true });
        const archived = [];
        const usedNames = new Set();
        for (const item of existing) {
          const originalName = path.basename(item.source);
          let backupName = originalName;
          for (let suffix = 2; usedNames.has(backupName); suffix += 1) {
            backupName = `${suffix}-${originalName}`;
          }
          usedNames.add(backupName);
          const backupFile = path.join(backupDirectory, backupName);
          await copyFile(item.source, backupFile);
          archived.push({ ...item, backupFile });
        }
        for (const item of existing) await rm(item.source, { force: true });
        return {
          retired: true,
          imported,
          verification,
          backupDirectory,
          archived,
          removed: existing.map((item) => item.source),
        };
      },
    ));
    this.#tail = operation;
    return operation;
  }

  async close() {
    await this.#tail.catch(() => {});
    this.#database.close();
  }
}
