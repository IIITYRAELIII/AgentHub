import {
  formatClaudeRateLimits,
  formatCodexRateLimits,
  formatStatusMessage,
} from "../../../status.mjs";
import {
  catalogEntryIsSelected,
  mergeTaskCatalog,
  runningTaskReplyMarkup,
} from "../../../task-catalog.mjs";

export class TelegramStatusController {
  #limitsCache = new Map();
  #limitsInFlight = new Map();

  constructor({
    config,
    projects,
    findProject,
    refreshTaskCatalog,
    currentTaskCatalog,
    currentTaskRuns,
    readCodexRateLimits,
    readClaudeRateLimits,
    codexModelLabel,
    claudeModelLabels,
    reasoningLabels,
    collaborationModeLabels,
    sendStatusCard,
    limitsCacheMs = 60_000,
    logger = console,
  }) {
    this.config = config;
    this.projects = projects;
    this.findProject = findProject;
    this.refreshTaskCatalog = refreshTaskCatalog;
    this.currentTaskCatalog = currentTaskCatalog;
    this.currentTaskRuns = currentTaskRuns;
    this.readCodexRateLimits = readCodexRateLimits;
    this.readClaudeRateLimits = readClaudeRateLimits;
    this.codexModelLabel = codexModelLabel;
    this.claudeModelLabels = claudeModelLabels;
    this.reasoningLabels = reasoningLabels;
    this.collaborationModeLabels = collaborationModeLabels;
    this.sendStatusCard = sendStatusCard;
    this.limitsCacheMs = limitsCacheMs;
    this.logger = logger;
  }

  async #limits(provider) {
    const cached = this.#limitsCache.get(provider);
    if (cached && Date.now() - cached.at < this.limitsCacheMs) return cached.value;
    if (this.#limitsInFlight.has(provider)) return this.#limitsInFlight.get(provider);
    const request = (async () => {
      const value = provider === "codex"
        ? formatCodexRateLimits(await this.readCodexRateLimits())
        : formatClaudeRateLimits(await this.readClaudeRateLimits());
      this.#limitsCache.set(provider, { at: Date.now(), value });
      return value;
    })();
    this.#limitsInFlight.set(provider, request);
    try {
      return await request;
    } finally {
      this.#limitsInFlight.delete(provider);
    }
  }

  async send(snapshot) {
    const project = this.findProject(snapshot.projectRoot) ?? this.projects[0];
    const selected = {
      provider: snapshot.provider,
      projectRoot: snapshot.projectRoot,
      threadId: snapshot.threadId,
    };
    const codexSelected = snapshot.provider === "codex";
    const [catalogResult, limitsResult] = await Promise.allSettled([
      this.refreshTaskCatalog(),
      this.#limits(snapshot.provider),
    ]);
    let catalog = this.currentTaskCatalog();
    if (catalogResult.status === "fulfilled") {
      catalog = catalogResult.value;
    } else {
      this.logger.error(
        "Cannot refresh task catalog for status:",
        catalogResult.reason?.message ?? catalogResult.reason,
      );
      catalog = mergeTaskCatalog(catalog, this.currentTaskRuns());
    }
    let task = "Не выбрана";
    if (snapshot.threadId) {
      const current = catalog.find((entry) => catalogEntryIsSelected(entry, selected));
      task = current?.title || snapshot.taskTitle
        || `${codexSelected ? "Codex" : "Claude"} · ${snapshot.threadId.slice(0, 8)}`;
    }

    let limits;
    if (limitsResult.status === "fulfilled") {
      limits = limitsResult.value;
    } else {
      const error = limitsResult.reason;
      this.logger.error(
        `Cannot read ${codexSelected ? "Codex" : "Claude"} limits for status:`,
        error?.message ?? error,
      );
      limits = `Не удалось получить: ${error?.message ?? error}`;
    }

    const runningTasks = catalog
      .filter((entry) => entry.running)
      .map((entry) => `${entry.provider === "codex" ? "Codex" : "Claude"} · ${entry.projectName} · ${entry.title}`);
    const runningProviders = [...new Set(catalog
      .filter((entry) => entry.running)
      .map((entry) => entry.provider))];
    const selectedBusy = catalog.some((entry) => (
      entry.running && catalogEntryIsSelected(entry, selected)
    ));
    const replyMarkup = runningTaskReplyMarkup(catalog, selected, {
      showProject: this.config.showProjectButton,
    });
    const statusText = formatStatusMessage({
      provider: codexSelected ? "CODEX" : "CLAUDE",
      busy: selectedBusy,
      runningTasks,
      model: codexSelected
        ? this.codexModelLabel(snapshot.codexModel)
        : this.claudeModelLabels[snapshot.claudeModel],
      reasoning: this.reasoningLabels[codexSelected
        ? snapshot.codexReasoningEffort : snapshot.claudeReasoningEffort],
      mode: this.collaborationModeLabels[codexSelected
        ? snapshot.codexCollaborationMode : snapshot.claudeCollaborationMode],
      task,
      project: this.config.showProjectButton ? project.name : null,
      limits,
      showTaskButtons: replyMarkup.inline_keyboard.length > 0,
    });
    await this.sendStatusCard(
      statusText,
      replyMarkup.inline_keyboard.length
        ? { parse_mode: "HTML", reply_markup: replyMarkup }
        : { parse_mode: "HTML" },
      runningProviders,
      { targetChatId: snapshot.chatId, provider: snapshot.provider },
    );
  }
}
