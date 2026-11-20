// GitHub's public device client: no client secret, loopback listener or browser
// credential relay. The device code and token never leave the local owner.
export const GITHUB_OAUTH_SCOPES = "gist read:org repo workflow";

async function responseJson(response) {
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) { await reader.cancel(); throw new Error(); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

export class GitHubDeviceAuthorization {
  constructor({ clientId = "", fetchImpl = fetch, now = Date.now } = {}) {
    this.clientId = String(clientId).trim();
    this.fetch = fetchImpl;
    this.now = now;
  }
  get configured() { return /^[A-Za-z0-9._-]{1,128}$/u.test(this.clientId); }
  async #post(path, values) {
    try {
      const response = await this.fetch(`https://github.com${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "AgentHub" },
        body: new URLSearchParams({ client_id: this.clientId, ...values }).toString(),
      });
      if (!response.ok) throw new Error();
      const result = await responseJson(response);
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
      return result;
    } catch { throw new Error("Не удалось выполнить вход через GitHub. Повтори вход."); }
  }
  async start() {
    if (!this.configured) throw new Error("Вход через GitHub ещё не настроен: владельцу Hub нужен Client ID OAuth-приложения с включённым Device Flow.");
    const result = await this.#post("/login/device/code", { scope: GITHUB_OAUTH_SCOPES });
    if (result.error === "device_flow_disabled" || result.error === "incorrect_client_credentials") {
      throw new Error("Проверь Client ID и включи Device Flow в настройках OAuth-приложения GitHub.");
    }
    if (typeof result.device_code !== "string" || !/^[A-Za-z0-9_-]{20,200}$/u.test(result.device_code)
        || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(result.user_code ?? "")
        || result.verification_uri !== "https://github.com/login/device"
        || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0
        || !Number.isSafeInteger(this.now() + result.expires_in * 1000)
        || !Number.isSafeInteger(result.interval) || result.interval <= 0 || !Number.isSafeInteger(result.interval * 1000)) {
      throw new Error("GitHub вернул неподдерживаемый ответ входа.");
    }
    return { deviceCode: result.device_code, userCode: result.user_code,
      verificationUri: result.verification_uri, expiresAt: this.now() + result.expires_in * 1000,
      intervalMs: result.interval * 1000, nextPollAt: this.now() + result.interval * 1000 };
  }
  async poll(flow) {
    if (this.now() >= flow.expiresAt) return { status: "expired", message: "Код входа истёк. Войди через GitHub ещё раз." };
    if (this.now() < flow.nextPollAt) return { status: "pending", waitMs: flow.nextPollAt - this.now() };
    const result = await this.#post("/login/oauth/access_token", {
      device_code: flow.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (result.error === "authorization_pending" || result.error === "slow_down") {
      if (result.interval != null && (!Number.isSafeInteger(result.interval) || result.interval <= 0
          || !Number.isSafeInteger(result.interval * 1000))) throw new Error("GitHub вернул неподдерживаемый интервал входа.");
      if (result.error === "slow_down") flow.intervalMs = Math.max(flow.intervalMs + 5000,
        Number.isSafeInteger(result.interval) ? result.interval * 1000 : 0);
      flow.nextPollAt = this.now() + flow.intervalMs;
      return { status: "pending", waitMs: flow.intervalMs };
    }
    if (result.error === "access_denied") return { status: "denied", message: "Вход отменён на GitHub." };
    if (["expired_token", "token_expired"].includes(result.error)) return { status: "expired", message: "Код входа истёк. Войди через GitHub ещё раз." };
    if (result.error || result.token_type?.toLowerCase() !== "bearer"
        || !/^[A-Za-z0-9_]{20,255}$/u.test(result.access_token ?? "")
        || result.expires_in != null && (!Number.isSafeInteger(result.expires_in) || result.expires_in <= 0
          || !Number.isSafeInteger(this.now() + result.expires_in * 1000))) {
      throw new Error("GitHub не подтвердил вход. Повтори вход.");
    }
    // Expiry is enforced by the shared credential owner for Git, gh and API.
    // Reconnect uses the same device flow. No plaintext refresh-token store.
    return { status: "authorized", token: result.access_token,
      expiresAt: result.expires_in == null ? null : this.now() + result.expires_in * 1000 };
  }
}
