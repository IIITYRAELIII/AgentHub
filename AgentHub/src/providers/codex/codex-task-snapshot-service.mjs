import {
  codexExplicitFinalTurnAnswer,
  codexFinalTurnAnswer,
  codexSubagentAuthor,
  codexTurnHasExplicitFinalAnswer,
} from "../../application/task-history.mjs";
import { codexTurnAnswer } from "./codex-turn-answers.mjs";
import { codexThreadHistory } from "../../application/task-history.mjs";
import { codexThreadWaitingOnApproval } from "./codex-approvals.mjs";
import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";

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
  if (item.type === "reasoning") return completed ? "✓ Анализ завершён." : "Анализирую поток…";
  if (item.type === "plan") return completed ? "✓ План подготовлен." : "Составляю план…";
  return completed ? "Этап завершён." : "Выполняется следующий этап…";
}

function codexTurnTimestamp(value) {
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) && value !== null && value !== ""
    ? (numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function codexTurnStartedAt(turn) {
  return codexTurnTimestamp(turn?.startedAt ?? turn?.createdAt ?? null);
}

export function codexTurnCompletedAt(turn) {
  return codexTurnTimestamp(turn?.completedAt ?? turn?.lastActivityAt ?? null);
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
  const turnMessages = (exchange?.messages ?? [])
    .filter((message) => message.role === "user" || message.kind === "subagent")
    .map((message) => ({ ...message }));
  const userMessages = turnMessages.filter((message) => message.role === "user");
  const prompt = exchange?.prompt ?? "";
  return {
    answer,
    finalAnswer: codexFinalTurnAnswer(turn),
    reasoning: "",
    prompt,
    clientUserMessageId: userMessages[0]?.clientUserMessageId ?? null,
    userMessages: turnMessages,
    activities: exchange?.activities ?? [],
    activityGroups: exchange?.activityGroups ?? [],
    startedAt: codexTurnStartedAt(turn),
    completedAt: codexTurnCompletedAt(turn),
    completed: turn?.status !== "inProgress",
    active: turn?.status === "inProgress",
    status: turn?.status === "completed" ? "completed" : String(turn?.status ?? "stopped"),
    waitingOnApproval,
    stage: turn?.status === "inProgress"
      ? waitingOnApproval
        ? "🔐 Ожидается подтверждение разрешений."
        : describeCodexItem(lastItem, false)
      : turn?.status === "completed" || hasExplicitFinalAnswer
        ? "Поток завершён."
        : `Поток остановлен: ${turn?.status ?? "неизвестно"}.`,
  };
}

function withRolloutUserIdentity(snapshot, rolloutState) {
  const userMessages = Array.isArray(rolloutState?.userMessages)
    ? rolloutState.userMessages.map((message) => ({ ...message }))
    : [];
  if (!userMessages.length) return snapshot;
  const rootUser = userMessages.find((message) => message?.role !== "agent");
  const prompt = String(rootUser?.text ?? "").trim();
  const clientUserMessageId = String(rootUser?.clientUserMessageId ?? "").trim();
  return {
    ...snapshot,
    ...(prompt ? { prompt } : {}),
    clientUserMessageId: clientUserMessageId || snapshot.clientUserMessageId || null,
    userMessages,
  };
}

export class CodexTaskSnapshotService {
  #d;
  #subagentAuthors = new Map();

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
          {
            ...(exact ? { freshnessMs: Number.POSITIVE_INFINITY } : {}),
            pinCache: true,
          },
        );
        const state = await this.#hydrateSubagentMessages(d.rolloutTurnState(activity, run.turnId, {
          exact,
          threadActive: activity.running,
        }));
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
              ? "Поток прерван вместе с клиентом Codex."
              : state.finalAnswer ? "Поток завершён." : "Поток остановлен или неактивен.",
          executionOwner,
        });
      }
    }

    const result = threadResult ?? await d.readThread(run.threadId, {
      fresh,
      includeTurns: false,
      priority: "interactive",
    });
    const turns = (Array.isArray(result.thread?.turns) ? result.thread.turns : [])
      .filter((turn) => !isCodexContextProbeTurn(turn));
    const exact = run.exactTurnObserver === true;
    const activity = await d.readRolloutActivity(
      result.thread?.path,
      {
        ...(exact ? { freshnessMs: Number.POSITIVE_INFINITY } : {}),
        pinCache: run.observer === true,
      },
    );
    if (!turns.length) {
      const state = await this.#hydrateSubagentMessages(d.rolloutTurnState(activity, run.turnId, {
        exact,
        threadActive: result.thread?.status?.type === "active",
      }));
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
          : state.finalAnswer ? "Поток завершён." : "Поток остановлен или неактивен.",
        executionOwner,
      });
    }

    const turn = d.selectTurn(turns, {
      requestedTurnId: run.turnId,
      rolloutActiveTurnIds: activity.activeTurnIds,
      strictRequested: exact || run.observer !== true,
    });
    if (!turn) return null;
    const rolloutState = await this.#hydrateSubagentMessages(d.rolloutTurnState(activity, turn.id, {
      exact: true,
      threadActive: result.thread?.status?.type === "active",
    }));
    const turnSnapshot = withRolloutUserIdentity(
      d.turnSnapshot(turn, result.thread?.status),
      rolloutState,
    );
    const completedAtMs = Number(activity.completedAtMsByTurnId?.[turn.id]);
    const snapshot = {
      ...turnSnapshot,
      turnId: turn.id,
      activeTurnCount: activity.activeTurnIds.length || (turn?.status === "inProgress" ? 1 : 0),
      activityAtMs: Number(activity.activityAtMsByTurnId?.[turn.id]) || activity.lastActivityAtMs,
      model: activity.model,
      reasoningEffort: activity.reasoningEffort,
      startedAt: Number.isFinite(Number(activity.startedAtMsByTurnId?.[turn.id]))
        ? new Date(Number(activity.startedAtMsByTurnId[turn.id])).toISOString()
        : d.turnStartedAt(turn),
      completedAt: Number.isFinite(completedAtMs)
        ? new Date(completedAtMs).toISOString()
        : turnSnapshot.completedAt,
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
    const turnId = String(completedTurnId ?? "").trim();
    const eventStatus = String(eventTurn?.status ?? "").trim().toLowerCase();
    const interrupted = eventStatus && eventStatus !== "completed";
    let rolloutPath = "";
    const rolloutAnswer = async ({ includeLatest = false } = {}) => {
      try {
        rolloutPath ||= await this.#d.knownRolloutPath(run.threadId);
        if (!rolloutPath) return "";
        const activity = await this.#d.readRolloutActivity(rolloutPath);
        return String(
          activity?.finalMessages?.[turnId]
          || (includeLatest ? activity?.latestMessages?.[turnId] : "")
          || "",
        ).trim();
      } catch (error) {
        this.#d.logger?.warn?.(
          `Cannot read Codex rollout answer ${turnId || "unknown"}: ${error.message}`,
        );
        return "";
      }
    };

    let answer = await rolloutAnswer({ includeLatest: interrupted });
    if (answer) return answer;
    let fallbackAnswer = codexExplicitFinalTurnAnswer(eventTurn);
    for (const waitMs of [0, 100, 250, 500]) {
      if (waitMs) await this.#d.delay(waitMs);
      try {
        answer = await rolloutAnswer({ includeLatest: interrupted });
        if (answer) return answer;
        const result = await this.#d.readThread(run.threadId, {
          fresh: true,
          priority: "interactive",
        });
        const completedTurn = (result.thread?.turns ?? [])
          .find((turn) => String(turn?.id ?? "") === turnId);
        answer = codexExplicitFinalTurnAnswer(completedTurn);
        if (answer) fallbackAnswer = answer;
      } catch (error) {
        this.#d.logger?.warn?.(
          `Cannot read completed Codex turn ${completedTurnId ?? "unknown"}: ${error.message}`,
        );
      }
    }
    if (fallbackAnswer) return fallbackAnswer;
    if (!interrupted) return "";
    return String((await rolloutAnswer({ includeLatest: true })) || run.responseText || "").trim();
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
    if (Array.isArray(snapshot?.activityGroups) && snapshot.activityGroups.length) {
      const existingActivities = new Map((run.activities ?? []).map((activity) => [activity.id, activity]));
      run.activityGroups = snapshot.activityGroups.map((group) => ({
        ...group,
        activities: (group.activities ?? []).map((activity) => (
          existingActivities.has(activity.id)
            ? { ...activity, ...existingActivities.get(activity.id) }
            : { ...activity }
        )),
      }));
      run.currentActivityGroupId = run.activityGroups.at(-1)?.id ?? null;
    }
  }

  applyActive(run, snapshot) {
    run.appServer = this.#d.runtimeLabel(run.executionOwner);
    run.activeTurnCount = Math.max(1, Number(snapshot?.activeTurnCount) || 1);
  }

  #rolloutSnapshot(state, activity, overrides) {
    const rootUser = state.userMessages.find((message) => message?.role !== "agent");
    return {
      answer: overrides.active ? state.latestAnswer : state.finalAnswer,
      finalAnswer: state.finalAnswer,
      reasoning: "",
      prompt: rootUser?.text ?? "",
      clientUserMessageId: rootUser?.clientUserMessageId ?? null,
      userMessages: state.userMessages,
      activityGroups: structuredClone(activity.activityGroups?.[state.turnId] ?? []),
      startedAt: state.startedAt,
      completedAt: state.completedAt,
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

  async #hydrateSubagentMessages(state) {
    const messages = Array.isArray(state?.userMessages) ? state.userMessages : [];
    const hydrated = await Promise.all(messages.map(async (message) => {
      if (message?.kind !== "subagent"
        || String(message.author ?? "") !== codexSubagentAuthor("")) {
        return { ...message };
      }
      const threadId = String(message.agentThreadId ?? "").trim();
      if (!threadId) return { ...message };
      let author = this.#subagentAuthors.get(threadId);
      let model = String(message.model ?? "").trim();
      if (!author) {
        try {
          const rolloutPath = await this.#d.knownRolloutPath(threadId);
          const activity = rolloutPath ? await this.#d.readRolloutActivity(rolloutPath) : null;
          model ||= String(activity?.model ?? "").trim();
          author = codexSubagentAuthor(model);
          if (model) {
            this.#subagentAuthors.set(threadId, author);
            if (this.#subagentAuthors.size > 200) {
              this.#subagentAuthors.delete(this.#subagentAuthors.keys().next().value);
            }
          }
        } catch {
          author = codexSubagentAuthor("");
        }
      }
      return { ...message, author: author || codexSubagentAuthor(""), ...(model ? { model } : {}) };
    }));
    return { ...state, userMessages: hydrated };
  }
}
