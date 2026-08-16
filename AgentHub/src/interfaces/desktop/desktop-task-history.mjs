import { createHash } from "node:crypto";
import {
  displayUserPrompt,
  isEmptyTurnCompletionPlaceholder,
  mergeSyntheticRolloutUsers,
  withoutCodexInspectionAttachments,
} from "../../application/task-history.mjs";
import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";
import { isCodexAutoCompactionTurnId } from "../../domain/codex-internal-turn.mjs";
import { taskDisplayTitle } from "../../domain/task-display-title.mjs";
import { taskRunIsActive } from "../../domain/task-runs.mjs";

const MAX_CACHED_HISTORIES = 12;
const MAX_CACHED_TURNS_PER_HISTORY = 40;

function historyItemTimestamp(item) {
  const values = [
    item?.startedAt,
    ...(Array.isArray(item?.messages) ? item.messages.map((message) => message?.time) : []),
    item?.completedAt,
  ].map((value) => Date.parse(String(value ?? ""))).filter(Number.isFinite);
  return values.length ? Math.min(...values) : Number.NaN;
}

function sortTaskHistoryChronologically(history) {
  return history
    .map((item, index) => ({ item, index, time: historyItemTimestamp(item) }))
    .sort((left, right) => {
      if (Number.isFinite(left.time) && Number.isFinite(right.time) && left.time !== right.time) {
        return left.time - right.time;
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

// Builds the bounded Desktop/Mini App history read-model for one task.
function mergeDurableMessages(hydratedMessages, durableMessages) {
  const values = structuredClone(Array.isArray(hydratedMessages) ? hydratedMessages : []);
  for (const durable of Array.isArray(durableMessages) ? durableMessages : []) {
    const itemId = String(durable?.itemId ?? "").trim();
    const clientId = String(durable?.clientUserMessageId ?? "").trim();
    let index = values.findIndex((message) => (
      (itemId && String(message?.itemId ?? "").trim() === itemId)
      || (clientId && String(message?.clientUserMessageId ?? "").trim() === clientId)
    ));
    if (index < 0 && durable?.role === "agent") {
      const syntheticFinalId = /:(?:rollout-)?agent:(?:live|final)$/u.test(itemId);
      if (syntheticFinalId) {
        const candidates = values.map((message, candidateIndex) => ({ message, candidateIndex }))
          .filter(({ message }) => (
            message?.role === "agent"
            && /:(?:rollout-)?agent:(?:live|final)$/u.test(String(message?.itemId ?? ""))
          ));
        if (candidates.length === 1) index = candidates[0].candidateIndex;
      }
    }
    if (index < 0) {
      values.push(structuredClone(durable));
      continue;
    }
    const current = values[index];
    values[index] = {
      ...current,
      ...structuredClone(durable),
      time: current.time ?? durable?.time ?? null,
      attachments: Array.isArray(durable?.attachments) && durable.attachments.length
        ? structuredClone(durable.attachments)
        : current.attachments,
      attachmentSources: Array.isArray(durable?.attachmentSources) && durable.attachmentSources.length
        ? structuredClone(durable.attachmentSources)
        : current.attachmentSources,
    };
  }
  return values;
}

export function mergeDurableTaskHistory(hydratedHistory, durableHistory) {
  const values = structuredClone(Array.isArray(hydratedHistory) ? hydratedHistory : []);
  for (const durable of Array.isArray(durableHistory) ? durableHistory : []) {
    const id = String(durable?.id ?? "").trim();
    const index = id
      ? values.findIndex((item) => String(item?.id ?? "").trim() === id)
      : -1;
    if (index < 0) {
      values.push(structuredClone(durable));
      continue;
    }
    const current = values[index];
    values[index] = {
      ...current,
      ...structuredClone(durable),
      startedAt: current.startedAt ?? durable?.startedAt ?? null,
      completedAt: current.completedAt ?? durable?.completedAt ?? null,
      messages: mergeSyntheticRolloutUsers(
        mergeDurableMessages(current.messages, durable?.messages),
        id,
      ),
      activities: Array.isArray(durable?.activities) && durable.activities.length
        ? structuredClone(durable.activities)
        : current.activities,
      activityGroups: Array.isArray(durable?.activityGroups) && durable.activityGroups.length
        ? structuredClone(durable.activityGroups)
        : current.activityGroups,
    };
  }
  return values;
}

function mergeCachedTaskHistory(cachedHistory, durableHistory) {
  const cachedById = new Map((Array.isArray(cachedHistory) ? cachedHistory : [])
    .map((item) => [String(item?.id ?? "").trim(), item])
    .filter(([id]) => Boolean(id)));
  if (!cachedById.size) return Array.isArray(durableHistory) ? durableHistory : [];

  const values = [];
  const durableIds = new Set();
  for (const durable of Array.isArray(durableHistory) ? durableHistory : []) {
    const id = String(durable?.id ?? "").trim();
    if (id) durableIds.add(id);
    const cached = id ? cachedById.get(id) : null;
    values.push(cached
      ? mergeDurableTaskHistory([cached], [durable])[0]
      : durable);
  }
  for (const [id, cached] of cachedById) {
    if (!durableIds.has(id)) values.push(structuredClone(cached));
  }
  return values;
}

function visibleProviderHistory(provider, history) {
  const values = Array.isArray(history) ? history : [];
  return provider === "codex"
    ? withoutCodexInspectionAttachments(values.filter((turn) => (
      !isCodexContextProbeTurn(turn)
      && !isCodexAutoCompactionTurnId(turn?.id)
      && !isEmptyTurnCompletionPlaceholder(turn)
    )))
    : values;
}

export function createDesktopTaskHistoryFactory({
  selection,
  catalog,
  historyReader,
  runs,
  historyMerger,
  latestMessage = () => null,
  receipts = {},
  attachmentImporter = async () => [],
  responseBudget,
  warn = () => {},
}) {
  const refreshes = new Map();
  const refreshedAt = new Map();
  const providerHistories = new Map();
  const hydratedHistories = new Map();
  const refreshIntervalMs = 15_000;
  let catalogRefresh = null;

  async function hydrateHistory(history) {
    const result = structuredClone(Array.isArray(history) ? history : []);
    await Promise.all(result.flatMap((item) => (
      (Array.isArray(item.messages) ? item.messages : [])
        .filter((message) => (
          ["user", "agent"].includes(String(message?.role ?? ""))
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

  function readCachedHistory(cache, key) {
    const turns = cache.get(key);
    if (!turns) return [];
    cache.delete(key);
    cache.set(key, turns);
    return [...turns.values()].map((turn) => structuredClone(turn));
  }

  function cacheHistory(cache, key, history, { replace = false } = {}) {
    const turns = replace ? new Map() : new Map(cache.get(key) ?? []);
    for (const turn of Array.isArray(history) ? history : []) {
      const id = String(turn?.id ?? "").trim();
      if (!id) continue;
      turns.delete(id);
      turns.set(id, structuredClone(turn));
    }
    while (turns.size > MAX_CACHED_TURNS_PER_HISTORY) {
      turns.delete(turns.keys().next().value);
    }
    if (!turns.size) return;
    cache.delete(key);
    cache.set(key, turns);
    while (cache.size > MAX_CACHED_HISTORIES) {
      cache.delete(cache.keys().next().value);
    }
  }

  function scheduleRefresh(binding, { force = false } = {}) {
    if (typeof historyReader.refresh !== "function") return null;
    const key = `${binding.provider}:${binding.threadId}`;
    if (refreshes.has(key)) return refreshes.get(key);
    if (!force && Date.now() - (refreshedAt.get(key) ?? 0) < refreshIntervalMs) return null;
    refreshedAt.set(key, Date.now());
    const operation = Promise.resolve()
      .then(async () => {
        const refreshed = await historyReader.refresh(binding);
        if (Array.isArray(refreshed?.history)) {
          cacheHistory(
            providerHistories,
            key,
            visibleProviderHistory(binding.provider, refreshed.history).slice(-MAX_CACHED_TURNS_PER_HISTORY),
            { replace: true },
          );
        }
      })
      .catch((error) => warn(
        `Cannot refresh ${binding.provider} history ${binding.threadId}: ${error?.message ?? error}`,
      ))
      .finally(() => refreshes.delete(key));
    refreshes.set(key, operation);
    return operation;
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
    const selectedStreamId = String(params.streamId ?? "").trim();
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
    const entry = entries.find((item) => (
      (selectedStreamId && item.streamId === selectedStreamId)
      || (!selectedStreamId && item.provider === provider && item.threadId === selectedThreadId)
    ));
    if (!entry) throw new Error("Задача не найдена в локальном каталоге");

    const binding = {
      ...((entry.streamId ?? selectedStreamId) ? { streamId: entry.streamId ?? selectedStreamId } : {}),
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
      taskTitle: taskDisplayTitle(entry),
      chatId: selection.chatId(),
    };
    const streamThreads = binding.streamId && typeof catalog.threadsForStream === "function"
      ? catalog.threadsForStream(binding.streamId)
      : [];
    const threadBindings = streamThreads.length ? streamThreads.map((thread) => ({
      streamId: binding.streamId,
      provider: thread.provider,
      projectRoot: thread.projectRoot || binding.projectRoot,
      threadId: thread.threadId,
      taskTitle: binding.taskTitle,
      chatId: binding.chatId,
    })) : [binding];
    const historySources = new Map();
    const history = [];
    for (const threadBinding of threadBindings) {
      const key = `${threadBinding.provider}:${threadBinding.threadId}`;
      if (params.refreshSource === true) {
        await scheduleRefresh(threadBinding, { force: true });
      }
      const cached = await historyReader.read(threadBinding);
      const durableHistory = visibleProviderHistory(threadBinding.provider, cached.history);
      let threadHistory = mergeCachedTaskHistory(
        readCachedHistory(providerHistories, key),
        durableHistory,
      );
      threadHistory = mergeCachedTaskHistory(
        readCachedHistory(hydratedHistories, key),
        threadHistory,
      );
      scheduleRefresh(threadBinding);
      for (const item of threadHistory) {
        history.push(item);
        historySources.set(item, {
          key,
          provider: threadBinding.provider,
          threadId: threadBinding.threadId,
        });
      }
    }
    const indexedRun = params.includeActive === false ? null : runs.forTask(binding);
    const candidateRun = indexedRun
      && taskRunIsActive(indexedRun)
      && String(indexedRun.provider ?? "") === String(binding.provider ?? "")
      && String(indexedRun.threadId ?? "") === String(binding.threadId ?? "")
      ? indexedRun
      : null;
    const running = binding.provider === "codex" && isCodexContextProbeTurn({
      prompt: candidateRun?.promptPreview,
      finalAnswer: candidateRun?.responseText,
      clientUserMessageId: candidateRun?.clientUserMessageId,
      userMessages: candidateRun?.userMessages,
    }) ? null : candidateRun;
    if (running) {
      historyMerger.mergeActive(history, {
        active: true,
        provider: running.provider ?? binding.provider,
        turnId: running.turnId ?? running.id,
        prompt: running.promptPreview,
        answer: running.responseText,
        clientUserMessageId: running.clientUserMessageId,
        userMessages: running.userMessages,
        responseItemId: running.responseItemId,
        activities: running.activities,
        ...(Array.isArray(running.activityGroups) && running.activityGroups.length
          ? { activityGroups: running.activityGroups }
          : {}),
        startedAt: running.startedAt,
        attachments: running.messageAttachments ?? [],
      });
    } else {
      const savedCompletion = latestMessage(binding);
      const completed = savedCompletion?.threadId
        && String(savedCompletion.threadId) !== String(binding.threadId)
        ? null
        : savedCompletion;
      const completedTurnId = String(completed?.turnId ?? "").trim();
      const matchingTurnVisible = completedTurnId && history.some((item) => (
        String(item?.id ?? "").trim() === completedTurnId
      ));
      const unrelatedActiveTurnVisible = history.some((item) => (
        item?.active === true && String(item?.id ?? "").trim() !== completedTurnId
      ));
      if (completed?.turnId && completed?.text && !(
        binding.provider === "codex" && isCodexContextProbeTurn({
          turnId: completed.turnId,
          finalAnswer: completed.text,
        })
      ) && !(
        binding.provider === "codex" && isEmptyTurnCompletionPlaceholder({
          answer: completed.text,
        })
      ) && (matchingTurnVisible || !unrelatedActiveTurnVisible)) {
        historyMerger.mergeCompleted(history, {
          turnId: completed.turnId,
          answer: completed.text,
          completedAt: completed.updatedAt,
        });
      }
    }

    for (const item of history) {
      if (!historySources.has(item)) {
        historySources.set(item, {
          key: `${binding.provider}:${binding.threadId}`,
          provider: binding.provider,
          threadId: binding.threadId,
        });
      }
    }

    const orderedHistory = sortTaskHistoryChronologically(history);
    const total = orderedHistory.length;
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
    const rawPage = orderedHistory.slice(start, end);
    const pageSources = rawPage.map((item) => historySources.get(item));
    const page = await hydrateHistory(rawPage);
    for (let index = 0; index < page.length; index += 1) {
      const source = pageSources[index];
      if (source?.key) cacheHistory(hydratedHistories, source.key, [page[index]]);
    }
    const payload = {
      ...(binding.streamId ? { streamId: binding.streamId } : {}),
      provider,
      threadId: selectedThreadId,
      title: taskDisplayTitle(entry),
      total,
      start,
      end,
      nextBefore: start > 0 ? start : null,
      items: page.map((item, index) => {
        const source = pageSources[index];
        const itemProvider = source?.provider ?? provider;
        const itemThreadId = source?.threadId ?? selectedThreadId;
        return {
          id: String(item.id ?? ""),
          prompt: displayUserPrompt(item.prompt),
          promptAnnotations: (Array.isArray(item.promptAnnotations) ? item.promptAnnotations : [])
            .slice(0, 20)
            .map((annotation) => ({
              text: String(annotation?.text ?? ""),
              annotation: String(annotation?.annotation ?? ""),
            })),
          promptRequest: String(item.promptRequest ?? ""),
          answer: String(item.answer ?? "").slice(0, maxAnswerChars),
          status: String(item.status ?? ""),
          active: item.active === true,
          completed: item.completed === true,
          startedAt: item.startedAt ?? null,
          completedAt: item.completedAt ?? null,
          activities: Array.isArray(item.activities) ? item.activities : [],
          ...(Array.isArray(item.activityGroups) && item.activityGroups.length
            ? { activityGroups: item.activityGroups }
            : {}),
          messages: (() => {
            const sourceMessages = Array.isArray(item.messages) ? item.messages : [];
            const rootUserIndex = sourceMessages.findIndex((message) => (
              String(message?.role ?? "") === "user"
            ));
            return sourceMessages.flatMap((message, messageIndex) => {
              const role = String(message?.role ?? "");
              const receipt = role === "user"
                ? (message.clientUserMessageId
                  ? receipts.forMessage?.({
                    provider: itemProvider,
                    threadId: itemThreadId,
                    clientUserMessageId: message.clientUserMessageId,
                  })
                  : null)
                  ?? (messageIndex === rootUserIndex ? receipts.forTurn?.({
                    provider: itemProvider,
                    threadId: itemThreadId,
                    turnId: item.id,
                  }) : null)
                : null;
              const clientUserMessageId = String(
                message.clientUserMessageId
                  ?? (messageIndex === rootUserIndex ? receipt?.clientUserMessageId : "")
                  ?? "",
              ).trim();
              const attachments = (message.attachments
                ?? (role === "user" ? receipt?.result?.attachments ?? item.attachments ?? [] : []))
                .map((attachment) => ({ ...attachment }));
              const sourceText = String(message?.text ?? "");
              const text = role === "user" ? displayUserPrompt(sourceText) : sourceText;
              if (!["user", "agent"].includes(role) || (!text && !attachments.length)) return [];
              const visibleText = text || (attachments.some((attachment) => (
                String(attachment?.type ?? "").toLowerCase().startsWith("image/")
              )) ? "Изображение" : "Вложение");
              return [{
                itemId: String(message.itemId ?? ""),
                ...(clientUserMessageId ? { clientUserMessageId } : {}),
                role,
                text: role === "agent" ? visibleText.slice(0, maxAnswerChars) : visibleText,
                ...(String(message?.author ?? "").trim()
                  ? { author: String(message.author).trim() }
                  : {}),
                ...(role === "user" && Array.isArray(message.responseAnnotations)
                  ? {
                    responseAnnotations: message.responseAnnotations.slice(0, 20).map((annotation) => ({
                      text: String(annotation?.text ?? ""),
                      annotation: String(annotation?.annotation ?? ""),
                    })),
                    responseAnnotationRequest: String(message.responseAnnotationRequest ?? ""),
                  }
                  : {}),
                ...(message.phase ? { phase: String(message.phase) } : {}),
                time: message.time
                  ?? (role === "user" ? item.startedAt : item.completedAt)
                  ?? receipt?.createdAt
                  ?? null,
                attachments,
              }];
            });
          })(),
        };
      }),
    };
    const fitted = responseBudget.fit(payload, {
      maxBytes: Math.min(
        Math.max(Number(params.maxResponseBytes) || 3_500_000, 64 * 1_024),
        3_500_000,
      ),
    });
    const version = createHash("sha256")
      .update(JSON.stringify(fitted))
      .digest("base64url")
      .slice(0, 22);
    if (params.knownVersion && String(params.knownVersion) === version) {
      return {
        ...(binding.streamId ? { streamId: binding.streamId } : {}),
        provider,
        threadId: selectedThreadId,
        notModified: true,
        version,
      };
    }
    return { ...fitted, version };
  };
}
