import {
  normalizeTaskExecutionOwner,
  TASK_EXECUTION_OWNERS,
} from "../domain/task-execution-owner.mjs";
import {
  interstreamOriginAuthor,
  normalizeInterstreamOrigin,
} from "../domain/interstream-message.mjs";
import { contextMaintenanceActiveError } from "../domain/deferred-input.mjs";
import {
  taskOccupancyIdentity,
  taskRunIsActive,
  taskRunKey,
} from "../domain/task-runs.mjs";

export function activeTurnNotSteerable(error) {
  const details = `${String(error?.message ?? "")} ${JSON.stringify(error?.data ?? {})}`.toLowerCase();
  return details.includes("activeturnnotsteerable")
    || details.includes("active turn not steerable")
    || details.includes("no active turn")
    || details.includes("expectedturnid")
    || details.includes("expected active turn id")
    || details.includes("thread not found")
    || details.includes("already has an active writer")
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
  #intakeLanes = new Map();

  constructor({
    taskRuns,
    providers,
    externalActivity,
    repositoryConflict,
    deferInput,
    beginRun,
    rollbackAdmission,
    launchTurn,
    describeAttachments = () => [],
    notifyInputStart = () => {},
    hasDeferredBacklog = () => false,
    isMaintenanceActive = () => false,
    scheduleDeferred = () => {},
    setProgressStage = () => {},
    noteRunActivity = () => {},
    scheduleProgressUpdate = () => {},
    rekeyDeferredOccupancy = null,
  }) {
    if (!taskRuns?.forTask) throw new TypeError("taskRuns.forTask is required");
    if (!providers?.call) throw new TypeError("providers.call is required");
    for (const [name, value] of Object.entries({
      externalActivity,
      repositoryConflict,
      deferInput,
      beginRun,
      rollbackAdmission,
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
    this.rollbackAdmission = rollbackAdmission;
    this.launchTurn = launchTurn;
    this.describeAttachments = describeAttachments;
    this.notifyInputStart = notifyInputStart;
    this.hasDeferredBacklog = hasDeferredBacklog;
    this.isMaintenanceActive = isMaintenanceActive;
    this.scheduleDeferred = scheduleDeferred;
    this.setProgressStage = setProgressStage;
    this.noteRunActivity = noteRunActivity;
    this.scheduleProgressUpdate = scheduleProgressUpdate;
    this.rekeyDeferredOccupancy = rekeyDeferredOccupancy;
  }

  taskLane(target) {
    return taskOccupancyIdentity(target)?.key ?? taskRunKey(target ?? {});
  }

  activeRun(target) {
    const run = this.taskRuns.forTask(target);
    return taskRunIsActive(run) ? run : null;
  }

  async deferredOccupancy(target) {
    const identity = taskOccupancyIdentity(target);
    const run = this.activeRun(target);
    if (run) {
      return {
        key: this.taskLane(run),
        binding: taskOccupancyIdentity(run)?.binding ?? identity?.binding ?? "provisional",
        occupied: true,
        state: "active",
        waitReason: "provider-thread-active",
        run,
      };
    }
    if (identity?.binding !== "exact") {
      return {
        key: identity?.key ?? this.taskLane(target),
        binding: identity?.binding ?? "provisional",
        occupied: false,
        state: "inactive",
        waitReason: null,
        run: null,
      };
    }
    const external = await this.externalActivity(target);
    return {
      key: identity.key,
      binding: identity.binding,
      occupied: external.state !== "inactive",
      state: external.state,
      waitReason: external.state === "active"
        ? "provider-thread-active"
        : external.state === "unknown" ? "provider-temporarily-unavailable" : null,
      run: null,
      executionOwner: external.executionOwner ?? null,
    };
  }

  async bindDeferredOccupancy(item) {
    const identity = taskOccupancyIdentity(item);
    if (!identity || identity.binding !== "exact") return { changed: false, item };
    const clientUserMessageId = String(item?.clientUserMessageId ?? "").trim();
    if (!clientUserMessageId || typeof this.rekeyDeferredOccupancy !== "function") {
      item.occupancyKey = identity.key;
      item.occupancyBinding = identity.binding;
      return { changed: false, item };
    }
    const result = await this.rekeyDeferredOccupancy({
      clientUserMessageId,
      expectedOccupancyKey: item.occupancyKey ?? null,
      target: item,
    });
    if (result?.conflict) throw new Error("message command occupancy binding conflict");
    if (result?.record?.item) Object.assign(item, result.record.item);
    else {
      item.occupancyKey = identity.key;
      item.occupancyBinding = identity.binding;
    }
    return { ...result, item };
  }

  async serializeIn(lanes, target, operation) {
    const lane = this.taskLane(target);
    const previous = lanes.get(lane) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const settled = current.catch(() => {});
    lanes.set(lane, settled);
    try {
      return await current;
    } finally {
      if (lanes.get(lane) === settled) lanes.delete(lane);
    }
  }

  serialize(target, operation) {
    return this.serializeIn(this.#lanes, target, operation);
  }

  serializeIntake(target, operation) {
    return this.serializeIn(this.#intakeLanes, target, operation);
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
    const existingRun = this.activeRun(target);
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
      const concurrentRun = this.activeRun(target);
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
    if (this.isMaintenanceActive(item)) throw contextMaintenanceActiveError();
    await this.bindDeferredOccupancy(item);
    const messageOrigin = normalizeInterstreamOrigin(item.messageOrigin);
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
      ...(messageOrigin ? { messageOrigin } : {}),
      deferredInput: item,
    };
    const run = await this.beginRun(item.input, target);
    if (this.isMaintenanceActive(target)) {
      await this.rollbackAdmission(run);
      throw contextMaintenanceActiveError();
    }
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
    conflictKind = reason,
    scheduleDelayMs = 500,
  }) {
    const deferred = await this.deferInput(input, attachments, {
      executionOwner,
      target,
      conflictKind,
      clientUserMessageId,
      destination: "queued",
      notify: false,
      persistentFiles: attachments.length > 0,
    });
    if (deferred.duplicate && deferred.durableResult) {
      return {
        ...deferred.durableResult,
        duplicate: true,
        clientUserMessageId,
      };
    }
    if (!deferred.duplicate) this.scheduleDeferred(deferred.item, scheduleDelayMs);
    return {
      accepted: reason === "message-intake",
      deferred: true,
      queued: true,
      duplicate: deferred.duplicate === true,
      duplicateOfClientUserMessageId: deferred.duplicateOfClientUserMessageId ?? null,
      id: deferred.id,
      runId: null,
      threadId: target.threadId,
      turnId: null,
      clientUserMessageId,
      reason,
      message: deferred.duplicate === true
        ? "Точный повтор уже находится в очереди и не был добавлен второй раз."
        : reason === "message-intake"
        ? "Сообщение принято Hub, сохранено и передано на запуск."
        : reason === "steer-unavailable"
        ? "Текущий ход уже нельзя изменить; сообщение сохранено в очереди."
        : reason === "context-maintenance"
          ? "Сообщение поставлено в очередь до завершения свёртки или ротации контекста."
          : reason === "provider-thread-active"
            ? "Codex ещё завершает предыдущий ход; сообщение сохранено в очереди."
            : "Сообщение поставлено в очередь и будет отправлено после текущего хода.",
    };
  }

  acceptClientInput(request) {
    return this.serializeIntake(request.target, () => this.acceptClientInputUnlocked(request));
  }

  async acceptClientInputUnlocked({
    input,
    attachments = [],
    target,
    clientUserMessageId,
    followUpMode = "",
  }) {
    const existingRun = this.activeRun(target);
    if (this.isMaintenanceActive(target)) {
      return this.queue(input, attachments, {
        target,
        executionOwner: TASK_EXECUTION_OWNERS.HUB,
        clientUserMessageId,
        reason: "context-maintenance",
      });
    }
    if (existingRun) {
      if (followUpMode === "steer") {
        return this.submitClientInputUnlocked({
          input,
          attachments,
          target,
          clientUserMessageId,
          followUpMode,
        });
      }
      if (followUpMode === "queue") {
        return this.queue(input, attachments, {
          target,
          executionOwner: existingRun.executionOwner ?? TASK_EXECUTION_OWNERS.HUB,
          clientUserMessageId,
        });
      }
      const deferred = await this.deferInput(input, attachments, {
        executionOwner: existingRun.executionOwner ?? TASK_EXECUTION_OWNERS.HUB,
        target,
        conflictKind: "task-running",
        clientUserMessageId,
        persistentFiles: attachments.length > 0,
      });
      return {
        accepted: false,
        deferred: true,
        id: deferred.id,
        clientUserMessageId,
        reason: "task-running",
        message: "Сообщение сохранено: выберите новый поток, очередь или отмену справа.",
      };
    }
    return this.queue(input, attachments, {
      target,
      executionOwner: TASK_EXECUTION_OWNERS.HUB,
      clientUserMessageId,
      reason: "message-intake",
      scheduleDelayMs: 0,
    });
  }

  steer(request) {
    return this.serialize(request.target, () => this.steerUnlocked(request));
  }

  async steerUnlocked({ input, target, clientUserMessageId }) {
    const existingRun = this.activeRun(target);
    const externalActivity = existingRun
      ? { state: "active", executionOwner: existingRun.executionOwner }
      : await this.externalActivity(target);
    if (!existingRun && externalActivity.state === "inactive") {
      throw new Error("Текущий ход уже завершён; сообщение осталось в очереди");
    }
    const executionOwner = normalizeTaskExecutionOwner(
      existingRun?.executionOwner ?? externalActivity.executionOwner,
    );
    if (executionOwner && executionOwner !== TASK_EXECUTION_OWNERS.HUB) {
      throw new Error("Active turn not steerable: another Codex runtime owns the writer");
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
      const messageOrigin = normalizeInterstreamOrigin(target?.messageOrigin);
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
          ...(messageOrigin ? {
            kind: "interstream",
            origin: structuredClone(messageOrigin),
            author: interstreamOriginAuthor(messageOrigin),
          } : {}),
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
    const existingRun = this.activeRun(target);
    const externalActivity = existingRun
      ? { state: "active", executionOwner: existingRun.executionOwner }
      : await this.externalActivity(target);
    if (existingRun || externalActivity.state !== "inactive") {
      if (followUpMode === "steer") {
        const executionOwner = normalizeTaskExecutionOwner(
          existingRun?.executionOwner ?? externalActivity.executionOwner,
        );
        if (executionOwner && executionOwner !== TASK_EXECUTION_OWNERS.HUB) {
          return this.queue(input, attachments, {
            target,
            executionOwner,
            clientUserMessageId,
            reason: "provider-thread-active",
          });
        }
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
          : "Сообщение сохранено: выберите новый поток, очередь или отмену справа.",
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
        message: `Сообщение сохранено: поток «${repositoryConflict.taskTitle ?? "Без названия"}» уже изменяет тот же Git-репозиторий.`,
      };
    }
    const run = await this.beginRun(input, { ...target, clientUserMessageId });
    run.messageAttachments = this.describeAttachments(attachments);
    try {
      await this.launchTurn(run, input, []);
    } catch (error) {
      if (!providerThreadAlreadyActive(error)) throw error;
      await this.rollbackAdmission(run);
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
