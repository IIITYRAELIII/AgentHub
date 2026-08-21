// Handles task navigation and task-scoped callback routes.
import { taskDisplayTitle } from "../../domain/task-display-title.mjs";

const ROUTE_KINDS = new Set([
  "task-diff", "task-history", "task-view", "task-page",
  "catalog-task", "thread-new", "thread-archive",
]);

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class TelegramTaskCallbackService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "telegram", "resolveTaskViewBinding", "runForTask", "refreshTaskDiff",
      "storedTaskDiff", "taskRunKey", "sendLongMessage", "selectTaskFromBinding",
      "callbackContext", "showLastTaskMessage", "showTaskMessage", "sendMessageTo",
      "sendTaskSwitchNotification", "sendTaskAlreadySelectedNotification",
      "scheduleInteractiveJob", "sendThreadPicker",
      "taskCatalog", "refreshTaskCatalog", "createCurrentTask",
      "sendMessage", "providerTitle", "archiveBlockedReason", "archiveCurrentThread",
      "sendArchiveMessage", "dismissCallbackMenu",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async handle(callback, route) {
    if (!ROUTE_KINDS.has(route?.kind)) return false;
    const d = this.#d;
    const taskViewAction = route.taskView;
    const historyMatch = route.legacyHistory;
    if (route.kind === "task-diff") {
      const targetChatId = callback.message?.chat?.id;
      const binding = await d.resolveTaskViewBinding(taskViewAction, targetChatId, callback.message?.message_id);
      if (!binding) return this.#stale(callback, "Изменения этого потока уже недоступны");
      await this.#answer(callback, "Загружаю изменения…");
      d.scheduleInteractiveJob("Изменения", targetChatId, async () => {
        const run = d.runForTask(binding);
        const diff = run ? await d.refreshTaskDiff(run) : d.storedTaskDiff(d.taskRunKey(binding)) ?? "";
        await d.sendLongMessage(diff || "В этом потоке изменений файлов нет.", { maxParts: 8, targetChatId });
      });
      return true;
    }
    if (route.kind === "task-history") {
      const targetChatId = callback.message?.chat?.id;
      const binding = await d.resolveTaskViewBinding(taskViewAction, targetChatId, callback.message?.message_id);
      if (!binding) return this.#stale(callback, "История этого потока уже недоступна");
      await this.#answer(callback, "Загружаю предыдущие сообщения…");
      const completedOnly = taskViewAction ? taskViewAction.action === "history-last" : historyMatch.scope === "l";
      const count = taskViewAction?.count ?? Math.max(1, Math.min(Number(historyMatch.count) || 1, 50));
      try {
        await d.selectTaskFromBinding(binding, d.callbackContext(callback));
        if (completedOnly) await d.showLastTaskMessage(binding, targetChatId, { count });
        else await d.showTaskMessage(binding, targetChatId, { count });
      } catch (error) {
        d.logError?.("Cannot load task history:", error.message);
        await d.sendMessageTo(targetChatId, `Не удалось загрузить историю потока: ${error.message}`);
      }
      return true;
    }
    if (route.kind === "task-view") {
      const targetChatId = callback.message?.chat?.id;
      const binding = await d.resolveTaskViewBinding(taskViewAction, targetChatId, callback.message?.message_id);
      if (!binding) return this.#stale(callback, "Привязка потока уже недоступна");
      await this.#answer(callback, "Открываю поток…");
      try {
        const selected = await d.selectTaskFromBinding(binding, d.callbackContext(callback));
        if (selected.selectionChanged) {
          await d.sendTaskSwitchNotification({ targetChatId, showLastMessage: false });
        }
        await d.showTaskMessage(binding, targetChatId);
      } catch (error) {
        d.logError?.("Cannot show bound task message:", error.message);
        await d.sendMessageTo(targetChatId, `Не удалось показать сообщение потока: ${error.message}`);
      }
      return true;
    }
    if (route.kind === "task-page") {
      await this.#answer(callback);
      d.scheduleInteractiveJob("Страница списка потоков", callback.message.chat.id, () => d.sendThreadPicker({
        editMessage: callback.message,
        page: route.page,
      }));
      return true;
    }
    if (route.kind === "catalog-task") {
      const selected = route.catalogTask;
      let entry = d.taskCatalog().find((item) => item.provider === selected.provider && item.threadId === selected.threadId);
      if (!entry) {
        entry = (await d.refreshTaskCatalog()).find((item) => item.provider === selected.provider && item.threadId === selected.threadId);
      }
      if (!entry) return this.#stale(callback, "Поток больше не найден");
      try {
        await this.#selectCatalogTask(callback, entry);
      } catch (error) {
        await d.sendMessageTo(callback.message.chat.id, `Ошибка выбора потока: ${error.message}`);
      }
      return true;
    }
    if (route.kind === "thread-new") {
      try {
        await d.createCurrentTask(d.callbackContext(callback));
        await this.#answer(callback, "Новый поток создан");
        await this.#closeMenu(callback);
        await d.sendMessage(`Создан новый поток ${d.providerTitle()} в текущем проекте.`);
      } catch (error) {
        await this.#stale(callback, "Не удалось создать поток");
        d.logError?.("Cannot create thread:", error.message);
      }
      return true;
    }
    const blockedReason = d.archiveBlockedReason();
    if (blockedReason) {
      const messages = {
        "active-turn": "Сначала завершите или отмените текущий поток",
        unsupported: "Архивация доступна только для потоков Codex",
        "no-current": "Текущий поток не выбран",
      };
      await this.#stale(callback, messages[blockedReason] ?? "Архивация недоступна");
      return true;
    }
    await this.#answer(callback, "Архивирую поток…");
    try {
      const result = await d.archiveCurrentThread(d.callbackContext(callback));
      if (!result.archived) {
        await d.sendMessageTo(callback.message.chat.id, "Архивация потока стала недоступна. Обновите список потоков.");
        return true;
      }
      const outcomes = await Promise.allSettled([
        d.sendArchiveMessage(result, callback.message.chat.id),
        d.sendThreadPicker({ editMessage: callback.message }),
      ]);
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      if (failures.length) {
        throw new AggregateError(failures.map((failure) => failure.reason), "Не удалось полностью обновить меню архивации");
      }
    } catch (error) {
      d.logError?.("Cannot archive thread:", error.message);
      await d.sendMessageTo(callback.message.chat.id, `Ошибка архивации потока: ${error.message}`);
    }
    return true;
  }

  async #selectCatalogTask(callback, entry) {
    const d = this.#d;
    const targetChatId = callback.message.chat.id;
    await this.#answer(callback, "Переключаю поток…");
    const selected = await d.selectTaskFromBinding({
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
      taskTitle: taskDisplayTitle(entry),
    }, d.callbackContext(callback));
    await Promise.all([
      selected.selectionChanged
        ? d.sendTaskSwitchNotification({ targetChatId })
        : d.sendTaskAlreadySelectedNotification({ targetChatId }),
      d.dismissCallbackMenu(callback.message),
    ]);
  }

  #answer(callback, text) {
    return this.#d.telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      ...(text ? { text } : {}),
    });
  }

  #stale(callback, text) {
    return this.#d.telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text,
      show_alert: true,
    });
  }

  #closeMenu(callback) {
    return this.#d.telegram("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }
}
