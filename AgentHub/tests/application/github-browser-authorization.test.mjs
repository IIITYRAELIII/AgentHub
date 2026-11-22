import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile, access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { GitHubBrowserAuthorization } from "../../src/infrastructure/network/github-browser-authorization.mjs";
import { githubOAuthChallenge } from "../../src/infrastructure/network/github-oauth-protocol.mjs";
import { GitHubAccountService } from "../../src/application/github-account-service.mjs";
import { GitHubAccountVault } from "../../src/infrastructure/filesystem/github-account-vault.mjs";
import { githubCredential } from "../../src/infrastructure/process/github-credential-helper.mjs";
import { runGitHubCli } from "../../src/infrastructure/process/github-gh-cli.mjs";

const token = "gho_SYNTHETIC_OAUTH_ACCESS_1234567890";
const oldToken = "github_pat_SYNTHETIC_OLD_PUBLICATION_123456";
const state = "s".repeat(43);
const grant = { state };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-oauth-"));
  const requests = [], replies = [];
  let clock = Date.now(), held = null, apiDenied = 0, emailDenied = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: body ? JSON.parse(body) : null, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/github/start") return res.end(JSON.stringify(grant));
    if (req.url === "/github/poll") {
      if (held) { const wait = held; held = null; await wait; }
      return res.end(JSON.stringify(replies.shift() ?? { status: "authorized", token, expiresAt: clock + 28_800_000 }));
    }
    if (apiDenied) { res.statusCode = apiDenied; return res.end("{}"); }
    if (req.url === "/user") return res.end(JSON.stringify(req.headers.authorization === `Bearer ${oldToken}`
      ? { id: 11, login: "original-user", name: "Original User" }
      : { id: 211, login: "oauth-user", name: "OAuth User" }));
    if (req.url === "/user/emails") {
      if (emailDenied) { res.statusCode = 403; return res.end("{}"); }
      return res.end(JSON.stringify([{ primary: true, verified: true, email: "oauth@example.invalid" }]));
    }
    return res.end(JSON.stringify({ authorized: req.headers.authorization === `Bearer ${token}` }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const fetchImpl = (url, options) => {
    assert.ok(url.startsWith("https://auth.darksanctuary.ru/") || url.startsWith("https://api.github.com/"));
    assert.equal(options.redirect, "error");
    assert.equal(new URL(url).search, "");
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options);
  };
  const oauth = new GitHubBrowserAuthorization({ fetchImpl, now: () => clock });
  const vault = new GitHubAccountVault({ directory, crypt: async b => Buffer.from(b).reverse(), protect: async () => {} });
  const service = await new GitHubAccountService({ directory, vault, fetchImpl, authorization: oauth }).initialize();
  return { directory, service, vault, oauth, requests, replies,
    advance: ms => { clock += ms; }, hold: wait => { held = wait; }, deny: status => { apiDenied = status; },
    denyPrivateEmail: () => { emailDenied = true; } };
}

test("browser requests exact scopes and binds outbound polls to the local PKCE verifier", async t => {
  const f = await fixture(t), flow = await f.oauth.start();
  const url = new URL(flow.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), "https://auth.darksanctuary.ru/github/callback");
  assert.deepEqual(url.searchParams.get("scope").split(/\s+/u).sort(), ["gist", "read:org", "repo", "workflow"]);
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(f.requests[0].body, { challenge: await githubOAuthChallenge(flow.verifier) });
  assert.equal(url.searchParams.get("code_challenge"), f.requests[0].body.challenge);
  assert.equal(url.href.includes(flow.verifier), false);
  assert.equal((await f.oauth.poll(flow)).status, "pending");
  assert.equal(f.requests.length, 1);
  f.advance(flow.intervalMs);
  f.replies.push({ status: "pending" });
  assert.equal((await f.oauth.poll(flow)).waitMs, flow.intervalMs);
  assert.deepEqual(f.requests.at(-1).body, { state, verifier: flow.verifier });
  f.advance(flow.intervalMs - 1);
  assert.equal((await f.oauth.poll(flow)).status, "pending");
  assert.equal(f.requests.length, 2);
  f.advance(1);
  const result = await f.oauth.poll(flow);
  assert.equal(result.status, "authorized");
  assert.equal(result.token, token);
  assert.equal(f.requests.at(-1).path, "/github/poll");
  f.advance(300_000);
  assert.equal((await f.oauth.poll(flow)).status, "expired");
  assert.equal(f.requests.length, 3);
});

test("OAuth completion reuses actual protected selection for Git credential, gh child and API; expiry refuses all", async t => {
  const f = await fixture(t);
  f.denyPrivateEmail();
  const started = await f.service.startLogin();
  assert.deepEqual(Object.keys(started.login).sort(), ["attemptId", "authorizationUrl", "expiresAt", "waitMs"]);
  assert.equal(JSON.stringify(await f.service.snapshot()).includes(state), false);
  f.advance(5000);
  const result = await f.service.pollLogin(started.login.attemptId);
  assert.equal(result.githubAccount.status, "connected");
  assert.equal(result.githubAccount.account.email, "211+oauth-user@users.noreply.github.com");
  assert.equal(JSON.stringify(result).includes(token), false);
  const row = await f.vault.read();
  assert.equal((await githubCredential({ directory: f.directory, vault: f.vault, id: row.id, operation: "get", input: "protocol=https\nhost=github.com\n\n" })).includes(token), true);
  assert.equal((await (await f.service.request("/repos/owner/private")).json()).authorized, true);
  await writeFile(path.join(f.directory, "tools.json"), JSON.stringify({ gh: process.execPath }));
  const child = path.join(f.directory, "oauth-gh.cjs");
  await writeFile(child, `if(process.env.GH_TOKEN!==${JSON.stringify(token)})process.exit(9); process.stdout.write('authorized');`);
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  let output = ""; stdout.on("data", x => { output += x; }); stdin.end();
  assert.equal(await runGitHubCli([child], { directory: f.directory, vault: f.vault, stdout, stderr, stdin }), 0);
  assert.equal(output, "authorized");
  const ciphertext = await readFile(f.vault.credentialFile(row.id), "utf8");
  assert.equal(ciphertext.includes(token), false);
  const expired = { ...row, expiresAt: Date.now() - 1 };
  await writeFile(f.vault.credentialFile(row.id), JSON.stringify(expired));
  assert.equal((await f.service.snapshot()).status, "expired");
  await assert.rejects(f.vault.token(expired), /Переподключите/u);
  const before = f.requests.length;
  const refusedCredential = await githubCredential({ directory: f.directory, vault: f.vault, id: row.id, operation: "get", input: "protocol=https\nhost=github.com\n\n" });
  assert.equal(refusedCredential.includes(token), false);
  await assert.rejects(runGitHubCli([child], { directory: f.directory, vault: f.vault }), /Переподключите/u);
  await assert.rejects(f.service.request("/repos/owner/private"), /Переподключите/u);
  assert.equal(f.requests.length, before);
  await writeFile(f.vault.credentialFile(row.id), JSON.stringify(row));
  f.deny(403); await assert.rejects(f.service.request("/repos/denied"), /403/u);
  assert.equal((await f.service.snapshot()).status, "connected");
  f.deny(401); await assert.rejects(f.service.request("/repos/denied"), /истекла/u);
  assert.equal((await f.service.snapshot()).status, "expired");
});

for (const action of ["disconnect", "cancel", "replace", "pause"]) test(`late OAuth completion cannot reverse ${action} or publish another account`, async t => {
  const f = await fixture(t);
  const started = await f.service.startLogin(); f.advance(5000);
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const polling = f.service.pollLogin(started.login.attemptId);
  // Wait for the real HTTP request boundary, not an arbitrary delay.
  while (!f.requests.some(x => x.path === "/github/poll")) await new Promise(resolve => setImmediate(resolve));
  if (action === "disconnect") await f.service.disconnect();
  if (action === "cancel") await f.service.cancelLogin(started.login.attemptId);
  if (action === "replace") await f.service.startLogin();
  if (action === "pause") f.service.pause();
  release();
  await assert.rejects(polling, /заменён/u);
  assert.equal((await f.service.snapshot()).status, "disconnected");
  assert.equal(await f.vault.selection(), null);
});

test("denial/expiry and unreadable broker replies remain explicit without response leakage", async t => {
  const f = await fixture(t);
  for (const status of ["denied", "expired"]) {
    const started = await f.service.startLogin(); f.advance(5000); f.replies.push({ status });
    const result = await f.service.pollLogin(started.login.attemptId);
    assert.equal(result.login.status, status);
    assert.equal((await f.service.snapshot()).status, "disconnected");
  }
  const invalid = new GitHubBrowserAuthorization({ fetchImpl: async () => Response.json({ state: "invalid" }) });
  await assert.rejects(invalid.start(), /неподдерживаемый/u);
  const hostile = new GitHubBrowserAuthorization({ fetchImpl: async () => { throw new Error(token); } });
  await assert.rejects(hostile.start(), e => !e.message.includes(token));
  const malformed = new GitHubBrowserAuthorization({ fetchImpl: async () => Response.json(null) });
  await assert.rejects(malformed.start(), /Не удалось связаться/u);
});

test("concurrent exact polls redeem once; snapshot/reopen do not revive a pending browser login", async t => {
  const f = await fixture(t);
  const started = await f.service.startLogin(); f.advance(5000);
  const result = await Promise.all([f.service.pollLogin(started.login.attemptId), f.service.pollLogin(started.login.attemptId)]);
  assert.equal(f.requests.filter(x => x.path === "/github/poll").length, 1);
  assert.equal(result[0].githubAccount.status, result[1].githubAccount.status);
  let external = 0;
  const reopened = await new GitHubAccountService({ directory: f.directory, vault: f.vault,
    fetchImpl: async () => { external++; throw new Error("unexpected external request"); } }).initialize();
  await assert.rejects(reopened.pollLogin(started.login.attemptId), /завершён/u);
  await reopened.snapshot();
  assert.equal(external, 0);
});

for (const phase of ["selection", "save", "publish-before", "publish-after"]) {
  for (const action of ["cancel", "replace", "pause", "disconnect"]) {
    test(`OAuth publication ${phase} linearizes ${action} with actual selected-account readback`, { timeout: 10_000 }, async t => {
      const f = await fixture(t);
      await f.service.connect(oldToken);
      const original = await f.vault.selection();
      const started = await f.service.startLogin(); f.advance(5000);
      let reachedResolve, release;
      const reached = new Promise(resolve => { reachedResolve = resolve; });
      const barrier = new Promise(resolve => { release = resolve; });
      const events = [];
      let held = false;
      const hold = async () => { if (!held) { held = true; reachedResolve(); await barrier; } };
      if (phase === "selection") {
        const selection = f.vault.selection.bind(f.vault);
        f.vault.selection = async () => { const row = await selection(); await hold(); return row; };
      } else if (phase === "save") {
        const crypt = f.vault.crypt;
        f.vault.crypt = async (bytes, decrypt) => { if (!decrypt) await hold(); return crypt(bytes, decrypt); };
      } else {
        const publish = f.vault.publish.bind(f.vault);
        f.vault.publish = async row => {
          if (row?.account.id !== 211) return publish(row);
          if (phase === "publish-before") await hold();
          await publish(row);
          events.push("published");
          if (phase === "publish-after") await hold();
        };
      }
      // Observe the next browser-start response too: replacement must not pass
      // merely because its network request still happens to be pending.
      let nextFlowResolve;
      const nextFlow = new Promise(resolve => { nextFlowResolve = resolve; });
      const start = f.oauth.start.bind(f.oauth);
      f.oauth.start = async () => { const flow = await start(); nextFlowResolve(); return flow; };
      const outcome = f.service.pollLogin(started.login.attemptId).then(value => ({ value }), error => ({ error }));
      let changing;
      try {
        await reached;
        // Only the explicit cancellation/replacement/quiesced read joins the
        // writer; an ordinary live read still projects its actual selection.
        assert.equal((await f.service.snapshot()).account.id, phase === "publish-after" ? 211 : 11);
        let replied = false;
        if (action === "cancel") changing = f.service.cancelLogin(started.login.attemptId);
        if (action === "replace") changing = f.service.startLogin();
        if (action === "pause") { f.service.pause(); changing = f.service.snapshot().then(githubAccount => ({ githubAccount })); }
        if (action === "disconnect") changing = f.service.disconnect().then(githubAccount => ({ githubAccount }));
        changing = changing.then(value => { replied = true; events.push("reply"); return value; });
        if (action === "replace") await nextFlow;
        await new Promise(resolve => setImmediate(resolve));
        const repliedBeforeRelease = replied;
        release();
        const response = await changing;
        const poll = await outcome;
        const selected = await f.vault.selection();
        assert.equal(repliedBeforeRelease, false, "reply must join the admitted storage/publication section");
        assert.equal(response.githubAccount.account?.id ?? null, selected?.account.id ?? null);
        if (action === "disconnect") {
          assert.equal(selected, null);
          assert.equal(response.githubAccount.status, "disconnected");
        } else if (phase === "selection" || phase === "save") {
          assert.equal(selected.id, original.id);
          assert.equal(selected.account.id, 11);
          assert.ok(poll.error);
          assert.equal(await access(f.vault.credentialFile(original.id)).then(() => true, () => false), true);
        } else {
          assert.equal(selected.account.id, 211);
          assert.equal(poll.value.githubAccount.account.id, 211);
          assert.equal(events.indexOf("published") < events.indexOf("reply"), true);
          assert.equal(await access(f.vault.credentialFile(original.id)).then(() => true, () => false), false);
        }
        if (phase === "selection" || phase === "save") {
          assert.equal(events.includes("published"), false);
          assert.equal((await readdir(f.directory)).filter(x => /^connection-/u.test(x)).length, action === "disconnect" ? 0 : 1);
        }
      } finally { release(); await Promise.allSettled([outcome, changing]); }
    });
  }
}

for (const committed of [false, true]) test(`OAuth cancelled publication ${committed ? "lost ACK" : "refusal"} reports actual winner and preserves credential custody`, async t => {
  const f = await fixture(t);
  await f.service.connect(oldToken);
  const original = await f.vault.selection();
  const started = await f.service.startLogin(); f.advance(5000);
  let reachedResolve, release;
  const reached = new Promise(resolve => { reachedResolve = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const publish = f.vault.publish.bind(f.vault);
  f.vault.publish = async row => {
    if (committed) await publish(row);
    reachedResolve(); await barrier;
    throw new Error("controlled publication acknowledgement failure");
  };
  const outcome = f.service.pollLogin(started.login.attemptId).then(value => ({ value }), error => ({ error }));
  let cancelling;
  try {
    await reached;
    cancelling = f.service.cancelLogin(started.login.attemptId);
    release();
    const reply = await cancelling, poll = await outcome, selected = await f.vault.selection();
    assert.equal(reply.githubAccount.account.id, committed ? 211 : 11);
    assert.equal(selected.account.id, reply.githubAccount.account.id);
    assert.equal(Boolean(poll.error), !committed);
    assert.equal(await access(f.vault.credentialFile(original.id)).then(() => true, () => false), !committed);
    f.vault.publish = publish;
    const reopened = await new GitHubAccountService({ directory: f.directory, vault: f.vault }).initialize();
    assert.equal((await reopened.snapshot()).account.id, selected.account.id);
  } finally { release(); await Promise.allSettled([outcome, cancelling]); }
});
