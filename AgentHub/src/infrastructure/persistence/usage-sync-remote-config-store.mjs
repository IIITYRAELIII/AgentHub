import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeTextAtomic } from "./state-store.mjs";

function text(value, limit = 1024) {
  return String(value ?? "").trim().slice(0, limit);
}

function positiveInteger(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function normalizeUrl(value) {
  const candidate = text(value);
  if (!candidate) return "";
  const url = new URL(candidate);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Usage sync server URL must use http or https");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

function normalizeState(value = {}, { defaultServerUrl = "" } = {}) {
  if (!value || typeof value !== "object") return {};
  const serverUrl = value.serverUrl ? normalizeUrl(value.serverUrl) : normalizeUrl(defaultServerUrl);
  return {
    version: 3,
    serverUrl,
    deviceId: text(value.deviceId, 80),
    enrolledAt: text(value.enrolledAt, 80),
    lastPushAt: text(value.lastPushAt, 80),
    lastPullAt: text(value.lastPullAt, 80),
    lastUsagePushWatermark: text(value.lastUsagePushWatermark, 80),
    lastUsagePushJournalRevision: positiveInteger(value.lastUsagePushJournalRevision),
    lastUsageHistoryResendVersion: positiveInteger(value.lastUsageHistoryResendVersion),
    lastUsagePullRevision: positiveInteger(value.lastUsagePullRevision),
    lastUsagePullServerGeneration: text(value.lastUsagePullServerGeneration, 120),
    lastUsagePullLocalGeneration: text(value.lastUsagePullLocalGeneration, 120),
    lastUsagePullFactSummary: value.lastUsagePullFactSummary && typeof value.lastUsagePullFactSummary === "object"
      ? structuredClone(value.lastUsagePullFactSummary)
      : null,
    lastUsageAntiEntropyAt: text(value.lastUsageAntiEntropyAt, 80),
    lastResult: value.lastResult && typeof value.lastResult === "object"
      ? structuredClone(value.lastResult)
      : null,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    return {};
  }
}

export class UsageSyncRemoteConfigStore {
  #file;
  #defaultServerUrl;
  #now;
  #state = null;
  #tail = Promise.resolve();

  constructor({ file, defaultServerUrl = "", now = () => new Date() } = {}) {
    if (!file) throw new TypeError("UsageSyncRemoteConfigStore requires a file");
    this.#file = path.resolve(file);
    this.#defaultServerUrl = defaultServerUrl ? normalizeUrl(defaultServerUrl) : "";
    this.#now = now;
  }

  get file() {
    return this.#file;
  }

  #enqueue(operation) {
    const next = this.#tail.catch(() => {}).then(operation);
    this.#tail = next;
    return next;
  }

  async #write(state) {
    await mkdir(path.dirname(this.#file), { recursive: true });
    await writeTextAtomic(this.#file, `${JSON.stringify(state, null, 2)}\n`);
  }

  load() {
    return this.#enqueue(async () => {
      if (this.#state) return structuredClone(this.#state);
      this.#state = normalizeState(await readJson(this.#file), { defaultServerUrl: this.#defaultServerUrl });
      return structuredClone(this.#state);
    });
  }

  rememberEnrollment({ serverUrl, deviceId, result = null } = {}) {
    return this.#enqueue(async () => {
      const current = this.#state ?? normalizeState(await readJson(this.#file), {
        defaultServerUrl: this.#defaultServerUrl,
      });
      const state = normalizeState({
        ...current,
        serverUrl,
        deviceId,
        enrolledAt: this.#now().toISOString(),
        lastResult: result,
      });
      await this.#write(state);
      this.#state = state;
      return structuredClone(state);
    });
  }

  rememberPush(result = {}, {
    usageWatermark = "",
    usageJournalRevision = null,
    usageHistoryResendVersion = null,
  } = {}) {
    return this.#rememberResult("lastPushAt", result, {
      usageWatermark,
      usageJournalRevision,
      usageHistoryResendVersion,
    });
  }

  rememberPull(result = {}, {
    serverRevision = null,
    serverGeneration = "",
    localGeneration = "",
    factSummary = null,
    antiEntropyAt = "",
    replaceCursor = false,
  } = {}) {
    return this.#rememberResult("lastPullAt", result, {
      serverRevision,
      serverGeneration,
      localGeneration,
      factSummary,
      antiEntropyAt,
      replaceCursor,
    });
  }

  #rememberResult(timestampField, result, {
    usageWatermark = "",
    usageJournalRevision = null,
    usageHistoryResendVersion = null,
    serverRevision = null,
    serverGeneration = "",
    localGeneration = "",
    factSummary = null,
    antiEntropyAt = "",
    replaceCursor = false,
  } = {}) {
    return this.#enqueue(async () => {
      const current = this.#state ?? normalizeState(await readJson(this.#file), {
        defaultServerUrl: this.#defaultServerUrl,
      });
      const state = normalizeState({
        ...current,
        [timestampField]: this.#now().toISOString(),
        lastUsagePushWatermark: usageWatermark || current.lastUsagePushWatermark,
        lastUsagePushJournalRevision: usageJournalRevision == null
          ? current.lastUsagePushJournalRevision
          : Math.max(Number(current.lastUsagePushJournalRevision) || 0, positiveInteger(usageJournalRevision)),
        lastUsageHistoryResendVersion: usageHistoryResendVersion == null
          ? current.lastUsageHistoryResendVersion
          : Math.max(Number(current.lastUsageHistoryResendVersion) || 0, positiveInteger(usageHistoryResendVersion)),
        lastUsagePullRevision: serverRevision == null
          ? current.lastUsagePullRevision
          : replaceCursor
            ? positiveInteger(serverRevision)
            : Math.max(Number(current.lastUsagePullRevision) || 0, positiveInteger(serverRevision)),
        lastUsagePullServerGeneration: serverGeneration || current.lastUsagePullServerGeneration,
        lastUsagePullLocalGeneration: localGeneration || current.lastUsagePullLocalGeneration,
        lastUsagePullFactSummary: factSummary && typeof factSummary === "object"
          ? structuredClone(factSummary)
          : current.lastUsagePullFactSummary,
        lastUsageAntiEntropyAt: antiEntropyAt || current.lastUsageAntiEntropyAt,
        lastResult: result,
      });
      await this.#write(state);
      this.#state = state;
      return structuredClone(state);
    });
  }
}
