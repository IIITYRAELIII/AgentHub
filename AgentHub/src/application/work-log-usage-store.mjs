import crypto from "node:crypto";

import {
  IMAGE_GENERATION_ESTIMATE_CREDITS,
  looksLikeImageGenerationPrompt,
} from "../domain/codex-usage-estimate.mjs";
import { normalizeServiceTier } from "../domain/token-usage.mjs";
import { journalProjectionVersion, replaceJournalProjectionFromMarkdown } from "./journal-projection-service.mjs";
import { buildLazyJournalPayload } from "./journal-projection-data.mjs";
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
  WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
  workLogTurnKey,
} from "./work-log-usage-projection.mjs";
import { usageSyncSnapshotFromLedger } from "../domain/work-log-usage-sync.mjs";
import { normalizeAuthObservation } from "../domain/usage-facts.mjs";
import { ledgerRecordFingerprint } from "../domain/ledger-record-fingerprint.mjs";

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
  #authPublicationTail = Promise.resolve();
  #lastAuthObservationObservedMs = 0;
  #workspaceCatalogStore;
  #workspaceAssignments = new Map();
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
    await replaceJournalProjectionFromMarkdown(this.#repository, updated, {
      version,
      accountUsageProjectionVersion: WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
    });
    return { projected: true };
  }

  async #projectAccountUsage(projectRoots = [], {
    force = false,
    strict = false,
  } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { current, accountCatalog } = await this.#repository.enqueue(async () => ({
        current: await this.#repository.payload(),
        accountCatalog: typeof this.#repository.accountCatalog === "function"
          ? await this.#repository.accountCatalog() : [],
      }), { load: false });
      const projected = typeof this.#usageSyncStore.projectAccountUsage === "function"
        ? await this.#usageSyncStore.projectAccountUsage({
          html: String(current?.html ?? ""),
          projectRoots,
          accountCatalog,
          localDeviceId: this.#usageSyncDeviceId,
          localDeviceLabel: this.#usageSyncDeviceLabel,
          now: Date.now(),
          force,
        })
        : (() => {
          throw new Error("Usage sync projection worker is not configured");
        })();
      if (!projected.projected) {
        if (!force) return projected;
        throw new Error("Usage sync projection worker skipped a required projection");
      }
      await this.#beforeProjectionWrite?.({
        databaseFile: this.#repository.databaseFile,
        current: current?.html ?? "",
        updated: projected.html,
        attempt,
      });
      const written = await this.#repository.enqueue(() => this.#repository.replaceIndexProjection(projected.html, {
        expectedRevision: current?.revision,
        version: projected.version,
        accountUsageProjectionVersion: WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
      }), { load: false });
      if (!written.conflict) {
        return {
          projected: true,
          version: written.version ?? projected.version,
          usageProjectionDurationMs: projected.durationMs,
          usageProjectionEventCount: projected.eventCount,
          workerThreadId: projected.workerThreadId,
        };
      }
    }
    const deferred = { projected: false, reason: "stale-journal-revision", projectionDeferred: true };
    if (!strict) return deferred;
    const error = new Error("Required account usage projection could not commit after a journal revision conflict");
    error.code = "JOURNAL_ACCOUNT_USAGE_PROJECTION_CONFLICT";
    error.projection = deferred;
    throw error;
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

  async ensureTurnUsageFact(identity) {
    if (!this.#usageSyncStore?.importSnapshot) return { supported: false, added: 0, updated: 0 };
    const record = await this.getTurn(identity);
    if (!record) return { supported: true, missing: true, added: 0, updated: 0 };
    const snapshot = usageSyncSnapshotFromLedger({ [workLogTurnKey(record)]: record }, {
      deviceId: this.#usageSyncDeviceId,
      deviceLabel: this.#usageSyncDeviceLabel,
      defaultRuntimeHomeIds: this.#usageSyncRuntimeHomeIds,
    });
    const result = await this.#usageSyncStore.importSnapshot(snapshot);
    return { supported: true, missing: false, ...result };
  }

  async turnProjectionStatus(identity) {
    if (typeof this.#repository.turnProjectionStatus !== "function") return null;
    const status = await this.#repository.turnProjectionStatus(identity);
    const sourceRevision = Number(status?.projectionSource?.revision);
    const recordRevision = Number(status?.recordRevision);
    const roots = Array.isArray(status?.projectionSource?.projectRoots)
      ? status.projectionSource.projectRoots : [];
    const covered = status?.record && (
      !roots.some(Boolean)
      || roots.some((root) => sameProjectRoot(root, status.record.projectRoot))
    );
    return {
      ...status,
      current: Boolean(
        status?.record
        && status.indexed
        && status.usageFact
        && covered
        && Number.isFinite(sourceRevision)
        && Number.isFinite(recordRevision)
        && sourceRevision + 1 >= recordRevision
      ),
    };
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
    if (typeof this.#usageSyncStore?.usageHistory === "function") {
      return this.#repository.prepareIndependentRead().then(() => (
        this.#usageSyncStore.usageHistory({
          includeClaudeUsage: this.#includeClaudeUsage, ...options,
          defaultProjectRoot: this.#defaultProjectRoot,
          localDeviceId: this.#usageSyncDeviceId, localDeviceLabel: this.#usageSyncDeviceLabel,
        }, { workspaceResolver: this.#workspaceResolver() })
      ));
    }
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
    if (typeof this.#usageSyncStore?.readTurnMetadataCandidates === "function") {
      return this.#readTurnMetadataCandidates({ provider, kind: "pricing" });
    }
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
    if (typeof this.#usageSyncStore?.readTurnMetadataCandidates === "function") {
      return this.#readTurnMetadataCandidates({ provider, kind: "image-estimate" });
    }
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
    if (this.#supportsWorkerMetadata()) return this.#synchronizeTurnMetadataAndProject({
      kind: "image-estimate", items, projectRoot, projectionProjectRoots, workLogFile,
    });
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
      return { updated };
    });
    return operation.then(async (result) => {
      if (!result.updated) return result;
      const projection = await this.project(workLogFile, { projectRoot, projectionProjectRoots });
      return { ...result, projected: projection.projected };
    });
  }

  synchronizePricingMetadataAndProject({
    items = [],
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
  }) {
    if (this.#supportsWorkerMetadata()) return this.#synchronizeTurnMetadataAndProject({
      kind: "pricing", items, projectRoot, projectionProjectRoots, workLogFile,
    });
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
      return { updated };
    });
    return operation.then(async (result) => {
      if (!result.updated) return result;
      const projection = await this.project(workLogFile, { projectRoot, projectionProjectRoots });
      return { ...result, projected: projection.projected };
    });
  }

  async #readTurnMetadataCandidates(payload) {
    await this.#repository.enqueue(() => {}, { load: false, pointRead: true });
    return this.#usageSyncStore.readTurnMetadataCandidates({
      ...payload, defaultProjectRoot: this.#defaultProjectRoot,
    });
  }

  #supportsWorkerMetadata() {
    return typeof this.#usageSyncStore?.synchronizeTurnMetadata === "function"
      && typeof this.#usageSyncStore?.projectJournal === "function" && !this.#beforeProjectionWrite;
  }

  async #synchronizeTurnMetadataAndProject({
    kind, items, projectRoot, projectionProjectRoots, workLogFile,
  }) {
    const result = await this.#usageSyncStore.synchronizeTurnMetadata({
      kind, items, projectRoot, defaultProjectRoot: this.#defaultProjectRoot,
    }, {
      mutationLock: (mutate) => this.#repository.enqueue(
        () => this.#repository.applyExternalMutation(mutate), { load: false, pointRead: true },
      ),
    });
    if (!result.projectionRequired) return { updated: 0, projected: false, reason: "unchanged" };
    const projection = await this.project(workLogFile, { projectRoot, projectionProjectRoots });
    return { updated: result.updated, projected: projection.projected };
  }

  synchronizeTaskTitlesAndProject({
    titles = [],
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
  }) {
    if (typeof this.#usageSyncStore?.synchronizeTaskTitles === "function"
      && typeof this.#usageSyncStore?.projectJournal === "function" && !this.#beforeProjectionWrite) {
      return this.#usageSyncStore.synchronizeTaskTitles({
        titles, projectRoot, defaultProjectRoot: this.#defaultProjectRoot,
      }, {
        mutationLock: (mutate) => this.#repository.enqueue(
          () => this.#repository.applyExternalMutation(mutate), { load: false, pointRead: true },
        ),
      }).then(async (result) => {
        if (!result.projectionRequired) return { updated: 0, projected: false, reason: "unchanged" };
        const projection = await this.project(workLogFile, { projectRoot, projectionProjectRoots });
        return { updated: result.updated, projected: projection.projected };
      });
    }
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

  async usageSyncSnapshot({
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
    await this.#publishCurrentAuthObservations();
    return this.#usageSyncStore.usageSyncSnapshot({
      deviceId,
      deviceLabel,
      afterObservedAt,
      afterJournalRevision,
      defaultRuntimeHomeIds: this.#usageSyncRuntimeHomeIds,
    });
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

  #publishCurrentAuthObservations() {
    const operation = this.#authPublicationTail.catch(() => {}).then(() => this.#publishAuthObservationBatch());
    this.#authPublicationTail = operation;
    return operation;
  }

  async #publishAuthObservationBatch() {
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

  async importUsageSyncSnapshotAndProject({
    snapshot,
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
    reconcile = false,
  } = {}) {
    if (!this.#usageSyncStore) {
      throw new Error("Usage sync store is not configured");
    }
    const imported = reconcile && typeof this.#usageSyncStore.reconcileSnapshot === "function"
      ? await this.#usageSyncStore.reconcileSnapshot(snapshot)
      : await this.#usageSyncStore.importSnapshot(snapshot);
    if (!imported.added && !imported.updated && !imported.pruned) {
      return { ...imported, projected: false, reason: "unchanged" };
    }
    const roots = (Array.isArray(projectionProjectRoots) && projectionProjectRoots.length)
      ? projectionProjectRoots
      : [projectRoot];
    const projection = await this.#projectAccountUsage(roots);
    return { ...imported, ...projection };
  }

  usageSyncState() {
    if (!this.#usageSyncStore || typeof this.#usageSyncStore.usageSyncState !== "function") {
      return Promise.resolve({
        localStoreGeneration: "",
        factSummary: { version: 1, count: 0, byType: {}, digest: "" },
      });
    }
    return this.#usageSyncStore.usageSyncState();
  }

  async ensureAccountUsageProjectionCurrent({
    required = false,
    reason = "shipped-version-check",
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
  } = {}) {
    if (!this.#usageSyncStore) {
      throw new Error("Usage sync store is not configured");
    }
    if (typeof this.#repository.accountUsageProjectionVersion !== "function") {
      throw new Error("Journal projection version metadata is not configured");
    }
    const persistedVersion = await this.#repository.enqueue(
      () => this.#repository.accountUsageProjectionVersion(), { load: false },
    );
    if (!required && persistedVersion === WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION) {
      return {
        projected: false,
        projectionRequired: false,
        projectionVersion: WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
        reason: "current",
      };
    }
    const roots = (Array.isArray(projectionProjectRoots) && projectionProjectRoots.length)
      ? projectionProjectRoots
      : [projectRoot];
    const projection = await this.#projectAccountUsage(roots, {
      force: true,
      strict: true,
    });
    return {
      ...projection,
      projectionRequired: true,
      projectionVersion: WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
      triggerReason: String(reason ?? "shipped-version-check"),
    };
  }

  #workspaceResolver() {
    return this.#workspaceCatalogStore
      ? (reference) => {
        const resolved = this.#workspaceCatalogStore.resolveThread(reference);
        if (resolved) return resolved;
        const key = `${String(reference?.provider ?? "").toLowerCase()}\0${String(reference?.threadId ?? "")}`;
        if (!this.#workspaceAssignments.has(key)) {
          const pending = this.#workspaceCatalogStore.assignUnknownThread(
            reference,
            { source: "discovered" },
          );
          if (!pending || typeof pending.then !== "function") return pending ?? null;
          const assignment = Promise.resolve(pending).catch((error) => {
            this.#logger?.warn?.(`Cannot assign journal Thread to Workspace: ${error.message}`);
          }).finally(() => this.#workspaceAssignments.delete(key));
          this.#workspaceAssignments.set(key, assignment);
        }
        return null;
      }
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
    if (typeof this.#usageSyncStore?.projectJournal === "function" && !this.#beforeProjectionWrite) {
      return this.#repository.enqueue(() => undefined, { load: false, pointRead: true }).then(async () => {
        let projection;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          projection = await this.#usageSyncStore.projectJournal({
            defaultProjectRoot: this.#defaultProjectRoot,
            projectRoots: Array.isArray(projectionProjectRoots) && projectionProjectRoots.length
              ? projectionProjectRoots : [projectRoot],
            includeClaudeUsage,
            localDeviceId: this.#usageSyncDeviceId,
            localDeviceLabel: this.#usageSyncDeviceLabel,
          }, { workspaceResolver: this.#workspaceResolver() });
          if (!projection.conflict && !projection.projectionDeferred) return projection;
        }
        const error = new Error("Journal projection could not commit after a journal revision conflict");
        error.code = "JOURNAL_PROJECTION_CONFLICT";
        error.projection = projection;
        throw error;
      });
    }
    const operation = this.#enqueueMutation(workLogFile, async () => {
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      return this.#projectDatabase(selectedTurns, { includeClaudeUsage });
    });
    return operation;
  }

  projectRateLimits(workLogFile, summary, sampledAt = "") {
    const operation = this.#repository.enqueue(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const expectedRevision = await this.#repository.currentRevision();
        const current = await this.#repository.payload();
        const updated = projectWorkLogRateLimits(
          String(current?.html ?? "") || "# Глобальный журнал работ\n",
          summary,
          sampledAt,
        );
        const html = buildLazyJournalPayload(updated).html;
        if (html === String(current?.html ?? "")) {
          return { projected: false, reason: "unchanged" };
        }
        const projection = await this.#repository.replaceIndexProjection(html, {
          expectedRevision, version: journalProjectionVersion(updated),
        });
        if (!projection.conflict) return { projected: true };
      }
      const error = new Error("Rate-limit projection could not commit after a journal revision conflict");
      error.code = "JOURNAL_PROJECTION_CONFLICT";
      throw error;
    }, { load: false });
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
    deferProjection = false,
  }) {
    const workerProjection = typeof this.#usageSyncStore?.projectJournal === "function"
      && !this.#beforeProjectionWrite;
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
      if (deferProjection || workerProjection) return {
        recorded: !existing,
        usage: recordedUsage,
        workLogId: id,
        projected: false,
        projectionDeferred: true,
      };
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
    if (deferProjection || !workerProjection) return operation;
    return operation.then(async (recorded) => {
      try {
        const projection = await this.project(workLogFile, { projectRoot, projectionProjectRoots });
        return { ...recorded, ...projection, projectionDeferred: projection.projectionDeferred === true };
      } catch (error) {
        return { ...recorded, projectionError: String(error?.message ?? error) };
      }
    });
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
    if (deferProjection || (typeof this.#usageSyncStore?.projectJournal === "function"
      && !this.#beforeProjectionWrite)) {
      const operation = this.#repository.enqueue(async () => {
        const key = workLogTurnKey({ provider, threadId, turnId });
        const existing = await this.#repository.getRecord({ provider, threadId, turnId });
        const previousFingerprint = existing ? ledgerRecordFingerprint(existing) : null;
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
        const changed = !existing || ledgerRecordFingerprint(record) !== previousFingerprint;
        if (changed) await this.#repository.saveRecord(key, record);
        return {
          recorded: !existing,
          usage: record.usage,
          workLogId: null,
          target: "thread-day-row",
          projected: false,
          projectionDeferred: changed,
        };
      }, { load: false, pointRead: true });
      if (deferProjection) return operation;
      return operation.then(async (recorded) => {
        try {
          const projection = await this.project(workLogFile, { projectRoot, projectionProjectRoots });
          return { ...recorded, ...projection, projectionDeferred: projection.projectionDeferred === true };
        } catch (error) {
          return { ...recorded, projectionError: String(error?.message ?? error) };
        }
      });
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
    const operation = this.#repository.enqueue(async () => {
      let recorded = 0;
      let updated = 0;
      const changes = new Map();
      for (const value of Array.isArray(records) ? records : []) {
        const provider = String(value?.provider ?? "codex").trim().toLowerCase();
        const threadId = String(value?.threadId ?? "").trim();
        const turnId = String(value?.turnId ?? "").trim();
        if (!provider || !threadId || !turnId) continue;
        const key = workLogTurnKey({ provider, threadId, turnId });
        const existing = changes.get(key) ?? await this.#repository.getRecord({ provider, threadId, turnId });
        const before = existing ? JSON.stringify(existing) : "";
        const incoming = incomingLedgerRecord({
          ...value,
          provider,
          threadId,
          turnId,
          projectRoot: value.projectRoot ?? projectRoot,
        });
        const merged = mergeLedgerRecord(existing, incoming);
        const changed = !existing || JSON.stringify(merged) !== before;
        if (!existing) recorded += 1;
        else if (changed) updated += 1;
        if (changed) changes.set(key, merged);
      }
      if (!recorded && !updated) {
        return { recorded: 0, updated: 0, projected: false, reason: "unchanged" };
      }
      await this.#repository.upsertRecords([...changes.values()]);
      return { recorded, updated };
    }, { load: false, pointRead: true });
    return operation.then(async (result) => {
      if (!result.recorded && !result.updated) return result;
      const projection = await this.project(workLogFile, { projectRoot, projectionProjectRoots });
      return { ...result, projected: projection.projected };
    });
  }

  retractProvisionalAndProject({
    provider = "codex",
    threadId,
    turnId,
    projectRoot = this.#defaultProjectRoot,
    workLogFile,
    projectionProjectRoots,
  }) {
    const operation = this.#repository.enqueue(async () => {
      const identity = { provider, threadId, turnId };
      const existing = await this.#repository.getRecord(identity);
      if (!existing?.provisional) return false;
      const result = await this.#repository.deleteRecord(identity);
      return result.deleted > 0;
    }, { load: false, pointRead: true });
    return operation.then(async (retracted) => {
      if (!retracted) return { retracted: false, projected: false };
      try {
        const projection = await this.project(workLogFile, { projectRoot, projectionProjectRoots });
        return { retracted: true, projected: projection.projected };
      } catch (error) {
        return {
          retracted: true,
          projected: false,
          projectionError: String(error?.message ?? error),
        };
      }
    });
  }

  retireLegacyStorage(options = {}) {
    return this.#repository.retireLegacyStorage(options);
  }

  async close() {
    await this.#authPublicationTail.catch(() => {});
    return Promise.all([
      ...this.#workspaceAssignments.values(),
      this.#repository.close(),
      this.#usageSyncStore?.close?.(),
    ]).then(() => undefined);
  }
}
