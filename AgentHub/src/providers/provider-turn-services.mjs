import { unlink } from "node:fs/promises";
import { buildCodexCollaborationMode } from "./codex/codex-settings.mjs";
import { activeTurnMissing, interruptCodexTurnWithRecovery, startCodexTurnWithRecovery } from "./codex/codex-recovery.mjs";
import { codexThreadSandboxSettings, codexTurnSandboxSettings } from "./codex/codex-sandbox.mjs";
import { emptyTokenUsage } from "../domain/token-usage.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function rememberBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

export class CodexTurnService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "sendRpc", "sandboxMode", "compactionRecycle", "resolvedSkillNames", "reindexRun",
      "saveState", "startTyping", "scheduleObservedRun", "finishProgress", "completeRun",
      "readThread",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async launch(run, input, temporaryFiles = [], { forceSpeechButton = false } = {}) {
    const d = this.#d;
    const recycle = d.compactionRecycle();
    if (recycle) await recycle;
    const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
    run.skillsUsed = await d.resolvedSkillNames(input, run.projectRoot);
    run.mcpCalls = [];
    run.toolMetricsKnown = true;
    try {
      const result = await startCodexTurnWithRecovery({
        threadId: run.threadId,
        startTurn: () => d.sendRpc("turn/start", {
          threadId: run.threadId,
          input: items,
          clientUserMessageId: run.clientUserMessageId ?? undefined,
          model: run.modelId,
          effort: run.reasoningId,
          collaborationMode: buildCodexCollaborationMode({
            mode: run.collaborationMode,
            model: run.modelId,
            reasoningEffort: run.reasoningId,
          }),
          ...codexTurnSandboxSettings(d.sandboxMode(), run.projectRoot),
        }),
        resume: (params) => d.sendRpc("thread/resume", {
          ...params,
          ...codexThreadSandboxSettings(d.sandboxMode()),
        }),
        rollback: (params) => d.sendRpc("thread/rollback", params),
      });
      const previousTurnId = run.turnId;
      run.turnId = result.turn.id;
      d.reindexRun(run, { turnId: previousTurnId });
      d.speechButtons.set(run.turnId, forceSpeechButton);
      if (temporaryFiles.length) d.temporaryFiles.set(run.turnId, temporaryFiles);
      if (!d.turnTokenUsage.has(run.turnId)) {
        rememberBounded(d.turnTokenUsage, run.turnId, { usage: emptyTokenUsage(), reported: false }, 200);
      }
      await d.saveState();
      d.startTyping();
      d.scheduleObservedRun(run);
    } catch (error) {
      await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
      await d.finishProgress(run, `Ошибка запуска: ${error.message}`);
      await d.completeRun(run);
      throw error;
    }
  }

  async steer({ run, target, input, clientUserMessageId }) {
    const turnId = await this.#exactTurnId(target, run);
    if (!turnId) throw new Error("Текущий ход уже нельзя изменить; сообщение осталось в очереди");
    const result = await this.#d.sendRpc("turn/steer", {
      threadId: target.threadId,
      expectedTurnId: turnId,
      input: typeof input === "string" ? [{ type: "text", text: input }] : input,
      clientUserMessageId,
    });
    return { turnId: String(result?.turnId ?? turnId) };
  }

  async interrupt(run) {
    return interruptCodexTurnWithRecovery({
      threadId: run.threadId,
      turnId: run.turnId,
      interrupt: (params) => this.#d.sendRpc("turn/interrupt", params),
      resume: ({ threadId }) => this.#d.sendRpc("thread/resume", {
        threadId,
        ...codexThreadSandboxSettings(this.#d.sandboxMode()),
      }),
    });
  }

  async #exactTurnId(target, run) {
    const registered = String(run?.turnId ?? "").trim();
    if (registered) return registered;
    const result = await this.#d.readThread(target.threadId, { fresh: true });
    const active = (Array.isArray(result.thread?.turns) ? result.thread.turns : [])
      .filter((turn) => ["inProgress", "in_progress", "running"].includes(String(turn?.status ?? "")))
      .map((turn) => String(turn.id ?? "").trim())
      .filter(Boolean);
    if (active.length === 1) return active[0];
    if (active.length > 1) throw new Error("В задаче выполняется несколько ходов; выбрать ход для изменения нельзя");
    return null;
  }
}

export class ProviderCancellationService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "interruptCodex", "runForTask", "completeRun", "readCodexSnapshot",
      "finishObserved", "completeManaged", "taskExternalActivity", "stopClaudeRun",
      "processIsAlive", "taskRunKey", "saveState",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async cancelCodex(run) {
    try {
      await this.#d.interruptCodex(run);
      return { accepted: true, stopRequested: true, message: "Запрошена остановка этой задачи." };
    } catch (error) {
      this.#d.logWarn?.(`Cannot interrupt Codex task ${run.threadId}:`, error.message);
      return {
        ...await this.#codexInterruptFailure(run, error),
        interruptFailed: true,
        stopRequested: false,
      };
    }
  }

  async cancelClaude(run) {
    const d = this.#d;
    if (run.observer) return { accepted: true, stopRequested: false };
    if (run.process || d.processIsAlive(run.pid)) {
      if (!await d.stopClaudeRun(run)) throw new Error("Не удалось остановить дерево процессов Claude");
      rememberBounded(d.cancelledClaudeTasks, d.taskRunKey(run), Date.now(), 200);
      await d.saveState();
      return { accepted: true, stopRequested: true, message: "Запрошена остановка этой задачи." };
    }
    return {
      accepted: false,
      detach: true,
      stopRequested: false,
      message: "Отключил наблюдение. Остановить внешний процесс Claude из этой сессии Agent Hub не может.",
    };
  }

  async #codexInterruptFailure(run, error) {
    const d = this.#d;
    const activity = await d.taskExternalActivity(run);
    if (activity.state === "inactive") {
      const reconciled = await this.#reconcileInactiveCodexRun(run);
      return {
        accepted: reconciled,
        message: reconciled
          ? "Ход уже завершён или остановлен; состояние синхронизировано"
          : "Ход уже завершён или остановлен; состояние обновляется",
      };
    }
    if (run.observer || activeTurnMissing(error)) {
      return {
        accepted: false,
        message: "Ход выполняется в другом окне Codex. Остановите его в том окне; наблюдение Agent Hub сохранено",
      };
    }
    return { accepted: false, message: "Codex не подтвердил остановку. Наблюдение и блокировка задачи сохранены" };
  }

  async #reconcileInactiveCodexRun(run) {
    const d = this.#d;
    if (d.runForTask(run) !== run) return true;
    if (["finishing", "completed"].includes(run.status)) {
      await d.completeRun(run);
      return true;
    }
    try {
      const snapshot = await d.readCodexSnapshot(run, { fresh: true });
      if (d.runForTask(run) !== run) return true;
      if (snapshot) {
        const terminal = {
          ...snapshot,
          active: false,
          completed: true,
          status: snapshot.completed ? snapshot.status : "interrupted",
          stage: snapshot.completed ? snapshot.stage ?? "Задача завершена." : "Задача остановлена или неактивна.",
        };
        if (run.observer) await d.finishObserved(run, terminal);
        else await d.completeManaged(run, { snapshot: terminal });
      }
    } catch (error) {
      d.logError?.(`Cannot reconcile inactive Codex task ${run.threadId}:`, error.message);
    } finally {
      if (d.runForTask(run) === run) await d.completeRun(run);
    }
    return d.runForTask(run) !== run;
  }
}

export function unsupportedProviderSteer() {
  throw new Error("Отправка в текущий ход недоступна для выбранного агента");
}
