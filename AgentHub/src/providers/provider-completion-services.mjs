import { unlink } from "node:fs/promises";
import { claudeFailureMessage, formatClaudeUsage } from "./claude/claude.mjs";
import { TASK_EXECUTION_OWNERS } from "../domain/task-execution-owner.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function trackerFromUsageResult(usageResult) {
  return {
    usage: usageResult?.usage,
    reported: usageResult?.reported === true,
    imageGenerationCount: usageResult?.imageGenerationCount,
    estimatedCredits: usageResult?.estimatedCredits,
    estimateKind: usageResult?.estimateKind,
    model: usageResult?.model,
    serviceTier: usageResult?.serviceTier,
    skillsUsed: usageResult?.skillsUsed,
    mcpCalls: usageResult?.mcpCalls,
    toolMetricsKnown: usageResult?.toolMetricsKnown,
  };
}

export class CodexCompletionService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "runForTask", "consumeTracker", "waitForCompletion", "readThread",
      "readTurnUsage", "applyRolloutContext", "finalizeDelivery", "finishProgress",
      "completedAnswer",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async completeObserved(run, { snapshot, answer, deliver, completedTurnId, tracker }) {
    run.status = "finishing";
    let resolvedTracker = tracker ?? this.#d.consumeTracker(completedTurnId);
    if (run.executionOwner !== TASK_EXECUTION_OWNERS.HUB) {
      const hooked = await this.#d.waitForCompletion({
        provider: "codex",
        threadId: run.threadId,
        turnId: completedTurnId,
      });
      if (hooked?.usageReported || Number(hooked?.estimatedCredits) > 0) {
        resolvedTracker = {
          usage: hooked.usage,
          reported: hooked.usageReported === true,
          estimatedCredits: hooked.estimatedCredits,
          estimateKind: hooked.estimateKind,
          model: hooked.model,
          serviceTier: hooked.serviceTier,
          skillsUsed: hooked.skillsUsed,
          mcpCalls: hooked.mcpCalls,
          toolMetricsKnown: hooked.toolMetricsKnown,
        };
      }
    }
    resolvedTracker = await this.#resolvePricing(run, completedTurnId, resolvedTracker);
    return this.#d.finalizeDelivery(run, {
      answer,
      turnId: completedTurnId,
      status: snapshot?.status ?? "completed",
      tracker: resolvedTracker,
      deliver,
      silent: run.displayRequested !== true,
      description: "финальный ответ наблюдаемого хода",
    });
  }

  async finishManagedSnapshot(run, snapshot) {
    if (this.#d.runForTask(run) !== run || run.status !== "running") return;
    run.status = "finishing";
    const completedTurnId = run.turnId;
    let tracker = this.#d.consumeTracker(completedTurnId);
    tracker = await this.#resolvePricing(run, completedTurnId, tracker);
    const forceSpeechButton = await this.#releaseTurnResources(completedTurnId);
    const answer = String(snapshot?.finalAnswer ?? "").trim()
      || String(snapshot?.answer ?? "").trim()
      || run.responseText.trim()
      || "Ход завершён без текстового ответа.";
    await this.#d.finishProgress(run, snapshot?.stage ?? "Задача завершена.");
    await this.#d.finalizeDelivery(run, {
      answer,
      turnId: completedTurnId,
      status: snapshot?.status ?? "completed",
      tracker,
      forceSpeechButton,
      description: "восстановленный финальный ответ Codex",
    });
  }

  async completeManaged(run, {
    snapshot = null,
    eventTurn = null,
    completedTurnId = eventTurn?.id ?? run?.turnId,
  } = {}) {
    if (snapshot) return this.finishManagedSnapshot(run, snapshot);
    if (this.#d.runForTask(run) !== run || run.status !== "running") return;
    run.status = "finishing";
    let tracker = this.#d.consumeTracker(completedTurnId);
    tracker = await this.#resolvePricing(run, completedTurnId, tracker);
    const forceSpeechButton = await this.#releaseTurnResources(completedTurnId);
    const status = eventTurn?.status ?? "completed";
    const error = eventTurn?.error?.message;
    const answer = await this.#d.completedAnswer(run, completedTurnId, eventTurn)
      || (error ? `Ошибка: ${error}` : `Задача завершена: ${status}`);
    await this.#d.finishProgress(
      run,
      error || status === "failed"
        ? `Задача завершилась с ошибкой: ${error ?? status}`
        : "Задача завершена.",
    );
    return this.#d.finalizeDelivery(run, {
      answer,
      turnId: completedTurnId,
      status,
      tracker,
      forceSpeechButton,
      description: "финальный ответ Codex",
    });
  }

  async #resolvePricing(run, turnId, tracker) {
    if (String(tracker?.model ?? "").trim() && run?.rolloutChangeTrackingKnown === true) return tracker;
    try {
      const result = await this.#d.readThread(run.threadId, { fresh: true, includeTurns: false });
      const usageResult = await this.#d.readTurnUsage(result.thread?.path, turnId);
      this.#d.applyRolloutContext(run, usageResult);
      if (usageResult?.model) {
        const fromRollout = trackerFromUsageResult(usageResult);
        return fromRollout.reported || !tracker?.reported
          ? fromRollout
          : { ...tracker, ...fromRollout, usage: tracker.usage, reported: tracker.reported };
      }
    } catch (error) {
      this.#d.logError?.(`Cannot resolve rollout metadata for Codex turn ${turnId}:`, error.message);
    }
    return tracker;
  }

  async #releaseTurnResources(turnId) {
    const files = this.#d.temporaryFiles.get(turnId) ?? [];
    this.#d.temporaryFiles.delete(turnId);
    const forceSpeechButton = this.#d.speechButtons.get(turnId) ?? false;
    this.#d.speechButtons.delete(turnId);
    await Promise.all(files.map((file) => unlink(file).catch(() => {})));
    return forceSpeechButton;
  }
}

export class ClaudeCompletionService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "runForTask", "isSelectedRun", "reindexRun", "setSelectedThread", "saveState",
      "finishProgress", "persistHistory", "projectWorkLog", "finalizeDelivery",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async completeObserved(run, { snapshot, answer, deliver }) {
    await this.#d.projectWorkLog(run, {
      answer,
      status: snapshot?.status ?? "completed",
      snapshot,
    }).catch((error) => {
      this.#d.logError?.(`Cannot update journal for observed Claude turn ${run.turnId}:`, error.message);
    });
    return this.#d.finalizeDelivery(run, {
      answer,
      deliver,
      silent: run.displayRequested !== true,
      description: "финальный ответ наблюдаемого хода",
    });
  }

  async completeManaged(run, { spawnError = null, result, errorText = "", exitCode = null } = {}) {
    if (!run) return;
    const turnId = run.turnId;
    const files = this.#d.temporaryFiles.get(turnId) ?? run.claudeTemporaryFiles ?? [];
    this.#d.temporaryFiles.delete(turnId);
    run.claudeTemporaryFiles = [];
    await Promise.all(files.map((file) => unlink(file).catch(() => {})));
    const forceSpeechButton = run.claudeForceSpeechButton === true;
    try {
      if (spawnError) throw spawnError;
      if (!result) {
        throw new Error(run.claudeFailureText || errorText || (exitCode === null
          ? "Claude Code завершился, не вернув результат"
          : `Claude Code завершился с кодом ${exitCode}`));
      }
      if (result.session_id) {
        const previousThreadId = run.threadId;
        const wasSelected = this.#d.isSelectedRun(run);
        run.threadId = result.session_id;
        run.sessionId = result.session_id;
        if (!run.taskTitle || run.taskTitle === "Новая задача Claude") {
          run.taskTitle = `Сессия Claude · ${result.session_id.slice(0, 8)}`;
        }
        this.#d.reindexRun(run, { threadId: previousThreadId });
        if (wasSelected) this.#d.setSelectedThread(result.session_id, run.taskTitle);
        await this.#d.saveState();
      }
      const failed = (exitCode !== null && exitCode !== 0) || result.is_error === true;
      const answer = failed
        ? claudeFailureMessage(result, { streamFailureText: run.claudeFailureText, errorText, exitCode })
        : String(result.result ?? "").trim() || "Задача завершена.";
      if (failed) this.#d.logError?.(`Claude turn ${run.turnId ?? "unknown"} failed: ${answer}`);
      await this.#d.finishProgress(run, failed ? `Claude остановлен: ${answer}` : "Задача завершена.");
      const response = failed ? `Ошибка Claude Code: ${answer}` : answer;
      await this.#persistAndDeliver(run, {
        response,
        status: failed ? "failed" : "completed",
        result,
        message: `${response}\n\n${formatClaudeUsage(result)}`,
        speechText: answer,
        forceSpeechButton,
        description: "финальный ответ Claude",
      });
    } catch (error) {
      await this.#d.finishProgress(run, `Claude остановлен: ${error.message}`);
      const answer = `Ошибка Claude Code: ${error.message}`;
      await this.#persistAndDeliver(run, {
        response: answer,
        status: "failed",
        description: "ошибка Claude",
      });
    }
  }

  async #persistAndDeliver(run, options) {
    await this.#d.persistHistory(run, { answer: options.response, status: options.status, active: false });
    await this.#d.projectWorkLog(run, {
      answer: options.response,
      status: options.status,
      result: options.result,
    }).catch((error) => {
      this.#d.logError?.(`Cannot update journal for Claude turn ${run.turnId}:`, error.message);
    });
    await this.#d.finalizeDelivery(run, {
      answer: options.response,
      message: options.message,
      speechText: options.speechText,
      forceSpeechButton: options.forceSpeechButton,
      description: options.description,
    });
  }
}
