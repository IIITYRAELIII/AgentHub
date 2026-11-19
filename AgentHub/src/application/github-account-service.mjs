import { randomUUID } from "node:crypto";
import { GitHubAccountVault, atomicAccountFile } from "../infrastructure/filesystem/github-account-vault.mjs";
import { githubGitConfig } from "../infrastructure/filesystem/github-git-profile.mjs";

const safeText = (value, name) => {
  const text = String(value ?? "").trim();
  if (!text || text.length > 1024 || /[\x00-\x1f\x7f<>]/u.test(text)) throw new Error(`GitHub returned an invalid ${name}`);
  return text;
};
export class GitHubAccountService {
  #revision = 0;
  #writes = Promise.resolve();
  #pending = new Set();
  #paused = false;
  #disposed = false;
  constructor({ directory, vault = new GitHubAccountVault({ directory }), fetchImpl = fetch } = {}) {
    this.vault = vault;
    this.fetch = fetchImpl;
  }
  async initialize() {
    await this.vault.initialize();
    const row = await this.vault.read();
    await this.#profile(row);
    return this;
  }
  #serialize(action) {
    const result = this.#writes.then(action);
    this.#writes = result.catch(() => {});
    return result;
  }
  #admit(action) {
    if (this.#paused || this.#disposed) return Promise.reject(new Error("Подключение GitHub временно недоступно во время остановки Hub"));
    const result = action();
    this.#pending.add(result);
    result.then(() => this.#pending.delete(result), () => this.#pending.delete(result));
    return result;
  }
  pause() { this.#paused = true; }
  resume() { if (!this.#disposed) this.#paused = false; }
  async drain() { await Promise.allSettled([...this.#pending]); }
  async dispose() { this.#disposed = true; this.pause(); await this.drain(); }
  async #profile(row) {
    await atomicAccountFile(this.vault.profileFile, githubGitConfig({ directory: this.vault.directory, ...row }));
  }
  async snapshot() {
    const row = await this.vault.read();
    const account = row ? { id: row.account.id, login: row.account.login, name: row.account.name, email: row.account.email } : null;
    return { status: !row ? "disconnected" : await this.vault.rejected(row.id) ? "expired" : "connected", account };
  }
  async #request(pathname, token, options = {}) {
    if (!/^\/(?!\/)/u.test(pathname)) throw new Error("GitHub API requires a relative path");
    let response;
    try {
      response = await this.fetch(`https://api.github.com${pathname}`, { ...options, redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(30_000),
        headers: { Accept: "application/vnd.github+json", "User-Agent": "AgentHub", "X-GitHub-Api-Version": "2022-11-28",
          ...options.headers, Authorization: `Bearer ${token}` } });
    } catch { throw new Error("Не удалось связаться с GitHub"); }
    if (!response.ok) {
      const error = new Error(response.status === 401 ? "Авторизация GitHub истекла. Переподключите аккаунт."
        : `GitHub отказал в операции (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response;
  }
  async #json(pathname, token) {
    const response = await this.#request(pathname, token);
    try {
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error(); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    } catch { throw new Error("GitHub returned an unreadable account response"); }
  }
  connect(token) { return this.#admit(() => this.#connect(token)); }
  async #connect(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_]{20,255}$/u.test(token)) throw new Error("Укажите GitHub personal access token");
    const revision = ++this.#revision;
    const user = await this.#json("/user", token);
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || !/^[A-Za-z0-9-]{1,39}$/u.test(user.login)) throw new Error("GitHub returned an invalid account");
    let email = `${user.id}+${user.login}@users.noreply.github.com`;
    // Email scope is optional; the authenticated numeric account's GitHub
    // noreply address works with fine-grained tokens that cannot list emails.
    try {
      const emails = await this.#json("/user/emails", token);
      const primary = Array.isArray(emails) && emails.find(item => item.primary === true && item.verified === true);
      if (primary && typeof primary.email === "string" && primary.email.length <= 254
        && /^[^\s@<>]+@[^\s@<>]+$/u.test(primary.email)) email = primary.email;
    } catch (error) { if (![403, 404].includes(error.status)) throw error; }
    const displayName = String(user.name ?? "").trim();
    const name = displayName && displayName.length <= 200 && !/[\x00-\x1f\x7f<>]/u.test(displayName) ? displayName : user.login;
    const account = { id: user.id, login: user.login, name: safeText(name, "name"), email: safeText(email, "email") };
    if (!/^[^\s@]+@[^\s@]+$/u.test(account.email)) throw new Error("GitHub returned an invalid email");
    return this.#serialize(async () => {
      if (revision !== this.#revision) throw new Error("Подключение GitHub заменено более новым действием");
      const id = randomUUID();
      await this.vault.save({ id, account, token });
      await this.#profile({ id, account });
      return this.snapshot();
    });
  }
  disconnect() { return this.#admit(() => this.#disconnect()); }
  async #disconnect() {
    ++this.#revision;
    return this.#serialize(async () => {
      await this.vault.remove();
      await this.#profile(null);
      return this.snapshot();
    });
  }
  async request(pathname, options = {}) {
    const row = await this.vault.read();
    if (!row) throw new Error("Подключите GitHub-аккаунт");
    try { return await this.#request(pathname, await this.vault.token(row), options); }
    catch (error) { if (error.status === 401) await this.vault.reject(row.id); throw error; }
  }
}
