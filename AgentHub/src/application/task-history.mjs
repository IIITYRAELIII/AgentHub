import { createHash } from "node:crypto";
import { codexSubagentActivity } from "../domain/run-activity.mjs";
import {
  interstreamOriginAuthor,
  normalizeInterstreamOrigin,
  trustedInterstreamMessageDetails,
} from "../domain/interstream-message.mjs";
import {
  isClaudeInterruptEntry,
  isClaudeSyntheticUserEntry,
  claudeTransportPromptDetails,
  withoutClaudeResumePreludes,
} from "../domain/claude-transcript.mjs";
import { taskReferencePromptDetails } from "../domain/task-board-task.mjs";
import { codexAssistantResponseProjection } from "../domain/codex-response-annotation.mjs";
import { normalizedResponseAnnotations } from "../domain/response-annotation-source.mjs";
import {
  codexTerminalFailure,
  mergeProviderTerminalFailure,
  normalizeProviderTerminalFailure,
} from "../domain/provider-terminal-failure.mjs";
import {
  hasCanonicalUserMessages,
  mergedUserMessageSnapshotAuthority,
  mergeCanonicalUserMessages,
  userMessageSnapshotAuthority,
} from "../domain/canonical-user-messages.mjs";

export const EMPTY_TURN_COMPLETION_TEXT = "Ход завершён без текстового ответа.";

export function withoutMisclassifiedSubagentUsers(currentMessages, observedMessages) {
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const observed = Array.isArray(observedMessages) ? observedMessages : [];
  const occurrences = (messages) => {
    const grouped = new Map();
    for (const message of messages) {
      const identity = String(message?.sourceOccurrenceId ?? "").trim();
      if (!/^(?:codex-rollout|codex-app-server):[0-9a-f]{64}$/u.test(identity)) continue;
      const values = grouped.get(identity) ?? [];
      values.push(message);
      grouped.set(identity, values);
    }
    return grouped;
  };
  const currentOccurrences = occurrences(current);
  const observedOccurrences = occurrences(observed);
  const unbound = (message) => ![message?.clientUserMessageId, message?.clientId, message?.submissionId]
    .some((value) => String(value ?? "").trim());
  return current.filter((message) => {
    if (message?.role !== "user" || !unbound(message) || message.origin || message.messageOrigin) return true;
    const identity = String(message.sourceOccurrenceId ?? "").trim();
    const evidence = observedOccurrences.get(identity);
    if (currentOccurrences.get(identity)?.length !== 1 || evidence?.length !== 1) return true;
    const [subagent] = evidence;
    return subagent.role !== "agent" || subagent.kind !== "subagent"
      || !String(subagent.agentThreadId ?? "").trim() || !unbound(subagent);
  });
}

function codexSubagentModelName(value) {
  const model = String(value ?? "").trim();
  if (!model) return "";
  const family = /(?:^|[-_/])(sol|terra|luna)(?:$|[-_/])/iu.exec(model)?.[1];
  if (family) return `${family[0].toUpperCase()}${family.slice(1).toLowerCase()}`;
  return model.replace(/^gpt-/iu, "GPT-");
}

export function codexSubagentAuthor(model) {
  const name = codexSubagentModelName(model);
  return name ? `Субагент (${name})` : "Субагент (модель неизвестна)";
}

export function codexSubagentNotificationDetails(value, { model = "" } = {}) {
  const text = String(value ?? "").trim();
  const match = /^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/iu.exec(text);
  if (!match) return null;
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return {
      agentThreadId: "",
      author: codexSubagentAuthor(model),
      kind: "subagent",
      model: String(model ?? "").trim(),
      text: "Субагент завершил работу, но его ответ не удалось прочитать.",
    };
  }
  const status = payload?.status && typeof payload.status === "object" ? payload.status : {};
  const statusText = Object.values(status)
    .map((item) => typeof item === "string" ? item.trim() : "")
    .find(Boolean) ?? "Субагент завершил работу без текстового ответа.";
  const exactModel = String(model || payload?.model || "").trim();
  return {
    agentThreadId: String(payload?.agent_path ?? payload?.agent_thread_id ?? "").trim(),
    author: codexSubagentAuthor(exactModel),
    kind: "subagent",
    model: exactModel,
    text: statusText,
  };
}

export function isEmptyTurnCompletionPlaceholder(turn = {}) {
  const prompt = String(turn.prompt ?? turn.promptPreview ?? "").trim();
  const answer = String(turn.answer ?? turn.finalAnswer ?? turn.text ?? "").trim();
  const userMessages = [
    ...(Array.isArray(turn.userMessages) ? turn.userMessages : []),
    ...(Array.isArray(turn.messages)
      ? turn.messages.filter((message) => message?.role === "user")
      : []),
  ];
  const hasUserMessage = userMessages.some((message) => (
    String(message?.text ?? "").trim()
    || (Array.isArray(message?.attachments) && message.attachments.length)
  ));
  return !prompt && !hasUserMessage && answer === EMPTY_TURN_COMPLETION_TEXT;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => ["text", "input_text"].includes(String(item?.type ?? "")) && String(item.text ?? "").trim())
    .map((item) => String(item.text).trim())
    .join("\n")
    .trim();
}

function messageItemId(turnId, role, item, index) {
  const exact = String(item?.id ?? "").trim();
  return exact || `${String(turnId ?? "turn")}:${role}:${index}`;
}

export function exactTurnReceiptBindings(messages, receipts) {
  const values = Array.isArray(messages) ? messages : [];
  const turnReceipts = (Array.isArray(receipts) ? receipts : [])
    .filter((receipt) => String(receipt?.clientUserMessageId ?? "").trim());
  const receiptByClientId = new Map(turnReceipts.map((receipt) => [
    String(receipt.clientUserMessageId).trim(),
    receipt,
  ]));
  const bindings = new Map();

  values.forEach((message, index) => {
    if (String(message?.role ?? "") !== "user") return;
    const clientUserMessageId = String(message?.clientUserMessageId ?? "").trim();
    const receipt = receiptByClientId.get(clientUserMessageId);
    if (receipt) {
      bindings.set(index, receipt);
    }
  });
  return bindings;
}

function codexAppServerOccurrenceId(turnId, item, index) {
  if (!turnId || !Number.isSafeInteger(index) || index < 0) return "";
  const sourceRecord = JSON.stringify({
    type: item?.type ?? null,
    id: item?.id ?? null,
    content: item?.content ?? null,
    createdAt: item?.createdAt ?? null,
  });
  return `codex-app-server:${createHash("sha256")
    .update(turnId)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(sourceRecord)
    .digest("hex")}`;
}

function inlineImageAttachments(value) {
  const source = String(value ?? "");
  return [...source.matchAll(/<image\b([^>]*)>\s*(?:<\/image>)?/giu)]
    .map((match) => {
      const attributes = String(match[1] ?? "");
      const pathMatch = attributes.match(/\bpath="([^"]+)"/iu);
      const nameMatch = attributes.match(/\bname=\[([^\]]+)\]/iu);
      return {
        name: String(nameMatch?.[1] ?? "").trim(),
        path: String(pathMatch?.[1] ?? "").trim(),
      };
    })
    .filter((item) => item.path);
}

function stripInlineImageTags(value) {
  return String(value ?? "")
    .replace(/<image\b[^>]*>\s*(?:<\/image>)?/giu, "")
    .trim();
}

function stripUserServiceMarkup(value) {
  return stripInlineImageTags(value)
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();
}

function uniquePathAttachments(values) {
  const known = new Set();
  return values.filter((item) => {
    const key = String(item?.path ?? "").trim().toLowerCase();
    if (!key || known.has(key)) return false;
    known.add(key);
    return true;
  });
}

export function withoutCodexInspectionAttachments(history) {
  return (Array.isArray(history) ? history : []).map((turn) => ({
    ...turn,
    messages: (Array.isArray(turn?.messages) ? turn.messages : []).map((message) => {
      if (message?.role !== "agent") return { ...message };
      const next = { ...message };
      for (const field of ["attachments", "attachmentSources"]) {
        const values = (Array.isArray(message?.[field]) ? message[field] : []).filter((item) => (
          item?.type !== "view-path"
          && !String(item?.id ?? "").startsWith("codex-viewed-")
        ));
        if (values.length) next[field] = values.map((item) => ({ ...item }));
        else delete next[field];
      }
      return next;
    }),
  }));
}

function desktopPromptEnvelope(value) {
  const source = String(value ?? "").trim();
  const heading = /^# Files mentioned by the user:\s*$/im;
  const headingMatch = heading.exec(source);
  if (!headingMatch || headingMatch.index !== 0) return null;

  const request = /^## My request(?: for Codex)?:\s*$/im;
  const requestMatch = request.exec(source);
  if (!requestMatch || requestMatch.index <= headingMatch.index) return null;

  const filesBlock = source.slice(headingMatch[0].length, requestMatch.index);
  const fileAttachments = [...filesBlock.matchAll(/^##\s+([^:\r\n]+):\s*(.+?)\s*$/gmu)]
    .map((match) => ({
      name: String(match[1] ?? "").trim(),
      path: String(match[2] ?? "").trim(),
    }))
    .filter((item) => item.path);
  const requestText = source.slice(requestMatch.index + requestMatch[0].length);
  const attachments = uniquePathAttachments([
    ...fileAttachments,
    ...inlineImageAttachments(requestText),
  ]);
  const attachmentPaths = attachments.map((item) => item.path);
  const text = stripInlineImageTags(requestText);
  return { text, attachments, attachmentPaths };
}

function codexAttachmentSources(content, envelope, rawText = "") {
  if (envelope?.attachments.length) {
    return envelope.attachments.map((item) => ({ type: "path", value: item.path, name: item.name }));
  }
  const values = (Array.isArray(content) ? content : []).flatMap((item) => {
    if (item?.type === "localImage" && String(item.path ?? "").trim()) {
      return [{ type: "path", value: String(item.path).trim() }];
    }
    const dataUrl = String(item?.url ?? item?.image_url ?? "");
    if (
      ["image", "input_image"].includes(String(item?.type ?? ""))
      && dataUrl.startsWith("data:image/")
    ) {
      return [{ type: "data", value: dataUrl }];
    }
    return [];
  });
  values.push(...inlineImageAttachments(rawText).map((item) => ({
    type: "path",
    value: item.path,
    ...(item.name ? { name: item.name } : {}),
  })));
  const known = new Set();
  return values.filter((item) => {
    const key = `${item.type}\0${String(item.value ?? "").toLowerCase()}`;
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
}

function normalizedTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function itemFailed(item) {
  const status = String(item?.status ?? "").toLowerCase();
  return ["failed", "error", "declined", "rejected"].includes(status)
    || (Number.isInteger(item?.exitCode) && item.exitCode !== 0)
    || Boolean(item?.error);
}

function activityFromCodexItem(item, index) {
  const id = `item:${String(item?.id ?? index)}`;
  if (item?.type === "commandExecution") return {
    id, type: "command", label: itemFailed(item) ? "Команда завершилась с ошибкой" : "Команда выполнена",
    detail: String(item.command ?? "").replace(/\s+/gu, " ").slice(0, 500),
    status: itemFailed(item) ? "failed" : "completed",
  };
  if (item?.type === "fileChange") {
    const detail = (item.changes ?? item.files ?? [])
      .map((change) => String(change?.path ?? change ?? "").trim()).filter(Boolean).join(", ").slice(0, 500);
    return {
      id, type: "file",
      label: itemFailed(item) ? "Изменение файлов не выполнено" : "Файлы изменены",
      detail,
      status: itemFailed(item) ? "failed" : "completed",
    };
  }
  if (item?.type === "mcpToolCall" || item?.type === "dynamicToolCall") {
    const detail = item.type === "mcpToolCall"
      ? `${item.server ?? "MCP"}/${item.tool ?? ""}`
      : String(item.tool ?? "");
    return { id, type: "tool", label: "Инструмент завершён", detail, status: item.error ? "failed" : "completed" };
  }
  if (item?.type === "webSearch") return {
    id, type: "tool", label: "Поиск завершён", detail: String(item.query ?? "").slice(0, 500), status: "completed",
  };
  if (item?.type === "contextCompaction") return {
    id, type: "compaction", label: "Контекст свёрнут", detail: "", status: "completed",
  };
  if (item?.type === "userMessage" || item?.type === "agentMessage" || item?.type === "plan") return null;
  const subagent = codexSubagentActivity(item, true);
  if (subagent) return { id, ...subagent };
  return null;
}

function codexReasoningText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(codexReasoningText).filter(Boolean).join("\n\n");
  if (!value || typeof value !== "object") return "";
  return codexReasoningText(value.text ?? value.content ?? value.summary ?? "");
}

function codexVisibleReasoning(item) {
  if (item?.type === "reasoning") {
    return codexReasoningText(item.summary) || codexReasoningText(item.content);
  }
  if (item?.type !== "agentMessage") return "";
  const phase = String(item.phase ?? "").trim();
  if (!["analysis", "commentary", "reasoning"].includes(phase)) return "";
  return String(item.text ?? "").trim();
}

function isCodexAnswerItem(item) {
  return (item?.type === "agentMessage" || item?.type === "plan")
    && !(Array.isArray(item.questions) && item.questions.length);
}

function codexAnswerPhase(item) {
  return item?.type === "plan" ? "final_answer" : String(item?.phase ?? "");
}

export function codexTurnActivityGroups(turn) {
  const groups = [];
  let current = null;
  for (const [index, item] of (Array.isArray(turn?.items) ? turn.items : []).entries()) {
    const reasoning = codexVisibleReasoning(item);
    if (reasoning) {
      current = {
        id: `${item?.type === "agentMessage" ? "commentary" : "reasoning"}:${String(item.id ?? index)}`,
        reasoning,
        activities: [],
      };
      groups.push(current);
      continue;
    }
    const activity = activityFromCodexItem(item, index);
    if (!activity) continue;
    if (!current) {
      current = { id: `activity:${String(item?.id ?? index)}`, reasoning: "", activities: [] };
      groups.push(current);
    }
    current.activities.push(activity);
  }
  return groups;
}

export function codexTurnActivities(turn) {
  return (Array.isArray(turn?.items) ? turn.items : [])
    .map(activityFromCodexItem)
    .filter(Boolean);
}

export function mergeSyntheticRolloutUsers(messages) {
  // Raw rollout and App Server items remain separate until a downstream owner
  // has an exact client command identity or collision-safe source occurrence.
  // This compatibility helper deliberately performs no content, timestamp,
  // provider-item, or ordinal reconciliation.
  return Array.isArray(messages) ? messages : [];
}

function codexTurnMessages(turn, { userAuthor = "" } = {}) {
  const turnId = String(turn?.id ?? "").trim();
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const subagentModels = new Map(items.flatMap((item) => (
    item?.type === "collabAgentToolCall" && item?.tool === "spawnAgent"
      ? (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).map((threadId) => (
        [String(threadId ?? "").trim(), String(item.model ?? "").trim()]
      ))
      : []
  )).filter(([threadId]) => threadId));
  const messages = items.flatMap((item, index) => {
    if (item?.type === "userMessage") {
      const rawText = textContent(item.content);
      const clientUserMessageId = String(item.clientId ?? "").trim();
      const rawNotification = codexSubagentNotificationDetails(rawText);
      const notification = rawNotification && codexSubagentNotificationDetails(rawText, {
        model: subagentModels.get(rawNotification.agentThreadId) ?? rawNotification.model,
      });
      if (notification) return [{
        itemId: messageItemId(turnId, "agent", item, index),
        role: "agent",
        ...notification,
        ...(normalizedTimestamp(item.createdAt ?? turn?.completedAt ?? turn?.updatedAt)
          ? { time: normalizedTimestamp(item.createdAt ?? turn?.completedAt ?? turn?.updatedAt) }
          : {}),
      }];
      const envelope = desktopPromptEnvelope(rawText);
      const taskReferences = userTaskReferencePromptDetails(rawText)?.references ?? [];
      const attachmentSources = codexAttachmentSources(item.content, envelope, rawText);
      const responseAnnotations = responseAnnotationDetails(rawText);
      const text = displayUserPrompt(rawText)
        || (attachmentSources.length ? (envelope ? "Вложение" : "Изображение") : "");
      const author = String(userAuthor).trim();
      return text || taskReferences.length ? [{
        itemId: messageItemId(turnId, "user", item, index),
        ...(clientUserMessageId
          ? { clientUserMessageId }
          : {}),
        // App Server may expose clientId only after the same provider item was
        // first observed. Keep its collision-safe source occurrence across
        // that enrichment so the canonical owner can replace, not append, it.
        sourceOccurrenceId: codexAppServerOccurrenceId(turnId, item, index),
        role: "user",
        text,
        ...(author ? { author } : {}),
        ...(responseAnnotations?.items.length
          ? {
            responseAnnotations: responseAnnotations.items.map((annotation) => ({ ...annotation })),
            responseAnnotationRequest: responseAnnotations.request,
          }
          : {}),
        ...(attachmentSources.length
          ? { attachmentSources }
          : {}),
        ...(taskReferences.length
          ? { attachments: taskReferences.map((reference) => ({ ...reference })) }
          : {}),
        ...(normalizedTimestamp(item.createdAt ?? turn?.startedAt ?? turn?.createdAt)
          ? { time: normalizedTimestamp(item.createdAt ?? turn?.startedAt ?? turn?.createdAt) }
          : {}),
      }] : [];
    }
    if (isCodexAnswerItem(item) && String(item.text ?? "").trim()) {
      const projection = codexAssistantResponseProjection(item.text);
      return [{
        itemId: messageItemId(turnId, "agent", item, index),
        role: "agent",
        text: projection.text.trim(),
        ...(projection.responseAnnotationReferences.length
          ? { responseAnnotationReferences: projection.responseAnnotationReferences }
          : {}),
        phase: codexAnswerPhase(item),
        ...(normalizedTimestamp(item.createdAt ?? turn?.completedAt ?? turn?.updatedAt)
          ? { time: normalizedTimestamp(item.createdAt ?? turn?.completedAt ?? turn?.updatedAt) }
          : {}),
      }];
    }
    return [];
  });
  return mergeSyntheticRolloutUsers(messages, turnId);
}

export function responseAnnotationDetails(value) {
  const text = String(value ?? "");
  const block = text.match(/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/i);
  if (!block) return null;

  let annotations = [];
  try {
    const parsed = JSON.parse(block[1]);
    if (Array.isArray(parsed)) annotations = parsed;
  } catch {
    // A malformed annotation container falls back to the explicit request text.
  }

  const items = normalizedResponseAnnotations(annotations);
  const comments = items.flatMap((item, index) => (
    item.annotation ? [{ index: index + 1, annotation: item.annotation }] : []
  ));
  const requestTail = text.slice((block.index ?? 0) + block[0].length);
  const request = stripUserServiceMarkup(requestTail
    .replace(/^\s*##\s*My request(?: for Codex)?:\s*/i, ""));
  const selections = items
    .map((item) => item.text)
    .filter(Boolean);
  const annotationText = comments.length === 1
    ? comments[0].annotation
    : comments
      .map((item) => `Аннотация ${item.index}: ${item.annotation}`)
      .join("\n");
  const selectedText = !annotationText && !request
    ? selections.length === 1
      ? `Выделено: ${selections[0]}`
      : selections.map((selection, index) => `Выделено ${index + 1}: ${selection}`).join("\n")
    : "";
  const displayText = [annotationText, selectedText, request]
    .filter(Boolean)
    .join("\n\n")
    .trim() || "Аннотация к предыдущему ответу";
  return { items, request, displayText };
}

function responseAnnotationPrompt(value) {
  return responseAnnotationDetails(value)?.displayText ?? null;
}

function isCodexInternalPromptEnvelope(value) {
  const text = String(value ?? "").trim();
  return [
    "<codex_internal_context",
    "<skills_instructions>",
    "<recommended_plugins>",
    "# AGENTS.md instructions for ",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<apps_instructions>",
    "<plugins_instructions>",
  ].some((prefix) => text.startsWith(prefix));
}

export function displayUserPrompt(value) {
  let text = unwrappedUserPrompt(value);
  if (codexSubagentNotificationDetails(text)) return "";
  if (isCodexInternalPromptEnvelope(text)) return "";
  const taskReferencePrompt = taskReferencePromptDetails(text);
  if (taskReferencePrompt) text = taskReferencePrompt.displayText;
  const telegramReplyMarker = "\nТекст пользователя:\n";
  const telegramReplyAt = text.lastIndexOf(telegramReplyMarker);
  if (telegramReplyAt >= 0) text = text.slice(telegramReplyAt + telegramReplyMarker.length).trim();
  text = stripUserServiceMarkup(text);
  if (/^<turn_aborted>\s*[\s\S]*?\s*<\/turn_aborted>$/iu.test(text)) return "";
  const annotated = responseAnnotationPrompt(text);
  if (annotated !== null) return annotated;
  return text;
}

function unwrappedUserPrompt(value) {
  let text = String(value ?? "").trim();
  const envelope = desktopPromptEnvelope(text);
  if (envelope) text = envelope.text;
  return text;
}

export function userTaskReferencePromptDetails(value) {
  return taskReferencePromptDetails(unwrappedUserPrompt(value));
}

export function codexExplicitFinalTurnAnswer(turn) {
  const explicitFinal = (turn?.items ?? [])
    .filter((item) => isCodexAnswerItem(item) && String(item.text ?? "").trim());
  return codexAssistantResponseProjection(explicitFinal.findLast((item) => (
    ["final", "final_answer", "finalAnswer"].includes(codexAnswerPhase(item))
  ))?.text ?? "").text.trim();
}

export function codexFinalTurnAnswer(turn) {
  const explicitFinal = codexExplicitFinalTurnAnswer(turn);
  if (explicitFinal) return explicitFinal;
  const messages = (turn?.items ?? [])
    .filter((item) => isCodexAnswerItem(item) && String(item.text ?? "").trim()
      && !codexAnswerPhase(item).trim());
  return codexAssistantResponseProjection(messages.at(-1)?.text ?? "").text.trim();
}

export function codexTurnHasExplicitFinalAnswer(turn) {
  return Boolean(codexExplicitFinalTurnAnswer(turn));
}

export function codexThreadHistory(turns, options = {}) {
  return (Array.isArray(turns) ? turns : []).flatMap((turn) => {
    const messages = codexTurnMessages(turn, options);
    const activityGroups = codexTurnActivityGroups(turn);
    const userMessage = messages.find((item) => item.role === "user");
    const prompt = userMessage?.text ?? "";
    if (!userMessage) return [];
    const visibleAnswer = messages
      .filter((item) => item.role === "agent")
      .map((item) => item.text)
      .join("\n\n")
      .trim();
    const answer = turn?.status === "completed"
      ? codexFinalTurnAnswer(turn)
      : visibleAnswer;
    const status = String(turn?.status ?? "");
    const terminal = ["completed", "failed", "cancelled", "aborted"].includes(status.toLowerCase());
    const terminalFailure = codexTerminalFailure(turn, status);
    return [{
      id: String(turn?.id ?? ""),
      userMessageSnapshotAuthority: "complete",
      prompt,
      answer,
      status,
      active: turn?.status === "inProgress",
      completed: terminal,
      ...(terminalFailure ? { terminalFailure } : {}),
      ...(userMessage?.responseAnnotations?.length
        ? {
          promptAnnotations: userMessage.responseAnnotations.map((annotation) => ({ ...annotation })),
          promptRequest: userMessage.responseAnnotationRequest ?? "",
        }
        : {}),
      ...(normalizedTimestamp(turn?.startedAt ?? turn?.createdAt)
        ? { startedAt: normalizedTimestamp(turn?.startedAt ?? turn?.createdAt) }
        : {}),
      ...(normalizedTimestamp(turn?.completedAt ?? turn?.updatedAt)
        ? { completedAt: normalizedTimestamp(turn?.completedAt ?? turn?.updatedAt) }
        : {}),
      messages,
      activities: codexTurnActivities(turn),
      ...(activityGroups.length ? { activityGroups } : {}),
    }];
  });
}

function claudeEntries(text) {
  return String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function claudeAssistantText(entries) {
  return entries
    .filter((entry) => entry?.type === "assistant" && entry.message?.role === "assistant")
    .flatMap((entry) => Array.isArray(entry.message?.content)
      ? entry.message.content
      : [{ type: "text", text: entry.message?.content }])
    .filter((block) => block?.type === "text" && String(block.text ?? "").trim())
    .map((block) => String(block.text).trim())
    .join("\n\n")
    .trim();
}

function claudeUserPromptDetails(entry) {
  if (entry?.type !== "user" || entry.message?.role !== "user") return null;
  /* Продолжение после свёртки, преамбула локальных команд и сами слэш-команды
     приходят как user-записи транскрипта. Показывать их как сообщения
     пользователя нельзя: он их не писал. */
  if (isClaudeSyntheticUserEntry(entry)) return null;
  const rawText = textContent(entry.message?.content);
  const transport = claudeTransportPromptDetails(rawText);
  const clientUserMessageId = String(
    entry.clientUserMessageId ?? entry.message?.clientUserMessageId ?? "",
  ).trim();
  return {
    text: displayUserPrompt(transport.text),
    clientUserMessageId,
    taskReferences: userTaskReferencePromptDetails(transport.text)?.references ?? [],
    attachmentSources: transport.attachmentSources,
  };
}

function claudeUserPrompt(entry) {
  return claudeUserPromptDetails(entry)?.text ?? "";
}

function claudeUserPromptVisible(entry) {
  const details = claudeUserPromptDetails(entry);
  return Boolean(details && (details.text || details.taskReferences.length));
}

/* Запрос, отправленный в прерванный ход, продолжает тот же ход: между ним и
   предыдущим запросом стоит маркер прерывания, а не ответ модели. */
function claudeSteerContinuation(entries, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const entry = entries[cursor];
    if (isClaudeInterruptEntry(entry)) return true;
    if (entry?.type === "assistant" && entry.message?.stop_reason === "end_turn") return false;
    if (claudeUserPromptVisible(entry)) return false;
  }
  return false;
}

function claudeUserHistoryMessage(entry, index) {
  const userPrompt = claudeUserPromptDetails(entry);
  return {
    itemId: String(entry?.uuid ?? `${index}:user`),
    ...(userPrompt?.clientUserMessageId
      ? { clientUserMessageId: userPrompt.clientUserMessageId }
      : {}),
    role: "user",
    text: userPrompt?.text ?? "",
    ...(userPrompt?.taskReferences.length
      ? { attachments: userPrompt.taskReferences.map((reference) => ({ ...reference })) }
      : {}),
    ...(userPrompt?.attachmentSources.length
      ? { attachmentSources: userPrompt.attachmentSources.map((source) => ({ ...source })) }
      : {}),
    ...(normalizedTimestamp(entry?.timestamp) ? { time: normalizedTimestamp(entry?.timestamp) } : {}),
  };
}

export function claudeTranscriptHistory(text) {
  const entries = withoutClaudeResumePreludes(claudeEntries(text));
  const userIndexes = entries
    .map((entry, index) => (
      claudeUserPromptVisible(entry) && !claudeSteerContinuation(entries, index) ? index : -1
    ))
    .filter((index) => index >= 0);
  return userIndexes.map((entryIndex, historyIndex) => {
    const userPrompt = claudeUserPromptDetails(entries[entryIndex]);
    const nextUserIndex = userIndexes[historyIndex + 1] ?? entries.length;
    const turnEntries = entries.slice(entryIndex + 1, nextUserIndex);
    const completed = turnEntries.some((entry) => entry?.type === "last-prompt")
      || turnEntries.some((entry) => (
        entry?.type === "assistant" && entry.message?.stop_reason === "end_turn"
      ));
    const activities = turnEntries.flatMap((entry, index) => {
      const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
      return blocks.flatMap((block, blockIndex) => block?.type === "tool_use" ? [{
        id: `claude-tool:${String(block.id ?? `${index}:${blockIndex}`)}`,
        type: "tool",
        label: "Инструмент завершён",
        detail: String(block.name ?? "").slice(0, 500),
        status: "completed",
      }] : []);
    });
    return {
      id: String(entries[entryIndex]?.uuid ?? entryIndex),
      userMessageSnapshotAuthority: "complete",
      prompt: userPrompt?.text ?? "",
      answer: claudeAssistantText(turnEntries),
      status: completed ? "completed" : "inProgress",
      active: !completed,
      completed,
      ...(normalizedTimestamp(entries[entryIndex]?.timestamp)
        ? { startedAt: normalizedTimestamp(entries[entryIndex]?.timestamp) }
        : {}),
      ...(normalizedTimestamp(turnEntries.map((entry) => entry?.timestamp).filter(Boolean).at(-1))
        ? {
          completedAt: normalizedTimestamp(
            turnEntries.map((entry) => entry?.timestamp).filter(Boolean).at(-1),
          ),
        }
        : {}),
      activities,
      messages: [
        claudeUserHistoryMessage(entries[entryIndex], entryIndex),
        ...turnEntries.flatMap((entry, index) => {
          if (claudeUserPromptVisible(entry)) {
            return [{ ...claudeUserHistoryMessage(entry, entryIndex + 1 + index), turnUserSlot: "steer" }];
          }
          if (entry?.type !== "assistant" || entry.message?.role !== "assistant") return [];
          const assistantText = textContent(entry.message?.content);
          return assistantText ? [{
            itemId: String(entry.uuid ?? `${entryIndex}:agent:${index}`),
            role: "agent",
            text: assistantText,
            ...(normalizedTimestamp(entry.timestamp)
              ? { time: normalizedTimestamp(entry.timestamp) }
              : {}),
          }] : [];
        }),
      ],
    };
  });
}

export function visibleTaskHistory(history, count = 1, { completedOnly = false } = {}) {
  const values = (Array.isArray(history) ? history : [])
    .filter((item) => !completedOnly || item.completed);
  const safeCount = Math.max(1, Math.min(Number(count) || 1, values.length || 1));
  return {
    items: values.slice(-safeCount),
    shown: Math.min(safeCount, values.length),
    total: values.length,
    hasMore: values.length > safeCount,
    nextCount: Math.min(values.length, safeCount + 1),
  };
}

export function mergeCompletedTaskHistory(history, completedTurn = {}, {
  matchSingleActive = true,
} = {}) {
  const values = Array.isArray(history) ? history : [];
  const turnId = String(completedTurn.turnId ?? completedTurn.id ?? "").trim();
  const answer = String(completedTurn.answer ?? completedTurn.text ?? "").trim();
  if (!turnId || !answer) return values;

  let current = values.findLast((item) => String(item?.id ?? "") === turnId);
  if (!current && matchSingleActive) {
    const activeItems = values.filter((item) => item?.active === true);
    if (activeItems.length === 1) {
      current = activeItems[0];
      current.id = turnId;
    }
  }
  if (!current) {
    current = { id: turnId, prompt: "", answer: "", messages: [] };
    values.push(current);
  }

  const suppliedStatus = String(completedTurn.status ?? "").trim().toLowerCase();
  const retainedStatus = String(current.status ?? "").trim().toLowerCase();
  const status = ["completed", "failed", "cancelled", "aborted"].includes(suppliedStatus)
    ? suppliedStatus
    : current.completed === true && ["completed", "failed", "cancelled", "aborted"].includes(retainedStatus)
      ? retainedStatus
      : "completed";
  const terminalFailure = mergeProviderTerminalFailure(
    current.terminalFailure,
    completedTurn.terminalFailure,
    { status },
  );
  current.active = false;
  current.completed = true;
  current.status = status;
  if (terminalFailure) current.terminalFailure = terminalFailure;
  else delete current.terminalFailure;
  current.answer = answer;
  const terminalRevision = Number(completedTurn.terminalRevision);
  if (Number.isSafeInteger(terminalRevision) && terminalRevision > 0) {
    current.terminalRevision = terminalRevision;
  }
  if (!Array.isArray(current.activities)) current.activities = [];
  if (!Array.isArray(current.activityGroups)) current.activityGroups = [];
  const completedAt = normalizedTimestamp(completedTurn.completedAt ?? completedTurn.updatedAt);
  const responseAnnotationReferences = Array.isArray(completedTurn.responseAnnotationReferences)
    ? structuredClone(completedTurn.responseAnnotationReferences)
    : [];
  if (completedAt && !normalizedTimestamp(current.completedAt)) current.completedAt = completedAt;
  const messages = Array.isArray(current.messages) ? current.messages : [];
  const parentAgents = messages.filter((message) => (
    message.role === "agent"
    && message.kind !== "subagent"
    && !String(message.itemId ?? "").includes(":subagent:")
  ));
  const agent = parentAgents.find((message) => String(message.itemId ?? "") === `${turnId}:agent:final`)
    ?? parentAgents.findLast((message) => ["final", "final_answer"].includes(String(message.phase ?? "")))
    ?? parentAgents.at(-1);
  if (agent) {
    agent.text = answer;
    if (responseAnnotationReferences.length) {
      agent.responseAnnotationReferences = responseAnnotationReferences;
    }
    agent.phase = "final";
    delete agent.author;
    delete agent.kind;
    delete agent.agentThreadId;
    delete agent.model;
    if (completedAt && !normalizedTimestamp(agent.time)) agent.time = completedAt;
  } else {
    messages.push({
      itemId: `${turnId}:agent:final`,
      role: "agent",
      phase: "final",
      text: answer,
      ...(responseAnnotationReferences.length ? { responseAnnotationReferences } : {}),
      ...(completedAt ? { time: completedAt } : {}),
    });
  }
  current.messages = messages;
  return values;
}

export function mergeActiveTaskHistory(history, activeTurn = {}) {
  const values = Array.isArray(history) ? history : [];
  if (activeTurn?.active !== true) return values;

  const turnId = String(activeTurn.turnId ?? activeTurn.id ?? "").trim();
  const rawPrompt = String(activeTurn.prompt ?? "").trim();
  const rootOrigin = normalizeInterstreamOrigin(activeTurn.messageOrigin);
  const rootClientUserMessageId = String(
    String(activeTurn.clientUserMessageId ?? "").trim()
      || (rootOrigin?.requestId ? `mcp:${rootOrigin.requestId}` : ""),
  ).trim();
  const rootInterstream = trustedInterstreamMessageDetails(rawPrompt, {
    origin: activeTurn.messageOrigin,
    clientUserMessageId: rootClientUserMessageId,
  });
  const rootAuthor = interstreamOriginAuthor(rootOrigin);
  const responseAnnotations = responseAnnotationDetails(rawPrompt);
  const visiblePrompt = displayUserPrompt(rootInterstream?.text ?? rawPrompt);
  const attachments = Array.isArray(activeTurn.attachments)
    ? activeTurn.attachments.map((attachment) => ({ ...attachment }))
    : [];
  let current = turnId
    ? values.findLast((item) => String(item?.id ?? "") === turnId)
    : values.findLast((item) => item?.active === true);
  if (!current && turnId && activeTurn.provider === "claude") {
    const activeItems = values.filter((item) => item?.active === true);
    if (activeItems.length === 1) {
      current = activeItems[0];
      // Managed Claude runs use an internal run UUID until the transcript emits
      // its own user-message UUID. While the turn is active, normalize the
      // visible history to the run UUID so the live and history layers share
      // one exact identity instead of rendering the same prompt twice.
      current.id = turnId;
    }
  }

  if (!current) {
    current = {
      id: turnId || "active-turn",
      prompt: visiblePrompt,
      ...(rootAuthor ? { promptAuthor: rootAuthor, promptOrigin: structuredClone(rootOrigin) } : {}),
      answer: "",
      ...(responseAnnotations?.items.length
        ? {
          promptAnnotations: responseAnnotations.items.map((annotation) => ({ ...annotation })),
          promptRequest: responseAnnotations.request,
        }
        : {}),
      messages: [],
      ...(normalizedTimestamp(activeTurn.startedAt)
        ? { startedAt: normalizedTimestamp(activeTurn.startedAt) }
        : {}),
      ...(attachments.length
        ? { attachments }
        : {}),
    };
    values.push(current);
  }

  if (!visiblePrompt && current.prompt === "Текущее сообщение") {
    current.prompt = "";
    current.messages = (Array.isArray(current.messages) ? current.messages : [])
      .filter((message) => !(message.role === "user" && message.text === "Текущее сообщение"));
  }
  current.active = true;
  current.completed = false;
  current.status = "inProgress";
  if (!current.startedAt && normalizedTimestamp(activeTurn.startedAt)) {
    current.startedAt = normalizedTimestamp(activeTurn.startedAt);
  }
  const suppliedUsers = (Array.isArray(activeTurn.userMessages) ? activeTurn.userMessages : [])
    .filter((message) => message?.role === "user")
    .map((message, index) => {
      const rawMessageText = String(message.text ?? "");
      const directClientUserMessageId = String(
        message.clientUserMessageId
          ?? message.clientId
          ?? "",
      ).trim();
      const directOrigin = message.origin
        ?? message.messageOrigin;
      const interstream = trustedInterstreamMessageDetails(rawMessageText, {
        origin: directOrigin,
        clientUserMessageId: directClientUserMessageId,
      });
      const origin = normalizeInterstreamOrigin(directOrigin);
      const author = interstreamOriginAuthor(origin) || String(message.author ?? "").trim();
      const messageText = displayUserPrompt(interstream?.text ?? rawMessageText);
      const clientUserMessageId = directClientUserMessageId
        || (origin?.requestId ? `mcp:${origin.requestId}` : "");
      return {
        itemId: String(message.itemId ?? message.id ?? "").trim(),
        clientUserMessageId,
        ...(String(message.sourceOccurrenceId ?? "").trim()
          ? { sourceOccurrenceId: String(message.sourceOccurrenceId).trim() }
          : {}),
        role: "user",
        text: messageText,
        ...(author ? { author } : {}),
        ...(origin ? { kind: "interstream", origin: structuredClone(origin) } : {}),
        ...(normalizedTimestamp(message.time) ? { time: normalizedTimestamp(message.time) } : {}),
        ...(Array.isArray(message.responseAnnotations)
          ? { responseAnnotations: message.responseAnnotations.map((item) => ({ ...item })) }
          : {}),
        ...(String(message.responseAnnotationRequest ?? "").trim()
          ? { responseAnnotationRequest: String(message.responseAnnotationRequest).trim() }
          : {}),
        ...(Array.isArray(message.attachments)
          ? { attachments: message.attachments.map((item) => ({ ...item })) }
          : {}),
        ...(Array.isArray(message.attachmentSources)
          ? { attachmentSources: message.attachmentSources.map((item) => ({ ...item })) }
          : {}),
        index,
      };
    });
  const suppliedSubagents = (Array.isArray(activeTurn.userMessages) ? activeTurn.userMessages : [])
    .filter((message) => message?.role === "agent" && message?.kind === "subagent")
    .map((message, index) => ({
      itemId: String(message.itemId ?? message.id ?? "").trim(),
      role: "agent",
      kind: "subagent",
      text: String(message.text ?? "").trim(),
      author: String(message.author ?? "").trim() || codexSubagentAuthor(message.model),
      agentThreadId: String(message.agentThreadId ?? "").trim(),
      model: String(message.model ?? "").trim(),
      ...(normalizedTimestamp(message.time) ? { time: normalizedTimestamp(message.time) } : {}),
      index,
    })).filter((message) => message.text);
  const currentMessages = Array.isArray(current.messages) ? current.messages : [];
  const currentUsers = currentMessages.filter((message) => message?.role === "user");
  const hasRootUser = rootClientUserMessageId
    ? suppliedUsers.some((message) => message.clientUserMessageId === rootClientUserMessageId)
    : currentUsers.length > 0 || suppliedUsers.length > 0;
  if (!hasRootUser && (visiblePrompt || attachments.length)) {
    suppliedUsers.unshift({
      itemId: "",
      clientUserMessageId: rootClientUserMessageId,
      role: "user",
      text: visiblePrompt,
      ...(rootAuthor ? {
        author: rootAuthor,
        kind: "interstream",
        origin: structuredClone(rootOrigin),
      } : {}),
      ...(normalizedTimestamp(activeTurn.startedAt) ? { time: normalizedTimestamp(activeTurn.startedAt) } : {}),
      ...(responseAnnotations?.items.length
        ? {
          responseAnnotations: responseAnnotations.items.map((annotation) => ({ ...annotation })),
          responseAnnotationRequest: responseAnnotations.request,
        }
        : {}),
      ...(attachments.length ? { attachments: attachments.map((item) => ({ ...item })) } : {}),
      index: 0,
    });
  }
  suppliedUsers.forEach((message, index) => { message.index = index; });
  if (suppliedUsers.length && currentUsers.length) {
    const canonical = hasCanonicalUserMessages(currentUsers);
    current.messages = [
      ...mergeCanonicalUserMessages(
        currentUsers,
        suppliedUsers.map((message) => {
          const { index: _index, ...observed } = message;
          return observed;
        }),
        {
          currentSnapshotAuthority: userMessageSnapshotAuthority(current),
          snapshotAuthority: userMessageSnapshotAuthority(activeTurn),
        },
      ),
      ...currentMessages
        .filter((message) => message?.role !== "user")
        .map((message) => structuredClone(message)),
    ];
    if (!canonical && visiblePrompt) current.prompt = visiblePrompt;
    current.userMessageSnapshotAuthority = mergedUserMessageSnapshotAuthority(
      currentUsers,
      current,
      activeTurn,
    );
    suppliedUsers.length = 0;
  }
  if (suppliedUsers.length) {
    if (visiblePrompt) current.prompt = visiblePrompt;
    else if (!current.prompt && suppliedUsers[0].text) current.prompt = suppliedUsers[0].text;
    if (rootAuthor) {
      current.promptAuthor = rootAuthor;
      current.promptOrigin = structuredClone(rootOrigin);
    }
    const messages = Array.isArray(current.messages) ? current.messages : [];
    const users = mergeCanonicalUserMessages(
      messages.filter((message) => message?.role === "user"),
      suppliedUsers.map(({ index: _index, ...message }) => message),
      {
        currentSnapshotAuthority: userMessageSnapshotAuthority(current),
        snapshotAuthority: userMessageSnapshotAuthority(activeTurn),
      },
    );
    if (attachments.length) current.attachments = attachments;
    current.messages = [
      ...users,
      ...messages
        .filter((message) => message?.role !== "user")
        .map((message) => structuredClone(message)),
    ];
    current.userMessageSnapshotAuthority = mergedUserMessageSnapshotAuthority(
      messages.filter((message) => message?.role === "user"),
      current,
      activeTurn,
    );
  }
  if (suppliedSubagents.length) {
    const messages = Array.isArray(current.messages) ? current.messages : [];
    for (const incoming of suppliedSubagents) {
      let message = incoming.itemId
        ? messages.find((item) => String(item?.itemId ?? "") === incoming.itemId)
        : null;
      if (!message && incoming.agentThreadId) {
        message = messages.find((item) => (
          item?.kind === "subagent"
          && String(item?.agentThreadId ?? "") === incoming.agentThreadId
        ));
      }
      if (!message) {
        message = {
          itemId: incoming.itemId || `${turnId || current.id || "active-turn"}:subagent:${incoming.index}`,
          role: "agent",
          kind: "subagent",
        };
        const parentAgent = messages.findIndex((item) => item.role === "agent" && item.kind !== "subagent");
        messages.splice(parentAgent < 0 ? messages.length : parentAgent, 0, message);
      }
      Object.assign(message, incoming);
    }
    current.messages = messages;
  }
  if (Array.isArray(activeTurn.activities)) current.activities = activeTurn.activities.slice();
  if (Array.isArray(activeTurn.activityGroups)) {
    current.activityGroups = structuredClone(activeTurn.activityGroups);
  }
  const answer = String(activeTurn.answer ?? "").trim();
  if (answer) {
    current.answer = answer;
    const messages = Array.isArray(current.messages) ? current.messages : [];
    const itemId = String(activeTurn.responseItemId ?? "").trim()
      || `${turnId || current.id || "active-turn"}:agent:live`;
    const existing = messages.find((item) => (
      item.role === "agent" && String(item.itemId ?? "") === itemId
    ));
    const responseAnnotationReferences = structuredClone(
      activeTurn.responseAnnotationReferences ?? [],
    );
    if (existing) {
      existing.text = answer;
      if (responseAnnotationReferences.length) {
        existing.responseAnnotationReferences = responseAnnotationReferences;
      }
    } else messages.push({
      itemId,
      role: "agent",
      text: answer,
      ...(responseAnnotationReferences.length ? { responseAnnotationReferences } : {}),
    });
    current.messages = messages;
  }
  return values;
}
