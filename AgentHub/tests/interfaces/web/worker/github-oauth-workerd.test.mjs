import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import worker, { GitHubOAuthAttempt } from "../../../../cloudflare-github-oauth/worker.mjs";
import { GitHubBrowserAuthorization } from "../../../../src/infrastructure/network/github-browser-authorization.mjs";
import { GITHUB_OAUTH_ORIGIN } from "../../../../src/infrastructure/network/github-oauth-protocol.mjs";

test("native Worker joins GitHub callback to its exact local Hub and exchanges the code once", { timeout: 30_000 }, async t => {
  const secret = "synthetic-client-secret";
  const token = "gho_SYNTHETIC_WORKER_TOKEN_123456789";
  const exchanges = [];
  const runtime = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../../../../cloudflare-github-oauth/worker.mjs", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../../../..", import.meta.url)),
    compatibilityDate: "2026-07-28",
    durableObjects: { ATTEMPTS: { className: "GitHubOAuthAttempt", useSQLite: true } },
    bindings: { GITHUB_OAUTH_CLIENT_SECRET: secret },
    outboundService: async request => {
      exchanges.push({ url: request.url, method: request.method, body: await request.text() });
      if (new URLSearchParams(exchanges.at(-1).body).get("code") === "synthetic_redirect") {
        return Response.redirect("https://foreign.example/token", 307);
      }
      return Response.json({ token_type: "bearer", access_token: token, expires_in: 3600 });
    },
    cf: false,
  });
  t.after(() => runtime.dispose());
  const fetchImpl = (url, options) => runtime.dispatchFetch(url, options);
  const post = (path, values) => fetchImpl(GITHUB_OAUTH_ORIGIN + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
  });
  const callback = (state, result) => fetchImpl(GITHUB_OAUTH_ORIGIN + "/github/callback?" + new URLSearchParams({ state, ...result }),
    { redirect: "manual" });
  let now = Date.now();
  const authorization = new GitHubBrowserAuthorization({ fetchImpl, now: () => now });
  const [first, second] = await Promise.all([authorization.start(), authorization.start()]);
  assert.notEqual(first.state, second.state);
  assert.equal((await callback("z".repeat(43), { code: "synthetic_wrong_state" })).status, 409);
  assert.equal((await callback(first.state, { code: "synthetic_code_first" })).status, 303);
  assert.equal((await callback(first.state, { code: "synthetic_code_replacement" })).status, 409);
  const foreign = await post("/github/poll", { state: first.state, verifier: second.verifier });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.text()).includes(token), false);

  const proof = { state: first.state, verifier: first.verifier };
  const replies = await Promise.all([1, 2].map(async () => (await post("/github/poll", proof)).json()));
  const authorized = replies.filter(reply => reply.status === "authorized");
  assert.equal(authorized.length, 1, JSON.stringify({ statuses: replies.map(reply => reply.status), exchanges: exchanges.length }));
  assert.equal(authorized[0].token, token);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].url, "https://github.com/login/oauth/access_token");
  assert.equal(exchanges[0].method, "POST");
  const form = new URLSearchParams(exchanges[0].body);
  assert.equal(form.get("client_secret"), secret);
  assert.equal(form.get("client_id"), new URL(first.authorizationUrl).searchParams.get("client_id"));
  assert.equal(form.get("redirect_uri"), GITHUB_OAUTH_ORIGIN + "/github/callback");
  assert.equal(form.get("code_verifier"), first.verifier);
  assert.equal(form.get("code"), "synthetic_code_first");
  assert.deepEqual(await (await post("/github/poll", proof)).json(), { status: "consumed" });

  now += second.intervalMs;
  assert.equal((await authorization.poll(second)).status, "pending");
  const denied = await callback(second.state, { error: "access_denied" });
  assert.equal(denied.status, 303);
  assert.equal(denied.headers.get("Location"), "/github/complete");
  now += second.intervalMs;
  assert.equal((await authorization.poll(second)).status, "denied");
  assert.equal(exchanges.length, 1);

  const redirected = await authorization.start();
  assert.equal((await callback(redirected.state, { code: "synthetic_redirect" })).status, 303);
  const rejected = await (await post("/github/poll", { state: redirected.state, verifier: redirected.verifier })).json();
  assert.deepEqual(rejected, { status: "failed" });
  assert.deepEqual(exchanges.map(item => item.url), Array(2).fill("https://github.com/login/oauth/access_token"));
});

test("native Worker gives a rotated pair back once admitted, including a lost Hub response", { timeout: 30_000 }, async t => {
  const refreshToken = "ghr_REFRESH_FIXTURE_INITIAL_123456789";
  const nextRefreshToken = "ghr_REFRESH_FIXTURE_ROTATED_123456789";
  const nextToken = "gho_REFRESH_FIXTURE_ROTATED_123456789";
  const brokenToken = "ghr_REFRESH_FIXTURE_UNKNOWN_123456789";
  const revokedToken = "ghr_REFRESH_FIXTURE_REVOKED_123456789";
  const exchangeStarted = Promise.withResolvers(), releaseExchange = Promise.withResolvers();
  const exchanges = [];
  const pair = { token_type: "bearer", access_token: nextToken, expires_in: 28_800,
    refresh_token: nextRefreshToken, refresh_token_expires_in: 15_897_600 };
  const runtime = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../../../../cloudflare-github-oauth/worker.mjs", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../../../..", import.meta.url)),
    compatibilityDate: "2026-07-28",
    durableObjects: { ATTEMPTS: { className: "GitHubOAuthAttempt", useSQLite: true } },
    bindings: { GITHUB_OAUTH_CLIENT_SECRET: "synthetic-client-secret" },
    outboundService: async request => {
      assert.equal(request.url, "https://github.com/login/oauth/access_token");
      const values = new URLSearchParams(await request.text());
      exchanges.push(values);
      if (values.has("code")) return Response.json(pair);
      switch (values.get("refresh_token")) {
        case refreshToken: exchangeStarted.resolve(); await releaseExchange.promise; return Response.json(pair);
        case revokedToken: return Response.json({ error: "bad_refresh_token" });
        case brokenToken: return Response.json({ error: "indeterminate" }, { status: 502 });
        default: throw new Error("Unexpected synthetic refresh");
      }
    },
    cf: false,
  });
  t.after(() => runtime.dispose());
  const post = (endpoint, body) => runtime.dispatchFetch(GITHUB_OAUTH_ORIGIN + endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let clock = Date.now();
  const authorization = new GitHubBrowserAuthorization({ fetchImpl: (url, options) => runtime.dispatchFetch(url, options),
    now: () => clock });
  for (const modern of [false, true]) {
    const login = await authorization.start();
    const callback = await runtime.dispatchFetch(GITHUB_OAUTH_ORIGIN + "/github/callback?" +
      new URLSearchParams({ state: login.state, code: "fixture_oauth_code" }), { redirect: "manual" });
    assert.equal(callback.status, 303);
    clock += login.intervalMs;
    const credentials = modern ? await authorization.poll(login)
      : await (await post("/github/poll", { state: login.state, verifier: login.verifier })).json();
    assert.equal(credentials.token, nextToken);
    assert.equal(credentials.refreshToken, modern ? nextRefreshToken : undefined);
  }
  const proof = { refreshToken, verifier: "v".repeat(43), deadline: Date.now() + 60_000 };
  const first = post("/github/refresh", proof);
  try {
    await exchangeStarted.promise;
    assert.deepEqual(await (await post("/github/refresh", proof)).json(), { status: "pending" });
    assert.deepEqual(await (await post("/github/refresh", { ...proof, verifier: "x".repeat(43) })).json(),
      { status: "unknown" });
  } finally { releaseExchange.resolve(); }
  const raw = await (await first).text();
  assert.equal(JSON.parse(raw).status, "refreshed");
  assert.ok([nextToken, nextRefreshToken, proof.verifier].every(secret => !raw.includes(secret)));
  // Discard the first response. A fresh caller reads back the same durable result.
  assert.equal(await (await post("/github/refresh", proof)).text(), raw);
  const current = await authorization.refresh(proof);
  assert.equal(current.token, nextToken);
  assert.equal(current.refreshToken, nextRefreshToken);
  assert.equal(exchanges.filter(form => form.get("refresh_token") === refreshToken).length, 1);
  const form = exchanges.at(-1);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("client_secret"), "synthetic-client-secret");
  assert.equal(form.has("scope"), false);
  for (const [refreshToken, status] of [[revokedToken, "reconnect"], [brokenToken, "unknown"]]) {
    const same = { ...proof, refreshToken };
    for (let i = 0; i < 2; i++) assert.deepEqual(await authorization.refresh(same), { status });
    assert.equal(exchanges.filter(form => form.get("refresh_token") === refreshToken).length, 1);
  }
});

test("legacy whole-object alarm cleanup clears the sealed result without reopening provider admission", async t => {
  const deadline = Date.now() + 86_400_000, objects = new Map();
  let exchanges = 0;
  t.mock.method(globalThis, "fetch", async () => {
    exchanges++;
    return Response.json({ token_type: "bearer", access_token: "gho_ROLLBACK_FIXTURE_ROTATED_123456789",
      expires_in: 28_800, refresh_token: "ghr_ROLLBACK_FIXTURE_ROTATED_123456789", refresh_token_expires_in: 15_897_600 });
  });
  const env = { GITHUB_OAUTH_CLIENT_SECRET: "synthetic-client-secret", ATTEMPTS: {
    getByName(name) {
      if (!objects.has(name)) {
        const rows = new Map();
        const record = { rows, alarmAt: null };
        const storage = { kv: { get: key => rows.get(key), put: (key, value) => rows.set(key, value) },
          setAlarm: async at => { record.alarmAt = at; }, sync: async () => {}, deleteAll: async () => rows.clear() };
        record.runAlarm = () => storage.deleteAll(); // The previously deployed Worker uses whole-object cleanup.
        record.fetch = (url, options) => new GitHubOAuthAttempt({ storage }, env).fetch(new Request(url, options));
        objects.set(name, record);
      }
      return objects.get(name);
    },
  } };
  const proof = { refreshToken: "ghr_ROLLBACK_FIXTURE_INITIAL_123456789", verifier: "v".repeat(43), deadline };
  const refresh = () => worker.fetch(new Request(GITHUB_OAUTH_ORIGIN + "/github/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(proof),
  }), env);
  assert.equal((await (await refresh()).json()).status, "refreshed"); // The original Hub response is lost.
  const receipts = [...objects.values()].sort((a, b) => a.alarmAt - b.alarmAt);
  assert.equal(receipts.length, 2);
  assert.ok(receipts[0].alarmAt < deadline);
  assert.equal(receipts[1].alarmAt, deadline);
  await receipts[0].runAlarm();
  assert.equal(receipts[0].rows.size, 0);
  assert.equal(receipts[1].rows.get("refresh").status, "refreshed");
  assert.deepEqual(await (await refresh()).json(), { status: "unknown" });
  assert.equal(exchanges, 1);
});
