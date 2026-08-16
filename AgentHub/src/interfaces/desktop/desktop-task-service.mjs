import { displayUserPrompt } from "../../application/task-history.mjs";
import {
  interstreamMessageDetails,
  normalizeInterstreamOrigin,
} from "../../domain/interstream-message.mjs";
import { taskDisplayTitle } from "../../domain/task-display-title.mjs";

const MAX_DESKTOP_RESPONSE_BYTES = 3_500_000;
const MIN_HISTORY_RESPONSE_BYTES = 64 * 1_024;
const RESPONSE_ENVELOPE_RESERVE_BYTES = 16 * 1_024;

function historyResponseBudget(value, params = {}) {
  const totalBytes = Math.min(
    Math.max(Number(params.maxResponseBytes) || MAX_DESKTOP_RESPONSE_BYTES, MIN_HISTORY_RESPONSE_BYTES),
    MAX_DESKTOP_RESPONSE_BYTES,
  );
  const consumedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  return Math.max(
    MIN_HISTORY_RESPONSE_BYTES,
    totalBytes - consumedBytes - RESPONSE_ENVELOPE_RESERVE_BYTES,
  );
}

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
    searchMessage = () => null,
    threadsForStream = () => [],
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
    this.searchMessage = searchMessage;
    this.threadsForStream = threadsForStream;
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
    let entry = this.#find(params);
    if (!entry) {
      entry = this.#find(params, await this.refreshCatalog());
    } else {
      void this.refreshCatalog().catch((error) => {
        this.warn(`Cannot refresh task catalog after message intake: ${error.message}`);
      });
    }
    if (!entry) throw new Error("Задача сообщения больше не существует в локальном каталоге");
    const messageOrigin = normalizeInterstreamOrigin(context?.messageOrigin);
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
      ...(messageOrigin ? { messageOrigin } : {}),
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
      ...await this.snapshot(params, context),
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
        maxResponseBytes: historyResponseBudget({ snapshot }, params),
      }),
    };
  }

  async openTurn(params, context = null) {
    const reference = normalizedTaskReference(params);
    const entry = this.#find(params);
    const taskThread = String(params.taskThreadId || reference.threadId || entry?.threadId || "").trim();
    const turnThread = String(params.turnThreadId ?? taskThread).trim();
    const turnId = String(params.turnId ?? "").trim();
    const itemId = String(params.itemId ?? "").trim();
    if (!taskThread || !turnThread || !turnId) throw new Error("Укажите корректный ход");
    void this.refreshCatalog().catch((error) => {
      this.warn(`Cannot refresh task catalog after Desktop turn open: ${error.message}`);
    });
    if (!entry) throw new Error("Задача не найдена в локальном каталоге");
    const targetProvider = String(params.provider ?? entry.provider).trim();
    if (itemId && entry.streamId && !this.threadsForStream(entry.streamId).some((thread) => (
      String(thread?.provider ?? "") === targetProvider
      && String(thread?.threadId ?? "") === taskThread
    ))) {
      throw new Error("Ход не относится к выбранному Stream");
    }
    const indexedMessage = itemId ? this.searchMessage({
      provider: targetProvider,
      threadId: taskThread,
      turnId,
      itemId,
    }) : null;
    if (itemId && !indexedMessage) throw new Error("Сообщение не найдено в индексе");
    const record = await this.readTurn({
      provider: targetProvider,
      threadId: turnThread,
      turnId,
    });
    if (!record && !indexedMessage) throw new Error("Ход не найден в журнале");
    const recordedTaskThread = String(record?.taskThreadId ?? record?.threadId ?? "").trim();
    if (record && (recordedTaskThread !== taskThread
      || (record.projectRoot && !this.samePath(record.projectRoot, entry.projectRoot)))) {
      throw new Error("Ход не относится к выбранной задаче");
    }
    const snapshot = await this.dispatchCommand(
      "task.select",
      {
        ...params,
        streamId: entry.streamId,
        provider: entry.provider,
        threadId: entry.threadId,
        taskTitle: taskDisplayTitle(entry),
      },
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
    const rawPrompt = String(record?.prompt ?? "");
    const interstream = interstreamMessageDetails(rawPrompt);
    const focusedTurn = {
      provider: targetProvider,
      taskThreadId: taskThread,
      turnThreadId: turnThread,
      turnId,
      title: String(record?.title ?? ""),
      prompt: displayUserPrompt(rawPrompt),
      ...(interstream ? { promptAuthor: interstream.author } : {}),
      answer: String(record?.body ?? record?.text ?? "").slice(
        0,
        Math.max(1_000, Math.min(Number(params.maxAnswerChars) || 200_000, 200_000)),
      ),
      status: String(record?.status ?? ""),
      startedAt: record?.startedAt ?? null,
      completedAt: record?.completedAt ?? null,
      ...(indexedMessage ? {
        messages: [{
          itemId: indexedMessage.itemId,
          role: indexedMessage.role,
          text: indexedMessage.text,
          ...(indexedMessage.author ? { author: indexedMessage.author } : {}),
          time: indexedMessage.occurredAt,
          attachments: indexedMessage.attachmentNames.map((name) => ({ name })),
        }],
        focusItemId: indexedMessage.itemId,
      } : {}),
    };
    return {
      snapshot,
      history: await this.taskHistory({
        streamId: entry.streamId,
        provider: targetProvider,
        threadId: taskThread,
        limit: params.limit,
        maxAnswerChars: params.maxAnswerChars,
        maxResponseBytes: historyResponseBudget({ snapshot, focusedTurn }, params),
      }),
      focusedTurn,
      ...(indexedMessage ? { focusedMessage: indexedMessage } : {}),
    };
  }
}
