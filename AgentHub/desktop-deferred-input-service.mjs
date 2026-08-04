function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class DesktopDeferredInputService {
  #d;
  #actions = new Map();

  constructor(dependencies = {}) {
    for (const name of [
      "responseAnnotations", "replaceInputText", "saveState", "updateReceipt", "cleanupFiles",
      "updateMessage", "scheduleNext", "scheduleQueued", "selectTask", "clientContext",
      "startTurn", "runForTask", "describeAttachments", "selectedTask", "dispatchCommand",
      "activeTitle", "snapshot",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  handle(params, context = null) {
    const id = String(params.id ?? "");
    const action = String(params.action ?? "");
    if (!id) throw new Error("Не указан идентификатор сообщения");
    const actionKey = action === "edit" ? `${action}\0${String(params.text ?? "").trim()}` : action;
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
      const completed = action === "steer" ? d.findReceiptByResultId(id)?.result : null;
      if (completed?.steered === true) return completed;
      throw new Error("Сохранённое сообщение уже обработано");
    }
    if (action === "edit") {
      if (item.dispatchingAt || d.isProcessing(id)) {
        throw new Error("Сообщение уже отправляется и больше не может быть изменено");
      }
      const text = String(params.text ?? "").trim();
      const annotations = d.responseAnnotations(item.input)?.annotations ?? [];
      if (!text && !(item.temporaryFiles ?? []).length && !annotations.length) {
        throw new Error("Введите сообщение или оставьте изображение либо аннотацию");
      }
      if (text.length > 100_000) throw new Error("Сообщение слишком длинное");
      item.input = d.replaceInputText(item.input, text);
      await d.saveState();
      return { accepted: true, id, message: "Сообщение в очереди изменено" };
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
      d.pendingInputs.delete(id);
      d.queuedInputs.delete(id);
      d.updateReceipt(item, "cancelled");
      await d.cleanupFiles(item);
      await d.saveState();
      await d.updateMessage(item, "❌ Сохранённое сообщение отменено.");
      d.scheduleNext(item);
      return { accepted: true, message: "Сохранённое сообщение отменено" };
    }
    if (action === "queue") {
      if (d.queuedInputs.has(id)) return { accepted: true, id, queued: true, message: "Сообщение уже находится в очереди" };
      if (!d.pendingInputs.has(id)) throw new Error("Сохранённое сообщение уже обработано");
      d.pendingInputs.delete(id);
      d.queuedInputs.set(id, item);
      d.updateReceipt(item, "queued");
      await d.saveState();
      await d.updateMessage(item, `⏳ Сообщение поставлено в очередь задачи «${item.taskTitle}».`);
      d.scheduleQueued(item, 500);
      return { accepted: true, message: "Сообщение поставлено в очередь" };
    }
    if (!d.pendingInputs.has(id)) throw new Error("Сообщение уже находится в очереди");
    const binding = this.#binding(item);
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
      });
      if (outcome?.deferred) throw new Error("Условие безопасного запуска всё ещё не выполнено");
      const startedRun = d.runForTask(binding);
      if (startedRun && item.persistentFiles) startedRun.messageAttachments = d.describeAttachments(item.temporaryFiles);
      d.pendingInputs.delete(id);
      d.updateReceipt(item, "started", startedRun);
      await d.saveState();
      await d.updateMessage(item, `⚠️ Сообщение отправлено в задачу «${item.taskTitle}».`);
      d.scheduleNext(item);
      return { accepted: true, message: "Сообщение принудительно запущено" };
    }
    if (action === "new") {
      await d.selectTask(binding, d.clientContext(context, "desktop"));
      await d.dispatchCommand("task.create", { provider: binding.provider }, d.clientContext(context, "desktop"));
      const outcome = await d.startTurn(item.input, item.temporaryFiles ?? [], {
        forceSpeechButton: item.forceSpeechButton === true,
        persistentFiles: item.persistentFiles === true,
      });
      if (outcome?.deferred) throw new Error("Новая задача неожиданно оказалась занята");
      const startedRun = d.runForTask(d.selectedTask());
      if (startedRun && item.persistentFiles) startedRun.messageAttachments = d.describeAttachments(item.temporaryFiles);
      d.pendingInputs.delete(id);
      d.updateReceipt(item, "started", startedRun);
      await d.saveState();
      await d.updateMessage(item, `🆕 Сообщение отправлено в новую задачу «${d.activeTitle()}».`);
      d.scheduleNext(item);
      return { accepted: true, message: "Сообщение отправлено в новую задачу", snapshot: await d.snapshot() };
    }
    throw new Error("Неизвестное действие с сохранённым сообщением");
  }

  #binding(item) {
    return {
      provider: item.provider, projectRoot: item.projectRoot,
      threadId: item.threadId, taskTitle: item.taskTitle,
    };
  }
}

