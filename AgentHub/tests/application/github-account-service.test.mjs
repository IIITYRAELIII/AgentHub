import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
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
import { githubAccountFetch } from "../../src/infrastructure/network/github-account-request.mjs";
import { githubInvocation } from "../../src/infrastructure/process/github-gh-arguments.mjs";

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
  assert.equal((await readFile(f.vault.credentialFile((await f.vault.read()).id), "utf8")).includes(token), false);
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

test("atomic selection failure preserves the same account, credential and Git profile", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await f.service.connect(token);
  const original = await f.vault.read();
  const profile = await readFile(f.vault.profileFile);
  // Actual Windows filesystem refusal: saving an immutable new credential is
  // possible, replacing the read-only selected profile is not.
  await chmod(f.vault.profileFile, 0o444);
  try {
    await assert.rejects(f.service.connect(token));
    assert.equal((await f.vault.read()).id, original.id);
    assert.deepEqual(await readFile(f.vault.profileFile), profile);
    assert.equal(await f.vault.token(await f.vault.read()) === token, true);
    await assert.rejects(f.service.disconnect());
    assert.equal((await f.vault.read()).id, original.id);
    assert.equal((await f.service.snapshot()).status, "connected");
  } finally { await chmod(f.vault.profileFile, 0o600); }
  await f.service.disconnect();
  assert.equal(await f.vault.read(), null);
  await assert.rejects(readFile(f.vault.credentialFile(original.id)), error => error.code === "ENOENT");
});

test("same atomic connection readback resolves only an already published profile after lost write acknowledgement", async t => {
  const f = await fixture(t);
  const publish = f.vault.publish.bind(f.vault);
  f.vault.publish = async row => { await publish(row); throw new Error("Synthetic lost write acknowledgement"); };
  assert.equal((await f.service.connect(token)).status, "connected");
  const first = (await f.vault.read()).id;
  const reopened = await new GitHubAccountService({ directory: f.directory, vault: f.vault }).initialize();
  assert.equal((await reopened.snapshot()).status, "connected");
  assert.equal((await f.vault.read()).id, first);
  assert.equal((await f.service.connect(token)).status, "connected");
  assert.notEqual((await f.vault.read()).id, first);
  await assert.rejects(readFile(f.vault.credentialFile(first)), error => error.code === "ENOENT");
  assert.equal((await f.service.disconnect()).status, "disconnected");
  f.vault.publish = async () => { throw new Error("Synthetic write refused before publication"); };
  await assert.rejects(f.service.connect(token), /сохранить GitHub-профиль/u);
  assert.equal(await f.vault.read(), null);
});

test("selected credential loss or mismatched account refuses initialization without substituting a connection", async t => {
  const f = await fixture(t);
  await f.service.connect(token);
  const row = await f.vault.read(), file = f.vault.credentialFile(row.id);
  const saved = await readFile(file);
  await writeFile(file, JSON.stringify({ ...row, account: { ...row.account, id: row.account.id + 1 } }));
  await assert.rejects(f.service.snapshot(), /storage cannot be read/u);
  await assert.rejects(new GitHubAccountService({ directory: f.directory, vault: f.vault }).initialize(), /storage cannot be read/u);
  await rm(file);
  await assert.rejects(f.vault.read(), /storage cannot be read/u);
  await writeFile(file, saved);
  assert.equal((await f.service.snapshot()).status, "connected");
});

test("credential cleanup refusal reports the committed connection or disconnection without changing its selection", async t => {
  const f = await fixture(t);
  await f.service.connect(token);
  const first = (await f.vault.read()).id;
  const remove = f.vault.remove.bind(f.vault);
  f.vault.remove = async () => { throw new Error("Synthetic encrypted credential cleanup refusal"); };
  await assert.rejects(f.service.connect(token), /GitHub подключён.*зашифрованные данные сохранены/u);
  const second = (await f.vault.read()).id;
  assert.notEqual(second, first);
  assert.equal((await f.vault.selection()).id, second);
  assert.equal((await f.service.snapshot()).status, "connected");
  assert.equal((await readFile(f.vault.credentialFile(first))).length > 0, true);
  await assert.rejects(f.service.disconnect(), /GitHub отключён.*Зашифрованные данные сохранены/u);
  assert.equal(await f.vault.read(), null);
  assert.equal((await readFile(f.vault.credentialFile(second))).length > 0, true);
  f.vault.remove = remove;
  await remove(first); await remove(second);
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
  await f.vault.reject(second);
  await f.vault.reject(first);
  assert.equal((await f.service.snapshot()).status, "expired");
  await f.service.connect(token);
  assert.equal((await f.service.snapshot()).status, "connected");
});

async function ghContentFixture(t) {
  const f = await fixture(t);
  await f.service.connect(token);
  await writeFile(path.join(f.directory, "tools.json"), JSON.stringify({ gh: process.execPath }));
  const script = path.join(f.directory, "gh-content.cjs");
  await writeFile(script, "if(!process.env.GH_TOKEN?.startsWith('github_pat_SYNTHETIC'))process.exit(7);process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  let starts = 0;
  return { starts: () => starts, run: async (args, environment = process.env) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    let output = "";
    stdin.end(); stdout.on("data", chunk => { output += chunk; }); stderr.resume();
    const code = await runGitHubCli(args, { directory: f.directory, vault: f.vault, environment, stdin, stdout, stderr,
      spawnProcess: (executable, actualArgs, options) => { starts++; return spawn(executable, [script, ...actualArgs], options); } });
    return { code, args: JSON.parse(output) };
  } };
}

test("gh content URLs remain exact body, notes, title, formatting and query payloads", async t => {
  const f = await ghContentFixture(t);
  const commands = [
    ["issue", "create", "--repo", "owner/repo", "--body", "https://example.org/docs", "--title", "foreign.ghe.com/owner/repo"],
    ["issue", "create", "--repo=github.com/owner/repo", "--body=https://example.org/docs"],
    ["issue", "create", "-Rowner/repo", "-b", "https://example.org/docs", "-t", "https://example.org/title"],
    ["issue", "create", "--body", "--hostname", "--repo", "owner/repo"],
    ["release", "create", "v-fixture", "--repo", "owner/repo", "--notes", "https://example.org/notes", "--title", "foreign.ghe.com/owner/repo"],
    ["release", "create", "-d", "-p", "v-fixture", "--repo=owner/repo", "--notes=https://example.org/notes"],
    ["release", "new", "v-fixture", "-R", "owner/repo", "-n", "https://example.org/notes", "-F", "foreign.ghe.com/notes/file"],
    ["release", "edit", "v-fixture", "--notes", "--repo=foreign.ghe.com/owner/repo", "--repo", "owner/repo"],
    ["issue", "comment", "https://github.com/owner/repo/issues/1", "--body", "https://example.org/docs"],
    ["pr", "review", "https://github.com/owner/repo/pull/1", "--comment", "--body", "https://example.org/docs"],
    ["api", "--raw-field", "body=https://example.org/docs", "--method", "POST", "repos/owner/repo/issues"],
    ["api", "https://api.github.com/user", "--template", "https://example.org/format"],
    ["search", "issues", "https://example.org/docs"],
    ["repo", "create", "owner/repo", "--description", "https://example.org/docs", "--homepage", "https://example.org"],
    ["repo", "view", "--json", "name", "https://github.com/owner/repo"],
    ["issue", "close", "-c", "https://example.org/docs", "123", "--repo", "owner/repo"],
    ["issue", "close", "--comment=https://example.org/docs", "123", "--repo", "owner/repo"],
    ["issue", "close", "-chttps://example.org/docs", "123", "--repo", "owner/repo"],
    ["issue", "close", "-c=https://example.org/docs", "123", "--repo", "owner/repo"],
    ["issue", "close", "-c=", "123", "--repo", "owner/repo"],
    ["repo", "view", "-b", "main", "https://github.com/owner/repo"],
    ["repo", "view", "-bmain", "https://github.com/owner/repo"],
    ["repo", "view", "-wbmain", "https://github.com/owner/repo"],
    ["pr", "diff", "--color", "always", "https://github.com/owner/repo/pull/1"],
    ["pr", "diff", "--color=always", "https://github.com/owner/repo/pull/1"],
    ["pr", "co", "https://github.com/owner/repo/pull/1"],
    ["repo", "new", "owner/repo", "--template", "github.com/template/project", "--description", "https://example.org/docs"],
    ["repo", "deploy-key", "add", "foreign.ghe.com/local/key.pub"],
    ["release", "create", "v-fixture", "foreign.ghe.com/local/archive.zip", "--notes", "https://example.org/docs"],
    ["cache", "delete", "--succeed-on-no-caches", "--repo", "owner/repo", "--all"],
    ["browse", "--commit", "--repo", "owner/repo"],
    ["browse", "-c=Rforeign.ghe.com/owner/repo", "--repo", "owner/repo"],
  ];
  for (const args of commands) {
    const result = await f.run(args);
    assert.equal(result.code, 0);
    assert.deepEqual(result.args, args);
  }
  assert.equal(f.starts(), commands.length);
});

test("gh destination host controls still reject actual foreign selectors and positional resources before spawn", async t => {
  const f = await ghContentFixture(t);
  for (const args of [
    ["api", "--hostname", "foreign.invalid", "user"],
    ["api", "--hostname=foreign.invalid", "user"],
    ["issue", "create", "--body", "https://example.org/docs", "--repo", "foreign.ghe.com/owner/repo"],
    ["issue", "create", "-Rforeign.ghe.com/owner/repo", "-b", "https://example.org/docs"],
    ["release", "create", "-d", "-p", "--hostname", "foreign.invalid", "v-fixture"],
    ["repo", "view", "--web", "foreign.ghe.com/owner/repo"],
    ["repo", "clone", "https://foreign.invalid/owner/repo"],
    ["issue", "view", "https://foreign.invalid/owner/repo/issues/1"],
    ["pr", "review", "-a", "https://foreign.invalid/owner/repo/pull/1"],
    ["pr", "review", "--comment", "https://foreign.invalid/owner/repo/pull/1"],
    ["repo", "view", "--repo=foreign.ghe.com/owner/repo"],
    ["api", "--field", "body=ordinary", "https://foreign.invalid/user"],
    ["repo", "view", "-b", "main", "https://foreign.ghe.com/owner/repo"],
    ["repo", "view", "-b=main", "https://foreign.ghe.com/owner/repo"],
    ["repo", "view", "-wbmain", "https://foreign.ghe.com/owner/repo"],
    ["issue", "close", "-c", "Closing", "https://foreign.ghe.com/owner/repo/issues/1"],
    ["issue", "close", "--comment=Closing", "https://foreign.ghe.com/owner/repo/issues/1"],
    ["issue", "close", "-cClosing", "https://foreign.ghe.com/owner/repo/issues/1"],
    ["issue", "close", "-c=", "https://foreign.ghe.com/owner/repo/issues/1"],
    ["pr", "diff", "--color", "always", "https://foreign.ghe.com/owner/repo/pull/1"],
    ["pr", "diff", "--color=always", "https://foreign.ghe.com/owner/repo/pull/1"],
    ["pr", "co", "https://foreign.ghe.com/owner/repo/pull/1"],
    ["repo", "sync", "--source", "foreign.ghe.com/owner/repo"],
    ["repo", "create", "owner/repo", "--template=https://foreign.ghe.com/owner/repo"],
    ["issue", "develop", "123", "--branch-repo", "foreign.ghe.com/owner/repo"],
    ["extension", "install", "https://foreign.ghe.com/owner/repo"],
    ["cache", "delete", "--succeed-on-no-caches", "--repo", "foreign.ghe.com/owner/repo", "--all"],
    ["cache", "delete", "--succeed-on-no-caches", "-Rforeign.ghe.com/owner/repo", "--all"],
    ["cache", "delete", "--succeed-on-no-caches=true", "--repo", "foreign.ghe.com/owner/repo", "--all"],
    ["browse", "--commit", "--repo", "foreign.ghe.com/owner/repo"],
    ["browse", "-c", "-Rforeign.ghe.com/owner/repo"],
  ]) await assert.rejects(f.run(args), /limited to github.com/u);
  await assert.rejects(f.run(["api", "user"], { ...process.env, GH_HOST: "foreign.invalid" }), /limited to github.com/u);
  await assert.rejects(f.run(["issue", "list"], { ...process.env, GH_REPO: "foreign.ghe.com/owner/repo" }), /limited to github.com/u);
  assert.equal(f.starts(), 0);
});

test("gh option arity follows actual pflag consumption and NoOptDefVal rather than rendered help", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-gh-arity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = withoutGithubAccountEnvironment(process.env);
  for (const key of Object.keys(env)) if (/^(?:GH|GITHUB)_(?:ENTERPRISE_)?TOKEN$/iu.test(key)
    || /^GIT_CONFIG/iu.test(key) || ["GH_DEBUG", "DEBUG", "GH_HOST", "GH_REPO"].includes(key)) delete env[key];
  const gitConfig = path.join(directory, "gitconfig");
  await writeFile(gitConfig, "");
  Object.assign(env, { GH_CONFIG_DIR: path.join(directory, "gh"), HOME: directory, USERPROFILE: directory,
    XDG_CONFIG_HOME: directory, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", GH_PROMPT_DISABLED: "1", GH_ACTIVE_HELP: "0" });
  let reference;
  try { reference = (await execute("gh", ["help", "reference"], { cwd: directory, env, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout; }
  catch (error) { if (error.code === "ENOENT") { t.skip("GitHub CLI is not installed; its command metadata cannot be checked"); return; } throw error; }
  let command;
  const declarations = [];
  for (const line of reference.split(/\r?\n/u)) {
    const heading = line.match(/^#{2,} gh ([a-z0-9][a-z0-9-]*(?: [a-z0-9][a-z0-9-]*)*)/u);
    if (heading) { command = heading[1].split(" "); continue; }
    // Help supplies only names. Nothing after the long name determines arity.
    const flag = line.match(/^  (?:(-[A-Za-z0-9?]), *)? *(--[A-Za-z0-9-]+)/u);
    if (command && flag) declarations.push({ command, short: flag[1], long: flag[2] });
  }
  let next = 0, probes = 0;
  const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (next < declarations.length) {
      const { command, short, long } = declarations[next++];
      // gh copilot disables pflag parsing; --remove is a decorative Bool in
      // exact upstream source. Do not launch/probe the delegated Copilot CLI.
      if (command.join(" ") === "copilot") {
        assert.equal(long, "--remove");
        assert.deepEqual(githubInvocation([...command, long, "content", "resource-sentinel"]).operands, ["content", "resource-sentinel"]);
        continue;
      }
      const first = "--__hub254_arity_value", last = "--__hub254_arity_stop";
      const { stderr } = await execute("gh", ["__complete", ...command, long, first, last, ""],
        { cwd: directory, env, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
      // Cobra returns at this ParseFlags failure, before RunE/custom completion.
      // A required value consumes first; NoOptDefVal leaves it as the error.
      assert.match(stderr, /Error while parsing flags from args /u);
      const noNext = stderr.includes("unknown flag: " + first);
      assert.ok(noNext || stderr.includes("unknown flag: " + last)
        || stderr.includes('invalid argument "' + first + '" for '), "Arity probe did not reach either exact parser marker");
      for (const name of [short, long].filter(Boolean)) {
        const value = "https://example.org/opaque-content", target = "resource-sentinel";
        assert.deepEqual(githubInvocation([...command, name, value, target]).operands,
          noNext ? [value, target] : [target], `Actual arity ${command.join(" ")} ${name}`);
        for (const argv of [[...command, name + "=" + value, target], [...command, name + "=", target],
          ...(!noNext && short === name ? [[...command, name + value, target]] : [])]) {
          assert.deepEqual(githubInvocation(argv).operands, [target], `Explicit value ${command.join(" ")} ${name}`);
        }
      }
      probes++;
    }
  }));
  for (const result of workers) if (result.status === "rejected") throw result.reason;
  assert.ok(probes > 500, "Full built-in parser declaration set was not checked");
  t.diagnostic(`Actual compiled pflag probes ${probes}; help only supplied names, not types or arity`);
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
  assert.equal((await readFile(vault.credentialFile((await vault.read()).id), "utf8")).includes(token), false);
  const originalFetch = globalThis.fetch, originalDirectory = process.env.AGENT_HUB_GITHUB_DIRECTORY;
  let apiCalls = 0;
  try {
    process.env.AGENT_HUB_GITHUB_DIRECTORY = vault.directory;
    globalThis.fetch = async (url, options) => {
      apiCalls++;
      assert.equal(url, "https://api.github.com/repos/owner/private");
      assert.equal(options.headers.Authorization === `Bearer ${token}`, true);
      return Response.json({ accountAuthorized: true });
    };
    assert.deepEqual(await (await githubAccountFetch("https://api.github.com/repos/owner/private")).json(), { accountAuthorized: true });
    await assert.rejects(githubAccountFetch("https://foreign.invalid/repos/owner/private"), /origin/u);
    assert.equal(apiCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDirectory === undefined) delete process.env.AGENT_HUB_GITHUB_DIRECTORY;
    else process.env.AGENT_HUB_GITHUB_DIRECTORY = originalDirectory;
  }
  await service.disconnect();
});
