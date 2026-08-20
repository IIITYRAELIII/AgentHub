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

async function parseJsonResponse(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { ok: false, error: text };
  }
  if (!response.ok) {
    throw new Error(String(payload?.error || `HTTP ${response.status}`));
  }
  return payload ?? {};
}

export class UsageSyncRemoteClient {
  #serverUrl;
  #identityStore;
  #fetch;
  #now;

  constructor({
    serverUrl,
    identityStore,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
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

  async createEnrollmentCode({ ttlSeconds = 900 } = {}) {
    const body = jsonBody({
      deviceId: this.#identityStore.deviceId,
      requestedAt: this.#now().toISOString(),
      ttlSeconds: Math.max(60, Math.min(86_400, Math.trunc(Number(ttlSeconds) || 900))),
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
    const body = jsonBody(snapshot);
    const response = await this.#fetch(`${this.#serverUrl}/api/usage`, {
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

  async pull() {
    const body = jsonBody({
      deviceId: this.#identityStore.deviceId,
      requestedAt: this.#now().toISOString(),
    });
    const response = await this.#fetch(`${this.#serverUrl}/api/snapshot`, {
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
}

export { normalizeServerUrl };
