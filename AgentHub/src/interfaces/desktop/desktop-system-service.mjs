import { taskDisplayTitle } from "../../domain/task-display-title.mjs";

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
    searchMessages,
    messageSearchStatus = null,
    markMessageSearchThread = null,
    refreshHistory = null,
    workspaceHierarchy,
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
      searchMessages,
      messageSearchStatus,
      markMessageSearchThread,
      refreshHistory,
      workspaceHierarchy,
      projectRoots,
      samePath,
      trustedDeviceManager,
      resolveTask,
      lastTaskMessage,
      enqueueSpeech,
      maxSpeechJobs,
    });
    this.messageSearchIndexTail = Promise.resolve();
    this.messageSearchIndexScheduled = new Set();
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

  async usageHistory(params = {}) {
    const accountActivity = (await this.readRateLimitHistory({
      range: params.range,
    }))?.accountActivity;
    return this.readUsageHistory({
      range: params.range,
      maxPoints: params.maxPoints,
      provider: params.provider,
      accountKey: params.accountKey,
      accountActivity: Array.isArray(accountActivity) ? accountActivity : [],
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
          title: taskDisplayTitle(entry ?? result, result.taskTitle),
          latestAt: result.latestAt,
          matches: result.matches,
        };
      }),
    };
  }

  async workspaceMessageSearch(params = {}) {
    const workspaceId = String(params.workspaceId ?? "").trim();
    const query = String(params.query ?? "").trim().slice(0, 200);
    const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
    const limit = Math.min(Math.max(Math.floor(Number(params.limit) || 40), 1), 100);
    if (!workspaceId) throw new Error("Укажите Workspace для поиска");
    if (query.length < 2) return {
      workspaceId, query, total: 0, nextOffset: null, results: [],
      indexing: { state: "ready", completedThreads: 0, totalThreads: 0, revision: 1 },
    };
    const workspace = (this.workspaceHierarchy?.() ?? [])
      .find((candidate) => String(candidate?.id ?? "") === workspaceId);
    if (!workspace) throw new Error("Workspace не найден");
    const streams = Array.isArray(workspace.streams) ? workspace.streams : [];
    const streamByThread = new Map();
    const references = [];
    for (const stream of streams) {
      for (const thread of Array.isArray(stream?.threads) ? stream.threads : []) {
        const reference = {
          provider: String(thread?.provider ?? "").trim().toLowerCase(),
          threadId: String(thread?.threadId ?? "").trim(),
        };
        if (!reference.provider || !reference.threadId) continue;
        references.push(reference);
        reference.streamId = String(stream.id ?? "");
        reference.projectRoot = String(thread?.projectRoot ?? "");
        reference.taskTitle = String(stream.displayName ?? stream.name ?? "");
        streamByThread.set(`${reference.provider}\0${reference.threadId}`, stream);
      }
    }
    const indexStatus = typeof this.messageSearchStatus === "function"
      ? this.messageSearchStatus(references)
      : {
        totalThreads: references.length,
        completedThreads: references.length,
        failedThreads: 0,
        threads: references.map((reference) => ({ ...reference, state: "ready" })),
      };
    this.scheduleWorkspaceMessageIndex(references, indexStatus);
    const searched = this.searchMessages({ references, query, offset, limit });
    const results = searched.results.flatMap((result) => {
      const stream = streamByThread.get(`${result.provider}\0${result.threadId}`);
      if (!stream) return [];
      return [{
        ...result,
        workspaceId,
        streamId: String(stream.id),
        streamName: String(stream.displayName ?? stream.name ?? `Stream ${stream.ordinal ?? 1}`),
        streamOrdinal: Math.max(1, Number(stream.ordinal) || 1),
      }];
    });
    const nextOffset = offset + results.length < searched.total
      ? offset + results.length
      : null;
    return {
      workspaceId,
      query,
      total: searched.total,
      nextOffset,
      results,
      indexing: {
        state: indexStatus.failedThreads > 0
          ? "partial"
          : indexStatus.completedThreads < indexStatus.totalThreads ? "indexing" : "ready",
        completedThreads: indexStatus.completedThreads,
        totalThreads: indexStatus.totalThreads,
        failedThreads: indexStatus.failedThreads,
        revision: 1,
      },
    };
  }

  scheduleWorkspaceMessageIndex(references, status) {
    if (typeof this.refreshHistory !== "function"
      || typeof this.markMessageSearchThread !== "function") return;
    const stateByThread = new Map((status?.threads ?? []).map((thread) => (
      [`${thread.provider}\0${thread.threadId}`, thread]
    )));
    for (const reference of references) {
      const key = `${reference.provider}\0${reference.threadId}`;
      const threadState = stateByThread.get(key);
      const failedRetryDue = threadState?.state === "failed"
        && Date.now() - Number(threadState.completedAtMs ?? 0) >= 60_000;
      if (!threadState || !(threadState.state === "pending" || failedRetryDue)
        || this.messageSearchIndexScheduled.has(key)) continue;
      this.messageSearchIndexScheduled.add(key);
      this.messageSearchIndexTail = this.messageSearchIndexTail.catch(() => null).then(async () => {
        try {
          await this.refreshHistory(reference);
          this.markMessageSearchThread(reference);
        } catch (error) {
          this.markMessageSearchThread(reference, { error: error?.message ?? error });
        } finally {
          this.messageSearchIndexScheduled.delete(key);
        }
      });
    }
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
    if (!text) throw new Error("У потока ещё нет завершённого ответа");
    const job = await this.enqueueSpeech(target, text);
    if (!job) throw new Error(`Очередь озвучивания заполнена (${this.maxSpeechJobs})`);
    return { accepted: true, message: "Озвучивание будет отправлено в Telegram" };
  }
}
