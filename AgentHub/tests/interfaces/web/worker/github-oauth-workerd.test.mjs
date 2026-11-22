import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
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
