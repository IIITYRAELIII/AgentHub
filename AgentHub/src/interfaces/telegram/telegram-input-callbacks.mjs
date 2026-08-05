// Handles deferred input, forwarded bundles and speech callback routes.
const ROUTE_KINDS = new Set(["forward-bundle", "pending-input", "speech"]);

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class TelegramInputCallbackService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "telegram", "sendMessageTo", "updateDeferredDesktopReceipt", "cleanupDeferredFiles",
      "saveState", "updateDeferredMessage", "scheduleNextForTask", "selectTaskFromBinding",
      "callbackContext", "showTaskMessage", "scheduleQueuedInput", "startTurn", "runForTask",
      "describeAttachments", "dispatchApplicationCommand", "activeThreadTitle", "selectedTask",
      "speechText", "sendTaskSwitchNotification",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async handle(callback, route) {
    if (!ROUTE_KINDS.has(route?.kind)) return false;
    if (route.kind === "forward-bundle") return this.#forwardBundle(callback, route);
    if (route.kind === "pending-input") return this.#pendingInput(callback, route);
    return this.#speech(callback, route);
  }

  async #forwardBundle(callback, route) {
    const d = this.#d;
    if (!d.forwardBundleController.bundleById(route.id)) {
      await this.#answer(callback, "Эта пачка уже обработана", true);
      return true;
    }
    await this.#answer(
      callback,
      route.action === "send"
        ? "Отправляю пачку…"
        : route.action === "undo" ? "Убираю последнее сообщение…" : "Отменяю сбор…",
    );
    try {
      const result = route.action === "send"
        ? await d.forwardBundleController.submit(route.id)
        : route.action === "undo"
          ? await d.forwardBundleController.undo(route.id)
          : await d.forwardBundleController.cancel(route.id);
      if (result.status === "missing") return true;
    } catch (error) {
      d.logError?.(`Cannot process forward bundle ${route.id}:`, error.message);
      await d.sendMessageTo(callback.message.chat.id, `Не удалось обработать пачку сообщений: ${error.message}`);
    }
    return true;
  }

  async #pendingInput(callback, route) {
    const d = this.#d;
    const { action, id } = route;
    const item = d.pendingInputs.get(id);
    if (!item) {
      await this.#answer(callback, "Сохранённое сообщение уже обработано", true);
      return true;
    }
    const binding = {
      hubTaskId: item.hubTaskId ?? null,
      provider: item.provider,
      projectRoot: item.projectRoot,
      threadId: item.threadId,
      taskTitle: item.taskTitle,
    };
    await this.#answer(
      callback,
      action === "new" ? "Создаю новую задачу…"
        : action === "queue" ? "Ставлю сообщение в очередь…"
          : action === "force" ? "Запускаю после явного подтверждения…"
            : action === "show" ? "Показываю текущий ход…" : "Сообщение отменено",
    );
    try {
      if (action === "cancel") {
        d.pendingInputs.delete(id);
        d.updateDeferredDesktopReceipt(item, "cancelled");
        await d.cleanupDeferredFiles(item);
        await d.saveState();
        await d.updateDeferredMessage(item, "❌ Сохранённое сообщение отменено.");
        d.scheduleNextForTask(item);
        return true;
      }
      if (action === "show") {
        const selected = await d.selectTaskFromBinding(binding, d.callbackContext(callback));
        if (selected.selectionChanged) {
          await d.sendTaskSwitchNotification({ targetChatId: item.chatId, showLastMessage: false });
        }
        await d.showTaskMessage(binding, item.chatId);
        return true;
      }
      if (action === "queue") {
        d.pendingInputs.delete(id);
        d.queuedInputs.set(id, item);
        d.updateDeferredDesktopReceipt(item, "queued");
        await d.saveState();
        await d.updateDeferredMessage(
          item,
          `⏳ Сообщение поставлено в очередь задачи «${item.taskTitle}» и будет отправлено после завершения текущего хода.`,
        );
        d.scheduleQueuedInput(item, 500);
        return true;
      }
      if (action === "force") {
        if (item.allowForce !== true) throw new Error("принудительный запуск для этого сообщения не разрешён");
        await d.selectTaskFromBinding(binding, d.callbackContext(callback));
        const outcome = await d.startTurn(item.input, item.temporaryFiles ?? [], {
          forceSpeechButton: item.forceSpeechButton === true,
          target: {
            ...binding,
            chatId: item.chatId,
            modelId: item.modelId,
            reasoningId: item.reasoningId,
            collaborationMode: item.collaborationMode,
            clientUserMessageId: item.clientUserMessageId,
          },
          allowRepositoryConflict: item.conflictKind === "repository",
          allowUnknownExternalActivity: item.conflictKind === "activity-unknown",
          persistentFiles: item.persistentFiles === true,
        });
        if (outcome?.deferred) throw new Error("условие безопасного запуска всё ещё не выполнено");
        const startedRun = d.runForTask(binding);
        if (startedRun && item.persistentFiles) {
          startedRun.messageAttachments = d.describeAttachments(item.temporaryFiles);
        }
        d.pendingInputs.delete(id);
        d.updateDeferredDesktopReceipt(item, "started", startedRun);
        await d.saveState();
        await d.updateDeferredMessage(item, `⚠️ Сообщение отправлено в задачу «${item.taskTitle}» после явного подтверждения.`);
        d.scheduleNextForTask(item);
        return true;
      }
      await d.selectTaskFromBinding(binding, d.callbackContext(callback));
      await d.dispatchApplicationCommand("task.create", { provider: binding.provider }, d.callbackContext(callback));
      const newTaskTitle = d.activeThreadTitle();
      const outcome = await d.startTurn(item.input, item.temporaryFiles ?? [], {
        forceSpeechButton: item.forceSpeechButton === true,
        persistentFiles: item.persistentFiles === true,
      });
      if (outcome?.deferred) throw new Error("новая задача неожиданно оказалась занята");
      const startedRun = d.runForTask(d.selectedTask());
      if (startedRun && item.persistentFiles) {
        startedRun.messageAttachments = d.describeAttachments(item.temporaryFiles);
      }
      d.pendingInputs.delete(id);
      d.updateDeferredDesktopReceipt(item, "started", startedRun);
      await d.saveState();
      await d.updateDeferredMessage(item, `🆕 Сообщение отправлено в новую задачу «${newTaskTitle}».`);
      d.scheduleNextForTask(item);
      await d.sendTaskSwitchNotification({ targetChatId: item.chatId });
    } catch (error) {
      d.logError?.(`Cannot process pending input ${id}:`, error.message);
      await d.sendMessageTo(item.chatId, `Не удалось обработать сохранённое сообщение: ${error.message}`);
    }
    return true;
  }

  async #speech(callback, route) {
    const d = this.#d;
    const text = d.speechText(route.id);
    if (!text) {
      await this.#answer(callback, "Текст ответа уже недоступен", true);
      return true;
    }
    const speechJob = await d.backgroundJobs.enqueue("speech", {
      chatId: callback.message.chat.id,
      text,
    }, callback.message.chat.id, { dedupeKey: `callback:${callback.id}:speech` });
    if (!speechJob) {
      await this.#answer(callback, `Очередь озвучивания заполнена (${d.maxSpeechJobs})`, true);
      return true;
    }
    await this.#answer(
      callback,
      d.backgroundJobs.speechPending
        ? `Озвучивание поставлено в очередь: ${d.backgroundJobs.speechPending}`
        : "Готовлю голосовое сообщение…",
    );
    return true;
  }

  #answer(callback, text, showAlert = false) {
    return this.#d.telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text,
      ...(showAlert ? { show_alert: true } : {}),
    });
  }
}
