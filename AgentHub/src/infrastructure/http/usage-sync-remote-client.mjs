function normalizeServerUrl(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate) return "";
  const url = new URL(candidate);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Usage sync server URL must use http or https");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJsonValue(value[key])]),
  );
}

export function canonicalUsageSyncJson(value) {
  return JSON.stringify(sortedJsonValue(value));
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export const DEFAULT_USAGE_SYNC_PUSH_BODY_BYTES = 512 * 1024;

export function usageSyncPushChunks(snapshot, {
  maxBodyBytes = DEFAULT_USAGE_SYNC_PUSH_BODY_BYTES,
} = {}) {
  const limit = Math.max(256, Math.floor(Number(maxBodyBytes) || 0));
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const emptySnapshot = { ...snapshot, events: [] };
  const envelopeBytes = jsonBody(emptySnapshot).byteLength;
  if (envelopeBytes > limit) {
    throw new Error(`Usage sync snapshot envelope exceeds ${limit} bytes`);
  }
  if (!events.length) return [emptySnapshot];

  const chunks = [];
  let chunkEvents = [];
  let chunkBytes = envelopeBytes;
  for (const event of events) {
    const eventBytes = jsonBody(event).byteLength;
    if (envelopeBytes + eventBytes > limit) {
      throw new Error(`Usage sync event exceeds ${limit} bytes`);
    }
    const separatorBytes = chunkEvents.length ? 1 : 0;
    if (chunkBytes + separatorBytes + eventBytes > limit) {
      chunks.push({ ...snapshot, events: chunkEvents });
      chunkEvents = [];
      chunkBytes = envelopeBytes;
    }
    chunkBytes += (chunkEvents.length ? 1 : 0) + eventBytes;
    chunkEvents.push(event);
  }
  if (chunkEvents.length) chunks.push({ ...snapshot, events: chunkEvents });
  return chunks;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { ok: false, error: text };
  }
  if (!response.ok) {
    const error = new Error(String(payload?.error || `HTTP ${response.status}`));
    error.status = response.status;
    throw error;
  }
  return payload ?? {};
}

export class UsageSyncRemoteClient {
  #serverUrl;
  #identityStore;
  #fetch;
  #now;
  #maxPushBodyBytes;

  constructor({
    serverUrl,
    identityStore,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    maxPushBodyBytes = DEFAULT_USAGE_SYNC_PUSH_BODY_BYTES,
  } = {}) {
    this.#serverUrl = normalizeServerUrl(serverUrl);
    if (!this.#serverUrl) throw new TypeError("UsageSyncRemoteClient requires a serverUrl");
    if (!identityStore || typeof identityStore.sign !== "function" || typeof identityStore.toPublic !== "function") {
      throw new TypeError("UsageSyncRemoteClient requires an identityStore");
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("UsageSyncRemoteClient requires fetch");
    }
    this.#identityStore = identityStore;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#maxPushBodyBytes = maxPushBodyBytes;
  }

  get serverUrl() {
    return this.#serverUrl;
  }

  async enroll(code) {
    const identity = this.#identityStore.toPublic();
    const enrollment = {
      code: String(code ?? "").trim(),
      identity,
    };
    if (!enrollment.code) throw new Error("Enrollment code is required");
    const payload = {
      ...enrollment,
      signature: this.#identityStore.sign(canonicalUsageSyncJson(enrollment)),
    };
    const response = await this.#fetch(`${this.#serverUrl}/api/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    return parseJsonResponse(response);
  }

  async createEnrollmentCode({ ttlSeconds = 10_800 } = {}) {
    const body = jsonBody({
      deviceId: this.#identityStore.deviceId,
      requestedAt: this.#now().toISOString(),
      ttlSeconds: Math.max(60, Math.min(86_400, Math.trunc(Number(ttlSeconds) || 10_800))),
    });
    const response = await this.#fetch(`${this.#serverUrl}/api/enrollment-code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-AgentHub-Device-Id": this.#identityStore.deviceId,
        "X-AgentHub-Signature": this.#identityStore.sign(body),
      },
      body,
    });
    return parseJsonResponse(response);
  }

  async push(snapshot) {
    const chunks = usageSyncPushChunks(snapshot, { maxBodyBytes: this.#maxPushBodyBytes });
    let lastResult = null;
    const aggregate = {
      ok: true,
      deviceId: this.#identityStore.deviceId,
      added: 0,
      updated: 0,
      unchanged: 0,
      rejected: 0,
      requests: chunks.length,
    };
    for (const chunk of chunks) {
      const body = jsonBody(chunk);
      const response = await this.#fetch(`${this.#serverUrl}/api/usage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-AgentHub-Device-Id": this.#identityStore.deviceId,
          "X-AgentHub-Signature": this.#identityStore.sign(body),
        },
        body,
      });
      lastResult = await parseJsonResponse(response);
      aggregate.ok = aggregate.ok && lastResult?.ok !== false;
      for (const field of ["added", "updated", "unchanged", "rejected"]) {
        aggregate[field] += Math.max(0, Number(lastResult?.[field]) || 0);
      }
    }
    return chunks.length === 1 ? lastResult : aggregate;
  }

  async pull({ sinceRevision = null } = {}) {
    const body = jsonBody({
      deviceId: this.#identityStore.deviceId,
      requestedAt: this.#now().toISOString(),
      ...(sinceRevision == null
        ? {}
        : { sinceRevision: Math.max(0, Math.trunc(Number(sinceRevision) || 0)) }),
    });
    const endpoint = sinceRevision == null ? "/api/snapshot" : "/api/changes";
    const response = await this.#fetch(`${this.#serverUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-AgentHub-Device-Id": this.#identityStore.deviceId,
        "X-AgentHub-Signature": this.#identityStore.sign(body),
      },
      body,
    });
    try {
      return await parseJsonResponse(response);
    } catch (error) {
      if (endpoint !== "/api/changes" || error.status !== 404) throw error;
    }
    const fallbackBody = jsonBody({
      deviceId: this.#identityStore.deviceId,
      requestedAt: this.#now().toISOString(),
    });
    const fallback = await this.#fetch(`${this.#serverUrl}/api/snapshot`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-AgentHub-Device-Id": this.#identityStore.deviceId,
        "X-AgentHub-Signature": this.#identityStore.sign(fallbackBody),
      },
      body: fallbackBody,
    });
    return parseJsonResponse(fallback);
  }
}

export { normalizeServerUrl };
