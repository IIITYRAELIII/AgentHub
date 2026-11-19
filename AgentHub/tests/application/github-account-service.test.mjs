import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GitHubAccountService } from "../../src/application/github-account-service.mjs";
import { GitHubAccountVault, windowsAccountCrypt } from "../../src/infrastructure/filesystem/github-account-vault.mjs";
import { githubAgentEnvironment, withoutGithubAccountEnvironment } from "../../src/infrastructure/filesystem/github-git-profile.mjs";
import { githubCredential } from "../../src/infrastructure/process/github-credential-helper.mjs";
import { runTaskGitCommand, TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { runGitHubCli } from "../../src/infrastructure/process/github-gh-cli.mjs";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { CodexAppServerLifecycle } from "../../src/providers/codex/codex-app-server-lifecycle.mjs";
import { ClaudeTurnLauncher } from "../../src/providers/claude/claude-turn-launcher.mjs";
import { spawnClaudeWorker } from "../../src/providers/claude/claude-run-io.mjs";
import { OwnedNativeObjectStore } from "../../src/infrastructure/filesystem/owned-native-object-store.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { inventoryNativeCapture } from "../../src/infrastructure/filesystem/native-capture-inventory.mjs";

const execute = promisify(execFile);
const token = "github_pat_SYNTHETIC_TEST_VALUE_123456789";
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-github-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Injected reversible cipher is fixture-only; production has no plaintext or
  // non-Windows fallback. A separate case executes actual current-user DPAPI.
  const crypt = async bytes => Buffer.from(bytes).reverse();
  const vault = new GitHubAccountVault({ directory, crypt, protect: async () => {} });
  const requests = [];
  let denied = 0;
  const fetchImpl = async (url, init) => {
    requests.push({ url, authorization: init.headers.Authorization, redirect: init.redirect });
    if (denied) return new Response("untrusted body " + token, { status: denied });
    if (url.endsWith("/user")) return Response.json({ id: 1234, login: "connected-user", name: "Connected User" });
    if (url.endsWith("/user/emails")) return Response.json([{ email: "connected@example.invalid", primary: true, verified: true }]);
    return Response.json({ authorized: init.headers.Authorization === `Bearer ${token}` });
  };
  const service = await new GitHubAccountService({ directory, vault, fetchImpl: options.fetchImpl ?? fetchImpl }).initialize();
  return { directory, vault, service, requests, deny: status => { denied = status; } };
}

test("connect, authenticated operation, explicit denial/expiry, reconnect and disconnect never expose credentials", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.snapshot()).status, "disconnected");
  const connected = await f.service.connect(token);
  assert.deepEqual(connected.account, { id: 1234, login: "connected-user", name: "Connected User", email: "connected@example.invalid" });
  assert.equal(JSON.stringify(connected).includes(token), false);
  assert.equal((await readFile(f.vault.file, "utf8")).includes(token), false);
  assert.equal((await readFile(f.vault.profileFile, "utf8")).includes(token), false);
  assert.deepEqual(await (await f.service.request("/repos/owner/private")).json(), { authorized: true });
  assert.ok(f.requests.every(item => item.authorization === `Bearer ${token}` && item.redirect === "error"));
  f.deny(403);
  await assert.rejects(f.service.request("/repos/owner/private"), error => error.status === 403 && !error.message.includes(token));
  assert.equal((await f.service.snapshot()).status, "connected");
  f.deny(401);
  await assert.rejects(f.service.request("/user"), /Переподключите/u);
  assert.equal((await f.service.snapshot()).status, "expired");
  f.deny(0);
  await f.service.connect(token);
  assert.equal((await f.service.snapshot()).status, "connected");
  await f.service.disconnect();
  assert.equal((await f.service.snapshot()).status, "disconnected");
  await assert.rejects(f.service.request("/user"), /Подключите/u);
  await assert.rejects(f.service.request("https://foreign.invalid"));
});

test("late connection cannot undo disconnect, optional email scope uses authenticated numeric noreply identity", async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fetchImpl: async url => {
    if (url.endsWith("/user")) { await held; return Response.json({ id: 77, login: "private-email", name: null }); }
    return new Response("", { status: 403 });
  } });
  const pending = f.service.connect(token);
  await f.service.disconnect();
  release();
  await assert.rejects(pending, /заменено/u);
  assert.equal((await f.service.snapshot()).status, "disconnected");
  const result = await f.service.connect(token);
  assert.equal(result.account.email, "77+private-email@users.noreply.github.com");
});

test("cutover pauses only account admission and joins existing validation before final disposal", async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fetchImpl: async url => {
    if (url.endsWith("/user")) { await held; return Response.json({ id: 77, login: "cutover-account" }); }
    return new Response("", { status: 403 });
  } });
  const admitted = f.service.connect(token);
  f.service.pause();
  await assert.rejects(f.service.connect(token), /остановки/u);
  await assert.rejects(f.service.disconnect(), /остановки/u);
  let drained = false;
  const drain = f.service.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await admitted;
  await drain;
  assert.equal((await f.service.snapshot()).status, "connected");
  f.service.resume();
  await f.service.disconnect();
  await f.service.dispose();
  f.service.resume();
  await assert.rejects(f.service.connect(token), /остановки/u);
});

test("private HTTP account/API path preserves authorization permissions and refuses redirects and 401", async t => {
  const observations = [];
  let unauthorized = false;
  const server = createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${token}`;
    observations.push({ path: request.url, authorized });
    response.setHeader("Content-Type", "application/json");
    if (!authorized || unauthorized) { response.writeHead(401); response.end("{}"); return; }
    if (request.url === "/user") { response.end(JSON.stringify({ id: 67, login: "http-account" })); return; }
    if (request.url === "/user/emails" || request.url === "/repos/forbidden") { response.writeHead(403); response.end("{}"); return; }
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/not-authorized-redirect" }); response.end(); return; }
    response.end(JSON.stringify({ accessible: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const f = await fixture(t, { fetchImpl: (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://api.github.com");
    return fetch(`http://127.0.0.1:${server.address().port}${target.pathname}`, options);
  } });
  await f.service.connect(token);
  assert.deepEqual(await (await f.service.request("/repos/allowed")).json(), { accessible: true });
  await assert.rejects(f.service.request("/repos/forbidden"), error => error.status === 403);
  assert.equal((await f.service.snapshot()).status, "connected");
  await assert.rejects(f.service.request("/redirect"), /связаться/u);
  assert.equal(observations.some(value => value.path === "/not-authorized-redirect"), false);
  unauthorized = true;
  await assert.rejects(f.service.request("/user"), error => error.status === 401);
  assert.equal((await f.service.snapshot()).status, "expired");
  assert.ok(observations.every(value => value.authorized));
});

test("credential pipe binds exact GitHub host and connection; foreign and stale helpers receive no token", async t => {
  const f = await fixture(t);
  await f.service.connect(token);
  const row = await f.vault.read();
  const get = (input, id = row.id, operation = "get") => githubCredential({ directory: f.directory, id, operation, input, vault: f.vault });
  assert.equal(await get("protocol=https\nhost=foreign.invalid\n"), "");
  assert.equal(await get("protocol=http\nhost=github.com\n"), "");
  assert.equal(await get("protocol=https\nhost=github.com\n", "stale"), "quit=true\n\n");
  assert.equal(await get("protocol=https\nhost=github.com\n"), `username=connected-user\npassword=${token}\n\n`);
  await f.service.connect(token);
  assert.equal(await get("protocol=https\nhost=github.com\n"), "quit=true\n\n");
  assert.equal((await f.service.snapshot()).status, "connected");
});

test("two separate Stream processes and internal Hub snapshot share profile, preserve historical commits and global config", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.service.connect(token);
  const root = path.join(f.directory, "repository");
  await mkdir(root);
  const git = async (...args) => (await execute("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Repository Owner");
  await git("config", "user.email", "repository@example.invalid");
  await git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "historical");
  const historical = await git("rev-parse", "HEAD"), historicalObject = await git("cat-file", "commit", historical);
  const globalBefore = await git("config", "--global", "--list", "--show-origin");
  const env = githubAgentEnvironment(process.env, f.directory);
  assert.equal(Object.values(env).includes(token), false);
  const prior = process.env.AGENT_HUB_GITHUB_DIRECTORY;
  process.env.AGENT_HUB_GITHUB_DIRECTORY = f.directory;
  try {
    // Real production provider launchers and real Git. Only the external model
    // executable is a deterministic local fixture; no model/network is called.
    const codexScript = path.join(f.directory, "codex-fixture.cjs");
    await writeFile(codexScript, `const {execFileSync}=require('node:child_process');
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const message=JSON.parse(line);execFileSync('git',['-c','commit.gpgsign=false','commit','--allow-empty','-m',message.params.threadId],{stdio:'pipe'});
        process.stdout.write(JSON.stringify({id:message.id,result:{accepted:true}})+'\\n');
      });`);
    let spawned;
    const lifecycle = new CodexAppServerLifecycle({ resolveExecutable: async () => process.execPath,
      executableArgs: [codexScript], projectRoot: () => root, unavailableMcpOverrides: async () => ({ disabled: [], args: [] }),
      spawnProcess: (command, args, options) => {
        assert.equal(args.some(value => value.includes("shell_environment_policy.set.GIT_CONFIG_KEY_")), true);
        assert.equal(args.join(" ").includes(token), false);
        assert.equal(Object.values(options.env).includes(token), false);
        return spawn(command, args, options);
      },
      logger: { log() {}, error() {} }, rpcTimeoutMs: 5000, isStopping: () => true,
      bindSpawnedProcess: child => { spawned = child; }, stopProcessTree: async () => { spawned.kill(); }, onMessage() {} });
    await lifecycle.start();
    try { assert.equal((await lifecycle.request("turn/start", { threadId: "stream-a" })).accepted, true); }
    finally { await lifecycle.stop(); }
    assert.equal(await git("show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"), "Connected User <connected@example.invalid>|Connected User <connected@example.invalid>");
    const claudeScript = path.join(f.directory, "claude-fixture.cjs");
    await writeFile(claudeScript, "require('node:child_process').execFileSync('git',['-c','commit.gpgsign=false','commit','--allow-empty','-m','stream-b'],{stdio:'pipe'});");
    const launcher = new ClaudeTurnLauncher({ taskRuns: { reindex() {} }, turnTemporaryFiles: new Map(),
      taskSnapshots: { read: async () => null }, autoApprove: () => false, permissionMode: "default",
      persistHistory: async () => {}, resolveInvocation: () => ({ command: process.execPath, prefixArgs: [claudeScript] }),
      runController: { start: async (_run, invocation) => {
        assert.equal(Object.values(invocation.env).includes(token), false);
        await new Promise((resolve, reject) => {
          const child = spawnClaudeWorker({ ...invocation, stdin: "ignore", stdout: "pipe", stderr: "pipe", onError: reject });
          child.once("close", code => code === 0 ? resolve() : reject(new Error("Claude Git fixture failed")));
          child.stdout.resume(); child.stderr.resume();
        });
      } }, logWarning() {} });
    await launcher.start({ provider: "claude", threadId: "11111111-1111-4111-8111-111111111111", streamId: "stream-b", projectRoot: root,
      collaborationMode: "default", modelId: "fixture", reasoningId: "low" }, [{ type: "text", text: "Synthetic Git work" }], []);
    assert.equal(await git("show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"), "Connected User <connected@example.invalid>|Connected User <connected@example.invalid>");
    const workspaces = new TaskGitWorkspaceService({ dataDir: path.join(f.directory, "hub-data"), recordTiming() {} });
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const managed = await workspaces.prepare({ taskId, taskNumber: "HUB-954", projectRoot: root });
    await writeFile(path.join(managed.projectRoot, "internal.txt"), "Owned Task snapshot\n");
    const saved = await workspaces.snapshot({ taskId, taskNumber: "HUB-954", projectRoot: managed.projectRoot });
    assert.equal(await runTaskGitCommand(["show", "-s", "--format=%an <%ae>|%cn <%ce>", saved.headCommit], { cwd: managed.projectRoot }),
      "Connected User <connected@example.invalid>|Connected User <connected@example.invalid>");
  } finally { if (prior === undefined) delete process.env.AGENT_HUB_GITHUB_DIRECTORY; else process.env.AGENT_HUB_GITHUB_DIRECTORY = prior; }
  assert.equal(await git("show", "-s", "--format=%an <%ae>", "HEAD"), "Connected User <connected@example.invalid>");
  assert.equal(await git("cat-file", "commit", historical), historicalObject);
  assert.ok(await git("config", "--global", "--list", "--show-origin") === globalBefore,
    "Global Git configuration changed; values are intentionally omitted from diagnostics");
  assert.equal(await git("config", "--local", "user.name"), "Repository Owner");
  // Existing persistent provider env reads the updated file, without restart.
  await f.service.disconnect();
  await execute("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "disconnected"], { cwd: root, env, windowsHide: true });
  assert.equal(await git("show", "-s", "--format=%an", "HEAD"), "Repository Owner");
});

test("gh receives credential only in its child, and echoed/chunked token is redacted", async t => {
  const f = await fixture(t);
  await f.service.connect(token);
  await writeFile(path.join(f.directory, "tools.json"), JSON.stringify({ gh: process.execPath }));
  const script = path.join(f.directory, "fake-gh.cjs");
  await writeFile(script, "const t=process.env.GH_TOKEN;process.stdout.write(t.slice(0,7));setTimeout(()=>{process.stdout.write(t.slice(7));process.stderr.write(t);},10);");
  const out = new PassThrough(), err = new PassThrough(), input = new PassThrough();
  let stdout = "", stderr = "";
  out.on("data", chunk => { stdout += chunk; }); err.on("data", chunk => { stderr += chunk; }); input.end();
  assert.equal(await runGitHubCli([script], { directory: f.directory, vault: f.vault, stdout: out, stderr: err, stdin: input }), 0);
  assert.equal(stdout, "[REDACTED]"); assert.equal(stderr, "[REDACTED]");
  await assert.rejects(runGitHubCli(["api", "--hostname", "foreign.invalid"], { directory: f.directory, vault: f.vault }), /limited/u);
  assert.notEqual(process.env.GH_TOKEN, token);
  await assert.rejects(runGitHubCli(["repo", "view", "foreign.ghe.com/owner/repo"], { directory: f.directory, vault: f.vault }), /limited/u);
  for (const operation of ["login", "logout", "setup-git", "token"]) {
    await assert.rejects(runGitHubCli(["auth", operation], { directory: f.directory, vault: f.vault }), /в Hub/u);
  }
});

test("late rejected old credential cannot clear a newer connection's rejection", async t => {
  const f = await fixture(t);
  await f.service.connect(token);
  const first = await f.vault.read();
  await f.service.connect(token);
  const second = await f.vault.read();
  await f.vault.reject(second.id);
  await f.vault.reject(first.id);
  assert.equal((await f.service.snapshot()).status, "expired");
  await f.service.connect(token);
  assert.equal((await f.service.snapshot()).status, "connected");
});

test("test/child runtime isolation removes only the inherited Hub account include and gh path", () => {
  const directory = path.join(os.tmpdir(), "isolated-hub-account");
  const original = { PATH: path.join(os.tmpdir(), "ordinary-tools"), GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.longpaths", GIT_CONFIG_VALUE_0: "true", GIT_DIR: "untrusted-redirect" };
  const provider = githubAgentEnvironment(original, directory);
  const isolated = withoutGithubAccountEnvironment(provider);
  assert.deepEqual(isolated, original);
  assert.equal(provider.AGENT_HUB_GITHUB_DIRECTORY, directory);
  const forged = { ...provider, GIT_CONFIG_VALUE_1: "foreign-config" };
  assert.equal(withoutGithubAccountEnvironment(forged).GIT_CONFIG_VALUE_1, "foreign-config");
});

test("new archive anchors use connected identity while retained DAG and original retry stay exact", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.service.connect(token);
  const source = path.join(f.directory, "archive-source");
  const dataDir = path.join(f.directory, "archive-data");
  await mkdir(source);
  const git = async (...args) => (await execute("git", args, { cwd: source, windowsHide: true })).stdout.trim();
  await git("init", "-b", "main");
  await writeFile(path.join(source, "original.txt"), "Original history\n");
  await git("add", ".");
  await git("-c", "user.name=Historical Owner", "-c", "user.email=historical@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "historical original");
  const original = await git("rev-parse", "HEAD"), body = await git("cat-file", "commit", original);
  const prior = process.env.AGENT_HUB_GITHUB_DIRECTORY;
  process.env.AGENT_HUB_GITHUB_DIRECTORY = f.directory;
  try {
    const store = new MaintenanceOperationStore({ dataDir });
    const objects = new OwnedNativeObjectStore({ dataDir, store,
      gitAt: (cwd, args, options) => runTaskGitCommand(args, { cwd, ...options }) });
    const input = { sourceRoot: source, binding: { fixture: "connected-account" },
      inventory: await inventoryNativeCapture(source), assertCurrent: async () => {} };
    const result = await objects.archive(input);
    const author = await runTaskGitCommand(["show", "-s", "--format=%an <%ae>", result.archive.commit], { cwd: objects.repository });
    assert.equal(author, "Connected User <connected@example.invalid>");
    assert.equal(await runTaskGitCommand(["cat-file", "commit", original], { cwd: objects.repository }), body);
    await f.service.disconnect();
    const retried = await objects.archive(input);
    assert.equal(retried.archive.commit, result.archive.commit);
    assert.equal(await git("cat-file", "commit", original), body);
  } finally { if (prior === undefined) delete process.env.AGENT_HUB_GITHUB_DIRECTORY; else process.env.AGENT_HUB_GITHUB_DIRECTORY = prior; }
});

test("actual Windows DPAPI protects credential bytes and round-trips only in current account", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const plain = Buffer.from(token);
  const encrypted = await windowsAccountCrypt(plain);
  assert.notDeepEqual(encrypted, plain);
  assert.equal(encrypted.includes(plain), false);
  assert.deepEqual(await windowsAccountCrypt(encrypted, true), plain);
});

test("native protected vault serves actual Git credential plumbing without token in profile/config/argv", { skip: process.platform !== "win32", timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const vault = new GitHubAccountVault({ directory: path.join(f.directory, "native-vault") });
  const service = await new GitHubAccountService({ directory: vault.directory, vault,
    fetchImpl: async url => url.endsWith("/user") ? Response.json({ id: 12, login: "native-account" }) : new Response("", { status: 403 }),
  }).initialize();
  await service.connect(token);
  const env = githubAgentEnvironment(process.env, vault.directory);
  for (const url of ["git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git",
    "ssh://git@github.com:22/owner/repo.git", "ssh://git@ssh.github.com:443/owner/repo.git"]) {
    const target = await execute("git", ["ls-remote", "--get-url", url], { env, windowsHide: true });
    assert.equal(target.stdout.trim(), "https://github.com/owner/repo.git");
  }
  const actual = await new Promise((resolve, reject) => {
    const child = execFile("git", ["credential", "fill"], { env, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error("Native Git credential fixture failed")); else resolve({ stdout, stderr });
    });
    child.stdin.end("protocol=https\nhost=github.com\n\n");
  });
  assert.equal(actual.stdout.includes(`password=${token}`), true);
  assert.equal(actual.stderr, "");
  assert.equal((await readFile(vault.profileFile, "utf8")).includes(token), false);
  assert.equal((await readFile(vault.file, "utf8")).includes(token), false);
  await service.disconnect();
});
