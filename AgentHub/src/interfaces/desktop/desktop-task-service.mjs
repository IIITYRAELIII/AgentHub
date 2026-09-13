import { displayUserPrompt } from "../../application/task-history.mjs";
import {
  normalizeInterstreamOrigin,
  trustedInterstreamMessageDetails,
} from "../../domain/interstream-message.mjs";
import { taskDisplayTitle } from "../../domain/task-display-title.mjs";

const MAX_DESKTOP_RESPONSE_BYTES = 3_500_000;
const MIN_HISTORY_RESPONSE_BYTES = 64 * 1_024;
const RESPONSE_ENVELOPE_RESERVE_BYTES = 16 * 1_024;
const SELECTION_WITHOUT_SNAPSHOT = Symbol("selection-without-snapshot");

function responseBudget(params = {}) {
  return Math.min(
    Math.max(Number(params.maxResponseBytes) || MAX_DESKTOP_RESPONSE_BYTES, MIN_HISTORY_RESPONSE_BYTES),
    MAX_DESKTOP_RESPONSE_BYTES,
  );
}

function historyResponseBudget(value, params = {}) {
  const totalBytes = responseBudget(params);
  const consumedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  return totalBytes - consumedBytes - RESPONSE_ENVELOPE_RESERVE_BYTES;
}

function normalizedTaskReference(params = {}) {
  const streamId = String(params.streamId ?? "").trim();
  const provider = String(params.provider ?? "").trim();
  const threadId = String(params.threadId ?? params.taskThreadId ?? "").trim();
  if (streamId) return { streamId, provider, threadId };
  if (!["codex", "claude"].includes(provider) || !threadId) {
    throw new Error("Укажите корректный поток");
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
    snapshot,
    taskHistory,
    dispatchCommand,
    commandTaskTarget,
    readTurn,
    searchMessage = () => null,
    threadsForStream = () => [],
    currentThread = () => null,
    streamSettings = () => null,
    samePath,
    chatId,
    warn = console.warn,
  }) {
    this.catalog = catalog;
    this.refreshCatalog = refreshCatalog;
    this.activateBinding = activateBinding;
    this.snapshot = snapshot;
    this.taskHistory = taskHistory;
    this.dispatchCommand = dispatchCommand;
    this.commandTaskTarget = commandTaskTarget;
    this.readTurn = readTurn;
    this.searchMessage = searchMessage;
    this.threadsForStream = threadsForStream;
    this.currentThread = currentThread;
    this.streamSettings = streamSettings;
    this.samePath = samePath;
    this.chatId = chatId;
    this.warn = warn;
  }

  #find(params, entries = this.catalog()) {
    const reference = normalizedTaskReference(params);
    return entries.find((entry) => entryMatchesReference(entry, reference)) ?? null;
  }

  #findCurrentStream(streamId, entries = this.catalog()) {
    const current = this.currentThread(streamId);
    if (!current) return null;
    return entries.find((entry) => (
      String(entry?.streamId ?? "") === String(streamId)
      && String(entry?.provider ?? "") === String(current.provider ?? "")
      && String(entry?.threadId ?? "") === String(current.threadId ?? "")
    )) ?? null;
  }

  #findHistoricalThread(params, entries = this.catalog()) {
    const reference = normalizedTaskReference(params);
    if (reference.streamId) return null;
    return entries.find((entry) => entry?.streamId && this.threadsForStream(entry.streamId).some((thread) => (
      String(thread?.provider ?? "") === reference.provider
      && String(thread?.threadId ?? "") === reference.threadId
    ))) ?? null;
  }

  async #resolveOpenEntry(params) {
    let entries = this.catalog();
    let entry = this.#find(params, entries) ?? this.#findHistoricalThread(params, entries);
    if (!entry) {
      entries = await this.refreshCatalog();
      entry = this.#find(params, entries) ?? this.#findHistoricalThread(params, entries);
    } else {
      void this.refreshCatalog().catch((error) => {
        this.warn(`Cannot refresh task catalog after Desktop task open: ${error.message}`);
      });
    }
    if (!entry) throw new Error("Поток не найден в локальном каталоге");
    return entry;
  }

  async resolveTarget(params, context = null) {
    const reference = normalizedTaskReference(params);
    let entry = reference.streamId
      ? this.#findCurrentStream(reference.streamId)
      : this.#find(params);
    if (!entry) {
      const refreshed = await this.refreshCatalog();
      entry = reference.streamId
        ? this.#findCurrentStream(reference.streamId, refreshed)
        : this.#find(params, refreshed);
    }
    if (!entry) throw new Error("Поток сообщения больше не существует в локальном каталоге");
    const binding = entry.streamId ? this.threadsForStream(entry.streamId).find((thread) => (
      String(thread?.provider ?? "") === String(entry.provider ?? "")
      && String(thread?.threadId ?? "") === String(entry.threadId ?? "")
    )) : null;
    if (binding?.detachedAtMs != null) {
      throw new Error("Это исторический Thread тестового контура. Сначала создай новый Thread в этом Stream");
    }
    const settings = entry.streamId ? this.streamSettings(entry.streamId) : null;
    const settingsProvider = String(settings?.provider ?? "").trim();
    const settingsModelId = String(settings?.model ?? "").trim();
    const catalogModelId = String(entry.model ?? "").trim();
    const modelId = settingsModelId
      && (!settingsProvider || settingsProvider === String(entry.provider ?? "").trim())
      ? settingsModelId
      : catalogModelId || null;
    const messageOrigin = normalizeInterstreamOrigin(context?.messageOrigin);
    return {
      streamId: entry.streamId ?? null,
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      sessionCwd: entry.sessionCwd ?? null,
      threadId: entry.threadId,
      taskTitle: taskDisplayTitle(entry),
      modelId,
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
    if (!entry) throw new Error("Поток не найден в локальном каталоге");
    const activation = await this.activateBinding({
      streamId: entry.streamId ?? null,
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
      taskTitle: taskDisplayTitle(entry),
    });
    if (params[SELECTION_WITHOUT_SNAPSHOT] === true) {
      return { selectionChanged: activation.changed };
    }
    return {
      ...await this.snapshot(params, context),
      selectionChanged: activation.changed,
    };
  }

  async openTask(params, context = null) {
    const entry = await this.#resolveOpenEntry(params);
    const resolvedParams = {
      ...params,
      streamId: entry.streamId ?? null,
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
      taskTitle: taskDisplayTitle(entry),
    };
    const historyParams = {
      streamId: resolvedParams.streamId,
      provider: resolvedParams.provider,
      threadId: resolvedParams.threadId,
      refreshSource: false,
      limit: params.limit,
      maxAnswerChars: params.maxAnswerChars,
    };
    const [selection, response] = await Promise.all([
      this.dispatchCommand(
        "task.select",
        { ...resolvedParams, [SELECTION_WITHOUT_SNAPSHOT]: true },
        context,
        { target: this.commandTaskTarget(resolvedParams) },
      ),
      this.#openHistoryOnlyResponse(historyParams, params),
    ]);
    return { ...response, selectionChanged: selection?.selectionChanged === true };
  }

  async #openHistoryOnlyResponse(historyParams, params, extra = {}) {
    const envelope = { ...extra, snapshot: null, snapshotDeferred: true };
    const maxBytes = historyResponseBudget(envelope, params);
    if (maxBytes < MIN_HISTORY_RESPONSE_BYTES) {
      throw new Error("Содержимое выбранного сообщения превышает общий лимит транспорта");
    }
    // Selection is an ordered mutation, while the exact history page is an
    // independent read. Run them together and let the client fetch the
    // authoritative version-fenced snapshot after the first visible page.
    const history = await this.taskHistory({
      ...historyParams,
      refreshSource: false,
      maxResponseBytes: maxBytes,
    });
    const result = { ...envelope, history };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > responseBudget(params)) {
      throw new Error("Ответ открытия истории превышает общий лимит транспорта");
    }
    return result;
  }

  async #openHistoryResponse(snapshot, historyParams, params, extra = {}) {
    let envelope = { snapshot, ...extra };
    let maxBytes = historyResponseBudget(envelope, params);
    const deferSnapshot = () => {
      // Null is absence, not an empty full snapshot: clients retain their
      // canonical collections and request the ordinary delta separately.
      envelope = { ...extra, snapshot: null, snapshotDeferred: true };
      maxBytes = historyResponseBudget(envelope, params);
    };
    if (maxBytes < MIN_HISTORY_RESPONSE_BYTES) deferSnapshot();
    if (maxBytes < MIN_HISTORY_RESPONSE_BYTES) {
      throw new Error("Содержимое выбранного сообщения превышает общий лимит транспорта");
    }
    const read = () => this.taskHistory({ ...historyParams, refreshSource: false, maxResponseBytes: maxBytes });
    let history;
    try {
      history = await read();
    } catch (error) {
      if (error?.code !== "TASK_HISTORY_RESPONSE_BUDGET_EXCEEDED" || envelope.snapshotDeferred) throw error;
      // The first read may contain a complete quote larger than the remaining
      // shared envelope. Retry only that local read, never task.select or a
      // provider refresh, and never cut annotations or their source locators.
      deferSnapshot();
      history = await read();
    }
    if (history?.transportTruncated === true && !envelope.snapshotDeferred) {
      // A fitted response may succeed only because message text was shortened.
      // Give history the whole envelope before presenting that lossy projection.
      deferSnapshot();
      history = await read();
    }
    const result = { ...envelope, history };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > responseBudget(params)) {
      throw new Error("Ответ открытия истории превышает общий лимит транспорта");
    }
    return result;
  }

  async openTurn(params, context = null) {
    const reference = normalizedTaskReference(params);
    // Turn routes retain the provider/Thread that owns the historical turn.
    // After a Stream rebirth that pair is no longer the catalog's current
    // entry, so resolve it through the same Stream history used by openTask.
    const entry = await this.#resolveOpenEntry(params);
    const taskThread = String(params.taskThreadId || reference.threadId || entry?.threadId || "").trim();
    const turnThread = String(params.turnThreadId ?? taskThread).trim();
    const turnId = String(params.turnId ?? "").trim();
    const itemId = String(params.itemId ?? "").trim();
    if (!taskThread || !turnThread || !turnId) throw new Error("Укажите корректный ход");
    const targetProvider = String(params.provider ?? entry.provider).trim();
    const currentBindingMatches = entry.provider === targetProvider && entry.threadId === taskThread;
    const historicalBinding = entry.streamId && !currentBindingMatches
      ? this.threadsForStream(entry.streamId).find((thread) => (
        String(thread?.provider ?? "") === targetProvider
        && String(thread?.threadId ?? "") === taskThread
      ))
      : null;
    const taskBelongsToStream = currentBindingMatches || Boolean(historicalBinding);
    if (entry.streamId && !taskBelongsToStream) {
      throw new Error("Ход не относится к выбранному Stream");
    }
    const indexedMessage = itemId ? this.searchMessage({
      provider: targetProvider,
      threadId: taskThread,
      turnId,
      itemId,
    }) : null;
    if (itemId && !indexedMessage) throw new Error("Сообщение не найдено в индексе");
    const requestedRole = String(params.role ?? "").trim();
    if (indexedMessage && (
      (requestedRole && indexedMessage.role !== requestedRole)
      || (indexedMessage.turnThreadId && indexedMessage.turnThreadId !== turnThread)
    )) {
      throw new Error("Сообщение не соответствует указанной identity");
    }
    const record = await this.readTurn({
      provider: targetProvider,
      threadId: turnThread,
      turnId,
    });
    if (!record && !indexedMessage) throw new Error("Ход не найден в журнале");
    const recordedTaskThread = String(record?.taskThreadId ?? record?.threadId ?? "").trim();
    const owningProjectRoot = String(historicalBinding?.projectRoot ?? entry.projectRoot ?? "").trim();
    if (record && (recordedTaskThread !== taskThread
      || (record.projectRoot && owningProjectRoot && !this.samePath(record.projectRoot, owningProjectRoot)))) {
      throw new Error("Ход не относится к выбранному потоку");
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
    const rootUserMessage = (Array.isArray(record?.userMessages) ? record.userMessages : [])
      .find((message) => String(message?.role ?? "") === "user") ?? null;
    const interstream = trustedInterstreamMessageDetails(rawPrompt, {
      origin: record?.messageOrigin ?? record?.origin
        ?? rootUserMessage?.origin ?? rootUserMessage?.messageOrigin,
      clientUserMessageId: record?.clientUserMessageId
        ?? rootUserMessage?.clientUserMessageId ?? rootUserMessage?.clientId,
    });
    const focusedTurn = {
      provider: targetProvider,
      taskThreadId: taskThread,
      turnThreadId: turnThread,
      turnId,
      title: String(record?.title ?? ""),
      prompt: displayUserPrompt(interstream?.text ?? rawPrompt),
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
          messageKey: indexedMessage.messageKey,
          sourceAlias: indexedMessage.sourceAlias,
          semanticSlot: indexedMessage.semanticSlot,
          pinEligible: indexedMessage.pinEligible === true,
          ...(indexedMessage.clientUserMessageId
            ? { clientUserMessageId: indexedMessage.clientUserMessageId }
            : {}),
          ...(indexedMessage.author ? { author: indexedMessage.author } : {}),
          time: indexedMessage.occurredAt,
          attachments: indexedMessage.attachmentNames.map((name) => ({ name })),
        }],
        focusItemId: indexedMessage.itemId,
      } : {}),
    };
    return this.#openHistoryResponse(snapshot, {
        streamId: entry.streamId,
        provider: targetProvider,
        threadId: taskThread,
        limit: params.limit,
        maxAnswerChars: params.maxAnswerChars,
      }, params, {
      focusedTurn,
      ...(indexedMessage ? { focusedMessage: indexedMessage } : {}),
    });
  }
}
