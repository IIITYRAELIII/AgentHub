// Applies Desktop/Mini App settings through injected application operations.
function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class DesktopSettingsService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "isSelected", "selectedTask", "switchProvider", "isCodex", "threadId", "isCompacting",
      "switchCodexModel", "switchClaudeModel", "updateCodexThreadSettings", "saveState",
      "getCodexReasoning", "setCodexReasoning", "getClaudeReasoning", "setClaudeReasoning",
      "getCodexMode", "setCodexMode", "getClaudeMode", "setClaudeMode", "getAutoApprove",
      "setAutoApprove", "getIncludeClaudeUsage", "setIncludeClaudeUsage", "projectUsage",
      "findProjectIndex", "switchProject", "snapshot",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async update(params) {
    const d = this.#d;
    const name = String(params.name ?? "").trim();
    const value = String(params.value ?? "").trim();
    if (["provider", "project", "model", "reasoning", "mode"].includes(name)
      && !d.isSelected(params, d.selectedTask())) {
      throw new Error("Настройка относится уже не к выбранной задаче; обновите карточку");
    }
    let changed = false;
    if (name === "provider") {
      ({ changed } = await d.switchProvider(value));
    } else if (name === "model") {
      if (d.isCodex()) {
        this.#assertNotCompacting("модели");
        ({ changed } = d.switchCodexModel(value));
        await d.updateCodexThreadSettings();
      } else {
        ({ changed } = d.switchClaudeModel(value));
        await d.saveState();
      }
    } else if (name === "reasoning") {
      if (!d.reasoningEfforts.includes(value)) throw new Error("Неизвестный уровень reasoning");
      if (d.isCodex()) {
        this.#assertNotCompacting("Reasoning");
        changed = d.getCodexReasoning() !== value;
        d.setCodexReasoning(value);
        await d.updateCodexThreadSettings();
      } else {
        changed = d.getClaudeReasoning() !== value;
        d.setClaudeReasoning(value);
        await d.saveState();
      }
    } else if (name === "mode") {
      if (!d.collaborationModes.includes(value)) throw new Error("Неизвестный режим работы");
      if (d.isCodex()) {
        changed = d.getCodexMode() !== value;
        d.setCodexMode(value);
      } else {
        changed = d.getClaudeMode() !== value;
        d.setClaudeMode(value);
      }
      await d.saveState();
    } else if (name === "approvalMode") {
      if (!['auto', 'manual'].includes(value)) throw new Error("Неизвестный режим подтверждений");
      changed = d.getAutoApprove() !== (value === "auto");
      d.setAutoApprove(value === "auto");
    } else if (name === "includeClaudeUsage") {
      if (!['true', 'false'].includes(value)) throw new Error("Неизвестный режим учёта Claude");
      changed = d.getIncludeClaudeUsage() !== (value === "true");
      d.setIncludeClaudeUsage(value === "true");
      await d.projectUsage();
      await d.saveState();
    } else if (name === "project") {
      const index = d.findProjectIndex(value);
      if (index < 0) throw new Error("Проект не найден");
      ({ changed } = await d.switchProject(index));
    } else {
      throw new Error("Неизвестная настройка Desktop-приложения");
    }
    return { ...await d.snapshot({ refresh: true }), setting: { name, value, changed } };
  }

  #assertNotCompacting(label) {
    const threadId = this.#d.threadId();
    if (threadId && this.#d.isCompacting(threadId)) {
      throw new Error(`Дождитесь завершения свёртки контекста перед сменой ${label}`);
    }
  }
}
