import {
  normalizeTaskExecutionOwner,
  TASK_EXECUTION_OWNERS,
} from "../domain/task-execution-owner.mjs";
import {
  interstreamDisplayText,
  interstreamOriginAuthor,
  normalizeInterstreamOrigin,
} from "../domain/interstream-message.mjs";
import {
  contextMaintenanceActiveError,
  runtimeRestartPendingError,
} from "../domain/deferred-input.mjs";
import {
  taskOccupancyIdentity,
  taskRunIsActive,
  taskRunKey,
} from "../domain/task-runs.mjs";
import { taskReferencePromptDetails } from "../domain/task-board-task.mjs";

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

const CLAUDE_EXTERNAL_OWNER_ACTIVE = "ERR_CLAUDE_EXTERNAL_OWNER_ACTIVE";
const CLAUDE_EXTERNAL_OWNER_UNKNOWN = "ERR_CLAUDE_EXTERNAL_OWNER_UNKNOWN";

function persistentAttachmentDescriptors(describeAttachments, files, persistentFiles) {
  return persistentFiles ? describeAttachments(files) : [];
}

export class RunCoordinator {
  #lanes = new Map();
  #intakeLanes = new Map();
  #pendingAdmissions = new Map();
  #nextPendingAdmissionId = 0;

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
    isManagedMaintenanceActive = isMaintenanceActive,
    isRuntimeStopping = () => false,
    scheduleDeferred = () => {},
    setProgressStage = () => {},
    noteRunActivity = () => {},
    scheduleProgressUpdate = () => {},
    rekeyDeferredOccupancy = null,
    bindDashboardTask = null,
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
    this.isManagedMaintenanceActive = isManagedMaintenanceActive;
    this.isRuntimeStopping = isRuntimeStopping;
    this.scheduleDeferred = scheduleDeferred;
    this.setProgressStage = setProgressStage;
    this.noteRunActivity = noteRunActivity;
    this.scheduleProgressUpdate = scheduleProgressUpdate;
    this.rekeyDeferredOccupancy = rekeyDeferredOccupancy;
    this.bindDashboardTask = typeof bindDashboardTask === "function" ? bindDashboardTask : null;
    this.dispatchingClientMessageIds = new Map();
    this.beforeDeferredDispatch = null;
  }

  async bindStartedDashboardTask(run, input) {
    if (!this.bindDashboardTask || !run?.turnId) return;
    const text = typeof input === "string"
      ? input
      : (Array.isArray(input) ? input : []).filter((item) => item?.type === "text")
        .map((item) => String(item.text ?? "")).join("\n");
    const reference = taskReferencePromptDetails(text)?.references
      ?.find((candidate) => candidate.intent === "start");
    if (reference?.taskId) await this.bindDashboardTask({ run, taskId: reference.taskId });
  }

  taskLane(target) {
    return taskOccupancyIdentity(target)?.key ?? taskRunKey(target ?? {});
  }

  activeRun(target) {
    const run = this.taskRuns.forTask(target);
    return taskRunIsActive(run) ? run : null;
  }

  async deferOccupiedInput(input, attachments, options) {
    const deferred = await this.deferInput(input, attachments, options);
    if (!deferred.duplicate) this.scheduleDeferred(deferred.item);
    return deferred;
  }

  maintenanceBarrier(target, { exactManagedSteer = false } = {}) {
    const active = exactManagedSteer
      ? this.isManagedMaintenanceActive(target)
      : this.isMaintenanceActive(target);
    return active ? "context-maintenance" : null;
  }

  admissionBarrier(target, options = {}) {
    if (this.isRuntimeStopping()) return "runtime-restart";
    return this.maintenanceBarrier(target, options);
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

  async withPendingAdmission(target, operation) {
    const id = ++this.#nextPendingAdmissionId;
    const admissionTarget = Object.freeze({
      streamId: String(target?.streamId ?? "").trim(),
      provider: String(target?.provider ?? "").trim().toLowerCase(),
      threadId: String(target?.threadId ?? "").trim(),
    });
    this.#pendingAdmissions.set(id, admissionTarget);
    try {
      return await operation();
    } finally {
      this.#pendingAdmissions.delete(id);
    }
  }

  hasPendingAdmission(matcher) {
    if (typeof matcher !== "function") throw new TypeError("pending admission matcher is required");
    return [...this.#pendingAdmissions.values()].some((target) => matcher(target));
  }

  start(input, temporaryFiles = [], options = {}) {
    return this.withPendingAdmission(options.target, () => (
      this.serialize(options.target, () => this.startUnlocked(input, temporaryFiles, options))
    ));
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
    if (this.isRuntimeStopping()) {
      return this.queue(input, temporaryFiles, {
        target,
        clientUserMessageId: target.clientUserMessageId,
        reason: "runtime-restart",
      });
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
      return this.deferOccupiedInput(input, temporaryFiles, {
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
      if ([CLAUDE_EXTERNAL_OWNER_ACTIVE, CLAUDE_EXTERNAL_OWNER_UNKNOWN].includes(error?.code)) {
        return this.deferOccupiedInput(input, temporaryFiles, {
          forceSpeechButton,
          executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
          target,
          allowForce: error.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
          conflictKind: error.code === CLAUDE_EXTERNAL_OWNER_ACTIVE
            ? "task-running"
            : "activity-unknown",
          persistentFiles,
        });
      }
      const concurrentRun = this.activeRun(target);
      if (error.message !== "this task is already running" || !concurrentRun) throw error;
      return this.deferOccupiedInput(input, temporaryFiles, {
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
    await this.bindStartedDashboardTask(run, input);
    return { started: true, runId: run.id, run };
  }

  async startDeferred(item) {
    this.beforeDeferredDispatch?.(item);
    const id = String(item.clientUserMessageId ?? "");
    if (id) this.dispatchingClientMessageIds.set(id, (this.dispatchingClientMessageIds.get(id) ?? 0) + 1);
    return this.withPendingAdmission(item, () => (
      this.serialize(item, () => this.startDeferredUnlocked(item))
    )).finally(() => {
      const count = this.dispatchingClientMessageIds.get(id) ?? 0;
      if (count <= 1) this.dispatchingClientMessageIds.delete(id);
      else this.dispatchingClientMessageIds.set(id, count - 1);
    });
  }

  async startDeferredUnlocked(item) {
    const initialBarrier = this.admissionBarrier(item);
    if (initialBarrier === "runtime-restart") throw runtimeRestartPendingError();
    if (initialBarrier) throw contextMaintenanceActiveError();
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
    const admittedBarrier = this.admissionBarrier(target);
    if (admittedBarrier) {
      await this.rollbackAdmission(run);
      if (admittedBarrier === "runtime-restart") throw runtimeRestartPendingError();
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
    await this.bindStartedDashboardTask(run, item.input);
    return run;
  }

  async queue(input, attachments, {
    target,
    executionOwner,
    clientUserMessageId,
    clientProjectionIntent = null,
    messageFingerprint = null,
    reason = "task-running",
    conflictKind = reason,
    scheduleDelayMs = 500,
  }) {
    const deferred = await this.deferInput(input, attachments, {
      executionOwner,
      target,
      conflictKind,
      clientUserMessageId,
      clientProjectionIntent,
      messageFingerprint,
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
      accepted: ["message-intake", "runtime-restart", "final-answer-active"].includes(reason),
      providerAccepted: false,
      deferred: true,
      queued: true,
      duplicate: deferred.duplicate === true,
      duplicateOfClientUserMessageId: deferred.duplicateOfClientUserMessageId ?? null,
      id: deferred.id,
      runId: null,
      threadId: target.threadId,
      turnId: null,
      clientUserMessageId,
      ...(clientProjectionIntent ? { clientProjectionIntent } : {}),
      reason,
      message: deferred.duplicate === true
        ? "Точный повтор уже находится в очереди и не был добавлен второй раз."
        : reason === "message-intake"
        ? "Сообщение принято Hub и сохранено в очереди; ход провайдера ещё не запущен."
        : reason === "steer-unavailable"
        ? "Текущий ход уже нельзя изменить; сообщение сохранено в очереди."
        : reason === "final-answer-active"
        ? "Финальный ответ уже формируется; сообщение сохранено в очереди для следующего хода."
        : reason === "context-maintenance"
          ? "Сообщение поставлено в очередь до завершения свёртки или ротации контекста."
          : reason === "runtime-restart"
            ? "Сообщение сохранено и будет запущено после готовности нового Agent Hub runtime."
            : reason === "provider-thread-active"
            ? "Codex ещё завершает предыдущий ход; сообщение сохранено в очереди."
            : "Сообщение поставлено в очередь и будет отправлено после текущего хода.",
    };
  }

  async queueSteer(input, attachments, {
    target,
    existingRun,
    clientUserMessageId,
    clientProjectionIntent = null,
    messageFingerprint = null,
  }) {
    const deferred = await this.deferInput(input, attachments, {
      executionOwner: existingRun.executionOwner ?? TASK_EXECUTION_OWNERS.HUB,
      target,
      conflictKind: "message-steer",
      clientUserMessageId,
      clientProjectionIntent,
      messageFingerprint,
      steerTargetRunId: existingRun.id ?? null,
      steerTargetTurnId: existingRun.turnId ?? null,
      destination: "queued",
      notify: false,
      persistentFiles: attachments.length > 0,
    });
    if (!deferred.duplicate) this.scheduleDeferred(deferred.item, 0);
    return {
      accepted: true,
      steerPending: true,
      deferred: false,
      queued: false,
      duplicate: deferred.duplicate === true,
      id: deferred.id,
      runId: existingRun.id ?? null,
      threadId: target.threadId,
      turnId: existingRun.turnId ?? null,
      clientUserMessageId,
      ...(clientProjectionIntent ? { clientProjectionIntent } : {}),
      message: deferred.duplicate === true
        ? "Уточнение уже принято Hub и не было отправлено повторно."
        : "Уточнение принято Hub и будет добавлено в текущий ход.",
    };
  }

  async acceptClientInput(request) {
    this.beforeDeferredDispatch?.();
    return this.withPendingAdmission(request.target, () => (
      this.serializeIntake(request.target, () => this.acceptClientInputUnlocked(request))
    ));
  }

  async acceptClientInputUnlocked({
    input,
    attachments = [],
    target,
    clientUserMessageId,
    clientProjectionIntent = null,
    messageFingerprint = null,
    followUpMode = "",
  }) {
    const existingRun = this.activeRun(target);
    const admissionBarrier = this.admissionBarrier(target, {
      exactManagedSteer: followUpMode === "steer" && Boolean(existingRun),
    });
    if (admissionBarrier && (admissionBarrier === "runtime-restart"
      || !(followUpMode === "steer" && existingRun))) {
      return this.queue(input, attachments, {
        target,
        executionOwner: TASK_EXECUTION_OWNERS.HUB,
        clientUserMessageId,
        clientProjectionIntent,
        messageFingerprint,
        reason: admissionBarrier,
      });
    }
    if (existingRun?.status === "finishing" && followUpMode !== "steer") {
      return this.queue(input, attachments, {
        target,
        executionOwner: existingRun.executionOwner ?? TASK_EXECUTION_OWNERS.HUB,
        clientUserMessageId,
        clientProjectionIntent,
        messageFingerprint,
        reason: "message-intake",
        scheduleDelayMs: 0,
      });
    }
    if (existingRun) {
      if (followUpMode === "steer") {
        return this.queueSteer(input, attachments, {
          existingRun,
          messageFingerprint,
          target,
          clientUserMessageId,
          clientProjectionIntent,
        });
      }
      if (followUpMode === "queue") {
        return this.queue(input, attachments, {
          target,
          executionOwner: existingRun.executionOwner ?? TASK_EXECUTION_OWNERS.HUB,
          clientUserMessageId,
          clientProjectionIntent,
          messageFingerprint,
        });
      }
      const deferred = await this.deferOccupiedInput(input, attachments, {
        executionOwner: existingRun.executionOwner ?? TASK_EXECUTION_OWNERS.HUB,
        target,
        conflictKind: "task-running",
        clientUserMessageId,
        clientProjectionIntent,
        messageFingerprint,
        persistentFiles: attachments.length > 0,
      });
      return {
        accepted: false,
        deferred: true,
        id: deferred.id,
        clientUserMessageId,
        ...(clientProjectionIntent ? { clientProjectionIntent } : {}),
        reason: "task-running",
        message: "Сообщение сохранено: выберите новый поток, очередь или отмену справа.",
      };
    }
    return this.queue(input, attachments, {
      target,
      executionOwner: TASK_EXECUTION_OWNERS.HUB,
      clientUserMessageId,
      clientProjectionIntent,
      messageFingerprint,
      reason: "message-intake",
      scheduleDelayMs: 0,
    });
  }

  steer(request) {
    return this.withPendingAdmission(request.target, () => (
      this.serialize(request.target, () => this.steerUnlocked(request))
    ));
  }

  async steerUnlocked({ input, target, clientUserMessageId }) {
    if (this.isRuntimeStopping()) throw runtimeRestartPendingError();
    const existingRun = this.activeRun(target);
    const expectedRunId = String(target?.steerTargetRunId ?? "").trim();
    const expectedTurnId = String(target?.steerTargetTurnId ?? "").trim();
    if ((expectedRunId && expectedRunId !== String(existingRun?.id ?? "").trim())
      || (expectedTurnId && expectedTurnId !== String(existingRun?.turnId ?? "").trim())) {
      throw new Error("Active turn not steerable: the targeted managed turn is no longer active");
    }
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
        const rawText = typeof input === "string"
          ? input
          : input.filter((item) => item?.type === "text")
            .map((item) => String(item.text ?? ""))
            .filter(Boolean)
            .join("\n");
        userMessages.push({
          role: "user",
          clientUserMessageId,
          text: interstreamDisplayText(rawText, {
            origin: messageOrigin,
            clientUserMessageId,
          }),
          ...(messageOrigin ? {
            kind: "interstream",
            origin: structuredClone(messageOrigin),
            author: interstreamOriginAuthor(messageOrigin),
          } : {}),
          time: new Date().toISOString(),
        });
        existingRun.userMessages = userMessages;
      } else if (messageOrigin) {
        // A provider user event can arrive before steerTurn resolves. Enrich
        // its exact occurrence instead of losing the admitted source metadata.
        const matches = userMessages.filter((message) => message.role === "user"
          && String(message.clientUserMessageId ?? "") === clientUserMessageId);
        if (matches.length === 1 && !matches[0].origin && !matches[0].messageOrigin) {
          Object.assign(matches[0], {
            kind: "interstream",
            origin: structuredClone(messageOrigin),
            author: interstreamOriginAuthor(messageOrigin),
          });
        }
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
    return this.withPendingAdmission(request.target, () => (
      this.serialize(request.target, () => this.submitClientInputUnlocked(request))
    ));
  }

  async submitClientInputUnlocked({
    input,
    attachments = [],
    target,
    clientUserMessageId,
    clientProjectionIntent = null,
    followUpMode = "",
  }) {
    const existingRun = this.activeRun(target);
    const admissionBarrier = this.admissionBarrier(target, {
      exactManagedSteer: followUpMode === "steer" && Boolean(existingRun),
    });
    if (admissionBarrier) {
      return this.queue(input, attachments, {
        target,
        executionOwner: TASK_EXECUTION_OWNERS.HUB,
        clientUserMessageId,
        clientProjectionIntent,
        reason: admissionBarrier,
      });
    }
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
            clientProjectionIntent,
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
            clientProjectionIntent,
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
          clientProjectionIntent,
        });
      }
      const deferred = await this.deferOccupiedInput(input, attachments, {
        executionOwner: existingRun?.executionOwner
          ?? externalActivity.executionOwner
          ?? TASK_EXECUTION_OWNERS.EXTERNAL,
        target,
        allowForce: externalActivity.state === "unknown" && !existingRun,
        conflictKind: externalActivity.state === "unknown" && !existingRun
          ? "activity-unknown"
          : "task-running",
        clientUserMessageId,
        clientProjectionIntent,
        persistentFiles: attachments.length > 0,
      });
      return {
        accepted: false,
        deferred: true,
        id: deferred.id,
        clientUserMessageId,
        ...(clientProjectionIntent ? { clientProjectionIntent } : {}),
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
        clientProjectionIntent,
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
        clientProjectionIntent,
        persistentFiles: attachments.length > 0,
      });
      return {
        accepted: false,
        deferred: true,
        id: deferred.id,
        clientUserMessageId,
        ...(clientProjectionIntent ? { clientProjectionIntent } : {}),
        reason: "repository-conflict",
        message: `Сообщение сохранено: поток «${repositoryConflict.taskTitle ?? "Без названия"}» уже изменяет тот же Git-репозиторий.`,
      };
    }
    let run;
    try {
      run = await this.beginRun(input, { ...target, clientUserMessageId });
    } catch (error) {
      if (![CLAUDE_EXTERNAL_OWNER_ACTIVE, CLAUDE_EXTERNAL_OWNER_UNKNOWN].includes(error?.code)) throw error;
      return this.queue(input, attachments, {
        target,
        executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
        clientUserMessageId,
        clientProjectionIntent,
        reason: error.code === CLAUDE_EXTERNAL_OWNER_ACTIVE
          ? "provider-thread-active"
          : "provider-temporarily-unavailable",
      });
    }
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
        clientProjectionIntent,
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
