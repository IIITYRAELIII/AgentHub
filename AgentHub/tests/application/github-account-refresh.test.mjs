import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GitHubAccountService } from "../../src/application/github-account-service.mjs";
import { GitHubAccountVault } from "../../src/infrastructure/filesystem/github-account-vault.mjs";
import { githubCredential } from "../../src/infrastructure/process/github-credential-helper.mjs";
import { runGitHubCli } from "../../src/infrastructure/process/github-gh-cli.mjs";

const original = "gho_TEST_ACCESS_INITIAL_987654321";
const rotated = "gho_TEST_ACCESS_ROTATED_987654321";
const oldRefresh = "ghr_TEST_REFRESH_INITIAL_123456789";
const newRefresh = "ghr_TEST_REFRESH_ROTATED_123456789";
const gitRequest = "protocol=https\nhost=github.com\n\n";

async function fixture(t, { refreshToken = oldRefresh } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-github-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.now();
  const now = () => clock;
  const calls = [];
  const pair = () => ({ status: "refreshed", token: rotated, refreshToken: newRefresh,
    expiresAt: now() + 28_800_000, refreshExpiresAt: now() + 15897600000 });
  let respond = async () => pair(), fetchAccount;
  const authorization = {
    start: async () => ({ authorizationUrl: "https://github.com/fixture" }),
    poll: async () => ({ status: "authorized", token: original, expiresAt: now() + 28_800_000,
      ...(refreshToken && { refreshToken, refreshExpiresAt: now() + 15897600000 }) }),
    refresh: async input => { calls.push(input); return respond(); },
  };
  const makeVault = () => new GitHubAccountVault({ directory, now, authorization,
    crypt: async b => Buffer.from(b).reverse(), protect: async () => {} });
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/user")) return Response.json({ id: 5, login: "test-account", name: "Test" });
    if (url.endsWith("/user/emails")) return Response.json([]);
    return fetchAccount ? fetchAccount(options) : Response.json({ authorized: options.headers.Authorization === "Bearer " + rotated });
  };
  const vault = makeVault();
  const openService = () => new GitHubAccountService({ directory, vault: makeVault(), fetchImpl, authorization }).initialize();
  const service = await new GitHubAccountService({ directory, vault, fetchImpl, authorization }).initialize();
  const started = await service.startLogin();
  assert.equal((await service.pollLogin(started.login.attemptId)).login.status, "connected");
  const row = await vault.read();
  await writeFile(path.join(directory, "tools.json"), JSON.stringify({ gh: "synthetic-gh" }));
  return { service, openService, vault, makeVault, directory, row, calls, pair, now,
    advance: ms => { clock += ms; }, respond: next => { respond = next; }, api: next => { fetchAccount = next; } };
}

test("API, Git and gh share one rotation across vault owners and reopen", async t => {
  const f = await fixture(t);
  const profile = await readFile(f.vault.profileFile);
  f.advance(28_800_001);
  assert.equal((await f.service.snapshot()).status, "connected");
  const [api, git, gh] = await Promise.all([
    f.service.request("/repos/owned/repo"),
    githubCredential({ directory: f.directory, vault: f.makeVault(), id: f.row.id, operation: "get", input: gitRequest }),
    runGitHubCli(["repo", "view"], { directory: f.directory, vault: f.makeVault(),
      environment: {}, stdin: new PassThrough(), spawnProcess: (executable, args, options) => {
        assert.equal(options.env.GH_TOKEN, rotated);
        assert.equal(Object.values(options.env).includes(newRefresh), false);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit("close", 0); });
        return child;
      } }),
  ]);
  assert.deepEqual(await api.json(), { authorized: true });
  assert.match(git, new RegExp("password=" + rotated, "u"));
  assert.equal(gh, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].refreshToken, oldRefresh);
  const after = await f.vault.read(), raw = await readFile(f.vault.credentialFile(after.id), "utf8");
  assert.equal(after.id, f.row.id);
  assert.notEqual(after.generation, f.row.generation);
  assert.deepEqual(await readFile(f.vault.profileFile), profile);
  assert.deepEqual(await (await (await f.openService()).request("/repos/owned/repo")).json(), { authorized: true });
  assert.equal(f.calls.length, 1);
  assert.ok([original, rotated, oldRefresh, newRefresh, f.calls[0].verifier].every(secret => !raw.includes(secret)));
});

test("lost replies keep the selected pair and reuse the same attempt after restart", async t => {
  const f = await fixture(t);
  f.advance(28_800_001);
  f.respond(async () => ({ status: "unavailable" }));
  await assert.rejects(f.service.request("/repos/owned/repo"), /Повторите операцию/u);
  assert.equal((await f.service.snapshot()).status, "connected");
  const saved = await f.vault.read();
  assert.equal(saved.secret, f.row.secret);
  assert.equal(saved.refreshSecret, f.row.refreshSecret);
  f.advance(24 * 60 * 60_000);
  f.respond(async () => f.pair());
  const reopened = await f.openService();
  assert.equal((await (await reopened.request("/repos/owned/repo")).json()).authorized, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], f.calls[1]);
});

test("two independent credential processes share the on-disk rotation lock", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  f.advance(28_800_001);
  const vaultModule = new URL("../../src/infrastructure/filesystem/github-account-vault.mjs", import.meta.url);
  const helperModule = new URL("../../src/infrastructure/process/github-credential-helper.mjs", import.meta.url);
  const program = `
    import { once } from "node:events";
    import { GitHubAccountVault } from ${JSON.stringify(vaultModule.href)};
    import { githubCredential } from ${JSON.stringify(helperModule.href)};
    const [directory, id, clock] = process.argv.slice(1);
    const vault = new GitHubAccountVault({ directory, now: () => Number(clock), crypt: async bytes => Buffer.from(bytes).reverse(),
      authorization: { refresh: async () => {
        const answer = once(process, "message");
        process.send({ refreshRequested: true });
        return (await answer)[0];
      } } });
    const reply = await githubCredential({ directory, id, vault, operation: "get", input: ${JSON.stringify(gitRequest)} });
    process.send({ valid: reply.includes("password=" + ${JSON.stringify(rotated)}) });
    process.disconnect();
  `;
  let upstream = 0;
  const owner = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program, f.directory, f.row.id, String(f.now())],
      { windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let valid = false;
    child.on("message", message => {
      if (message.refreshRequested) {
        upstream++;
        child.send(f.pair());
      } else valid = message.valid;
    });
    child.once("error", reject);
    child.once("close", code => resolve({ code, valid }));
  });
  assert.deepEqual(await Promise.all([owner(), owner()]), [{ code: 0, valid: true }, { code: 0, valid: true }]);
  assert.equal(upstream, 1);
});

test("definite refresh rejection and expired legacy access require sign-in", async t => {
  const f = await fixture(t);
  f.advance(28_800_001);
  f.respond(async () => ({ status: "reconnect" }));
  await assert.rejects(f.service.request("/repos/owned/repo"), /Переподключите/u);
  await assert.rejects((await f.openService()).request("/repos/owned/repo"), /Переподключите/u);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.snapshot()).status, "expired");
  assert.equal((await f.vault.read()).refreshSecret, f.row.refreshSecret);
  const legacy = await fixture(t, { refreshToken: null });
  legacy.advance(28_800_001);
  await assert.rejects(legacy.service.request("/repos/owned/repo"), /Переподключите/u);
  assert.equal((await legacy.service.snapshot()).status, "expired");
  assert.equal(legacy.calls.length, 0);
  const stale = await fixture(t);
  stale.advance(15897600001);
  await assert.rejects(stale.service.request("/repos/owned/repo"), /Переподключите/u);
  assert.equal((await stale.service.snapshot()).status, "expired");
  assert.equal(stale.calls.length, 0);
});

test("an authoritative indeterminate exchange keeps its original receipt and credentials", async t => {
  const f = await fixture(t);
  f.advance(28_800_001);
  f.respond(async () => ({ status: "unknown" }));
  await assert.rejects(f.service.request("/repos/owned/repo"), /Переподключите/u);
  const saved = await f.vault.read();
  assert.equal((await f.service.snapshot()).status, "expired");
  assert.equal(saved.secret, f.row.secret);
  assert.equal(saved.refreshSecret, f.row.refreshSecret);
  const reopened = await f.openService();
  await assert.rejects(reopened.request("/repos/owned/repo"), /Переподключите/u);
  assert.equal((await reopened.snapshot()).status, "expired");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.vault.read(), saved);
});

for (const action of ["disconnect", "reconnect"]) test(`late rotation cannot resurrect a ${action}ed selection`, async t => {
  const f = await fixture(t);
  f.advance(28_800_001);
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  f.respond(async () => { entered.resolve(); await finish.promise; return f.pair(); });
  const refreshing = assert.rejects(f.service.request("/repos/owned/repo"), /Переподключите/u);
  await entered.promise;
  const selected = Promise.withResolvers();
  const publish = f.vault.publish.bind(f.vault);
  f.vault.publish = async row => { await publish(row); selected.resolve(); };
  const change = action === "disconnect" ? f.service.disconnect() : f.service.connect(original);
  await selected.promise;
  finish.resolve();
  await Promise.all([refreshing, change]);
  const row = await f.vault.read();
  assert.ok(action === "disconnect" ? row === null : row.id !== f.row.id && !row.refreshSecret);
  await assert.rejects(readFile(f.vault.credentialFile(f.row.id)), { code: "ENOENT" });
});

test("late old API 401 and Git erase leave the rotated credential usable", async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  f.api(async options => {
    if (options.headers.Authorization === "Bearer " + original) {
      entered.resolve();
      await finish.promise;
      return new Response(null, { status: 401 });
    }
    return Response.json({ authorized: true });
  });
  const old = assert.rejects(f.service.request("/repos/owned/repo"), { status: 401 });
  await entered.promise;
  f.advance(28_800_001);
  assert.equal((await (await f.service.request("/repos/owned/repo")).json()).authorized, true);
  finish.resolve();
  await old;
  await githubCredential({ directory: f.directory, vault: f.makeVault(), id: f.row.id, operation: "erase",
    input: gitRequest.trimEnd() + "\npassword=" + original + "\n\n" });
  assert.equal((await f.service.snapshot()).status, "connected");
  assert.equal(await f.vault.token(await f.vault.read()), rotated);
});
