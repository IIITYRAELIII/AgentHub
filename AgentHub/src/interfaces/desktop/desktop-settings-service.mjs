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
      "switchCodexModel", "switchClaudeModel", "updateCodexThreadSettings", "createCodexThread", "saveState",
      "getCodexReasoning", "setCodexReasoning", "getClaudeReasoning", "setClaudeReasoning",
      "getCodexMode", "setCodexMode", "getClaudeMode", "setClaudeMode", "getAutoApprove",
      "setAutoApprove", "getIncludeClaudeUsage", "setIncludeClaudeUsage", "projectUsage",
      "getActivityRecentMinutes", "setActivityRecentMinutes",
      "getStreamOrderMode", "setStreamOrderMode", "getStreamCardWidthMode", "setStreamCardWidthMode",
      "getStreamCardFixedWidth", "setStreamCardFixedWidth", "getStreamCardGapEnabled", "setStreamCardGapEnabled",
      "getPinnedWorkspaceStreams", "setPinnedWorkspaceStreams",
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
      throw new Error("Настройка относится уже не к выбранному потоку; обновите карточку");
    }
    let changed = false;
    if (name === "provider") {
      ({ changed } = await d.switchProvider(value));
    } else if (name === "model") {
      if (d.isCodex()) {
        this.#assertNotCompacting("модели");
        ({ changed } = d.switchCodexModel(value));
        try {
          await d.updateCodexThreadSettings();
        } catch (error) {
          if (error?.data?.kind !== "threadBackendChangeRequiresNewThread") throw error;
          await d.createCodexThread();
        }
      } else {
        ({ changed } = d.switchClaudeModel(value));
        await d.saveState();
      }
    } else if (name === "reasoning") {
      const efforts = d.isCodex()
        ? d.reasoningEfforts
        : d.claudeReasoningEfforts ?? d.reasoningEfforts;
      if (!efforts.includes(value)) throw new Error("Неизвестный уровень reasoning");
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
      const enabled = value === "true";
      changed = d.getIncludeClaudeUsage() !== enabled;
      if (changed) {
        await d.projectUsage(enabled);
        d.setIncludeClaudeUsage(enabled);
        await d.saveState();
      }
    } else if (name === "activityRecentMinutes") {
      const minutes = Number(value);
      if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 30 * 24 * 60) {
        throw new Error("Неизвестный период отображения активных задач");
      }
      changed = d.getActivityRecentMinutes() !== minutes;
      d.setActivityRecentMinutes(minutes);
      await d.saveState();
    } else if (name === "streamOrderMode") {
      if (!["activity", "manual"].includes(value)) throw new Error("Неизвестный порядок потоков");
      changed = d.getStreamOrderMode() !== value;
      d.setStreamOrderMode(value);
      await d.saveState();
    } else if (name === "streamCardWidthMode") {
      if (!["auto", "fixed"].includes(value)) throw new Error("Неизвестный режим ширины потоков");
      changed = d.getStreamCardWidthMode() !== value;
      d.setStreamCardWidthMode(value);
      await d.saveState();
    } else if (name === "streamCardFixedWidth") {
      const width = Number(value);
      if (!Number.isSafeInteger(width) || width < 90 || width > 450) {
        throw new Error("Неизвестная ширина карточек потоков");
      }
      changed = d.getStreamCardFixedWidth() !== width;
      d.setStreamCardFixedWidth(width);
      await d.saveState();
    } else if (name === "streamCardGapEnabled") {
      if (!["true", "false"].includes(value)) throw new Error("Неизвестный режим отступа потоков");
      const enabled = value === "true";
      changed = d.getStreamCardGapEnabled() !== enabled;
      d.setStreamCardGapEnabled(enabled);
      await d.saveState();
    } else if (name === "pinnedWorkspaceStreams") {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error("Неизвестный набор закреплённых потоков");
      }
      const previous = JSON.stringify(d.getPinnedWorkspaceStreams());
      d.setPinnedWorkspaceStreams(parsed);
      changed = previous !== JSON.stringify(d.getPinnedWorkspaceStreams());
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
