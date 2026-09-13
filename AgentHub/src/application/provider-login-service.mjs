/**
 * Official sign-in of the shared Codex and Claude accounts from the Server page.
 *
 * Hub only starts the provider-owned flow and tracks its state. Codex keeps the
 * credentials inside its App Server (`account/login/*`), Claude inside its CLI
 * config directory (`claude auth login`). Hub never reads, stores or logs tokens,
 * so a successful sign-in applies to new requests without restarting Hub, and
 * running turns keep their existing process.
 */
export const PROVIDER_LOGIN_PROVIDERS = Object.freeze(["codex", "claude"]);

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_ERROR_LENGTH = 300;
const MAX_URL_SCAN_BYTES = 64 * 1024;

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function boundedError(value) {
  const text = String(value?.message ?? value ?? "").trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

function firstHttpsUrl(text) {
  const match = /https:\/\/[^\s"'<>]+/u.exec(String(text ?? ""));
  return match ? match[0].replace(/[).,;]+$/u, "") : "";
}

function normalizedProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!PROVIDER_LOGIN_PROVIDERS.includes(provider)) throw new Error("Неизвестный провайдер входа");
  return provider;
}

export class ProviderLoginService {
  #d;
  #states = new Map();
  #attempt = 0;

  constructor({
    sendRpc,
    resolveClaudeInvocation,
    spawnProcess,
    stopProcessTree,
    readClaudeLoggedIn,
    onAccountChanged = async () => {},
    timers = { setTimeout, clearTimeout },
    clock = () => Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger = console,
  } = {}) {
    this.#d = {
      sendRpc: requiredFunction(sendRpc, "sendRpc"),
      resolveClaudeInvocation: requiredFunction(resolveClaudeInvocation, "resolveClaudeInvocation"),
      spawnProcess: requiredFunction(spawnProcess, "spawnProcess"),
      stopProcessTree: requiredFunction(stopProcessTree, "stopProcessTree"),
      readClaudeLoggedIn: requiredFunction(readClaudeLoggedIn, "readClaudeLoggedIn"),
      onAccountChanged,
      timers,
      clock,
      timeoutMs,
      logger,
    };
    for (const provider of PROVIDER_LOGIN_PROVIDERS) this.#states.set(provider, { provider, status: "idle" });
  }

  snapshot() {
    return PROVIDER_LOGIN_PROVIDERS.map((provider) => {
      const state = this.#states.get(provider);
      return {
        provider,
        status: state.status,
        authUrl: state.status === "pending" ? state.authUrl || null : null,
        startedAt: state.startedAt ?? null,
        finishedAt: state.finishedAt ?? null,
        error: state.error || null,
      };
    });
  }

  entry(provider) {
    return this.snapshot().find((item) => item.provider === normalizedProvider(provider));
  }

  /** Starts a sign-in; an unfinished sign-in of the same provider is cancelled first. */
  async start(providerName) {
    const provider = normalizedProvider(providerName);
    await this.#cancelPending(provider, "superseded");
    const attempt = ++this.#attempt;
    const state = { provider, status: "pending", attempt, startedAt: new Date(this.#d.clock()).toISOString() };
    this.#states.set(provider, state);
    try {
      if (provider === "codex") await this.#startCodex(state);
      else this.#startClaude(state);
    } catch (error) {
      this.#finish(state, "failed", error);
      throw error;
    }
    if (this.#isCurrent(state)) {
      state.timer = this.#d.timers.setTimeout(() => {
        void this.#cancelPending(provider, "timeout", attempt);
      }, this.#d.timeoutMs);
      state.timer?.unref?.();
    }
    return this.entry(provider);
  }

  async cancel(providerName) {
    const provider = normalizedProvider(providerName);
    await this.#cancelPending(provider, "cancelled");
    return this.entry(provider);
  }

  /** Receives every Codex App Server message; never throws into the event pipeline. */
  observeCodexMessage(message) {
    const method = message?.method;
    if (method !== "account/login/completed" && method !== "account/updated") return;
    if (method === "account/updated") {
      this.#notifyAccountChanged("codex");
      return;
    }
    const params = message.params ?? {};
    const state = this.#states.get("codex");
    if (state.status !== "pending") return;
    if (params.loginId && state.loginId && params.loginId !== state.loginId) return;
    if (params.success === true) {
      this.#finish(state, "succeeded");
      this.#notifyAccountChanged("codex");
    } else {
      this.#finish(state, "failed", params.error || "Вход Codex не завершён");
    }
  }

  async stop() {
    for (const provider of PROVIDER_LOGIN_PROVIDERS) await this.#cancelPending(provider, "cancelled");
  }

  async #startCodex(state) {
    const result = await this.#d.sendRpc("account/login/start", { type: "chatgpt" }, { timeoutMs: 15_000 });
    const loginId = String(result?.loginId ?? "").trim();
    const authUrl = String(result?.authUrl ?? "").trim();
    if (!loginId || !/^https:\/\//u.test(authUrl)) throw new Error("Codex App Server не вернул ссылку входа");
    state.loginId = loginId;
    state.authUrl = authUrl;
  }

  #startClaude(state) {
    const invocation = this.#d.resolveClaudeInvocation();
    const worker = this.#d.spawnProcess(invocation.command, [...(invocation.prefixArgs ?? []), "auth", "login"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.worker = worker;
    let scanned = 0;
    const scan = (chunk) => {
      if (state.authUrl || scanned >= MAX_URL_SCAN_BYTES || !this.#isCurrent(state)) return;
      const text = String(chunk ?? "");
      scanned += Buffer.byteLength(text, "utf8");
      state.authUrl = firstHttpsUrl(text);
    };
    worker.stdout?.setEncoding?.("utf8");
    worker.stderr?.setEncoding?.("utf8");
    worker.stdout?.on("data", scan);
    worker.stderr?.on("data", scan);
    worker.on("error", (error) => {
      if (this.#isCurrent(state)) this.#finish(state, "failed", error);
    });
    worker.on("close", (code) => {
      if (!this.#isCurrent(state)) return;
      if (code !== 0) {
        this.#finish(state, "failed", `Claude Code завершился с кодом ${code}`);
        return;
      }
      void this.#d.readClaudeLoggedIn().then((loggedIn) => {
        if (!this.#isCurrent(state)) return;
        if (loggedIn) {
          this.#finish(state, "succeeded");
          this.#notifyAccountChanged("claude");
        } else {
          this.#finish(state, "failed", "Claude Code не подтвердил вход");
        }
      }, (error) => {
        if (this.#isCurrent(state)) this.#finish(state, "failed", error);
      });
    });
  }

  #isCurrent(state) {
    const current = this.#states.get(state.provider);
    return current === state && current.status === "pending";
  }

  async #cancelPending(provider, reason, attempt = null) {
    const state = this.#states.get(provider);
    if (state.status !== "pending" || (attempt !== null && state.attempt !== attempt)) return;
    if (reason === "timeout") this.#finish(state, "failed", "Время ожидания входа истекло");
    else this.#finish(state, "cancelled");
    if (provider === "codex" && state.loginId) {
      try {
        await this.#d.sendRpc("account/login/cancel", { loginId: state.loginId }, { timeoutMs: 5_000 });
      } catch (error) {
        this.#d.logger.error?.("Cannot cancel Codex sign-in:", boundedError(error));
      }
    }
    if (provider === "claude" && state.worker) {
      const worker = state.worker;
      try {
        const stopped = await this.#d.stopProcessTree(worker.pid);
        if (!stopped) worker.kill?.();
      } catch {
        worker.kill?.();
      }
    }
  }

  #finish(state, status, error = null) {
    state.status = status;
    state.finishedAt = new Date(this.#d.clock()).toISOString();
    state.error = error ? boundedError(error) : "";
    state.authUrl = "";
    if (state.timer) this.#d.timers.clearTimeout(state.timer);
    state.timer = null;
  }

  #notifyAccountChanged(provider) {
    Promise.resolve()
      .then(() => this.#d.onAccountChanged(provider))
      .catch((error) => this.#d.logger.error?.(`Cannot refresh ${provider} account:`, boundedError(error)));
  }
}
