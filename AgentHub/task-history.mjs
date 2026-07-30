function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && String(item.text ?? "").trim())
    .map((item) => String(item.text).trim())
    .join("\n")
    .trim();
}

function messageItemId(turnId, role, item, index) {
  const exact = String(item?.id ?? "").trim();
  return exact || `${String(turnId ?? "turn")}:${role}:${index}`;
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
  if (item?.type === "userMessage" || item?.type === "agentMessage") return null;
  if (/agent|collab|subagent/iu.test(String(item?.type ?? ""))) return {
    id, type: "subagent", label: "Субагент завершён",
    detail: String(item.name ?? item.task ?? "").slice(0, 500), status: "completed",
  };
  return null;
}

export function codexTurnActivities(turn) {
  return (Array.isArray(turn?.items) ? turn.items : [])
    .map(activityFromCodexItem)
    .filter(Boolean);
}

function codexTurnMessages(turn) {
  const turnId = String(turn?.id ?? "").trim();
  return (Array.isArray(turn?.items) ? turn.items : []).flatMap((item, index) => {
    if (item?.type === "userMessage") {
      const text = displayUserPrompt(textContent(item.content));
      return text ? [{
        itemId: messageItemId(turnId, "user", item, index),
        ...(String(item.clientId ?? "").trim()
          ? { clientUserMessageId: String(item.clientId).trim() }
          : {}),
        role: "user",
        text,
        ...(normalizedTimestamp(item.createdAt ?? turn?.startedAt ?? turn?.createdAt)
          ? { time: normalizedTimestamp(item.createdAt ?? turn?.startedAt ?? turn?.createdAt) }
          : {}),
      }] : [];
    }
    if (item?.type === "agentMessage" && String(item.text ?? "").trim()) {
      return [{
        itemId: messageItemId(turnId, "agent", item, index),
        role: "agent",
        text: String(item.text).trim(),
        phase: String(item.phase ?? ""),
        ...(normalizedTimestamp(item.createdAt ?? turn?.completedAt ?? turn?.updatedAt)
          ? { time: normalizedTimestamp(item.createdAt ?? turn?.completedAt ?? turn?.updatedAt) }
          : {}),
      }];
    }
    return [];
  });
}

function responseAnnotationPrompt(value) {
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

  const comments = annotations.flatMap((item, index) => {
    const annotation = String(item?.annotation ?? "").trim();
    return annotation ? [{ index: index + 1, annotation }] : [];
  });
  const requestTail = text.slice((block.index ?? 0) + block[0].length);
  const request = requestTail
    .replace(/^\s*##\s*My request for Codex:\s*/i, "")
    .trim();
  const selections = annotations
    .map((item) => String(item?.text ?? "").trim())
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
  return [annotationText, selectedText, request]
    .filter(Boolean)
    .join("\n\n")
    .trim() || "Аннотация к предыдущему ответу";
}

export function displayUserPrompt(value) {
  let text = String(value ?? "").trim();
  const telegramReplyMarker = "\nТекст пользователя:\n";
  const telegramReplyAt = text.lastIndexOf(telegramReplyMarker);
  if (telegramReplyAt >= 0) text = text.slice(telegramReplyAt + telegramReplyMarker.length).trim();
  text = text
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();
  const annotated = responseAnnotationPrompt(text);
  if (annotated !== null) return annotated;
  return text;
}

export function codexFinalTurnAnswer(turn) {
  const messages = (turn?.items ?? [])
    .filter((item) => item?.type === "agentMessage" && String(item.text ?? "").trim());
  const explicitFinal = messages.findLast((item) => (
    ["final", "final_answer", "finalAnswer"].includes(String(item.phase ?? ""))
  ));
  return String(explicitFinal?.text ?? messages.at(-1)?.text ?? "").trim();
}

export function codexTurnHasExplicitFinalAnswer(turn) {
  return (turn?.items ?? []).some((item) => (
    item?.type === "agentMessage"
      && String(item.text ?? "").trim()
      && ["final", "final_answer", "finalAnswer"].includes(String(item.phase ?? ""))
  ));
}

export function codexThreadHistory(turns) {
  return (Array.isArray(turns) ? turns : []).flatMap((turn) => {
    const messages = codexTurnMessages(turn);
    const prompt = messages.find((item) => item.role === "user")?.text ?? "";
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
      ...(normalizedTimestamp(turn?.startedAt ?? turn?.createdAt)
        ? { startedAt: normalizedTimestamp(turn?.startedAt ?? turn?.createdAt) }
        : {}),
      ...(normalizedTimestamp(turn?.completedAt ?? turn?.updatedAt)
        ? { completedAt: normalizedTimestamp(turn?.completedAt ?? turn?.updatedAt) }
        : {}),
      messages,
      activities: codexTurnActivities(turn),
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

export function mergeActiveTaskHistory(history, activeTurn = {}) {
  const values = Array.isArray(history) ? history : [];
  if (activeTurn?.active !== true) return values;

  const turnId = String(activeTurn.turnId ?? activeTurn.id ?? "").trim();
  let current = turnId
    ? values.findLast((item) => String(item?.id ?? "") === turnId)
    : values.findLast((item) => item?.active === true);

  if (!current) {
    current = {
      id: turnId || "active-turn",
      prompt: String(activeTurn.prompt ?? "").trim() || "Текущее сообщение",
      answer: "",
      messages: [{
        itemId: `${turnId || "active-turn"}:user:0`,
        ...(String(activeTurn.clientUserMessageId ?? "").trim()
          ? { clientUserMessageId: String(activeTurn.clientUserMessageId).trim() }
          : {}),
        role: "user",
        text: String(activeTurn.prompt ?? "").trim() || "Текущее сообщение",
        ...(normalizedTimestamp(activeTurn.startedAt)
          ? { time: normalizedTimestamp(activeTurn.startedAt) }
          : {}),
        ...(Array.isArray(activeTurn.attachments) && activeTurn.attachments.length
          ? { attachments: activeTurn.attachments.map((attachment) => ({ ...attachment })) }
          : {}),
      }],
      ...(normalizedTimestamp(activeTurn.startedAt)
        ? { startedAt: normalizedTimestamp(activeTurn.startedAt) }
        : {}),
      ...(Array.isArray(activeTurn.attachments) && activeTurn.attachments.length
        ? { attachments: activeTurn.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
    };
    values.push(current);
  }

  current.active = true;
  current.completed = false;
  current.status = "inProgress";
  if (!current.startedAt && normalizedTimestamp(activeTurn.startedAt)) {
    current.startedAt = normalizedTimestamp(activeTurn.startedAt);
  }
  if (Array.isArray(activeTurn.attachments) && activeTurn.attachments.length) {
    current.attachments = activeTurn.attachments.map((attachment) => ({ ...attachment }));
    const messages = Array.isArray(current.messages) ? current.messages : [];
    const user = messages.find((message) => (
      message.role === "user"
      && (
        !activeTurn.clientUserMessageId
        || String(message.clientUserMessageId ?? "") === String(activeTurn.clientUserMessageId)
      )
    ));
    if (user) {
      user.time ??= normalizedTimestamp(activeTurn.startedAt);
      user.attachments = current.attachments.map((attachment) => ({ ...attachment }));
    }
  }
  if (Array.isArray(activeTurn.activities)) current.activities = activeTurn.activities.slice();
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
