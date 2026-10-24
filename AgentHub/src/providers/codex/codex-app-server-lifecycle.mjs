import { spawn } from "node:child_process";

import { AGENT_HUB_VERSION } from "../../infrastructure/filesystem/agent-hub-package.mjs";
import { CodexAppServerTransport } from "./codex-app-server-transport.mjs";

export class CodexAppServerLifecycle {
  #d;
  #restarting = false;
  #timeoutRestarting = false;
  #timeoutHealthCheck = null;
  #startedWithRollback = false;
  #startupTimings = {};
  #updateFlight = null;
  #updateCompletion = null;

  constructor(dependencies) {
    this.#d = dependencies;
    this.transport = new CodexAppServerTransport({
      spawnProcess: (args) => this.#spawn(args),
      stopProcessTree: dependencies.stopProcessTree,
      onMessage: dependencies.onMessage,
      onExit: (event) => this.#handleExit(event),
      onTimeout: (event) => this.#handleTimeout(event),
      rpcTimeoutMs: dependencies.rpcTimeoutMs,
    });
  }

  get running() { return this.transport.running; }
  get pid() { return this.transport.pid; }

  startupTimings() { return { ...this.#startupTimings }; }

  async #spawn(args) {
    const d = this.#d;
    this.#startupTimings = {};
    let phaseStartedAt = performance.now();
    const selectedCommand = await d.resolveExecutable();
    this.#startupTimings.selectionMs = Math.round(performance.now() - phaseStartedAt);
    phaseStartedAt = performance.now();
    const mcp = await d.unavailableMcpOverrides();
    this.#startupTimings.mcpPreflightMs = Math.round(performance.now() - phaseStartedAt);
    if (mcp.disabled.length > 0) {
      const endpoints = mcp.disabled
        .map((server) => `${server.name} (${server.host}:${server.port})`)
        .join(", ");
      d.logger.log(`Local MCP unavailable; disabled for Agent Hub Server: ${endpoints}`);
    }
    phaseStartedAt = performance.now();
    const command = typeof d.verifyExecutableForLaunch === "function"
      ? await d.verifyExecutableForLaunch(selectedCommand)
      : selectedCommand;
    this.#startupTimings.verificationMs = Math.round(performance.now() - phaseStartedAt);
    phaseStartedAt = performance.now();
    d.logger.error(`Starting Codex: ${command}`);
    const child = (d.spawnProcess ?? spawn)(command, [...d.executableArgs, ...mcp.args, ...args], {
      cwd: d.projectRoot(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    try { d.bindSpawnedProcess?.(child); }
    catch (error) {
      // Spawn already created this exact owned child. A custody bind failure
      // must not strand it outside the transport owner.
      child.once("error", () => {});
      child.kill();
      throw error;
    }
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.#startupTimings.spawnMs = Math.round(performance.now() - phaseStartedAt);
    return child;
  }

  async #handleExit({ detail }) {
    const d = this.#d;
    if (d.isStopping()) return;
    d.logger.error(`Codex app-server stopped (${detail}).`);
    if (this.#timeoutRestarting) return;
    const runs = d.activeRuns().filter((run) => run.provider === "codex");
    if (!d.providerSelected() && runs.length === 0) return;
    for (const run of runs) d.setStage(run, "Связь с Codex потеряна. Переподключаюсь…");
    if (!this.#restarting) queueMicrotask(() => void this.restartAfterCrash());
  }

  async #handleTimeout({ method, timeoutMs, generation, error }) {
    const d = this.#d;
    if (d.isStopping() || this.#restarting || this.#timeoutRestarting || timeoutMs < d.rpcTimeoutMs) return;
    if (Number.isSafeInteger(generation) && generation !== this.transport.generation) return;
    if (error?.deliveryOutcome === "not-sent") return;
    if (!["thread/read", "thread/list", "thread/turns/list"].includes(method)) return;
    const managedRunActive = d.activeRuns().some((run) => (
      run.provider === "codex" && run.observer === false && run.status === "running"
    ));
    if (managedRunActive) return;
    if (this.#timeoutHealthCheck) return;

    d.logger.error(`Codex ${method} timed out; checking app-server health before recycling it.`);
    const healthCheck = {
      method,
      generation,
      promise: null,
    };
    this.#timeoutHealthCheck = healthCheck;
    try {
      healthCheck.promise = this.request("thread/list", { limit: 1 }, {
        timeoutMs: d.rpcTimeoutMs,
        priority: "interactive",
      });
      await healthCheck.promise;
      d.logger.log(`Codex app-server answered the health check after ${method} timed out; keeping it running.`);
    } catch (error) {
      if (this.#timeoutHealthCheck !== healthCheck
        || d.isStopping()
        || this.#timeoutRestarting
        || error?.deliveryOutcome === "not-sent"
        || (Number.isSafeInteger(healthCheck.generation)
          && healthCheck.generation !== this.transport.generation)) return;
      const runStartedDuringCheck = d.activeRuns().some((run) => (
        run.provider === "codex" && run.observer === false && run.status === "running"
      ));
      if (runStartedDuringCheck) return;
      this.#timeoutRestarting = true;
      d.logger.error(
        `Codex app-server did not answer the health check after ${healthCheck.method} timed out; recycling the Hub-owned process.`,
      );
      try {
        await this.stop();
        await this.restartAfterCrash({ required: true });
      } finally {
        this.#timeoutRestarting = false;
      }
    } finally {
      if (this.#timeoutHealthCheck === healthCheck) this.#timeoutHealthCheck = null;
    }
  }

  setRestarting(value) {
    this.#restarting = Boolean(value);
  }

  async start() {
    if (this.#updateFlight) await this.#updateFlight;
    return this.#start();
  }

  async #start() {
    try {
      await this.transport.start();
      this.#startedWithRollback = false;
    } catch (error) {
      const rollback = await this.#d.onStartupFailure?.(error);
      if (!rollback) throw error;
      this.#d.logger.error(`Codex process start failed; retrying once with last-known-good: ${error.message}`);
      await this.transport.stop();
      try {
        await this.transport.start();
        this.#startedWithRollback = true;
      } catch (rollbackError) {
        await this.#d.onStartupFailure?.(rollbackError);
        throw new AggregateError(
          [error, rollbackError],
          `Codex candidate and last-known-good process start failed: ${rollbackError.message}`,
        );
      }
    }
  }
  async stop() {
    await this.#updateCompletion?.catch(() => {});
    await this.transport.stop();
  }
  request(method, params = {}, options = {}) {
    return this.#updateFlight ? this.#updateFlight.then(() => this.transport.request(method, params, options))
      : this.transport.request(method, params, options);
  }
  readThread(threadId, options = {}) {
    return this.#updateFlight ? this.#updateFlight.then(() => this.transport.readThread(threadId, options))
      : this.transport.readThread(threadId, options);
  }
  invalidateThreadRead(threadId) { this.transport.invalidateThreadRead(threadId); }
  notify(method, params = {}) { this.transport.notify(method, params); }
  respond(id, result) { return this.transport.respond(id, result); }

  async initialize({ attachSelectedThread = true } = {}) {
    if (this.#updateFlight) await this.#updateFlight;
    return this.#initialize({ attachSelectedThread });
  }

  async #initialize({ attachSelectedThread = true, request = null } = {}) {
    const initializeOnce = async () => {
      const phaseStartedAt = performance.now();
      const initialized = await this.transport.initialize({
        clientInfo: {
          name: "agent_hub",
          title: "Agent Hub",
          version: AGENT_HUB_VERSION,
        },
        capabilities: { experimentalApi: true },
      });
      if (initialized.newlyInitialized) this.#startupTimings.initializeMs = Math.round(performance.now() - phaseStartedAt);
      if (initialized.newlyInitialized) this.notify("initialized");
      if (attachSelectedThread) await this.#d.attachSelectedThread(request ? { sendRpc: request } : undefined);
      return initialized;
    };
    try {
      const initialized = await initializeOnce();
      await this.#d.onStartupSuccess?.();
      const rolledBack = this.#startedWithRollback;
      this.#startedWithRollback = false;
      return rolledBack ? { ...initialized, rolledBack: true } : initialized;
    } catch (error) {
      const rollback = await this.#d.onStartupFailure?.(error);
      if (!rollback) throw error;
      this.#d.logger.error(`Codex startup failed; retrying once with last-known-good: ${error.message}`);
      await this.transport.stop();
      await this.transport.start();
      try {
        const initialized = await initializeOnce();
        await this.#d.onStartupSuccess?.();
        this.#startedWithRollback = false;
        return { ...initialized, rolledBack: true };
      } catch (rollbackError) {
        await this.#d.onStartupFailure?.(rollbackError);
        throw new AggregateError(
          [error, rollbackError],
          `Codex candidate and last-known-good startup failed: ${rollbackError.message}`,
        );
      }
    }
  }

  applyPreparedUpdate() {
    const d = this.#d;
    if (this.#updateCompletion) return this.#updateCompletion;
    const lostTransport = !this.transport.running;
    if (d.isStopping() || this.#restarting || this.#timeoutRestarting
      || (!lostTransport && d.activeRuns().some(run => run.provider === "codex" && !["completed", "failed", "cancelled", "aborted"].includes(run.status)))
      || this.transport.pending?.size || Object.values(this.transport.requestQueues ?? {}).some(queue => queue.length)) return Promise.resolve(false);
    // Set the provider-local RPC fence synchronously before yielding. Newly
    // admitted commands keep their original identities and wait; no replay.
    this.#updateFlight = Promise.resolve().then(async () => {
      if (d.isStopping() || (!lostTransport && d.activeRuns().some(run => run.provider === "codex"
        && !["completed", "failed", "cancelled", "aborted"].includes(run.status)))) return false;
      this.#restarting = true;
      try {
        d.onInitializationPending?.();
        await this.transport.stop();
        await this.#start();
        await this.#initialize({ attachSelectedThread: d.providerSelected(),
          request: (method, params, options) => this.transport.request(method, params, options) });
        return true;
      } catch (error) {
        d.onInitializationFailure?.(error);
        throw error;
      } finally { this.#restarting = false; }
    }).finally(() => { this.#updateFlight = null; });
    // Existing recovery may issue reads through the ordinary port. Run it only
    // for lost transport, after removing the RPC fence; exact run lanes remain
    // occupied and no old user command is resubmitted.
    this.#updateCompletion = this.#updateFlight.then(async applied => {
      if (applied && lostTransport) await d.recoverRuns();
      return applied;
    }).finally(() => { this.#updateCompletion = null; });
    return this.#updateCompletion;
  }

  async restartAfterCrash({ required = false } = {}) {
    const d = this.#d;
    const runs = d.activeRuns().filter((run) => run.provider === "codex");
    if (d.isStopping() || (!required && !d.providerSelected() && runs.length === 0) || this.#restarting) return;
    this.#restarting = true;
    try {
      await this.start();
      await this.initialize({ attachSelectedThread: d.providerSelected() });
      await d.recoverRuns();
      if (d.activeRuns().some((run) => run.displayRequested === true)) d.startTyping();
      for (const run of runs) d.setStage(run, "Соединение с Codex восстановлено.");
    } catch (error) {
      d.logger.error("Cannot restart Codex app-server:", error.message);
      for (const run of runs) d.setStage(run, `Codex пока недоступен: ${error.message}`);
      if (!d.isStopping() && (required || d.providerSelected() || runs.length)) {
        d.scheduleRetry(() => this.restartAfterCrash({ required }), 5_000);
      }
    } finally {
      this.#restarting = false;
    }
  }
}
