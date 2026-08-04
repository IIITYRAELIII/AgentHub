function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class CodexTaskSnapshotService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "knownRolloutPath", "readRolloutActivity", "rolloutTurnState", "capturedOwner",
      "runtimeActive", "resolveOwner", "readThread", "selectTurn", "turnSnapshot",
      "turnStartedAt", "describeItem", "hubOwner", "agentHubPid",
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
