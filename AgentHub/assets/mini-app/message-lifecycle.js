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

function reconcile(serverMessages, outgoingMessages) {
  const outgoing = Array.isArray(outgoingMessages) ? outgoingMessages : [];
  const clientOutgoing = new Map();
  const exactOutgoing = new Map();
  const turnRoleOutgoing = new Map();
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
  }
  const matchedIds = new Set();
  const matches = (Array.isArray(serverMessages) ? serverMessages : []).map((message) => {
    const serverClientIdentity = clientIdentityKey(message);
    const serverItemIdentity = identityKey(message);
    const client = clientOutgoing.get(serverClientIdentity);
    const exact = exactOutgoing.get(serverItemIdentity);
    const fallbackValues = serverClientIdentity || serverItemIdentity
      ? []
      : turnRoleOutgoing.get(identityKey(message, { withoutItem: true })) ?? [];
    // A turn can contain several steering messages. A turn+role fallback is safe
    // only when it identifies one local message; text is never an identity.
    const local = client ?? exact ?? (fallbackValues.length === 1 ? fallbackValues[0] : null);
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

globalThis.AgentHubMessageLifecycle = Object.freeze({
  activeStageLabel,
  identityKey,
  clientIdentityKey,
  liveMessageMatch,
  mergeLiveUserMessages,
  reconcile,
  rememberBounded,
  visibleConversationMessages,
});

})();
