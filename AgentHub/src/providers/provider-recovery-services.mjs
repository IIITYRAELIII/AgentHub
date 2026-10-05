import { setTimeout as delay } from "node:timers/promises";
import { codexThreadWaitingOnApproval } from "./codex/codex-approvals.mjs";
import {
  codexThreadHistory,
  codexTurnActivityGroups,
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
    if (initialAction === TASK_RECOVERY_ACTIONS.INTERRUPTED_LOCAL) {
      d.setProgressStage(run, "Связь с Codex недоступна; исходный ход ожидает проверки.");
      d.scheduleObservedRun(run);
      await d.saveState();
      return;
    }

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
    const turns = Array.isArray(result.thread?.turns) ? result.thread.turns : [];
    const exactTurnId = String(run.turnId ?? "").trim();
    const turn = exactTurnId
      ? turns.find((item) => String(item?.id ?? "").trim() === exactTurnId)
      : turns.at(-1);
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
    let terminalSnapshot = null;
    if (exactTurnId) {
      try {
        terminalSnapshot = await d.readTaskSnapshot(run, { threadResult: result, fresh: true });
      } catch {
        // A failed provider/rollout read is not terminal evidence. Keep the
        // original run and let the exact observer retry the same identity.
      }
    }
    const exactTerminal = terminalSnapshot?.completed === true
      && String(terminalSnapshot.turnId ?? "").trim() === exactTurnId
      ? terminalSnapshot : null;
    if (!exactTerminal && recoveryAction === TASK_RECOVERY_ACTIONS.MISSING_CODEX_TURN) {
      d.setProgressStage(run, "Ожидаю подтверждения исходного хода Codex…");
      d.scheduleObservedRun(run);
      await d.saveState();
      return;
    }
    run.responseText = (turn ? d.recoveredAnswer(turn) : "") || run.responseText;
    if (!exactTerminal && recoveryAction === TASK_RECOVERY_ACTIONS.RETRY_LOST_APPROVAL) {
      const originalPrompt = codexThreadHistory([turn]).at(-1)?.prompt || run.promptPreview || "текущий поток";
      run.responseText = "";
      run.progressReasoning = "";
      d.setProgressStage(run, "Восстанавливаю ход после потерянного запроса подтверждения…");
      await d.launchTurn(
        run,
        "Продолжи текущий поток с места остановки. Предыдущий ход завис на запросе подтверждения, "
          + "который был потерян при переподключении App Server. Проверь уже выполненные действия и файлы, "
          + `не повторяй завершённую работу. Исходный запрос:\n\n${originalPrompt}`,
      );
      return;
    }
    if (!exactTerminal && recoveryAction === TASK_RECOVERY_ACTIONS.ATTACH_CODEX) {
      const previousTurnId = run.turnId;
      run.turnId = turn.id;
      d.reindexRun(run, { turnId: previousTurnId });
      if (!d.turnTokenUsage.has(run.turnId)) {
        rememberBounded(d.turnTokenUsage, run.turnId, { usage: emptyTokenUsage(), reported: false }, 200);
      }
      d.setProgressStage(run, "Подключено к продолжающемуся потоку.");
      d.scheduleObservedRun(run);
      if (run.displayRequested) d.startTyping();
      await d.saveState();
      return;
    }
    if (!exactTerminal) {
      d.setProgressStage(run, "Ожидаю точное terminal-событие исходного хода Codex…");
      d.scheduleObservedRun(run);
      await d.saveState();
      return;
    }
    if (d.restartRequested() && exactTerminal.status === "aborted") {
      while (run.progressUpdateInFlight) await delay(50);
      const progressMessageIds = [...run.progressMessageIds];
      run.progressMessageIds = [];
      run.progressReasoning = "";
      run.lastProgressText = "";
      await d.finalizeDelivery(run, {
        answer: (turn ? d.recoveredAnswer(turn) : "")
          || run.responseText.trim()
          || "Ход прерван при перезапуске.",
        turnId: run.turnId,
        status: "aborted",
        tracker: d.consumeTracker(run.turnId),
        deliver: false,
        silent: true,
        description: "прерванный при перезапуске ход",
      });
      for (const messageId of progressMessageIds) {
        await d.telegram("deleteMessage", { chat_id: run.chatId, message_id: messageId }).catch(() => {});
      }
      return;
    }
    const answer = exactTerminal.answer || (turn ? d.recoveredAnswer(turn) : "")
      || run.responseText.trim()
      || turn?.error?.message
      || `Сохранённый запуск завершён со статусом ${exactTerminal.status}.`;
    const tracker = d.consumeTracker(run.turnId);
    const recoveredAsCompleted = exactTerminal.status === "completed";
    await d.finishProgress(run, recoveredAsCompleted ? "Поток завершён." : `Поток остановлен: ${exactTerminal.status}.`);
    await d.finalizeDelivery(run, {
      answer,
      turnId: run.turnId,
      status: exactTerminal.status,
      tracker,
      description: "восстановленный ответ",
    });
  }
}
