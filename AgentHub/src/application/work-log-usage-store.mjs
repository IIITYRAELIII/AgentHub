import crypto from "node:crypto";

import {
  IMAGE_GENERATION_ESTIMATE_CREDITS,
  looksLikeImageGenerationPrompt,
} from "../domain/codex-usage-estimate.mjs";
import { normalizeServiceTier } from "../domain/token-usage.mjs";
import { replaceJournalProjectionFromMarkdown } from "./journal-projection-service.mjs";
import {
  buildWorkLogUsageHistory,
  incomingLedgerRecord,
  mergeLedgerRecord,
  normalizedAccountFields,
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
import { usageSyncSnapshotFromLedger } from "../domain/work-log-usage-sync.mjs";
import { normalizeAuthObservation } from "../domain/usage-facts.mjs";

export function createWorkLogUsageStore({
  repositoryFactory,
  ledgerFile,
  databaseFile,
  journalDatabase = null,
  defaultProjectRoot = "",
  includeClaudeUsage = true,
  resolveAccount = null,
  usageSyncStore = null,
  usageSyncDeviceId = "",
  usageSyncDeviceLabel = "",
  usageSyncRuntimeHomeIds = {},
  usageSyncIdentity = null,
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
    usageSyncStore,
    usageSyncDeviceId,
    usageSyncDeviceLabel,
    usageSyncRuntimeHomeIds,
    usageSyncIdentity,
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
  #usageSyncStore;
  #usageSyncDeviceId;
  #usageSyncDeviceLabel;
  #usageSyncRuntimeHomeIds;
  #usageSyncIdentity;
  #publishedAuthObservationStates = new Map();
  #lastAuthObservationObservedMs = 0;
  #workspaceCatalogStore;
  #beforeProjectionWrite;
  #logger;

  constructor({
    repository,
    defaultProjectRoot = "",
    includeClaudeUsage = true,
    resolveAccount = null,
    usageSyncStore = null,
    usageSyncDeviceId = "",
    usageSyncDeviceLabel = "",
    usageSyncRuntimeHomeIds = {},
    usageSyncIdentity = null,
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
    this.#usageSyncStore = usageSyncStore && typeof usageSyncStore.events === "function"
      ? usageSyncStore
      : null;
    this.#usageSyncDeviceId = String(usageSyncDeviceId ?? "").trim();
    this.#usageSyncDeviceLabel = String(usageSyncDeviceLabel ?? "").trim();
    this.#usageSyncRuntimeHomeIds = Object.fromEntries(
      Object.entries(usageSyncRuntimeHomeIds ?? {})
        .map(([key, value]) => [String(key ?? "").trim().toLowerCase(), String(value ?? "").trim()])
        .filter(([key, value]) => key && value),
    );
    this.#usageSyncIdentity = usageSyncIdentity;
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

  setUsageSyncDeviceLabel(value) {
    this.#usageSyncDeviceLabel = String(value ?? "").trim();
  }

  #save(options) {
    return this.#repository.save(options);
  }

  #saveRecord(key, record) {
    if (typeof this.#repository.saveRecord === "function") {
      return this.#repository.saveRecord(key, record);
    }
    return this.#save();
  }

  #enqueueMutation(_workLogFile, operation) {
    return this.#repository.enqueue(operation);
  }

  #enqueueRead(operation) {
    return this.#repository.enqueue(operation, { retain: false });
  }

  diagnostics() {
    return this.#repository.diagnostics?.() ?? {};
  }

  async #projectionSource() {
    const current = await this.#repository.payload();
    const rateLimits = String(current?.html ?? "").match(
      /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
    )?.[0] ?? "";
    return `# Глобальный журнал работ\n${rateLimits ? `${rateLimits}\n` : ""}`;
  }

  async #projectDatabase(selectedTurns, {
    includeClaudeUsage = this.#includeClaudeUsage,
  } = {}) {
    const current = await this.#repository.payload();
    const source = await this.#projectionSource();
    const accountCatalog = typeof this.#repository.accountCatalog === "function"
      ? await this.#repository.accountCatalog()
      : [];
    const syncedUsageEvents = this.#usageSyncStore
      ? await this.#syncedUsageFacts()
      : [];
    const updated = this.#projectUsage(source, selectedTurns, {
      accountCatalog,
      includeClaudeUsage,
      syncedUsageEvents,
    });
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

  async #projectAccountUsage(projectRoots = []) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.#repository.payload();
      const accountCatalog = typeof this.#repository.accountCatalog === "function"
        ? await this.#repository.accountCatalog()
        : [];
      const projected = typeof this.#usageSyncStore.projectAccountUsage === "function"
        ? await this.#usageSyncStore.projectAccountUsage({
          html: String(current?.html ?? ""),
          projectRoots,
          accountCatalog,
          includeClaudeUsage: this.#includeClaudeUsage,
          localDeviceId: this.#usageSyncDeviceId,
          localDeviceLabel: this.#usageSyncDeviceLabel,
          now: Date.now(),
        })
        : (() => {
          throw new Error("Usage sync projection worker is not configured");
        })();
      if (!projected.projected) return projected;
      await this.#beforeProjectionWrite?.({
        databaseFile: this.#repository.databaseFile,
        current: current?.html ?? "",
        updated: projected.html,
        attempt,
      });
      const written = await this.#repository.replaceIndexProjection(projected.html, {
        expectedRevision: current?.revision,
        version: projected.version,
      });
      if (!written.conflict) {
        return {
          projected: true,
          usageProjectionDurationMs: projected.durationMs,
          usageProjectionEventCount: projected.eventCount,
          workerThreadId: projected.workerThreadId,
        };
      }
    }
    return { projected: false, reason: "stale-journal-revision", projectionDeferred: true };
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
    return this.#repository.enqueue(
      async () => structuredClone(await this.#repository.getRecord({ provider, threadId, turnId })),
      { load: false, pointRead: true },
    );
  }

  threadTurns(identities = [], { limit = 20 } = {}) {
    return this.#repository.enqueue(
      async () => structuredClone(await this.#repository.threadRecords(identities, { limit })),
      { load: false, pointRead: true },
    );
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
      const syncedUsageEvents = this.#usageSyncStore
        ? await this.#syncedUsageFacts()
        : [];
      return structuredClone(buildWorkLogUsageHistory(this.#ledger.turns, {
        includeClaudeUsage: this.#includeClaudeUsage,
        ...options,
        workspaceResolver: this.#workspaceResolver(),
        syncedUsageEvents,
        localDeviceId: this.#usageSyncDeviceId,
        localDeviceLabel: this.#usageSyncDeviceLabel,
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
        const imageGenerationCount = Math.max(
          0,
          Math.floor(Number(item?.imageGenerationCount) || 0),
          estimateKind === "imagegen-default"
            ? Math.round(estimatedCredits / IMAGE_GENERATION_ESTIMATE_CREDITS)
            : 0,
        );
        if (record.estimatedCredits === estimatedCredits
          && record.estimateKind === estimateKind
          && record.imageGenerationCount === imageGenerationCount) continue;
        record.estimatedCredits = estimatedCredits;
        record.estimateKind = estimateKind;
        record.imageGenerationCount = imageGenerationCount;
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

  #projectUsage(text, turns, {
    accountCatalog = [],
    includeClaudeUsage = this.#includeClaudeUsage,
    syncedUsageEvents = [],
  } = {}) {
    return projectWorkLogUsage(text, turns, {
      includeClaudeUsage,
      workspaceResolver: this.#workspaceResolver(),
      accountCatalog,
      syncedUsageEvents,
      localDeviceId: this.#usageSyncDeviceId,
      localDeviceLabel: this.#usageSyncDeviceLabel,
    });
  }

  usageSyncSnapshot({
    deviceId = this.#usageSyncDeviceId,
    deviceLabel = "",
    afterObservedAt = "",
    afterJournalRevision = 0,
  } = {}) {
    if (typeof this.#usageSyncStore?.usageSyncSnapshot !== "function") {
      return this.#enqueueRead(async () => usageSyncSnapshotFromLedger(
        this.#ledger.turns,
        {
          deviceId,
          deviceLabel,
          afterObservedAt,
          defaultRuntimeHomeIds: this.#usageSyncRuntimeHomeIds,
        },
      ));
    }
    return this.#repository.enqueue(
      async () => {
        await this.#publishCurrentAuthObservations();
        return this.#usageSyncStore.usageSyncSnapshot({
          deviceId,
          deviceLabel,
          afterObservedAt,
          afterJournalRevision,
          defaultRuntimeHomeIds: this.#usageSyncRuntimeHomeIds,
        });
      },
      { load: false },
    );
  }

  async #syncedUsageFacts() {
    if (!this.#usageSyncStore) return [];
    if (typeof this.#usageSyncStore.facts === "function") {
      return this.#usageSyncStore.facts();
    }
    return this.#usageSyncStore.events();
  }

  async #currentAuthObservation(provider, observedAt) {
    if (!this.#resolveAccount || !this.#usageSyncDeviceId) return null;
    const normalizedProvider = String(provider ?? "").trim().toLowerCase();
    const runtimeHomeId = String(this.#usageSyncRuntimeHomeIds[normalizedProvider] ?? "").trim();
    const installationInstanceId = String(this.#usageSyncIdentity?.installationInstanceId ?? "").trim();
    if (!normalizedProvider || !runtimeHomeId || !installationInstanceId) return null;
    let resolved = null;
    try {
      resolved = await this.#resolveAccount(normalizedProvider);
    } catch (error) {
      this.#logger?.warn?.(`Cannot identify ${normalizedProvider} account for usage sync auth observation: ${error.message}`);
      return null;
    }
    const account = normalizedAccountFields({ account: resolved });
    if (!account.accountKey) return null;
    let authFingerprint = "";
    try {
      authFingerprint = typeof this.#usageSyncIdentity?.authFingerprint === "function"
        ? this.#usageSyncIdentity.authFingerprint({
          accountKey: account.accountKey,
          accountPlan: account.accountPlan,
        })
        : "";
    } catch (error) {
      this.#logger?.warn?.(`Cannot fingerprint ${normalizedProvider} account for usage sync: ${error.message}`);
    }
    return normalizeAuthObservation({
      schemaVersion: 2,
      type: "auth_observation",
      deviceId: this.#usageSyncDeviceId,
      installationInstanceId,
      provider: normalizedProvider,
      runtimeHomeId,
      accountKey: account.accountKey,
      accountLabel: account.accountLabel,
      accountType: account.accountType,
      accountPlan: account.accountPlan,
      observedAt,
      evidenceSource: "account-read",
      authFingerprint,
    });
  }

  #nextAuthObservationObservedAt() {
    const observedMs = Math.max(Date.now(), this.#lastAuthObservationObservedMs + 1);
    this.#lastAuthObservationObservedMs = observedMs;
    return new Date(observedMs).toISOString();
  }

  async #publishCurrentAuthObservations() {
    if (typeof this.#usageSyncStore?.importSnapshot !== "function") return { added: 0, updated: 0 };
    const observed = (await Promise.all(
      ["codex", "claude"].map((provider) => this.#currentAuthObservation(
        provider,
        this.#nextAuthObservationObservedAt(),
      )),
    )).filter(Boolean);
    const facts = [];
    const pendingStates = [];
    for (const fact of observed) {
      const lineKey = JSON.stringify([
        fact.deviceId,
        fact.provider,
        fact.runtimeHomeId,
      ]);
      const stateKey = JSON.stringify([
        fact.accountKey,
        fact.accountPlan,
        fact.authFingerprint,
      ]);
      if (this.#publishedAuthObservationStates.get(lineKey) === stateKey) continue;
      facts.push(fact);
      pendingStates.push([lineKey, stateKey]);
    }
    if (!facts.length) return { added: 0, updated: 0 };
    const result = await this.#usageSyncStore.importSnapshot({
      version: 1,
      deviceId: this.#usageSyncDeviceId,
      deviceLabel: this.#usageSyncDeviceLabel,
      exportedAt: facts[facts.length - 1]?.observedAt ?? new Date().toISOString(),
      events: facts,
    });
    for (const [lineKey, stateKey] of pendingStates) this.#publishedAuthObservationStates.set(lineKey, stateKey);
    return result;
  }

  importUsageSyncSnapshotAndProject({
    snapshot,
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
  } = {}) {
    if (!this.#usageSyncStore) {
      throw new Error("Usage sync store is not configured");
    }
    const operation = this.#repository.enqueue(async () => {
      const imported = await this.#usageSyncStore.importSnapshot(snapshot);
      if (!imported.added && !imported.updated) {
        return { ...imported, projected: false, reason: "unchanged" };
      }
      const roots = (Array.isArray(projectionProjectRoots) && projectionProjectRoots.length)
        ? projectionProjectRoots
        : [projectRoot];
      const projection = await this.#projectAccountUsage(roots);
      return { ...imported, ...projection };
    }, { load: false });
    return operation;
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
    includeClaudeUsage = this.#includeClaudeUsage,
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
  } = {}) {
    const operation = this.#enqueueMutation(workLogFile, async () => {
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      return this.#projectDatabase(selectedTurns, { includeClaudeUsage });
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
    runId,
    projectRoot = this.#defaultProjectRoot,
    workLogId,
    usage,
    usageReported,
    estimatedCredits,
    estimateKind,
    imageGenerationCount,
    contextProbe,
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
    clientUserMessageId,
    messageOrigin,
    changedFiles,
    diff,
    skillsUsed,
    mcpCalls,
    toolMetricsKnown,
    account,
    accountKey,
    accountAttribution,
    resolveAccount = true,
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
        runId,
        projectRoot,
        workLogId: id,
        usage,
        usageReported,
        estimatedCredits,
        estimateKind,
        imageGenerationCount,
        contextProbe,
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
        clientUserMessageId,
        messageOrigin,
        changedFiles,
        diff,
        skillsUsed,
        mcpCalls,
        toolMetricsKnown,
        ...(resolveAccount === false
          ? { account, accountKey, accountAttribution }
          : await this.#resolvedAccountFields(provider, { account, accountKey, accountAttribution })),
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
    runId,
    projectRoot = this.#defaultProjectRoot,
    usage,
    usageReported,
    estimatedCredits,
    estimateKind,
    imageGenerationCount,
    contextProbe,
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
    clientUserMessageId,
    messageOrigin,
    changedFiles,
    diff,
    skillsUsed,
    mcpCalls,
    toolMetricsKnown,
    account,
    accountKey,
    accountAttribution,
    resolveAccount = true,
    startedAt,
    completedAt,
    status,
    text,
    workLogFile,
    projectionProjectRoots,
    deferProjection = false,
  }) {
    if (deferProjection) {
      return this.#repository.enqueue(async () => {
        const key = workLogTurnKey({ provider, threadId, turnId });
        const existing = await this.#repository.getRecord({ provider, threadId, turnId });
        const incoming = incomingLedgerRecord({
          provider,
          threadId,
          turnId,
          runId,
          projectRoot,
          usage,
          usageReported,
          estimatedCredits,
          estimateKind,
          imageGenerationCount,
          contextProbe,
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
          clientUserMessageId,
          messageOrigin,
          changedFiles,
          diff,
          skillsUsed,
          mcpCalls,
          toolMetricsKnown,
          ...(resolveAccount === false
            ? { account, accountKey, accountAttribution }
            : await this.#resolvedAccountFields(provider, { account, accountKey, accountAttribution })),
          startedAt,
          completedAt,
          status,
        });
        const record = mergeLedgerRecord(existing, incoming);
        await this.#repository.saveRecord(key, record);
        return {
          recorded: !existing,
          usage: record.usage,
          workLogId: null,
          target: "thread-day-row",
          projected: false,
          projectionDeferred: true,
        };
      }, { load: false });
    }
    return this.#enqueueMutation(workLogFile, async () => {
      const key = workLogTurnKey({ provider, threadId, turnId });
      const existing = this.#ledger.turns[key];
      const incoming = incomingLedgerRecord({
        provider,
        threadId,
        turnId,
        runId,
        projectRoot,
        usage,
        usageReported,
        estimatedCredits,
        estimateKind,
        imageGenerationCount,
        contextProbe,
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
        clientUserMessageId,
        messageOrigin,
        changedFiles,
        diff,
        skillsUsed,
        mcpCalls,
        toolMetricsKnown,
        ...(resolveAccount === false
          ? { account, accountKey, accountAttribution }
          : await this.#resolvedAccountFields(provider, { account, accountKey, accountAttribution })),
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
    return Promise.all([
      this.#repository.close(),
      this.#usageSyncStore?.close?.(),
    ]).then(() => undefined);
  }
}
