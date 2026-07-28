import { readFile } from "node:fs/promises";

import { parseClaudeResult, parseClaudeStreamEvent } from "./claude.mjs";
import {
  ClaudeOutputReader,
  openClaudeRunOutput,
  processIsAlive,
  removeClaudeRunOutput,
  spawnClaudeWorker,
  stopProcessTree,
} from "./claude-run-io.mjs";

export class ClaudeRunController {
  constructor({
    dataDir,
    pollIntervalMs = 250,
    isCurrentRun = () => true,
    isStopping = () => false,
    onStreamEvent = () => {},
    onComplete = async () => {},
    onPersist = async () => {},
    onActive = () => {},
    onReconnect = () => {},
    onReadError = (run, error) => console.error(`Cannot read Claude output for task ${run.threadId}:`, error.message),
  }) {
    this.dataDir = dataDir;
    this.pollIntervalMs = pollIntervalMs;
    this.isCurrentRun = isCurrentRun;
    this.isStopping = isStopping;
    this.onStreamEvent = onStreamEvent;
    this.onComplete = onComplete;
    this.onPersist = onPersist;
    this.onActive = onActive;
    this.onReconnect = onReconnect;
    this.onReadError = onReadError;
  }

  async start(run, { command, args, cwd, env }) {
    const output = await openClaudeRunOutput(this.dataDir, run.turnId);
    Object.assign(run, {
      claudeOutputPath: output.outputPath,
      claudeErrorPath: output.errorPath,
      claudeReadOffset: 0,
      claudeThinkingPeak: 0,
      claudeFailureText: "",
      claudeResult: null,
      claudeExitCode: null,
      claudeExited: false,
      claudeSettled: false,
    });
    let worker;
    let callbacksEnabled = false;
    let spawnError = null;
    try {
      worker = spawnClaudeWorker({
        command,
        args,
        cwd,
        stdout: output.outputHandle.fd,
        stderr: output.errorHandle.fd,
        env,
        onError: (error) => {
          spawnError = error;
          if (callbacksEnabled) void this.complete(run, { spawnError: error });
        },
        onExit: (code) => {
          run.claudeExitCode = code;
          run.claudeExited = true;
          if (callbacksEnabled) void this.drain(run);
        },
      });
    } finally {
      await Promise.all([
        output.outputHandle.close().catch(() => {}),
        output.errorHandle.close().catch(() => {}),
      ]);
    }
    if (spawnError) {
      await this.complete(run, { spawnError });
      return;
    }
    run.process = worker;
    run.pid = worker.pid ?? null;
    await this.onPersist(run);
    callbacksEnabled = true;
    if (spawnError) {
      await this.complete(run, { spawnError });
      return;
    }
    if (run.claudeExited) {
      await this.drain(run);
      return;
    }
    if (run.claudeSettled || !this.isCurrentRun(run)) return;
    this.onActive(run);
    this.schedule(run, 0);
  }

  schedule(run, delayMs = this.pollIntervalMs) {
    if (!run || run.claudeSettled || run.claudeDrainTimer || this.isStopping()) return;
    if (!this.isCurrentRun(run)) return;
    run.claudeDrainTimer = setTimeout(() => {
      run.claudeDrainTimer = null;
      void this.drain(run);
    }, delayMs);
  }

  async drain(run) {
    if (!run || run.claudeSettled || !this.isCurrentRun(run)) return;
    if (run.claudeDrainInFlight) {
      run.claudeDrainPending = true;
      return;
    }
    run.claudeDrainInFlight = true;
    try {
      do {
        run.claudeDrainPending = false;
        const reader = this.#reader(run);
        const lines = await reader.read();
        run.claudeReadOffset = reader.offset;
        for (const line of lines) {
          const parsed = parseClaudeStreamEvent(line);
          if (!parsed) continue;
          if (parsed.result) run.claudeResult = parsed.result;
          this.onStreamEvent(run, parsed);
        }
      } while (run.claudeDrainPending);
    } catch (error) {
      this.onReadError(run, error);
    } finally {
      run.claudeDrainInFlight = false;
    }
    if (run.claudeSettled || !this.isCurrentRun(run)) return;
    const processGone = run.claudeExited === true
      || (run.pid ? !processIsAlive(run.pid) : !run.process);
    if (run.claudeResult || processGone) {
      await this.complete(run);
      return;
    }
    this.schedule(run);
  }

  async complete(run, { spawnError = null } = {}) {
    if (!run || run.claudeSettled) return;
    run.claudeSettled = true;
    this.pause(run);
    run.process = null;
    const outputPaths = { outputPath: run.claudeOutputPath, errorPath: run.claudeErrorPath };
    const exitCode = Number.isInteger(run.claudeExitCode) ? run.claudeExitCode : null;
    const result = spawnError ? null : await this.#readResult(run);
    // Claude may return an is_error JSON result while writing the useful
    // diagnostic only to stderr. Keep both channels until completion handling.
    const errorText = await this.#readError(run);
    try {
      await this.onComplete(run, { spawnError, result, errorText, exitCode, outputPaths });
    } finally {
      await removeClaudeRunOutput(outputPaths);
    }
  }

  async stop(run) {
    if (!run) return false;
    const pid = Number(run.pid ?? run.process?.pid);
    if (!processIsAlive(pid)) {
      run.claudeExited = true;
      void this.drain(run);
      return true;
    }
    return stopProcessTree(pid);
  }

  async attachAfterRestart(run) {
    const alive = processIsAlive(run.pid);
    Object.assign(run, {
      process: null,
      claudeReader: null,
      claudeSettled: false,
      claudeExited: !alive,
      claudeExitCode: null,
      claudeReadOffset: 0,
      claudeThinkingPeak: 0,
      claudeFailureText: "",
      claudeResult: null,
      responseText: "",
    });
    this.onReconnect(run, alive);
    if (alive) this.onActive(run);
    await this.onPersist(run);
    await this.drain(run);
    return alive;
  }

  pause(run) {
    if (!run?.claudeDrainTimer) return;
    clearTimeout(run.claudeDrainTimer);
    run.claudeDrainTimer = null;
  }

  #reader(run) {
    if (!run.claudeReader || run.claudeReader.path !== run.claudeOutputPath) {
      run.claudeReader = new ClaudeOutputReader(run.claudeOutputPath, {
        offset: run.claudeReadOffset ?? 0,
      });
      run.claudeReader.path = run.claudeOutputPath;
    }
    return run.claudeReader;
  }

  async #readResult(run) {
    if (run.claudeResult) return run.claudeResult;
    if (!run.claudeOutputPath) return null;
    try {
      const text = await readFile(run.claudeOutputPath, "utf8");
      return text.trim() ? parseClaudeResult(text) : null;
    } catch {
      return null;
    }
  }

  async #readError(run) {
    if (!run.claudeErrorPath) return "";
    try {
      return String(await readFile(run.claudeErrorPath, "utf8")).trim().slice(-2000);
    } catch {
      return "";
    }
  }
}
