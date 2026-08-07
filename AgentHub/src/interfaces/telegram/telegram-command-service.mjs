// Dispatches Telegram slash/menu commands into injected application operations.
const COMMANDS = Object.freeze([
  "menu", "keyboard", "start", "help", "agent", "engine", "model", "reasoning", "mode",
  "projects", "folders", "folder", "new", "status", "approvals", "restart", "tasks", "resume",
  "rename", "archive", "current", "thread", "diff", "cancel",
]);

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class TelegramCommandService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "sendMessage", "providerTitle", "sendAgentPicker", "sendModelPicker",
      "sendReasoningPicker", "sendModePicker", "sendProjectPicker", "dispatchCommand", "createCurrentTask",
      "messageContext", "activeProvider", "statusSnapshot", "scheduleInteractiveJob",
      "sendStatus", "approvalModeText", "approvalModeKeyboard", "restart", "sendTaskPicker",
      "resumeThread", "renameCurrentTask", "archiveCurrentTask", "sendArchiveMessage",
      "selectedTask", "runForTask", "refreshTaskDiff", "storedTaskDiff", "taskKey",
      "sendLongMessage", "sendRunMessage", "bindIncomingMessage", "startTurn", "prompt",
      "commandTaskTarget", "selectedTurnTarget",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  handlers() {
    return Object.fromEntries(COMMANDS.map((command) => [
      command,
      ({ message, text }) => this.handle(message, text),
    ]));
  }

  async handle(message, text) {
    const d = this.#d;
    if (text === "/menu" || text === "/keyboard") {
      await d.sendMessage("⌨️ Панель кнопок показана.", { reply_markup: d.menu });
    } else if (text === "/start" || text === "/help") {
      await d.sendMessage(
        `Бот подключён к Claude Code и Codex. Текущий агент: ${d.providerTitle()}. Отправьте текст, изображение или голосовое сообщение.\n\n`
          + "/menu — показать панель кнопок\n/agent — переключить Claude Code/Codex\n/model — сменить модель\n/reasoning — мощь дум Codex/Claude\n/mode — режим Plan/Work Codex/Claude\n/projects — сменить активный проект\n/new — новый контекст\n/tasks — список задач и создание новой\n/resume — выбрать задачу\n/rename — закрепить название текущей задачи\n/archive — архивировать текущую задачу\n/status — статус, текущая задача и лимиты\n/approvals — режим подтверждений\n/restart — перезапустить бота\n/diff — последний diff\n/cancel — остановить задачу",
        { reply_markup: d.menu },
      );
    } else if (text === "/agent" || text === "/engine") {
      await d.sendAgentPicker();
    } else if (text === "/model") {
      await d.sendModelPicker();
    } else if (text === "/reasoning") {
      await d.sendReasoningPicker();
    } else if (text === "/mode") {
      await d.sendModePicker();
    } else if (text === "/projects" || text === "/folders" || text === "/folder") {
      await d.sendProjectPicker();
    } else if (text === "/new") {
      await d.createCurrentTask(d.messageContext(message));
      await d.sendMessage(`Создан новый контекст ${d.providerTitle()}.`);
    } else if (text === "/status") {
      const snapshot = d.statusSnapshot(message.chat.id);
      d.scheduleInteractiveJob("Статус", message.chat.id, () => d.sendStatus(snapshot));
    } else if (text === "/approvals") {
      await d.sendMessage(d.approvalModeText(), { reply_markup: d.approvalModeKeyboard() });
    } else if (text === "/restart") {
      await d.restart();
    } else if (text === "/tasks" || text === "/resume") {
      d.scheduleInteractiveJob("Список задач", message.chat.id, () => d.sendTaskPicker());
    } else if (text.startsWith("/resume ")) {
      const selectedThreadId = text.slice("/resume ".length).trim();
      if (!/^[0-9a-f-]+$/i.test(selectedThreadId)) {
        return d.sendMessage("Укажите корректный ID задачи или используйте /resume без параметров.");
      }
      await d.resumeThread(selectedThreadId, { context: d.messageContext(message) });
    } else if (text === "/rename") {
      await d.sendMessage("Укажите новое постоянное название: /rename Название задачи");
    } else if (text.startsWith("/rename ")) {
      try {
        const title = await d.renameCurrentTask(text.slice("/rename ".length), d.messageContext(message));
        await d.sendMessage(`✅ Название закреплено: «${title}». Автозаголовки Codex больше его не изменят.`);
      } catch (error) {
        await d.sendMessage(`Не удалось переименовать задачу: ${error.message}`);
      }
    } else if (text === "/archive") {
      const result = await d.archiveCurrentTask(d.messageContext(message));
      if (!result.archived) {
        if (result.reason === "active-turn") return d.sendMessage("Сначала завершите или отмените текущую задачу.");
        if (result.reason === "unsupported") return d.sendMessage("Архивация доступна только для задач Codex.");
        return d.sendMessage("Текущая задача не выбрана.");
      }
      await d.sendArchiveMessage(result);
      await d.sendTaskPicker();
    } else if (text === "/current" || text === "/thread") {
      const snapshot = d.statusSnapshot(message.chat.id);
      d.scheduleInteractiveJob("Текущая задача", message.chat.id, () => d.sendStatus(snapshot));
    } else if (text === "/diff") {
      const target = d.selectedTask();
      const run = d.runForTask(target);
      d.scheduleInteractiveJob("Изменения", message.chat.id, async () => {
        const diff = run ? await d.refreshTaskDiff(run) : d.storedTaskDiff(d.taskKey(target));
        await d.sendLongMessage(diff || "В выбранной задаче изменений файлов нет.", { maxParts: 8 });
      });
    } else if (text === "/cancel") {
      const target = d.selectedTask();
      if (!target.threadId) return d.sendMessage("В выбранной задаче сейчас ничего не выполняется.");
      const run = d.runForTask(target);
      const result = await d.dispatchCommand(
        "run.cancel",
        {},
        d.messageContext(message),
        { target: d.commandTaskTarget(target) },
      );
      if (run) await d.sendRunMessage(run, result.message);
      else await d.sendMessage(result.message);
    } else if (text.startsWith("/")) {
      await d.sendMessage("Неизвестная команда. Используйте /help.");
    } else {
      const target = d.selectedTurnTarget(message.chat.id);
      await d.bindIncomingMessage(message, text, target);
      await d.startTurn(d.prompt(message, text), [], { target });
    }
  }
}
