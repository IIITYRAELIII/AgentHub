import {
  codexThreadHistory,
  codexSubagentAuthor,
  displayUserPrompt,
  mergeActiveTaskHistory,
  responseAnnotationDetails,
  visibleTaskHistory,
  withoutCodexInspectionAttachments,
  withoutMisclassifiedSubagentUsers,
} from "../../application/task-history.mjs";
import { taskViewCallbackData } from "./task-view-callback.mjs";
import {
  hasCanonicalUserMessages,
  mergedUserMessageSnapshotAuthority,
  mergeCanonicalUserMessages,
  userMessageSnapshotAuthority,
} from "../../domain/canonical-user-messages.mjs";
import { isCodexAutoCompactionTurnId } from "../../domain/codex-internal-turn.mjs";
import { interstreamDisplayText, interstreamOriginAuthor, normalizeInterstreamOrigin } from "../../domain/interstream-message.mjs";
import { taskDisplayTitle } from "../../domain/task-display-title.mjs";
import { taskRunIsActive, updateTaskRunTitle } from "../../domain/task-runs.mjs";

const RENAMED_TURN_WINDOW_MS = 5 * 60 * 1000;

function turnStartedAtMs(item) {
  const value = Date.parse(String(item?.startedAt ?? ""));
  return Number.isFinite(value) ? value : null;
}

/* Управляемый ход Claude живёт под внутренним UUID Hub, а тот же ход из
   транскрипта приходит под собственным UUID записи пользователя. Без сведения
   этих двух имён завершённый ход возвращается второй карточкой и встаёт в конец
   ленты. Совпадением считается тот же текст запроса в близкое время у элемента,
   которого больше нет в источнике. */
function renamedTurnIndex(merged, item, sourceIds, adopted) {
  const prompt = String(item?.prompt ?? "").trim();
  const startedAtMs = turnStartedAtMs(item);
  if (!prompt || startedAtMs == null) return -1;
  return merged.findIndex((candidate, index) => {
    if (adopted.has(index)) return false;
    const id = String(candidate?.id ?? "").trim();
    if (!id || sourceIds.has(id)) return false;
    if (String(candidate?.prompt ?? "").trim() !== prompt) return false;
    const candidateAtMs = turnStartedAtMs(candidate);
    return candidateAtMs != null
      && Math.abs(candidateAtMs - startedAtMs) <= RENAMED_TURN_WINDOW_MS;
  });
}

/* Порядок ленты задаётся положением хода в массиве, поэтому ход, дочитанный из
   источника позже, обязан встать по своему времени, а не в конец. Элемент без
   времени остаётся привязанным к предшественнику. */
function chronologicalTurns(turns) {
  let anchorAtMs = Number.NEGATIVE_INFINITY;
  return turns
    .map((item, index) => {
      const startedAtMs = turnStartedAtMs(item);
      if (startedAtMs != null) anchorAtMs = startedAtMs;
      return { item, index, atMs: startedAtMs ?? anchorAtMs };
    })
    .sort((left, right) => (left.atMs === right.atMs
      ? left.index - right.index
      : left.atMs - right.atMs))
    .map(({ item }) => item);
}

function mergeDurableHistory(cachedHistory, sourceHistory, {
  adoptRenamedTurns = false,
  chronological = false,
  preserveCanonicalUserMessages = false,
} = {}) {
  const merged = (Array.isArray(cachedHistory) ? cachedHistory : [])
    .map((item) => structuredClone(item));
  const positions = new Map(merged.map((item, index) => [String(item?.id ?? ""), index]));
  const source = Array.isArray(sourceHistory) ? sourceHistory : [];
  const sourceIds = new Set(source.map((item) => String(item?.id ?? "")).filter(Boolean));
  const adopted = new Set();
  for (const item of source) {
    const id = String(item?.id ?? "");
    const index = id ? positions.get(id) : undefined;
    if (index !== undefined) {
      merged[index] = preserveCanonicalUserMessages
        ? mergeObservedTurn(merged[index], item)
        : structuredClone(item);
      continue;
    }
    const renamed = adoptRenamedTurns
      ? renamedTurnIndex(merged, item, sourceIds, adopted)
      : -1;
    if (renamed >= 0) {
      merged[renamed] = mergeObservedTurn(merged[renamed], item);
      adopted.add(renamed);
      if (id) positions.set(id, renamed);
      continue;
    }
    if (id) positions.set(id, merged.length);
    merged.push(structuredClone(item));
  }
  return chronological ? chronologicalTurns(merged) : merged;
}

function mergeAttachmentSources(currentMessages, rolloutMessages) {
  const messages = Array.isArray(currentMessages)
    ? currentMessages.map((message) => structuredClone(message))
    : [];
  let changed = false;
  for (const rolloutMessage of Array.isArray(rolloutMessages) ? rolloutMessages : []) {
    const sources = (Array.isArray(rolloutMessage?.attachmentSources)
      ? rolloutMessage.attachmentSources
      : []).filter((source) => ["generated-path", "display-path"].includes(source?.type));
    if (rolloutMessage?.role !== "agent" || !sources.length) continue;
    let targetIndex = messages.findIndex((message) => (
      message?.role === "agent"
      && String(message?.text ?? "").trim() === String(rolloutMessage.text ?? "").trim()
    ));
    if (targetIndex < 0) targetIndex = messages.findLastIndex((message) => message?.role === "agent");
    if (targetIndex < 0) {
      messages.push(structuredClone(rolloutMessage));
      changed = true;
      continue;
    }
    const target = messages[targetIndex];
    const mergedSources = (Array.isArray(target.attachmentSources)
      ? target.attachmentSources
      : []).filter((source) => ["generated-path", "display-path"].includes(source?.type))
      .map((source) => ({ ...source }));
    const known = new Set(mergedSources.map((source) => `${source.type}:${source.value}`));
    for (const source of sources) {
      const key = `${source?.type}:${source?.value}`;
      if (!known.has(key)) {
        mergedSources.push({ ...source });
        known.add(key);
        changed = true;
      }
    }
    if (mergedSources.length) target.attachmentSources = mergedSources;
  }
  return changed ? messages : currentMessages;
}

function mergeMessageAttachments(target, source) {
  const merged = { ...target };
  if (!String(merged.author ?? "").trim() && String(source?.author ?? "").trim()) {
    merged.author = String(source.author).trim();
  }
  for (const field of ["attachments", "attachmentSources"]) {
    const publicItem = field === "attachments"
      ? (item) => !String(item?.id ?? "").startsWith("codex-viewed-")
      : (item) => item?.type !== "view-path";
    const values = (Array.isArray(target?.[field]) ? target[field] : [])
      .filter(publicItem)
      .map((item) => ({ ...item }));
    const keyFor = field === "attachments"
      ? (item) => String(item?.id ?? item?.path ?? item?.name ?? "")
      : (item) => `${item?.type}:${item?.value}`;
    const known = new Set(values.map(keyFor));
    const sourceValues = (Array.isArray(source?.[field]) ? source[field] : []).filter(publicItem);
    for (const item of sourceValues) {
      const key = keyFor(item);
      if (!key || known.has(key)) continue;
      values.push({ ...item });
      known.add(key);
    }
    if (values.length) merged[field] = values;
    else delete merged[field];
  }
  return merged;
}

function retainSubagentReports(currentMessages, observedMessages) {
  const result = observedMessages.map((message) => structuredClone(message));
  for (const report of currentMessages.filter((message) => message.role === "agent" && message.kind === "subagent")) {
    const sourceId = String(report.sourceOccurrenceId ?? "").trim();
    const exists = result.some((message) => message.role === "agent" && message.kind === "subagent"
      && (sourceId ? message.sourceOccurrenceId === sourceId
        : report.itemId && message.itemId === report.itemId && message.agentThreadId === report.agentThreadId));
    if (!exists) result.push(structuredClone(report));
  }
  return result;
}

function mergeObservedTurn(current, observed) {
  const observedMessages = Array.isArray(observed?.messages) ? observed.messages : [];
  const currentMessages = withoutMisclassifiedSubagentUsers(current?.messages, observedMessages);
  const currentUsers = currentMessages.filter((message) => message?.role === "user");
  const observedUsers = observedMessages.filter((message) => message?.role === "user");
  const canonical = hasCanonicalUserMessages(currentUsers);
  const users = mergeCanonicalUserMessages(currentUsers, observedUsers, {
    currentSnapshotAuthority: userMessageSnapshotAuthority(current),
    snapshotAuthority: userMessageSnapshotAuthority(observed),
  });
  const observedNonUsers = observedMessages.filter((message) => message?.role !== "user");
  const currentNonUsers = currentMessages.filter((message) => message?.role !== "user");
  return {
    ...structuredClone(current),
    ...structuredClone(observed),
    userMessageSnapshotAuthority: mergedUserMessageSnapshotAuthority(
      currentUsers,
      current,
      observed,
    ),
    ...(canonical && current?.prompt ? { prompt: current.prompt } : {}),
    messages: [
      ...users,
      ...retainSubagentReports(currentNonUsers, observedNonUsers.length ? observedNonUsers : currentNonUsers),
    ],
  };
}

function mergeAuthoritativeRolloutTurn(current, rollout) {
  const rolloutMessages = Array.isArray(rollout?.messages) ? rollout.messages : [];
  const currentMessages = withoutMisclassifiedSubagentUsers(current?.messages, rolloutMessages);
  const rolloutUsers = rolloutMessages.filter((message) => message?.role === "user");
  const rolloutAgents = rolloutMessages.filter((message) => message?.role === "agent");
  const currentUsers = currentMessages.filter((message) => message?.role === "user");
  const currentAgents = currentMessages.filter((message) => message?.role === "agent");
  const hasActualRolloutUser = rollout.userMessagesObserved === true;
  const users = hasActualRolloutUser
    ? mergeCanonicalUserMessages(currentUsers, rolloutUsers, {
      currentSnapshotAuthority: userMessageSnapshotAuthority(current),
      snapshotAuthority: userMessageSnapshotAuthority(rollout),
    })
    : currentUsers.map((message) => structuredClone(message));
  const agents = rolloutAgents.length
    ? rolloutAgents.map((message, index) => mergeMessageAttachments(
      message,
      currentAgents[index] ?? currentAgents.at(-1),
    ))
    : currentAgents.map((message) => structuredClone(message));
  return {
    ...current,
    userMessageSnapshotAuthority: mergedUserMessageSnapshotAuthority(
      currentUsers,
      current,
      rollout,
    ),
    ...(hasActualRolloutUser && rollout.prompt && !hasCanonicalUserMessages(currentUsers)
      ? { prompt: rollout.prompt }
      : {}),
    ...(rollout.answer ? { answer: rollout.answer } : {}),
    status: rollout.status || current?.status,
    active: Boolean(rollout.active),
    completed: Boolean(rollout.completed),
    messages: [...users, ...retainSubagentReports(currentAgents, agents)],
    ...(rollout.activityGroups?.length
      ? {
        activityGroups: structuredClone(rollout.activityGroups),
        activities: structuredClone(rollout.activities ?? []),
      }
      : {}),
    ...(rollout.promptAnnotations?.length
      ? {
        promptAnnotations: rollout.promptAnnotations.map((annotation) => ({ ...annotation })),
        promptRequest: rollout.promptRequest ?? "",
      }
      : {}),
  };
}

async function materializeHistoryAttachments(history, importer) {
  if (typeof importer !== "function") return;
  await Promise.all((Array.isArray(history) ? history : []).flatMap((turn) => (
    (Array.isArray(turn?.messages) ? turn.messages : []).map(async (message) => {
      const sources = (Array.isArray(message?.attachmentSources) ? message.attachmentSources : [])
        .filter((source) => (
          message?.role !== "agent"
          || ["generated-path", "display-path"].includes(source?.type)
        ));
      if (!sources.length) return;
      const imported = await importer(sources);
      const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
        .filter((attachment) => (
          message?.role !== "agent"
          || !String(attachment?.id ?? "").startsWith("codex-viewed-")
        ))
        .map((attachment) => ({ ...attachment }));
      const known = new Set(attachments.map((attachment) => String(attachment?.id ?? "")));
      for (const attachment of Array.isArray(imported) ? imported : []) {
        const id = String(attachment?.id ?? "");
        if (id && !known.has(id)) {
          attachments.push({ ...attachment });
          known.add(id);
        }
      }
      if (attachments.length) message.attachments = attachments;
      delete message.attachmentSources;
    })
  )));
}

const CODEX_TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CODEX_HISTORY_REFRESH_TAIL_BYTES = 16 * 1024 * 1024;

export function codexRolloutHistory(activity = {}, { userAuthor = "" } = {}) {
  const userMessages = activity?.userMessages ?? {};
  const latestMessages = activity?.latestMessages ?? {};
  const finalMessages = activity?.finalMessages ?? {};
  const generatedImageSources = activity?.generatedImageSources ?? {};
  const activityGroups = activity?.activityGroups ?? {};
  const activeTurnIds = new Set(activity?.activeTurnIds ?? []);
  const ids = [...new Set([
    ...Object.keys(userMessages),
    ...Object.keys(latestMessages),
    ...Object.keys(finalMessages),
    ...Object.keys(generatedImageSources),
    ...Object.keys(activityGroups),
  ])];
  return ids.flatMap((id) => {
    if (isCodexAutoCompactionTurnId(id)) return [];
    const projectedMessages = (Array.isArray(userMessages[id]) ? userMessages[id] : [])
      .filter((message) => String(message?.text ?? "").trim()
        || message?.attachments?.length || message?.attachmentSources?.length)
      .map((message, index) => {
        const rawText = String(message.text ?? "").trim();
        const role = message.role === "agent" && message.kind === "subagent" ? "agent" : "user";
        if (role === "agent") return {
          ...structuredClone(message),
          role,
          author: String(message.author ?? "").trim() || codexSubagentAuthor(message.model),
          text: rawText,
        };
        const origin = normalizeInterstreamOrigin(message.origin ?? message.messageOrigin);
        const clientUserMessageId = String(message.clientUserMessageId ?? "").trim();
        const parsedAnnotations = responseAnnotationDetails(rawText);
        const responseAnnotations = Array.isArray(message.responseAnnotations)
          && message.responseAnnotations.length
          ? {
            items: message.responseAnnotations,
            request: String(message.responseAnnotationRequest ?? ""),
          }
          : parsedAnnotations;
        return {
          itemId: String(message.itemId ?? `${id}:rollout-user:${index}`),
          ...(clientUserMessageId
            ? { clientUserMessageId }
            : {}),
          ...(String(message.sourceOccurrenceId ?? "").trim()
            ? { sourceOccurrenceId: String(message.sourceOccurrenceId).trim() }
            : {}),
          role: "user",
          text: displayUserPrompt(interstreamDisplayText(rawText, {
            origin: message.origin ?? message.messageOrigin,
            clientUserMessageId,
          })),
          ...(origin ? { origin, kind: "interstream" } : {}),
          ...((interstreamOriginAuthor(origin) || String(message.author ?? userAuthor).trim())
            ? { author: interstreamOriginAuthor(origin) || String(message.author ?? userAuthor).trim() }
            : {}),
          ...(message.time ? { time: message.time } : {}),
          ...(Array.isArray(message.attachments) ? { attachments: structuredClone(message.attachments) } : {}),
          ...(Array.isArray(message.attachmentSources)
            ? { attachmentSources: structuredClone(message.attachmentSources) } : {}),
          ...(responseAnnotations?.items.length
            ? {
              responseAnnotations: responseAnnotations.items.map((annotation) => ({ ...annotation })),
              responseAnnotationRequest: responseAnnotations.request,
            }
            : {}),
        };
      })
      .filter((message) => message.text || message.attachments?.length || message.attachmentSources?.length);
    const users = projectedMessages.filter((message) => message.role === "user");
    const finalAnswer = String(finalMessages[id] ?? "").trim();
    const latestAnswer = String(latestMessages[id] ?? "").trim();
    const answer = finalAnswer || latestAnswer;
    const generatedImages = (Array.isArray(generatedImageSources[id])
      ? generatedImageSources[id]
      : []).filter((item) => ["generated-path", "display-path"].includes(item?.type))
      .map((item) => ({ ...item }));
    const trace = Array.isArray(activityGroups[id]) ? structuredClone(activityGroups[id]) : [];
    if (!projectedMessages.length && !answer && !generatedImages.length && !trace.length) return [];
    const completed = Boolean(finalAnswer);
    const active = !completed && activeTurnIds.has(id);
    const prompt = users[0]?.text ?? (projectedMessages.length ? "" : "Сообщение с вложением");
    const messages = projectedMessages.length
    ? [...projectedMessages]
      : [{ itemId: `${id}:rollout-user:placeholder`, role: "user", text: prompt }];
    if (answer) {
      messages.push({
        itemId: `${id}:rollout-agent:${completed ? "final" : "latest"}`,
        role: "agent",
        text: answer,
        ...(completed ? { phase: "final_answer" } : {}),
        ...(generatedImages.length ? { attachmentSources: generatedImages } : {}),
      });
    } else if (generatedImages.length) {
      messages.push({
        itemId: `${id}:rollout-agent:image`,
        role: "agent",
        text: "Изображение",
        attachmentSources: generatedImages,
      });
    }
    const firstUser = users[0];
    const responseAnnotations = firstUser?.responseAnnotations ?? [];
    return [{
      id,
      prompt,
      answer,
      status: completed ? "completed" : active ? "inProgress" : "stopped",
      active,
      completed,
      userMessagesObserved: users.length > 0,
      userMessageSnapshotAuthority: activity.userMessageSnapshotAuthorityByTurnId?.[id]
        ?? activity.userMessageSnapshotAuthority
        ?? "incremental",
      ...(responseAnnotations.length
        ? {
          promptAnnotations: responseAnnotations.map((annotation) => ({ ...annotation })),
          promptRequest: firstUser.responseAnnotationRequest ?? "",
        }
        : {}),
      messages,
      activities: trace.flatMap((group) => group.activities ?? []),
      ...(trace.length ? { activityGroups: trace } : {}),
    }];
  });
}

function providerAgentName(provider) {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : String(provider ?? "").trim();
}

function subagentPromptAuthor(binding, parentThreadId, workspaceCatalogStore) {
  const parentId = String(parentThreadId ?? "").trim();
  if (!parentId) return "";
  const provider = String(binding?.provider ?? "").trim();
  const parentBinding = workspaceCatalogStore?.thread?.({ provider, threadId: parentId })
    ?? workspaceCatalogStore?.thread?.({ provider, threadId: binding?.threadId });
  const stream = parentBinding?.streamId
    ? workspaceCatalogStore?.stream?.(parentBinding.streamId)
    : null;
  const workspace = stream?.workspaceId
    ? workspaceCatalogStore?.workspace?.(stream.workspaceId)
    : null;
  const workspaceName = String(workspace?.name ?? binding?.workspaceName ?? "Agent Hub").trim();
  const streamName = String(stream?.name ?? binding?.streamName ?? "").trim();
  const agent = providerAgentName(provider);
  return `${workspaceName}${streamName ? ` - ${streamName}` : ""}${agent ? ` (${agent})` : ""}`;
}

export function taskViewMessages(exchange, { includeAgent = true } = {}) {
  const source = (Array.isArray(exchange?.messages) ? exchange.messages : []).flatMap((message) => {
    const role = String(message?.role ?? "");
    const attachments = Array.isArray(message?.attachments)
      ? message.attachments.map((attachment) => ({ ...attachment }))
      : [];
    const text = String(message?.text ?? "").trim();
    if (!["user", "agent"].includes(role)
      || (role === "agent" && !includeAgent && message?.kind !== "subagent")) return [];
    if (!text && !attachments.length) return [];
    return [{
      ...message,
      role,
      text,
      attachments,
    }];
  });
  if (source.length) return source;
  const fallback = [];
  const prompt = String(exchange?.prompt ?? "").trim();
  const answer = String(exchange?.answer ?? "").trim();
  if (prompt) fallback.push({ role: "user", text: prompt, attachments: [] });
  if (includeAgent && answer) fallback.push({ role: "agent", text: answer, attachments: [] });
  return fallback;
}

function mergeCodexHistory(cachedHistory, sourceHistory, rolloutHistory, internalTurnIds = []) {
  const hidden = new Set((Array.isArray(internalTurnIds) ? internalTurnIds : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean));
  const merged = mergeDurableHistory(cachedHistory, sourceHistory, {
    preserveCanonicalUserMessages: true,
  })
    .filter((item) => (
      !isCodexAutoCompactionTurnId(item?.id)
      && !hidden.has(String(item?.id ?? "").trim())
    ));
  const positions = new Map(merged.map((item, index) => [String(item?.id ?? ""), index]));
  for (const item of Array.isArray(rolloutHistory) ? rolloutHistory : []) {
    const id = String(item?.id ?? "");
    if (hidden.has(id)) continue;
    const index = id ? positions.get(id) : undefined;
    if (index === undefined) {
      if (id) positions.set(id, merged.length);
      merged.push(structuredClone(item));
      continue;
    }
    let current = merged[index];
    const hasAuthoritativeContent = Boolean(
      item.answer
      || item.userMessagesObserved === true
      || item.messages?.some((message) => message?.role === "agent"),
    );
    if (hasAuthoritativeContent) {
      current = mergeAuthoritativeRolloutTurn(current, item);
      merged[index] = current;
    }
    const messagesWithImages = mergeAttachmentSources(current?.messages, item.messages);
    if (messagesWithImages !== current?.messages) {
      current = { ...current, messages: messagesWithImages };
      merged[index] = current;
    }
    if (item.activityGroups?.length) {
      current = {
        ...current,
        activityGroups: structuredClone(item.activityGroups),
        activities: current.activities?.length
          ? current.activities
          : structuredClone(item.activities ?? []),
      };
      merged[index] = current;
    }
    if (item.completed && !current?.completed) {
      merged[index] = {
        ...current,
        prompt: item.prompt || current.prompt,
        answer: item.answer || current.answer,
        status: "completed",
        active: false,
        completed: true,
        messages: mergeAuthoritativeRolloutTurn(current, item).messages,
        ...(item.promptAnnotations?.length
          ? {
            promptAnnotations: item.promptAnnotations.map((annotation) => ({ ...annotation })),
            promptRequest: item.promptRequest ?? "",
          }
          : {}),
      };
      continue;
    }
    if (item.promptAnnotations?.length) {
      const annotations = item.promptAnnotations.map((annotation) => ({ ...annotation }));
      const request = item.promptRequest ?? item.prompt ?? "";
      merged[index] = {
        ...current,
        prompt: item.prompt || current.prompt,
        promptAnnotations: annotations,
        promptRequest: request,
      };
    }
  }
  return withoutCodexInspectionAttachments(merged
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftId = String(left.item?.id ?? "");
      const rightId = String(right.item?.id ?? "");
      return CODEX_TURN_ID.test(leftId) && CODEX_TURN_ID.test(rightId)
        ? leftId.localeCompare(rightId)
        : left.index - right.index;
    })
    .map(({ item }) => item));
}

export class TaskViewController {
  constructor(deps) {
    this.deps = deps;
  }

  task(binding, targetChatId) {
    return {
      provider: binding.provider,
      projectRoot: binding.projectRoot,
      threadId: binding.threadId,
      chatId: targetChatId,
      taskTitle: binding.taskTitle,
    };
  }

  identityMatches(binding, identity) {
    return binding?.provider === identity?.provider
      && String(binding?.threadId ?? "").toLowerCase()
        === String(identity?.threadId ?? "").toLowerCase();
  }

  async readHistory(binding, { completedOnly = false, cachedOnly = false, limit = null, repairSubagentTurnIds = [] } = {}) {
    const d = this.deps;
    const task = this.task(binding, binding.chatId);
    const detachedThread = d.workspaceCatalogStore?.thread?.({
      provider: binding.provider,
      threadId: binding.threadId,
    });
    if (cachedOnly || detachedThread?.detachedAtMs != null) {
      return {
        history: withoutCodexInspectionAttachments(d.taskSyncStore.history(task, {
          ...(limit == null ? {} : { limit }),
        })
          .filter((item) => (
            binding.provider !== "codex" || !isCodexAutoCompactionTurnId(item?.id)
          ))
          .filter((item) => !completedOnly || item.completed)),
        snapshot: completedOnly ? null : d.taskSyncStore.snapshot(task),
      };
    }
    try {
      if (binding.provider === "codex") {
        const directRolloutPath = await d.findCodexRolloutPath?.(binding.threadId, "");
        if (directRolloutPath) {
          const cached = d.taskSyncStore.history(task);
          if (repairSubagentTurnIds.length) {
            const turns = cached.filter((turn) => repairSubagentTurnIds.includes(turn.id)
              && turn.completed === true && turn.active !== true);
            const candidates = turns.map((turn) => ({ turnId: turn.id }));
            const evidence = await d.recoverCodexRolloutSubagents(directRolloutPath, candidates);
            for (const turn of turns) {
              const reports = evidence.filter((message) => message.turnId === turn.id);
              const current = turn.messages ?? [];
              const retained = withoutMisclassifiedSubagentUsers(current, reports);
              const recovered = reports.filter((report) => !retained.some((message) => (
                message.sourceOccurrenceId === report.sourceOccurrenceId
              )));
              turn.messages = [...retained, ...recovered];
            }
          }
          const rolloutActivity = await d.readCodexRolloutActivity(
            directRolloutPath,
            {
              freshnessMs: Number.POSITIVE_INFINITY,
              tailBytes: CODEX_HISTORY_REFRESH_TAIL_BYTES,
            },
          );
          const userAuthor = subagentPromptAuthor(
            binding,
            rolloutActivity?.parentThreadId,
            d.workspaceCatalogStore,
          );
          const internalTurnIds = [...new Set([
            ...(rolloutActivity?.internalTurnIds ?? []),
            ...(d.contextProbeTurnIds?.(binding.threadId) ?? []),
          ])];
          const history = mergeCodexHistory(
            cached,
            [],
            codexRolloutHistory(rolloutActivity, { userAuthor }),
            internalTurnIds,
          );
          const snapshot = completedOnly ? null : await d.readCodexSnapshot({
            ...task,
            turnId: null,
            observer: true,
            rolloutPath: directRolloutPath,
          }, { threadResult: { thread: { id: binding.threadId, path: directRolloutPath } } });
          mergeActiveTaskHistory(history, { ...snapshot, provider: "codex" });
          await materializeHistoryAttachments(history, d.attachmentImporter);
          await d.taskSyncStore.recordHistory(task, history, snapshot);
          await d.taskSyncStore.save();
          return { history, snapshot };
        }
        await d.ensureCodex();
        const result = await d.readCodexThread(binding.threadId, { fresh: true });
        const cached = d.taskSyncStore.history(task);
        const rolloutActivity = result.thread?.path
          ? await d.readCodexRolloutActivity(result.thread.path, {
            freshnessMs: Number.POSITIVE_INFINITY,
            tailBytes: CODEX_HISTORY_REFRESH_TAIL_BYTES,
          })
          : null;
        const parentThreadId = result.thread?.parentThreadId || rolloutActivity?.parentThreadId;
        const userAuthor = subagentPromptAuthor(binding, parentThreadId, d.workspaceCatalogStore);
        const internalTurnIds = [...new Set([
          ...(rolloutActivity?.internalTurnIds ?? []),
          ...(d.contextProbeTurnIds?.(binding.threadId) ?? []),
        ])];
        const history = mergeCodexHistory(
          cached,
          codexThreadHistory(result.thread?.turns, { userAuthor }),
          codexRolloutHistory(rolloutActivity, { userAuthor }),
          internalTurnIds,
        );
        const snapshot = completedOnly ? null : await d.readCodexSnapshot({
          ...task,
          turnId: null,
          observer: true,
        }, { threadResult: result });
        mergeActiveTaskHistory(history, { ...snapshot, provider: "codex" });
        await materializeHistoryAttachments(history, d.attachmentImporter);
        await d.taskSyncStore.recordHistory(task, history, snapshot);
        await d.taskSyncStore.save();
        return { history, snapshot };
      }
      const snapshot = await d.readClaudeSnapshot(binding.threadId, { includeHistory: true });
      const cached = d.taskSyncStore.history(task);
      const history = mergeDurableHistory(cached, snapshot?.history ?? [], {
        adoptRenamedTurns: true,
        chronological: true,
      });
      const indexedRun = completedOnly ? null : d.taskRuns.forTask(task);
      const running = taskRunIsActive(indexedRun) ? indexedRun : null;
      if (running) {
        mergeActiveTaskHistory(history, {
          active: true,
          provider: "claude",
          turnId: running.turnId ?? running.id,
          prompt: running.promptPreview,
          answer: running.responseText,
          clientUserMessageId: running.clientUserMessageId,
          responseItemId: running.responseItemId,
          activities: running.activities,
          startedAt: running.startedAt,
          attachments: running.messageAttachments ?? [],
        });
      } else if (!snapshot) {
        for (const item of history) {
          if (item?.active !== true) continue;
          item.active = false;
          item.completed = true;
          item.status = "stopped";
        }
        const latest = history.at(-1);
        const savedAnswer = String(d.savedLastTaskMessage?.(task) ?? "").trim();
        if (latest && !String(latest.answer ?? "").trim() && savedAnswer) {
          latest.answer = savedAnswer;
          latest.status = "failed";
          latest.active = false;
          latest.completed = true;
          const messages = Array.isArray(latest.messages) ? latest.messages : [];
          messages.push({
            itemId: `${latest.id || "cached"}:agent:fallback`,
            role: "agent",
            text: savedAnswer,
          });
          latest.messages = messages;
        }
      }
      const persistenceSnapshot = completedOnly
        ? null
        : snapshot ?? (running ? {
          active: true,
          turnId: running.turnId ?? null,
          activityAtMs: Date.now(),
          stage: running.progressStage ?? "",
          answer: running.responseText ?? "",
        } : null);
      await d.taskSyncStore.recordHistory(task, history, persistenceSnapshot);
      await d.taskSyncStore.save();
      return { history, snapshot: completedOnly ? null : snapshot };
    } catch (error) {
      const history = withoutCodexInspectionAttachments(d.taskSyncStore.history(task)
        .filter((item) => (
          binding.provider !== "codex" || !isCodexAutoCompactionTurnId(item?.id)
        ))
        .filter((item) => !completedOnly || item.completed));
      if (!history.length) throw error;
      d.logger.warn(`Using cached local history for ${binding.provider} task ${binding.threadId}:`, error.message);
      return {
        history,
        snapshot: completedOnly ? null : d.taskSyncStore.snapshot(task),
      };
    }
  }

  async render(binding, targetChatId, { count = 1, completedOnly = false } = {}) {
    const d = this.deps;
    const task = this.task(binding, targetChatId);
    const { history, snapshot } = await this.readHistory(binding, { completedOnly });
    const indexedRun = d.taskRuns.forTask(task);
    const running = taskRunIsActive(indexedRun) ? indexedRun : null;
    if (running) {
      mergeActiveTaskHistory(history, {
        active: true,
        provider: binding.provider,
        turnId: running.turnId ?? running.id,
        prompt: running.promptPreview,
        answer: running.responseText,
      });
    }
    const view = visibleTaskHistory(history, count, { completedOnly });
    await d.deleteTaskMessages(task, targetChatId);
    const historyButton = view.hasMore
      ? {
        reply_markup: {
          inline_keyboard: [[{
            text: `👀 Показать ещё · ${view.shown}/${view.total}`,
            callback_data: taskViewCallbackData({
              action: completedOnly ? "history-last" : "history-all",
              provider: task.provider,
              threadId: task.threadId,
              count: view.nextCount,
            }) ?? `history-more:${completedOnly ? "l" : "a"}:${view.nextCount}`,
          }]],
        },
      }
      : {};
    await d.sendRunMessage(
      task,
      `🧵 ${d.runTaskTitle(task)}\n\n`
        + (view.total
          ? `Показано ходов: ${view.shown} из ${view.total}.`
          : "История этого потока пока пуста."),
      historyButton,
      { kind: "task-view-navigation" },
    );
    let rendered = false;
    for (const exchange of view.items) {
      for (const message of taskViewMessages(exchange, { includeAgent: !exchange.active })) {
        const user = message.role === "user";
        const author = String(message.author ?? "").trim();
        await d.sendTaskViewText(
          task,
          user
            ? `👤 ${author || "Вы"}`
            : `🤖 ${author || (binding.provider === "claude" ? "Claude" : "Codex")}`,
          message.text,
          user ? "task-view-user" : "task-view-assistant",
          message.attachments,
        );
        rendered = true;
      }
    }
    if (!rendered && completedOnly) {
      const answer = d.savedLastTaskMessage(task);
      if (answer) {
        await d.sendTaskViewText(
          task,
          binding.provider === "claude" ? "🤖 Claude" : "🤖 Codex",
          answer,
          "task-view-assistant",
        );
        rendered = true;
      }
    }
    return { snapshot, rendered };
  }

  async show(binding, targetChatId, { count = 1 } = {}) {
    const d = this.deps;
    const task = {
      provider: binding.provider,
      projectRoot: binding.projectRoot,
      threadId: binding.threadId,
    };
    if (d.dismissedExternalTasks.delete(task)) await d.saveState();
    const view = await this.render(binding, targetChatId, { count });
    const indexedRun = d.taskRuns.forTask(task);
    const running = taskRunIsActive(indexedRun) ? indexedRun : null;
    if (running) {
      const title = d.resolveRunningTitle(running, binding);
      if (updateTaskRunTitle(running, title)) await d.saveState();
      running.chatId = targetChatId;
      running.displayRequested = true;
      running.telegramDeliveryRequested = true;
      await d.startProgressMessage(running, { forceNew: true });
      return;
    }
    if (view.snapshot?.active) {
      const run = d.createObservedRun(
        binding,
        targetChatId,
        view.snapshot,
        binding.provider === "codex" ? view.snapshot.turnId : null,
      );
      run.displayRequested = true;
      run.telegramDeliveryRequested = true;
      await d.startProgressMessage(run, { forceNew: true });
      d.scheduleObservedRun(run);
      await d.saveState();
      return;
    }
    if (view.snapshot?.activityUnknown) {
      await d.sendRunMessage(
        { ...task, chatId: targetChatId, taskTitle: binding.taskTitle },
        "❔ Активность Claude неизвестна: транскрипт не завершён, но давно не обновлялся. Новое сообщение не будет запущено в этом треде без явного подтверждения.",
      );
      await d.saveState();
      return;
    }
    if (!view.rendered) {
      await d.sendRunMessage(
        { ...task, chatId: targetChatId, taskTitle: binding.taskTitle },
        "У этого потока пока нет выполняющегося хода или сохранённого ответа.",
      );
    }
    await d.saveState();
  }

  async showLast(binding, targetChatId, { count = 1 } = {}) {
    const view = await this.render(binding, targetChatId, { count, completedOnly: true });
    if (!view.rendered) {
      await this.deps.sendRunMessage(
        { ...binding, chatId: targetChatId },
        "У этого потока пока нет сохранённого завершённого ответа.",
      );
    }
    await this.deps.saveState();
  }

  async resolveBinding(identity, targetChatId, sourceMessageId) {
    const d = this.deps;
    const stored = await d.findMessageBinding(targetChatId, sourceMessageId);
    const reference = identity ?? stored;
    const entry = reference ? await d.findCatalogEntry(reference) : null;
    if (!identity && stored) return entry ? {
      ...stored,
      streamId: entry.streamId ?? stored.streamId ?? null,
      projectRoot: entry.projectRoot ?? stored.projectRoot,
      taskTitle: taskDisplayTitle(entry, stored.taskTitle),
    } : stored;
    if (this.identityMatches(stored, identity)) return entry ? {
      ...stored,
      streamId: entry.streamId ?? stored.streamId ?? null,
      projectRoot: entry.projectRoot ?? stored.projectRoot,
      taskTitle: taskDisplayTitle(entry, stored.taskTitle),
    } : stored;
    if (entry) {
      return {
        chatId: targetChatId,
        messageId: sourceMessageId,
        streamId: entry.streamId ?? null,
        provider: entry.provider,
        threadId: entry.threadId,
        projectRoot: entry.projectRoot,
        taskTitle: taskDisplayTitle(entry),
        createdAt: new Date().toISOString(),
      };
    }
    const selected = d.selectedTask();
    if (!this.identityMatches(selected, identity)) return null;
    return {
      chatId: targetChatId,
      messageId: sourceMessageId,
      ...selected,
      taskTitle: d.activeThreadTitle(),
      createdAt: new Date().toISOString(),
    };
  }
}
