import path from "node:path";

import {
  createObservedTaskRun,
  shouldDeliverObservedCompletion,
  updateObservedResponse,
} from "../domain/task-runs.mjs";
import {
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
} from "../domain/task-execution-owner.mjs";
import { TaskObserverController } from "./task-observer-controller.mjs";

export class TaskObservationService {
  constructor({
    providers,
    taskRuns,
    runCoordinator,
    dataDir,
    findProject,
    invalidateTaskCatalog,
    syncTaskRun,
    modelLabel,
    reasoningLabels,
    noteRunActivity,
    scheduleProgressUpdate,
    setProgressStage,
    markProgressHeartbeat,
    progressHeartbeatState,
    finishProgress,
    completeRun,
    discardContextCompactionRun,
    savedLastTaskMessageRecord,
    externalPollIntervalMs,
    managedPollIntervalMs,
    captureGitBaseline,
    now = Date.now,
    logger = console,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    this.providers = providers;
    this.taskRuns = taskRuns;
    this.runCoordinator = runCoordinator;
    this.dataDir = dataDir;
    this.findProject = findProject;
    this.invalidateTaskCatalog = invalidateTaskCatalog;
    this.syncTaskRun = syncTaskRun;
    this.modelLabel = modelLabel;
    this.reasoningLabels = reasoningLabels;
    this.noteRunActivity = noteRunActivity;
    this.scheduleProgressUpdate = scheduleProgressUpdate;
    this.setProgressStage = setProgressStage;
    this.markProgressHeartbeat = markProgressHeartbeat;
    this.progressHeartbeatState = progressHeartbeatState;
    this.finishProgress = finishProgress;
    this.completeRun = completeRun;
    this.discardContextCompactionRun = discardContextCompactionRun;
    this.savedLastTaskMessageRecord = savedLastTaskMessageRecord;
    if (typeof captureGitBaseline !== "function") {
      throw new TypeError("captureGitBaseline is required");
    }
    this.captureGitBaseline = captureGitBaseline;
    this.now = now;
    this.logger = logger;

    this.controller = new TaskObserverController({
      canObserve: (run) => Boolean(
        run?.provider
          && this.providers.call(run.provider, "shouldObserveRun", run)
          && this.taskRuns.forTask(run) === run,
      ),
      readSnapshot: (run) => this.providers.call(run.provider, "readRunSnapshot", run),
      pollDelay: (run) => run.observer === true
        ? externalPollIntervalMs
        : managedPollIntervalMs,
      onUnknown: (run, snapshot) => this.finishUnknown(run, snapshot),
      onMissing: async (run) => {
        this.setProgressStage(run, "Ожидаю данные текущего хода…");
        if (this.markProgressHeartbeat(run, "waiting")) this.scheduleProgressUpdate(run);
      },
      onTurnChanged: async (run, turnId) => {
        if (run.exactTurnObserver === true) {
          throw new Error(`Exact Codex turn observer cannot move from ${run.turnId} to ${turnId}`);
        }
        const previousTurnId = run.turnId;
        run.turnId = turnId;
        this.taskRuns.reindex(run, { turnId: previousTurnId });
      },
      onCompleted: async (run, snapshot) => {
        if (run.observer) await this.finish(run, snapshot);
        else await this.runCoordinator.completeManaged(run, { snapshot });
      },
      onActive: (run, snapshot) => this.applyActive(run, snapshot),
      onError: async (run, error) => {
        this.logger.error(`Cannot observe ${run.provider} task ${run.threadId}:`, error.message);
        this.setProgressStage(run, `Не удалось обновить ход: ${error.message}`);
        if (this.markProgressHeartbeat(run, "error")) this.scheduleProgressUpdate(run);
      },
      setTimeoutImpl,
      clearTimeoutImpl,
    });
  }

  async create(binding, targetChatId, snapshot, turnId = null) {
    const executionOwner = binding.provider === "codex"
      ? snapshot.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL
      : TASK_EXECUTION_OWNERS.EXTERNAL;
    const run = createObservedTaskRun({
      streamId: binding.streamId ?? null,
      provider: binding.provider,
      chatId: targetChatId,
      projectRoot: binding.projectRoot,
      projectName: this.findProject(binding.projectRoot)?.name ?? path.basename(binding.projectRoot),
      threadId: binding.threadId,
      turnId,
      taskTitle: binding.taskTitle,
      promptPreview: snapshot.prompt ?? snapshot.userMessages?.[0]?.text ?? "",
      clientUserMessageId: snapshot.clientUserMessageId
        ?? snapshot.userMessages?.[0]?.clientUserMessageId
        ?? null,
      userMessages: Array.isArray(snapshot.userMessages)
        ? snapshot.userMessages.map((message) => ({ ...message }))
        : [],
      model: binding.provider === "codex" && snapshot.model
        ? this.modelLabel(snapshot.model)
        : null,
      modelId: null,
      reasoning: binding.provider === "codex" && snapshot.reasoningEffort
        ? this.reasoningLabels[snapshot.reasoningEffort] ?? snapshot.reasoningEffort
        : "Подключённый ход",
      reasoningId: null,
      executionOwner,
      activeTurnCount: Number(snapshot.activeTurnCount) || 1,
      appServer: binding.provider === "codex"
        ? taskExecutionRuntimeLabel(executionOwner)
        : "Внешний Claude CLI",
      collaborationMode: "default",
    }, snapshot);
    run.gitBaseline = await this.captureGitBaseline(run.projectRoot, this.dataDir, run.id);
    this.taskRuns.add(run);
    this.invalidateTaskCatalog();
    this.syncTaskRun(run, {
      active: true,
      stage: snapshot.stage,
      answer: snapshot.answer,
      activityAtMs: snapshot.activityAtMs ?? snapshot.modifiedAtMs ?? this.now(),
    });
    return run;
  }

  update(run, snapshot) {
    const previousReasoning = run.progressReasoning;
    const previousStage = run.progressStage;
    const responseChanged = updateObservedResponse(run, snapshot?.answer);
    this.providers.call(run.provider, "applyObservedSnapshot", run, snapshot);
    if (!run.promptPreview && snapshot?.prompt) run.promptPreview = String(snapshot.prompt);
    if (Array.isArray(snapshot?.userMessages)) {
      run.userMessages = snapshot.userMessages.map((message) => ({ ...message }));
      const first = run.userMessages[0];
      if (!run.promptPreview && first?.text) run.promptPreview = String(first.text);
      if (!run.clientUserMessageId && first?.clientUserMessageId) {
        run.clientUserMessageId = String(first.clientUserMessageId);
      }
    }
    run.progressReasoning = String(snapshot?.reasoning ?? run.progressReasoning);
    run.progressStage = String(snapshot?.stage ?? run.progressStage);
    run.activeTurnCount = Math.max(1, Number(snapshot?.activeTurnCount) || 1);
    const snapshotStartedAt = Date.parse(String(snapshot?.startedAt ?? ""));
    const runStartedAt = Date.parse(String(run.startedAt ?? ""));
    if (
      Number.isFinite(snapshotStartedAt)
      && (!Number.isFinite(runStartedAt) || snapshotStartedAt < runStartedAt)
    ) {
      run.startedAt = new Date(snapshotStartedAt).toISOString();
    }
    const activityAtMs = Number(snapshot?.activityAtMs ?? snapshot?.modifiedAtMs);
    if (Number.isFinite(activityAtMs)) this.noteRunActivity(run, activityAtMs);
    if (responseChanged || run.progressReasoning !== previousReasoning || run.progressStage !== previousStage) {
      this.noteRunActivity(run);
    }
    this.scheduleProgressUpdate(run);
    return responseChanged;
  }

  async finish(run, snapshot) {
    if (this.taskRuns.forTask(run) !== run) return;
    const completedTurnId = snapshot?.turnId ?? run.turnId;
    if (await this.discardContextCompactionRun(run, completedTurnId)) return;
    const tracker = snapshot?.tokenTracker ?? null;
    this.update(run, snapshot);
    const savedRecord = this.savedLastTaskMessageRecord(run);
    const exactCompletedTurnId = String(completedTurnId ?? "").trim();
    const savedAnswer = exactCompletedTurnId
      && String(savedRecord?.turnId ?? "").trim() === exactCompletedTurnId
      ? String(savedRecord?.text ?? "").trim()
      : "";
    const answer = String(snapshot?.answer ?? "").trim()
      || savedAnswer
      || "Ход завершён без текстового ответа.";
    const deliver = shouldDeliverObservedCompletion(
      run,
      answer,
      savedRecord,
    );
    await this.finishProgress(run, snapshot?.stage ?? "Поток завершён.");
    await this.runCoordinator.completeObserved(run, {
      snapshot,
      answer,
      deliver,
      completedTurnId,
      tracker,
    });
  }

  async finishUnknown(run, snapshot) {
    if (this.taskRuns.forTask(run) !== run) return;
    const providerName = this.providers.get(run.provider).name;
    const activityAtMs = Number(snapshot?.activityAtMs);
    const idleMinutes = Number.isFinite(activityAtMs)
      ? Math.max(1, Math.round((this.now() - activityAtMs) / 60_000))
      : null;
    const stage = idleMinutes
      ? `Активность ${providerName} неизвестна: нет новых событий ${idleMinutes} мин.`
      : `Активность ${providerName} неизвестна: новых событий нет.`;
    this.update(run, { ...snapshot, stage });
    await this.finishProgress(run, stage);
    await this.completeRun(run);
    this.logger.log(`${providerName} activity became unknown for ${run.threadId}`);
  }

  async applyActive(run, snapshot) {
    run.executionOwner = run.observer === true
      ? snapshot.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL
      : TASK_EXECUTION_OWNERS.HUB;
    this.providers.call(run.provider, "applyActiveSnapshot", run, snapshot);
    if (Number.isFinite(Number(snapshot.activityAtMs ?? snapshot.modifiedAtMs))) {
      this.noteRunActivity(run, Number(snapshot.activityAtMs ?? snapshot.modifiedAtMs));
    }
    if (this.markProgressHeartbeat(run, this.progressHeartbeatState(run))) {
      this.scheduleProgressUpdate(run);
    }
    if (run.observer) {
      this.update(run, snapshot);
    } else {
      const answer = String(snapshot.answer ?? "").trim();
      if (answer && answer !== run.responseText) {
        run.responseText = answer;
        this.noteRunActivity(run);
      }
      run.progressReasoning = String(snapshot.reasoning ?? run.progressReasoning);
      run.progressStage = String(snapshot.stage ?? run.progressStage);
      this.scheduleProgressUpdate(run);
    }
    this.syncTaskRun(run, {
      active: true,
      stage: snapshot.stage,
      answer: snapshot.answer,
      activityAtMs: snapshot.activityAtMs ?? snapshot.modifiedAtMs ?? this.now(),
    });
  }

  schedule(run) {
    this.controller.schedule(run);
  }

  poll(run) {
    return this.controller.poll(run);
  }

  pause(run) {
    this.controller.pause(run);
  }
}
