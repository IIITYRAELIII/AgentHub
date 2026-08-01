export function createDesktopTaskHistoryFactory({
  selection,
  catalog,
  historyReader,
  runs,
  historyMerger,
  receipts = {},
  attachmentImporter = async () => [],
  responseBudget,
}) {
  return async function desktopTaskHistory(params) {
    const provider = String(params.provider ?? selection.activeProvider()).trim();
    const selectedThreadId = String(params.threadId ?? selection.threadId() ?? "").trim();
    if (!["codex", "claude"].includes(provider) || !selectedThreadId) {
      throw new Error("Укажите корректную задачу");
    }

    const entries = await catalog.refresh();
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
    const { history } = await historyReader.read(binding);
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
    await Promise.all(page.flatMap((item) => (
      (Array.isArray(item.messages) ? item.messages : [])
        .filter((message) => message?.role === "user" && Array.isArray(message.attachmentSources))
        .map(async (message) => {
          const imported = await attachmentImporter(message.attachmentSources);
          if (imported.length) {
            message.attachments = [
              ...(Array.isArray(message.attachments) ? message.attachments : []),
              ...imported,
            ];
          }
        })
    )));
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
