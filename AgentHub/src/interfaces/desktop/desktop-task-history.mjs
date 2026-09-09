import { createHash } from "node:crypto";
import {
  displayUserPrompt,
  EMPTY_TURN_COMPLETION_TEXT,
  exactTurnReceiptBindings,
  isEmptyTurnCompletionPlaceholder,
  userTaskReferencePromptDetails,
  withoutCodexInspectionAttachments,
  withoutMisclassifiedSubagentUsers,
} from "../../application/task-history.mjs";
import { normalizedResponseAnnotations } from "../../domain/response-annotation-source.mjs";
import {
  canonicalizeUserMessages,
  mergedUserMessageSnapshotAuthority,
  mergeCanonicalUserMessages,
  userMessageSnapshotAuthority,
} from "../../domain/canonical-user-messages.mjs";
import {
  CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX,
  isCodexContextProbeTurn,
} from "../../domain/codex-context-probe.mjs";
import {
  CODEX_AUTO_COMPACTION_TURN_ID_PREFIX,
  isCodexAutoCompactionTurnId,
} from "../../domain/codex-internal-turn.mjs";
import {
  consistentInterstreamRecordIdentity,
  interstreamOriginAuthor,
  normalizeInterstreamClientUserMessageId,
  normalizeInterstreamOrigin,
  sameAuditedInterstreamOrigin,
  trustedAuditedInterstreamBodyDetails,
  trustedInterstreamMessageDetails,
} from "../../domain/interstream-message.mjs";
import { taskDisplayTitle } from "../../domain/task-display-title.mjs";
import { taskRunIsActive } from "../../domain/task-runs.mjs";
import { withDurableMessageMetadata } from "../../domain/stream-message-pin.mjs";

const MAX_CACHED_HISTORIES = 12;
const MAX_CACHED_TURNS_PER_HISTORY = 40;

function coalesceInterstreamRootAlias(messages, turn) {
  const values = Array.isArray(messages) ? messages : [];
  const turnOrigin = normalizeInterstreamOrigin(turn?.promptOrigin);
  const requestId = String(turnOrigin?.requestId ?? "").trim();
  const clientUserMessageId = requestId ? `mcp:${requestId}` : "";
  const promptInterstream = trustedInterstreamMessageDetails(turn?.prompt, {
    origin: turnOrigin,
    clientUserMessageId,
  });
  if (!requestId || !promptInterstream) return values;

  const canonical = values.flatMap((message, index) => {
    const origin = normalizeInterstreamOrigin(message?.origin ?? message?.messageOrigin);
    const messageClientUserMessageId = String(message?.clientUserMessageId ?? "").trim();
    return message?.role === "user"
      && sameAuditedInterstreamOrigin(origin, turnOrigin)
      && messageClientUserMessageId === clientUserMessageId
      ? [{ index, message }]
      : [];
  });
  if (canonical.length !== 1) return values;

  const aliases = values.flatMap((message, index) => {
    if (
      message?.role !== "user"
      || index === canonical[0].index
      || String(message?.clientUserMessageId ?? "").trim()
      || normalizeInterstreamOrigin(message?.origin ?? message?.messageOrigin)
    ) return [];
    const interstream = trustedInterstreamMessageDetails(message?.text, {
      origin: turnOrigin,
      clientUserMessageId,
    });
    return interstream ? [{ index, message }] : [];
  });
  if (aliases.length !== 1) return values;

  const alias = aliases[0];
  const official = canonical[0];
  const merged = {
    ...structuredClone(alias.message),
    ...structuredClone(official.message),
    itemId: String(alias.message?.itemId ?? official.message?.itemId ?? ""),
    clientUserMessageId,
    origin: turnOrigin,
  };
  const first = Math.min(alias.index, official.index);
  const second = Math.max(alias.index, official.index);
  values[first] = merged;
  values.splice(second, 1);
  return values;
}

function historyItemTimestamp(item) {
  const startedAt = Date.parse(String(item?.startedAt ?? ""));
  if (Number.isFinite(startedAt)) return startedAt;
  const values = [
    item?.time,
    ...(Array.isArray(item?.messages) ? item.messages.map((message) => message?.time) : []),
    item?.completedAt,
    item?.createdAt,
    item?.updatedAt,
  ].map((value) => Date.parse(String(value ?? ""))).filter(Number.isFinite);
  return values.length ? Math.min(...values) : Number.NaN;
}

function sortTaskHistoryChronologically(history) {
  const values = history
    .map((item, index) => ({ item, index, time: historyItemTimestamp(item) }));
  const anchors = values.filter(({ time }) => Number.isFinite(time));
  for (const value of values) {
    if (Number.isFinite(value.time)) continue;
    const previous = anchors.findLast((anchor) => anchor.index < value.index);
    const next = anchors.find((anchor) => anchor.index > value.index);
    value.time = next?.time ?? previous?.time ?? Number.NaN;
  }
  return values
    .sort((left, right) => {
      if (Number.isFinite(left.time) && Number.isFinite(right.time) && left.time !== right.time) {
        return left.time - right.time;
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export function visibleTaskHistoryMessageCount(history) {
  return (Array.isArray(history) ? history : []).reduce((total, item) => {
    const sourceMessages = Array.isArray(item?.messages) ? item.messages : [];
    const messages = sourceMessages.filter((message) => {
      const role = String(message?.role ?? "");
      if (!["user", "agent"].includes(role)) return false;
      const text = role === "user"
        ? displayUserPrompt(message?.text)
        : String(message?.text ?? "");
      const messageAttachments = Array.isArray(message?.attachments) ? message.attachments : [];
      const attachments = messageAttachments.length
        ? messageAttachments
        : (role === "user" && Array.isArray(item?.attachments) ? item.attachments : []);
      return Boolean(text || attachments.length);
    });
    const parentAgents = messages.filter((message) => (
      message?.role === "agent" && message?.kind !== "subagent"
    ));
    const agentResponseVisible = item?.completed === true || item?.active !== true;
    const visibleAgent = agentResponseVisible
      ? parentAgents.findLast((message) => ["final", "final_answer", "finalAnswer"].includes(message?.phase))
        ?? parentAgents.at(-1)
      : null;
    let count = messages.filter((message) => (
      message?.role === "user"
      || message?.kind === "subagent"
      || message === visibleAgent
    )).length;
    if (!messages.some((message) => message?.role === "user") && displayUserPrompt(item?.prompt)) count += 1;
    if (!visibleAgent && agentResponseVisible && String(item?.answer ?? "").trim()) count += 1;
    return total + count;
  }, 0);
}

function exactTerminalAgentCandidate(message, turnId, canonicalItemId) {
  if (message?.role !== "agent" || message?.kind === "subagent") return false;
  if (String(message?.agentThreadId ?? "").trim()) return false;
  const itemId = String(message?.itemId ?? "").trim();
  if (!itemId) return false;
  const exactSyntheticIds = [
    `${turnId}:agent:live`,
    `${turnId}:agent:final`,
    `${turnId}:rollout-agent:live`,
    `${turnId}:rollout-agent:final`,
  ];
  if (exactSyntheticIds.includes(itemId)) return true;
  if (canonicalItemId !== `${turnId}:agent:final`
    && canonicalItemId !== `${turnId}:rollout-agent:final`) return false;
  return ["final", "final_answer"].includes(String(message?.phase ?? ""))
    && Array.isArray(message.responseAnnotationReferences)
    && message.responseAnnotationReferences.length > 0;
}

// Builds the bounded Desktop/Mini App history read-model for one task.
function mergeDurableMessages(hydratedMessages, durableMessages, turnId, hydratedTurn, durableTurn) {
  const durableValues = withoutMisclassifiedSubagentUsers(durableMessages, hydratedMessages);
  const hydratedValues = withoutMisclassifiedSubagentUsers(hydratedMessages, durableMessages);
  const hydratedUsers = canonicalizeUserMessages(
    hydratedValues.filter((message) => message?.role === "user"),
  );
  const durableUsers = canonicalizeUserMessages(
    durableValues.filter((message) => message?.role === "user"),
  );
  const users = durableTurn?.userMessageAuthority === "terminal-ledger"
    ? durableUsers.map((message) => structuredClone(message))
    : mergeCanonicalUserMessages(
      durableUsers,
      hydratedUsers,
      {
        currentSnapshotAuthority: userMessageSnapshotAuthority(durableTurn),
        snapshotAuthority: userMessageSnapshotAuthority(hydratedTurn),
      },
    );
  const values = structuredClone(hydratedValues.filter((message) => message?.role !== "user"));
  for (const durable of durableValues.filter((message) => message?.role !== "user")) {
    const itemId = String(durable?.itemId ?? "").trim();
    let index = values.findIndex((message) => (
      itemId && String(message?.itemId ?? "").trim() === itemId
    ));
    if (index < 0 && durable?.role === "agent") {
      const exactSyntheticFinalId = [
        `${turnId}:agent:live`,
        `${turnId}:agent:final`,
        `${turnId}:rollout-agent:live`,
        `${turnId}:rollout-agent:final`,
      ].includes(itemId);
      if (exactSyntheticFinalId) {
        const candidates = values.map((message, candidateIndex) => ({ message, candidateIndex }))
          .filter(({ message }) => exactTerminalAgentCandidate(message, turnId, itemId));
        if (candidates.length === 1) index = candidates[0].candidateIndex;
      }
    }
    if (index < 0) {
      values.push(structuredClone(durable));
      continue;
    }
    const current = values[index];
    const author = String(durable?.author ?? "").trim()
      || String(current?.author ?? "").trim();
    const responseAnnotationReferences = Array.isArray(durable?.responseAnnotationReferences)
      && durable.responseAnnotationReferences.length
      ? durable.responseAnnotationReferences
      : current.responseAnnotationReferences;
    values[index] = {
      ...current,
      ...structuredClone(durable),
      ...(author ? { author } : {}),
      ...(Array.isArray(responseAnnotationReferences) && responseAnnotationReferences.length
        ? { responseAnnotationReferences: structuredClone(responseAnnotationReferences) }
        : {}),
      time: current.time ?? durable?.time ?? null,
      attachments: Array.isArray(durable?.attachments) && durable.attachments.length
        ? structuredClone(durable.attachments)
        : current.attachments,
      attachmentSources: Array.isArray(durable?.attachmentSources) && durable.attachmentSources.length
        ? structuredClone(durable.attachmentSources)
        : current.attachmentSources,
    };
  }
  return [...users, ...values];
}

export function mergeDurableTaskHistory(hydratedHistory, durableHistory) {
  const values = structuredClone(Array.isArray(hydratedHistory) ? hydratedHistory : [])
    .map((item) => ({
      ...item,
      messages: [
        ...canonicalizeUserMessages(
          (Array.isArray(item?.messages) ? item.messages : [])
            .filter((message) => message?.role === "user"),
          { turnId: item?.id },
        ),
        ...(Array.isArray(item?.messages) ? item.messages : [])
          .filter((message) => message?.role !== "user")
          .map((message) => structuredClone(message)),
      ],
    }));
  for (const durable of Array.isArray(durableHistory) ? durableHistory : []) {
    const id = String(durable?.id ?? "").trim();
    const index = id
      ? values.findIndex((item) => String(item?.id ?? "").trim() === id)
      : -1;
    if (index < 0) {
      const item = structuredClone(durable);
      item.messages = [
        ...canonicalizeUserMessages(
          (Array.isArray(item?.messages) ? item.messages : [])
            .filter((message) => message?.role === "user"),
          { turnId: item?.id },
        ),
        ...(Array.isArray(item?.messages) ? item.messages : [])
          .filter((message) => message?.role !== "user")
          .map((message) => structuredClone(message)),
      ];
      values.push(item);
      continue;
    }
    const current = values[index];
    const merged = {
      ...current,
      ...structuredClone(durable),
      startedAt: current.startedAt ?? durable?.startedAt ?? null,
      completedAt: current.completedAt ?? durable?.completedAt ?? null,
      activities: Array.isArray(durable?.activities) && durable.activities.length
        ? structuredClone(durable.activities)
        : current.activities,
      activityGroups: Array.isArray(durable?.activityGroups) && durable.activityGroups.length
        ? structuredClone(durable.activityGroups)
        : current.activityGroups,
    };
    merged.messages = mergeDurableMessages(
      current.messages,
      durable?.messages,
      id,
      current,
      durable,
    );
    merged.userMessageSnapshotAuthority = mergedUserMessageSnapshotAuthority(
      (Array.isArray(durable?.messages) ? durable.messages : [])
        .filter((message) => message?.role === "user"),
      durable,
      current,
    );
    values[index] = merged;
  }
  return sortTaskHistoryChronologically(values);
}

export function mergeCachedTaskHistory(cachedHistory, durableHistory) {
  const cachedById = new Map((Array.isArray(cachedHistory) ? cachedHistory : [])
    .map((item) => [String(item?.id ?? "").trim(), item])
    .filter(([id]) => Boolean(id)));
  if (!cachedById.size) {
    return sortTaskHistoryChronologically(structuredClone(
      Array.isArray(durableHistory) ? durableHistory : [],
    ));
  }

  const values = [];
  for (const durable of Array.isArray(durableHistory) ? durableHistory : []) {
    const id = String(durable?.id ?? "").trim();
    const cached = id ? cachedById.get(id) : null;
    values.push(cached
      ? mergeDurableTaskHistory([cached], [durable])[0]
      : durable);
  }
  const valueIds = new Set(values.map((item) => String(item?.id ?? "").trim()).filter(Boolean));
  const cachedValues = Array.isArray(cachedHistory) ? cachedHistory : [];
  for (const [cachedIndex, cached] of cachedValues.entries()) {
    const id = String(cached?.id ?? "").trim();
    if (id && valueIds.has(id)) continue;
    const nextId = cachedValues.slice(cachedIndex + 1)
      .map((item) => String(item?.id ?? "").trim())
      .find((candidate) => candidate && valueIds.has(candidate));
    const previousId = cachedValues.slice(0, cachedIndex).reverse()
      .map((item) => String(item?.id ?? "").trim())
      .find((candidate) => candidate && valueIds.has(candidate));
    const nextIndex = nextId
      ? values.findIndex((item) => String(item?.id ?? "").trim() === nextId)
      : -1;
    const previousIndex = previousId
      ? values.findIndex((item) => String(item?.id ?? "").trim() === previousId)
      : -1;
    values.splice(nextIndex >= 0 ? nextIndex : previousIndex + 1, 0, structuredClone(cached));
    if (id) valueIds.add(id);
  }
  return sortTaskHistoryChronologically(values);
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
  interstreamOriginForClientMessage = () => null,
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
            visibleProviderHistory(binding.provider, refreshed.history)
              .slice(-MAX_CACHED_TURNS_PER_HISTORY),
            { replace: true },
          );
        }
        return true;
      })
      .catch((error) => {
        warn(`Cannot refresh ${binding.provider} history ${binding.threadId}: ${error?.message ?? error}`);
        return false;
      })
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
      throw new Error("Укажите корректный поток");
    }
    const limit = Math.max(1, Math.min(Number(params.limit) || 10, 20));

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
    if (!entry) throw new Error("Поток не найден в локальном каталоге");

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
    let sourceRefreshFailed = false;
    const currentThreadBinding = threadBindings.find((threadBinding) => (
      threadBinding.provider === binding.provider && threadBinding.threadId === binding.threadId
    )) ?? binding;
    if (params.refreshSource === true) {
      sourceRefreshFailed = await scheduleRefresh(currentThreadBinding, { force: true }) === false;
    }
    const pagedHistory = typeof historyReader.readPage === "function"
      ? await historyReader.readPage(threadBindings, {
        before: params.before,
        limit,
        hiddenProvider: "codex",
        hiddenTurnIdPrefixes: [CODEX_AUTO_COMPACTION_TURN_ID_PREFIX],
        hiddenClientUserMessageIdPrefixes: [CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX],
        emptyCompletionText: EMPTY_TURN_COMPLETION_TEXT,
      })
      : null;
    if (pagedHistory) {
      const cachedByKey = new Map();
      for (const threadBinding of threadBindings) {
        const key = `${threadBinding.provider}:${threadBinding.threadId}`;
        cachedByKey.set(key, {
          provider: readCachedHistory(providerHistories, key),
          hydrated: readCachedHistory(hydratedHistories, key),
        });
      }
      for (const source of pagedHistory.items) {
        const key = `${source.provider}:${source.threadId}`;
        const cached = cachedByKey.get(key) ?? { provider: [], hydrated: [] };
        const id = String(source.turn?.id ?? "").trim();
        let item = mergeCachedTaskHistory(
          cached.provider.filter((turn) => String(turn?.id ?? "").trim() === id),
          [source.turn],
        )[0];
        item = mergeCachedTaskHistory(
          cached.hydrated.filter((turn) => String(turn?.id ?? "").trim() === id),
          [item],
        )[0];
        if (!visibleProviderHistory(source.provider, [item]).length) continue;
        history.push(item);
        historySources.set(item, { key, provider: source.provider, threadId: source.threadId });
      }
      scheduleRefresh(currentThreadBinding);
    } else for (const threadBinding of threadBindings) {
      const key = `${threadBinding.provider}:${threadBinding.threadId}`;
      const currentThread = threadBinding.provider === binding.provider
        && threadBinding.threadId === binding.threadId;
      // Pagination is calculated after durable/provider/active histories are
      // merged. Limiting the durable source here makes its page look like the
      // complete history and loses the cursor for older turns.
      const cached = await historyReader.read(threadBinding);
      let threadHistory = mergeCachedTaskHistory(
        readCachedHistory(providerHistories, key),
        cached.history,
      );
      threadHistory = mergeCachedTaskHistory(
        readCachedHistory(hydratedHistories, key),
        threadHistory,
      );
      threadHistory = visibleProviderHistory(threadBinding.provider, threadHistory);
      if (currentThread) scheduleRefresh(threadBinding);
      for (const item of threadHistory) {
        history.push(item);
        historySources.set(item, {
          key,
          provider: threadBinding.provider,
          threadId: threadBinding.threadId,
        });
      }
    }
    const pagedBaseLength = history.length;
    const pagedBaseMessageCount = visibleTaskHistoryMessageCount(history);
    const pagedBaseIds = new Set(history.map((item) => String(item?.id ?? "").trim()));
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
        ...(running.userMessageSnapshotAuthority
          ? { userMessageSnapshotAuthority: running.userMessageSnapshotAuthority }
          : {}),
        responseItemId: running.responseItemId,
        ...(Array.isArray(running.responseAnnotationReferences)
          && running.responseAnnotationReferences.length
          ? { responseAnnotationReferences: running.responseAnnotationReferences }
          : {}),
        activities: running.activities,
        ...(Array.isArray(running.activityGroups) && running.activityGroups.length
          ? { activityGroups: running.activityGroups }
          : {}),
        startedAt: running.startedAt,
        attachments: running.messageAttachments ?? [],
      });
    }
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
    const unrelatedUserTurnVisible = history.some((item) => (
      item?.active === true
      && String(item?.id ?? "").trim() !== completedTurnId
      && (
        String(item?.prompt ?? "").trim()
        || (Array.isArray(item?.messages) && item.messages.some((message) => (
          message?.role === "user" && String(message?.text ?? "").trim()
        )))
      )
    ));
    if (completed?.turnId && completed?.text && !(
      binding.provider === "codex" && isCodexContextProbeTurn({
        turnId: completed.turnId,
        finalAnswer: completed.text,
        operationKind: completed.operationKind,
        contextProbe: completed.contextProbe,
        clientUserMessageId: completed.clientUserMessageId,
      })
    ) && !(
      binding.provider === "codex" && isEmptyTurnCompletionPlaceholder({
        answer: completed.text,
      })
    ) && (matchingTurnVisible || !unrelatedActiveTurnVisible || unrelatedUserTurnVisible)) {
      historyMerger.mergeCompleted(history, {
        turnId: completed.turnId,
        answer: completed.text,
        completedAt: completed.updatedAt,
        terminalRevision: completed.terminalRevision,
      }, {
        matchSingleActive: !unrelatedActiveTurnVisible,
      });
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

    let orderedHistory = sortTaskHistoryChronologically(history);
    const pagedLengthDelta = pagedHistory ? orderedHistory.length - pagedBaseLength : 0;
    const total = pagedHistory
      ? pagedHistory.total + pagedLengthDelta
      : orderedHistory.length;
    const messageTotal = pagedHistory
      ? pagedHistory.messageTotal
        + visibleTaskHistoryMessageCount(orderedHistory) - pagedBaseMessageCount
      : visibleTaskHistoryMessageCount(orderedHistory);
    const requestedEnd = Number(params.before);
    const end = Number.isSafeInteger(requestedEnd)
      ? Math.max(0, Math.min(requestedEnd, total))
      : total;
    const maxAnswerChars = Math.max(
      1_000,
      Math.min(Number(params.maxAnswerChars) || 200_000, 200_000),
    );
    let start = Math.max(0, end - limit);
    let rawPage;
    if (pagedHistory && Number.isSafeInteger(requestedEnd)) {
      orderedHistory = orderedHistory.filter((item) => pagedBaseIds.has(String(item?.id ?? "").trim()));
      start = pagedHistory.start;
      rawPage = orderedHistory;
    } else if (pagedHistory) {
      rawPage = orderedHistory.slice(-limit);
      start = Math.max(0, total - rawPage.length);
    } else {
      rawPage = orderedHistory.slice(start, end);
    }
    const pageSources = rawPage.map((item) => historySources.get(item));
    const page = await hydrateHistory(rawPage);
    for (let index = 0; index < page.length; index += 1) {
      const source = pageSources[index];
      if (source?.key) cacheHistory(hydratedHistories, source.key, [page[index]]);
    }
    const payload = {
      ...(binding.streamId ? { streamId: binding.streamId } : {}),
      // A Stream reference is authoritative.  The caller may still carry the
      // provider/thread pair that was current before a rebirth, so expose the
      // catalog's resolved current binding at the response envelope.
      provider: binding.provider,
      threadId: binding.threadId,
      title: taskDisplayTitle(entry),
      total,
      messageTotal,
      ...(sourceRefreshFailed ? { sourceFresh: false } : {}),
      start,
      end,
      nextBefore: start > 0 ? start : null,
      items: page.map((item, index) => {
        const source = pageSources[index];
        const itemProvider = source?.provider ?? provider;
        const itemThreadId = source?.threadId ?? selectedThreadId;
        const auditedOrigins = new Map();
        const auditedOriginForClientMessage = (clientUserMessageId) => {
          const clientId = String(clientUserMessageId ?? "").trim();
          if (!clientId) return null;
          if (!auditedOrigins.has(clientId)) {
            auditedOrigins.set(clientId, interstreamOriginForClientMessage(clientId));
          }
          return auditedOrigins.get(clientId);
        };
        const promptClientIds = [...new Set((Array.isArray(item.messages) ? item.messages : [])
          .flatMap((message) => {
            const clientUserMessageId = String(message?.clientUserMessageId ?? "").trim();
            return String(message?.role ?? "") === "user" && clientUserMessageId
              ? [clientUserMessageId]
              : [];
          }))];
        const durablePromptOrigin = normalizeInterstreamOrigin(item.promptOrigin);
        const durablePromptClientUserMessageId = durablePromptOrigin?.requestId
          && promptClientIds.includes(`mcp:${durablePromptOrigin.requestId}`)
          ? `mcp:${durablePromptOrigin.requestId}`
          : "";
        const auditedPromptIdentities = durablePromptOrigin ? [] : promptClientIds.flatMap(
          (clientUserMessageId) => {
            const origin = auditedOriginForClientMessage(clientUserMessageId);
            const details = origin && (trustedInterstreamMessageDetails(item.prompt, {
              origin,
              clientUserMessageId,
              audited: true,
            }) ?? trustedAuditedInterstreamBodyDetails(item.prompt, {
              origin,
              clientUserMessageId,
            }));
            return details ? [{ clientUserMessageId, origin: details.origin, details }] : [];
          },
        );
        const auditedPromptIdentity = auditedPromptIdentities.length === 1
          ? auditedPromptIdentities[0]
          : null;
        const promptClientUserMessageId = durablePromptClientUserMessageId
          || auditedPromptIdentity?.clientUserMessageId
          || "";
        const promptOrigin = durablePromptOrigin ?? auditedPromptIdentity?.origin ?? null;
        const promptInterstream = auditedPromptIdentity?.details ?? trustedInterstreamMessageDetails(item.prompt, {
          origin: promptOrigin,
          clientUserMessageId: promptClientUserMessageId,
        });
        const promptAuthor = interstreamOriginAuthor(promptOrigin)
          || String(item.promptAuthor ?? "").trim();
        const projectedTurn = {
          id: String(item.id ?? ""),
          // Stream history is an aggregate of sequential provider Threads.
          // Preserve each turn's source identity instead of making consumers
          // infer it from the current response envelope.
          provider: itemProvider,
          threadId: itemThreadId,
          prompt: displayUserPrompt(promptInterstream?.text ?? item.prompt),
          ...(promptAuthor ? { promptAuthor } : {}),
          ...(promptOrigin ? { promptOrigin } : {}),
          promptAnnotations: normalizedResponseAnnotations(item.promptAnnotations),
          promptRequest: String(item.promptRequest ?? ""),
          answer: String(item.answer ?? "").slice(0, maxAnswerChars),
          status: String(item.status ?? ""),
          active: item.active === true,
          completed: item.completed === true,
          terminalRevision: Number(item.terminalRevision) || null,
          operationKind: String(item.operationKind ?? "user-turn"),
          ...(!item.operationKind ? { operationKindMigrationGuard: "legacy-history-user-turn" } : {}),
          startedAt: item.startedAt ?? null,
          completedAt: item.completedAt ?? null,
          activities: Array.isArray(item.activities) ? item.activities : [],
          ...(Array.isArray(item.activityGroups) && item.activityGroups.length
            ? { activityGroups: item.activityGroups }
            : {}),
          messages: (() => {
            const sourceMessages = coalesceInterstreamRootAlias(
              (Array.isArray(item.messages) ? item.messages : []).map((message) => {
                const identity = consistentInterstreamRecordIdentity({
                  clientUserMessageIds: [message?.clientUserMessageId],
                  origins: [message?.origin ?? message?.messageOrigin],
                });
                if (identity.conflicted) {
                  const value = { ...message };
                  delete value.clientUserMessageId;
                  delete value.origin;
                  delete value.messageOrigin;
                  return value;
                }
                const clientUserMessageId = identity.clientUserMessageId ?? "";
                if (identity.messageOrigin) {
                  return {
                    ...message,
                    ...(clientUserMessageId ? { clientUserMessageId } : {}),
                    origin: identity.messageOrigin,
                  };
                }
                const auditedOrigin = auditedOriginForClientMessage(clientUserMessageId);
                const details = auditedOrigin && (trustedInterstreamMessageDetails(message?.text, {
                  origin: auditedOrigin,
                  clientUserMessageId,
                  audited: true,
                }) ?? trustedAuditedInterstreamBodyDetails(message?.text, {
                  origin: auditedOrigin,
                  clientUserMessageId,
                }));
                if (details) return { ...message, origin: details.origin };
                return message;
              }),
              { prompt: item.prompt, promptOrigin },
            );
            const rootUserIndex = sourceMessages.findIndex((message) => (
              String(message?.role ?? "") === "user"
            ));
            const turnReceiptsValue = receipts.forTurn?.({
              provider: itemProvider,
              threadId: itemThreadId,
              turnId: item.id,
            });
            const turnReceipts = Array.isArray(turnReceiptsValue)
              ? turnReceiptsValue
              : turnReceiptsValue ? [turnReceiptsValue] : [];
            const turnReceiptBindings = exactTurnReceiptBindings(sourceMessages, turnReceipts);
            return sourceMessages.flatMap((message, messageIndex) => {
              const role = String(message?.role ?? "");
              const turnReceipt = turnReceiptBindings.get(messageIndex) ?? null;
              const receipt = role === "user"
                ? (message.clientUserMessageId
                  ? receipts.forMessage?.({
                    provider: itemProvider,
                    threadId: itemThreadId,
                    clientUserMessageId: message.clientUserMessageId,
                  })
                  : null)
                  ?? turnReceipt
                : null;
              const clientUserMessageId = String(
                message.clientUserMessageId
                  ?? receipt?.clientUserMessageId
                  ?? "",
              ).trim();
              const identityClientUserMessageId = normalizeInterstreamClientUserMessageId(
                message.clientUserMessageId,
              ) ?? "";
              const messageAttachments = Array.isArray(message.attachments)
                ? message.attachments
                : [];
              const receiptAttachments = role === "user" && Array.isArray(receipt?.result?.attachments)
                ? receipt.result.attachments
                : [];
              const itemAttachments = role === "user"
                && messageIndex === rootUserIndex
                && Array.isArray(item.attachments)
                ? item.attachments
                : [];
              const sourceText = String(message?.text ?? "");
              const promptTaskReferences = role === "user"
                ? userTaskReferencePromptDetails(sourceText)?.references ?? []
                : [];
              const attachments = (messageAttachments.length
                ? messageAttachments
                : receiptAttachments.length
                  ? receiptAttachments
                  : itemAttachments.length
                    ? itemAttachments
                    : promptTaskReferences)
                .map((attachment) => ({ ...attachment }));
              const durableOrigin = role === "user"
                ? normalizeInterstreamOrigin(message?.origin ?? message?.messageOrigin)
                : null;
              const auditedOrigin = role === "user" && identityClientUserMessageId
                ? auditedOriginForClientMessage(identityClientUserMessageId)
                : null;
              const identityOrigin = role === "user" ? durableOrigin ?? auditedOrigin : null;
              const interstream = role === "user" ? trustedInterstreamMessageDetails(sourceText, {
                origin: identityOrigin,
                clientUserMessageId: identityClientUserMessageId,
                audited: !durableOrigin && Boolean(auditedOrigin),
              }) ?? (!durableOrigin && auditedOrigin
                ? trustedAuditedInterstreamBodyDetails(sourceText, {
                  origin: auditedOrigin,
                  clientUserMessageId: identityClientUserMessageId,
                })
                : null) : null;
              const origin = interstream?.origin ?? durableOrigin;
              const author = interstreamOriginAuthor(origin) || String(message?.author ?? "").trim();
              const messageKind = origin
                ? "interstream"
                : String(message?.kind ?? "").trim();
              const text = role === "user"
                ? displayUserPrompt(interstream?.text ?? sourceText)
                : sourceText;
              const responseAnnotations = role === "user" && Array.isArray(
                receipt?.result?.responseAnnotations ?? message.responseAnnotations,
              )
                ? (receipt?.result?.responseAnnotations ?? message.responseAnnotations)
                : [];
              if (!["user", "agent"].includes(role) || (!text && !attachments.length)) return [];
              const taskReferencesOnly = attachments.length > 0
                && attachments.every((attachment) => attachment?.kind === "task");
              const visibleText = text || (taskReferencesOnly
                ? ""
                : attachments.some((attachment) => (
                  String(attachment?.type ?? "").toLowerCase().startsWith("image/")
                )) ? "Изображение" : "Вложение");
              const rootSubmittedAt = role === "user" && messageIndex === rootUserIndex
                ? message.submittedAt ?? receipt?.createdAt ?? message.time ?? item.submittedAt ?? item.startedAt ?? null
                : null;
              const rootStartedAt = role === "user" && messageIndex === rootUserIndex
                ? message.startedAt ?? item.startedAt ?? null
                : null;
              return [{
                itemId: String(message.itemId ?? ""),
                ...(clientUserMessageId ? { clientUserMessageId } : {}),
                ...(String(message.sourceOccurrenceId ?? "").trim()
                  ? { sourceOccurrenceId: String(message.sourceOccurrenceId).trim() }
                  : {}),
                role,
                text: role === "agent" ? visibleText.slice(0, maxAnswerChars) : visibleText,
                ...(author ? { author } : {}),
                ...(messageKind ? { kind: messageKind } : {}),
                ...(origin ? { origin } : {}),
                ...(String(message?.agentThreadId ?? "").trim()
                  ? { agentThreadId: String(message.agentThreadId).trim() }
                  : {}),
                ...(String(message?.model ?? "").trim()
                  ? { model: String(message.model).trim() }
                  : {}),
                ...(role === "user" && responseAnnotations.length
                  ? {
                    responseAnnotations: normalizedResponseAnnotations(responseAnnotations),
                    responseAnnotationRequest: displayUserPrompt(
                      receipt?.result?.responseAnnotationRequest ?? message.responseAnnotationRequest,
                    ),
                  }
                  : {}),
                ...(role === "agent" && Array.isArray(message.responseAnnotationReferences)
                  && message.responseAnnotationReferences.length
                  ? {
                    responseAnnotationReferences: message.responseAnnotationReferences.map(
                      (reference) => ({ index: Number(reference?.index) }),
                    ).filter((reference) => Number.isSafeInteger(reference.index) && reference.index > 0),
                  }
                  : {}),
                ...(message.phase ? { phase: String(message.phase) } : {}),
                ...(rootSubmittedAt
                  ? { submittedAt: rootSubmittedAt }
                  : {}),
                ...(rootStartedAt
                  ? { startedAt: rootStartedAt }
                  : {}),
                time: role === "user" && messageIndex === rootUserIndex
                  ? rootSubmittedAt
                  : message.time
                    ?? (role === "user" ? item.startedAt : item.completedAt)
                    ?? receipt?.createdAt
                    ?? null,
                attachments,
              }];
            });
          })(),
        };
        return withDurableMessageMetadata(projectedTurn, {
          provider: itemProvider,
          threadId: itemThreadId,
        });
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
        provider: binding.provider,
        threadId: binding.threadId,
        notModified: true,
        version,
      };
    }
    return { ...fitted, version };
  };
}
