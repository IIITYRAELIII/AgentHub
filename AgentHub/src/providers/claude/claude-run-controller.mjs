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
  providerOwnershipLaunch,
  readOwnedProcessTree,
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
    processTreeLookup = readOwnedProcessTree,
    processTreeFingerprintLookup = null,
    stopProcess = stopProcessTree,
    completionExitGraceMs = 750,
    completionStopTimeoutMs = 3_000,
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
    this.processTreeLookup = processTreeLookup;
    this.processTreeFingerprintLookup = processTreeFingerprintLookup
      ?? (processTreeLookup === readOwnedProcessTree ? readProcessFingerprint : processFingerprintLookup);
    this.stopProcess = stopProcess;
    this.completionExitGraceMs = completionExitGraceMs;
    this.completionStopTimeoutMs = completionStopTimeoutMs;
  }

  async start(run, { command, args, cwd, env, input = null }) {
    this.processAuthority?.started(run);
    const output = await openClaudeRunOutput(this.dataDir, run.turnId);
    Object.assign(run, {
      claudeOutputPath: output.outputPath,
      claudeErrorPath: output.errorPath,
      claudeProcessOwnerPath: output.ownerPath,
      claudeProcessOwnerToken: randomUUID(),
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
      run.claudeProcessStartedAtMs = Date.now();
      const launch = providerOwnershipLaunch({
        command,
        args,
        ownerPath: run.claudeProcessOwnerPath,
        ownerToken: run.claudeProcessOwnerToken,
      });
      worker = spawnClaudeWorker({
        command: launch.command,
        args: launch.args,
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
          run.claudeProcessExitedAtMs = Date.now();
          if (callbacksEnabled) void this.drain(run);
        },
      });
      run.process = worker;
      run.pid = worker.pid ?? null;
      // Capture the root identity before releasing the output handles. A very
      // short provider can write its result and exit in the next turn; after
      // that point only this fingerprint can bind its surviving descendants.
      run.claudeProcessFingerprint = await this.#lookupFingerprintWithRetry(run.pid);
      run.claudeOwnedProcessTree = run.claudeProcessFingerprint ? [run.claudeProcessFingerprint] : [];
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
    const outputPaths = {
      outputPath: run.claudeOutputPath,
      errorPath: run.claudeErrorPath,
      ownerPath: run.claudeProcessOwnerPath,
    };
    const exitCode = Number.isInteger(run.claudeExitCode) ? run.claudeExitCode : null;
    const result = spawnError ? null : await this.#readResult(run);
    // Claude may return an is_error JSON result while writing the useful
    // diagnostic only to stderr. Keep both channels until completion handling.
    const errorText = await this.#readError(run);
    try {
      await this.#settleOwnedProcess(run);
    } catch (error) {
      // A terminal provider result does not release ownership of a process
      // tree which still holds the run directory. Keep the exact run alive so
      // cancellation/shutdown can retry the bounded stop safely.
      run.claudeSettled = false;
      run.claudeCleanupPending = true;
      await this.onPersist(run).catch(() => {});
      this.onReadError(run, error);
      return;
    }
    try {
      await this.onComplete(run, { spawnError, result, errorText, exitCode, outputPaths });
    } finally {
      await removeClaudeRunOutput(outputPaths);
    }
  }

  async #settleOwnedProcess(run) {
    const pid = Number(run.pid ?? run.process?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      run.process = null;
      run.claudeCleanupPending = false;
      return;
    }
    const gracefulExitMs = this.isStopping() ? 0 : this.completionExitGraceMs;
    if (await this.#waitForOwnedTreeExit(run, gracefulExitMs)) {
      run.claudeStopAttempt = null;
      run.claudeStopUnknown = false;
      run.claudeStopTargets = null;
      run.process = null;
      run.claudeCleanupPending = false;
      return;
    }
    const deadline = Date.now() + Math.max(1, Number(this.completionStopTimeoutMs) || 1);
    const stopped = await this.#stopOwnedTree(run, deadline);
    if (stopped !== true) {
      throw new Error(stopped === null
        ? `Completed Claude process tree ${pid} stop outcome is still unknown`
        : `Cannot stop completed Claude process tree ${pid}`);
    }
    if (!await this.#waitForOwnedTreeExit(run, Math.max(0, deadline - Date.now()))) {
      run.claudeStopAttempt = null;
      const remaining = await this.#currentOwnedTree(run);
      const identities = Array.isArray(remaining) ? remaining.map((item) => Number(item.pid)).join(",") : "unknown";
      throw new Error(
        `Completed Claude process tree ${pid} did not terminate; remaining=${identities}; stop=${run.claudeStopDiagnostic ?? "accepted"}`,
      );
    }
    run.claudeStopAttempt = null;
    run.claudeStopUnknown = false;
    run.claudeStopTargets = null;
    run.process = null;
    run.claudeCleanupPending = false;
  }

  async #waitForOwnedTreeExit(run, timeoutMs) {
    const durationMs = Math.max(0, Number(timeoutMs) || 0);
    const deadline = Date.now() + durationMs;
    const rootPid = Number(run?.pid ?? run?.process?.pid);
    if (durationMs === 0 && this.#ownsCurrentChild(run, rootPid) && this.processAlive(rootPid)) return false;
    do {
      const owned = await this.#currentOwnedTree(run);
      if (owned == null) throw new Error(
        `Cannot verify Claude process tree ${run.pid}: ${run.claudeOwnershipDiagnostic ?? "ownership probe failed"}`,
      );
      if (owned.length === 0) {
        run.claudeExited = true;
        return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
    } while (Date.now() < deadline);
    return false;
  }

  async #currentOwnedTree(run) {
    await this.#refreshProviderOwner(run);
    const pid = Number(run?.pid ?? run?.process?.pid);
    const root = run?.claudeProcessFingerprint ?? (Number.isInteger(pid) && pid > 0 ? {
      pid,
      startedAtMs: Number(run?.claudeProcessStartedAtMs) || null,
      exitedAtMs: Number(run?.claudeProcessExitedAtMs) || null,
    } : null);
    if (!root) {
      if (this.#ownsCurrentChild(run, pid) && this.processAlive(pid)) return [{ pid, currentChild: true }];
      run.claudeOwnershipDiagnostic = "root-fingerprint-unavailable";
      return null;
    }
    let current;
    try {
      current = await this.processTreeLookup(root, run.claudeOwnedProcessTree ?? [], {
        rootExited: run.claudeExited === true || run.process?.exitCode != null || run.process?.signalCode != null,
        rootHandleOwned: this.#ownsCurrentChild(run, pid),
      });
    } catch (error) {
      run.claudeOwnershipDiagnostic = `tree-probe-error:${error?.message ?? error}`;
      return null;
    }
    if (!Array.isArray(current)) {
      run.claudeOwnershipDiagnostic = "tree-probe-unavailable";
      return null;
    }
    if (!current.some((item) => Number(item.pid) === pid) && this.processAlive(pid)) {
      if (this.#ownsCurrentChild(run, pid)) current.push({ ...root, currentChild: true });
      else if (run.claudeExited === true || run.process?.exitCode != null || run.process?.signalCode != null) {
        // The exact child handle is terminal. A live numeric root PID may now
        // belong to another process; descendants were already bounded by the
        // captured start/exit interval and the reused root itself is ignored.
        const exactRoot = await this.#lookupFingerprint(pid);
        run.claudeRootPidReused = !exactRoot || !processFingerprintMatches(root, exactRoot);
      }
      else {
        const exactRoot = await this.#lookupFingerprint(pid);
        if (exactRoot && processFingerprintMatches(root, exactRoot)) current.push(exactRoot);
        else {
          run.claudeOwnershipDiagnostic = "root-identity-mismatch";
          return null;
        }
      }
    }
    const known = new Map((run.claudeOwnedProcessTree ?? []).map((item) => [Number(item.pid), item]));
    for (const item of current) known.set(Number(item.pid), item);
    const next = [...known.values()].filter((item) => Number.isInteger(Number(item?.pid)) && Number(item.pid) > 0);
    if (next.length !== (run.claudeOwnedProcessTree ?? []).length) {
      run.claudeOwnedProcessTree = next;
      await this.onPersist(run).catch(() => {});
    }
    return current;
  }

  async #refreshProviderOwner(run) {
    if (!run?.claudeProcessOwnerPath || !run?.claudeProcessOwnerToken) return;
    let value;
    try {
      value = JSON.parse(await readFile(run.claudeProcessOwnerPath, "utf8"));
    } catch {
      return;
    }
    const pid = Number(value?.pid);
    if (value?.token !== run.claudeProcessOwnerToken || !Number.isInteger(pid) || pid <= 0) return;
    const existing = (run.claudeOwnedProcessTree ?? []).find((item) => Number(item?.pid) === pid);
    const startedAtMs = Number(value.startedAtMs);
    const exitedAtMs = Number(value.exitedAtMs);
    const rootTerminal = run.claudeExited === true
      || run.process?.exitCode != null
      || run.process?.signalCode != null;
    let owner = existing;
    if (!owner?.creationTime) {
      const exact = await this.#lookupTreeFingerprint(pid);
      const exactCreatedAtMs = Date.parse(exact?.creationTime);
      const exactBelongsToLifetime = exact
        && Number.isFinite(exactCreatedAtMs)
        && (!Number.isFinite(startedAtMs) || exactCreatedAtMs >= startedAtMs - 1_000)
        && (!Number.isFinite(exitedAtMs) || exactCreatedAtMs <= exitedAtMs)
        && (!rootTerminal || Number.isFinite(exitedAtMs));
      owner = exactBelongsToLifetime ? exact : {
        pid,
        startedAtMs: startedAtMs || null,
        exitedAtMs: exitedAtMs || null,
      };
    }
    if (startedAtMs > 0) owner.startedAtMs = startedAtMs;
    if (exitedAtMs > 0) owner.exitedAtMs = exitedAtMs;
    const known = new Map((run.claudeOwnedProcessTree ?? []).map((item) => [Number(item.pid), item]));
    known.set(pid, owner);
    run.claudeOwnedProcessTree = [...known.values()];
  }

  async #stopOwnedTree(run, deadline) {
    let attempt = run.claudeStopAttempt;
    if (!attempt && run.claudeStopUnknown === true) return null;
    if (!attempt) {
      const rootPid = Number(run?.pid ?? run?.process?.pid);
      const owned = this.#ownsCurrentChild(run, rootPid) && this.processAlive(rootPid)
        ? [{ pid: rootPid, currentChild: true }]
        : await this.#currentOwnedTree(run);
      if (owned == null) return false;
      if (owned.length === 0) return run.claudeRootPidReused === true ? false : true;
      const targets = [...owned].sort((left, right) => Number(right.pid) - Number(left.pid));
      attempt = { state: "pending", targets: targets.map((item) => ({ ...item })) };
      run.claudeStopAttempt = attempt;
      run.claudeStopUnknown = true;
      run.claudeStopTargets = attempt.targets.map((item) => ({ ...item }));
      attempt.promise = (async () => {
        // Persist the exact admitted targets and unknown-outcome fence before
        // the first external stop effect. A restart may verify terminal state,
        // but cannot dispatch a second killer for this intent.
        await this.onPersist(run);
        for (const target of targets) {
          const pid = Number(target.pid);
          if (!target.currentChild) {
            const current = await this.#lookupTreeFingerprint(pid);
            if (!current) {
              if (this.processAlive(pid)) {
                run.claudeStopDiagnostic = `fingerprint-unavailable:${pid}`;
                return false;
              }
              continue;
            }
            if (!processFingerprintMatches(target, current)) {
              const normalized = (value) => String(value ?? "").replace(/\0/gu, " ").replace(/\s+/gu, " ").trim();
              run.claudeStopDiagnostic = `fingerprint-mismatch:${pid}:creation=${normalized(target.creationTime) === normalized(current.creationTime)}:executable=${normalized(target.executablePath).toLowerCase() === normalized(current.executablePath).toLowerCase()}:command=${normalized(target.commandLine) === normalized(current.commandLine)}`;
              continue;
            }
          } else if (!this.#ownsCurrentChild(run, pid)) {
            continue;
          }
          if (await this.stopProcess(pid) !== true) return false;
        }
        return true;
      })();
      attempt.promise.then((value) => {
        attempt.state = "settled";
        attempt.value = value === true;
        if (run.claudeCleanupPending) void this.complete(run);
      }, (error) => {
        attempt.state = "settled";
        attempt.error = error;
        if (run.claudeCleanupPending) void this.complete(run);
      });
    }
    if (attempt.state === "settled") {
      if (attempt.error) throw attempt.error;
      return attempt.value === true;
    }
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) return null;
    const timeout = Symbol("stop-timeout");
    const outcome = await Promise.race([
      attempt.promise,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(timeout), remainingMs);
        timer.unref?.();
      }),
    ]);
    if (outcome === timeout) {
      run.claudeStopUnknown = true;
      return null;
    }
    return outcome === true;
  }

  async stop(run) {
    if (!run) return false;
    if (this.processAuthority && !this.processAuthority.owns(run)) return false;
    const deadline = Date.now() + Math.max(1, Number(this.completionStopTimeoutMs) || 1);
    return (await this.#stopOwnedTree(run, deadline)) === true;
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

  async #lookupTreeFingerprint(pid) {
    try {
      return await this.processTreeFingerprintLookup(pid);
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
    return run?.claudeExited !== true
      && Number(child?.pid) === pid
      && child?.exitCode == null
      && child?.signalCode == null;
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
