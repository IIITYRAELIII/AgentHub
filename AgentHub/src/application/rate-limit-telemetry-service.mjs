export class RateLimitTelemetryService {
  constructor({
    resolveClaudeInvocation,
    parseClaudeLimits,
    formatClaudeRateLimits,
    formatCodexRateLimits,
    spawnCapture,
    readCodexAccount,
    readClaudeAccount,
    readCodexRateLimits,
    codexRunning,
    codexPollingEnabled = true,
    claudePollingEnabled = true,
    historyStore,
    workLogUsageStore,
    timers,
    isStopping,
    intervalMs = 5 * 60_000,
    historyFreshnessMs = 30_000,
    clock = () => Date.now(),
    nowIso = () => new Date().toISOString(),
    logger = console,
  }) {
    this.resolveClaudeInvocation = resolveClaudeInvocation;
    this.parseClaudeLimits = parseClaudeLimits;
    this.formatClaudeRateLimits = formatClaudeRateLimits;
    this.formatCodexRateLimits = formatCodexRateLimits;
    this.spawnCapture = spawnCapture;
    this.readCodexAccount = readCodexAccount ?? (async () => null);
    this.readClaudeAccount = readClaudeAccount ?? (async () => null);
    this.readCodexRateLimits = readCodexRateLimits;
    this.codexRunning = codexRunning;
    this.codexPollingEnabled = codexPollingEnabled;
    this.claudePollingEnabled = claudePollingEnabled;
    this.historyStore = historyStore;
    this.workLogUsageStore = workLogUsageStore;
    this.timers = timers;
    this.isStopping = isStopping;
    this.intervalMs = intervalMs;
    this.historyFreshnessMs = historyFreshnessMs;
    this.clock = clock;
    this.nowIso = nowIso;
    this.logger = logger;
    this.pollInFlight = null;
    this.codexRefreshInFlight = null;
    this.lastCodexRefresh = null;
  }

  readCodex() {
    return this.readCodexRateLimits();
  }

  readAccount() {
    return this.readCodexAccount();
  }

  readClaudeAccountDimension() {
    return this.readClaudeAccount();
  }

  refreshCodex({ maxAgeMs = 0 } = {}) {
    const maximumAge = Math.max(0, Number(maxAgeMs) || 0);
    if (maximumAge > 0 && this.lastCodexRefresh
      && this.clock() - this.lastCodexRefresh.atMs <= maximumAge) {
      return Promise.resolve(this.lastCodexRefresh.result);
    }
    if (this.codexRefreshInFlight) return this.codexRefreshInFlight;
    this.codexRefreshInFlight = this.#refreshCodexOnce().finally(() => {
      this.codexRefreshInFlight = null;
    });
    return this.codexRefreshInFlight;
  }

  async history(params = {}) {
    if (this.codexRunning()) {
      try {
        await this.refreshCodex({ maxAgeMs: this.historyFreshnessMs });
      } catch (error) {
        this.logger.error("Cannot refresh current Codex rate limits:", error.message);
      }
    }
    return this.historyStore.read(params);
  }

  async readClaude() {
    const invocation = this.resolveClaudeInvocation();
    const result = await this.spawnCapture(invocation.command, [
      ...invocation.prefixArgs,
      // The probe needs neither workspace customizations nor tools. Safe mode
      // prevents project/user MCP servers from starting merely for /usage.
      "--safe-mode", "--no-session-persistence",
      "--print", "--output-format", "text", "--permission-mode", "dontAsk", "/usage",
    ], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
    if (result.error) throw result.error;
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Claude Code завершился с кодом ${result.code}`);
    }
    return result.stdout;
  }

  async formatted(provider) {
    return provider === "codex"
      ? this.formatCodexRateLimits(await this.readCodex())
      : this.formatClaudeRateLimits(this.parseClaudeLimits(await this.readClaude()));
  }

  schedule(delayMs = this.intervalMs) {
    if (this.isStopping() || (!this.codexPollingEnabled && !this.claudePollingEnabled)) return;
    this.timers.schedule("rate-limit-poll", () => {
      void this.poll();
    }, Math.max(0, Number(delayMs) || 0));
  }

  poll() {
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.#pollOnce().finally(() => {
      this.pollInFlight = null;
      this.schedule();
    });
    return this.pollInFlight;
  }

  async #pollOnce() {
    const observedAt = this.nowIso();
    const jobs = [];
    if (this.codexPollingEnabled && this.codexRunning()) {
      jobs.push(this.refreshCodex().catch((error) => {
        this.logger.error("Cannot poll Codex rate limits:", error.message);
      }));
    }
    if (this.claudePollingEnabled) {
      jobs.push((async () => {
        const accountPromise = this.readClaudeAccountDimension().catch((error) => {
          this.logger.error("Cannot identify Claude account:", error.message);
          return null;
        });
        const [account, limits] = await Promise.all([
          accountPromise,
          this.parseClaudeLimits(await this.readClaude()),
        ]);
        if (!limits.length) throw new Error("Claude did not return recognizable limit data");
        await this.historyStore.record({ limits }, observedAt, "claude", account);
      })().catch((error) => {
        this.logger.error("Cannot poll Claude rate limits:", error.message);
      }));
    }
    await Promise.all(jobs);
  }

  async #refreshCodexOnce() {
    const observedAt = this.nowIso();
    const accountPromise = this.readAccount().catch((error) => {
      this.logger.error("Cannot identify Codex account:", error.message);
      return null;
    });
    const [account, result] = await Promise.all([accountPromise, this.readCodex()]);
    const summary = this.formatCodexRateLimits(result);
    await this.historyStore.record(result, observedAt, "codex", account);
    await this.workLogUsageStore.projectRateLimits(null, summary, observedAt);
    this.lastCodexRefresh = { atMs: this.clock(), result };
    return result;
  }
}
