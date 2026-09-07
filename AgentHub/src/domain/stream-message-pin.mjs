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

export function durableMessageMetadata({
  provider,
  threadId,
  turn = {},
  message = {},
  messageIndex = 0,
  finalAgentIndex = -1,
} = {}) {
  const normalizedProvider = text(provider).toLowerCase();
  const normalizedThreadId = text(threadId);
  const turnId = text(turn.id ?? turn.turnId);
  const itemId = text(message.itemId);
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
  return {
    ...turn,
    messages: messages.map((message, messageIndex) => ({
      ...message,
      ...durableMessageMetadata({
        provider,
        threadId,
        turn,
        message,
        messageIndex,
        finalAgentIndex,
      }),
    })),
  };
}

export function indexedDurableMessageMetadata(message = {}) {
  const provider = text(message.provider).toLowerCase();
  const threadId = text(message.threadId);
  const turnId = text(message.turnId);
  const itemId = text(message.itemId);
  const role = text(message.role);
  const semanticSlot = role === "user" && itemId === `${turnId}:prompt`
    ? "prompt"
    : role === "agent" && itemId === `${turnId}:answer`
      ? "final"
      : "";
  if (!provider || !threadId || !turnId || !itemId || !semanticSlot) {
    return { pinEligible: false, messageKey: "", sourceAlias: sourceAlias({ provider, threadId, turnId, itemId, role }), semanticSlot: "" };
  }
  return {
    pinEligible: true,
    messageKey: messageKey([
      semanticSlot === "final" ? "turn-final" : "turn-prompt",
      provider,
      threadId,
      turnId,
    ]),
    sourceAlias: sourceAlias({ provider, threadId, turnId, itemId, role }),
    semanticSlot,
  };
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
