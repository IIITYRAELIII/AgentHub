import { spawn } from "node:child_process";

import { CodexAppServerTransport } from "./codex-app-server-transport.mjs";

export class CodexAppServerLifecycle {
  #d;
  #restarting = false;
  #timeoutRestarting = false;

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

  async #spawn(args) {
    const d = this.#d;
    const command = await d.resolveExecutable();
    const mcp = await d.unavailableMcpOverrides();
    if (mcp.disabled.length > 0) {
      const endpoints = mcp.disabled
        .map((server) => `${server.name} (${server.host}:${server.port})`)
        .join(", ");
      d.logger.log(`Local MCP unavailable; disabled for Agent Hub Server: ${endpoints}`);
    }
    d.logger.error(`Starting Codex: ${command}`);
    const child = spawn(command, [...d.executableArgs, ...mcp.args, ...args], {
      cwd: d.projectRoot(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  }

  async #handleExit({ detail }) {
    const d = this.#d;
    if (d.isStopping()) return;
    d.logger.error(`Codex app-server stopped (${detail}).`);
    const runs = d.activeRuns().filter((run) => run.provider === "codex");
    if (!d.providerSelected() && runs.length === 0) return;
    for (const run of runs) d.setStage(run, "Связь с Codex потеряна. Переподключаюсь…");
    if (!this.#restarting) queueMicrotask(() => void this.restartAfterCrash());
  }

  async #handleTimeout({ method, timeoutMs, generation }) {
    const d = this.#d;
    if (d.isStopping() || this.#timeoutRestarting || timeoutMs < d.rpcTimeoutMs) return;
    if (Number.isSafeInteger(generation) && generation !== this.transport.generation) return;
    if (!["thread/read", "thread/list", "thread/turns/list"].includes(method)) return;
    const managedRunActive = d.activeRuns().some((run) => (
      run.provider === "codex" && run.observer === false && run.status === "running"
    ));
    if (managedRunActive) return;
    this.#timeoutRestarting = true;
    d.logger.error(`Codex app-server is unresponsive on ${method}; recycling the Hub-owned process.`);
    try {
      await this.stop();
    } finally {
      this.#timeoutRestarting = false;
    }
  }

  setRestarting(value) {
    this.#restarting = Boolean(value);
  }

  async start() { await this.transport.start(); }
  async stop() { await this.transport.stop(); }
  request(method, params = {}, options = {}) { return this.transport.request(method, params, options); }
  readThread(threadId, options = {}) { return this.transport.readThread(threadId, options); }
  invalidateThreadRead(threadId) { this.transport.invalidateThreadRead(threadId); }
  notify(method, params = {}) { this.transport.notify(method, params); }
  respond(id, result) { this.transport.respond(id, result); }

  async initialize({ attachSelectedThread = true } = {}) {
    const initialized = await this.transport.initialize({
      clientInfo: {
        name: "agent_hub",
        title: "Agent Hub",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    if (initialized.newlyInitialized) this.notify("initialized");
    if (attachSelectedThread) await this.#d.attachSelectedThread();
  }

  async restartAfterCrash() {
    const d = this.#d;
    const runs = d.activeRuns().filter((run) => run.provider === "codex");
    if (d.isStopping() || (!d.providerSelected() && runs.length === 0) || this.#restarting) return;
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
      if (!d.isStopping() && (d.providerSelected() || runs.length)) {
        d.scheduleRetry(() => this.restartAfterCrash(), 5_000);
      }
    } finally {
      this.#restarting = false;
    }
  }
}
