import { TASK_EXECUTION_OWNERS } from "../domain/task-execution-owner.mjs";

export function activeTurnNotSteerable(error) {
  const details = `${String(error?.message ?? "")} ${JSON.stringify(error?.data ?? {})}`.toLowerCase();
  return details.includes("activeturnnotsteerable")
    || details.includes("active turn not steerable")
    || details.includes("no active turn")
    || details.includes("expectedturnid")
    || /текущий ход уже/u.test(String(error?.message ?? "").toLowerCase());
}

export function providerThreadAlreadyActive(error) {
  return /thread\s+\S+\s+already has an active writer/iu.test(String(error?.message ?? error ?? ""));
}

function persistentAttachmentDescriptors(describeAttachments, files, persistentFiles) {
  return persistentFiles ? describeAttachments(files) : [];
}

export class RunCoordinator {
  #lanes = new Map();

  constructor({
    taskRuns,
    providers,
    externalActivity,
    repositoryConflict,
    deferInput,
    beginRun,
    launchTurn,
    describeAttachments = () => [],
    notifyInputStart = () => {},
    hasDeferredBacklog = () => false,
    isMaintenanceActive = () => false,
    scheduleDeferred = () => {},
    setProgressStage = () => {},
    noteRunActivity = () => {},
    scheduleProgressUpdate = () => {},
  }) {
    if (!taskRuns?.forTask) throw new TypeError("taskRuns.forTask is required");
    if (!providers?.call) throw new TypeError("providers.call is required");
    for (const [name, value] of Object.entries({
      externalActivity,
      repositoryConflict,
      deferInput,
      beginRun,
      launchTurn,
    })) {
      if (typeof value !== "function") throw new TypeError(`${name} is required`);
    }
    this.taskRuns = taskRuns;
    this.providers = providers;
    this.externalActivity = externalActivity;
    this.repositoryConflict = repositoryConflict;
    this.deferInput = deferInput;
    this.beginRun = beginRun;
    this.launchTurn = launchTurn;
    this.describeAttachments = describeAttachments;
    this.notifyInputStart = notifyInputStart;
    this.hasDeferredBacklog = hasDeferredBacklog;
    this.isMaintenanceActive = isMaintenanceActive;
    this.scheduleDeferred = scheduleDeferred;
    this.setProgressStage = setProgressStage;
    this.noteRunActivity = noteRunActivity;
    this.scheduleProgressUpdate = scheduleProgressUpdate;
  }

  taskLane(target) {
    const streamId = String(target?.streamId ?? "").trim();
    if (streamId) return `stream:${streamId}`;
    return [
      "provider",
      String(target?.provider ?? "").trim().toLowerCase(),
      String(target?.projectRoot ?? "").trim().toLowerCase(),
      String(target?.threadId ?? "").trim(),
    ].join(":");
  }

  async serialize(target, operation) {
    const lane = this.taskLane(target);
    const previous = this.#lanes.get(lane) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const settled = current.catch(() => {});
    this.#lanes.set(lane, settled);
    try {
      return await current;
    } finally {
      if (this.#lanes.get(lane) === settled) this.#lanes.delete(lane);
    }
  }

  start(input, temporaryFiles = [], options = {}) {
    return this.serialize(options.target, () => this.startUnlocked(input, temporaryFiles, options));
  }

  async startUnlocked(input, temporaryFiles = [], {
    forceSpeechButton = false,
    target,
    allowRepositoryConflict = false,
    allowUnknownExternalActivity = false,
    persistentFiles = false,
  } = {}) {
    if (!target?.provider) {
      throw new Error("run target requires provider");
    }
    this.notifyInputStart(target);
    if (this.isMaintenanceActive(target)) {
      return this.deferInput(input, temporaryFiles, {
        forceSpeechButton,
        executionOwner: TASK_EXECUTION_OWNERS.HUB,
        target,
        conflictKind: "context-maintenance",
        persistentFiles,
      });
    }
    const existingRun = this.taskRuns.forTask(target);
    const [externalActivity, repositoryConflict] = existingRun
      ? [{ state: "active", executionOwner: existingRun.executionOwner }, null]
      : await Promise.all([
        this.externalActivity(target),
        allowRepositoryConflict ? null : this.repositoryConflict(target),
      ]);
    if (existingRun || externalActivity.state === "active"
      || (externalActivity.state === "unknown" && !allowUnknownExternalActivity)) {
      return this.deferInput(input, temporaryFiles, {
        forceSpeechButton,
        executionOwner: existingRun?.executionOwner
          ?? externalActivity.executionOwner
          ?? TASK_EXECUTION_OWNERS.EXTERNAL,
        target,
        allowForce: externalActivity.state === "unknown" && !existingRun,
        conflictKind: externalActivity.state === "unknown" && !existingRun
          ? "activity-unknown"
          : "task-running",
        persistentFiles,
      });
    }
    if (repositoryConflict) {
      return this.deferInput(input, temporaryFiles, {
        forceSpeechButton,
        executionOwner: repositoryConflict.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL,
        target,
        allowForce: true,
        conflictKind: "repository",
        conflictTask: repositoryConflict,
        persistentFiles,
      });
    }
    let run;
    try {
      run = await this.beginRun(input, target);
    } catch (error) {
      const concurrentRun = this.taskRuns.forTask(target);
      if (error.message !== "this task is already running" || !concurrentRun) throw error;
      return this.deferInput(input, temporaryFiles, {
        forceSpeechButton,
        executionOwner: concurrentRun.executionOwner ?? TASK_EXECUTION_OWNERS.HUB,
        target,
        persistentFiles,
      });
    }
    run.messageAttachments = persistentAttachmentDescriptors(
      this.describeAttachments,
      temporaryFiles,
      persistentFiles,
    );
    await this.launchTurn(
      run,
      input,
      persistentFiles ? [] : temporaryFiles,
      { forceSpeechButton },
    );
    return { started: true, runId: run.id, run };
  }

  startDeferred(item) {
    return this.serialize(item, () => this.startDeferredUnlocked(item));
  }

  async startDeferredUnlocked(item) {
    const target = {
      provider: item.provider,
      streamId: item.streamId,
      projectRoot: item.projectRoot,
      threadId: item.threadId,
      taskTitle: item.taskTitle,
      chatId: item.chatId,
      modelId: item.modelId,
      reasoningId: item.reasoningId,
      collaborationMode: item.collaborationMode,
      clientUserMessageId: item.clientUserMessageId,
      telegramDeliveryRequested: item.telegramDeliveryRequested !== false,
      clientSource: item.clientSource,
      deferredInput: item,
    };
    const run = await this.beginRun(item.input, target);
    run.messageAttachments = persistentAttachmentDescriptors(
      this.describeAttachments,
      item.temporaryFiles ?? [],
      item.persistentFiles === true,
    );
    await this.launchTurn(
      run,
      item.input,
      item.persistentFiles ? [] : item.temporaryFiles ?? [],
      { forceSpeechButton: item.forceSpeechButton === true },
    );
    return run;
  }

  async queue(input, attachments, {
    target,
    executionOwner,
    clientUserMessageId,
    reason = "task-running",
  }) {
    const deferred = await this.deferInput(input, attachments, {
      executionOwner,
      target,
      conflictKind: reason,
      clientUserMessageId,
      destination: "queued",
      notify: false,
      persistentFiles: attachments.length > 0,
    });
    this.scheduleDeferred(deferred.item, 500);
    return {
      accepted: false,
      deferred: true,
      queued: true,
      id: deferred.id,
      clientUserMessageId,
      reason,
      message: reason === "steer-unavailable"
        ? "Текущий ход уже нельзя изменить; сообщение сохранено в очереди."
        : reason === "context-maintenance"
          ? "Сообщение поставлено в очередь до завершения свёртки или ротации контекста."
          : reason === "provider-thread-active"
            ? "Codex ещё завершает предыдущий ход; сообщение сохранено в очереди."
            : "Сообщение поставлено в очередь и будет отправлено после текущего хода.",
    };
  }

  steer(request) {
    return this.serialize(request.target, () => this.steerUnlocked(request));
  }

  async steerUnlocked({ input, target, clientUserMessageId }) {
    const existingRun = this.taskRuns.forTask(target);
    const externalActivity = existingRun
      ? { state: "active", executionOwner: existingRun.executionOwner }
      : await this.externalActivity(target);
    if (!existingRun && externalActivity.state === "inactive") {
      throw new Error("Текущий ход уже завершён; сообщение осталось в очереди");
    }
    let result;
    try {
      result = await this.providers.call(
        target.provider,
        "steerTurn",
        { run: existingRun, target, input, clientUserMessageId },
      );
    } catch (error) {
      if (!activeTurnNotSteerable(error)) throw error;
      throw new Error("Текущий ход уже нельзя изменить; сообщение осталось в очереди", {
        cause: error,
      });
    }
    if (existingRun) {
      const userMessages = Array.isArray(existingRun.userMessages)
        ? existingRun.userMessages
        : [];
      if (!userMessages.some((message) => (
        String(message?.clientUserMessageId ?? "") === clientUserMessageId
      ))) {
        userMessages.push({
          role: "user",
          clientUserMessageId,
          text: typeof input === "string"
            ? input
            : input.filter((item) => item?.type === "text")
              .map((item) => String(item.text ?? ""))
              .filter(Boolean)
              .join("\n"),
          time: new Date().toISOString(),
        });
        existingRun.userMessages = userMessages;
      }
      this.setProgressStage(existingRun, "Уточнение принято.");
      this.noteRunActivity(existingRun);
      this.scheduleProgressUpdate(existingRun, 0);
    }
    return {
      accepted: true,
      steered: true,
      runId: existingRun?.id ?? null,
      threadId: target.threadId,
      turnId: String(result?.turnId ?? existingRun?.turnId ?? "") || null,
      clientUserMessageId,
      message: "Сообщение добавлено в текущий ход.",
    };
  }

  submitClientInput(request) {
    return this.serialize(request.target, () => this.submitClientInputUnlocked(request));
  }

  async submitClientInputUnlocked({
    input,
    attachments = [],
    target,
    clientUserMessageId,
    followUpMode = "",
  }) {
    if (this.isMaintenanceActive(target)) {
      return this.queue(input, attachments, {
        target,
        executionOwner: TASK_EXECUTION_OWNERS.HUB,
        clientUserMessageId,
        reason: "context-maintenance",
      });
    }
    const existingRun = this.taskRuns.forTask(target);
    const externalActivity = existingRun
      ? { state: "active", executionOwner: existingRun.executionOwner }
      : await this.externalActivity(target);
    if (existingRun || externalActivity.state !== "inactive") {
      if (followUpMode === "steer") {
        try {
          return await this.steerUnlocked({ input, target, clientUserMessageId });
        } catch (error) {
          if (!activeTurnNotSteerable(error)) throw error;
          return this.queue(input, attachments, {
            target,
            executionOwner: existingRun?.executionOwner
              ?? externalActivity.executionOwner
              ?? TASK_EXECUTION_OWNERS.EXTERNAL,
            clientUserMessageId,
            reason: "steer-unavailable",
          });
        }
      }
      if (followUpMode === "queue") {
        return this.queue(input, attachments, {
          target,
          executionOwner: existingRun?.executionOwner
            ?? externalActivity.executionOwner
            ?? TASK_EXECUTION_OWNERS.EXTERNAL,
          clientUserMessageId,
        });
      }
      const deferred = await this.deferInput(input, attachments, {
        executionOwner: existingRun?.executionOwner
          ?? externalActivity.executionOwner
          ?? TASK_EXECUTION_OWNERS.EXTERNAL,
        target,
        allowForce: externalActivity.state === "unknown" && !existingRun,
        conflictKind: externalActivity.state === "unknown" && !existingRun
          ? "activity-unknown"
          : "task-running",
        clientUserMessageId,
        persistentFiles: attachments.length > 0,
      });
      return {
        accepted: false,
        deferred: true,
        id: deferred.id,
        clientUserMessageId,
        reason: externalActivity.state === "unknown" ? "activity-unknown" : "task-running",
        message: externalActivity.state === "unknown"
          ? "Сообщение сохранено: нельзя надёжно определить, завершён ли предыдущий ход."
          : "Сообщение сохранено: выберите новую задачу, очередь или отмену справа.",
      };
    }
    if (this.hasDeferredBacklog(target)) {
      return this.queue(input, attachments, {
        target,
        executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
        clientUserMessageId,
        reason: "queue-backlog",
      });
    }
    const repositoryConflict = await this.repositoryConflict(target);
    if (repositoryConflict) {
      const deferred = await this.deferInput(input, attachments, {
        executionOwner: repositoryConflict.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL,
        target,
        allowForce: true,
        conflictKind: "repository",
        conflictTask: repositoryConflict,
        clientUserMessageId,
        persistentFiles: attachments.length > 0,
      });
      return {
        accepted: false,
        deferred: true,
        id: deferred.id,
        clientUserMessageId,
        reason: "repository-conflict",
        message: `Сообщение сохранено: задача «${repositoryConflict.taskTitle ?? "Без названия"}» уже изменяет тот же Git-репозиторий.`,
      };
    }
    const run = await this.beginRun(input, { ...target, clientUserMessageId });
    run.messageAttachments = this.describeAttachments(attachments);
    try {
      await this.launchTurn(run, input, []);
    } catch (error) {
      if (!providerThreadAlreadyActive(error)) throw error;
      return this.queue(input, attachments, {
        target,
        executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
        clientUserMessageId,
        reason: "provider-thread-active",
      });
    }
    return {
      accepted: true,
      runId: run.id,
      threadId: run.threadId,
      turnId: run.turnId,
      clientUserMessageId,
    };
  }

  completeManaged(run, completion) {
    // Provider completion is a callback of the launch operation itself. It
    // must be able to finish while the admission lane still awaits a detached
    // worker startup, otherwise Claude can deadlock its own terminal event.
    return this.providers.call(run.provider, "completeManagedRun", run, completion);
  }

  completeObserved(run, snapshot) {
    return this.providers.call(run.provider, "completeObservedRun", run, snapshot);
  }

  recoverProviderRun(run, context = {}) {
    return this.providers.call(run.provider, "recoverRun", run, context);
  }
}
