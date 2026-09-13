/**
 * Official sign-in of the shared Codex and Claude accounts from the Server page.
 *
 * Hub only starts the provider-owned flow and tracks its state. Codex keeps the
 * credentials inside its App Server (`account/login/*`), Claude inside its CLI
 * config directory (`claude auth login`). Hub never reads, stores or logs tokens,
 * so a successful sign-in applies to new requests without restarting Hub, and
 * running turns keep their existing process.
 *
 * The Codex sign-in link is returned only to the local caller that started the
 * flow; snapshots carry state without it. Claude opens the browser itself with
 * its localhost callback. The link it prints is the manual-code fallback, which
 * needs the code typed back into the CLI, so Hub does not surface it.
 */
export const PROVIDER_LOGIN_PROVIDERS = Object.freeze(["codex", "claude"]);

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_ERROR_LENGTH = 300;

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function boundedError(value) {
  const text = String(value?.message ?? value ?? "").trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

function normalizedProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!PROVIDER_LOGIN_PROVIDERS.includes(provider)) throw new Error("Неизвестный провайдер входа");
  return provider;
}

export class ProviderLoginService {
  #d;
  #states = new Map();
  #queues = new Map();
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

  /** Sign-in state for snapshots: never the sign-in link or provider identifiers. */
  snapshot() {
    return PROVIDER_LOGIN_PROVIDERS.map((provider) => this.#publicEntry(provider));
  }

  entry(provider) {
    return this.#publicEntry(normalizedProvider(provider));
  }

  /**
   * Starts a sign-in; an unfinished sign-in of the same provider is cancelled
   * first. Start, cancel and timeout of one provider run strictly one at a time.
   */
  start(providerName) {
    const provider = normalizedProvider(providerName);
    return this.#serialize(provider, async () => {
      await this.#cancelPending(provider, "superseded");
      const attempt = ++this.#attempt;
      const state = { provider, status: "pending", attempt, startedAt: new Date(this.#d.clock()).toISOString() };
      this.#states.set(provider, state);
      try {
        if (provider === "codex") await this.#startCodex(state);
        else this.#startClaude(state);
      } catch (error) {
        if (this.#isCurrent(state)) this.#finish(state, "failed", error);
        throw error;
      }
      if (this.#isCurrent(state)) {
        state.timer = this.#d.timers.setTimeout(() => {
          void this.#serialize(provider, () => this.#cancelPending(provider, "timeout", attempt));
        }, this.#d.timeoutMs);
        state.timer?.unref?.();
      }
      return {
        ...this.#publicEntry(provider),
        authUrl: this.#isCurrent(state) && provider === "codex" ? state.authUrl : null,
      };
    });
  }

  cancel(providerName) {
    const provider = normalizedProvider(providerName);
    return this.#serialize(provider, async () => {
      await this.#cancelPending(provider, "cancelled");
      return this.#publicEntry(provider);
    });
  }

  /** Receives every Codex App Server message; never throws into the event pipeline. */
  observeCodexMessage(message) {
    const method = message?.method;
    if (method === "account/updated") {
      this.#notifyAccountChanged("codex");
      return;
    }
    if (method !== "account/login/completed") return;
    const params = message.params ?? {};
    const state = this.#states.get("codex");
    // Only the exact attempt whose start response bound its loginId may settle.
    if (state.status !== "pending" || !state.loginId || params.loginId !== state.loginId) return;
    if (params.success === true) {
      this.#finish(state, "succeeded");
      this.#notifyAccountChanged("codex");
    } else {
      this.#finish(state, "failed", params.error || "Вход Codex не завершён");
    }
  }

  /**
   * Synchronous Hub shutdown hook: closes only this service's own sign-in. The
   * Claude sign-in CLI is killed with its process tree so it cannot outlive Hub;
   * provider turns belong to other owners and are left alone.
   */
  dispose() {
    for (const provider of PROVIDER_LOGIN_PROVIDERS) {
      const state = this.#states.get(provider);
      if (state.status !== "pending") continue;
      const worker = state.worker;
      this.#finish(state, "cancelled");
      if (provider === "codex" && state.loginId) {
        void Promise.resolve()
          .then(() => this.#d.sendRpc("account/login/cancel", { loginId: state.loginId }, { timeoutMs: 2_000 }))
          .catch(() => {});
      }
      if (worker) {
        void Promise.resolve()
          .then(() => this.#d.stopProcessTree(worker.pid))
          .catch(() => {});
        try {
          worker.kill?.();
        } catch {
          // The process tree stop above remains the owner of cleanup.
        }
      }
    }
  }

  #serialize(provider, operation) {
    const previous = this.#queues.get(provider) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.#queues.set(provider, next.catch(() => {}));
    return next;
  }

  #publicEntry(provider) {
    const state = this.#states.get(provider);
    return {
      provider,
      status: state.status,
      startedAt: state.startedAt ?? null,
      finishedAt: state.finishedAt ?? null,
      error: state.error || null,
    };
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
    // The CLI output is not needed, but its pipes must be drained.
    worker.stdout?.resume?.();
    worker.stderr?.resume?.();
    const release = () => {
      // An exited child's PID may be reused: detach it before any further await.
      if (state.worker === worker) state.worker = null;
    };
    worker.on("error", (error) => {
      release();
      if (this.#isCurrent(state)) this.#finish(state, "failed", error);
    });
    worker.on("close", (code) => {
      release();
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
    const worker = state.worker;
    if (reason === "timeout") this.#finish(state, "failed", "Время ожидания входа истекло");
    else this.#finish(state, "cancelled");
    if (provider === "codex" && state.loginId) {
      try {
        await this.#d.sendRpc("account/login/cancel", { loginId: state.loginId }, { timeoutMs: 5_000 });
      } catch (error) {
        this.#d.logger.error?.("Cannot cancel Codex sign-in:", boundedError(error));
      }
    }
    if (worker) {
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
    state.worker = null;
    if (state.timer) this.#d.timers.clearTimeout(state.timer);
    state.timer = null;
  }

  #notifyAccountChanged(provider) {
    Promise.resolve()
      .then(() => this.#d.onAccountChanged(provider))
      .catch((error) => this.#d.logger.error?.(`Cannot refresh ${provider} account:`, boundedError(error)));
  }
}
