export class DesktopSystemService {
  constructor({
    activeProvider,
    isCodex,
    preferences,
    codexModelLabel,
    claudeModelLabels,
    reasoningLabels,
    collaborationModeLabels,
    formattedRateLimits,
    activeRunCount,
    backgroundJobCount,
    readRateLimitHistory,
    readUsageHistory,
    refreshCatalog,
    searchTurns,
    projectRoots,
    samePath,
    trustedDeviceManager,
    resolveTask,
    lastTaskMessage,
    enqueueSpeech,
    maxSpeechJobs,
  }) {
    Object.assign(this, {
      activeProvider,
      isCodex,
      preferences,
      codexModelLabel,
      claudeModelLabels,
      reasoningLabels,
      collaborationModeLabels,
      formattedRateLimits,
      activeRunCount,
      backgroundJobCount,
      readRateLimitHistory,
      readUsageHistory,
      refreshCatalog,
      searchTurns,
      projectRoots,
      samePath,
      trustedDeviceManager,
      resolveTask,
      lastTaskMessage,
      enqueueSpeech,
      maxSpeechJobs,
    });
  }

  async statusDetails() {
    const provider = this.activeProvider();
    let limits;
    try {
      limits = await this.formattedRateLimits(provider);
    } catch (error) {
      limits = `Не удалось получить: ${error.message}`;
    }
    const codexSelected = this.isCodex();
    const preferences = this.preferences(provider);
    return {
      provider,
      model: codexSelected
        ? this.codexModelLabel(preferences.model)
        : this.claudeModelLabels[preferences.model],
      reasoning: this.reasoningLabels[preferences.reasoningEffort],
      mode: this.collaborationModeLabels[preferences.collaborationMode],
      limits,
      activeCount: this.activeRunCount(),
      backgroundJobs: this.backgroundJobCount(),
    };
  }

  rateLimitHistory(params = {}) {
    return this.readRateLimitHistory({
      range: params.range,
      maxPointsPerSeries: params.maxPointsPerSeries,
    });
  }

  usageHistory(params = {}) {
    return this.readUsageHistory({
      range: params.range,
      maxPoints: params.maxPoints,
      provider: params.provider,
      turnTimeMode: params.turnTimeMode,
      ...(Array.isArray(params.activeIntervals) ? { activeIntervals: params.activeIntervals } : {}),
    });
  }

  async search(params = {}) {
    const query = String(params.query ?? "").trim().slice(0, 200);
    if (query.length < 2) return { query, results: [] };
    const catalog = await this.refreshCatalog();
    const results = await this.searchTurns(query, {
      limit: Math.min(Math.max(Number(params.limit) || 100, 1), 200),
      perTask: 3,
      projectRoots: this.projectRoots(),
    });
    return {
      query,
      results: results.map((result) => {
        const entry = catalog.find((candidate) => (
          candidate.provider === result.provider
          && candidate.threadId === result.threadId
          && (!result.projectRoot || this.samePath(candidate.projectRoot, result.projectRoot))
        ));
        return {
          id: entry?.streamId ?? (entry
            ? `${entry.provider}:${entry.threadId}`
            : `${result.provider}:${result.threadId}`),
          streamId: entry?.streamId ?? result.streamId ?? null,
          provider: result.provider,
          threadId: result.threadId,
          projectRoot: result.projectRoot,
          title: entry?.title ?? result.taskTitle,
          latestAt: result.latestAt,
          matches: result.matches,
        };
      }),
    };
  }

  trustedDevices(_params, context) {
    return this.trustedDeviceManager(context).list();
  }

  createDevicePairing(_params, context) {
    return this.trustedDeviceManager(context).createPairing();
  }

  revokeDevice(params, context) {
    const deviceId = String(params?.deviceId ?? "").trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/u.test(deviceId)) throw new Error("Некорректный идентификатор устройства");
    return this.trustedDeviceManager(context).revoke(deviceId);
  }

  async speakLastAnswer(params) {
    const target = await this.resolveTask(params);
    const text = String(this.lastTaskMessage(target)?.text ?? "").trim();
    if (!text) throw new Error("У задачи ещё нет завершённого ответа");
    const job = await this.enqueueSpeech(target, text);
    if (!job) throw new Error(`Очередь озвучивания заполнена (${this.maxSpeechJobs})`);
    return { accepted: true, message: "Озвучивание будет отправлено в Telegram" };
  }
}
