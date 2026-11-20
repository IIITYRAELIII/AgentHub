import {
  GITHUB_OAUTH_CALLBACK, GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_LIFETIME_MS, GITHUB_OAUTH_ORIGIN,
  githubOAuthChallenge, githubOAuthOpaque, githubOAuthRandom, githubOAuthToken, readGitHubOAuthJson,
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
        return await attempt(env, body.state, "poll", { verifier: body.verifier });
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
    if (action === "/poll") return this.#poll(body.verifier);
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

  async #poll(verifier) {
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
    const token = await this.#exchange(current.code, verifier);
    // The token stays in memory for this response only. The attempt retains
    // its terminal outcome so even concurrent polls can't redeem it twice.
    if (Date.now() >= current.deadline) return status("expired");
    this.storage.kv.put("attempt", { challenge, deadline: current.deadline, status: token ? "consumed" : "failed" });
    return token ? json({ status: "authorized", ...token }) : status("failed");
  }

  async #exchange(code, verifier) {
    try {
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, client_secret: this.env.GITHUB_OAUTH_CLIENT_SECRET,
          code, code_verifier: verifier, redirect_uri: GITHUB_OAUTH_CALLBACK }).toString(),
      });
      if (!response.ok) return null;
      const value = await readGitHubOAuthJson(response, 64 * 1024);
      const expiresAt = value.expires_in == null ? null : Date.now() + value.expires_in * 1000;
      if (value.error || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"
          || !githubOAuthToken(value.access_token) || value.expires_in != null && (!Number.isSafeInteger(value.expires_in)
            || value.expires_in <= 0 || !Number.isSafeInteger(expiresAt))) return null;
      return { token: value.access_token, expiresAt };
    } catch { return null; }
  }

  async alarm() { await this.storage.deleteAll(); }
}
