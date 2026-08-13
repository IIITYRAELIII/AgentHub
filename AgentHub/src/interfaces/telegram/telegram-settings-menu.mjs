import { samePath } from "../../infrastructure/filesystem/config.mjs";

export class TelegramSettingsMenu {
  constructor({
    projects,
    codexModels,
    claudeModels,
    claudeModelLabels,
    reasoningEfforts,
    reasoningLabels,
    claudeReasoningEfforts,
    claudeReasoningLabels,
    collaborationModes,
    collaborationModeLabels,
    callbackData,
    sendMessage,
  }) {
    this.projects = projects;
    this.codexModels = codexModels;
    this.claudeModels = claudeModels;
    this.claudeModelLabels = claudeModelLabels;
    this.reasoningEfforts = reasoningEfforts;
    this.reasoningLabels = reasoningLabels;
    this.claudeReasoningEfforts = claudeReasoningEfforts ?? reasoningEfforts;
    this.claudeReasoningLabels = claudeReasoningLabels ?? reasoningLabels;
    this.collaborationModes = collaborationModes;
    this.collaborationModeLabels = collaborationModeLabels;
    this.callbackData = callbackData;
    this.sendMessage = sendMessage;
  }

  async projectsPicker({ activeProjectRoot }) {
    const project = this.projects.find((item) => samePath(item.path, activeProjectRoot))
      ?? this.projects[0];
    const keyboard = this.projects.map((item, index) => [{
      text: `${samePath(item.path, activeProjectRoot) ? "✓ " : ""}${item.name}`,
      callback_data: this.callbackData(`p:${index}`),
    }]);
    await this.sendMessage(
      `Активный проект: ${project.name}\n${activeProjectRoot}\n\nВыберите проект:`,
      { reply_markup: { inline_keyboard: keyboard } },
    );
  }

  async agentPicker({ provider }) {
    const keyboard = [
      [{ text: `${provider === "claude" ? "✓ " : ""}Claude Code`, callback_data: this.callbackData("engine:claude") }],
      [{ text: `${provider === "codex" ? "✓ " : ""}Codex`, callback_data: this.callbackData("engine:codex") }],
    ];
    await this.sendMessage(
      `Активный агент: ${provider === "codex" ? "Codex" : "Claude Code"}\n\nВыберите агента:`,
      { reply_markup: { inline_keyboard: keyboard } },
    );
  }

  async modelPicker({ provider, codexModel, claudeModel, codexModelLabel }) {
    if (provider === "codex") {
      const keyboard = this.codexModels.map((model) => [{
        text: `${model.value === codexModel ? "? " : ""}${model.label}`,
        callback_data: this.callbackData(`codex-model:${model.value}`),
      }]);
      await this.sendMessage(
        `Current Codex model: ${codexModelLabel}\n\nChoose model for next Codex turns:`,
        { reply_markup: { inline_keyboard: keyboard } },
      );
      return;
    }
    const keyboard = this.claudeModels.map((value) => [{
      text: `${value === claudeModel ? "✓ " : ""}${this.claudeModelLabels[value]}`,
      callback_data: this.callbackData(`model:${value}`),
    }]);
    await this.sendMessage(
      `Текущая модель Claude Code: ${this.claudeModelLabels[claudeModel]}\n\nВыберите модель:`,
      { reply_markup: { inline_keyboard: keyboard } },
    );
  }

  async reasoningPicker({ provider, value }) {
    const prefix = provider === "codex" ? "codex-reasoning" : "claude-reasoning";
    const efforts = provider === "codex" ? this.reasoningEfforts : this.claudeReasoningEfforts;
    const labels = provider === "codex" ? this.reasoningLabels : this.claudeReasoningLabels;
    const keyboard = efforts.map((item) => [{
      text: `${item === value ? "✓ " : ""}${labels[item]}`,
      callback_data: this.callbackData(`${prefix}:${item}`),
    }]);
    const hint = provider === "codex"
      ? "Выберите уровень для следующих запросов:"
      : "Выберите уровень effort, который Claude Code передаст модели:";
    await this.sendMessage(
      `Reasoning ${provider === "codex" ? "Codex" : "Claude Code"}: ${labels[value]}\n\n${hint}`,
      { reply_markup: { inline_keyboard: keyboard } },
    );
  }

  async collaborationModePicker({ provider, value }) {
    const prefix = provider === "codex" ? "codex-mode" : "claude-mode";
    const keyboard = [this.collaborationModes.map((item) => ({
      text: `${item === value ? "✓ " : ""}${this.collaborationModeLabels[item]}`,
      callback_data: this.callbackData(`${prefix}:${item}`),
    }))];
    const hint = provider === "codex"
      ? "Выберите режим для следующих запросов:"
      : "Выберите режим (Plan — Claude только планирует, ничего не меняя):";
    await this.sendMessage(
      `Режим ${provider === "codex" ? "Codex" : "Claude Code"}: ${this.collaborationModeLabels[value]}\n\n${hint}`,
      { reply_markup: { inline_keyboard: keyboard } },
    );
  }
}
