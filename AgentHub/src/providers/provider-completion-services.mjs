import { unlink } from "node:fs/promises";

import { isClaudeCompactionRun } from "../domain/claude-context-maintenance.mjs";
import { claudeFailureMessage, formatClaudeUsage } from "./claude/claude.mjs";
import { TASK_EXECUTION_OWNERS } from "../domain/task-execution-owner.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class CodexCompletionService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "runForTask", "consumeTracker", "waitForCompletion", "finalizeDelivery", "finishProgress",
      "completedAnswer", "rememberSeenTurn", "rememberLastMessage",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async completeObserved(run, { snapshot, answer, deliver, completedTurnId, tracker }) {
    run.status = "finishing";
    await this.#d.rememberSeenTurn(run, completedTurnId);
    this.#rememberTerminalAnswer(run, completedTurnId, answer, snapshot);
    const resolvedTracker = tracker ?? this.#d.consumeTracker(completedTurnId);
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
    const answer = String(snapshot?.finalAnswer ?? "").trim()
      || String(snapshot?.answer ?? "").trim()
      || run.responseText.trim()
      || "Ход завершён без текстового ответа.";
    this.#rememberTerminalAnswer(run, completedTurnId, answer, snapshot);
    const tracker = this.#d.consumeTracker(completedTurnId);
    const forceSpeechButton = await this.#releaseTurnResources(completedTurnId);
    await this.#d.finishProgress(run, snapshot?.stage ?? "Поток завершён.");
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
    const status = eventTurn?.status ?? "completed";
    const error = eventTurn?.error?.message;
    const answer = await this.#d.completedAnswer(run, completedTurnId, eventTurn)
      || (error ? `Ошибка: ${error}` : `Поток завершён: ${status}`);
    this.#rememberTerminalAnswer(run, completedTurnId, answer, eventTurn);
    const tracker = this.#d.consumeTracker(completedTurnId);
    const forceSpeechButton = await this.#releaseTurnResources(completedTurnId);
    await this.#d.finishProgress(
      run,
      error || status === "failed"
        ? `Поток завершился с ошибкой: ${error ?? status}`
        : "Поток завершён.",
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

  #rememberTerminalAnswer(run, turnId, answer, completion = null) {
    const completedAtMs = Number(run?.providerStart?.completedAtMs);
    const updatedAt = completion?.completedAt
      ?? (Number.isFinite(completedAtMs) ? new Date(completedAtMs).toISOString() : null);
    this.#d.rememberLastMessage({ ...run, turnId }, answer, { updatedAt });
  }

  async #releaseTurnResources(turnId) {
    const files = this.#d.temporaryFiles.get(turnId) ?? [];
    this.#d.temporaryFiles.delete(turnId);
    const forceSpeechButton = this.#d.speechButtons.get(turnId) ?? false;
    this.#d.speechButtons.delete(turnId);
    await Promise.all(files.map((file) => (this.#d.removeFile ?? ((value) => unlink(value).catch(() => {})))(file)));
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
    // Свёртка контекста — служебный ход Hub: у неё нет ответа, поэтому она не
    // попадает ни в историю задачи, ни в доставку.
    if (isClaudeCompactionRun(run)) return this.#completeCompaction(run);
    const turnId = run.turnId;
    const files = this.#d.temporaryFiles.get(turnId) ?? run.claudeTemporaryFiles ?? [];
    this.#d.temporaryFiles.delete(turnId);
    run.claudeTemporaryFiles = [];
    await Promise.all(files.map((file) => (this.#d.removeFile ?? ((value) => unlink(value).catch(() => {})))(file)));
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
        if (!run.taskTitle || ["Новая задача Claude", "Новый поток Claude"].includes(run.taskTitle)) {
          run.taskTitle = `Сессия Claude · ${result.session_id.slice(0, 8)}`;
        }
        this.#d.reindexRun(run, { threadId: previousThreadId });
        if (wasSelected) this.#d.setSelectedThread(result.session_id, run.taskTitle);
        await this.#d.saveState();
      }
      const failed = (exitCode !== null && exitCode !== 0) || result.is_error === true;
      const answer = failed
        ? claudeFailureMessage(result, { streamFailureText: run.claudeFailureText, errorText, exitCode })
        : String(result.result ?? "").trim() || "Поток завершён.";
      if (failed) this.#d.logError?.(`Claude turn ${run.turnId ?? "unknown"} failed: ${answer}`);
      await this.#d.finishProgress(run, failed ? `Claude остановлен: ${answer}` : "Поток завершён.");
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

  async #completeCompaction(run) {
    try {
      this.#d.settleCompaction?.(run);
    } catch (error) {
      this.#d.logError?.(`Cannot settle Claude context compaction ${run.turnId}:`, error.message);
    }
    await this.#d.completeMaintenanceRun?.(run);
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
