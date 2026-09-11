import { createHash } from "node:crypto";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "interrupted",
  "aborted",
  "cancelled",
  "canceled",
]);

export const STREAM_MESSAGE_PIN_LIMIT = 50;
export const STREAM_MESSAGE_PIN_PREVIEW_CHARS = 320;

function text(value) {
  return String(value ?? "").trim();
}

function messageKey(parts) {
  const digest = createHash("sha256").update(JSON.stringify(parts), "utf8").digest("base64url");
  return `message:v1:${digest}`;
}

export function durableUserCommandItemId(clientUserMessageId) {
  const identity = text(clientUserMessageId);
  return identity ? `user-command:v1:${createHash("sha256")
    .update(JSON.stringify(["user-command-item", identity]), "utf8")
    .digest("base64url")}` : "";
}

function terminalTurn(turn = {}) {
  if (turn.active === true) return false;
  const status = text(turn.status).toLowerCase();
  return turn.completed === true || TERMINAL_STATUSES.has(status);
}

function finalParentAgentIndex(messages) {
  return messages.findLastIndex((message) => (
    text(message?.role) === "agent"
    && text(message?.kind) !== "subagent"
    && !text(message?.agentThreadId)
  ));
}

function sourceAlias({ provider, threadId, turnId, itemId, role }) {
  return JSON.stringify([provider, threadId, turnId, itemId, role]);
}

function durableItemId(message = {}) {
  const itemId = text(message.itemId);
  if (itemId) return itemId;
  return text(message.role) === "user"
    ? durableUserCommandItemId(message.clientUserMessageId)
    : "";
}

export function durableMessageMetadata({
  provider,
  threadId,
  turn = {},
  message = {},
  messageIndex = 0,
  finalAgentIndex = -1,
  canonicalItemId,
} = {}) {
  const normalizedProvider = text(provider).toLowerCase();
  const normalizedThreadId = text(threadId);
  const turnId = text(turn.id ?? turn.turnId);
  const itemId = canonicalItemId === undefined
    ? durableItemId(message)
    : text(canonicalItemId);
  const role = text(message.role);
  const clientUserMessageId = text(message.clientUserMessageId);
  if (!normalizedProvider || !normalizedThreadId || !turnId || !itemId
      || !["user", "agent"].includes(role)) {
    return { pinEligible: false, messageKey: "", sourceAlias: "", semanticSlot: "" };
  }
  const source = sourceAlias({
    provider: normalizedProvider,
    threadId: normalizedThreadId,
    turnId,
    itemId,
    role,
  });
  const terminal = terminalTurn(turn);
  if (!terminal || text(message.kind) === "subagent" || text(message.agentThreadId)) {
    return { pinEligible: false, messageKey: "", sourceAlias: source, semanticSlot: "" };
  }
  if (role === "agent") {
    if (messageIndex !== finalAgentIndex) {
      return { pinEligible: false, messageKey: "", sourceAlias: source, semanticSlot: "" };
    }
    return {
      pinEligible: true,
      messageKey: messageKey(["turn-final", normalizedProvider, normalizedThreadId, turnId]),
      sourceAlias: source,
      semanticSlot: "final",
    };
  }
  if (clientUserMessageId) {
    return {
      pinEligible: true,
      messageKey: messageKey(["user-command", clientUserMessageId]),
      sourceAlias: source,
      semanticSlot: "user-command",
    };
  }
  if ([`${turnId}:prompt`, `${turnId}:focused:user`].includes(itemId)) {
    return {
      pinEligible: true,
      messageKey: messageKey(["turn-prompt", normalizedProvider, normalizedThreadId, turnId]),
      sourceAlias: source,
      semanticSlot: "prompt",
    };
  }
  return {
    pinEligible: true,
    messageKey: messageKey([
      "provider-item",
      normalizedProvider,
      normalizedThreadId,
      turnId,
      itemId,
      role,
    ]),
    sourceAlias: source,
    semanticSlot: "provider-item",
  };
}

export function withDurableMessageMetadata(turn = {}, { provider, threadId } = {}) {
  const messages = Array.isArray(turn.messages) ? turn.messages : [];
  const finalAgentIndex = finalParentAgentIndex(messages);
  const providerItemIds = new Set(messages.map((message) => text(message?.itemId)).filter(Boolean));
  const commandItemIds = messages.map((message) => (
    text(message?.itemId) ? "" : durableItemId(message)
  ));
  const commandItemIdCounts = new Map();
  for (const itemId of commandItemIds.filter(Boolean)) {
    commandItemIdCounts.set(itemId, (commandItemIdCounts.get(itemId) ?? 0) + 1);
  }
  return {
    ...turn,
    messages: messages.map((message, messageIndex) => {
      const providerItemId = text(message?.itemId);
      const commandItemId = commandItemIds[messageIndex];
      const canonicalItemId = providerItemId || (
        commandItemId
        && !providerItemIds.has(commandItemId)
        && commandItemIdCounts.get(commandItemId) === 1
          ? commandItemId
          : ""
      );
      const canonicalMessage = { ...message, itemId: canonicalItemId };
      return {
        ...canonicalMessage,
        ...durableMessageMetadata({
          provider,
          threadId,
          turn,
          message: canonicalMessage,
          messageIndex,
          finalAgentIndex,
          canonicalItemId,
        }),
      };
    }),
  };
}

export function indexedDurableMessageMetadata(message = {}) {
  const provider = text(message.provider).toLowerCase();
  const threadId = text(message.threadId);
  const turnId = text(message.turnId);
  const itemId = text(message.itemId);
  const role = text(message.role);
  const source = sourceAlias({ provider, threadId, turnId, itemId, role });
  const explicit = indexedExplicitMetadata({ provider, threadId, turnId, itemId, role }, message);
  if (explicit) return explicit;
  if (indexedMetadataPresent(message)) {
    return { pinEligible: false, messageKey: "", sourceAlias: source, semanticSlot: "" };
  }
  const semanticSlot = role === "user" && itemId === `${turnId}:prompt`
    ? "prompt"
    : role === "agent" && itemId === `${turnId}:answer`
      ? "final"
      : "";
  if (!provider || !threadId || !turnId || !itemId || !semanticSlot) {
    return { pinEligible: false, messageKey: "", sourceAlias: source, semanticSlot: "" };
  }
  return {
    pinEligible: true,
    messageKey: messageKey([
      semanticSlot === "final" ? "turn-final" : "turn-prompt",
      provider,
      threadId,
      turnId,
    ]),
    sourceAlias: source,
    semanticSlot,
  };
}

function indexedMetadataPresent(message = {}) {
  return Boolean(
    text(message.messageKey)
    || text(message.sourceAlias)
    || text(message.semanticSlot)
    || text(message.clientUserMessageId),
  );
}

function indexedExplicitMetadata(identity, metadata = {}) {
  const { provider, threadId, turnId, itemId, role } = identity;
  if (!provider || !threadId || !turnId || !itemId || !["user", "agent"].includes(role)) return null;
  for (const [key, expected] of Object.entries(identity)) {
    const actual = text(metadata[key]);
    if (actual && actual !== expected) return null;
  }
  const semanticSlot = text(metadata.semanticSlot);
  const storedMessageKey = text(metadata.messageKey);
  const storedSourceAlias = text(metadata.sourceAlias);
  const clientUserMessageId = text(metadata.clientUserMessageId);
  const expectedSourceAlias = sourceAlias(identity);
  let expectedMessageKey = "";
  if (semanticSlot === "user-command" && role === "user" && clientUserMessageId) {
    expectedMessageKey = messageKey(["user-command", clientUserMessageId]);
  } else if (semanticSlot === "prompt" && role === "user") {
    expectedMessageKey = messageKey(["turn-prompt", provider, threadId, turnId]);
  } else if (semanticSlot === "final" && role === "agent") {
    expectedMessageKey = messageKey(["turn-final", provider, threadId, turnId]);
  } else if (semanticSlot === "provider-item" && role === "user") {
    expectedMessageKey = messageKey(["provider-item", provider, threadId, turnId, itemId, role]);
  }
  if (!expectedMessageKey || storedMessageKey !== expectedMessageKey
      || storedSourceAlias !== expectedSourceAlias) return null;
  return {
    pinEligible: true,
    messageKey: storedMessageKey,
    sourceAlias: storedSourceAlias,
    semanticSlot,
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
  };
}

export function indexedDurableMessageMetadataWithEvidence(message = {}, evidence = {}) {
  const persisted = indexedDurableMessageMetadata(message);
  if (persisted.pinEligible === true || indexedMetadataPresent(message)) return persisted;
  const recovered = indexedExplicitMetadata({
    provider: text(message.provider).toLowerCase(),
    threadId: text(message.threadId),
    turnId: text(message.turnId),
    itemId: text(message.itemId),
    role: text(message.role),
  }, evidence);
  return recovered ?? persisted;
}

export function streamMessagePinPreview({ text: sourceText, attachments = [], attachmentNames = [] } = {}) {
  const plain = String(sourceText ?? "")
    .replace(/```[\s\S]*?```/gu, (block) => block.replace(/^```[^\n]*|```$/gu, ""))
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/(^|\s)[#>*_~`-]+(?=\S)/gu, "$1")
    .replace(/[*_~`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (plain) {
    return plain.length <= STREAM_MESSAGE_PIN_PREVIEW_CHARS
      ? plain
      : `${plain.slice(0, STREAM_MESSAGE_PIN_PREVIEW_CHARS - 1).trimEnd()}…`;
  }
  const values = [
    ...(Array.isArray(attachments) ? attachments : []),
    ...(Array.isArray(attachmentNames) ? attachmentNames.map((name) => ({ name })) : []),
  ];
  const named = values.map((attachment) => text(attachment?.name)).find(Boolean);
  if (named) return named.slice(0, STREAM_MESSAGE_PIN_PREVIEW_CHARS);
  return values.some((attachment) => text(attachment?.type).toLowerCase().startsWith("image/"))
    ? "Изображение"
    : "Вложение";
}
