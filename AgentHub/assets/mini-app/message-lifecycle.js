"use strict";

(() => {

function identityKey(message, { withoutItem = false } = {}) {
  const provider = String(message?.provider ?? "");
  const threadId = String(message?.threadId ?? "");
  const turnId = String(message?.turnId ?? "");
  const itemId = String(message?.itemId ?? "");
  const role = String(message?.role ?? "");
  if (!provider || !threadId || !turnId || !role) return "";
  if (withoutItem) return `${provider}\0${threadId}\0${turnId}\0${role}`;
  return itemId ? `${provider}\0${threadId}\0${turnId}\0${itemId}\0${role}` : "";
}

function clientIdentityKey(message) {
  const clientUserMessageId = String(message?.clientUserMessageId ?? "");
  const role = String(message?.role ?? "");
  if (!clientUserMessageId || role !== "user") return "";
  // clientUserMessageId is the global idempotency key of one submission.
  // Provider/thread can briefly differ while an optimistic card is rebound to
  // the canonical task, but that must not create a second visible message.
  return `${clientUserMessageId}\0${role}`;
}

function agentTurnKey(message) {
  const provider = String(message?.provider ?? "");
  const threadId = String(message?.threadId ?? "");
  const turnId = String(message?.turnId ?? "");
  if (!provider || !threadId || !turnId || message?.role !== "agent") return "";
  return `${provider}\0${threadId}\0${turnId}\0agent`;
}

// The App Server may replay a materialized user item while reconnecting. A
// client id is an idempotency key for one user submission, so two history
// items with that key must render as one message even when server item ids
// differ. This happens before optimistic reconciliation; otherwise both
// echoes remain after the local card has been confirmed and removed.
function deduplicateConversationMessages(messages) {
  const values = [];
  const seen = new Set();
  const positions = new Map();
  const agentTurns = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const client = clientIdentityKey(message);
    const item = identityKey(message);
    const agentTurn = agentTurnKey(message);
    const keys = [
      ...(client ? [`client:${client}`] : []),
      ...(item ? [`item:${item}`] : []),
    ];
    if (agentTurn && agentTurns.has(agentTurn)) {
      values[agentTurns.get(agentTurn)] = message;
      keys.forEach((key) => seen.add(key));
      continue;
    }
    const duplicateKey = keys.find((key) => seen.has(key));
    if (duplicateKey) {
      const position = positions.get(duplicateKey);
      if (Number.isInteger(position) && message?.role === "user") {
        const existing = values[position];
        const delivery = String(message?.deliveryState ?? "").trim() ? message : existing;
        values[position] = {
          ...message,
          ...existing,
          clientUserMessageId: existing.clientUserMessageId || message.clientUserMessageId,
          attachments: Array.isArray(message.attachments) && message.attachments.length
            ? message.attachments
            : existing.attachments ?? [],
          responseAnnotations: Array.isArray(message.responseAnnotations)
            && message.responseAnnotations.length
            ? message.responseAnnotations
            : existing.responseAnnotations,
          responseAnnotationRequest: String(message.responseAnnotationRequest ?? "").trim()
            ? message.responseAnnotationRequest
            : existing.responseAnnotationRequest,
          ...(delivery ? {
            deliveryState: delivery.deliveryState,
            delivery: delivery.delivery,
            failed: delivery.failed,
          } : {}),
        };
      }
      continue;
    }
    keys.forEach((key) => {
      seen.add(key);
      positions.set(key, values.length);
    });
    if (agentTurn) agentTurns.set(agentTurn, values.length);
    values.push(message);
  }
  return values;
}

function turnRootUserKey(message) {
  const provider = String(message?.provider ?? "");
  const threadId = String(message?.threadId ?? "");
  const turnId = String(message?.turnId ?? "");
  if (!provider || !threadId || !turnId || message?.role !== "user") return "";
  return `${provider}\0${threadId}\0${turnId}\0root-user`;
}

function isTurnRootUser(messages, index) {
  const message = messages[index];
  const key = turnRootUserKey(message);
  if (!key) return false;
  return !messages.slice(0, index).some((candidate) => turnRootUserKey(candidate) === key);
}

function focusedTurnTaskThreadId(focusedTurn) {
  return String(focusedTurn?.taskThreadId ?? focusedTurn?.turnThreadId ?? "");
}

function focusedTurnAlreadyVisible(history, messages, focusedTurn) {
  const provider = String(focusedTurn?.provider ?? "");
  const taskThreadId = focusedTurnTaskThreadId(focusedTurn);
  const turnId = String(focusedTurn?.turnId ?? "");
  if (!provider || !taskThreadId || !turnId) return false;
  if (
    String(history?.provider ?? "") !== provider
    || String(history?.threadId ?? "") !== taskThreadId
  ) return false;
  return (Array.isArray(messages) ? messages : []).some((message) => (
    String(message?.provider ?? "") === provider
    && String(message?.threadId ?? "") === taskThreadId
    && String(message?.turnId ?? "") === turnId
  ));
}

function historyContainsLatestAnswer(history, task) {
  const expectedTurnId = String(task?.lastAnswerTurnId ?? "").trim();
  const expectedAnswer = String(task?.lastAnswer ?? "").trim();
  const hasKnownAnswer = Boolean(String(task?.lastAnswerAt ?? "").trim() || expectedAnswer);
  if (!hasKnownAnswer) return true;
  const items = Array.isArray(history?.items) ? history.items : [];
  const candidates = expectedTurnId
    ? items.filter((item) => String(item?.id ?? "") === expectedTurnId)
    : items;
  return candidates.some((item) => {
    if (item?.completed !== true) return false;
    const hasUserMessage = Boolean(String(item?.prompt ?? "").trim())
      || (Array.isArray(item?.messages) ? item.messages : []).some((message) => (
        message?.role === "user" && String(message?.text ?? "").trim()
      ));
    // A temporary completion overlay can expose the final answer before the
    // durable history contains its user item. With an exact latest turn id,
    // keep refreshing until the whole exchange is present.
    if (expectedTurnId && !hasUserMessage) return false;
    const texts = [
      String(item?.answer ?? "").trim(),
      ...(Array.isArray(item?.messages) ? item.messages : [])
        .filter((message) => message?.role === "agent")
        .map((message) => String(message?.text ?? "").trim()),
    ].filter(Boolean);
    if (expectedTurnId) return texts.length > 0;
    return expectedAnswer
      ? texts.some((text) => (
          text === expectedAnswer
          || text.startsWith(expectedAnswer)
          || expectedAnswer.startsWith(text)
        ))
      : texts.length > 0;
  });
}

function normalizedResponseAnnotations(values) {
  return (Array.isArray(values) ? values : []).flatMap((item) => {
    const text = String(item?.text ?? item?.quote ?? "").trim();
    const annotation = String(item?.annotation ?? item?.comment ?? "").trim();
    return text || annotation ? [{ text, annotation }] : [];
  });
}

function responseAnnotationPrompt(request, values) {
  const payload = normalizedResponseAnnotations(values);
  if (!payload.length) return String(request ?? "");
  return "# Response annotations:\n"
    + "Each item contains text selected from an earlier Codex response and may include a user comment. "
    + "Use every selection as context and address every comment in your response.\n"
    + `<response-annotations>\n${JSON.stringify(payload)}\n</response-annotations>\n\n`
    + `## My request for Codex:\n${String(request ?? "")}`;
}

function embeddedResponseAnnotations(value) {
  const text = String(value ?? "");
  const block = text.match(/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/iu);
  const requestMarker = /^##\s*My request for Codex:\s*$/imu;
  if (!block || !requestMarker.test(text)) return null;
  let parsed = [];
  try {
    const valueFromJson = JSON.parse(block[1]);
    if (Array.isArray(valueFromJson)) parsed = valueFromJson;
  } catch {
    // Even a damaged legacy envelope must not expose its service wrapper.
  }
  const request = text.split(requestMarker).slice(1).join("\n").trim();
  return { annotations: normalizedResponseAnnotations(parsed), request };
}

function normalizedUserMessage(message) {
  if (message?.role !== "user") return message;
  const embedded = embeddedResponseAnnotations(message.text);
  const structured = normalizedResponseAnnotations(message.responseAnnotations);
  const annotations = structured.length ? structured : embedded?.annotations ?? [];
  const explicitRequest = String(message.responseAnnotationRequest ?? "").trim();
  const request = explicitRequest || embedded?.request || "";
  return {
    ...message,
    text: embedded || annotations.length ? request : String(message.text ?? ""),
    ...(annotations.length ? { responseAnnotations: annotations } : {}),
    ...(request ? { responseAnnotationRequest: request } : {}),
  };
}

function mergeReconciledUserMessage(message, local) {
  if (!local || message?.role !== "user") return message;
  const server = normalizedUserMessage(message);
  const optimistic = normalizedUserMessage(local);
  const serverAnnotations = normalizedResponseAnnotations(server.responseAnnotations);
  const localAnnotations = normalizedResponseAnnotations(optimistic.responseAnnotations);
  if (serverAnnotations.length || !localAnnotations.length) return message;
  return {
    ...message,
    responseAnnotations: localAnnotations,
    responseAnnotationRequest: String(
      optimistic.responseAnnotationRequest ?? optimistic.text ?? "",
    ).trim(),
  };
}

function reconciledUserMetadataConfirmed(message, local) {
  if (!local || message?.role !== "user") return true;
  const server = normalizedUserMessage(message);
  const optimistic = normalizedUserMessage(local);
  const localAnnotations = normalizedResponseAnnotations(optimistic.responseAnnotations);
  if (!localAnnotations.length) return true;
  const serverAnnotations = normalizedResponseAnnotations(server.responseAnnotations);
  return JSON.stringify(serverAnnotations) === JSON.stringify(localAnnotations);
}

function confirmedOutgoingMessageIds(durableMessages, outgoingMessages) {
  const { matches } = reconcile(durableMessages, outgoingMessages);
  return new Set(matches.flatMap(({ message, local }) => (
    local && reconciledUserMetadataConfirmed(message, local)
      ? [local.clientUserMessageId]
      : []
  )));
}

function completedConversationTurnVisible(messages, {
  turnId,
  answer = "",
  requireAgent = false,
} = {}) {
  const exactTurnId = String(turnId ?? "").trim();
  if (!exactTurnId) return false;
  const turnMessages = (Array.isArray(messages) ? messages : []).filter((message) => (
    String(message?.turnId ?? "").trim() === exactTurnId
  ));
  const hasUser = turnMessages.some((message) => (
    message?.role === "user" && String(message?.text ?? "").trim()
  ));
  if (!hasUser) return false;
  const agentTexts = turnMessages
    .filter((message) => message?.role === "agent")
    .map((message) => String(message?.text ?? "").trim())
    .filter(Boolean);
  const expectedAnswer = String(answer ?? "").trim();
  if (expectedAnswer) {
    return agentTexts.some((text) => (
      text === expectedAnswer
      || text.startsWith(expectedAnswer)
      || expectedAnswer.startsWith(text)
    ));
  }
  return requireAgent ? agentTexts.length > 0 : true;
}

function reconcile(serverMessages, outgoingMessages) {
  const outgoing = Array.isArray(outgoingMessages) ? outgoingMessages : [];
  const clientOutgoing = new Map();
  const exactOutgoing = new Map();
  const turnRoleOutgoing = new Map();
  const rootOutgoing = new Map();
  for (const message of outgoing) {
    const client = clientIdentityKey(message);
    if (client) clientOutgoing.set(client, message);
    const exact = identityKey(message);
    if (exact) exactOutgoing.set(exact, message);
    const turnRole = identityKey(message, { withoutItem: true });
    if (!client && !exact && turnRole) {
      const values = turnRoleOutgoing.get(turnRole) ?? [];
      values.push(message);
      turnRoleOutgoing.set(turnRole, values);
    }
    // Codex sometimes omits client_id while it is materializing the first
    // user item of a newly started turn. The turn root is still a stable
    // identity: provider + thread + turn + its first user position. Steer
    // messages deliberately never take this fallback because their position
    // in a turn is not known to the optimistic client.
    if (message?.turnUserSlot === "root") {
      const root = turnRootUserKey(message);
      if (root) rootOutgoing.set(root, message);
    }
  }
  const matchedIds = new Set();
  const server = Array.isArray(serverMessages) ? serverMessages : [];
  const matches = server.map((message, index) => {
    const serverClientIdentity = clientIdentityKey(message);
    const serverItemIdentity = identityKey(message);
    const client = clientOutgoing.get(serverClientIdentity);
    const exact = exactOutgoing.get(serverItemIdentity);
    const fallbackValues = serverClientIdentity || serverItemIdentity
      ? []
      : turnRoleOutgoing.get(identityKey(message, { withoutItem: true })) ?? [];
    // A new-turn optimistic message is bound to the exact turn before Codex
    // has finished materializing its user item. Some App Server revisions can
    // replace the supplied client id on that root item. The root position is
    // still unambiguous; steer messages never receive turnUserSlot="root".
    const root = isTurnRootUser(server, index)
      ? rootOutgoing.get(turnRootUserKey(message))
      : null;
    // A turn can contain several steering messages. A turn+role fallback is safe
    // only when it identifies one local message; text is never an identity.
    const local = client ?? exact ?? root ?? (fallbackValues.length === 1 ? fallbackValues[0] : null);
    if (!local) return { message, local: null };
    matchedIds.add(local.clientUserMessageId);
    return { message, local };
  });
  return { matches, matchedIds };
}

function rememberBounded(messages, message, limit = 100) {
  messages.set(message.clientUserMessageId, message);
  const boundedLimit = Math.max(1, Number(limit) || 100);
  while (messages.size > boundedLimit) messages.delete(messages.keys().next().value);
  return messages;
}

function liveMessageMatch(messages, probe) {
  const values = Array.isArray(messages) ? messages : [];
  const exact = identityKey(probe);
  if (exact) {
    const exactMatches = values.filter((message) => identityKey(message) === exact);
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1) return null;
  }
  const turnRole = identityKey(probe, { withoutItem: true });
  if (!turnRole) return null;
  const turnMatches = values.filter(
    (message) => identityKey(message, { withoutItem: true }) === turnRole,
  );
  return turnMatches.length === 1 ? turnMatches[0] : null;
}

function visibleConversationMessages(messages, {
  deferredClientUserMessageIds = [],
  liveProbe = null,
} = {}) {
  const deferredIds = new Set(
    Array.from(deferredClientUserMessageIds ?? [], (value) => String(value ?? "").trim())
      .filter(Boolean),
  );
  const visible = (Array.isArray(messages) ? messages : []).filter((message) => !(
    message?.role === "user"
    && deferredIds.has(String(message?.clientUserMessageId ?? "").trim())
  ));
  if (!liveProbe) return visible;
  const liveTurnRole = identityKey(liveProbe, { withoutItem: true });
  if (!liveTurnRole) return visible;
  // A VSC turn can emit several commentary items before the accumulated live
  // response gets its stable item id. While that turn is active, the live card
  // is the single renderer for every agent fragment from the exact same turn.
  return visible.filter(
    (message) => identityKey(message, { withoutItem: true }) !== liveTurnRole,
  );
}

function mergeLiveUserMessages(messages, {
  provider,
  threadId,
  turnId,
  userMessages = [],
  prompt = "",
  clientUserMessageId = "",
  time = null,
  attachments = [],
} = {}) {
  const values = Array.isArray(messages) ? messages.slice() : [];
  const live = Array.isArray(userMessages) && userMessages.length
    ? userMessages
    : String(prompt ?? "").trim()
      ? [{
          itemId: `${String(turnId ?? "active-turn")}:live:user`,
          clientUserMessageId,
          text: prompt,
        }]
      : [];
  for (const [index, message] of live.entries()) {
    const text = String(message?.text ?? "").trim();
    if (!provider || !threadId || !turnId || !text) continue;
    const candidate = {
      id: `${provider}:${threadId}:${turnId}:${message.itemId || `live-user-${index}`}:user`,
      provider,
      threadId,
      turnId,
      itemId: String(message.itemId ?? `live-user-${index}`),
      clientUserMessageId: String(message.clientUserMessageId ?? ""),
      role: "user",
      author: "Вы",
      text,
      ...(Array.isArray(message.responseAnnotations) ? {
        responseAnnotations: message.responseAnnotations.map((item) => ({ ...item })),
        responseAnnotationRequest: String(message.responseAnnotationRequest ?? ""),
      } : {}),
      time: message.time ?? time ?? null,
      attachments: Array.isArray(message.attachments) && message.attachments.length
        ? message.attachments.map((attachment) => ({ ...attachment }))
        : index === 0
          ? attachments.map((attachment) => ({ ...attachment }))
          : [],
    };
    const clientKey = clientIdentityKey(candidate);
    const itemKey = identityKey(candidate);
    const sameTurnUsers = values.filter((existing) => (
      existing?.role === "user"
      && String(existing?.provider ?? "") === provider
      && String(existing?.threadId ?? "") === threadId
      && String(existing?.turnId ?? "") === turnId
    ));
    const duplicateIndex = values.findIndex((existing) => (
      (clientKey && clientIdentityKey(existing) === clientKey)
      || (itemKey && identityKey(existing) === itemKey)
      || (
        !clientKey
        && existing?.role === "user"
        && String(existing?.provider ?? "") === provider
        && String(existing?.threadId ?? "") === threadId
        && String(existing?.turnId ?? "") === turnId
      )
    ));
    const fallbackDuplicateIndex = duplicateIndex < 0 && index === 0 && sameTurnUsers.length > 0
      ? values.indexOf(sameTurnUsers[0])
      : duplicateIndex;
    if (fallbackDuplicateIndex < 0) {
      values.push(candidate);
      continue;
    }
    const existing = values[fallbackDuplicateIndex];
    values[fallbackDuplicateIndex] = {
      ...existing,
      ...candidate,
      id: existing.id ?? candidate.id,
      itemId: existing.itemId || candidate.itemId,
      clientUserMessageId: existing.clientUserMessageId || candidate.clientUserMessageId,
      time: candidate.time ?? existing.time ?? null,
      attachments: candidate.attachments.length
        ? candidate.attachments
        : existing.attachments ?? [],
    };
  }
  return values;
}

function deferredClientMessageId(entry) {
  return String(
    entry?.clientUserMessageId
      ?? entry?.clientMessageId
      ?? entry?.requestId
      ?? "",
  ).trim();
}

function mergeDeferredQueueEntries(serverEntries, clientEntries) {
  const values = [];
  const positions = new Map();
  const appendServer = (entry, index) => {
    const clientUserMessageId = deferredClientMessageId(entry);
    const key = clientUserMessageId
      ? `client:${clientUserMessageId}`
      : `server:${String(entry?.id ?? index)}`;
    const position = positions.get(key);
    const normalized = {
      ...entry,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      optimistic: false,
    };
    if (!Number.isInteger(position)) {
      positions.set(key, values.length);
      values.push(normalized);
      return;
    }
    values[position] = { ...values[position], ...normalized };
  };
  (Array.isArray(serverEntries) ? serverEntries : []).forEach(appendServer);

  for (const [index, entry] of (Array.isArray(clientEntries) ? clientEntries : []).entries()) {
    const clientUserMessageId = deferredClientMessageId(entry);
    const key = clientUserMessageId
      ? `client:${clientUserMessageId}`
      : `client-local:${String(entry?.id ?? index)}`;
    const position = positions.get(key);
    if (!Number.isInteger(position)) {
      positions.set(key, values.length);
      values.push({
        ...entry,
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      });
      continue;
    }
    const server = values[position];
    const clientText = String(entry?.text ?? "").trim();
    const serverText = String(server?.text ?? "").trim();
    values[position] = {
      ...entry,
      ...server,
      clientUserMessageId,
      text: serverText ? server.text : (clientText ? entry.text : server.text),
      annotations: Array.isArray(server.annotations) && server.annotations.length
        ? server.annotations
        : entry.annotations ?? [],
      attachments: Array.isArray(server.attachments) && server.attachments.length
        ? server.attachments
        : entry.attachments ?? [],
      createdAt: server.createdAt ?? entry.createdAt ?? null,
      optimistic: false,
    };
  }
  return values;
}

function chronologicalMessages(messages) {
  const decorated = (Array.isArray(messages) ? messages : [])
    .map((message, index) => ({
      message,
      index,
      time: Date.parse(message?.time ?? ""),
      historyOrder: message?.historyOrder == null
        ? Number.NaN
        : Number(message.historyOrder),
    }));
  const turnTimes = new Map();
  const historyTurnOrders = new Map();
  for (const item of decorated) {
    const turnId = String(item.message?.turnId ?? "");
    if (!turnId) continue;
    if (Number.isFinite(item.time)) {
      const previous = turnTimes.get(turnId);
      turnTimes.set(turnId, previous == null ? item.time : Math.min(previous, item.time));
    }
    if (Number.isFinite(item.historyOrder)) {
      const previous = historyTurnOrders.get(turnId);
      historyTurnOrders.set(
        turnId,
        previous == null ? item.historyOrder : Math.min(previous, item.historyOrder),
      );
    }
  }
  const orderedHistoryTurns = [...historyTurnOrders]
    .map(([turnId, order]) => ({ turnId, order, time: turnTimes.get(turnId) }))
    .sort((left, right) => left.order - right.order);
  const anchors = orderedHistoryTurns.filter((turn) => Number.isFinite(turn.time));
  for (const turn of orderedHistoryTurns) {
    if (Number.isFinite(turn.time)) continue;
    const previous = anchors.findLast((anchor) => anchor.order < turn.order);
    const next = anchors.find((anchor) => anchor.order > turn.order);
    if (previous && next) {
      const span = next.order - previous.order;
      turn.time = previous.time
        + ((next.time - previous.time) * (turn.order - previous.order)) / span;
    } else if (previous) {
      turn.time = previous.time + Math.max(1, turn.order - previous.order);
    } else if (next) {
      turn.time = next.time - Math.max(1, next.order - turn.order);
    } else {
      turn.time = turn.order;
    }
    turnTimes.set(turn.turnId, turn.time);
  }
  for (const item of decorated) {
    if (Number.isFinite(item.time)) continue;
    const turnId = String(item.message?.turnId ?? "");
    item.time = turnTimes.get(turnId) ?? Number.POSITIVE_INFINITY;
  }
  return decorated
    .sort((left, right) => {
      if (left.time !== right.time) return left.time - right.time;
      const sameTurn = String(left.message?.turnId ?? "")
        && String(left.message?.turnId ?? "") === String(right.message?.turnId ?? "");
      if (sameTurn && left.message?.role !== right.message?.role) {
        return left.message?.role === "user" ? -1 : right.message?.role === "user" ? 1 : 0;
      }
      return left.index - right.index;
    })
    .map(({ message }) => message);
}

function historicalAgentResponseVisible(turn) {
  return turn?.completed === true || turn?.active !== true;
}

function activeStageLabel(stage) {
  const value = String(stage ?? "").trim();
  if (!value) return "Ход выполняется";
  if (/^ход выполняется(?:\s|[·:—-]|$)/iu.test(value)) return value;
  return `Ход выполняется · ${value}`;
}

function reusableAttachmentPaths(previousPaths, attachmentCount, { remote = false } = {}) {
  if (remote) return [];
  const paths = Array.isArray(previousPaths) ? previousPaths : [];
  return paths.length === Math.max(0, Number(attachmentCount) || 0)
    ? paths.slice()
    : [];
}

function markConnectionFailure(error) {
  const failure = error && typeof error === "object" && typeof error.message === "string"
    ? error
    : new Error(String(error ?? "Ошибка соединения"));
  Object.defineProperty(failure, "agentHubConnectionFailure", {
    configurable: true,
    enumerable: false,
    value: true,
  });
  return failure;
}

function isConnectionFailure(error) {
  return error?.agentHubConnectionFailure === true;
}

function looksLikeConnectionFailure(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  const message = String(error?.message ?? error ?? "").trim();
  return ["ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE"].includes(code)
    || /\b(?:ECONNREFUSED|ECONNRESET|ENOENT|EPIPE)\b[\s\S]*agent-hub-desktop-/iu.test(message)
    || /Agent Hub (?:в VS Code )?не ответил вовремя/iu.test(message)
    || /Desktop control connection closed without a response/iu.test(message);
}

function hubErrorMessage(error) {
  const message = String(error?.message ?? error ?? "Неизвестная ошибка").trim();
  if (looksLikeConnectionFailure(error)) return "Нет связи с Agent Hub.";
  const translations = new Map([
    ["remote attachment not found", "Вложение недоступно. Повторите отправку."],
    ["remote attachment is incomplete", "Вложение загрузилось не полностью. Повторите отправку."],
    ["remote attachment quota exceeded", "Хранилище вложений временно заполнено. Повторите позже."],
  ]);
  return translations.get(message.toLowerCase()) ?? message;
}

globalThis.AgentHubMessageLifecycle = Object.freeze({
  activeStageLabel,
  chronologicalMessages,
  completedConversationTurnVisible,
  confirmedOutgoingMessageIds,
  deduplicateConversationMessages,
  embeddedResponseAnnotations,
  hubErrorMessage,
  identityKey,
  isConnectionFailure,
  looksLikeConnectionFailure,
  clientIdentityKey,
  focusedTurnAlreadyVisible,
  focusedTurnTaskThreadId,
  historyContainsLatestAnswer,
  historicalAgentResponseVisible,
  liveMessageMatch,
  markConnectionFailure,
  mergeDeferredQueueEntries,
  mergeLiveUserMessages,
  normalizedResponseAnnotations,
  normalizedUserMessage,
  mergeReconciledUserMessage,
  reconciledUserMetadataConfirmed,
  responseAnnotationPrompt,
  reconcile,
  rememberBounded,
  reusableAttachmentPaths,
  visibleConversationMessages,
});

})();
