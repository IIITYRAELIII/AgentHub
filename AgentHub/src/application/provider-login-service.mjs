/**
 * Official sign-in of the shared Codex and Claude accounts from the Server page.
 *
 * Hub only starts the provider-owned flow and tracks its state. Codex keeps the
 * credentials inside its App Server (`account/login/*`), Claude inside its CLI
 * config directory (`claude auth login`). Hub never reads, stores or logs tokens,
 * so a successful sign-in applies to new requests without restarting Hub, and
 * running turns keep their existing process.
 *
 * Sign-in links are returned only to the local caller that started the flow;
 * snapshots carry state without them. Claude opens the browser itself with its
 * localhost callback. Its printed link is the manual flow: the page shows a
 * `code#state` value that `claude auth login` reads line by line from stdin, so
 * Hub forwards that value to the stdin of the exact running attempt and keeps
 * nothing of it.
 */
export const PROVIDER_LOGIN_PROVIDERS = Object.freeze(["codex", "claude"]);

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CLAUDE_URL_WAIT_MS = 10_000;
const MAX_ERROR_LENGTH = 300;
const MAX_OUTPUT_SCAN_CHARS = 64 * 1024;
const MAX_MANUAL_CODE_LENGTH = 4_096;
const INVALID_CODE_ERROR = "Claude Code не принял код: скопируйте его со страницы входа целиком";

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
  return match ? match[0] : "";
}

function normalizedProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!PROVIDER_LOGIN_PROVIDERS.includes(provider)) throw new Error("Неизвестный провайдер входа");
  return provider;
}

/**
 * The value `claude auth login` accepts on stdin: `code#state`. Errors never
 * quote the value.
 */
export function manualClaudeLoginCode(value) {
  const text = String(value ?? "").trim();
  const parts = text.split("#");
  if (!text || text.length > MAX_MANUAL_CODE_LENGTH || /\s/u.test(text)
    || parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Код должен иметь вид code#state: скопируйте его со страницы входа целиком");
  }
  return text;
}

export class ProviderLoginService {
  #d;
  #states = new Map();
  #queues = new Map();
  #attempt = 0;
  #disposed = false;

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
    claudeUrlWaitMs = DEFAULT_CLAUDE_URL_WAIT_MS,
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
      claudeUrlWaitMs: Math.max(0, Number(claudeUrlWaitMs) || 0),
      logger,
    };
    for (const provider of PROVIDER_LOGIN_PROVIDERS) this.#states.set(provider, { provider, status: "idle" });
  }

  /** Sign-in state for snapshots: never the sign-in link, code or provider identifiers. */
  snapshot() {
    return PROVIDER_LOGIN_PROVIDERS.map((provider) => this.#publicEntry(provider));
  }

  entry(provider) {
    return this.#publicEntry(normalizedProvider(provider));
  }

  /**
   * Starts a sign-in; an unfinished sign-in of the same provider is cancelled
   * first. Start, code, cancel and timeout of one provider run strictly one at a
   * time.
   */
  start(providerName) {
    const provider = normalizedProvider(providerName);
    return this.#serialize(provider, async () => {
      this.#assertNotDisposed();
      await this.#cancelPending(provider, "superseded");
      this.#assertNotDisposed();
      const attempt = ++this.#attempt;
      const state = { provider, status: "pending", attempt, startedAt: new Date(this.#d.clock()).toISOString() };
      this.#states.set(provider, state);
      try {
        if (provider === "codex") await this.#startCodex(state);
        else await this.#startClaude(state);
      } catch (error) {
        if (this.#isCurrent(state)) this.#finish(state, "failed", error);
        throw error;
      }
      if (this.#disposed) {
        // Shutdown already finished this attempt before its start completed:
        // cancel the provider-side sign-in it has just created.
        await this.#cancelStartedAfterDispose(state);
        this.#assertNotDisposed();
      }
      if (this.#isCurrent(state)) {
        state.timer = this.#d.timers.setTimeout(() => {
          void this.#serialize(provider, () => this.#cancelPending(provider, "timeout", attempt));
        }, this.#d.timeoutMs);
        state.timer?.unref?.();
      }
      return {
        ...this.#publicEntry(provider),
        authUrl: this.#isCurrent(state) ? state.authUrl || null : null,
      };
    });
  }

  /** Forwards the manual `code#state` to the stdin of the exact running Claude sign-in. */
  submitCode(providerName, code, attemptId) {
    const provider = normalizedProvider(providerName);
    return this.#serialize(provider, async () => {
      this.#assertNotDisposed();
      if (provider !== "claude") throw new Error("Код входа вводится только для Claude");
      const state = this.#states.get(provider);
      const worker = state.worker;
      const stdin = worker?.stdin;
      if (!this.#isCurrent(state) || !stdin || stdin.destroyed || stdin.writableEnded) {
        throw new Error("Нет входа Claude, ожидающего код");
      }
      if (String(attemptId ?? "") !== String(state.attempt)) {
        throw new Error("Код относится к другой попытке входа: запустите вход заново");
      }
      const line = `${manualClaudeLoginCode(code)}\n`;
      state.error = "";
      await new Promise((resolve, reject) => {
        stdin.write(line, (error) => (error ? reject(new Error("Не удалось передать код Claude Code")) : resolve()));
      });
      return this.#publicEntry(provider);
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
    // Terminal fence: queued and in-flight operations check it inside their
    // serialized operation, so nothing can leave a pending sign-in after shutdown.
    this.#disposed = true;
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

  #assertNotDisposed() {
    if (this.#disposed) throw new Error("Agent Hub останавливается: вход недоступен");
  }

  async #cancelStartedAfterDispose(state) {
    const worker = state.worker;
    if (state.status === "pending") this.#finish(state, "cancelled");
    if (state.provider === "codex" && state.loginId) {
      try {
        await this.#d.sendRpc("account/login/cancel", { loginId: state.loginId }, { timeoutMs: 2_000 });
      } catch {
        // Hub is stopping; the App Server closes with it.
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

  #serialize(provider, operation) {
    const previous = this.#queues.get(provider) ?? Promise.resolve();
    const next = previous.then(() => operation(), () => operation());
    this.#queues.set(provider, next.catch(() => {}));
    return next;
  }

  #publicEntry(provider) {
    const state = this.#states.get(provider);
    return {
      provider,
      status: state.status,
      attemptId: state.attempt ? String(state.attempt) : null,
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

  async #startClaude(state) {
    const invocation = this.#d.resolveClaudeInvocation();
    const worker = this.#d.spawnProcess(invocation.command, [...(invocation.prefixArgs ?? []), "auth", "login"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.worker = worker;
    let urlSeen = null;
    const urlReady = new Promise((resolve) => { urlSeen = resolve; });
    let scanned = 0;
    // The output is read only for the printed sign-in link and the CLI's
    // invalid-code notice; reading also keeps the pipes drained.
    const onOutput = (chunk) => {
      if (state.worker !== worker || scanned >= MAX_OUTPUT_SCAN_CHARS) return;
      const text = String(chunk ?? "");
      scanned += text.length;
      if (!state.authUrl) {
        const url = firstHttpsUrl(text);
        if (url) {
          state.authUrl = url;
          urlSeen();
        }
      }
      if (text.includes("Invalid code.")) state.error = INVALID_CODE_ERROR;
    };
    worker.stdout?.setEncoding?.("utf8");
    worker.stderr?.setEncoding?.("utf8");
    worker.stdout?.on("data", onOutput);
    worker.stderr?.on("data", onOutput);
    const release = () => {
      // An exited child's PID may be reused: detach it before any further await.
      if (state.worker === worker) state.worker = null;
      urlSeen();
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
    if (this.#d.claudeUrlWaitMs > 0 && !state.authUrl) {
      let timer = null;
      await Promise.race([
        urlReady,
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.#d.claudeUrlWaitMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
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
