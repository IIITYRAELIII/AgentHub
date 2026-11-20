import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { GitHubDeviceAuthorization, GITHUB_OAUTH_SCOPES } from "../../src/infrastructure/network/github-device-authorization.mjs";
import { GitHubAccountService } from "../../src/application/github-account-service.mjs";
import { GitHubAccountVault } from "../../src/infrastructure/filesystem/github-account-vault.mjs";
import { githubCredential } from "../../src/infrastructure/process/github-credential-helper.mjs";
import { runGitHubCli } from "../../src/infrastructure/process/github-gh-cli.mjs";

const token = "gho_SYNTHETIC_OAUTH_ACCESS_1234567890";
const deviceCode = "synthetic_device_code_12345678901234567890";
const grant = { device_code: deviceCode, user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-oauth-"));
  const requests = [], replies = [];
  let clock = Date.now(), held = null, apiDenied = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: new URLSearchParams(body), authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/login/device/code") return res.end(JSON.stringify(grant));
    if (req.url === "/login/oauth/access_token") {
      if (held) { const wait = held; held = null; await wait; }
      return res.end(JSON.stringify(replies.shift() ?? { access_token: token, token_type: "bearer", expires_in: 28800 }));
    }
    if (apiDenied) { res.statusCode = apiDenied; return res.end("{}"); }
    if (req.url === "/user") return res.end(JSON.stringify({ id: 211, login: "oauth-user", name: "OAuth User" }));
    if (req.url === "/user/emails") return res.end(JSON.stringify([{ primary: true, verified: true, email: "oauth@example.invalid" }]));
    return res.end(JSON.stringify({ authorized: req.headers.authorization === `Bearer ${token}` }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const fetchImpl = (url, options) => {
    assert.ok(url.startsWith("https://github.com/") || url.startsWith("https://api.github.com/"));
    assert.equal(options.redirect, "error");
    assert.equal(new URL(url).search, "");
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options);
  };
  const oauth = new GitHubDeviceAuthorization({ clientId: "synthetic_public_client", fetchImpl, now: () => clock });
  const vault = new GitHubAccountVault({ directory, crypt: async b => Buffer.from(b).reverse(), protect: async () => {} });
  const service = await new GitHubAccountService({ directory, vault, fetchImpl, deviceAuthorization: oauth }).initialize();
  return { directory, service, vault, oauth, requests, replies,
    advance: ms => { clock += ms; }, hold: wait => { held = wait; }, deny: status => { apiDenied = status; } };
}

test("device interval, slow-down and deadline govern actual private HTTP without early token requests", async t => {
  const f = await fixture(t), flow = await f.oauth.start();
  assert.equal(f.requests[0].body.get("scope"), GITHUB_OAUTH_SCOPES);
  assert.equal(f.requests[0].body.has("client_secret"), false);
  assert.equal((await f.oauth.poll(flow)).status, "pending");
  assert.equal(f.requests.length, 1);
  f.advance(5000); f.replies.push({ error: "authorization_pending" });
  assert.equal((await f.oauth.poll(flow)).waitMs, 5000);
  f.advance(5000); f.replies.push({ error: "slow_down", interval: 12 });
  assert.equal((await f.oauth.poll(flow)).waitMs, 12000);
  f.advance(11000); await f.oauth.poll(flow);
  assert.equal(f.requests.length, 3);
  f.advance(1000);
  const result = await f.oauth.poll(flow);
  assert.equal(result.status, "authorized");
  assert.equal(result.token, token);
  assert.equal(f.requests.at(-1).body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  f.advance(900_000);
  assert.equal((await f.oauth.poll(flow)).status, "expired");
  assert.equal(f.requests.length, 4);
});

test("OAuth completion reuses actual protected selection for Git credential, gh child and API; expiry refuses all", async t => {
  const f = await fixture(t);
  const started = await f.service.startLogin();
  assert.equal(started.login.userCode, "ABCD-EFGH");
  assert.equal(JSON.stringify(await f.service.snapshot()).includes(deviceCode), false);
  assert.equal(JSON.stringify(started).includes(deviceCode), false);
  f.advance(5000);
  const result = await f.service.pollLogin(started.login.attemptId);
  assert.equal(result.githubAccount.status, "connected");
  assert.equal(result.githubAccount.account.email, "oauth@example.invalid");
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
  while (!f.requests.some(x => x.path === "/login/oauth/access_token")) await new Promise(resolve => setImmediate(resolve));
  if (action === "disconnect") await f.service.disconnect();
  if (action === "cancel") await f.service.cancelLogin(started.login.attemptId);
  if (action === "replace") await f.service.startLogin();
  if (action === "pause") f.service.pause();
  release();
  await assert.rejects(polling, /заменён/u);
  assert.equal((await f.service.snapshot()).status, "disconnected");
  assert.equal(await f.vault.selection(), null);
});

test("denial/expiry/unconfigured/foreign and unreadable replies remain explicit without response leakage", async t => {
  const f = await fixture(t);
  for (const error of ["access_denied", "expired_token", "token_expired"]) {
    const started = await f.service.startLogin(); f.advance(5000); f.replies.push({ error });
    const result = await f.service.pollLogin(started.login.attemptId);
    assert.ok(["denied", "expired"].includes(result.login.status));
    assert.equal((await f.service.snapshot()).status, "disconnected");
  }
  let calls = 0;
  await assert.rejects(new GitHubDeviceAuthorization({ fetchImpl: () => { calls++; } }).start(), /Client ID/u);
  assert.equal(calls, 0);
  for (const value of [{ ...grant, verification_uri: "https://foreign.invalid/login" }, { ...grant, error: "device_flow_disabled" }, { ...grant, interval: 0 }]) {
    const oauth = new GitHubDeviceAuthorization({ clientId: "public", fetchImpl: async () => Response.json(value) });
    await assert.rejects(oauth.start(), /GitHub|Device Flow/u);
  }
  const hostile = new GitHubDeviceAuthorization({ clientId: "public", fetchImpl: async () => { throw new Error(token); } });
  await assert.rejects(hostile.start(), e => !e.message.includes(token));
  const malformed = new GitHubDeviceAuthorization({ clientId: "public", fetchImpl: async () => Response.json(null) });
  await assert.rejects(malformed.start(), /Не удалось выполнить/u);
});

test("concurrent exact polls redeem once; snapshot/reopen do not revive a pending device login", async t => {
  const f = await fixture(t);
  const started = await f.service.startLogin(); f.advance(5000);
  const result = await Promise.all([f.service.pollLogin(started.login.attemptId), f.service.pollLogin(started.login.attemptId)]);
  assert.equal(f.requests.filter(x => x.path === "/login/oauth/access_token").length, 1);
  assert.equal(result[0].githubAccount.status, result[1].githubAccount.status);
  let external = 0;
  const reopened = await new GitHubAccountService({ directory: f.directory, vault: f.vault,
    fetchImpl: async () => { external++; throw new Error("unexpected external request"); } }).initialize();
  await assert.rejects(reopened.pollLogin(started.login.attemptId), /завершён/u);
  await reopened.snapshot();
  assert.equal(external, 0);
});
