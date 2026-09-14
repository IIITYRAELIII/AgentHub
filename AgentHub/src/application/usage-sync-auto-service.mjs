import { assertContourExternalEffects } from "../ports/contour-external-effects.mjs";

const TIMER_NAME = "work-log-usage-sync";
const USG001_HISTORY_RESEND_VERSION = 1;
const USAGE_FACT_SCHEMA_VERSION = 2;
const DEFAULT_ANTI_ENTROPY_INTERVAL_MS = 60 * 60_000;

function numberField(value) {
  return Math.max(0, Number(value) || 0);
}

function syncHasChanges({ push = {}, pull = {}, exportedEvents = 0, remoteEvents = 0 } = {}) {
  return Boolean(
    numberField(push.added)
    || numberField(push.updated)
    || numberField(push.rejected)
    || numberField(pull.added)
    || numberField(pull.updated)
    || numberField(pull.pruned)
    || numberField(pull.projected)
    || numberField(exportedEvents)
    || numberField(remoteEvents),
  );
}

function isUsageTurnEvent(event) {
  const type = String(event?.type ?? "").trim();
  const eventId = String(event?.eventId ?? event?.id ?? "").trim();
  return type === "turn" || (!type && !eventId.startsWith("auth:") && !eventId.startsWith("limit:"));
}

function latestTurnObservedAt(events = []) {
  let latest = "";
  let latestMs = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!isUsageTurnEvent(event)) continue;
    const observedAt = String(event?.observedAt ?? "").trim();
    const observedMs = Date.parse(observedAt) || 0;
    if (observedMs > latestMs) {
      latestMs = observedMs;
      latest = observedAt;
    }
  }
  return latest;
}

function usageFactSchemaVersion(value) {
  return Math.max(0, Math.trunc(Number(value?.usageFactSchemaVersion) || 0));
}

function text(value) {
  return String(value ?? "").trim();
}

function digest(value) {
  return text(value?.digest);
}

function sameFactSummary(left, right) {
  return Boolean(
    left
    && right
    && Number(left.count) === Number(right.count)
    && digest(left) !== ""
    && digest(left) === digest(right)
  );
}

function shouldRunAntiEntropy(remoteConfig, now, intervalMs) {
  const last = Date.parse(remoteConfig?.lastUsageAntiEntropyAt) || 0;
  return !last || (now.getTime() - last) >= intervalMs;
}

export class UsageSyncAutoService {
  constructor({
    timers,
    remoteConfigStore,
    identityStore,
    workLogUsageStore,
    clientFactory,
    projectRoot,
    projectionProjectRoots = [],
    workLogFile = null,
    initialDelayMs = 30_000,
    intervalMs = 5 * 60_000,
    antiEntropyIntervalMs = DEFAULT_ANTI_ENTROPY_INTERVAL_MS,
    accountBackfill = null,
    suggestedDeviceLabel = null,
    externalEffects = null,
    isStopping = () => false,
    now = () => new Date(),
    logger = console,
  } = {}) {
    if (!timers || typeof timers.schedule !== "function") {
      throw new TypeError("UsageSyncAutoService requires timers");
    }
    if (!remoteConfigStore || typeof remoteConfigStore.load !== "function") {
      throw new TypeError("UsageSyncAutoService requires a remoteConfigStore");
    }
    if (!identityStore?.deviceId) {
      throw new TypeError("UsageSyncAutoService requires an identityStore");
    }
    if (!workLogUsageStore || typeof workLogUsageStore.usageSyncSnapshot !== "function") {
      throw new TypeError("UsageSyncAutoService requires a workLogUsageStore");
    }
    if (typeof clientFactory !== "function") {
      throw new TypeError("UsageSyncAutoService requires a clientFactory");
    }
    this.timers = timers;
    this.remoteConfigStore = remoteConfigStore;
    this.identityStore = identityStore;
    this.workLogUsageStore = workLogUsageStore;
    this.clientFactory = clientFactory;
    this.projectRoot = projectRoot;
    this.projectionProjectRoots = projectionProjectRoots;
    this.workLogFile = workLogFile;
    this.initialDelayMs = initialDelayMs;
    this.intervalMs = intervalMs;
    this.antiEntropyIntervalMs = antiEntropyIntervalMs;
    this.accountBackfill = typeof accountBackfill === "function" ? accountBackfill : null;
    this.suggestedDeviceLabel = typeof suggestedDeviceLabel === "function" ? suggestedDeviceLabel : null;
    this.isStopping = isStopping;
    this.now = typeof now === "function" ? now : () => new Date();
    this.logger = logger;
    this.syncInFlight = null;
    this.externalEffects = assertContourExternalEffects(externalEffects);
  }

  schedule(delayMs = this.intervalMs) {
    if (this.externalEffects) return this.externalEffects.exclude("usage-sync", "schedule");
    if (this.isStopping()) return;
    this.timers.schedule(TIMER_NAME, () => {
      void this.sync().catch((error) => {
        this.logger.warn?.(`Usage sync failed: ${error.message}`);
      });
    }, Math.max(0, Number(delayMs) || 0), { unref: true });
  }

  scheduleInitial() {
    this.schedule(this.initialDelayMs);
  }

  stop() {
    this.timers.clear?.(TIMER_NAME);
  }

  sync() {
    if (this.externalEffects) return Promise.resolve(this.externalEffects.exclude("usage-sync", "sync"));
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.#syncOnce().finally(() => {
      this.syncInFlight = null;
      this.schedule();
    });
    return this.syncInFlight;
  }

  async createEnrollmentCode({ ttlSeconds = 10_800 } = {}) {
    if (this.externalEffects) return this.externalEffects.exclude("usage-sync", "create-enrollment-code");
    const remoteConfig = await this.remoteConfigStore.load();
    const serverUrl = String(remoteConfig?.serverUrl ?? "").trim();
    if (!serverUrl || !remoteConfig?.enrolledAt) {
      throw new Error("usage-sync is not enrolled");
    }
    const client = this.clientFactory({ serverUrl, identityStore: this.identityStore });
    return client.createEnrollmentCode({ ttlSeconds });
  }

  async enroll({ serverUrl = "", code = "" } = {}) {
    if (this.externalEffects) return this.externalEffects.exclude("usage-sync", "enroll");
    const normalizedServerUrl = String(serverUrl ?? "").trim()
      || String((await this.remoteConfigStore.load())?.serverUrl ?? "").trim();
    if (!normalizedServerUrl) throw new Error("Usage sync server URL is required");
    const client = this.clientFactory({
      serverUrl: normalizedServerUrl,
      identityStore: this.identityStore,
    });
    const result = await client.enroll(code);
    await this.remoteConfigStore.rememberEnrollment({
      serverUrl: normalizedServerUrl,
      deviceId: this.identityStore.deviceId,
      result,
    });
    const sync = await this.sync();
    return { enrolled: true, result, sync };
  }

  async deviceLabelStatus() {
    const label = String(this.identityStore.label ?? "").trim();
    const suggested = String(await this.#suggestDeviceLabel() || label).trim();
    const confirmedAt = String(this.identityStore.labelConfirmedAt ?? "").trim();
    return {
      deviceId: this.identityStore.deviceId,
      deviceLabel: label,
      suggestedDeviceLabel: suggested,
      deviceLabelConfirmed: Boolean(confirmedAt),
      deviceLabelConfirmedAt: confirmedAt,
      deviceLabelPromptRequired: !confirmedAt,
    };
  }

  async setDeviceLabel(value) {
    const label = String(value ?? "").trim();
    if (!label) throw new Error("Никнейм устройства пустой");
    await this.identityStore.setLabel(label, { confirmed: true });
    this.workLogUsageStore.setUsageSyncDeviceLabel?.(this.identityStore.label);
    let sync = { skipped: true, reason: "not-run" };
    try {
      sync = await this.sync();
    } catch (error) {
      sync = { skipped: true, failed: true, reason: error.message };
    }
    return {
      updated: true,
      deviceId: this.identityStore.deviceId,
      deviceLabel: this.identityStore.label,
      deviceLabelConfirmedAt: this.identityStore.labelConfirmedAt,
      sync,
    };
  }

  async #syncOnce() {
    const remoteConfig = await this.remoteConfigStore.load();
    const serverUrl = String(remoteConfig?.serverUrl ?? "").trim();
    if (!serverUrl) return { skipped: true, reason: "not-configured" };
    if (!remoteConfig?.enrolledAt) return { skipped: true, reason: "not-enrolled", serverUrl };
    const client = this.clientFactory({ serverUrl, identityStore: this.identityStore });
    const localStateBefore = typeof this.workLogUsageStore.usageSyncState === "function"
      ? await this.workLogUsageStore.usageSyncState()
      : { localStoreGeneration: "", factSummary: null };
    const cursorServerGeneration = text(remoteConfig.lastUsagePullServerGeneration);
    const cursorLocalGeneration = text(remoteConfig.lastUsagePullLocalGeneration);
    const currentLocalGeneration = text(localStateBefore.localStoreGeneration);
    const cursorLocalGenerationChanged = Boolean(
      cursorLocalGeneration
      && currentLocalGeneration
      && cursorLocalGeneration !== currentLocalGeneration
    );
    const accountBackfill = await this.#backfillAccounts();
    const historyResendDoneVersion = Math.max(
      0,
      Math.trunc(Number(remoteConfig.lastUsageHistoryResendVersion) || 0),
    );
    const forceHistoryResend = historyResendDoneVersion < USG001_HISTORY_RESEND_VERSION;
    const snapshot = await this.workLogUsageStore.usageSyncSnapshot({
      deviceId: this.identityStore.deviceId,
      deviceLabel: this.identityStore.label,
      afterObservedAt: forceHistoryResend ? "" : remoteConfig.lastUsagePushWatermark,
      afterJournalRevision: forceHistoryResend ? 0 : remoteConfig.lastUsagePushJournalRevision,
      ownFactsOnly: true,
    });
    const push = await client.push(snapshot);
    const pushAccepted = push?.ok !== false && !numberField(push.rejected);
    const serverAcceptsUsageFacts = usageFactSchemaVersion(push) >= USAGE_FACT_SCHEMA_VERSION;
    const canAdvanceUsageCursor = pushAccepted && (!forceHistoryResend || serverAcceptsUsageFacts);
    const usageWatermark = canAdvanceUsageCursor ? latestTurnObservedAt(snapshot.events) : "";
    const usageJournalRevision = canAdvanceUsageCursor
      ? Math.max(0, Math.trunc(Number(snapshot.journalRevision) || 0))
      : null;
    const usageHistoryResendVersion = forceHistoryResend && canAdvanceUsageCursor
      ? USG001_HISTORY_RESEND_VERSION
      : null;
    const rememberPushOptions = {
      usageWatermark,
      usageJournalRevision,
    };
    if (usageHistoryResendVersion != null) {
      rememberPushOptions.usageHistoryResendVersion = usageHistoryResendVersion;
    }
    await this.remoteConfigStore.rememberPush(push, rememberPushOptions);
    const serverGenerationAfterPush = text(push.datasetGeneration);
    const serverRevisionAfterPush = Number(push.serverRevision ?? 0) || 0;
    const cursorRevision = Math.max(0, Math.trunc(Number(remoteConfig.lastUsagePullRevision) || 0));
    const cursorInvalidReasons = [];
    if (cursorLocalGenerationChanged && cursorRevision) cursorInvalidReasons.push("cursor-generation-mismatch");
    if (
      cursorRevision
      && serverGenerationAfterPush
      && (!cursorServerGeneration || !cursorLocalGeneration || !currentLocalGeneration)
    ) {
      cursorInvalidReasons.push("cursor-generation-mismatch");
    }
    if (cursorServerGeneration && serverGenerationAfterPush && cursorServerGeneration !== serverGenerationAfterPush) {
      cursorInvalidReasons.push("server-generation-changed");
    }
    if (cursorRevision && serverRevisionAfterPush && serverRevisionAfterPush < cursorRevision) {
      cursorInvalidReasons.push("server-revision-regressed");
    }
    const runAntiEntropy = shouldRunAntiEntropy(remoteConfig, this.#now(), this.antiEntropyIntervalMs);
    let remoteSnapshot = null;
    let remoteEvents = 0;
    let pull = { imported: true, before: null, after: null, added: 0, updated: 0, projected: false };
    let localStateAfterPull = localStateBefore;
    let repair = null;
    let antiEntropyMismatch = false;

    const runFullReconcile = async (reasons) => {
      const fullSnapshot = await client.pull();
      const fullRemoteEvents = Array.isArray(fullSnapshot.events) ? fullSnapshot.events.length : 0;
      const reconcile = await this.workLogUsageStore.importUsageSyncSnapshotAndProject({
        snapshot: fullSnapshot,
        projectRoot: this.projectRoot,
        projectionProjectRoots: this.projectionProjectRoots,
        workLogFile: this.workLogFile,
        reconcile: true,
      });
      localStateAfterPull = typeof this.workLogUsageStore.usageSyncState === "function"
        ? await this.workLogUsageStore.usageSyncState()
        : localStateAfterPull;
      const fullSummary = fullSnapshot.factSummary || null;
      const summaryRequired = Boolean(digest(fullSummary) || text(fullSnapshot.datasetGeneration));
      const converged = summaryRequired
        ? sameFactSummary(localStateAfterPull.factSummary, fullSummary)
        : true;
      repair = {
        attempted: true,
        reasons,
        remoteEvents: fullRemoteEvents,
        pull: reconcile,
        converged,
      };
      if (!converged) {
        repair.failed = true;
        repair.reason = "fact-summary-mismatch-after-reconcile";
      } else {
        repair.projection = await this.#ensureRepairProjection();
      }
      remoteSnapshot = fullSnapshot;
      remoteEvents = fullRemoteEvents;
      pull = reconcile;
    };

    if (cursorInvalidReasons.length) {
      await runFullReconcile([...new Set(cursorInvalidReasons)]);
    } else {
      remoteSnapshot = await client.pull({ sinceRevision: cursorRevision });
      remoteEvents = Array.isArray(remoteSnapshot.events) ? remoteSnapshot.events.length : 0;
      pull = remoteEvents
        ? await this.workLogUsageStore.importUsageSyncSnapshotAndProject({
          snapshot: remoteSnapshot,
          projectRoot: this.projectRoot,
          projectionProjectRoots: this.projectionProjectRoots,
          workLogFile: this.workLogFile,
        })
        : { imported: true, before: null, after: null, added: 0, updated: 0, projected: false };
      localStateAfterPull = typeof this.workLogUsageStore.usageSyncState === "function"
        ? await this.workLogUsageStore.usageSyncState()
        : { localStoreGeneration: "", factSummary: null };
      const antiEntropySnapshot = runAntiEntropy
        ? await this.#usageSummary(client)
        : null;
      const postPullInvalidReasons = [];
      const remoteGeneration = text(
        antiEntropySnapshot?.datasetGeneration || remoteSnapshot.datasetGeneration || serverGenerationAfterPush,
      );
      if (
        cursorRevision
        && remoteGeneration
        && (!cursorServerGeneration || !cursorLocalGeneration || !currentLocalGeneration)
      ) {
        postPullInvalidReasons.push("cursor-generation-mismatch");
      }
      if (cursorServerGeneration && remoteGeneration && cursorServerGeneration !== remoteGeneration) {
        postPullInvalidReasons.push("server-generation-changed");
      }
      if (cursorRevision && Number(remoteSnapshot.serverRevision ?? 0) < cursorRevision) {
        postPullInvalidReasons.push("server-revision-regressed");
      }
      const remoteSummary = antiEntropySnapshot?.factSummary || null;
      const summaryMismatch = Boolean(remoteSummary && !sameFactSummary(localStateAfterPull.factSummary, remoteSummary));
      antiEntropyMismatch = runAntiEntropy && summaryMismatch;
      if (postPullInvalidReasons.length || antiEntropyMismatch) {
        cursorInvalidReasons.push(...postPullInvalidReasons);
        await runFullReconcile(postPullInvalidReasons.length
          ? [...new Set(postPullInvalidReasons)]
          : ["fact-summary-mismatch"]);
      }
    }
    const serverRevision = Number(remoteSnapshot.serverRevision ?? push.serverRevision ?? 0) || null;
    const serverGeneration = text(remoteSnapshot.datasetGeneration || push.datasetGeneration);
    const canAdvancePullCursor = !repair?.attempted || repair.converged === true;
    const antiEntropyAt = runAntiEntropy && canAdvancePullCursor ? this.#now().toISOString() : "";
    const rememberPullOptions = { serverRevision: canAdvancePullCursor ? serverRevision : null };
    if (canAdvancePullCursor && serverGeneration) rememberPullOptions.serverGeneration = serverGeneration;
    if (canAdvancePullCursor && text(localStateAfterPull.localStoreGeneration)) {
      rememberPullOptions.localGeneration = text(localStateAfterPull.localStoreGeneration);
    }
    if (canAdvancePullCursor && localStateAfterPull.factSummary) {
      rememberPullOptions.factSummary = localStateAfterPull.factSummary;
    }
    if (antiEntropyAt) rememberPullOptions.antiEntropyAt = antiEntropyAt;
    if (repair?.converged) rememberPullOptions.replaceCursor = true;
    await this.remoteConfigStore.rememberPull(pull, rememberPullOptions);
    const result = {
      synced: true,
      exportedEvents: Array.isArray(snapshot.events) ? snapshot.events.length : 0,
      remoteEvents,
      serverRevision,
      serverGeneration,
      factSummary: localStateAfterPull.factSummary,
      antiEntropy: { checked: runAntiEntropy, mismatch: antiEntropyMismatch },
      repair,
      usageWatermark,
      usageJournalRevision,
      usageHistoryResendVersion,
      usageHistoryResendPending: forceHistoryResend && !usageHistoryResendVersion,
      accountBackfill,
      push,
      pull,
      serverUrl,
    };
    if (syncHasChanges(result)) {
      this.logger.info?.(
        `Usage sync completed: pushed +${numberField(push.added)}/${numberField(push.updated)}, `
        + `pulled +${numberField(pull.added)}/${numberField(pull.updated)}, `
        + `remote events ${result.remoteEvents}`,
      );
    }
    return result;
  }

  async #backfillAccounts() {
    if (!this.accountBackfill) return { applied: false, reason: "not-configured" };
    try {
      const result = await this.accountBackfill();
      if (result?.applied) {
        this.logger.info?.(
          `Usage sync account backfill updated ${numberField(result.updated)} local journal record(s).`,
        );
      }
      return result ?? { applied: false, reason: "empty-result" };
    } catch (error) {
      this.logger.warn?.(`Usage sync account backfill failed: ${error.message}`);
      return { applied: false, failed: true, reason: error.message };
    }
  }

  async #suggestDeviceLabel() {
    if (this.externalEffects) {
      this.externalEffects.exclude("usage-sync", "account-label-suggestion");
      return "";
    }
    if (!this.suggestedDeviceLabel) return "";
    try {
      return String(await this.suggestedDeviceLabel() ?? "").trim();
    } catch (error) {
      this.logger.warn?.(`Usage sync device label suggestion failed: ${error.message}`);
      return "";
    }
  }

  #now() {
    return this.now();
  }

  async #usageSummary(client) {
    if (typeof client.summary === "function") return client.summary();
    return client.pull({ summaryOnly: true });
  }

  async #ensureRepairProjection() {
    if (typeof this.workLogUsageStore.ensureAccountUsageProjectionCurrent !== "function") {
      return {
        projected: false,
        projectionRequired: true,
        failed: true,
        reason: "projection-hook-unavailable",
      };
    }
    try {
      return await this.workLogUsageStore.ensureAccountUsageProjectionCurrent({
        required: true,
        reason: "sync-repair",
        projectRoot: this.projectRoot,
        projectionProjectRoots: this.projectionProjectRoots,
      });
    } catch (error) {
      return {
        projected: false,
        projectionRequired: true,
        failed: true,
        reason: String(error?.message ?? error),
      };
    }
  }
}

export { TIMER_NAME as USAGE_SYNC_AUTO_TIMER_NAME };
