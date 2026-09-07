import { randomUUID } from "node:crypto";
import {
  displayUserPrompt,
  responseAnnotationDetails,
  userTaskReferencePromptDetails,
} from "../../application/task-history.mjs";
import { deferredInputText } from "../../domain/deferred-input.mjs";
import {
  interstreamMessageDetails,
  normalizeInterstreamOrigin,
} from "../../domain/interstream-message.mjs";

// Maps deferred-input UI actions to application commands for one exact task.
function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class DesktopDeferredInputService {
  #d;
  #actions = new Map();

  constructor(dependencies = {}) {
    for (const name of [
      "saveState", "updateReceipt", "cleanupFiles",
      "updateMessage", "scheduleNext", "scheduleQueued", "selectTask", "clientContext",
      "startTurn", "startDeferred", "runForTask", "describeAttachments", "selectedTask", "dispatchCommand",
      "activeTitle", "snapshot",
    ]) requiredFunction(dependencies[name], name);
    if (!dependencies.composerTransfers?.remember || !dependencies.composerTransfers?.has) {
      throw new TypeError("composerTransfers is required");
    }
    this.#d = dependencies;
    this.#d.createComposerTransferId ??= randomUUID;
  }

  handle(params, context = null) {
    const id = String(params.id ?? "");
    const action = String(params.action ?? "");
    if (!id) throw new Error("Не указан идентификатор сообщения");
    const actionKey = action.startsWith("composer-")
      ? `${action}\0${String(params.token ?? "").trim()}`
      : action === "edit"
      ? `${action}\0${String(params.text ?? "").trim()}`
      : action === "move" ? `${action}\0${String(params.direction ?? "")}` : action;
    return this.#withAction(id, actionKey, () => this.#execute(id, action, params, context));
  }

  #withAction(id, action, operation) {
    const existing = this.#actions.get(id);
    if (existing) {
      if (existing.action === action) return existing.promise;
      return existing.promise.catch(() => {}).then(() => this.#withAction(id, action, operation));
    }
    const promise = Promise.resolve().then(operation);
    const entry = { action, promise };
    this.#actions.set(id, entry);
    return promise.finally(() => {
      if (this.#actions.get(id) === entry) this.#actions.delete(id);
    });
  }

  async #execute(id, action, params, context) {
    const d = this.#d;
    const item = d.pendingInputs.get(id) ?? d.queuedInputs.get(id);
    if (!item) {
      if (action === "composer-commit" && d.composerTransfers.has({ id, token: params.token })) {
        return { accepted: true, id, committed: true, message: "Сообщение возвращено в композер" };
      }
      const completed = action === "steer" ? d.findReceiptByResultId(id)?.result : null;
      if (completed?.steered === true) return completed;
      throw new Error("Сохранённое сообщение уже обработано");
    }
    if (action === "composer-prepare") return this.#prepareComposerTransfer(item);
    if (action === "composer-commit") return this.#commitComposerTransfer(item, params.token);
    if (action === "composer-release") return this.#releaseComposerTransfer(item, params.token);
    if (item.composerTransfer) {
      throw new Error("Сообщение уже возвращается в композер");
    }
    if (action === "edit") {
      throw new Error("Изменение сообщения выполняется только через возврат в основной композер");
    }
    if (action === "move") {
      if (!d.queuedInputs.has(id) || item.dispatchingAt || d.isProcessing(id)) {
        throw new Error("Можно переставлять только ожидающие сообщения очереди");
      }
      const direction = String(params.direction ?? "");
      if (!["up", "down"].includes(direction)) throw new Error("Неизвестное направление перемещения");
      const siblings = [...d.queuedInputs.values()]
        .filter((candidate) => this.#bindingKey(candidate) === this.#bindingKey(item))
        .sort((left, right) => {
          const leftOrder = Number.isFinite(Number(left.queueOrder)) ? Number(left.queueOrder) : Date.parse(left.createdAt || 0);
          const rightOrder = Number.isFinite(Number(right.queueOrder)) ? Number(right.queueOrder) : Date.parse(right.createdAt || 0);
          return leftOrder - rightOrder;
        });
      const index = siblings.findIndex((candidate) => candidate.id === id);
      const nextIndex = direction === "up" ? index - 1 : index + 1;
      if (index >= 0 && nextIndex >= 0 && nextIndex < siblings.length) {
        const previous = siblings.map((candidate) => [candidate, this.#itemState(candidate)]);
        [siblings[index], siblings[nextIndex]] = [siblings[nextIndex], siblings[index]];
        siblings.forEach((candidate, order) => { candidate.queueOrder = order; });
        try {
          await d.saveState();
        } catch (error) {
          for (const [candidate, descriptors] of previous) this.#restoreItemState(candidate, descriptors);
          throw error;
        }
      }
      return { accepted: true, id, message: "Порядок очереди изменён" };
    }
    if (action === "pause") {
      if (!d.queuedInputs.has(id)) throw new Error("Сообщение не находится в очереди");
      const previous = this.#itemState(item);
      const wasScheduled = d.cancelSchedule(id);
      item.paused = true;
      delete item.dispatchingAt;
      delete item.lastError;
      delete item.lastErrorCode;
      delete item.recheckRequested;
      try {
        await d.saveState();
      } catch (error) {
        this.#restoreItemState(item, previous);
        if (wasScheduled) d.scheduleQueued(item, 0);
        throw error;
      }
      return { accepted: true, id, message: "Сообщение в очереди приостановлено" };
    }
    if (action === "resume") {
      if (!d.queuedInputs.has(id)) throw new Error("Сообщение не находится в очереди");
      delete item.paused;
      delete item.lastError;
      delete item.lastErrorCode;
      if (item.waitReason === "provider-thread-active") item.recheckRequested = true;
      await d.saveState();
      d.scheduleQueued(item, 0);
      return {
        accepted: true,
        id,
        message: item.waitReason === "provider-thread-active"
          ? "Повторная проверка занятости запущена"
          : "Очередь возобновлена",
      };
    }
    if (action === "steer") {
      if (item.dispatchingAt || d.isProcessing(id)) {
        throw new Error("Сообщение уже отправляется; изменить текущий ход нельзя");
      }
      const destination = d.queuedInputs.has(id) ? "queued" : "pending";
      d.cancelSchedule(id);
      d.pendingInputs.delete(id);
      d.queuedInputs.delete(id);
      item.manualAction = "steer";
      d.pendingInputs.set(id, item);
      await d.saveState();
      try {
        const result = await d.steerActiveInput({
          input: item.input,
          target: this.#binding(item),
          clientUserMessageId: item.clientUserMessageId,
        });
        d.pendingInputs.delete(id);
        delete item.manualAction;
        d.updateReceipt(item, "steered", result);
        await d.saveState();
        await d.updateMessage(item, "⚠️ Сообщение добавлено в текущий ход.");
        d.scheduleNext(item);
        return { accepted: true, ...result };
      } catch (error) {
        d.pendingInputs.delete(id);
        delete item.manualAction;
        (destination === "queued" ? d.queuedInputs : d.pendingInputs).set(id, item);
        await d.saveState();
        if (destination === "queued") d.scheduleQueued(item, 500);
        throw error;
      }
    }
    if (action === "cancel") {
      if (item.dispatchingAt || d.isProcessing(id)) {
        throw new Error("Сообщение уже отправляется; отмена не подтверждена");
      }
      const destination = d.pendingInputs.has(id) ? "pending" : "queued";
      const wasScheduled = destination === "queued" ? d.cancelSchedule(id) : false;
      d.pendingInputs.delete(id);
      d.queuedInputs.delete(id);
      try {
        await d.saveState();
      } catch (error) {
        (destination === "queued" ? d.queuedInputs : d.pendingInputs).set(id, item);
        if (wasScheduled) d.scheduleQueued(item, 0);
        throw error;
      }
      d.updateReceipt(item, "cancelled");
      await d.cleanupFiles(item);
      await d.updateMessage(item, "❌ Сохранённое сообщение отменено.");
      d.scheduleNext(item);
      return { accepted: true, message: "Сохранённое сообщение отменено" };
    }
    if (action === "queue" || action === "retry") {
      if (d.queuedInputs.has(id)) return { accepted: true, id, queued: true, message: "Сообщение уже находится в очереди" };
      if (!d.pendingInputs.has(id)) throw new Error("Сохранённое сообщение уже обработано");
      d.pendingInputs.delete(id);
      delete item.paused;
      delete item.lastError;
      delete item.lastErrorCode;
      delete item.waitReason;
      d.queuedInputs.set(id, item);
      d.updateReceipt(item, "queued");
      await d.saveState();
      await d.updateMessage(item, `⏳ Сообщение поставлено в очередь потока «${item.taskTitle}».`);
      d.scheduleQueued(item, 500);
      return { accepted: true, message: "Сообщение поставлено в очередь" };
    }
    const binding = this.#binding(item);
    if (action === "new") {
      if (!binding.streamId) {
        throw new Error("Нельзя безопасно создать новый поток для сообщения без Stream-привязки");
      }
      if (item.dispatchingAt || d.isProcessing(id)) {
        throw new Error("Сообщение уже отправляется и не может быть перенесено");
      }
      const destination = d.queuedInputs.has(id) ? "queued" : "pending";
      d.cancelSchedule(id);
      d.pendingInputs.delete(id);
      d.queuedInputs.delete(id);
      item.manualAction = "new";
      delete item.paused;
      delete item.recheckRequested;
      d.pendingInputs.set(id, item);
      await d.saveState();
      try {
        await d.selectTask(binding, d.clientContext(context, "desktop"));
        const createResult = await d.dispatchCommand("task.create", {
          provider: binding.provider,
          streamId: binding.streamId,
        }, d.clientContext(context, "desktop"));
        const selectedTask = d.selectedTask();
        const createdTask = createResult?.createdTask ?? {};
        const newTarget = {
          ...selectedTask,
          ...createdTask,
          provider: createdTask.provider ?? selectedTask.provider ?? binding.provider,
          streamId: createdTask.streamId ?? selectedTask.streamId ?? binding.streamId,
          projectRoot: createdTask.projectRoot ?? selectedTask.projectRoot ?? item.projectRoot,
          threadId: createdTask.threadId ?? selectedTask.threadId,
          taskTitle: createdTask.taskTitle ?? createdTask.title ?? d.activeTitle(),
        };
        const startedRun = await d.startDeferred({
          ...item,
          ...newTarget,
          input: item.input,
          temporaryFiles: item.temporaryFiles ?? [],
          forceSpeechButton: item.forceSpeechButton === true,
          persistentFiles: item.persistentFiles === true,
          telegramDeliveryRequested: false,
        });
        if (startedRun && item.persistentFiles) {
          startedRun.messageAttachments = d.describeAttachments(item.temporaryFiles);
        }
        d.pendingInputs.delete(id);
        delete item.manualAction;
        delete item.waitReason;
        d.updateReceipt(item, "started", startedRun);
        await d.saveState();
        await d.updateMessage(item, `🆕 Сообщение отправлено в новый поток «${d.activeTitle()}».`);
        d.scheduleNext(item);
        return { accepted: true, message: "Сообщение отправлено в новый поток", snapshot: await d.snapshot() };
      } catch (error) {
        d.pendingInputs.delete(id);
        delete item.manualAction;
        (destination === "queued" ? d.queuedInputs : d.pendingInputs).set(id, item);
        await d.saveState();
        if (destination === "queued") d.scheduleQueued(item, 500);
        throw error;
      }
    }
    if (!d.pendingInputs.has(id)) throw new Error("Сообщение уже находится в очереди");
    if (action === "force") {
      if (item.allowForce !== true) throw new Error("Принудительный запуск для этого сообщения не разрешён");
      await d.selectTask(binding, d.clientContext(context, "desktop"));
      const outcome = await d.startTurn(item.input, item.temporaryFiles ?? [], {
        forceSpeechButton: item.forceSpeechButton === true,
        target: {
          ...binding, chatId: item.chatId, modelId: item.modelId, reasoningId: item.reasoningId,
          collaborationMode: item.collaborationMode, clientUserMessageId: item.clientUserMessageId,
        },
        allowRepositoryConflict: item.conflictKind === "repository",
        allowUnknownExternalActivity: item.conflictKind === "activity-unknown",
        persistentFiles: item.persistentFiles === true,
        telegramDeliveryRequested: false,
      });
      if (outcome?.deferred) throw new Error("Условие безопасного запуска всё ещё не выполнено");
      const startedRun = d.runForTask(binding);
      if (startedRun && item.persistentFiles) startedRun.messageAttachments = d.describeAttachments(item.temporaryFiles);
      d.pendingInputs.delete(id);
      d.updateReceipt(item, "started", startedRun);
      await d.saveState();
      await d.updateMessage(item, `⚠️ Сообщение отправлено в поток «${item.taskTitle}».`);
      d.scheduleNext(item);
      return { accepted: true, message: "Сообщение принудительно запущено" };
    }
    throw new Error("Неизвестное действие с сохранённым сообщением");
  }

  #composerDraft(item) {
    const rawText = deferredInputText(item.input);
    const interstreamAt = rawText.indexOf("<agent-hub-stream-message>");
    const interstream = interstreamAt >= 0
      ? interstreamMessageDetails(rawText.slice(interstreamAt))
      : null;
    const prompt = interstream?.text ?? rawText;
    const embeddedOrigin = interstream?.origin ?? null;
    const annotated = responseAnnotationDetails(prompt);
    const referenced = userTaskReferencePromptDetails(prompt);
    const text = annotated?.request
      ?? referenced?.displayText
      ?? displayUserPrompt(prompt);
    return {
      text: String(text ?? ""),
      attachments: item.persistentFiles
        ? this.#d.describeAttachments(item.temporaryFiles ?? [])
        : [],
      taskReferences: (referenced?.references ?? []).map((reference) => ({ ...reference })),
      annotations: (annotated?.items ?? []).map((annotation) => ({
        quote: annotation.text,
        annotation: annotation.annotation,
        ...(annotation.source ? { source: annotation.source } : {}),
      })),
      messageOrigin: normalizeInterstreamOrigin(item.messageOrigin) ?? embeddedOrigin ?? null,
    };
  }

  async #prepareComposerTransfer(item) {
    const d = this.#d;
    if (item.dispatchingAt || d.isProcessing(item.id)) {
      throw new Error("Сообщение уже отправляется и не может быть возвращено в композер");
    }
    if (item.persistentFiles !== true && (item.temporaryFiles ?? []).length) {
      throw new Error("Вложения этого сообщения нельзя безопасно вернуть в композер");
    }
    if (item.composerTransfer?.token) {
      return {
        accepted: true,
        id: item.id,
        token: item.composerTransfer.token,
        binding: this.#binding(item),
        draft: this.#composerDraft(item),
      };
    }
    const previous = this.#itemState(item);
    const wasScheduled = d.cancelSchedule(item.id);
    item.composerTransfer = {
      token: String(d.createComposerTransferId()).trim(),
      paused: item.paused === true,
    };
    item.paused = true;
    delete item.dispatchingAt;
    try {
      await d.saveState();
    } catch (error) {
      this.#restoreItemState(item, previous);
      if (wasScheduled) d.scheduleQueued(item, 0);
      throw error;
    }
    return {
      accepted: true,
      id: item.id,
      token: item.composerTransfer.token,
      binding: this.#binding(item),
      draft: this.#composerDraft(item),
    };
  }

  async #commitComposerTransfer(item, token) {
    const d = this.#d;
    const normalizedToken = String(token ?? "").trim();
    if (!normalizedToken || item.composerTransfer?.token !== normalizedToken) {
      throw new Error("Перенос черновика устарел; очередь не изменена");
    }
    const destination = d.pendingInputs.has(item.id) ? "pending" : "queued";
    d.cancelSchedule(item.id);
    d.pendingInputs.delete(item.id);
    d.queuedInputs.delete(item.id);
    try {
      await d.saveState();
    } catch (error) {
      (destination === "queued" ? d.queuedInputs : d.pendingInputs).set(item.id, item);
      throw error;
    }
    d.composerTransfers.remember(item, normalizedToken);
    d.updateReceipt(item, "cancelled");
    await d.updateMessage(item, "✏️ Сообщение возвращено в основной композер.");
    d.scheduleNext(item);
    return { accepted: true, id: item.id, committed: true, message: "Сообщение возвращено в композер" };
  }

  async #releaseComposerTransfer(item, token) {
    const d = this.#d;
    const normalizedToken = String(token ?? "").trim();
    if (!item.composerTransfer) {
      return { accepted: true, id: item.id, released: true };
    }
    if (!normalizedToken || item.composerTransfer.token !== normalizedToken) {
      throw new Error("Перенос черновика устарел; очередь не изменена");
    }
    const previous = this.#itemState(item);
    const wasPaused = item.composerTransfer.paused === true;
    delete item.composerTransfer;
    if (wasPaused) item.paused = true;
    else delete item.paused;
    try {
      await d.saveState();
    } catch (error) {
      this.#restoreItemState(item, previous);
      throw error;
    }
    if (d.queuedInputs.has(item.id) && !wasPaused) d.scheduleQueued(item, 0);
    return { accepted: true, id: item.id, released: true };
  }

  #binding(item) {
    return {
      streamId: item.streamId ?? null,
      provider: item.provider, projectRoot: item.projectRoot,
      threadId: item.threadId, taskTitle: item.taskTitle,
    };
  }

  #bindingKey(item) {
    const streamId = String(item.streamId ?? "").trim().toLowerCase();
    if (streamId) return `stream\0${streamId}`;
    const binding = this.#binding(item);
    return [binding.provider, binding.projectRoot, binding.threadId]
      .map((value) => String(value ?? "").trim().toLowerCase())
      .join("\0");
  }

  #itemState(item) {
    return Object.getOwnPropertyDescriptors(item);
  }

  #restoreItemState(item, descriptors) {
    for (const key of Reflect.ownKeys(item)) delete item[key];
    Object.defineProperties(item, descriptors);
  }
}
