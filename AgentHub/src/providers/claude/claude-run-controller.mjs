import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const EOL = String.fromCharCode(10);

import {
  claudeInterruptRequest,
  claudeStreamInputMessage,
  parseClaudeResult,
  parseClaudeStreamEvent,
} from "./claude.mjs";
import {
  ClaudeOutputReader,
  openClaudeRunOutput,
  processFingerprintMatches,
  processIsAlive,
  readProcessFingerprint,
  removeClaudeRunOutput,
  spawnClaudeWorker,
  stopProcessTree,
} from "./claude-run-io.mjs";

export class ClaudeRunController {
  constructor({
    dataDir,
    processAuthority = null,
    onRecoveryUnavailable = async () => {},
    pollIntervalMs = 250,
    isCurrentRun = () => true,
    isStopping = () => false,
    onStreamEvent = () => {},
    onComplete = async () => {},
    onPersist = async () => {},
    onActive = () => {},
    onReconnect = () => {},
    onReadError = (run, error) => console.error(`Cannot read Claude output for task ${run.threadId}:`, error.message),
    processAlive = processIsAlive,
    processFingerprintLookup = readProcessFingerprint,
    stopProcess = stopProcessTree,
  }) {
    this.dataDir = dataDir;
    this.processAuthority = processAuthority;
    this.onRecoveryUnavailable = onRecoveryUnavailable;
    this.pollIntervalMs = pollIntervalMs;
    this.isCurrentRun = isCurrentRun;
    this.isStopping = isStopping;
    this.onStreamEvent = onStreamEvent;
    this.onComplete = onComplete;
    this.onPersist = onPersist;
    this.onActive = onActive;
    this.onReconnect = onReconnect;
    this.onReadError = onReadError;
    this.processAlive = processAlive;
    this.processFingerprintLookup = processFingerprintLookup;
    this.stopProcess = stopProcess;
  }

  async start(run, { command, args, cwd, env, input = null }) {
    this.processAuthority?.started(run);
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
      claudeExitDrainRetried: false,
      claudeSettled: false,
      claudeInput: null,
      claudeSteer: null,
    });
    let worker;
    let callbacksEnabled = false;
    let spawnError = null;
    try {
      worker = spawnClaudeWorker({
        command,
        args,
        cwd,
        stdin: input == null ? "ignore" : "pipe",
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
    if (input != null && worker.stdin) {
      // Разрыв канала не является ошибкой хода: процесс дочитает текущий ход
      // и завершится, а его результат придёт через файл вывода как обычно.
      worker.stdin.on("error", () => {});
      run.claudeInput = worker.stdin;
      this.#write(run, claudeStreamInputMessage(input));
    }
    // Win32_Process may not expose a just-created child on its first WMI
    // query. Capture the fingerprint before persisting the run so a later
    // Hub restart can safely reattach it instead of treating it as unknown.
    run.claudeProcessFingerprint = await this.#lookupFingerprintWithRetry(run.pid);
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
    if (this.processAuthority && !this.processAuthority.owns(run)) return;
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
          if (parsed.result && this.#continueSteer(run)) continue;
          if (parsed.result) {
            run.claudeResult = parsed.result;
            this.#closeInput(run);
          }
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
      || (run.pid ? !this.processAlive(run.pid) : !run.process);
    if (run.claudeResult) {
      await this.complete(run);
      return;
    }
    // Windows may report the detached child exit just before its redirected
    // output becomes visible to the reader. Give the final JSONL write one
    // bounded extra polling interval before concluding that no result exists.
    if (processGone && !run.claudeExitDrainRetried) {
      run.claudeExitDrainRetried = true;
      this.schedule(run);
      return;
    }
    if (processGone) {
      await this.complete(run);
      return;
    }
    this.schedule(run);
  }

  /* Отправка в идущий ход. У Claude CLI нет подмешивания текста в ход, как у
     Codex: текущий ход прерывается, а сообщение уходит следующим ходом того же
     процесса и той же сессии — контекст сохраняется. Завершается такой ход
     результатом продолжения, а не результатом прерванного хода. */
  steer(run, text) {
    const message = String(text ?? "").trim();
    if (!message) throw new Error("Active turn not steerable: empty steer message");
    if (!run || run.claudeSettled || run.claudeExited || !run.claudeInput || run.claudeInputClosed) {
      throw new Error("Active turn not steerable: Claude turn has no open input channel");
    }
    const requestId = `agent-hub-interrupt:${randomUUID()}`;
    run.claudeSteer = { text: message, state: "interrupting", requestId };
    this.#write(run, claudeInterruptRequest(requestId));
    return { turnId: run.turnId, requestId };
  }

  #continueSteer(run) {
    const steer = run.claudeSteer;
    if (steer?.state !== "interrupting") return false;
    // Результат принадлежит прерванному ходу (или ходу, который успел
    // завершиться сам): он не финальный, продолжение уходит тем же процессом.
    run.claudeSteer = { ...steer, state: "continuing" };
    this.#write(run, claudeStreamInputMessage(steer.text));
    return true;
  }

  #write(run, line) {
    const input = run?.claudeInput;
    if (!input || run.claudeInputClosed || input.destroyed) return false;
    input.write(`${line}${EOL}`);
    return true;
  }

  #closeInput(run) {
    const input = run?.claudeInput;
    if (!input || run.claudeInputClosed) return;
    run.claudeInputClosed = true;
    try {
      input.end();
    } catch {
      // Канал уже закрыт со стороны процесса.
    }
  }

  async complete(run, { spawnError = null } = {}) {
    if (!run || run.claudeSettled) return;
    if (this.processAuthority && !this.processAuthority.owns(run)) return;
    run.claudeSettled = true;
    this.pause(run);
    this.#closeInput(run);
    run.claudeInput = null;
    run.claudeSteer = null;
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
    if (this.processAuthority && !this.processAuthority.owns(run)) return false;
    const pid = Number(run.pid ?? run.process?.pid);
    if (!this.processAlive(pid)) {
      run.claudeExited = true;
      void this.drain(run);
      return true;
    }
    // Before a Hub restart, the ChildProcess handle is stronger evidence than
    // a transient WMI lookup: it is the exact child this controller spawned.
    // After a restart no handle exists, so the persisted fingerprint remains
    // mandatory and a reused PID can never be stopped by mistake.
    if (!this.#ownsCurrentChild(run, pid) && !await this.#ownsProcess(run, pid)) return false;
    return this.stopProcess(pid);
  }

  async attachAfterRestart(run) {
    if (this.processAuthority && !this.processAuthority.owns(run)) {
      run.contourRecoveryExclusion = "captured-process-and-output-not-owned";
      await this.onPersist(run);
      await this.onRecoveryUnavailable(run);
      return false;
    }
    const alive = this.processAlive(run.pid) && await this.#ownsProcess(run, run.pid);
    // Канал ввода перезапуск Hub не переживает: ход дочитывается, но отправка
    // в него уже недоступна.
    Object.assign(run, {
      process: null,
      claudeInput: null,
      claudeInputClosed: true,
      claudeSteer: null,
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

  async #lookupFingerprint(pid) {
    try {
      return await this.processFingerprintLookup(pid);
    } catch {
      return null;
    }
  }

  async #ownsProcess(run, pid) {
    const expected = run?.claudeProcessFingerprint;
    if (!expected) return false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.#lookupFingerprint(pid);
      if (current) return processFingerprintMatches(expected, current);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 75));
    }
    return false;
  }

  async #lookupFingerprintWithRetry(pid) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.#lookupFingerprint(pid);
      if (current) return current;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 75));
    }
    return null;
  }

  #ownsCurrentChild(run, pid) {
    const child = run?.process;
    return Number(child?.pid) === pid && child?.exitCode == null;
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
