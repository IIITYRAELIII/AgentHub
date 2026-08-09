import { setTimeout as delay } from "node:timers/promises";
import { codexThreadWaitingOnApproval } from "./codex/codex-approvals.mjs";
import {
  codexThreadHistory,
  codexTurnActivityGroups,
  codexTurnHasExplicitFinalAnswer,
} from "../application/task-history.mjs";
import { replaceRunActivityGroups } from "../domain/run-activity.mjs";
import { resolveTaskRecoveryAction, TASK_RECOVERY_ACTIONS } from "../domain/task-recovery.mjs";
import { emptyTokenUsage } from "../domain/token-usage.mjs";
import { hydrateCodexAgentMessages } from "./codex/codex-agent-message-reducer.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function rememberBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

export class ClaudeRecoveryService {
  #attach;
  #finishInterrupted;

  constructor({ attach, finishInterrupted }) {
    this.#attach = requiredFunction(attach, "attach");
    this.#finishInterrupted = requiredFunction(finishInterrupted, "finishInterrupted");
  }

  async recover(run, { observerSnapshot = null } = {}) {
    const action = resolveTaskRecoveryAction({ run, observerSnapshot });
    if (action === TASK_RECOVERY_ACTIONS.ATTACH_CLAUDE) return this.#attach(run);
    return this.#finishInterrupted(run);
  }
}

export class CodexRecoveryService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "transportRunning", "readTaskSnapshot", "startTransport", "initialize", "isCodex",
      "finishInterrupted", "readThread", "autoApprove", "restartRequested",
      "finishProgress", "completeRun", "recoveredAnswer", "setProgressStage",
      "launchTurn", "reindexRun", "scheduleObservedRun", "startTyping", "saveState",
      "telegram", "consumeTracker", "finalizeDelivery",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  readSnapshot(run) {
    if (!this.#d.transportRunning()) return null;
    return this.#d.readTaskSnapshot(run);
  }

  async prepare(runs) {
    if (!runs.length || this.#d.transportRunning()) return;
    await this.#d.startTransport();
    await this.#d.initialize({ attachSelectedThread: this.#d.isCodex() });
  }

  async recover(run, { observerSnapshot = null } = {}) {
    const d = this.#d;
    const initialAction = resolveTaskRecoveryAction({
      run,
      observerSnapshot,
      codexAvailable: d.transportRunning(),
    });
    if (initialAction === TASK_RECOVERY_ACTIONS.INTERRUPTED_LOCAL) return d.finishInterrupted(run);

    let recoveryResult;
    await d.readThread(run.threadId, {
      fresh: true,
      priority: "interactive",
      applySnapshot: async (snapshot) => {
        recoveryResult = await this.#recoverFromThread(run, snapshot);
      },
    });
    return recoveryResult;
  }

  async #recoverFromThread(run, result) {
    const d = this.#d;
    const turn = result.thread?.turns?.find((item) => item.id === run.turnId) ?? result.thread?.turns?.at(-1);
    hydrateCodexAgentMessages(run, turn?.items, { turnId: turn?.id });
    replaceRunActivityGroups(run, codexTurnActivityGroups(turn));
    const recoveryAction = resolveTaskRecoveryAction({
      run,
      codexAvailable: d.transportRunning(),
      codexTurn: turn,
      waitingOnApproval: codexThreadWaitingOnApproval(result.thread?.status),
      autoApprove: d.autoApprove(),
      restartRequested: d.restartRequested(),
    });
    if (recoveryAction === TASK_RECOVERY_ACTIONS.MISSING_CODEX_TURN) {
      await d.finishProgress(run, "Не удалось найти сохранённый запуск.");
      await d.completeRun(run);
      return;
    }
    run.responseText = d.recoveredAnswer(turn) || run.responseText;
    if (recoveryAction === TASK_RECOVERY_ACTIONS.RETRY_LOST_APPROVAL) {
      const originalPrompt = codexThreadHistory([turn]).at(-1)?.prompt || run.promptPreview || "текущую задачу";
      run.responseText = "";
      run.progressReasoning = "";
      d.setProgressStage(run, "Восстанавливаю ход после потерянного запроса подтверждения…");
      await d.launchTurn(
        run,
        "Продолжи текущую задачу с места остановки. Предыдущий ход завис на запросе подтверждения, "
          + "который был потерян при переподключении App Server. Проверь уже выполненные действия и файлы, "
          + `не повторяй завершённую работу. Исходный запрос:\n\n${originalPrompt}`,
      );
      return;
    }
    if (recoveryAction === TASK_RECOVERY_ACTIONS.ATTACH_CODEX) {
      const previousTurnId = run.turnId;
      run.turnId = turn.id;
      d.reindexRun(run, { turnId: previousTurnId });
      if (!d.turnTokenUsage.has(run.turnId)) {
        rememberBounded(d.turnTokenUsage, run.turnId, { usage: emptyTokenUsage(), reported: false }, 200);
      }
      d.setProgressStage(run, "Подключено к продолжающейся задаче.");
      d.scheduleObservedRun(run);
      if (run.displayRequested) d.startTyping();
      await d.saveState();
      return;
    }
    if (recoveryAction === TASK_RECOVERY_ACTIONS.DISMISS_RESTART_INTERRUPTION) {
      while (run.progressUpdateInFlight) await delay(50);
      for (const messageId of run.progressMessageIds) {
        await d.telegram("deleteMessage", { chat_id: run.chatId, message_id: messageId }).catch(() => {});
      }
      run.progressMessageIds = [];
      run.progressReasoning = "";
      run.lastProgressText = "";
      await d.completeRun(run);
      return;
    }
    const answer = d.recoveredAnswer(turn)
      || run.responseText.trim()
      || turn.error?.message
      || `Сохранённый запуск завершён со статусом ${turn.status}.`;
    const tracker = d.consumeTracker(run.turnId);
    const recoveredAsCompleted = turn.status === "completed" || codexTurnHasExplicitFinalAnswer(turn);
    await d.finishProgress(run, recoveredAsCompleted ? "Задача завершена." : `Задача остановлена: ${turn.status}.`);
    await d.finalizeDelivery(run, {
      answer,
      turnId: run.turnId,
      status: turn.status ?? "completed",
      tracker,
      description: "восстановленный ответ",
    });
  }
}
