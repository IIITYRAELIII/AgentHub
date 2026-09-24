import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const EOL = String.fromCharCode(10);
const PROVIDER_CAPTURE_INTERVAL_MS = 2_000;
// Each capture attempt reads the process table; stop polling after about a minute.
const PROVIDER_CAPTURE_MAX_ATTEMPTS = 30;
const STOP_INTENT_RETRY_MAX_MS = 30_000;

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
  #preDispatchStopFailures = new WeakSet();
  #stopIntentRetryCounts = new WeakMap();
  #providerCaptureSchedule = new WeakMap();
  #lineagePersistence = new WeakMap();
  #unresolvedOwnership = new WeakSet();
  #transientOwnershipProbe = new WeakSet();
  #ownershipRecheckCounts = new WeakMap();

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
      if (process.platform === "win32") await this.#captureProviderOwnerWithRetry(run);
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
    if (processGone && run.claudeExited !== true && Number.isInteger(Number(run.pid))) {
      // A restored run has no ChildProcess exit callback. Once the exact PID is
      // authoritatively absent, persist the observation as the upper bound of
      // its lifetime so ownership classification can prove an empty tree. A
      // live reused PID never reaches this branch and remains fail-closed.
      run.claudeExited = true;
      run.claudeProcessExitedAtMs = Date.now();
      await this.onPersist(run).catch(() => {});
    }
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
    await this.#captureProviderOwnerWhileLive(run);
    if (run.claudeSettled || !this.isCurrentRun(run)) return;
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
      if (this.#preDispatchStopFailures.delete(run)) this.#scheduleStopIntentRetry(run);
      else if (this.#unresolvedOwnership.has(run) || this.#transientOwnershipProbe.has(run)) {
        this.#scheduleOwnershipRecheck(run);
      }
      return;
    }
    this.#ownershipRecheckCounts.delete(run);
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
      // Defensive: the classifier reports an unresolved tree without exact
      // targets as null; an injected lookup must not turn it into success.
      if (owned.length === 0 && owned.unresolved !== true) {
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
    const root = this.#runRootFingerprint(run);
    if (!root) {
      if (this.#ownsCurrentChild(run, pid) && this.processAlive(pid)) return [{ pid, currentChild: true }];
      run.claudeOwnershipDiagnostic = "root-fingerprint-unavailable";
      return null;
    }
    let current;
    const diagnostics = { unresolved: null };
    this.#unresolvedOwnership.delete(run);
    this.#transientOwnershipProbe.delete(run);
    try {
      current = await this.processTreeLookup(root, run.claudeOwnedProcessTree ?? [], {
        rootExited: run.claudeExited === true || run.process?.exitCode != null || run.process?.signalCode != null,
        rootHandleOwned: this.#ownsCurrentChild(run, pid),
        diagnostics,
      });
    } catch (error) {
      run.claudeOwnershipDiagnostic = `tree-probe-error:${error?.message ?? error}`;
      this.#transientOwnershipProbe.add(run);
      return null;
    }
    if (!Array.isArray(current)) {
      if (this.#ownsCurrentChild(run, pid) && this.processAlive(pid)) {
        current = [{ ...root, currentChild: true }];
      } else {
        const exactRoot = this.processAlive(pid) ? await this.#lookupFingerprint(pid) : null;
        if (exactRoot && processFingerprintMatches(root, exactRoot)) current = [exactRoot];
        else if (diagnostics.unresolved) {
          // An authoritative snapshot proved ancestry ambiguous; it did not fail.
          run.claudeOwnershipDiagnostic = `ownership-unresolved:${diagnostics.unresolved}`;
          this.#unresolvedOwnership.add(run);
          return null;
        } else {
          run.claudeOwnershipDiagnostic = "tree-probe-unavailable";
          this.#transientOwnershipProbe.add(run);
          return null;
        }
      }
    }
    if (!current.some((item) => Number(item.pid) === pid) && this.processAlive(pid)) {
      if (this.#ownsCurrentChild(run, pid)) current.push({ ...root, currentChild: true });
      else if (run.claudeExited === true || run.process?.exitCode != null || run.process?.signalCode != null) {
        // The exact child handle is terminal. A live numeric root PID may now
        // belong to another process; the classifier never owns that holder and
        // resolves its children by the recorded lifetime and holder creation.
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
    if (!run?.claudeProcessOwnerPath || !run?.claudeProcessOwnerToken) return false;
    let value;
    try {
      value = JSON.parse(await readFile(run.claudeProcessOwnerPath, "utf8"));
    } catch {
      return false;
    }
    const pid = Number(value?.pid);
    if (value?.token !== run.claudeProcessOwnerToken || !Number.isInteger(pid) || pid <= 0) return false;
    const existing = (run.claudeOwnedProcessTree ?? []).find((item) => Number(item?.pid) === pid);
    const startedAtMs = Number(value.startedAtMs);
    const exitedAtMs = Number(value.exitedAtMs);
    const rootExitedAtMs = Number(run.claudeProcessExitedAtMs);
    const ownershipUpperBoundMs = Number.isFinite(exitedAtMs) && exitedAtMs > 0
      ? exitedAtMs
      : rootExitedAtMs;
    let owner = existing?.launchLineageVerified === true && existing?.creationTime ? existing : null;
    if (!owner) {
      const root = this.#runRootFingerprint(run);
      const rootPid = Number(root?.pid);
      const rootHandleOwned = this.#ownsCurrentChild(run, rootPid) && this.processAlive(rootPid);
      const exactRoot = rootHandleOwned ? root : await this.#lookupFingerprint(rootPid);
      const rootLive = root && exactRoot && processFingerprintMatches(root, exactRoot);
      if (rootLive) {
        let liveTree;
        try {
          liveTree = await this.processTreeLookup(root, [], {
            rootExited: false,
            rootHandleOwned,
          });
        } catch {
          liveTree = null;
        }
        const exact = Array.isArray(liveTree)
          ? liveTree.find((item) => Number(item?.pid) === pid)
          : null;
        const exactCreatedAtMs = Date.parse(exact?.creationTime);
        if (exact && Number.isFinite(exactCreatedAtMs)
          && (!Number.isFinite(startedAtMs) || exactCreatedAtMs >= startedAtMs - 1_000)) {
          owner = { ...exact, launchLineageVerified: true };
        }
      }
    }
    if (owner?.creationTime) {
      const ownerCreatedAtMs = Date.parse(owner.creationTime);
      const withinLowerBound = !Number.isFinite(startedAtMs) || ownerCreatedAtMs >= startedAtMs - 1_000;
      const withinUpperBound = !Number.isFinite(ownershipUpperBoundMs)
        || ownershipUpperBoundMs <= 0
        || ownerCreatedAtMs <= ownershipUpperBoundMs;
      if (!Number.isFinite(ownerCreatedAtMs) || !withinLowerBound || !withinUpperBound) owner = null;
    }
    if (!owner) {
      owner = {
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
    return owner.launchLineageVerified === true;
  }

  async #captureProviderOwnerWithRetry(run) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await this.#refreshProviderOwner(run)) return true;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  #providerLineageVerified(run) {
    return (run?.claudeOwnedProcessTree ?? [])
      .some((item) => item?.launchLineageVerified === true && item?.creationTime);
  }

  // The launch window may close before the wrapper writes its sidecar. While the
  // exact root is still alive, keep retrying the same live-ancestry capture from
  // the ordinary poll, rate-limited because each attempt reads the process table.
  async #captureProviderOwnerWhileLive(run) {
    if (process.platform !== "win32") return;
    if (!run?.claudeProcessOwnerPath || !run?.claudeProcessOwnerToken) return;
    if (this.#providerLineageVerified(run)) {
      // Captured in memory is not durable: keep saving the same exact identity
      // until one write succeeds, so a Hub restart cannot lose the only proof.
      await this.#persistCapturedLineage(run);
      return;
    }
    const now = Date.now();
    const schedule = this.#providerCaptureSchedule.get(run) ?? { nextAtMs: 0, attempts: 0 };
    if (now < schedule.nextAtMs || schedule.attempts >= PROVIDER_CAPTURE_MAX_ATTEMPTS) return;
    this.#providerCaptureSchedule.set(run, {
      nextAtMs: now + PROVIDER_CAPTURE_INTERVAL_MS,
      attempts: schedule.attempts + 1,
    });
    let verified = false;
    try {
      verified = await this.#refreshProviderOwner(run);
    } catch {
      return;
    }
    if (verified) {
      this.#lineagePersistence.set(run, { nextAtMs: 0, attempts: 0 });
      await this.#persistCapturedLineage(run);
    }
  }

  // Durable-save retry for an already captured exact provider identity. It never
  // captures a new identity and never dispatches any process effect.
  async #persistCapturedLineage(run) {
    const pending = this.#lineagePersistence.get(run);
    if (!pending) return;
    const now = Date.now();
    if (now < pending.nextAtMs) return;
    try {
      await this.onPersist(run);
      this.#lineagePersistence.delete(run);
    } catch {
      const attempts = pending.attempts + 1;
      this.#lineagePersistence.set(run, {
        attempts,
        nextAtMs: now + this.#stopIntentRetryDelayMs(attempts),
      });
    }
  }

  // The rejected stop-intent persistence is conclusively pre-effect. Keep a
  // canonical poll with bounded backoff so storage that recovers later still
  // finishes cleanup without cancellation, shutdown or a restart.
  #scheduleStopIntentRetry(run) {
    const retry = (this.#stopIntentRetryCounts.get(run) ?? 0) + 1;
    this.#stopIntentRetryCounts.set(run, retry);
    this.schedule(run, this.#stopIntentRetryDelayMs(retry));
  }

  // Authoritative ownership ambiguity can only clear through a later snapshot.
  // Re-run the canonical completion with bounded backoff on the single drain
  // timer; it re-reads the tree and reuses the settled stop attempt and its
  // unknown-outcome fence, so it never dispatches a second killer.
  #scheduleOwnershipRecheck(run) {
    const retry = (this.#ownershipRecheckCounts.get(run) ?? 0) + 1;
    this.#ownershipRecheckCounts.set(run, retry);
    this.schedule(run, this.#stopIntentRetryDelayMs(retry));
  }

  #stopIntentRetryDelayMs(retry) {
    const base = Math.max(1, Math.min(Number(this.pollIntervalMs) || 250, 250));
    return Math.min(STOP_INTENT_RETRY_MAX_MS, base * (2 ** Math.min(Math.max(0, retry - 1), 16)));
  }

  #runRootFingerprint(run) {
    const pid = Number(run?.pid ?? run?.process?.pid);
    const storedRoot = run?.claudeProcessFingerprint ?? (Number.isInteger(pid) && pid > 0 ? { pid } : null);
    const startedAtMs = Number(run?.claudeProcessStartedAtMs);
    const exitedAtMs = Number(run?.claudeProcessExitedAtMs);
    return storedRoot ? {
      ...storedRoot,
      startedAtMs: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : storedRoot.startedAtMs,
      exitedAtMs: Number.isFinite(exitedAtMs) && exitedAtMs > 0 ? exitedAtMs : storedRoot.exitedAtMs,
    } : null;
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
      attempt = { state: "pending", dispatched: false, targets: targets.map((item) => ({ ...item })) };
      run.claudeStopAttempt = attempt;
      run.claudeStopUnknown = true;
      run.claudeStopTargets = attempt.targets.map((item) => ({ ...item }));
      attempt.promise = (async () => {
        // Persist the exact admitted targets and unknown-outcome fence before
        // the first external stop effect. A restart may verify terminal state,
        // but cannot dispatch a second killer for this intent.
        await this.onPersist(run);
        this.#stopIntentRetryCounts.delete(run);
        attempt.dispatched = true;
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
        const preDispatchFailure = attempt.dispatched !== true;
        if (preDispatchFailure) this.#preDispatchStopFailures.add(run);
        if (preDispatchFailure && run.claudeStopAttempt === attempt) {
          // Persistence failed before any process effect was dispatched. This
          // is a known rejection, not an unknown stop outcome, so a later
          // completion may persist a fresh intent after storage recovers.
          run.claudeStopAttempt = null;
          run.claudeStopUnknown = false;
          run.claudeStopTargets = null;
        }
        // A rejection that lands after the stop deadline arrives when complete()
        // has already returned: it must drive the same backoff retry itself.
        // While complete() is still settling, its catch consumes the flag.
        if (preDispatchFailure && !run.claudeSettled && run.claudeCleanupPending) {
          this.#preDispatchStopFailures.delete(run);
          this.#scheduleStopIntentRetry(run);
        }
        if (!preDispatchFailure && run.claudeCleanupPending) void this.complete(run);
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
