import { codexSubagentActivity } from "../domain/run-activity.mjs";
import { isCodexContextProbeTurn } from "../domain/codex-context-probe.mjs";
import { interstreamMessageDetails } from "../domain/interstream-message.mjs";

export const EMPTY_TURN_COMPLETION_TEXT = "Ход завершён без текстового ответа.";

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

  const request = /^## My request for Codex:\s*$/im;
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
  return item?.type === "agentMessage" || item?.type === "plan";
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

function codexTurnMessages(turn, { userAuthor = "" } = {}) {
  if (isCodexContextProbeTurn(turn)) return [];
  const turnId = String(turn?.id ?? "").trim();
  return (Array.isArray(turn?.items) ? turn.items : []).flatMap((item, index) => {
    if (item?.type === "userMessage") {
      const rawText = textContent(item.content);
      const interstream = interstreamMessageDetails(rawText);
      const envelope = desktopPromptEnvelope(rawText);
      const attachmentSources = codexAttachmentSources(item.content, envelope, rawText);
      const responseAnnotations = responseAnnotationDetails(rawText);
      const text = displayUserPrompt(rawText)
        || (attachmentSources.length ? (envelope ? "Вложение" : "Изображение") : "");
      return text ? [{
        itemId: messageItemId(turnId, "user", item, index),
        ...(String(item.clientId ?? "").trim()
          ? { clientUserMessageId: String(item.clientId).trim() }
          : {}),
        role: "user",
        text,
        ...((interstream?.author ?? String(userAuthor).trim())
          ? { author: interstream?.author ?? String(userAuthor).trim() }
          : {}),
        ...(responseAnnotations?.items.length
          ? {
            responseAnnotations: responseAnnotations.items.map((annotation) => ({ ...annotation })),
            responseAnnotationRequest: responseAnnotations.request,
          }
          : {}),
        ...(attachmentSources.length
          ? { attachmentSources }
          : {}),
        ...(normalizedTimestamp(item.createdAt ?? turn?.startedAt ?? turn?.createdAt)
          ? { time: normalizedTimestamp(item.createdAt ?? turn?.startedAt ?? turn?.createdAt) }
          : {}),
      }] : [];
    }
    if (isCodexAnswerItem(item) && String(item.text ?? "").trim()) {
      return [{
        itemId: messageItemId(turnId, "agent", item, index),
        role: "agent",
        text: String(item.text).trim(),
        phase: codexAnswerPhase(item),
        ...(normalizedTimestamp(item.createdAt ?? turn?.completedAt ?? turn?.updatedAt)
          ? { time: normalizedTimestamp(item.createdAt ?? turn?.completedAt ?? turn?.updatedAt) }
          : {}),
      }];
    }
    return [];
  });
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

  const items = annotations.flatMap((item) => {
    const selectedText = String(item?.text ?? "").trim();
    const annotation = String(item?.annotation ?? "").trim();
    return selectedText || annotation ? [{ text: selectedText, annotation }] : [];
  });
  const comments = items.flatMap((item, index) => (
    item.annotation ? [{ index: index + 1, annotation: item.annotation }] : []
  ));
  const requestTail = text.slice((block.index ?? 0) + block[0].length);
  const request = requestTail
    .replace(/^\s*##\s*My request for Codex:\s*/i, "")
    .trim();
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
  let text = String(value ?? "").trim();
  if (isCodexInternalPromptEnvelope(text)) return "";
  const interstream = interstreamMessageDetails(text);
  if (interstream) text = interstream.text;
  const envelope = desktopPromptEnvelope(text);
  if (envelope) text = envelope.text;
  const telegramReplyMarker = "\nТекст пользователя:\n";
  const telegramReplyAt = text.lastIndexOf(telegramReplyMarker);
  if (telegramReplyAt >= 0) text = text.slice(telegramReplyAt + telegramReplyMarker.length).trim();
  text = text
    .replace(/<image\b[^>]*>\s*(?:<\/image>)?/giu, "")
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();
  if (/^<turn_aborted>\s*[\s\S]*?\s*<\/turn_aborted>$/iu.test(text)) return "";
  const annotated = responseAnnotationPrompt(text);
  if (annotated !== null) return annotated;
  return text;
}

export function codexExplicitFinalTurnAnswer(turn) {
  if (isCodexContextProbeTurn(turn)) return "";
  const explicitFinal = (turn?.items ?? [])
    .filter((item) => isCodexAnswerItem(item) && String(item.text ?? "").trim());
  return String(explicitFinal.findLast((item) => (
    ["final", "final_answer", "finalAnswer"].includes(codexAnswerPhase(item))
  ))?.text ?? "").trim();
}

export function codexFinalTurnAnswer(turn) {
  const explicitFinal = codexExplicitFinalTurnAnswer(turn);
  if (explicitFinal) return explicitFinal;
  if (isCodexContextProbeTurn(turn)) return "";
  const messages = (turn?.items ?? [])
    .filter((item) => isCodexAnswerItem(item) && String(item.text ?? "").trim());
  return String(messages.at(-1)?.text ?? "").trim();
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
    if (!prompt) return [];
    const visibleAnswer = messages
      .filter((item) => item.role === "agent")
      .map((item) => item.text)
      .join("\n\n")
      .trim();
    const answer = turn?.status === "completed"
      ? codexFinalTurnAnswer(turn)
      : visibleAnswer;
    return [{
      id: String(turn?.id ?? ""),
      prompt,
      answer,
      status: String(turn?.status ?? ""),
      active: turn?.status === "inProgress",
      completed: turn?.status === "completed",
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

function claudeUserPrompt(entry) {
  if (entry?.type !== "user" || entry.message?.role !== "user") return "";
  return displayUserPrompt(textContent(entry.message?.content));
}

function claudeUserAuthor(entry) {
  if (entry?.type !== "user" || entry.message?.role !== "user") return "";
  return interstreamMessageDetails(textContent(entry.message?.content))?.author ?? "";
}

export function claudeTranscriptHistory(text) {
  const entries = claudeEntries(text);
  const userIndexes = entries
    .map((entry, index) => (claudeUserPrompt(entry) ? index : -1))
    .filter((index) => index >= 0);
  return userIndexes.map((entryIndex, historyIndex) => {
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
      prompt: claudeUserPrompt(entries[entryIndex]),
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
        {
          itemId: String(entries[entryIndex]?.uuid ?? `${entryIndex}:user`),
          role: "user",
          text: claudeUserPrompt(entries[entryIndex]),
          ...(claudeUserAuthor(entries[entryIndex])
            ? { author: claudeUserAuthor(entries[entryIndex]) }
            : {}),
          ...(normalizedTimestamp(entries[entryIndex]?.timestamp)
            ? { time: normalizedTimestamp(entries[entryIndex]?.timestamp) }
            : {}),
        },
        ...turnEntries.flatMap((entry, index) => {
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

export function mergeCompletedTaskHistory(history, completedTurn = {}) {
  const values = Array.isArray(history) ? history : [];
  const turnId = String(completedTurn.turnId ?? completedTurn.id ?? "").trim();
  const answer = String(completedTurn.answer ?? completedTurn.text ?? "").trim();
  if (!turnId || !answer) return values;

  let current = values.findLast((item) => String(item?.id ?? "") === turnId);
  if (!current) {
    const activeItems = values.filter((item) => item?.active === true);
    if (activeItems.length === 1) {
      current = activeItems[0];
      current.id = turnId;
    }
  }
  if (!current) {
    const previousAnswer = String(values.findLast((item) => item?.completed !== false)?.answer ?? "").trim();
    if (previousAnswer === answer) return values;
  }
  if (!current) {
    current = { id: turnId, prompt: "", answer: "", messages: [] };
    values.push(current);
  }

  current.active = false;
  current.completed = true;
  current.status = "completed";
  current.answer = answer;
  const completedAt = normalizedTimestamp(completedTurn.completedAt ?? completedTurn.updatedAt);
  if (completedAt && !normalizedTimestamp(current.completedAt)) current.completedAt = completedAt;
  const messages = Array.isArray(current.messages) ? current.messages : [];
  const agents = messages.filter((message) => message.role === "agent");
  const agent = agents.find((message) => String(message.itemId ?? "") === `${turnId}:agent:final`)
    ?? agents.at(-1);
  if (agent) {
    agent.text = answer;
    agent.phase = "final";
    if (completedAt && !normalizedTimestamp(agent.time)) agent.time = completedAt;
  } else {
    messages.push({
      itemId: `${turnId}:agent:final`,
      role: "agent",
      phase: "final",
      text: answer,
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
  const rootInterstream = interstreamMessageDetails(rawPrompt);
  const responseAnnotations = responseAnnotationDetails(rawPrompt);
  const visiblePrompt = displayUserPrompt(rawPrompt);
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
      const interstream = interstreamMessageDetails(rawMessageText);
      const messageText = displayUserPrompt(rawMessageText);
      return {
        itemId: String(message.itemId ?? message.id ?? "").trim(),
        clientUserMessageId: String(message.clientUserMessageId ?? message.clientId ?? "").trim(),
        role: "user",
        text: messageText,
        ...((interstream?.author ?? String(message.author ?? "").trim())
          ? { author: interstream?.author ?? String(message.author).trim() }
          : {}),
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
        index,
      };
    });
  const rootClientUserMessageId = String(activeTurn.clientUserMessageId ?? "").trim();
  const hasRootUser = suppliedUsers.some((message) => (
    (rootClientUserMessageId && message.clientUserMessageId === rootClientUserMessageId)
    || (visiblePrompt && message.text === visiblePrompt)
  ));
  if (!hasRootUser && (visiblePrompt || attachments.length)) {
    suppliedUsers.unshift({
      itemId: "",
      clientUserMessageId: rootClientUserMessageId,
      role: "user",
      text: visiblePrompt,
      ...(rootInterstream ? { author: rootInterstream.author } : {}),
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
  if (suppliedUsers.length) {
    if (visiblePrompt) current.prompt = visiblePrompt;
    else if (!current.prompt && suppliedUsers[0].text) current.prompt = suppliedUsers[0].text;
    const messages = Array.isArray(current.messages) ? current.messages : [];
    for (const incoming of suppliedUsers) {
      const users = messages.filter((message) => message.role === "user");
      let user = incoming.itemId
        ? users.find((message) => String(message.itemId ?? "") === incoming.itemId)
        : null;
      if (!user && incoming.clientUserMessageId) {
        user = users.find((message) => (
          String(message.clientUserMessageId ?? "") === incoming.clientUserMessageId
        ));
      }
      if (!user) {
        const unidentified = users.filter((message) => !String(message.clientUserMessageId ?? "").trim());
        const matchingText = incoming.text
          ? unidentified.filter((message) => String(message.text ?? "").trim() === incoming.text)
          : [];
        if (matchingText.length === 1) user = matchingText[0];
        else if (incoming.index === 0 && unidentified.length === 1) user = unidentified[0];
      }
      if (!user) {
        user = {
          itemId: incoming.itemId || `${turnId || current.id || "active-turn"}:user:${incoming.index}`,
          role: "user",
          text: incoming.text,
        };
        const firstAgent = messages.findIndex((message) => message.role === "agent");
        messages.splice(firstAgent < 0 ? messages.length : firstAgent, 0, user);
      }
      if (incoming.itemId) user.itemId = incoming.itemId;
      if (incoming.clientUserMessageId) user.clientUserMessageId = incoming.clientUserMessageId;
      if (incoming.text) user.text = incoming.text;
      if (incoming.author) user.author = incoming.author;
      const timestamp = incoming.time ?? normalizedTimestamp(activeTurn.startedAt);
      if (!user.time && timestamp) user.time = timestamp;
      if (incoming.responseAnnotations?.length) user.responseAnnotations = incoming.responseAnnotations;
      if (incoming.responseAnnotationRequest) user.responseAnnotationRequest = incoming.responseAnnotationRequest;
      if (incoming.attachments?.length) user.attachments = incoming.attachments;
    }
    if (attachments.length) current.attachments = attachments;
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
    if (existing) existing.text = answer;
    else messages.push({ itemId, role: "agent", text: answer });
    current.messages = messages;
  }
  return values;
}
