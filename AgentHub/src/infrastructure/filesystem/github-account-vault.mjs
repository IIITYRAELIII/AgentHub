import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { protectRuntimeDirectory } from "./runtime-security.mjs";
import { githubGitConfig, githubProfileSelection } from "./github-git-profile.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import { GitHubBrowserAuthorization } from "../network/github-browser-authorization.mjs";
import { githubOAuthExpiry, githubOAuthOpaque, githubOAuthRandom,
  githubOAuthRefreshPair, githubOAuthToken } from "../network/github-oauth-protocol.mjs";

const encrypted = value => typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
const reconnect = () => new Error("Переподключите GitHub-аккаунт");
const unavailable = () => new Error("Обновление авторизации GitHub пока недоступно. Повторите операцию позже.");

// Current-user DPAPI. Plaintext crosses private redirected stdin/stdout only;
// never a command argument, environment variable, diagnostic or shell source.
export function windowsAccountCrypt(value, decrypt = false) {
  if (process.platform !== "win32") throw new Error("GitHub secure storage requires Windows DPAPI");
  const script = "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; "
    + "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); "
    + "$r=[Security.Cryptography.ProtectedData]::" + (decrypt ? "Unprotect" : "Protect")
    + "($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
    + "[Console]::Write([Convert]::ToBase64String($r)) } catch { exit 1 }";
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("GitHub secure storage is unavailable")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(output.trim())) reject(new Error("GitHub secure storage is unavailable"));
      else resolve(Buffer.from(output.trim(), "base64"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(value).toString("base64"));
  });
}

export async function atomicAccountFile(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(value); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export class GitHubAccountVault {
  constructor({ directory, crypt = windowsAccountCrypt, protect = protectRuntimeDirectory, now = Date.now,
    authorization = new GitHubBrowserAuthorization({ now }) }) {
    this.directory = path.resolve(directory);
    this.profileFile = path.join(this.directory, "gitconfig");
    this.crypt = crypt;
    this.protect = protect;
    this.now = now;
    this.authorization = authorization;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.protect(this.directory);
  }
  async read() {
    try {
      const selected = await this.selection();
      if (!selected) return null;
      const body = await readFile(this.credentialFile(selected.id), "utf8");
      if (Buffer.byteLength(body) > 32_768) throw new Error();
      const row = JSON.parse(body);
      if (row.version !== 1 || !/^[0-9a-f-]{36}$/u.test(row.id) || !row.account?.login
        || !row.account.name || !row.account.email || !encrypted(row.secret)
        || row.expiresAt != null && !githubOAuthExpiry(row.expiresAt)
        || row.refreshSecret != null && (!encrypted(row.refreshSecret) || !githubOAuthExpiry(row.refreshExpiresAt)
          || !githubOAuthExpiry(row.expiresAt) || !/^[0-9a-f-]{36}$/u.test(row.generation ?? ""))
        || row.refreshAttempt != null && (!row.refreshSecret || !encrypted(row.refreshAttempt.verifier)
          || row.refreshAttempt.deadline !== row.refreshExpiresAt
          || row.refreshAttempt.uncertain != null && row.refreshAttempt.uncertain !== true)
        || row.id !== selected.id || JSON.stringify(row.account) !== JSON.stringify(selected.account)) throw new Error();
      return row;
    }
    catch { throw new Error("GitHub account storage cannot be read"); }
  }
  async selection() {
    try { return githubProfileSelection(await readFile(this.profileFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw new Error("GitHub account selection cannot be read"); }
  }
  credentialFile(id) {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("Invalid GitHub connection identity");
    return path.join(this.directory, `connection-${id}.json`);
  }
  async publish(row) {
    await atomicAccountFile(this.profileFile, githubGitConfig({ directory: this.directory, ...row }));
  }
  #rejectionFile(id) {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("Invalid GitHub connection identity");
    return path.join(this.directory, `rejected-${id}.json`);
  }
  async rejected(id, generation) {
    try {
      const marker = JSON.parse(await readFile(this.#rejectionFile(id), "utf8"));
      return marker.id === id && (marker.generation == null || marker.generation === generation);
    }
    catch (error) { if (error.code === "ENOENT") return false; throw new Error("GitHub authorization state cannot be read"); }
  }
  #withCredential(id, action) {
    return withInterprocessLocks([this.credentialFile(id)], action);
  }
  #markRejected({ id, generation }) {
    return atomicAccountFile(this.#rejectionFile(id), JSON.stringify({ id, generation }));
  }
  async reject(credential) {
    return this.#withCredential(credential.id, async lease => {
      const row = await this.read();
      if (row?.id === credential.id && row.secret === credential.secret) {
        // A request may cross the access token's expiry in flight. Use the
        // refresh exchange to distinguish that normal expiry from lost consent.
        if (this.#expired(row) && this.#canRefresh(row)) return;
        await lease.assertOwned();
        await this.#markRejected(row);
      }
    });
  }
  #seal(value) { return this.crypt(Buffer.from(value)).then(bytes => bytes.toString("base64")); }
  #unseal(value) { return this.crypt(Buffer.from(value, "base64"), true).then(bytes => bytes.toString("utf8")); }
  #expired(row) { return row.expiresAt != null && this.now() >= row.expiresAt; }
  #canRefresh(row) { return row.refreshSecret && this.now() < row.refreshExpiresAt; }
  async needsReconnect(row) {
    return await this.rejected(row.id, row.generation) || this.#expired(row)
      && (!this.#canRefresh(row) || row.refreshAttempt?.uncertain === true);
  }
  async access(row, { refresh = true } = {}) {
    if (!row?.id || !row.secret || await this.rejected(row.id, row.generation)) throw reconnect();
    if (!this.#expired(row)) return { row, token: await this.#unseal(row.secret) };
    if (!refresh || !this.#canRefresh(row)) throw reconnect();
    return this.#withCredential(row.id, async lease => {
      let current = await this.read();
      if (current?.id !== row.id || await this.needsReconnect(current)) throw reconnect();
      if (this.#expired(current)) current = await this.#refresh(current, lease);
      const token = await this.#unseal(current.secret);
      if ((await this.selection())?.id !== current.id) throw reconnect();
      return { row: current, token };
    });
  }
  async token(row) { return (await this.access(row)).token; }
  async #refresh(row, lease) {
    const file = this.credentialFile(row.id);
    let attempt = row.refreshAttempt;
    if (!attempt) {
      attempt = { verifier: await this.#seal(githubOAuthRandom()), deadline: row.refreshExpiresAt };
      await lease.assertOwned();
      await atomicAccountFile(file, JSON.stringify({ ...row, refreshAttempt: attempt }));
    }
    const verifier = await this.#unseal(attempt.verifier);
    if (!githubOAuthOpaque(verifier) || this.now() >= attempt.deadline || (await this.selection())?.id !== row.id) throw reconnect();
    await lease.assertOwned();
    const refreshToken = await this.#unseal(row.refreshSecret);
    if (!githubOAuthToken(refreshToken)) throw reconnect();
    const result = await this.authorization.refresh({ verifier, deadline: attempt.deadline, refreshToken }, { signal: lease.signal });
    if ((await this.selection())?.id !== row.id) throw reconnect();
    await lease.assertOwned();
    if (result.status === "reconnect") { await this.#markRejected(row); throw reconnect(); }
    if (result.status === "unknown") {
      await atomicAccountFile(file, JSON.stringify({ ...row, refreshAttempt: { ...attempt, uncertain: true } }));
      throw reconnect();
    }
    // Keep both credentials and the original receipt on an indeterminate
    // exchange. The provider may have consumed the old refresh token.
    if (result.status !== "refreshed" || !githubOAuthToken(result.token) || !githubOAuthRefreshPair(result)
        || result.refreshToken === refreshToken || result.expiresAt <= this.now() || result.refreshExpiresAt <= this.now()) throw unavailable();
    const current = await this.#credential({ id: row.id, account: row.account, ...result });
    await lease.assertOwned();
    if ((await this.selection())?.id !== row.id) throw reconnect();
    await atomicAccountFile(file, JSON.stringify(current));
    return current;
  }
  async #credential({ id, account, token, expiresAt = null, refreshToken, refreshExpiresAt }) {
    const secret = await this.#seal(token);
    const row = { version: 1, id, account, secret, ...(expiresAt == null ? {} : { expiresAt }) };
    if (refreshToken != null) {
      if (!githubOAuthRefreshPair({ refreshToken, refreshExpiresAt, expiresAt })) throw new Error("Неполная пара авторизации GitHub");
      Object.assign(row, { refreshSecret: await this.#seal(refreshToken), refreshExpiresAt, generation: randomUUID() });
    }
    return row;
  }
  async save({ id, account, token, expiresAt, refreshToken, refreshExpiresAt }) {
    const row = await this.#credential({ id, account, token, expiresAt, refreshToken, refreshExpiresAt });
    const handle = await open(this.credentialFile(id), "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(row)); await handle.sync(); }
    finally { await handle.close(); }
  }
  async remove(id) {
    return this.#withCredential(id, async lease => {
      if ((await this.selection())?.id === id) throw new Error("Cannot remove selected GitHub credential");
      await lease.assertOwned();
      await unlink(this.credentialFile(id)).catch(error => { if (error.code !== "ENOENT") throw error; });
    });
  }
}
