import {
  GITHUB_OAUTH_CALLBACK, GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_LIFETIME_MS, GITHUB_OAUTH_ORIGIN,
  GITHUB_OAUTH_REFRESH_MAX_MS,
  githubOAuthChallenge, githubOAuthExpiry, githubOAuthOpaque, githubOAuthRandom, githubOAuthRefreshPair,
  githubOAuthToken, readGitHubOAuthJson, sealGitHubRefreshResult,
} from "../src/infrastructure/network/github-oauth-protocol.mjs";

const responseHeaders = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
};
const json = (data, status = 200) => Response.json(data, { status, headers: responseHeaders });
const status = value => json({ status: value });
const invalid = () => json({ status: "invalid" }, 400);
const missing = () => json({ status: "not_found" }, 404);
const secretConfigured = env => typeof env.GITHUB_OAUTH_CLIENT_SECRET === "string" && env.GITHUB_OAUTH_CLIENT_SECRET.length > 0;
const codePattern = /^[A-Za-z0-9_-]{8,255}$/u;

function githubPair(value, now) {
  const expiry = seconds => {
    const at = now + seconds * 1000;
    return Number.isSafeInteger(seconds) && seconds > 0 && githubOAuthExpiry(at) ? at : undefined;
  };
  const expiresAt = value.expires_in == null ? null : expiry(value.expires_in);
  if (value.error || value.token_type?.toLowerCase?.() !== "bearer"
      || !githubOAuthToken(value.access_token) || expiresAt === undefined) return null;
  const pair = { token: value.access_token, expiresAt };
  if (value.refresh_token != null) {
    const refresh = { refreshToken: value.refresh_token, refreshExpiresAt: expiry(value.refresh_token_expires_in) };
    if (githubOAuthRefreshPair({ ...pair, ...refresh })) Object.assign(pair, refresh);
  }
  return pair;
}

async function exchange(env, parameters) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      ...parameters }).toString(),
  });
  if (response.status !== 200 && response.status !== 400 && response.status !== 401) return null;
  const value = await readGitHubOAuthJson(response, 64 * 1024);
  return value.error === "bad_refresh_token" ? "reconnect" : response.ok ? githubPair(value, Date.now()) : null;
}

function page(message, statusCode = 200) {
  return new Response("<!doctype html><html lang=ru><meta charset=utf-8><title>Agent Hub</title><main><h1>Agent Hub</h1><p>"
    + message + "</p></main></html>", {
    status: statusCode,
    headers: { ...responseHeaders, "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

async function input(request) {
  try { return await readGitHubOAuthJson(request, 2048); } catch { return null; }
}

function attempt(env, state, action, body) {
  return env.ATTEMPTS.getByName(state).fetch("https://attempt.internal/" + action, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== GITHUB_OAUTH_ORIGIN) return missing();
    try {
      if (request.method === "GET" && url.pathname === "/github/health") {
        return json({ ready: secretConfigured(env) }, secretConfigured(env) ? 200 : 503);
      }
      if (request.method === "GET" && url.pathname === "/github/complete") {
        return page("Вернись в Agent Hub. Результат входа появится там.");
      }
      if (!secretConfigured(env)) return json({ status: "unavailable" }, 503);
      if (request.method === "POST" && url.pathname === "/github/start") {
        const body = await input(request);
        if (!githubOAuthOpaque(body?.challenge)) return invalid();
        const state = githubOAuthRandom();
        const created = await attempt(env, state, "start", { challenge: body.challenge });
        return created.ok ? json({ state }) : json({ status: "unavailable" }, 503);
      }
      if (request.method === "POST" && url.pathname === "/github/poll") {
        const body = await input(request);
        if (!githubOAuthOpaque(body?.state) || !githubOAuthOpaque(body?.verifier)) return invalid();
        return await attempt(env, body.state, "poll", { verifier: body.verifier, refresh: body.refresh === true });
      }
      if (request.method === "POST" && url.pathname === "/github/refresh") {
        const body = await input(request);
        if (!githubOAuthToken(body?.refreshToken) || !githubOAuthOpaque(body.verifier)
            || !githubOAuthExpiry(body.deadline)
            || body.deadline > Date.now() + GITHUB_OAUTH_REFRESH_MAX_MS + GITHUB_OAUTH_LIFETIME_MS) return invalid();
        if (body.deadline <= Date.now()) return status("unknown");
        const key = await githubOAuthChallenge("refresh:" + body.refreshToken);
        return await attempt(env, key, "refresh", body);
      }
      if (request.method === "GET" && url.pathname === "/github/callback") {
        const states = url.searchParams.getAll("state");
        const codes = url.searchParams.getAll("code");
        const errors = url.searchParams.getAll("error");
        const validResult = errors.length === 0 && codes.length === 1 && codePattern.test(codes[0])
          || codes.length === 0 && errors.length === 1 && errors[0] === "access_denied";
        if (states.length !== 1 || !githubOAuthOpaque(states[0]) || !validResult) {
          return page("Вход недействителен. Начни вход снова в Agent Hub.", 400);
        }
        const received = await attempt(env, states[0], "receive", { code: codes[0] ?? null });
        if (!received.ok) return page("Вход уже завершён или истёк. Проверь статус в Agent Hub.", 409);
        return new Response(null, { status: 303, headers: { ...responseHeaders, Location: "/github/complete" } });
      }
      return missing();
    } catch { return json({ status: "unavailable" }, 503); }
  },
};

export class GitHubOAuthAttempt {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.env = env;
  }

  async fetch(request) {
    const action = new URL(request.url).pathname;
    const body = await input(request);
    if (!body) return invalid();
    if (action === "/start") return this.#start(body.challenge);
    if (action === "/receive") return this.#receive(body.code);
    if (action === "/poll") return this.#poll(body.verifier, body.refresh);
    if (action === "/refresh") return this.#refresh(body);
    return missing();
  }

  async #start(challenge) {
    const deadline = Date.now() + GITHUB_OAUTH_LIFETIME_MS;
    if (this.storage.kv.get("attempt")) return json({ status: "duplicate" }, 409);
    const alarm = this.storage.setAlarm(deadline);
    this.storage.kv.put("attempt", { challenge, deadline, status: "pending" });
    await alarm;
    return status("pending");
  }

  #receive(code) {
    const current = this.storage.kv.get("attempt");
    if (!current || Date.now() >= current.deadline || current.status !== "pending") {
      return json({ status: "closed" }, 409);
    }
    this.storage.kv.put("attempt", { ...current, status: code ? "ready" : "denied", ...(code && { code }) });
    return status("received");
  }

  async #poll(verifier, includeRefresh) {
    const challenge = await githubOAuthChallenge(verifier);
    const current = this.storage.kv.get("attempt");
    const now = Date.now();
    if (!current || now >= current.deadline) return status("expired");
    if (current.challenge !== challenge) return json({ status: "invalid" }, 403);
    if (current.status === "exchanging") return status(now - current.startedAt < 20_000 ? "pending" : "failed");
    if (current.status !== "ready") return status(current.status);
    // Remove the code and durably record admission before the external exchange.
    // No storage or network await splits the read and the selection of its owner.
    this.storage.kv.put("attempt", { challenge, deadline: current.deadline, status: "exchanging", startedAt: now });
    await this.storage.sync();
    const token = await exchange(this.env, { code: current.code, code_verifier: verifier, redirect_uri: GITHUB_OAUTH_CALLBACK })
      .catch(() => null);
    // The token stays in memory for this response only. The attempt retains
    // its terminal outcome so even concurrent polls can't redeem it twice.
    if (Date.now() >= current.deadline) return status("expired");
    const authorized = token && token !== "reconnect";
    this.storage.kv.put("attempt", { challenge, deadline: current.deadline, status: authorized ? "consumed" : "failed" });
    if (!authorized) return status("failed");
    return json({ status: "authorized", ...(includeRefresh ? token : { token: token.token, expiresAt: token.expiresAt }) });
  }

  async #refresh({ refreshToken, verifier, deadline }) {
    const challenge = await githubOAuthChallenge(verifier);
    const current = this.storage.kv.get("refresh");
    const now = Date.now();
    if (deadline <= now) return status("unknown");
    if (current) {
      if (current.challenge !== challenge || current.deadline !== deadline) return status("unknown");
      if (current.status === "refreshed") {
        return now < current.resultUntil ? json({ status: current.status, result: current.result }) : status("unknown");
      }
      if (current.status === "exchanging") return status(now - current.startedAt < 20_000 ? "pending" : "unknown");
      return status(current.status);
    }
    const admitted = { challenge, deadline, status: "exchanging", startedAt: now };
    this.storage.kv.put("refresh", admitted);
    await this.storage.setAlarm(deadline);
    await this.storage.sync();
    if (Date.now() >= deadline) return status("unknown");
    let completed = { challenge, deadline, status: "unknown" };
    try {
      const pair = await exchange(this.env, { grant_type: "refresh_token", refresh_token: refreshToken });
      if (pair === "reconnect") completed.status = "reconnect";
      else if (githubOAuthRefreshPair(pair) && pair.refreshToken !== refreshToken) {
        completed = { ...completed, status: "refreshed", result: await sealGitHubRefreshResult(pair, verifier),
          resultUntil: Math.min(deadline, Date.now() + GITHUB_OAUTH_LIFETIME_MS) };
      }
    } catch { /* An indeterminate provider exchange cannot be replayed. */ }
    if (Date.now() >= deadline) return status("unknown");
    this.storage.kv.put("refresh", completed);
    if (completed.resultUntil < deadline) await this.storage.setAlarm(completed.resultUntil);
    await this.storage.sync();
    return completed.status === "refreshed" ? json({ status: completed.status, result: completed.result }) : status(completed.status);
  }

  async alarm() {
    const current = this.storage.kv.get("refresh");
    const now = Date.now();
    if (!current || now >= current.deadline) return this.storage.deleteAll();
    if (current.status === "refreshed") {
      if (now < current.resultUntil) return this.storage.setAlarm(current.resultUntil);
      this.storage.kv.put("refresh", { challenge: current.challenge, deadline: current.deadline, status: "unknown" });
    }
    await this.storage.setAlarm(current.deadline);
  }
}
