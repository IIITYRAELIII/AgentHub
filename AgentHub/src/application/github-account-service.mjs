import { randomUUID } from "node:crypto";
import { GitHubAccountVault } from "../infrastructure/filesystem/github-account-vault.mjs";
import { GitHubBrowserAuthorization } from "../infrastructure/network/github-browser-authorization.mjs";

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
  #login = null;
  constructor({ directory, vault = new GitHubAccountVault({ directory }), fetchImpl = fetch,
    authorization = new GitHubBrowserAuthorization({ fetchImpl }) } = {}) {
    this.vault = vault;
    this.fetch = fetchImpl;
    this.authorization = authorization;
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
  pause() { this.#paused = true; if (this.#login) { this.#login = null; ++this.#revision; } }
  resume() { if (!this.#disposed) this.#paused = false; }
  async drain() { await Promise.allSettled([...this.#pending]); }
  async dispose() { this.#disposed = true; this.pause(); await this.drain(); }
  async #profile(row) {
    try { await this.vault.publish(row); }
    catch {
      // Read back a possibly completed rename on the SAME connection identity.
      const selected = await this.vault.selection().catch(() => undefined);
      if (selected === undefined || (selected?.id ?? null) !== (row?.id ?? null)) {
        throw new Error("Не удалось сохранить GitHub-профиль. Проверьте подключение в Hub.");
      }
    }
  }
  async snapshot() {
    // Quiesced readback joins an admitted publication. Ordinary live reads
    // remain independent of the credential writer.
    if (this.#paused) await this.#writes;
    return this.#snapshot();
  }
  async #snapshot() {
    const row = await this.vault.read();
    const account = row ? { id: row.account.id, login: row.account.login, name: row.account.name, email: row.account.email } : null;
    return { status: !row ? "disconnected" : await this.vault.rejected(row.id)
      || row.expiresAt != null && Date.now() >= row.expiresAt ? "expired" : "connected", account };
  }
  startLogin() { return this.#admit(async () => {
    const revision = ++this.#revision;
    this.#login = null;
    const flow = await this.authorization.start();
    return this.#serialize(async () => {
      if (revision !== this.#revision || this.#paused) throw new Error("Вход GitHub заменён более новым действием");
      const attemptId = randomUUID();
      this.#login = { attemptId, revision, flow, pending: null };
      return { githubAccount: await this.#snapshot(), login: { attemptId, authorizationUrl: flow.authorizationUrl,
        expiresAt: flow.expiresAt, waitMs: flow.intervalMs } };
    });
  }); }
  pollLogin(attemptId) { return this.#admit(async () => {
    const login = this.#login;
    if (!login || login.attemptId !== attemptId) throw new Error("Вход GitHub уже завершён или заменён");
    if (!login.pending) login.pending = (async () => {
      let keep = false;
      try {
        const result = await this.authorization.poll(login.flow);
        if (this.#login !== login || login.revision !== this.#revision || this.#paused) throw new Error("Вход GitHub заменён более новым действием");
        if (result.status === "pending") {
          keep = true;
          return { githubAccount: await this.snapshot(), login: { status: "pending", waitMs: result.waitMs } };
        }
        if (result.status === "authorized") {
          await this.#connect(result.token, { revision: login.revision, expiresAt: result.expiresAt });
          return { githubAccount: await this.snapshot(), login: { status: "connected" } };
        }
        return { githubAccount: await this.snapshot(), login: { status: result.status, message: result.message } };
      } finally { if (!keep && this.#login === login) this.#login = null; }
    })();
    try { return await login.pending; }
    finally { login.pending = null; }
  }); }
  cancelLogin(attemptId) { return this.#admit(async () => {
    if (this.#login?.attemptId === attemptId) { ++this.#revision; this.#login = null; }
    // Invalidate immediately, then join the actual winner through publication,
    // durable readback and cleanup before acknowledging the selected account.
    return this.#serialize(async () => ({ githubAccount: await this.#snapshot() }));
  }); }
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
  async #connect(token, { revision = null, expiresAt = null } = {}) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_]{20,255}$/u.test(token)) throw new Error("Укажите GitHub personal access token");
    revision ??= ++this.#revision;
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
      const previous = await this.vault.selection();
      if (revision !== this.#revision) throw new Error("Подключение GitHub заменено более новым действием");
      const id = randomUUID();
      await this.vault.save({ id, account, token, expiresAt });
      try {
        if (revision !== this.#revision) throw new Error("Подключение GitHub заменено более новым действием");
        // Cancellation/replacement replies join this existing serialized
        // section; a rename already in flight cannot silently outlive them.
        await this.#profile({ id, account });
      }
      catch (error) { await this.vault.remove(id).catch(() => {}); throw error; }
      if (previous?.id) {
        try { await this.vault.remove(previous.id); }
        catch { throw new Error("GitHub подключён. Предыдущие зашифрованные данные сохранены: их удаление не завершено."); }
      }
      return this.#snapshot();
    });
  }
  disconnect() { return this.#admit(() => this.#disconnect()); }
  async #disconnect() {
    ++this.#revision;
    this.#login = null;
    return this.#serialize(async () => {
      const previous = await this.vault.selection();
      await this.#profile(null);
      if (previous?.id) {
        try { await this.vault.remove(previous.id); }
        catch { throw new Error("GitHub отключён. Зашифрованные данные сохранены: их удаление не завершено."); }
      }
      return this.#snapshot();
    });
  }
  async request(pathname, options = {}) {
    const row = await this.vault.read();
    if (!row) throw new Error("Подключите GitHub-аккаунт");
    try { return await this.#request(pathname, await this.vault.token(row), options); }
    catch (error) { if (error.status === 401) await this.vault.reject(row.id); throw error; }
  }
}
