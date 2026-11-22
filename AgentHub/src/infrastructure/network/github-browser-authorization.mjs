import {
  GITHUB_OAUTH_CALLBACK, GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_LIFETIME_MS, GITHUB_OAUTH_ORIGIN, GITHUB_OAUTH_POLL_MS,
  GITHUB_OAUTH_SCOPES, githubOAuthChallenge, githubOAuthOpaque, githubOAuthRandom, githubOAuthToken, readGitHubOAuthJson,
} from "./github-oauth-protocol.mjs";

export class GitHubBrowserAuthorization {
  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
  }

  async #post(path, values) {
    try {
      const response = await this.fetch(GITHUB_OAUTH_ORIGIN + path, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) throw new Error();
      return await readGitHubOAuthJson(response, 64 * 1024);
    } catch { throw new Error("Не удалось связаться с сервисом входа GitHub. Повтори вход."); }
  }

  async start() {
    const verifier = githubOAuthRandom();
    const challenge = await githubOAuthChallenge(verifier);
    const result = await this.#post("/github/start", { challenge });
    if (!githubOAuthOpaque(result.state)) throw new Error("Сервис вернул неподдерживаемый ответ входа GitHub.");
    const authorization = new URL("https://github.com/login/oauth/authorize");
    authorization.search = new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID, redirect_uri: GITHUB_OAUTH_CALLBACK, scope: GITHUB_OAUTH_SCOPES,
      state: result.state, code_challenge: challenge, code_challenge_method: "S256",
    }).toString();
    const now = this.now();
    return { state: result.state, verifier, authorizationUrl: authorization.href,
      expiresAt: now + GITHUB_OAUTH_LIFETIME_MS, intervalMs: GITHUB_OAUTH_POLL_MS, nextPollAt: now + GITHUB_OAUTH_POLL_MS };
  }

  async poll(flow) {
    if (this.now() >= flow.expiresAt) return { status: "expired", message: "Время входа истекло. Войди через GitHub ещё раз." };
    if (this.now() < flow.nextPollAt) return { status: "pending", waitMs: flow.nextPollAt - this.now() };
    const result = await this.#post("/github/poll", { state: flow.state, verifier: flow.verifier });
    if (result.status === "pending") {
      flow.nextPollAt = this.now() + flow.intervalMs;
      return { status: "pending", waitMs: flow.intervalMs };
    }
    if (result.status === "denied") return { status: "denied", message: "Вход отменён на GitHub." };
    if (result.status === "expired") return { status: "expired", message: "Время входа истекло. Войди через GitHub ещё раз." };
    if (result.status !== "authorized" || !githubOAuthToken(result.token)
        || result.expiresAt !== null && (!Number.isSafeInteger(result.expiresAt) || result.expiresAt <= this.now())) {
      throw new Error("GitHub не подтвердил вход. Повтори вход.");
    }
    return { status: "authorized", token: result.token, expiresAt: result.expiresAt };
  }
}
