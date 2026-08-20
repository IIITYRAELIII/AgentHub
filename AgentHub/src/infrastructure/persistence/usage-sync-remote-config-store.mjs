import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeTextAtomic } from "./state-store.mjs";

function text(value, limit = 1024) {
  return String(value ?? "").trim().slice(0, limit);
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

function normalizeState(value = {}) {
  if (!value || typeof value !== "object") return {};
  return {
    version: 1,
    serverUrl: value.serverUrl ? normalizeUrl(value.serverUrl) : "",
    deviceId: text(value.deviceId, 80),
    enrolledAt: text(value.enrolledAt, 80),
    lastPushAt: text(value.lastPushAt, 80),
    lastPullAt: text(value.lastPullAt, 80),
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
  #now;
  #state = null;
  #tail = Promise.resolve();

  constructor({ file, now = () => new Date() } = {}) {
    if (!file) throw new TypeError("UsageSyncRemoteConfigStore requires a file");
    this.#file = path.resolve(file);
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
      this.#state = normalizeState(await readJson(this.#file));
      return structuredClone(this.#state);
    });
  }

  rememberEnrollment({ serverUrl, deviceId, result = null } = {}) {
    return this.#enqueue(async () => {
      const current = this.#state ?? normalizeState(await readJson(this.#file));
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

  rememberPush(result = {}) {
    return this.#rememberResult("lastPushAt", result);
  }

  rememberPull(result = {}) {
    return this.#rememberResult("lastPullAt", result);
  }

  #rememberResult(timestampField, result) {
    return this.#enqueue(async () => {
      const current = this.#state ?? normalizeState(await readJson(this.#file));
      const state = normalizeState({
        ...current,
        [timestampField]: this.#now().toISOString(),
        lastResult: result,
      });
      await this.#write(state);
      this.#state = state;
      return structuredClone(state);
    });
  }
}
