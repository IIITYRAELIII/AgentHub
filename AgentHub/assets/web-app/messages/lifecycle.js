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

function liveCompletionTransition(previous, selected, incomingTurnId = "") {
  const previousTurnId = String(previous?.turnId ?? "").trim();
  if (!previousTurnId || previousTurnId === String(incomingTurnId ?? "").trim()) return "none";
  const previousProvider = String(previous?.provider ?? "").trim();
  const previousThreadId = String(previous?.threadId ?? "").trim();
  const selectedProvider = String(selected?.provider ?? "").trim();
  const selectedThreadId = String(selected?.threadId ?? "").trim();
  if (
    (previousProvider && selectedProvider && previousProvider !== selectedProvider)
    || (previousThreadId && selectedThreadId && previousThreadId !== selectedThreadId)
  ) return "discard";
  return "promote";
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
  const explicitSlot = String(message?.turnUserSlot ?? "").trim();
  if (explicitSlot === "steer") return false;
  const key = turnRootUserKey(message);
  if (!key) return false;
  return !messages.slice(0, index).some((candidate) => turnRootUserKey(candidate) === key);
}

function liveTurnUserSlot(message, index, {
  prompt = "",
  clientUserMessageId = "",
} = {}) {
  const explicitSlot = String(message?.turnUserSlot ?? "").trim();
  if (explicitSlot) return explicitSlot;
  const messageClientId = String(message?.clientUserMessageId ?? "").trim();
  const rootClientId = String(clientUserMessageId ?? "").trim();
  if (messageClientId && rootClientId) {
    return messageClientId === rootClientId ? "root" : "steer";
  }
  const rootPrompt = String(prompt ?? "").trim();
  const messageText = String(message?.text ?? "").trim();
  // An observed Codex snapshot can temporarily expose only the latest steer
  // and omit its client_id. The run still retains the root prompt, so a
  // different live prompt is enough to keep that sole item out of root-only
  // reconciliation. This is classification only; text is never used as the
  // identity that merges two cards.
  if (rootPrompt && messageText && messageText !== rootPrompt) return "steer";
  return index === 0 ? "root" : "steer";
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
  const serverAnnotations = normalizedResponseAnnotations(server.responseAnnotations);
  const annotationsConfirmed = !localAnnotations.length
    || JSON.stringify(serverAnnotations) === JSON.stringify(localAnnotations);
  const localAttachments = Array.isArray(local?.attachments) ? local.attachments : [];
  const serverAttachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentsConfirmed = !localAttachments.length
    || serverAttachments.length >= localAttachments.length;
  return annotationsConfirmed && attachmentsConfirmed;
}

function completedMaintenanceActivity(message) {
  if (
    message?.kind !== "maintenance"
    || message?.maintenanceType !== "compaction"
    || message?.maintenanceStatus !== "completed"
  ) return null;
  return {
    id: String(message.id ?? message.itemId ?? "maintenance:compaction"),
    type: "compaction",
    status: "completed",
    label: String(message.maintenanceLabel ?? "Свёртка завершена успешно"),
    detail: String(message.maintenanceDetail ?? ""),
    time: message.time ?? null,
  };
}

function sameMaintenanceActivity(left, right) {
  return String(left?.id ?? "") === String(right?.id ?? "")
    || (left?.type === "compaction" && right?.type === "compaction");
}

function messageWithMaintenanceActivity(message, activity) {
  if (!activity) return message;
  const groups = Array.isArray(message?.activityGroups)
    ? message.activityGroups.map((group) => ({
      ...group,
      activities: Array.isArray(group?.activities)
        ? group.activities.map((entry) => ({ ...entry }))
        : [],
    }))
    : [];
  if (groups.length) {
    let replaced = false;
    for (const group of groups) {
      group.activities = group.activities.map((entry) => {
        if (replaced || !sameMaintenanceActivity(entry, activity)) return entry;
        replaced = true;
        return { ...entry, ...activity, id: entry.id || activity.id };
      });
    }
    if (!replaced) groups.at(-1).activities.push(activity);
    return { ...message, activityGroups: groups };
  }
  const activities = Array.isArray(message?.activities)
    ? message.activities.map((entry) => ({ ...entry }))
    : [];
  const existing = activities.findIndex((entry) => sameMaintenanceActivity(entry, activity));
  if (existing >= 0) {
    activities[existing] = { ...activities[existing], ...activity, id: activities[existing].id || activity.id };
  } else {
    activities.push(activity);
  }
  return { ...message, activities };
}

function mergeTurnMaintenanceMessages(messages) {
  const values = (Array.isArray(messages) ? messages : []).slice();
  const embedded = new Set();
  for (const [eventIndex, event] of values.entries()) {
    const activity = completedMaintenanceActivity(event);
    const turnId = String(event?.turnId ?? "").trim();
    if (!activity || !turnId) continue;
    const answerIndex = values.findIndex((message) => (
      message?.role === "agent"
      && String(message?.provider ?? "") === String(event?.provider ?? "")
      && String(message?.threadId ?? "") === String(event?.threadId ?? "")
      && String(message?.turnId ?? "") === turnId
    ));
    if (answerIndex < 0) continue;
    values[answerIndex] = messageWithMaintenanceActivity(values[answerIndex], activity);
    embedded.add(eventIndex);
  }
  return values.filter((_, index) => !embedded.has(index));
}

function mergeLiveMaintenance(live, messages) {
  if (!live) return live;
  return (Array.isArray(messages) ? messages : []).reduce((value, event) => {
    const activity = completedMaintenanceActivity(event);
    if (
      !activity
      || String(event?.provider ?? "") !== String(value?.provider ?? "")
      || String(event?.threadId ?? "") !== String(value?.threadId ?? "")
      || String(event?.turnId ?? "") !== String(value?.turnId ?? "")
    ) return value;
    return messageWithMaintenanceActivity(value, activity);
  }, live);
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

function attachmentReceiptSignature(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  return JSON.stringify(attachments.map((attachment) => ({
    name: String(
      attachment?.name
        ?? attachment?.fileName
        ?? attachment?.filename
        ?? attachment?.path
        ?? "",
    ).replaceAll("\\", "/").split("/").at(-1).toLowerCase(),
    type: String(attachment?.type ?? attachment?.mimeType ?? "").toLowerCase(),
  })));
}

function optimisticReceiptMatch(server, local) {
  if (server?.role !== "user" || local?.role !== "user") return false;
  if (!String(local?.deliveryState ?? "").trim()) return false;
  for (const field of ["provider", "threadId", "turnId"]) {
    const left = String(server?.[field] ?? "").trim();
    const right = String(local?.[field] ?? "").trim();
    if (left && right && left !== right) return false;
  }
  const serverText = String(normalizedUserMessage(server)?.text ?? "").trim();
  const localText = String(normalizedUserMessage(local)?.text ?? "").trim();
  if (!serverText || serverText !== localText) return false;
  if (attachmentReceiptSignature(server) !== attachmentReceiptSignature(local)) return false;
  const serverTime = Date.parse(server?.time ?? "");
  const localTime = Date.parse(local?.time ?? "");
  return Number.isFinite(serverTime)
    && Number.isFinite(localTime)
    && Math.abs(serverTime - localTime) <= 120_000;
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
    if (turnRole) {
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
    const rootMessage = isTurnRootUser(server, index);
    const fallbackValues = client || exact
      ? []
      : (turnRoleOutgoing.get(identityKey(message, { withoutItem: true })) ?? [])
        .filter((candidate) => !matchedIds.has(candidate.clientUserMessageId))
        .filter((candidate) => (
          rootMessage
            ? candidate.turnUserSlot === "root"
            : candidate.turnUserSlot !== "root"
        ));
    // A new-turn optimistic message is bound to the exact turn before Codex
    // has finished materializing its user item. Some App Server revisions can
    // replace the supplied client id on that root item. The root position is
    // still unambiguous; steer messages never receive turnUserSlot="root".
    const root = rootMessage
      ? rootOutgoing.get(turnRootUserKey(message))
      : null;
    const receiptFallback = client || exact || root
      ? null
      : outgoing.filter((candidate) => (
        !matchedIds.has(candidate.clientUserMessageId)
        && optimisticReceiptMatch(message, candidate)
      ));
    // A turn can contain several steering messages. A turn+role fallback is safe
    // only when it identifies one local message; text is never an identity.
    // A delayed receipt can still lack turnId when durable history already has
    // the canonical turn and a replacement client id. Content is used only
    // when exactly one receipt-bearing candidate matches the same task, files
    // and narrow timestamp window, so repeated real submissions stay separate.
    const local = client
      ?? exact
      ?? root
      ?? (fallbackValues.length === 1 ? fallbackValues[0] : null)
      ?? (receiptFallback?.length === 1 ? receiptFallback[0] : null);
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

function outgoingTaskId(outgoingByTask, clientUserMessageId, preferredTaskId = "") {
  const clientId = String(clientUserMessageId ?? "").trim();
  const preferred = String(preferredTaskId ?? "").trim();
  if (!clientId) return "";
  if (preferred && outgoingByTask.get(preferred)?.has(clientId)) return preferred;
  for (const [taskIdValue, messages] of outgoingByTask) {
    if (messages?.has(clientId)) return taskIdValue;
  }
  return "";
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

const CONTEXT_PROBE_CLIENT_ID_PREFIX = "agent-hub-context-probe:";
const CONTEXT_PROBE_PROMPT = "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1";
const CONTEXT_PROBE_RESPONSE = "AGENT_HUB_CONTEXT_PROBE_OK_V1";

function contextProbeMessage(message) {
  const clientId = String(message?.clientUserMessageId ?? message?.clientId ?? "").trim();
  const text = String(message?.text ?? "").trim();
  return clientId.startsWith(CONTEXT_PROBE_CLIENT_ID_PREFIX)
    || text === CONTEXT_PROBE_PROMPT
    || text === CONTEXT_PROBE_RESPONSE;
}

function withoutContextProbeMessages(messages) {
  const values = Array.isArray(messages) ? messages : [];
  const hiddenTurns = new Set(values
    .filter(contextProbeMessage)
    .map((message) => String(message?.turnId ?? "").trim())
    .filter(Boolean));
  return values.filter((message) => !(
    contextProbeMessage(message)
    || hiddenTurns.has(String(message?.turnId ?? "").trim())
  ));
}

function visibleConversationMessages(messages, {
  deferredClientUserMessageIds = [],
  liveProbe = null,
} = {}) {
  const deferredIds = new Set(
    Array.from(deferredClientUserMessageIds ?? [], (value) => String(value ?? "").trim())
      .filter(Boolean),
  );
  const visible = withoutContextProbeMessages(messages).filter((message) => !(
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
    (message) => message?.kind === "subagent"
      || identityKey(message, { withoutItem: true }) !== liveTurnRole,
  );
}

function mergeLiveUserMessages(messages, {
  provider,
  threadId,
  turnId,
  userMessages = [],
  prompt = "",
  promptAuthor = "",
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
    const role = message?.role === "agent" && message?.kind === "subagent" ? "agent" : "user";
    const turnUserSlot = role === "user"
      ? liveTurnUserSlot(message, index, { prompt, clientUserMessageId })
      : "";
    const author = String(message?.author ?? "").trim()
      || (role === "agent" ? "Субагент (модель неизвестна)" : turnUserSlot === "root" ? String(promptAuthor ?? "").trim() : "")
      || "Вы";
    const candidate = {
      id: `${provider}:${threadId}:${turnId}:${message.itemId || `live-${role}-${index}`}:${role}`,
      provider,
      threadId,
      turnId,
      itemId: String(message.itemId ?? `live-${role}-${index}`),
      clientUserMessageId: String(message.clientUserMessageId ?? ""),
      turnUserSlot,
      role,
      author,
      text,
      ...(message?.kind ? { kind: String(message.kind) } : {}),
      ...(message?.agentThreadId ? { agentThreadId: String(message.agentThreadId) } : {}),
      ...(message?.model ? { model: String(message.model) } : {}),
      ...(Array.isArray(message.responseAnnotations) ? {
        responseAnnotations: message.responseAnnotations.map((item) => ({ ...item })),
        responseAnnotationRequest: String(message.responseAnnotationRequest ?? ""),
      } : {}),
      time: message.time ?? time ?? null,
      attachments: Array.isArray(message.attachments) && message.attachments.length
        ? message.attachments.map((attachment) => ({ ...attachment }))
        : role === "user" && turnUserSlot === "root"
          ? attachments.map((attachment) => ({ ...attachment }))
          : [],
    };
    const clientKey = clientIdentityKey(candidate);
    const itemKey = identityKey(candidate);
    const sameTurnUsers = values.filter((existing) => (
      existing?.role === role
      && String(existing?.provider ?? "") === provider
      && String(existing?.threadId ?? "") === threadId
      && String(existing?.turnId ?? "") === turnId
    ));
    const duplicateIndex = values.findIndex((existing) => (
      (clientKey && clientIdentityKey(existing) === clientKey)
      || (itemKey && identityKey(existing) === itemKey)
    ));
    const fallbackDuplicateIndex = duplicateIndex < 0
      && role === "user"
      && turnUserSlot === "root"
      && sameTurnUsers.length > 0
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
      author: candidate.author === "Вы" && String(existing.author ?? "").trim()
        ? existing.author
        : candidate.author,
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
      const leftTurnOrder = historyTurnOrders.get(String(left.message?.turnId ?? ""));
      const rightTurnOrder = historyTurnOrders.get(String(right.message?.turnId ?? ""));
      if (Number.isFinite(leftTurnOrder) && Number.isFinite(rightTurnOrder)
        && leftTurnOrder !== rightTurnOrder) {
        return leftTurnOrder - rightTurnOrder;
      }
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

function historicalMessagesForDisplay(item) {
  const messages = Array.isArray(item?.messages) ? item.messages : [];
  const parentAgents = messages.filter((message) => message?.role === "agent" && message?.kind !== "subagent");
  const visibleAgent = historicalAgentResponseVisible(item)
    ? parentAgents.findLast((message) => ["final", "final_answer", "finalAnswer"].includes(message.phase))
      ?? parentAgents.at(-1)
    : null;
  const visible = messages.filter((message) => (
    message?.role === "user"
    || message?.kind === "subagent"
    || message === visibleAgent
  ));
  if (!visible.some((message) => message?.role === "user") && String(item?.prompt ?? "").trim()) {
    visible.unshift({
      itemId: `${item.id}:prompt`,
      role: "user",
      author: item.promptAuthor,
      text: item.prompt,
      responseAnnotations: item.promptAnnotations,
      responseAnnotationRequest: item.promptRequest,
    });
  }
  if (!visibleAgent && historicalAgentResponseVisible(item) && String(item?.answer ?? "").trim()) {
    visible.push({ itemId: `${item.id}:answer`, role: "agent", text: item.answer });
  }
  return visible;
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

function conversationTaskId({ provider, threadId, streamId = "" } = {}, tasks = []) {
  const stableStreamId = String(streamId ?? "").trim()
    || String((Array.isArray(tasks) ? tasks : []).find((task) => (
      String(task?.provider ?? "") === String(provider ?? "")
      && String(task?.threadId ?? "") === String(threadId ?? "")
    ))?.streamId ?? "").trim();
  return stableStreamId || `${String(provider ?? "")}:${String(threadId ?? "")}`;
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

function markCommandRejected(error) {
  const failure = error && typeof error === "object" && typeof error.message === "string"
    ? error
    : new Error(String(error ?? "Команда Agent Hub отклонена"));
  Object.defineProperty(failure, "agentHubCommandRejected", {
    configurable: true,
    enumerable: false,
    value: true,
  });
  return failure;
}

function messageSendDefinitelyRejected(error) {
  return error?.agentHubCommandRejected === true
    || /^(?:Введите сообщение|Сообщение слишком длинное|Сначала выберите|Неизвестный режим|Идентификатор сообщения)/iu
      .test(String(error?.message ?? error ?? "").trim());
}

function looksLikeConnectionFailure(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  const message = String(error?.message ?? error ?? "").trim();
  return ["ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE"].includes(code)
    || /\b(?:ECONNREFUSED|ECONNRESET|ENOENT|EPIPE)\b[\s\S]*agent-hub-desktop-/iu.test(message)
    || /Agent Hub (?:в VS Code )?не ответил вовремя/iu.test(message)
    || /Desktop control request timed out/iu.test(message)
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
  conversationTaskId,
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
  historicalMessagesForDisplay,
  liveCompletionTransition,
  liveMessageMatch,
  markCommandRejected,
  markConnectionFailure,
  messageSendDefinitelyRejected,
  mergeDeferredQueueEntries,
  mergeLiveMaintenance,
  mergeLiveUserMessages,
  mergeTurnMaintenanceMessages,
  normalizedResponseAnnotations,
  normalizedUserMessage,
  outgoingTaskId,
  mergeReconciledUserMessage,
  reconciledUserMetadataConfirmed,
  responseAnnotationPrompt,
  reconcile,
  rememberBounded,
  reusableAttachmentPaths,
  visibleConversationMessages,
});

})();
