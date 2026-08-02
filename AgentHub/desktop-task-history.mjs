export function createDesktopTaskHistoryFactory({
  selection,
  catalog,
  historyReader,
  runs,
  historyMerger,
  receipts = {},
  attachmentImporter = async () => [],
  responseBudget,
  warn = () => {},
}) {
  const refreshes = new Map();
  const refreshedAt = new Map();
  const hydratedHistories = new Map();
  const refreshIntervalMs = 15_000;
  let catalogRefresh = null;

  async function hydrateHistory(history) {
    const result = structuredClone(Array.isArray(history) ? history : []);
    await Promise.all(result.flatMap((item) => (
      (Array.isArray(item.messages) ? item.messages : [])
        .filter((message) => (
          message?.role === "user"
          && Array.isArray(message.attachmentSources)
          && message.attachmentSources.length
          && !(Array.isArray(message.attachments) && message.attachments.length)
        ))
        .map(async (message) => {
          const imported = await attachmentImporter(message.attachmentSources);
          if (imported.length) message.attachments = imported;
        })
    )));
    return result;
  }

  function scheduleRefresh(binding) {
    if (typeof historyReader.refresh !== "function") return;
    const key = `${binding.provider}:${binding.threadId}`;
    if (refreshes.has(key) || Date.now() - (refreshedAt.get(key) ?? 0) < refreshIntervalMs) return;
    refreshedAt.set(key, Date.now());
    const operation = Promise.resolve()
      .then(async () => {
        const refreshed = await historyReader.refresh(binding);
        if (Array.isArray(refreshed?.history)) {
          hydratedHistories.set(key, await hydrateHistory(refreshed.history));
        }
      })
      .catch((error) => warn(
        `Cannot refresh ${binding.provider} history ${binding.threadId}: ${error?.message ?? error}`,
      ))
      .finally(() => refreshes.delete(key));
    refreshes.set(key, operation);
  }

  function scheduleCatalogRefresh() {
    if (typeof catalog.refresh !== "function" || catalogRefresh) return;
    catalogRefresh = Promise.resolve()
      .then(() => catalog.refresh())
      .catch((error) => warn(`Cannot refresh task catalog: ${error?.message ?? error}`))
      .finally(() => { catalogRefresh = null; });
  }

  return async function desktopTaskHistory(params) {
    const provider = String(params.provider ?? selection.activeProvider()).trim();
    const selectedThreadId = String(params.threadId ?? selection.threadId() ?? "").trim();
    if (!["codex", "claude"].includes(provider) || !selectedThreadId) {
      throw new Error("Укажите корректную задачу");
    }

    // Opening a chat must be a local operation. App Server discovery can take
    // tens of seconds when a provider is stuck, while SQLite/taskCatalog is
    // already sufficient to identify the task and render its latest page.
    const entries = typeof catalog.entries === "function"
      ? catalog.entries()
      : await catalog.refresh();
    scheduleCatalogRefresh();
    const entry = entries.find(
      (item) => item.provider === provider && item.threadId === selectedThreadId,
    );
    if (!entry) throw new Error("Задача не найдена в локальном каталоге");

    const binding = {
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
      taskTitle: entry.title,
      chatId: selection.chatId(),
    };
    const key = `${binding.provider}:${binding.threadId}`;
    const cached = await historyReader.read(binding);
    let history = hydratedHistories.get(key);
    if (history) {
      history = structuredClone(history);
      scheduleRefresh(binding);
    } else {
      // A first open uses only durable history. Provider/rollout hydration is
      // intentionally background work, otherwise one stalled App Server read
      // turns every task click into a Desktop-control timeout.
      history = await hydrateHistory(cached.history);
      hydratedHistories.set(key, structuredClone(history));
      scheduleRefresh(binding);
    }
    const running = runs.forTask(binding);
    if (running) {
      historyMerger.mergeActive(history, {
        active: true,
        turnId: running.turnId ?? running.id,
        prompt: running.promptPreview,
        answer: running.responseText,
        clientUserMessageId: running.clientUserMessageId,
        responseItemId: running.responseItemId,
        activities: running.activities,
        startedAt: running.startedAt,
        attachments: running.messageAttachments ?? [],
      });
    }

    const total = history.length;
    const requestedEnd = Number(params.before);
    const end = Number.isSafeInteger(requestedEnd)
      ? Math.max(0, Math.min(requestedEnd, total))
      : total;
    const limit = Math.max(1, Math.min(Number(params.limit) || 10, 20));
    const maxAnswerChars = Math.max(
      1_000,
      Math.min(Number(params.maxAnswerChars) || 200_000, 200_000),
    );
    const start = Math.max(0, end - limit);
    const page = history.slice(start, end);
    const payload = {
      provider,
      threadId: selectedThreadId,
      title: entry.title,
      total,
      start,
      end,
      nextBefore: start > 0 ? start : null,
      items: page.map((item) => ({
        id: String(item.id ?? ""),
        prompt: String(item.prompt ?? "").slice(0, 100_000),
        promptAnnotations: (Array.isArray(item.promptAnnotations) ? item.promptAnnotations : [])
          .slice(0, 20)
          .map((annotation) => ({
            text: String(annotation?.text ?? "").slice(0, 20_000),
            annotation: String(annotation?.annotation ?? "").slice(0, 20_000),
          })),
        promptRequest: String(item.promptRequest ?? "").slice(0, 100_000),
        answer: String(item.answer ?? "").slice(0, maxAnswerChars),
        status: String(item.status ?? ""),
        active: item.active === true,
        completed: item.completed === true,
        startedAt: item.startedAt ?? null,
        completedAt: item.completedAt ?? null,
        activities: Array.isArray(item.activities) ? item.activities.slice(-100) : [],
        messages: (Array.isArray(item.messages) ? item.messages : []).flatMap((message) => {
          const role = String(message?.role ?? "");
          const text = String(message?.text ?? "");
          if (!["user", "agent"].includes(role) || !text) return [];
          const receipt = role === "user"
            ? (message.clientUserMessageId
              ? receipts.forMessage?.({
                provider,
                threadId: selectedThreadId,
                clientUserMessageId: message.clientUserMessageId,
              })
              : null)
              ?? receipts.forTurn?.({
                provider,
                threadId: selectedThreadId,
                turnId: item.id,
              })
            : null;
          return [{
            itemId: String(message.itemId ?? ""),
            ...(message.clientUserMessageId
              ? { clientUserMessageId: String(message.clientUserMessageId) }
              : {}),
            role,
            text: text.slice(0, role === "agent" ? maxAnswerChars : 100_000),
            ...(role === "user" && Array.isArray(message.responseAnnotations)
              ? {
                responseAnnotations: message.responseAnnotations.slice(0, 20).map((annotation) => ({
                  text: String(annotation?.text ?? "").slice(0, 20_000),
                  annotation: String(annotation?.annotation ?? "").slice(0, 20_000),
                })),
                responseAnnotationRequest: String(message.responseAnnotationRequest ?? "").slice(0, 100_000),
              }
              : {}),
            ...(message.phase ? { phase: String(message.phase) } : {}),
            time: message.time
              ?? receipt?.createdAt
              ?? (role === "user" ? item.startedAt : item.completedAt)
              ?? null,
            attachments: role === "user"
              ? (message.attachments ?? receipt?.result?.attachments ?? item.attachments ?? [])
                .map((attachment) => ({ ...attachment }))
              : [],
          }];
        }),
      })),
    };
    return responseBudget.fit(payload, {
      maxBytes: Math.min(
        Math.max(Number(params.maxResponseBytes) || 3_500_000, 64 * 1_024),
        3_500_000,
      ),
    });
  };
}
