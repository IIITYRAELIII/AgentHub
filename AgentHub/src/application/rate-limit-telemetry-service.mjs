export class RateLimitTelemetryService {
  constructor({
    resolveClaudeInvocation,
    parseClaudeLimits,
    formatClaudeRateLimits,
    formatCodexRateLimits,
    spawnCapture,
    readCodexAccount,
    readCodexRateLimits,
    codexRunning,
    historyStore,
    workLogUsageStore,
    timers,
    isStopping,
    intervalMs = 5 * 60_000,
    nowIso = () => new Date().toISOString(),
    logger = console,
  }) {
    this.resolveClaudeInvocation = resolveClaudeInvocation;
    this.parseClaudeLimits = parseClaudeLimits;
    this.formatClaudeRateLimits = formatClaudeRateLimits;
    this.formatCodexRateLimits = formatCodexRateLimits;
    this.spawnCapture = spawnCapture;
    this.readCodexAccount = readCodexAccount ?? (async () => null);
    this.readCodexRateLimits = readCodexRateLimits;
    this.codexRunning = codexRunning;
    this.historyStore = historyStore;
    this.workLogUsageStore = workLogUsageStore;
    this.timers = timers;
    this.isStopping = isStopping;
    this.intervalMs = intervalMs;
    this.nowIso = nowIso;
    this.logger = logger;
    this.pollInFlight = null;
  }

  readCodex() {
    return this.readCodexRateLimits();
  }

  readAccount() {
    return this.readCodexAccount();
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
    if (this.isStopping()) return;
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
    if (this.codexRunning()) {
      jobs.push((async () => {
        const accountPromise = this.readAccount().catch((error) => {
          this.logger.error("Cannot identify Codex account:", error.message);
          return null;
        });
        const [account, result] = await Promise.all([accountPromise, this.readCodex()]);
        const summary = this.formatCodexRateLimits(result);
        await this.historyStore.record(result, observedAt, "codex", account);
        await this.workLogUsageStore.projectRateLimits(null, summary, observedAt);
      })().catch((error) => {
        this.logger.error("Cannot poll Codex rate limits:", error.message);
      }));
    }
    jobs.push((async () => {
      const limits = this.parseClaudeLimits(await this.readClaude());
      if (!limits.length) throw new Error("Claude did not return recognizable limit data");
      await this.historyStore.record({ limits }, observedAt, "claude");
    })().catch((error) => {
      this.logger.error("Cannot poll Claude rate limits:", error.message);
    }));
    await Promise.all(jobs);
  }
}
