const TIMER_NAME = "work-log-usage-sync";

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
    || numberField(pull.projected)
    || numberField(exportedEvents)
    || numberField(remoteEvents),
  );
}

function latestObservedAt(events = []) {
  let latest = "";
  let latestMs = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const observedAt = String(event?.observedAt ?? "").trim();
    const observedMs = Date.parse(observedAt) || 0;
    if (observedMs > latestMs) {
      latestMs = observedMs;
      latest = observedAt;
    }
  }
  return latest;
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
    accountBackfill = null,
    suggestedDeviceLabel = null,
    isStopping = () => false,
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
    this.accountBackfill = typeof accountBackfill === "function" ? accountBackfill : null;
    this.suggestedDeviceLabel = typeof suggestedDeviceLabel === "function" ? suggestedDeviceLabel : null;
    this.isStopping = isStopping;
    this.logger = logger;
    this.syncInFlight = null;
  }

  schedule(delayMs = this.intervalMs) {
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
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.#syncOnce().finally(() => {
      this.syncInFlight = null;
      this.schedule();
    });
    return this.syncInFlight;
  }

  async createEnrollmentCode({ ttlSeconds = 10_800 } = {}) {
    const remoteConfig = await this.remoteConfigStore.load();
    const serverUrl = String(remoteConfig?.serverUrl ?? "").trim();
    if (!serverUrl || !remoteConfig?.enrolledAt) {
      throw new Error("usage-sync is not enrolled");
    }
    const client = this.clientFactory({ serverUrl, identityStore: this.identityStore });
    return client.createEnrollmentCode({ ttlSeconds });
  }

  async enroll({ serverUrl = "", code = "" } = {}) {
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
    const accountBackfill = await this.#backfillAccounts();
    const snapshot = await this.workLogUsageStore.usageSyncSnapshot({
      deviceId: this.identityStore.deviceId,
      deviceLabel: this.identityStore.label,
      afterObservedAt: remoteConfig.lastUsagePushWatermark,
      afterJournalRevision: remoteConfig.lastUsagePushJournalRevision,
    });
    const push = await client.push(snapshot);
    const usageWatermark = numberField(push.rejected) ? "" : latestObservedAt(snapshot.events);
    const usageJournalRevision = numberField(push.rejected)
      ? null
      : Math.max(0, Math.trunc(Number(snapshot.journalRevision) || 0));
    await this.remoteConfigStore.rememberPush(push, { usageWatermark, usageJournalRevision });
    const remoteSnapshot = await client.pull({
      sinceRevision: Math.max(0, Math.trunc(Number(remoteConfig.lastUsagePullRevision) || 0)),
    });
    const remoteEvents = Array.isArray(remoteSnapshot.events) ? remoteSnapshot.events.length : 0;
    const pull = remoteEvents
      ? await this.workLogUsageStore.importUsageSyncSnapshotAndProject({
        snapshot: remoteSnapshot,
        projectRoot: this.projectRoot,
        projectionProjectRoots: this.projectionProjectRoots,
        workLogFile: this.workLogFile,
      })
      : { imported: true, before: null, after: null, added: 0, updated: 0, projected: false };
    const serverRevision = Number(remoteSnapshot.serverRevision ?? push.serverRevision ?? 0) || null;
    await this.remoteConfigStore.rememberPull(pull, { serverRevision });
    const result = {
      synced: true,
      exportedEvents: Array.isArray(snapshot.events) ? snapshot.events.length : 0,
      remoteEvents,
      serverRevision,
      usageWatermark,
      usageJournalRevision,
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
    if (!this.suggestedDeviceLabel) return "";
    try {
      return String(await this.suggestedDeviceLabel() ?? "").trim();
    } catch (error) {
      this.logger.warn?.(`Usage sync device label suggestion failed: ${error.message}`);
      return "";
    }
  }
}

export { TIMER_NAME as USAGE_SYNC_AUTO_TIMER_NAME };
