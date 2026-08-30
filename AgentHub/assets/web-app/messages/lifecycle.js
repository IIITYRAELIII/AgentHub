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
  const clientUserMessageId = String(message?.clientUserMessageId ?? message?.submissionId ?? "");
  const role = String(message?.role ?? "");
  if (!clientUserMessageId || role !== "user") return "";
  // clientUserMessageId is the global idempotency key of one submission.
  // Provider/thread can briefly differ while an optimistic card is rebound to
  // the canonical task, but that must not create a second visible message.
  return `${clientUserMessageId}\0${role}`;
}

function submissionIdentityKeys(message) {
  if (message?.role !== "user") return [];
  return [...new Set([
    String(message?.clientUserMessageId ?? "").trim(),
    String(message?.submissionId ?? "").trim(),
  ].filter(Boolean))].map((value) => `submission:${value}`);
}

function pagedHistoryIdentityKey(message) {
  if (!Number.isFinite(Number(message?.historyOrder))) return "";
  const turnId = String(message?.turnId ?? "").trim();
  const itemId = String(message?.itemId ?? "").trim();
  const role = String(message?.role ?? "").trim();
  if (!turnId || !role) return "";
  // Pagination belongs to one stable Stream cache. Provider and Thread are
  // provenance, not message identity: after Stream rebirth an overlapping
  // page can describe the same durable item with a newly resolved source.
  if (itemId) return `${turnId}\0${itemId}\0${role}`;
  if (role === "agent" && message?.kind !== "subagent") return `${turnId}\0parent-agent`;
  const agentThreadId = String(message?.agentThreadId ?? "").trim();
  if (role === "agent" && message?.kind === "subagent" && agentThreadId) {
    return `${turnId}\0subagent\0${agentThreadId}`;
  }
  if (role === "user" && String(message?.turnUserSlot ?? "").trim() === "root") {
    return `${turnId}\0root-user`;
  }
  return "";
}

function historyMatchesIdentity(history, identity) {
  if (!history || typeof history !== "object" || !identity || typeof identity !== "object") return false;
  const expectedStreamId = String(identity.streamId ?? "").trim();
  const actualStreamId = String(history.streamId ?? "").trim();
  const expectedProvider = String(identity.provider ?? "").trim();
  const actualProvider = String(history.provider ?? "").trim();
  if (expectedStreamId) {
    return actualStreamId === expectedStreamId;
  }
  return Boolean(expectedProvider && String(identity.threadId ?? "").trim())
    && actualProvider === expectedProvider
    && String(history.threadId ?? "").trim() === String(identity.threadId).trim();
}

function agentCardKey(message) {
  const provider = String(message?.provider ?? "");
  const threadId = String(message?.threadId ?? "");
  const turnId = String(message?.turnId ?? "");
  if (!provider || !threadId || !turnId || message?.role !== "agent") return "";
  if (message?.kind === "subagent") {
    const agentThreadId = String(message?.agentThreadId ?? "").trim();
    return agentThreadId
      ? `${provider}\0${threadId}\0${turnId}\0subagent\0${agentThreadId}`
      : "";
  }
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

function completedLiveAnswer(previous, selected) {
  const previousTurnId = String(previous?.turnId ?? "").trim();
  const answer = String(selected?.lastAnswer ?? "").trim();
  const answerTurnId = String(selected?.lastAnswerTurnId ?? "").trim();
  const currentAnswerAt = String(selected?.lastAnswerAt ?? "").trim();
  const baselineAnswerAt = String(previous?.snapshotLastAnswerAt ?? "").trim();
  if (answer && answerTurnId && answerTurnId === previousTurnId) return answer;
  // UI-001 migration guard for snapshots persisted before lastAnswerTurnId.
  // Remove after every retained terminal snapshot carries provider turn identity.
  if (answer && !answerTurnId && currentAnswerAt && currentAnswerAt !== baselineAnswerAt) return answer;
  const previousPhase = String(previous?.responsePhase ?? "").trim();
  return ["final", "final_answer", "finalAnswer"].includes(previousPhase)
    ? String(previous?.text ?? "").trim()
    : "";
}

function completedLiveAgentMessage(previous, selected) {
  const turnId = String(previous?.turnId ?? "").trim();
  const answer = completedLiveAnswer(previous, selected);
  if (!turnId || !answer) return null;
  const taskAnswerTurnId = String(selected?.lastAnswerTurnId ?? "").trim();
  const completionTime = taskAnswerTurnId === turnId
    ? selected?.lastAnswerAt ?? previous?.time ?? null
    : previous?.time ?? null;
  return {
    id: `${previous.provider}:${previous.threadId}:${turnId}:completion-overlay:agent`,
    provider: previous.provider,
    threadId: previous.threadId,
    turnId,
    itemId: previous.itemId || `${turnId}:agent:final`,
    role: "agent",
    author: previous.author,
    phase: "final",
    text: answer,
    time: completionTime,
    activities: Array.isArray(previous.activities) ? previous.activities : [],
    activityGroups: Array.isArray(previous.activityGroups) ? previous.activityGroups : [],
    turnStartedAt: previous.turnStartedAt ?? null,
    turnCompletedAt: completionTime,
  };
}

function snapshotCompletionCandidate(selected, incomingTurnId = "") {
  const turnId = String(selected?.lastAnswerTurnId ?? "").trim();
  const answer = String(selected?.lastAnswer ?? "").trim();
  if (!turnId || !answer || turnId === String(incomingTurnId ?? "").trim()) return null;
  const provider = String(selected?.provider ?? "").trim();
  const threadId = String(selected?.threadId ?? "").trim();
  if (!provider || !threadId) return null;
  return {
    provider,
    threadId,
    turnId,
    answer,
    time: selected?.lastAnswerAt ?? null,
  };
}

function snapshotCompletionReplacement(existing, completion) {
  const answer = String(completion?.answer ?? "").trim();
  if (!answer || answer === String(existing?.answer ?? "").trim()) return null;
  return completion;
}

function activeTaskRun(task) {
  return task?.running === true && task?.run ? task.run : null;
}

function activeRunMessageReceipts(tasks) {
  const receipts = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const run = activeTaskRun(task);
    const clientUserMessageId = String(run?.clientUserMessageId ?? "").trim();
    const provider = String(task?.provider ?? run?.provider ?? "").trim();
    const threadId = String(task?.threadId ?? run?.threadId ?? "").trim();
    if (!clientUserMessageId || !provider || !threadId) continue;
    const rootMessage = (Array.isArray(run.userMessages) ? run.userMessages : []).find((message) => (
      String(message?.clientUserMessageId ?? "").trim() === clientUserMessageId
    ));
    receipts.push({
      accepted: true,
      provider,
      threadId,
      streamId: String(task?.streamId ?? "").trim(),
      clientUserMessageId,
      turnId: String(run.turnId ?? rootMessage?.turnId ?? "").trim(),
      itemId: String(rootMessage?.itemId ?? clientUserMessageId).trim() || clientUserMessageId,
      deliveredAt: rootMessage?.time ?? run.startedAt ?? null,
      attachments: Array.isArray(rootMessage?.attachments) ? rootMessage.attachments : [],
    });
  }
  return receipts;
}

function latestAnswerTransition(previous, current) {
  if (!previous || !current) return false;
  if (String(previous.provider ?? "") !== String(current.provider ?? "")
    || String(previous.threadId ?? "") !== String(current.threadId ?? "")) return false;
  if (Number(current.lastAnswerRevision) > Number(previous.lastAnswerRevision)) return true;
  return Boolean(previous.running && !current.running)
    || String(previous.lastAnswerAt ?? "") !== String(current.lastAnswerAt ?? "")
    || String(previous.lastAnswerTurnId ?? "") !== String(current.lastAnswerTurnId ?? "")
    || String(previous.lastAnswer ?? "") !== String(current.lastAnswer ?? "");
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
  const agentCards = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const client = clientIdentityKey(message);
    const pagedHistory = pagedHistoryIdentityKey(message);
    const item = identityKey(message);
    const root = String(message?.turnUserSlot ?? "").trim() === "root"
      ? turnRootUserKey(message)
      : "";
    const agentCard = agentCardKey(message);
    const keys = [
      ...submissionIdentityKeys(message),
      ...(client ? [`client:${client}`] : []),
      ...(pagedHistory ? [`history:${pagedHistory}`] : []),
      ...(item ? [`item:${item}`] : []),
      ...(root ? [`root:${root}`] : []),
    ];
    if (agentCard && agentCards.has(agentCard)) {
      values[agentCards.get(agentCard)] = message;
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
      keys.forEach((key) => {
        seen.add(key);
        if (Number.isInteger(position)) positions.set(key, position);
      });
      continue;
    }
    keys.forEach((key) => {
      seen.add(key);
      positions.set(key, values.length);
    });
    if (agentCard) agentCards.set(agentCard, values.length);
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

function focusedTurnAlreadyVisible(_history, messages, focusedTurn) {
  const provider = String(focusedTurn?.provider ?? "");
  const taskThreadId = focusedTurnTaskThreadId(focusedTurn);
  const turnId = String(focusedTurn?.turnId ?? "");
  if (!provider || !taskThreadId || !turnId) return false;
  return (Array.isArray(messages) ? messages : []).some((message) => (
    String(message?.provider ?? "") === provider
    && String(message?.threadId ?? "") === taskThreadId
    && String(message?.turnId ?? "") === turnId
  ));
}

function historyContainsLatestAnswer(history, task, { expectedTurnId: pendingTurnId = "" } = {}) {
  const taskAnswerTurnId = String(task?.lastAnswerTurnId ?? "").trim();
  const expectedTurnId = String(pendingTurnId ?? "").trim() || taskAnswerTurnId;
  const expectedAnswer = expectedTurnId && taskAnswerTurnId !== expectedTurnId
    ? ""
    : String(task?.lastAnswer ?? "").trim();
  const hasKnownAnswer = Boolean(
    expectedTurnId
    || String(task?.lastAnswerAt ?? "").trim()
    || expectedAnswer,
  );
  if (!hasKnownAnswer) return true;
  const items = Array.isArray(history?.items) ? history.items : [];
  const expectedProvider = String(task?.provider ?? "").trim();
  const expectedThreadId = String(task?.threadId ?? "").trim();
  const scopedItems = expectedProvider && expectedThreadId
    ? items.filter((item) => (
        String(item?.provider ?? history?.provider ?? "").trim() === expectedProvider
        && String(item?.threadId ?? history?.threadId ?? "").trim() === expectedThreadId
      ))
    : items;
  const candidates = expectedTurnId
    ? scopedItems.filter((item) => String(item?.id ?? "") === expectedTurnId)
    : scopedItems;
  return candidates.some((item) => {
    if (item?.completed !== true) return false;
    const hasUserMessage = Boolean(String(item?.prompt ?? "").trim())
      || (Array.isArray(item?.messages) ? item.messages : []).some(userMessageHasVisibleContent);
    // A temporary completion overlay can expose the final answer before the
    // durable history contains its user item. With an exact latest turn id,
    // keep refreshing until the whole exchange is present.
    if (expectedTurnId && !hasUserMessage) return false;
    const agentMessages = (Array.isArray(item?.messages) ? item.messages : [])
      .filter((message) => message?.role === "agent" && String(message?.text ?? "").trim());
    const phasedAgentMessages = agentMessages.filter((message) => String(message?.phase ?? "").trim());
    const finalAgentMessages = phasedAgentMessages.filter((message) => (
      ["final", "final_answer", "finalAnswer"].includes(String(message?.phase ?? ""))
    ));
    const texts = [
      ...(expectedAnswer || !phasedAgentMessages.length
        ? [String(item?.answer ?? "").trim()]
        : []),
      ...finalAgentMessages.map((message) => String(message.text).trim()),
      ...(!phasedAgentMessages.length
        ? agentMessages.map((message) => String(message.text).trim())
        : []),
    ].filter(Boolean);
    if (!expectedAnswer) return texts.length > 0;
    if (expectedTurnId) return texts.some((text) => text === expectedAnswer);
    // UI-001 migration guard for legacy history without provider turn identity.
    // Remove after all retained history items carry provider + threadId + turnId.
    return texts.some((text) => (
      text === expectedAnswer
      || text.startsWith(expectedAnswer)
      || expectedAnswer.startsWith(text)
    ));
  });
}

function displayedFinalAcknowledgement({
  messages = [],
  final = null,
  focusedTurn = null,
  selectTask = false,
  selectedTaskId = "",
  taskId = "",
} = {}) {
  if (focusedTurn) return false;
  const openedTaskId = String(taskId ?? "").trim();
  const selected = selectTask === true || (
    openedTaskId && openedTaskId === String(selectedTaskId ?? "").trim()
  );
  if (!selected) return false;
  const provider = String(final?.provider ?? "").trim().toLowerCase();
  const threadId = String(final?.threadId ?? "").trim();
  const turnId = String(final?.turnId ?? "").trim();
  const revision = Number(final?.revision);
  if (!provider || !threadId || !turnId || !Number.isSafeInteger(revision) || revision < 1) return false;
  return (Array.isArray(messages) ? messages : []).some((message) => (
    ["agent", "assistant"].includes(String(message?.role ?? "").trim())
    && String(message?.provider ?? "").trim().toLowerCase() === provider
    && String(message?.threadId ?? "").trim() === threadId
    && String(message?.turnId ?? "").trim() === turnId
    && Number(message?.terminalRevision) === revision
    && (
      ["completed", "failed", "cancelled"].includes(String(message?.projectionState ?? "").trim().toLowerCase())
      || ["final", "final_answer", "finalanswer"].includes(String(message?.phase ?? "").trim().toLowerCase())
    )
  ));
}

function completionCatchUpTurnId(previous, current) {
  if (!previous || !current) return "";
  if (String(previous.provider ?? "") !== String(current.provider ?? "")
    || String(previous.threadId ?? "") !== String(current.threadId ?? "")) return "";
  if (previous.running && !current.running) {
    return String(previous.run?.turnId ?? previous.turnId ?? "").trim();
  }
  return String(current.lastAnswerTurnId ?? "").trim();
}

function nextHistoryCatchUpDeadline({
  sourceFresh,
  containsLatestAnswer,
  currentDeadline = 0,
  now = Date.now(),
  timeoutMs,
} = {}) {
  const deadline = Math.max(0, Number(currentDeadline) || 0);
  const next = Math.max(0, Number(now) || 0) + Math.max(0, Number(timeoutMs) || 0);
  if (sourceFresh === false) return next;
  if (containsLatestAnswer) return null;
  return deadline || next;
}

function historyRefreshSourceRequired({ answerTransition = false, catchUpPending = false } = {}) {
  return Boolean(catchUpPending && !answerTransition);
}

function userMessageHasVisibleContent(message) {
  return message?.role === "user" && Boolean(
    String(message?.text ?? "").trim()
    || String(message?.responseAnnotationRequest ?? "").trim()
    || normalizedResponseAnnotations(message?.responseAnnotations).length
    || (Array.isArray(message?.attachments) && message.attachments.length)
  );
}

function normalizedResponseAnnotations(values) {
  return (Array.isArray(values) ? values : []).flatMap((item) => {
    const text = String(item?.text ?? item?.quote ?? "").trim();
    const annotation = String(item?.annotation ?? item?.comment ?? "").trim();
    return text || annotation ? [{ text, annotation }] : [];
  });
}

function visibleUserText(value) {
  return String(value ?? "")
    .replace(/<image\b[^>]*>\s*(?:<\/image>)?/giu, "")
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();
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
  const request = visibleUserText(text.split(requestMarker).slice(1).join("\n"));
  return { annotations: normalizedResponseAnnotations(parsed), request };
}

function normalizedUserMessage(message) {
  if (message?.role !== "user") return message;
  const visibleText = visibleUserText(message.text);
  const embedded = embeddedResponseAnnotations(visibleText);
  const structured = normalizedResponseAnnotations(message.responseAnnotations);
  const annotations = structured.length ? structured : embedded?.annotations ?? [];
  const explicitRequest = visibleUserText(message.responseAnnotationRequest);
  const request = explicitRequest || embedded?.request || "";
  return {
    ...message,
    text: embedded || annotations.length ? request : visibleText,
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
  const hasUser = turnMessages.some(userMessageHasVisibleContent);
  if (!hasUser) return false;
  const agentTexts = turnMessages
    .filter((message) => message?.role === "agent")
    .map((message) => String(message?.text ?? "").trim())
    .filter(Boolean);
  const expectedAnswer = String(answer ?? "").trim();
  if (expectedAnswer) {
    return agentTexts.some((text) => text === expectedAnswer);
  }
  return requireAgent ? agentTexts.length > 0 : true;
}

function reconcile(serverMessages, outgoingMessages) {
  const outgoing = Array.isArray(outgoingMessages) ? outgoingMessages : [];
  const clientOutgoing = new Map();
  const exactOutgoing = new Map();
  const rootOutgoing = new Map();
  for (const message of outgoing) {
    const client = clientIdentityKey(message);
    if (client) clientOutgoing.set(client, message);
    const exact = identityKey(message);
    if (exact) exactOutgoing.set(exact, message);
    // UI-001 migration guard for Codex history written without client_id.
    // Remove after every retained root item carries clientUserMessageId/submissionId.
    // Steer messages never take this exact provider-turn-root fallback.
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
    // UI-001 migration guard for root items whose legacy App Server revision
    // omitted/replaced client_id. Remove with the rootOutgoing guard above.
    const root = rootMessage
      ? rootOutgoing.get(turnRootUserKey(message))
      : null;
    // Reconciliation confirms only authoritative identities. Display content,
    // timestamps and turn-role proximity can coincide across real submissions.
    const local = client
      ?? exact
      ?? root;
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
const CONTEXT_PROBE_RESPONSE_PREFIX = "AGENT_HUB_CONTEXT_PROBE";

function contextProbeClientId(value) {
  return String(value ?? "").trim().startsWith(CONTEXT_PROBE_CLIENT_ID_PREFIX);
}

function legacyContextProbeTextMigrationGuard(value) {
  // Removal condition: all pre-UI-001 probe records carry operationKind=probe.
  // Text is classification evidence only and never an entity identity.
  const text = String(value ?? "").trim();
  return text === CONTEXT_PROBE_PROMPT || text.startsWith(CONTEXT_PROBE_RESPONSE_PREFIX);
}

function contextProbeRun(run) {
  if (!run) return false;
  if (String(run.operationKind ?? "").trim() === "probe") return true;
  if (String(run.operationKind ?? "").trim()) return false;
  if ([
    run.clientUserMessageId,
    ...(Array.isArray(run.userMessages) ? run.userMessages : []).map((message) => (
      message?.clientUserMessageId ?? message?.clientId
    )),
  ].some(contextProbeClientId)) return true;
  if (legacyContextProbeTextMigrationGuard(run.prompt ?? run.promptPreview)) return true;
  return (Array.isArray(run.userMessages) ? run.userMessages : [])
    .some((message) => legacyContextProbeTextMigrationGuard(message?.text));
}

function contextProbeMessage(message) {
  if (String(message?.operationKind ?? "").trim() === "probe") return true;
  if (String(message?.operationKind ?? "").trim()) return false;
  return contextProbeClientId(message?.clientUserMessageId ?? message?.clientId)
    || legacyContextProbeTextMigrationGuard(message?.text);
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
  const deferredIds = new Set([...deferredClientUserMessageIds]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean));
  const visible = withoutContextProbeMessages(messages).filter((message) => {
    const deliveryState = String(message?.deliveryState ?? "").trim();
    if (message?.role === "user" && (deliveryState === "queued" || deliveryState === "deferred")) {
      return false;
    }
    const clientUserMessageId = String(
      message?.clientUserMessageId ?? message?.clientId ?? "",
    ).trim();
    if (message?.role === "user" && clientUserMessageId && deferredIds.has(clientUserMessageId)) {
      return false;
    }
    return Boolean(
      String(message?.text ?? "").trim()
      || normalizedResponseAnnotations(message?.responseAnnotations).some((item) => (
        String(item?.text ?? "").trim() || String(item?.annotation ?? "").trim()
      ))
      || String(message?.responseAnnotationRequest ?? "").trim()
      || (Array.isArray(message?.attachments) && message.attachments.length)
      || (Array.isArray(message?.activities) && message.activities.length)
      || (Array.isArray(message?.activityGroups) && message.activityGroups.length)
    );
  });
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

function withoutSupersededCompactionFailures(messages) {
  // UI-001 migration guard. Remove the text/time branches after persisted
  // maintenance messages all carry operationKind, operationId and revision.
  const values = Array.isArray(messages) ? messages : [];
  const latestCompletedAtByThread = new Map();
  const threadKey = (message) => (
    `${String(message?.provider ?? "").trim()}\u0000${String(message?.threadId ?? "").trim()}`
  );
  for (const message of values) {
    const id = String(message?.id ?? message?.itemId ?? "").trim();
    const completed = id.startsWith("maintenance:compaction:") && (
      message?.maintenanceStatus === "completed"
      || String(message?.text ?? "").startsWith("Свёртка завершена успешно")
    );
    const time = Date.parse(message?.time ?? "");
    if (!completed || !Number.isFinite(time)) continue;
    latestCompletedAtByThread.set(
      threadKey(message),
      Math.max(latestCompletedAtByThread.get(threadKey(message)) ?? 0, time),
    );
  }
  return values.filter((message) => {
    const id = String(message?.id ?? message?.itemId ?? "").trim();
    const failed = id.startsWith("maintenance:compaction:") && (
      ["failed", "timeout"].includes(String(message?.maintenanceStatus ?? ""))
      || /свёртка контекста не завершилась/iu.test(String(message?.text ?? ""))
    );
    if (!failed) return true;
    const completedAt = latestCompletedAtByThread.get(threadKey(message));
    const failedAt = Date.parse(message?.time ?? "");
    return !completedAt || !Number.isFinite(failedAt) || failedAt >= completedAt;
  });
}

function conversationMessageAuthor(message, provider = "") {
  const author = String(message?.author ?? "").trim();
  if (author) return author;
  if (message?.role === "user") return "Вы";
  if (message?.kind === "subagent") return "Субагент (модель неизвестна)";
  return String(provider ?? "").trim() === "claude" ? "Claude" : "Codex";
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
    const originRequestId = String(message?.origin?.requestId ?? "").trim();
    const directClientUserMessageId = String(message?.clientUserMessageId ?? "").trim();
    const resolvedClientUserMessageId = directClientUserMessageId
      || (originRequestId ? `mcp:${originRequestId}` : "");
    const turnUserSlot = role === "user"
      ? liveTurnUserSlot({ ...message, clientUserMessageId: resolvedClientUserMessageId }, index, {
          prompt,
          clientUserMessageId,
        })
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
      clientUserMessageId: resolvedClientUserMessageId,
      turnUserSlot,
      role,
      author,
      text,
      ...(message?.kind ? { kind: String(message.kind) } : {}),
      ...(message?.agentThreadId ? { agentThreadId: String(message.agentThreadId) } : {}),
      ...(message?.model ? { model: String(message.model) } : {}),
      ...(message?.origin ? { origin: { ...message.origin } } : {}),
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
      && !candidate.origin
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

function receiptLeavesDeferredQueue(receipt) {
  return receipt?.cancelled === true
    || receipt?.accepted === true
    || receipt?.steered === true
    || receipt?.dispatching === true;
}

function latestMaintenanceMessages(messages, limit = 1) {
  const maximum = Math.max(0, Math.trunc(Number(limit) || 0));
  if (!maximum) return [];
  return withoutSupersededCompactionFailures(messages)
    .map((message, index) => ({ message, index, time: Date.parse(message?.time ?? "") }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.time) ? left.time : Number.NEGATIVE_INFINITY;
      const rightTime = Number.isFinite(right.time) ? right.time : Number.NEGATIVE_INFINITY;
      return leftTime - rightTime || left.index - right.index;
    })
    .slice(-maximum)
    .map(({ message }) => message);
}

function receiptUsesDeferredQueue(receipt) {
  return receipt?.deferred === true
    && receipt?.accepted !== true
    && receipt?.dispatching !== true;
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
  const ordered = decorated
    .sort((left, right) => {
      const leftTurnOrder = historyTurnOrders.get(String(left.message?.turnId ?? ""));
      const rightTurnOrder = historyTurnOrders.get(String(right.message?.turnId ?? ""));
      if (Number.isFinite(leftTurnOrder) && Number.isFinite(rightTurnOrder)
        && leftTurnOrder !== rightTurnOrder) {
        return leftTurnOrder - rightTurnOrder;
      }
      const sameTurn = String(left.message?.turnId ?? "")
        && String(left.message?.turnId ?? "") === String(right.message?.turnId ?? "");
      if (sameTurn) {
        const placement = (message) => (
          message?.kind === "maintenance" ? 3
            : message?.role === "user" ? 0
              : message?.kind === "subagent" ? 1
                : 2
        );
        const placementDifference = placement(left.message) - placement(right.message);
        if (placementDifference) return placementDifference;
      }
      if (left.time !== right.time) return left.time - right.time;
      return left.index - right.index;
    })
    .map(({ message }) => message);
  for (const event of ordered.filter((message) => (
    message?.kind === "maintenance"
    && message?.placement === "after-source-turn"
    && String(message?.sourceThreadId ?? "").trim()
  ))) {
    const currentIndex = ordered.indexOf(event);
    ordered.splice(currentIndex, 1);
    const sourceThreadId = String(event.sourceThreadId).trim();
    let anchorIndex = ordered.findLastIndex((message) => (
      String(message?.threadId ?? "").trim() === sourceThreadId
    ));
    if (anchorIndex < 0) {
      ordered.splice(currentIndex, 0, event);
      continue;
    }
    while (
      ordered[anchorIndex + 1]?.kind === "maintenance"
      && ordered[anchorIndex + 1]?.placement === "after-source-turn"
      && String(ordered[anchorIndex + 1]?.sourceThreadId ?? "").trim() === sourceThreadId
    ) anchorIndex += 1;
    ordered.splice(anchorIndex + 1, 0, event);
  }
  return ordered;
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
  let userIndex = 0;
  return visible.map((message) => {
    if (message?.role !== "user") return message;
    const turnUserSlot = String(message?.turnUserSlot ?? "").trim()
      || (userIndex === 0 ? "root" : "steer");
    userIndex += 1;
    return { ...message, turnUserSlot };
  });
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
  const explicitStreamId = String(streamId ?? "").trim();
  const matches = explicitStreamId ? [] : (Array.isArray(tasks) ? tasks : []).filter((task) => (
    String(task?.provider ?? "") === String(provider ?? "")
    && String(task?.threadId ?? "") === String(threadId ?? "")
    && String(task?.streamId ?? "").trim()
  ));
  const inferredStreamId = matches.length === 1
    ? String(matches[0].streamId ?? "").trim()
    : "";
  const stableStreamId = explicitStreamId || inferredStreamId;
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

async function retryConnectionFailure(operation, {
  delaysMs = [],
  wait = (delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)),
  shouldRetry = isConnectionFailure,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const delayMs = delaysMs[attempt];
      if (!shouldRetry(error) || delayMs == null) throw error;
      await wait(Math.max(0, Number(delayMs) || 0));
    }
  }
}

function httpControlError(status, payload = {}) {
  const responseStatus = Number(status) || 0;
  const payloadError = String(payload?.error ?? "").trim();
  const error = new Error(payloadError || `Agent Hub: HTTP ${responseStatus}`);
  if ([502, 503, 504].includes(responseStatus) && !payloadError) {
    error.code = "AGENT_HUB_HTTP_GATEWAY";
    return markConnectionFailure(error);
  }
  return markCommandRejected(error);
}

async function settleOptionalRead(operation) {
  try {
    return { status: "fulfilled", value: await operation() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
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
  const name = String(error?.name ?? "").trim();
  const message = String(error?.message ?? error ?? "").trim();
  return ["ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE", "AGENT_HUB_CONTROL_TIMEOUT"].includes(code)
    || ["AbortError", "TimeoutError"].includes(name)
    || /\b(?:ECONNREFUSED|ECONNRESET|ENOENT|EPIPE)\b[\s\S]*agent-hub-desktop-/iu.test(message)
    || /Agent Hub (?:в VS Code )?не ответил вовремя/iu.test(message)
    || /Desktop control request timed out/iu.test(message)
    || /Desktop control connection closed without a response/iu.test(message);
}

function attachmentOnlyText(attachments) {
  const values = Array.isArray(attachments) ? attachments : [];
  if (!values.length) return "Вложение";
  const taskCount = values.filter((attachment) => attachment?.kind === "task").length;
  if (taskCount === values.length) return "";
  const imageCount = values.filter((attachment) => (
    String(attachment?.type ?? "").toLowerCase().startsWith("image/")
  )).length;
  if (imageCount === values.length) return values.length === 1 ? "Изображение" : "Изображения";
  return values.length === 1 ? "Вложение" : "Вложения";
}

async function stopTaskControls({ cancel, pause, queued = [] }) {
  const result = await cancel();
  const pauses = await Promise.allSettled((Array.isArray(queued) ? queued : []).map((item) => pause(item)));
  return {
    result,
    paused: pauses.filter((item) => item.status === "fulfilled").length,
    pauseFailures: pauses.filter((item) => item.status === "rejected").length,
  };
}

function hubErrorMessage(error) {
  const message = String(error?.message ?? error ?? "Неизвестная ошибка").trim();
  if (String(error?.code ?? "").trim().toUpperCase() === "AGENT_HUB_CONTROL_TIMEOUT") {
    return "Agent Hub не подтвердил приём вовремя. Статус сообщения уточняется.";
  }
  if (looksLikeConnectionFailure(error)) return "Нет связи с Agent Hub.";
  const translations = new Map([
    ["remote attachment not found", "Вложение недоступно. Повторите отправку."],
    ["remote attachment is incomplete", "Вложение загрузилось не полностью. Повторите отправку."],
    ["remote attachment quota exceeded", "Хранилище вложений временно заполнено. Повторите позже."],
  ]);
  return translations.get(message.toLowerCase()) ?? message;
}

globalThis.AgentHubMessageLifecycle = Object.freeze({
  activeRunMessageReceipts,
  activeStageLabel,
  activeTaskRun,
  attachmentOnlyText,
  chronologicalMessages,
  completionCatchUpTurnId,
  completedLiveAnswer,
  completedLiveAgentMessage,
  conversationTaskId,
  completedConversationTurnVisible,
  confirmedOutgoingMessageIds,
  contextProbeRun,
  conversationMessageAuthor,
  deduplicateConversationMessages,
  displayedFinalAcknowledgement,
  embeddedResponseAnnotations,
  hubErrorMessage,
  httpControlError,
  identityKey,
  isConnectionFailure,
  looksLikeConnectionFailure,
  clientIdentityKey,
  focusedTurnAlreadyVisible,
  focusedTurnTaskThreadId,
  historyContainsLatestAnswer,
  historyRefreshSourceRequired,
  historyMatchesIdentity,
  historicalAgentResponseVisible,
  historicalMessagesForDisplay,
  liveCompletionTransition,
  latestAnswerTransition,
  nextHistoryCatchUpDeadline,
  liveMessageMatch,
  markCommandRejected,
  markConnectionFailure,
  messageSendDefinitelyRejected,
  mergeDeferredQueueEntries,
  receiptLeavesDeferredQueue,
  receiptUsesDeferredQueue,
  mergeLiveMaintenance,
  mergeLiveUserMessages,
  mergeTurnMaintenanceMessages,
  latestMaintenanceMessages,
  withoutSupersededCompactionFailures,
  normalizedResponseAnnotations,
  normalizedUserMessage,
  outgoingTaskId,
  mergeReconciledUserMessage,
  reconciledUserMetadataConfirmed,
  responseAnnotationPrompt,
  reconcile,
  rememberBounded,
  retryConnectionFailure,
  reusableAttachmentPaths,
  settleOptionalRead,
  snapshotCompletionCandidate,
  snapshotCompletionReplacement,
  stopTaskControls,
  visibleConversationMessages,
});

})();
