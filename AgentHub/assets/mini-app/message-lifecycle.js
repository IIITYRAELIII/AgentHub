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
  const provider = String(message?.provider ?? "");
  const threadId = String(message?.threadId ?? "");
  const clientUserMessageId = String(message?.clientUserMessageId ?? "");
  const role = String(message?.role ?? "");
  if (!provider || !threadId || !clientUserMessageId || role !== "user") return "";
  return `${provider}\0${threadId}\0${clientUserMessageId}\0${role}`;
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
    const root = !serverClientIdentity && isTurnRootUser(server, index)
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
    const duplicate = values.some((existing) => (
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
    if (!duplicate) values.push(candidate);
  }
  return values;
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
  embeddedResponseAnnotations,
  hubErrorMessage,
  identityKey,
  isConnectionFailure,
  looksLikeConnectionFailure,
  clientIdentityKey,
  focusedTurnAlreadyVisible,
  focusedTurnTaskThreadId,
  historyContainsLatestAnswer,
  liveMessageMatch,
  markConnectionFailure,
  mergeLiveUserMessages,
  normalizedResponseAnnotations,
  normalizedUserMessage,
  reconcile,
  rememberBounded,
  reusableAttachmentPaths,
  visibleConversationMessages,
});

})();
