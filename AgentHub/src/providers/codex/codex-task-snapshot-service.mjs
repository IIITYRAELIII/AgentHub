import {
  codexFinalTurnAnswer,
  codexTurnHasExplicitFinalAnswer,
} from "../../application/task-history.mjs";
import { codexTurnAnswer } from "./codex-turn-answers.mjs";
import { codexThreadHistory } from "../../application/task-history.mjs";
import { codexThreadWaitingOnApproval } from "./codex-approvals.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export function describeCodexItem(item, completed) {
  if (!item || typeof item !== "object") return completed ? "Этап завершён." : "Выполняется следующий этап…";
  const mark = completed ? "✓" : "⚙";
  if (item.type === "commandExecution") {
    const command = String(item.command ?? "команда").replace(/\s+/g, " ").slice(0, 180);
    return `${mark} ${completed ? "Команда выполнена" : `Выполняется команда: ${command}`}`;
  }
  if (item.type === "fileChange") return `${mark} ${completed ? "Изменения файлов применены" : "Изменяются файлы…"}`;
  if (item.type === "mcpToolCall") return `${mark} Инструмент ${item.server ?? "MCP"}/${item.tool ?? ""}${completed ? " завершён" : " выполняется…"}`;
  if (item.type === "dynamicToolCall") return `${mark} Инструмент ${item.tool ?? ""}${completed ? " завершён" : " выполняется…"}`;
  if (item.type === "webSearch") return `${mark} ${completed ? "Поиск завершён" : "Выполняется поиск…"}`;
  if (item.type === "imageView") return `${mark} ${completed ? "Изображение изучено" : "Изучается изображение…"}`;
  if (item.type === "reasoning") return completed ? "✓ Анализ завершён." : "Анализирую задачу…";
  if (item.type === "plan") return completed ? "✓ План подготовлен." : "Составляю план…";
  return completed ? "Этап завершён." : "Выполняется следующий этап…";
}

export function codexTurnStartedAt(turn) {
  const value = turn?.startedAt ?? turn?.createdAt ?? null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) && value !== null && value !== ""
    ? (numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function recoveredCodexAnswer(turn) {
  return codexTurnAnswer(turn);
}

export function codexTurnSnapshot(turn, threadStatus = null) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const lastItem = items.at(-1);
  const answer = recoveredCodexAnswer(turn);
  const hasExplicitFinalAnswer = codexTurnHasExplicitFinalAnswer(turn);
  const waitingOnApproval = codexThreadWaitingOnApproval(threadStatus);
  const exchange = codexThreadHistory([turn]).at(-1);
  const userMessages = (exchange?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => ({ ...message }));
  const prompt = exchange?.prompt ?? "";
  return {
    answer,
    finalAnswer: codexFinalTurnAnswer(turn),
    reasoning: "",
    prompt,
    clientUserMessageId: userMessages[0]?.clientUserMessageId ?? null,
    userMessages,
    startedAt: codexTurnStartedAt(turn),
    completed: turn?.status !== "inProgress",
    active: turn?.status === "inProgress",
    status: turn?.status === "completed" ? "completed" : String(turn?.status ?? "stopped"),
    waitingOnApproval,
    stage: turn?.status === "inProgress"
      ? waitingOnApproval
        ? "🔐 Ожидается подтверждение разрешений."
        : describeCodexItem(lastItem, false)
      : turn?.status === "completed" || hasExplicitFinalAnswer
        ? "Задача завершена."
        : `Задача остановлена: ${turn?.status ?? "неизвестно"}.`,
  };
}

export class CodexTaskSnapshotService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "knownRolloutPath", "readRolloutActivity", "rolloutTurnState", "capturedOwner",
      "runtimeActive", "resolveOwner", "readThread", "selectTurn", "turnSnapshot",
      "turnStartedAt", "describeItem", "hubOwner", "agentHubPid", "modelLabel",
      "runtimeLabel", "delay", "reindexRun",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async read(run, { threadResult = null, fresh = false } = {}) {
    const d = this.#d;
    if (run.observer === true) {
      const rolloutPath = String(
        threadResult?.thread?.path
          ?? run.rolloutPath
          ?? await d.knownRolloutPath(run.threadId, run.startedAt),
      ).trim();
      if (rolloutPath) {
        run.rolloutPath = rolloutPath;
        const exact = run.exactTurnObserver === true;
        const activity = await d.readRolloutActivity(
          rolloutPath,
          exact ? { freshnessMs: Number.POSITIVE_INFINITY } : {},
        );
        const state = d.rolloutTurnState(activity, run.turnId, {
          exact,
          threadActive: activity.running,
        });
        const capturedOwner = d.capturedOwner(run.threadId, state.turnId);
        const runtimeActive = !state.active || await d.runtimeActive(activity, {
          turnId: state.turnId, rolloutPath, agentHubPid: d.agentHubPid(), capturedOwner,
        });
        const interrupted = state.active && !runtimeActive;
        const active = state.active && runtimeActive;
        const executionOwner = await d.resolveOwner(activity, {
          turnId: state.turnId, rolloutPath, agentHubPid: d.agentHubPid(), capturedOwner,
        });
        return this.#rolloutSnapshot(state, activity, {
          active,
          completed: state.completed || interrupted,
          status: interrupted ? "interrupted" : state.completed ? "completed" : active ? "inProgress" : "stopped",
          stage: active
            ? "Выполняется следующий этап…"
            : interrupted
              ? "Задача прервана вместе с клиентом Codex."
              : state.finalAnswer ? "Задача завершена." : "Задача остановлена или неактивна.",
          executionOwner,
        });
      }
    }

    const result = threadResult ?? await d.readThread(run.threadId, { fresh, includeTurns: false });
    const turns = Array.isArray(result.thread?.turns) ? result.thread.turns : [];
    const exact = run.exactTurnObserver === true;
    const activity = await d.readRolloutActivity(
      result.thread?.path,
      exact ? { freshnessMs: Number.POSITIVE_INFINITY } : {},
    );
    if (!turns.length) {
      const state = d.rolloutTurnState(activity, run.turnId, {
        exact,
        threadActive: result.thread?.status?.type === "active",
      });
      const executionOwner = run?.observer === true
        ? await d.resolveOwner(activity, {
          turnId: state.turnId,
          rolloutPath: result.thread?.path,
          agentHubPid: d.agentHubPid(),
          capturedOwner: d.capturedOwner(run.threadId, state.turnId),
        })
        : d.hubOwner();
      return this.#rolloutSnapshot(state, activity, {
        active: state.active,
        completed: state.completed,
        status: state.completed ? "completed" : state.active ? "inProgress" : "stopped",
        stage: state.active
          ? "Выполняется следующий этап…"
          : state.finalAnswer ? "Задача завершена." : "Задача остановлена или неактивна.",
        executionOwner,
      });
    }

    const turn = d.selectTurn(turns, {
      requestedTurnId: run.turnId,
      rolloutActiveTurnIds: activity.activeTurnIds,
      strictRequested: exact || run.observer !== true,
    });
    if (!turn) return null;
    const snapshot = {
      ...d.turnSnapshot(turn, result.thread?.status),
      turnId: turn.id,
      activeTurnCount: activity.activeTurnIds.length || (turn?.status === "inProgress" ? 1 : 0),
      activityAtMs: Number(activity.activityAtMsByTurnId?.[turn.id]) || activity.lastActivityAtMs,
      model: activity.model,
      reasoningEffort: activity.reasoningEffort,
      startedAt: Number.isFinite(Number(activity.startedAtMsByTurnId?.[turn.id]))
        ? new Date(Number(activity.startedAtMsByTurnId[turn.id])).toISOString()
        : d.turnStartedAt(turn),
      executionOwner: run?.observer === true
        ? await d.resolveOwner(activity, {
          turnId: turn.id,
          rolloutPath: result.thread?.path,
          agentHubPid: d.agentHubPid(),
          capturedOwner: d.capturedOwner(run.threadId, turn.id),
        })
        : d.hubOwner(),
    };
    if (!snapshot.active && activity.activeTurnIds.includes(turn.id)) {
      return { ...snapshot, completed: false, active: true, stage: d.describeItem(turn.items?.at(-1), false) };
    }
    return snapshot;
  }

  async completedAnswer(run, completedTurnId, eventTurn = null) {
    let answer = codexFinalTurnAnswer(eventTurn);
    if (answer) return answer;
    for (const waitMs of [0, 100, 250, 500]) {
      if (waitMs) await this.#d.delay(waitMs);
      try {
        const result = await this.#d.readThread(run.threadId, { fresh: true });
        const completedTurn = (result.thread?.turns ?? [])
          .find((turn) => String(turn?.id ?? "") === String(completedTurnId ?? ""));
        answer = codexFinalTurnAnswer(completedTurn);
        if (answer) return answer;
      } catch (error) {
        this.#d.logger?.warn?.(
          `Cannot read completed Codex turn ${completedTurnId ?? "unknown"}: ${error.message}`,
        );
      }
    }
    return String(run.responseText ?? "").trim();
  }

  applyObserved(run, snapshot) {
    if (!run.turnId && snapshot?.turnId) {
      run.turnId = snapshot.turnId;
      this.#d.reindexRun(run);
    }
    if (snapshot?.model) run.model = this.#d.modelLabel(snapshot.model);
    if (snapshot?.reasoningEffort) {
      run.reasoning = this.#d.reasoningLabels?.[snapshot.reasoningEffort]
        ?? snapshot.reasoningEffort;
    }
  }

  applyActive(run, snapshot) {
    run.appServer = this.#d.runtimeLabel(run.executionOwner);
    run.activeTurnCount = Math.max(1, Number(snapshot?.activeTurnCount) || 1);
  }

  #rolloutSnapshot(state, activity, overrides) {
    return {
      answer: overrides.active ? state.latestAnswer : state.finalAnswer,
      finalAnswer: state.finalAnswer,
      reasoning: "",
      prompt: state.userMessages[0]?.text ?? "",
      clientUserMessageId: state.userMessages[0]?.clientUserMessageId ?? null,
      userMessages: state.userMessages,
      startedAt: state.startedAt,
      completed: overrides.completed,
      active: overrides.active,
      status: overrides.status,
      waitingOnApproval: false,
      stage: overrides.stage,
      turnId: state.turnId,
      activeTurnCount: activity.activeTurnIds.length,
      activityAtMs: Number(activity.activityAtMsByTurnId?.[state.turnId]) || activity.lastActivityAtMs,
      model: activity.model,
      reasoningEffort: activity.reasoningEffort,
      executionOwner: overrides.executionOwner,
    };
  }
}
