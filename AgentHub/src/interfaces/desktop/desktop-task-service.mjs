import { taskDisplayTitle } from "../../domain/task-display-title.mjs";

function normalizedTaskReference(params = {}) {
  const streamId = String(params.streamId ?? "").trim();
  const provider = String(params.provider ?? "").trim();
  const threadId = String(params.threadId ?? params.taskThreadId ?? "").trim();
  if (streamId) return { streamId, provider, threadId };
  if (!["codex", "claude"].includes(provider) || !threadId) {
    throw new Error("Укажите корректную задачу");
  }
  return { streamId: "", provider, threadId };
}

function entryMatchesReference(entry, reference) {
  if (reference.streamId) return String(entry?.streamId ?? "") === reference.streamId;
  return entry?.provider === reference.provider && entry?.threadId === reference.threadId;
}

export class DesktopTaskService {
  constructor({
    catalog,
    refreshCatalog,
    activateBinding,
    markRead,
    snapshot,
    taskHistory,
    dispatchCommand,
    commandTaskTarget,
    readTurn,
    samePath,
    chatId,
    warn = console.warn,
  }) {
    this.catalog = catalog;
    this.refreshCatalog = refreshCatalog;
    this.activateBinding = activateBinding;
    this.markRead = markRead;
    this.snapshot = snapshot;
    this.taskHistory = taskHistory;
    this.dispatchCommand = dispatchCommand;
    this.commandTaskTarget = commandTaskTarget;
    this.readTurn = readTurn;
    this.samePath = samePath;
    this.chatId = chatId;
    this.warn = warn;
  }

  #find(params, entries = this.catalog()) {
    const reference = normalizedTaskReference(params);
    return entries.find((entry) => entryMatchesReference(entry, reference)) ?? null;
  }

  async resolveTarget(params, context = null) {
    const reference = normalizedTaskReference(params);
    const entries = await this.refreshCatalog();
    const entry = entries.find((candidate) => entryMatchesReference(candidate, reference));
    if (!entry) throw new Error("Задача сообщения больше не существует в локальном каталоге");
    return {
      streamId: entry.streamId ?? null,
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      sessionCwd: entry.sessionCwd ?? null,
      threadId: entry.threadId,
      taskTitle: taskDisplayTitle(entry),
      model: entry.model ?? null,
      chatId: this.chatId(),
      telegramDeliveryRequested: false,
      clientSource: String(context?.source ?? "desktop").trim() || "desktop",
    };
  }

  async select(params, context = null) {
    let entry = this.#find(params);
    if (!entry) {
      entry = this.#find(params, await this.refreshCatalog());
    } else {
      void this.refreshCatalog().catch((error) => {
        this.warn(`Cannot refresh task catalog after task selection: ${error.message}`);
      });
    }
    if (!entry) throw new Error("Задача не найдена в локальном каталоге");
    const activation = await this.activateBinding({
      streamId: entry.streamId ?? null,
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
      taskTitle: taskDisplayTitle(entry),
    });
    this.markRead(entry, context);
    return {
      ...await this.snapshot({}, context),
      selectionChanged: activation.changed,
    };
  }

  async openTask(params, context = null) {
    const snapshot = await this.dispatchCommand(
      "task.select",
      params,
      context,
      { target: this.commandTaskTarget(params) },
    );
    return {
      snapshot,
      history: await this.taskHistory({
        streamId: params.streamId,
        provider: params.provider,
        threadId: params.threadId,
        limit: params.limit,
        maxAnswerChars: params.maxAnswerChars,
      }),
    };
  }

  async openTurn(params, context = null) {
    const reference = normalizedTaskReference(params);
    const entry = this.#find(params);
    const taskThread = String(params.taskThreadId || reference.threadId || entry?.threadId || "").trim();
    const turnThread = String(params.turnThreadId ?? taskThread).trim();
    const turnId = String(params.turnId ?? "").trim();
    if (!taskThread || !turnThread || !turnId) throw new Error("Укажите корректный ход");
    void this.refreshCatalog().catch((error) => {
      this.warn(`Cannot refresh task catalog after Desktop turn open: ${error.message}`);
    });
    if (!entry) throw new Error("Задача не найдена в локальном каталоге");
    const record = await this.readTurn({
      provider: entry.provider,
      threadId: turnThread,
      turnId,
    });
    if (!record) throw new Error("Ход не найден в журнале");
    const recordedTaskThread = String(record.taskThreadId ?? record.threadId ?? "").trim();
    if (recordedTaskThread !== taskThread
      || (record.projectRoot && !this.samePath(record.projectRoot, entry.projectRoot))) {
      throw new Error("Ход не относится к выбранной задаче");
    }
    await this.dispatchCommand(
      "task.select",
      { taskTitle: taskDisplayTitle(entry) },
      context,
      {
        target: this.commandTaskTarget({
          streamId: entry.streamId,
          provider: entry.provider,
          projectRoot: entry.projectRoot,
          threadId: entry.threadId,
        }),
      },
    );
    return {
      snapshot: await this.snapshot({}, context),
      history: await this.taskHistory({
        streamId: entry.streamId,
        provider: entry.provider,
        threadId: taskThread,
        limit: params.limit,
        maxAnswerChars: params.maxAnswerChars,
      }),
      focusedTurn: {
        provider: entry.provider,
        taskThreadId: taskThread,
        turnThreadId: turnThread,
        turnId,
        title: String(record.title ?? ""),
        prompt: String(record.prompt ?? ""),
        answer: String(record.body ?? record.text ?? "").slice(
          0,
          Math.max(1_000, Math.min(Number(params.maxAnswerChars) || 200_000, 200_000)),
        ),
        status: String(record.status ?? ""),
        startedAt: record.startedAt ?? null,
        completedAt: record.completedAt ?? null,
      },
    };
  }
}
