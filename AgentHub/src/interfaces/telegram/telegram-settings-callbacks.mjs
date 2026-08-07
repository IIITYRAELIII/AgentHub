// Handles settings-only callback routes after transport-level parsing.
const ROUTE_KINDS = new Set([
  "approval-mode",
  "project",
  "engine",
  "codex-model",
  "codex-reasoning",
  "codex-mode",
  "claude-reasoning",
  "claude-mode",
  "claude-model",
]);

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class TelegramSettingsCallbackService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "telegram", "dispatchSetting", "sendMessage", "formatApprovalMode",
      "approvalModeKeyboard", "providerTitle", "activeProject", "activeProvider",
      "clearTaskSelection", "callbackContext",
      "autoApprove", "codexModel", "codexModelLabel", "codexReasoningEffort",
      "codexCollaborationMode", "claudeModel", "claudeReasoningEffort",
      "claudeCollaborationMode",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async handle(callback, route) {
    if (!ROUTE_KINDS.has(route?.kind)) return false;
    const d = this.#d;
    if (route.kind === "approval-mode") {
      await d.dispatchSetting(callback, "approvalMode", route.mode);
      await d.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: d.autoApprove() ? "Автоподтверждение включено" : "Ручной режим включён",
      });
      await d.telegram("editMessageText", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        text: d.formatApprovalMode(),
        reply_markup: d.approvalModeKeyboard(),
      });
      return true;
    }
    if (route.kind === "project") {
      try {
        const project = d.projects[route.index];
        if (!project) throw new Error("unknown project");
        const result = await d.dispatchSetting(callback, "project", project.path);
        if (result.setting.changed) await d.clearTaskSelection(d.callbackContext(callback));
        await d.telegram("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: result.setting.changed ? "Папка изменена" : "Эта папка уже активна",
        });
        await this.#closeMenu(callback);
        if (result.setting.changed) {
          await d.sendMessage(`Активная папка: ${project.name}\n${project.path}\nСоздан новый контекст ${d.providerTitle()}.`);
        }
      } catch (error) {
        await d.telegram("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "Не удалось сменить проект",
          show_alert: true,
        });
        await d.sendMessage(`Ошибка смены папки: ${error.message}`);
      }
      return true;
    }
    if (route.kind === "engine") {
      try {
        const result = await d.dispatchSetting(callback, "provider", route.provider);
        if (result.setting.changed) await d.clearTaskSelection(d.callbackContext(callback));
        await d.telegram("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: result.setting.changed ? "Агент переключён" : "Этот агент уже активен",
        });
        await this.#closeMenu(callback);
        if (result.setting.changed) {
          await d.sendMessage(`Активный агент: ${d.providerTitle()}\nПроект: ${d.activeProject().name}`);
        }
      } catch (error) {
        await d.telegram("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "Не удалось переключить агента",
          show_alert: true,
        });
        await d.sendMessage(`Ошибка переключения агента: ${error.message}`);
      }
      return true;
    }
    if (route.kind === "codex-model") {
      await this.#model(callback, route.model, {
        provider: "Codex",
        success: "Codex model changed",
        unchanged: "This Codex model is already selected",
        failed: "Cannot change Codex model",
        message: () => `Codex model: ${d.codexModelLabel(d.codexModel())}`,
      });
      return true;
    }
    if (route.kind === "claude-model") {
      await this.#model(callback, route.model, {
        provider: "Claude Code",
        success: "Модель изменена",
        unchanged: "Эта модель уже выбрана",
        failed: "Не удалось сменить модель",
        message: () => `Модель Claude Code: ${d.claudeModelLabels[d.claudeModel()]}`,
      });
      return true;
    }
    const isReasoning = route.kind.endsWith("-reasoning");
    const provider = route.kind.startsWith("codex-") ? "Codex" : "Claude Code";
    const setting = isReasoning ? "reasoning" : "mode";
    try {
      const result = await d.dispatchSetting(callback, setting, route.value);
      await d.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: result.setting.changed
          ? isReasoning ? "Reasoning изменён" : `Режим ${provider === "Codex" ? "Codex" : "Claude"} изменён`
          : isReasoning ? "Этот уровень уже выбран" : "Этот режим уже выбран",
      });
      await this.#closeMenu(callback);
      if (result.setting.changed) {
        const value = isReasoning
          ? d.reasoningLabels[provider === "Codex" ? d.codexReasoningEffort() : d.claudeReasoningEffort()]
          : d.collaborationModeLabels[provider === "Codex" ? d.codexCollaborationMode() : d.claudeCollaborationMode()];
        await d.sendMessage(`${isReasoning ? "Reasoning" : "Режим"} ${provider}: ${value}`);
      }
    } catch (error) {
      await d.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: isReasoning ? "Не удалось изменить Reasoning" : "Не удалось изменить режим",
        show_alert: true,
      });
      await d.sendMessage(`Ошибка смены ${isReasoning ? "Reasoning" : "режима"} ${provider}: ${error.message}`);
    }
    return true;
  }

  async #model(callback, model, labels) {
    const d = this.#d;
    try {
      const result = await d.dispatchSetting(callback, "model", model);
      await d.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: result.setting.changed ? labels.success : labels.unchanged,
      });
      await this.#closeMenu(callback);
      if (result.setting.changed) await d.sendMessage(labels.message());
    } catch (error) {
      await d.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: labels.failed,
        show_alert: true,
      });
      await d.sendMessage(`Ошибка смены модели ${labels.provider}: ${error.message}`);
    }
  }

  #closeMenu(callback) {
    return this.#d.telegram("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }
}
