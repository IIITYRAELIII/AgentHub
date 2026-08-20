import crypto from "node:crypto";

import { looksLikeImageGenerationPrompt } from "../domain/codex-usage-estimate.mjs";
import { normalizeServiceTier } from "../domain/token-usage.mjs";
import { replaceJournalProjectionFromMarkdown } from "./journal-projection-service.mjs";
import {
  buildWorkLogUsageHistory,
  incomingLedgerRecord,
  mergeLedgerRecord,
  normalizeEstimatedCredits,
  normalizePersistedWorkLog,
  normalizeWorkLogId,
  normalizeProjectRoot,
  projectWorkLogRateLimits,
  projectWorkLogUsage,
  sameProjectRoot,
  searchWorkLogRecords,
  taskThreadId,
  workLogTurnKey,
} from "./work-log-usage-projection.mjs";

export function createWorkLogUsageStore({
  repositoryFactory,
  ledgerFile,
  databaseFile,
  journalDatabase = null,
  defaultProjectRoot = "",
  includeClaudeUsage = true,
  resolveAccount = null,
  workspaceCatalogStore = null,
  beforeProjectionWrite = null,
  logger = console,
} = {}) {
  if (typeof repositoryFactory !== "function") {
    throw new TypeError("createWorkLogUsageStore requires repositoryFactory");
  }
  const normalizedProjectRoot = normalizeProjectRoot(defaultProjectRoot);
  const repository = repositoryFactory({
    ledgerFile,
    ...(databaseFile ? { databaseFile } : {}),
    journalDatabase,
    normalizePersisted: (persisted) => normalizePersistedWorkLog(persisted, {
      defaultProjectRoot: normalizedProjectRoot,
    }),
  });
  return new WorkLogUsageStore({
    repository,
    defaultProjectRoot: normalizedProjectRoot,
    includeClaudeUsage,
    resolveAccount,
    workspaceCatalogStore,
    beforeProjectionWrite,
    logger,
  });
}

export class WorkLogUsageStore {
  #repository;
  #defaultProjectRoot;
  #includeClaudeUsage = true;
  #resolveAccount;
  #workspaceCatalogStore;
  #beforeProjectionWrite;
  #logger;

  constructor({
    repository,
    defaultProjectRoot = "",
    includeClaudeUsage = true,
    resolveAccount = null,
    workspaceCatalogStore = null,
    beforeProjectionWrite = null,
    logger = console,
  } = {}) {
    if (
      !repository
      || typeof repository.enqueue !== "function"
      || typeof repository.save !== "function"
      || typeof repository.payload !== "function"
      || typeof repository.replaceProjection !== "function"
    ) {
      throw new TypeError("WorkLogUsageStore requires a persistence repository");
    }
    this.#defaultProjectRoot = normalizeProjectRoot(defaultProjectRoot);
    this.#repository = repository;
    this.#includeClaudeUsage = includeClaudeUsage !== false;
    this.#resolveAccount = typeof resolveAccount === "function" ? resolveAccount : null;
    if (workspaceCatalogStore && (
      typeof workspaceCatalogStore.resolveThread !== "function"
      || typeof workspaceCatalogStore.assignUnknownThread !== "function"
    )) {
      throw new TypeError("workspaceCatalogStore must resolve and assign provider threads");
    }
    this.#workspaceCatalogStore = workspaceCatalogStore;
    this.#beforeProjectionWrite = typeof beforeProjectionWrite === "function"
      ? beforeProjectionWrite
      : null;
    this.#logger = logger;
  }

  get #ledger() {
    return this.#repository.ledger;
  }

  setIncludeClaudeUsage(value) {
    this.#includeClaudeUsage = value !== false;
  }

  setResolveAccount(resolveAccount) {
    this.#resolveAccount = typeof resolveAccount === "function" ? resolveAccount : null;
  }

  #save(options) {
    return this.#repository.save(options);
  }

  #enqueueMutation(_workLogFile, operation) {
    return this.#repository.enqueue(operation);
  }

  #enqueueRead(operation) {
    return this.#repository.enqueue(operation);
  }

  async #projectionSource() {
    const current = await this.#repository.payload();
    const rateLimits = String(current?.html ?? "").match(
      /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
    )?.[0] ?? "";
    return `# Глобальный журнал работ\n${rateLimits ? `${rateLimits}\n` : ""}`;
  }

  async #projectDatabase(selectedTurns) {
    const current = await this.#repository.payload();
    const source = await this.#projectionSource();
    const accountCatalog = typeof this.#repository.accountCatalog === "function"
      ? await this.#repository.accountCatalog()
      : [];
    const updated = this.#projectUsage(source, selectedTurns, { accountCatalog });
    const version = `sha256:${crypto.createHash("sha256").update(updated, "utf8").digest("hex")}`;
    if (current?.version === version) {
      return { projected: false, reason: "unchanged" };
    }
    await this.#beforeProjectionWrite?.({
      databaseFile: this.#repository.databaseFile,
      current: current?.html ?? "",
      updated,
      attempt: 0,
    });
    await replaceJournalProjectionFromMarkdown(this.#repository, updated, { version });
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
    return operation;
  }

  getTurn({ provider = "codex", threadId, turnId }) {
    return this.#enqueueRead(async () => {
      const record = this.#ledger.turns[workLogTurnKey({ provider, threadId, turnId })];
      return record ? structuredClone(record) : null;
    });
  }

  threadTurns(identities = [], { limit = 20 } = {}) {
    return this.#enqueueRead(async () => {
      const keys = new Set((Array.isArray(identities) ? identities : []).map((identity) => (
        `${String(identity?.provider ?? "").trim().toLowerCase()}\0${String(identity?.threadId ?? "").trim()}`
      )));
      const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
      const timestamp = (record) => Date.parse(record.completedAt || record.startedAt || "") || 0;
      return structuredClone(Object.values(this.#ledger.turns)
        .filter((record) => keys.has(`${record.provider}\0${record.threadId}`))
        .sort((left, right) => timestamp(right) - timestamp(left))
        .slice(0, boundedLimit));
    });
  }

  searchTurns(query, options = {}) {
    return this.#enqueueRead(async () => {
      return structuredClone(searchWorkLogRecords(this.#ledger.turns, query, {
        ...options,
        workspaceResolver: this.#workspaceResolver(),
      }));
    });
  }

  usageHistory(options = {}) {
    return this.#enqueueRead(async () => {
      return structuredClone(buildWorkLogUsageHistory(this.#ledger.turns, {
        includeClaudeUsage: this.#includeClaudeUsage,
        ...options,
        workspaceResolver: this.#workspaceResolver(),
      }));
    });
  }

  ledgerSnapshot() {
    return this.#enqueueRead(async () => structuredClone(this.#ledger));
  }

  journalSnapshot() {
    return this.#enqueueRead(async () => structuredClone(await this.#repository.snapshot()));
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

  #projectUsage(text, turns, { accountCatalog = [] } = {}) {
    return projectWorkLogUsage(text, turns, {
      includeClaudeUsage: this.#includeClaudeUsage,
      workspaceResolver: this.#workspaceResolver(),
      accountCatalog,
    });
  }

  #workspaceResolver() {
    return this.#workspaceCatalogStore
      ? (reference) => this.#workspaceCatalogStore.resolveThread(reference)
        ?? this.#workspaceCatalogStore.assignUnknownThread(reference, { source: "discovered" })
      : null;
  }

  async #resolvedAccountFields(provider, supplied = {}) {
    if (supplied?.accountKey || supplied?.account) return supplied;
    if (!this.#resolveAccount) return supplied;
    const normalizedProvider = String(provider ?? "").trim().toLowerCase();
    if (!normalizedProvider) return supplied;
    try {
      const account = await this.#resolveAccount(normalizedProvider);
      return account ? { ...supplied, account } : supplied;
    } catch (error) {
      this.#logger?.warn?.(`Cannot identify ${normalizedProvider} account for journal record: ${error.message}`);
      return supplied;
    }
  }

  project(workLogFile, {
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
  } = {}) {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      return this.#projectDatabase(selectedTurns);
    });
    return operation;
  }

  projectRateLimits(workLogFile, summary, sampledAt = "") {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      const current = await this.#repository.payload();
      const updated = projectWorkLogRateLimits(
        String(current?.html ?? "") || "# Глобальный журнал работ\n",
        summary,
        sampledAt,
      );
      if (updated === String(current?.html ?? "")) {
        return { projected: false, reason: "unchanged" };
      }
      await replaceJournalProjectionFromMarkdown(this.#repository, updated);
      return { projected: true };
    });
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
    account,
    accountKey,
    accountAttribution,
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
        ...await this.#resolvedAccountFields(provider, { account, accountKey, accountAttribution }),
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
    account,
    accountKey,
    accountAttribution,
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
        ...await this.#resolvedAccountFields(provider, { account, accountKey, accountAttribution }),
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
    return operation;
  }

  retireLegacyStorage(options = {}) {
    return this.#repository.retireLegacyStorage(options);
  }

  close() {
    return this.#repository.close();
  }
}
